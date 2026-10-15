import { UNIT_CAPACITY } from '../../shared/constants';
import { ARCHETYPES } from '../../shared/archetypes';
import { H_HIGH_WATER, INST_BYTES, SNAP_HEADER_BYTES } from '../../shared/protocol';
import type { Snapshot } from '../../app/snapshotRing';
import { compileProgram, createQuadBuffer, uniforms } from '../gl/util';

/** Per-slot UI flags uploaded as one byte per unit slot. */
export const SEL_SELECTED = 1;
export const SEL_HOVERED = 2;

const VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_prev;        // x, y, heading, radius
layout(location = 2) in uint a_prevHandle;
layout(location = 3) in vec4 a_curr;
layout(location = 4) in uint a_attrs;
layout(location = 5) in uint a_currHandle;
layout(location = 6) in uint a_sel;

uniform mat3 u_view;
uniform float u_alpha;
uniform float u_px;          // world units per device pixel
uniform int u_pass;          // 0 = underlay (shadow, rings), 1 = body
uniform vec3 u_factionColors[8];
uniform uint u_plainMask;    // bit per archetype: draw without rim

out vec2 v_local;
flat out float v_r;
flat out float v_heading;
flat out vec3 v_color;
flat out uint v_sel;
flat out float v_plain;

const float PI = 3.14159265;

void main() {
  float r = a_curr.w;
  if (r <= 0.0 || (u_pass == 0 && a_sel == 0u && u_px > 0.25)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // cull
    return;
  }
  vec2 p = a_curr.xy;
  float h = a_curr.z;
  if (a_prevHandle == a_currHandle) {
    p = mix(a_prev.xy, a_curr.xy, u_alpha);
    float dh = mod(a_curr.z - a_prev.z + PI, 2.0 * PI) - PI;
    h = a_prev.z + dh * u_alpha;
  }
  float rd = max(r, 1.1 * u_px); // keep tiny units visible when zoomed out
  float ext = u_pass == 0
    ? max(rd * 1.4, rd + max(0.16, 2.5 * u_px) + max(0.07, 1.6 * u_px)) + 2.0 * u_px
    : rd + 1.5 * u_px;
  v_local = a_corner * ext;
  v_r = rd;
  v_heading = h;
  uint faction = a_attrs & 15u;
  uint arch = (a_attrs >> 4u) & 15u;
  v_color = u_factionColors[faction];
  v_sel = a_sel;
  v_plain = ((u_plainMask >> arch) & 1u) == 1u ? 1.0 : 0.0;
  vec3 clip = u_view * vec3(p + v_local, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 v_local;
flat in float v_r;
flat in float v_heading;
flat in vec3 v_color;
flat in uint v_sel;
flat in float v_plain;
uniform float u_px;
uniform int u_pass;
out vec4 o;

void main() {
  float dist = length(v_local);
  float d = dist - v_r;
  float detail = smoothstep(2.5, 6.0, v_r / u_px); // fade fine details on tiny units

  if (u_pass == 0) {
    vec2 so = v_local - vec2(0.10, 0.16) * v_r;
    float sd = length(so) - v_r;
    float shadow = (1.0 - smoothstep(-v_r * 0.2, v_r * 0.35, sd)) * 0.42 * detail;
    vec4 col = vec4(0.0, 0.0, 0.0, shadow);
    if ((v_sel & 1u) != 0u) {
      float ringR = v_r + max(0.16, 2.5 * u_px);
      float ringW = max(0.07, 1.6 * u_px);
      float rd = abs(dist - ringR) - ringW * 0.5;
      float ring = clamp(0.5 - rd / u_px, 0.0, 1.0);
      col = mix(col, vec4(0.30, 0.95, 0.40, 1.0), ring);
    }
    if ((v_sel & 2u) != 0u) {
      float ringR = v_r + max(0.10, 1.5 * u_px);
      float rd = abs(dist - ringR) - max(0.03, 0.6 * u_px);
      float ring = clamp(0.5 - rd / u_px, 0.0, 1.0);
      col = mix(col, vec4(1.0, 1.0, 1.0, 0.9), ring * 0.8);
    }
    if (col.a <= 0.003) discard;
    o = col;
    return;
  }

  float a = clamp(0.5 - d / u_px, 0.0, 1.0);
  if (a <= 0.0) discard;
  vec2 n = v_local / v_r;
  float light = 0.9 + 0.2 * dot(n, vec2(-0.6, -0.8)) * (1.0 - 0.3 * dot(n, n));
  vec3 c = v_color * light;

  float rimW = max(0.08 * v_r, 1.2 * u_px);
  float rim = smoothstep(-rimW - u_px, -rimW, d) * (1.0 - v_plain) * detail;
  c = mix(c, v_color * 0.42, rim);

  vec2 dir = vec2(cos(v_heading), sin(v_heading));
  vec2 q = vec2(dot(v_local, dir), dot(v_local, vec2(-dir.y, dir.x)));
  float tw = max(0.10 * v_r, 0.9 * u_px);
  float tick = (1.0 - smoothstep(tw * 0.5, tw * 0.5 + u_px, abs(q.y)))
             * smoothstep(0.15 * v_r, 0.15 * v_r + u_px, q.x)
             * (1.0 - smoothstep(0.86 * v_r - 0.5 * u_px, 0.86 * v_r + 0.5 * u_px, q.x));
  c = mix(c, vec3(1.0, 0.98, 0.94), tick * 0.85 * detail * (1.0 - v_plain * 0.6));
  o = vec4(c, a);
}`;

interface GpuSnapshot {
  readonly buf: WebGLBuffer;
  tick: number;
  usedFrame: number;
}

const GPU_SNAPSHOTS = 3;

export class UnitsPass {
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly vao: WebGLVertexArrayObject;
  private readonly gpu: GpuSnapshot[] = [];
  private readonly selBuf: WebGLBuffer;
  private frame = 0;
  private readonly factionColors = new Float32Array(24);

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, 'units', VS, FS);
    this.u = uniforms(gl, this.prog, ['u_view', 'u_alpha', 'u_px', 'u_pass', 'u_factionColors', 'u_plainMask'] as const);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, createQuadBuffer(gl));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (let loc = 1; loc <= 6; loc++) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribDivisor(loc, 1);
    }
    this.selBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.selBuf);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_CAPACITY, gl.DYNAMIC_DRAW);
    gl.vertexAttribIPointer(6, 1, gl.UNSIGNED_BYTE, 1, 0);
    gl.bindVertexArray(null);

    const zeros = new Uint8Array(UNIT_CAPACITY * INST_BYTES);
    for (let k = 0; k < GPU_SNAPSHOTS; k++) {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, zeros, gl.DYNAMIC_DRAW);
      this.gpu.push({ buf, tick: -1, usedFrame: -1 });
    }
  }

  setFactionColors(colors: readonly (readonly [number, number, number])[]): void {
    this.factionColors.fill(0.5);
    colors.forEach((c, i) => this.factionColors.set(c, i * 3));
  }

  /** Uploads per-slot selection/hover flags (call when they change). */
  uploadSelection(flags: Uint8Array, count: number): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.selBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, flags, 0, Math.max(1, count));
  }

  /** Returns the GPU buffer holding snapshot `s`, uploading it if needed. */
  private ensure(s: Snapshot, keep: GpuSnapshot | null): GpuSnapshot {
    const hit = this.gpu.find((g) => g.tick === s.tick);
    if (hit) {
      hit.usedFrame = this.frame;
      return hit;
    }
    let victim = this.gpu[0];
    for (const g of this.gpu) {
      if (g === keep) continue;
      if (victim === keep || g.usedFrame < victim.usedFrame) victim = g;
    }
    const gl = this.gl;
    const hw = s.views.i32[H_HIGH_WATER];
    gl.bindBuffer(gl.ARRAY_BUFFER, victim.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(s.views.buffer as ArrayBuffer, SNAP_HEADER_BYTES, hw * INST_BYTES));
    victim.tick = s.tick;
    victim.usedFrame = this.frame;
    return victim;
  }

  draw(view: Float32Array, a: Snapshot, b: Snapshot, alpha: number, pxPerUnit: number): void {
    const gl = this.gl;
    this.frame++;
    const gb = this.ensure(b, null);
    const ga = this.ensure(a, gb);
    const count = b.views.i32[H_HIGH_WATER];
    if (count === 0) return;

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, ga.buf);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, INST_BYTES, 0);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, INST_BYTES, 20);
    gl.bindBuffer(gl.ARRAY_BUFFER, gb.buf);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, INST_BYTES, 0);
    gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, INST_BYTES, 16);
    gl.vertexAttribIPointer(5, 1, gl.UNSIGNED_INT, INST_BYTES, 20);

    gl.uniformMatrix3fv(this.u.u_view, false, view);
    gl.uniform1f(this.u.u_alpha, alpha);
    gl.uniform1f(this.u.u_px, 1 / pxPerUnit);
    gl.uniform3fv(this.u.u_factionColors, this.factionColors);
    let plainMask = 0;
    ARCHETYPES.forEach((t, i) => { if (t.plain) plainMask |= 1 << i; });
    gl.uniform1ui(this.u.u_plainMask, plainMask);

    gl.uniform1i(this.u.u_pass, 0);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.uniform1i(this.u.u_pass, 1);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.bindVertexArray(null);
  }
}
