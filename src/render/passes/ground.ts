import { compileProgram, uniforms } from '../gl/util';
import { SDF_GLSL } from './terrain';

const VS = /* glsl */ `#version 300 es
out vec2 v_clip;
void main() {
  // Fullscreen triangle.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  v_clip = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_clip;
uniform vec4 u_cam;      // centerX, centerY, halfViewW/zoom, halfViewH/zoom (world units)
uniform float u_pxPerUnit;
out vec4 o;
${SDF_GLSL}

// Coverage of grid lines with the given spacing (world units), ~1 device px wide.
float grid(vec2 w, float spacing, float widthPx) {
  vec2 g = abs(fract(w / spacing + 0.5) - 0.5) * spacing * u_pxPerUnit;
  float d = min(g.x, g.y);
  float vis = smoothstep(4.0, 10.0, spacing * u_pxPerUnit); // fade dense grids out
  return (1.0 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1.0, d)) * vis;
}

void main() {
  vec2 w = u_cam.xy + v_clip * vec2(u_cam.z, -u_cam.w);
  bool inside = w.x >= 0.0 && w.y >= 0.0 && w.x <= u_map.x && w.y <= u_map.y;
  float d = sdf(w);
  vec3 base = vec3(0.071, 0.078, 0.090);
  // Very subtle large-scale variation so the ground doesn't look flat.
  float n = sin(w.x * 0.031) * sin(w.y * 0.027) + sin((w.x + w.y) * 0.013);
  base += n * 0.006;
  if (!inside) {
    o = vec4(0.035, 0.038, 0.045, 1.0);
    return;
  }
  vec3 c = base;
  c += vec3(0.022, 0.025, 0.030) * grid(w, 1.0, 1.0);
  c += vec3(0.030, 0.034, 0.042) * grid(w, 8.0, 1.0);
  c += vec3(0.040, 0.046, 0.056) * grid(w, 64.0, 1.5);
  // Ambient occlusion at the foot of rock, and a cast shadow toward the bottom-right.
  float ao = 1.0 - 0.5 * exp(-max(d, 0.0) * 0.9);
  float shadow = 1.0 - 0.38 * smoothstep(0.5, -0.6, sdf(w - vec2(0.75, 1.0)));
  c *= ao * shadow;
  o = vec4(c, 1.0);
}`;

export class GroundPass {
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly vao: WebGLVertexArrayObject;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, 'ground', VS, FS);
    this.u = uniforms(gl, this.prog, ['u_cam', 'u_map', 'u_pxPerUnit', 'u_sdf'] as const);
    this.vao = gl.createVertexArray();
  }

  /** Expects the terrain distance field bound on texture unit 0. */
  draw(cx: number, cy: number, halfW: number, halfH: number, mapW: number, mapH: number, pxPerUnit: number): void {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniform1i(this.u.u_sdf, 0);
    gl.uniform4f(this.u.u_cam, cx, cy, halfW, halfH);
    gl.uniform2f(this.u.u_map, mapW, mapH);
    gl.uniform1f(this.u.u_pxPerUnit, pxPerUnit);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
