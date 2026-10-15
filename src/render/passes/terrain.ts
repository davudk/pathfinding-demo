import earcut from 'earcut';
import type { Polygon } from '../../shared/geometry';
import { scanlineFill, signedDistanceField } from '../../shared/raster';
import { compileProgram, uniforms } from '../gl/util';

/** Distance-field resolution (texels per world unit). */
export const SDF_RES = 2;
/** Distances are clamped to ±this (world units) before upload. */
const SDF_CLAMP = 16;

const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + 1.0), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { v += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}`;

export const SDF_GLSL = /* glsl */ `
uniform sampler2D u_sdf;
uniform vec2 u_map;
float sdf(vec2 w) { return texture(u_sdf, w / u_map).r; }`;

const VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
uniform mat3 u_view;
out vec2 v_world;
void main() {
  v_world = a_pos;
  vec3 c = u_view * vec3(a_pos, 1.0);
  gl_Position = vec4(c.xy, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_world;
uniform float u_px;
out vec4 o;
${SDF_GLSL}
${NOISE_GLSL}
void main() {
  vec2 w = v_world;
  float d = sdf(w);                       // negative inside rock
  float depth = max(0.0, -d);
  float e = 0.5;
  vec2 g = vec2(sdf(w + vec2(e, 0)) - sdf(w - vec2(e, 0)), sdf(w + vec2(0, e)) - sdf(w - vec2(0, e)));
  vec2 outward = length(g) > 1e-4 ? normalize(g) : vec2(0.0);

  // Bevel: the rim slopes down toward the outline over ~1.3 units.
  float slope = 1.0 - smoothstep(0.0, 1.3, depth);
  vec3 n = normalize(vec3(outward * slope * 1.6, 1.0));
  vec3 light = normalize(vec3(-0.55, -0.75, 0.9));
  float lambert = dot(n, light);

  float tex = fbm(w * 0.32);
  float fine = vnoise(w * 2.1);
  vec3 dark = vec3(0.150, 0.168, 0.205);
  vec3 lite = vec3(0.235, 0.258, 0.310);
  vec3 c = mix(dark, lite, tex * 0.85 + fine * 0.15);
  // Plateau is slightly lighter than the rim; rim lit by direction.
  c *= 0.82 + 0.16 * smoothstep(0.6, 2.5, depth);
  c *= 0.62 + 0.55 * lambert;
  // Sparse, faint fissures (ridged noise), only on the plateau.
  float ridge = 1.0 - abs(fbm(w * 0.18 + 5.0) * 2.0 - 1.0);
  float crack = smoothstep(0.93, 0.985, ridge) * smoothstep(1.2, 2.5, depth);
  c *= 1.0 - crack * 0.18;
  o = vec4(c, 1.0);
}`;

export class TerrainPass {
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly ibo: WebGLBuffer;
  private indexCount = 0;
  readonly sdfTexture: WebGLTexture;
  mapW = 1;
  mapH = 1;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, 'terrain', VS, FS);
    this.u = uniforms(gl, this.prog, ['u_view', 'u_px', 'u_sdf', 'u_map'] as const);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.ibo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bindVertexArray(null);

    this.sdfTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sdfTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([SDF_CLAMP]));
  }

  /** Rebuilds the fill mesh and the distance field from normalized terrain polygons. */
  setTerrain(polygons: readonly Polygon[], mapW: number, mapH: number): { triangles: number; ms: number } {
    const t0 = performance.now();
    const gl = this.gl;
    this.mapW = mapW;
    this.mapH = mapH;

    // Fill mesh.
    const verts: number[] = [];
    const idx: number[] = [];
    for (const p of polygons) {
      const flat: number[] = [];
      const holes: number[] = [];
      p.rings.forEach((r, k) => {
        if (k > 0) holes.push(flat.length / 2);
        for (let i = 0; i < r.length; i++) flat.push(r[i]);
      });
      const tri = earcut(flat, holes, 2);
      const base = verts.length / 2;
      for (const v of flat) verts.push(v);
      for (const t of tri) idx.push(base + t);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
    this.indexCount = idx.length;

    // Signed distance field.
    const w = Math.ceil(mapW * SDF_RES), h = Math.ceil(mapH * SDF_RES);
    const mask = new Uint8Array(w * h);
    const rings: Float64Array[] = [];
    for (const p of polygons) for (const r of p.rings) rings.push(r);
    scanlineFill(rings, w, h, SDF_RES, mask);
    const sdf = signedDistanceField(mask, w, h, SDF_RES);
    for (let i = 0; i < sdf.length; i++) sdf[i] = Math.max(-SDF_CLAMP, Math.min(SDF_CLAMP, sdf[i]));
    gl.bindTexture(gl.TEXTURE_2D, this.sdfTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.FLOAT, sdf);
    return { triangles: idx.length / 3, ms: performance.now() - t0 };
  }

  /** Binds the distance field to texture unit `unit` for other passes. */
  bindSdf(unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.sdfTexture);
  }

  draw(view: Float32Array, pxPerUnit: number): void {
    if (this.indexCount === 0) return;
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix3fv(this.u.u_view, false, view);
    gl.uniform1f(this.u.u_px, 1 / pxPerUnit);
    gl.uniform2f(this.u.u_map, this.mapW, this.mapH);
    this.bindSdf(0);
    gl.uniform1i(this.u.u_sdf, 0);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }
}
