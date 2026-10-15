import { compileProgram, uniforms } from '../gl/util';

const VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;   // x: 0..1 along, y: -1..1 across
layout(location = 1) in vec4 a_seg;      // x0, y0, x1, y1 (world)
layout(location = 2) in vec4 a_color;    // rgba8 normalized
layout(location = 3) in float a_width;   // >0: device px, <0: world units
uniform mat3 u_view;
uniform float u_px;                      // world units per device px
out vec4 v_color;
out float v_across;                      // device px from center line
flat out float v_halfW;
void main() {
  vec2 p0 = a_seg.xy, p1 = a_seg.zw;
  vec2 d = p1 - p0;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float halfWpx = a_width > 0.0 ? a_width * 0.5 : -a_width * 0.5 / u_px;
  float extPx = halfWpx + 1.0;
  float ext = extPx * u_px;
  vec2 p = mix(p0 - dir * ext * 0.5, p1 + dir * ext * 0.5, a_corner.x) + nrm * a_corner.y * ext;
  v_across = a_corner.y * extPx;
  v_halfW = halfWpx;
  v_color = a_color;
  vec3 clip = u_view * vec3(p, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_color;
in float v_across;
flat in float v_halfW;
out vec4 o;
void main() {
  float a = clamp(v_halfW + 0.5 - abs(v_across), 0.0, 1.0);
  if (a <= 0.0) discard;
  o = vec4(v_color.rgb, v_color.a * a);
}`;

const STRIDE_WORDS = 6; // x0 y0 x1 y1 color width
const STRIDE_BYTES = STRIDE_WORDS * 4;

/** Packs 0..255 rgba into the little-endian u32 the shader reads as normalized bytes. */
export function rgba(r: number, g: number, b: number, a = 255): number {
  return ((a & 255) << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0;
}

/**
 * A growable batch of thick anti-aliased segments drawn with one instanced call.
 * Width > 0 is in device pixels (constant on screen); width < 0 is in world units.
 */
export class LineBatch {
  private f32: Float32Array;
  private u32: Uint32Array;
  private count = 0;
  private uploaded = 0;
  private dirty = true;
  private readonly buf: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private gpuCapacity = 0;

  constructor(private readonly lines: LinePass, initialCapacity = 1024) {
    this.f32 = new Float32Array(initialCapacity * STRIDE_WORDS);
    this.u32 = new Uint32Array(this.f32.buffer);
    const gl = lines.gl;
    this.buf = gl.createBuffer();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, lines.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE_BYTES, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, STRIDE_BYTES, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE_BYTES, 20);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
  }

  clear(): void {
    this.count = 0;
    this.dirty = true;
  }

  get size(): number {
    return this.count;
  }

  add(x0: number, y0: number, x1: number, y1: number, color: number, width: number): void {
    if ((this.count + 1) * STRIDE_WORDS > this.f32.length) {
      const next = new Float32Array(this.f32.length * 2);
      next.set(this.f32);
      this.f32 = next;
      this.u32 = new Uint32Array(next.buffer);
    }
    const o = this.count * STRIDE_WORDS;
    this.f32[o] = x0;
    this.f32[o + 1] = y0;
    this.f32[o + 2] = x1;
    this.f32[o + 3] = y1;
    this.u32[o + 4] = color;
    this.f32[o + 5] = width;
    this.count++;
    this.dirty = true;
  }

  /** Closed or open polyline from flat [x0, y0, x1, y1, ...]. */
  polyline(pts: ArrayLike<number>, closed: boolean, color: number, width: number): void {
    const n = pts.length >> 1;
    for (let k = 0; k + 1 < n; k++) this.add(pts[2 * k], pts[2 * k + 1], pts[2 * k + 2], pts[2 * k + 3], color, width);
    if (closed && n > 2) this.add(pts[2 * n - 2], pts[2 * n - 1], pts[0], pts[1], color, width);
  }

  draw(view: Float32Array, pxPerUnit: number): void {
    if (this.count === 0) return;
    const gl = this.lines.gl;
    if (this.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      const bytes = this.count * STRIDE_BYTES;
      if (bytes > this.gpuCapacity) {
        this.gpuCapacity = this.f32.byteLength;
        gl.bufferData(gl.ARRAY_BUFFER, this.f32, gl.DYNAMIC_DRAW);
      } else {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32, 0, this.count * STRIDE_WORDS);
      }
      this.uploaded = this.count;
      this.dirty = false;
    }
    this.lines.use(view, pxPerUnit);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.uploaded);
    gl.bindVertexArray(null);
  }
}

/** Shared program + quad for all line batches. */
export class LinePass {
  readonly quad: WebGLBuffer;
  private readonly prog: WebGLProgram;
  private readonly u;

  constructor(readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, 'lines', VS, FS);
    this.u = uniforms(gl, this.prog, ['u_view', 'u_px'] as const);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    // x along (0..1), y across (-1..1)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]), gl.STATIC_DRAW);
  }

  use(view: Float32Array, pxPerUnit: number): void {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix3fv(this.u.u_view, false, view);
    gl.uniform1f(this.u.u_px, 1 / pxPerUnit);
  }

  batch(initialCapacity?: number): LineBatch {
    return new LineBatch(this, initialCapacity);
  }
}
