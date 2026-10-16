import { compileProgram, uniforms } from '../gl/util';

const VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_color;
uniform mat3 u_view;
out vec4 v_color;
void main() {
  v_color = a_color;
  vec3 c = u_view * vec3(a_pos, 1.0);
  gl_Position = vec4(c.xy, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 o;
void main() { o = v_color; }`;

const STRIDE = 12; // x, y (f32) + rgba8

/** Flat-colored triangles (debug fills such as navmesh regions). */
export class TriBatch {
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buf: WebGLBuffer;
  private count = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, 'tris', VS, FS);
    this.u = uniforms(gl, this.prog, ['u_view'] as const);
    this.vao = gl.createVertexArray();
    this.buf = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, STRIDE, 8);
    gl.bindVertexArray(null);
  }

  /** tris: (x0,y0,x1,y1,x2,y2) per triangle; colors: packed rgba (see lines.rgba) per triangle, 0 = skip. */
  set(tris: Float32Array, colors: Uint32Array): void {
    const n = colors.length;
    let kept = 0;
    for (let t = 0; t < n; t++) if (colors[t] !== 0) kept++;
    const data = new ArrayBuffer(kept * 3 * STRIDE);
    const f = new Float32Array(data), u = new Uint32Array(data);
    let o = 0;
    for (let t = 0; t < n; t++) {
      if (colors[t] === 0) continue;
      for (let k = 0; k < 3; k++) {
        f[o] = tris[6 * t + 2 * k];
        f[o + 1] = tris[6 * t + 2 * k + 1];
        u[o + 2] = colors[t];
        o += 3;
      }
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.count = kept * 3;
  }

  clear(): void {
    this.count = 0;
  }

  draw(view: Float32Array): void {
    if (this.count === 0) return;
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix3fv(this.u.u_view, false, view);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    gl.bindVertexArray(null);
  }
}
