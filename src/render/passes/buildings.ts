import type { BuildingDef } from '../../shared/mapFormat';
import { FACTION_COLORS } from '../../shared/factions';
import { compileProgram, createQuadBuffer, uniforms } from '../gl/util';

export const BUILDING_TYPES = ['house', 'depot', 'barracks', 'factory', 'hall'] as const;

const VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_rect;   // cx, cy, halfW, halfH
layout(location = 2) in vec2 a_rotType; // rotation (rad), type id
layout(location = 3) in vec3 a_color;
uniform mat3 u_view;
uniform float u_px;
uniform int u_pass;                    // 0 = shadow, 1 = body
uniform vec2 u_shadowOffset;
out vec2 v_local;                      // building-local position (world units)
flat out vec2 v_half;
flat out float v_type;
flat out vec3 v_color;
flat out mat2 v_rot;                   // local → world rotation
void main() {
  float c = cos(a_rotType.x), s = sin(a_rotType.x);
  mat2 rot = mat2(c, s, -s, c);
  vec2 pad = vec2(u_pass == 0 ? 1.0 : 2.0 * u_px);
  vec2 local = a_corner * (a_rect.zw + pad);
  vec2 world = a_rect.xy + rot * local;
  if (u_pass == 0) {
    world += u_shadowOffset;
  }
  v_local = local;
  v_half = a_rect.zw;
  v_type = a_rotType.y;
  v_color = a_color;
  v_rot = rot;
  vec3 clip = u_view * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 v_local;
flat in vec2 v_half;
flat in float v_type;
flat in vec3 v_color;
flat in mat2 v_rot;
uniform float u_px;
uniform int u_pass;
out vec4 o;

float box(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - (b - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  float r = min(0.22, min(v_half.x, v_half.y) * 0.4);
  float d = box(v_local, v_half, r);
  if (u_pass == 0) {
    float a = (1.0 - smoothstep(-0.25, 0.55, d)) * 0.42;
    if (a <= 0.002) discard;
    o = vec4(0.0, 0.0, 0.0, a);
    return;
  }
  float cov = clamp(0.5 - d / u_px, 0.0, 1.0);
  if (cov <= 0.0) discard;

  vec3 base = mix(vec3(0.20, 0.215, 0.25), v_color, 0.38);
  // Bevel: outward normal of the rounded box, lit from the top-left (in world space).
  vec2 e = vec2(0.02, 0.0);
  vec2 g = vec2(box(v_local + e.xy, v_half, r) - box(v_local - e.xy, v_half, r),
                box(v_local + e.yx, v_half, r) - box(v_local - e.yx, v_half, r));
  vec2 nw = v_rot * normalize(g + 1e-6);
  float rim = 1.0 - smoothstep(0.0, 0.3, -d);
  vec3 n = normalize(vec3(nw * rim * 1.4, 1.0));
  float lambert = dot(n, normalize(vec3(-0.55, -0.75, 0.9)));
  vec3 c = base * (0.6 + 0.55 * lambert);

  // Roof panel inset.
  float inset = min(0.45, min(v_half.x, v_half.y) * 0.35);
  float dp = box(v_local, v_half - inset, max(0.05, r - inset * 0.5));
  float panel = clamp(0.5 - dp / u_px, 0.0, 1.0);
  c = mix(c, base * 0.88, panel);
  float seam = clamp(1.0 - abs(dp) / max(u_px, 0.03), 0.0, 1.0);
  c = mix(c, base * 0.6, seam * 0.6);

  // Type marks.
  int t = int(v_type + 0.5);
  float mark = 0.0;
  if (t == 1) { // depot: X
    vec2 p = v_local / v_half;
    mark = smoothstep(0.09, 0.05, min(abs(p.x - p.y), abs(p.x + p.y))) * step(dp, 0.0);
  } else if (t == 2) { // barracks: stripe
    mark = smoothstep(0.14, 0.1, abs(v_local.y)) * step(dp, 0.0);
  } else if (t == 3) { // factory: two vents
    vec2 q = vec2(abs(v_local.x) - v_half.x * 0.45, v_local.y);
    mark = 1.0 - smoothstep(-0.02, 0.02, box(q, vec2(0.28), 0.06));
  } else if (t == 4) { // hall: ring
    float rr = min(v_half.x, v_half.y) * 0.55;
    mark = smoothstep(0.12, 0.06, abs(length(v_local) - rr));
  }
  c = mix(c, mix(base, v_color, 0.6) * 1.25, mark * 0.85);

  // Crisp outline.
  float outline = clamp(1.0 - abs(d + 0.5 * u_px) / max(u_px, 0.025), 0.0, 1.0);
  c = mix(c, base * 0.35, outline * 0.9);
  o = vec4(c, cov);
}`;

const FLOATS = 9; // cx cy hw hh rot type r g b

export class BuildingsPass {
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buf: WebGLBuffer;
  private count = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, 'buildings', VS, FS);
    this.u = uniforms(gl, this.prog, ['u_view', 'u_px', 'u_pass', 'u_shadowOffset'] as const);
    this.vao = gl.createVertexArray();
    this.buf = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, createQuadBuffer(gl));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const stride = FLOATS * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 24);
    for (let l = 1; l <= 3; l++) gl.vertexAttribDivisor(l, 1);
    gl.bindVertexArray(null);
  }

  private palette: readonly (readonly [number, number, number])[] = FACTION_COLORS;
  private last: readonly BuildingDef[] = [];

  setPalette(colors: readonly (readonly [number, number, number])[]): void {
    this.palette = colors;
    this.setBuildings(this.last);
  }

  setBuildings(list: readonly BuildingDef[]): void {
    this.last = list;
    const data = new Float32Array(list.length * FLOATS);
    list.forEach((b, i) => {
      const o = i * FLOATS;
      const col = this.palette[b.faction] ?? this.palette[4];
      const type = Math.max(0, BUILDING_TYPES.indexOf(b.type as (typeof BUILDING_TYPES)[number]));
      data.set([b.center[0], b.center[1], b.size[0] / 2, b.size[1] / 2, b.rot, type, col[0], col[1], col[2]], o);
    });
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.count = list.length;
  }

  private drawPass(pass: number, view: Float32Array, pxPerUnit: number): void {
    if (this.count === 0) return;
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix3fv(this.u.u_view, false, view);
    gl.uniform1f(this.u.u_px, 1 / pxPerUnit);
    gl.uniform1i(this.u.u_pass, pass);
    gl.uniform2f(this.u.u_shadowOffset, 0.3, 0.42);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
    gl.bindVertexArray(null);
  }

  drawShadows(view: Float32Array, pxPerUnit: number): void {
    this.drawPass(0, view, pxPerUnit);
  }

  draw(view: Float32Array, pxPerUnit: number): void {
    this.drawPass(1, view, pxPerUnit);
  }
}
