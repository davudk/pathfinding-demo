/**
 * Main thread ↔ simulation protocol and the render snapshot layout.
 *
 * Snapshot buffer = header (SNAP_HEADER_BYTES) + one instance record per unit slot
 * in [0, highWater). Records are indexed by slot, so the same slot in two consecutive
 * snapshots is the same unit iff the handles match. That is what lets the GPU interpolate
 * prev → curr without any CPU work.
 */

import { UNIT_CAPACITY } from './constants';

// ── Header (int32 / float32 words) ────────────────────────────────────────────
export const SNAP_HEADER_WORDS = 64;
export const SNAP_HEADER_BYTES = SNAP_HEADER_WORDS * 4;
export const H_TICK = 0;
export const H_HIGH_WATER = 1;
export const H_ALIVE = 2;
export const H_MAP_W = 3;
export const H_MAP_H = 4;
/** Float64 index (words 8–9): absolute publish time, performance.timeOrigin + now(), ms. */
export const H_TIME_F64 = 4;
/** Float32 per-system timings (ms) of the tick that produced the snapshot. */
export const H_SYS_BASE = 16;
export const H_SYS_MAX = 32;

// ── Instance record (6 words = 24 bytes) ──────────────────────────────────────
export const INST_WORDS = 6;
export const INST_BYTES = INST_WORDS * 4;
export const I_X = 0; // f32
export const I_Y = 1; // f32
export const I_HEADING = 2; // f32 radians
export const I_RADIUS = 3; // f32, 0 = empty slot
export const I_ATTRS = 4; // u32, see packAttrs
export const I_HANDLE = 5; // u32

/** attrs: faction (4 bits) | archetype (4) | moveState (4) | flags (20). */
export function packAttrs(faction: number, archetype: number, state: number, flags: number): number {
  return ((faction & 0xf) | ((archetype & 0xf) << 4) | ((state & 0xf) << 8) | ((flags & 0xfffff) << 12)) >>> 0;
}
export const attrFaction = (a: number): number => a & 0xf;
export const attrArchetype = (a: number): number => (a >>> 4) & 0xf;
export const attrState = (a: number): number => (a >>> 8) & 0xf;

export function snapshotByteLength(capacity: number = UNIT_CAPACITY): number {
  return SNAP_HEADER_BYTES + capacity * INST_BYTES;
}

/** Typed views over one snapshot. */
export interface SnapshotViews {
  readonly buffer: ArrayBufferLike;
  readonly i32: Int32Array;
  readonly f32: Float32Array;
  readonly u32: Uint32Array;
  /** Header-only float64 view (8 doubles). */
  readonly f64: Float64Array;
}

export function snapshotViews(buffer: ArrayBufferLike, byteOffset = 0, capacity = UNIT_CAPACITY): SnapshotViews {
  const words = Math.min(snapshotByteLength(capacity), buffer.byteLength - byteOffset) >> 2;
  return {
    buffer,
    i32: new Int32Array(buffer, byteOffset, words),
    f32: new Float32Array(buffer, byteOffset, words),
    u32: new Uint32Array(buffer, byteOffset, words),
    f64: new Float64Array(buffer, byteOffset, 8),
  };
}

// ── Shared-memory ring (cross-origin isolated mode) ───────────────────────────
/** Control block: [latestTick, writing flag, ...], int32. */
export const SAB_CTRL_BYTES = 64;
export const SAB_CTRL_LATEST = 0;
export const SAB_RING = 8;

export function sabByteLength(capacity = UNIT_CAPACITY): number {
  return SAB_CTRL_BYTES + SAB_RING * snapshotByteLength(capacity);
}

export function sabSlotOffset(tick: number, capacity = UNIT_CAPACITY): number {
  return SAB_CTRL_BYTES + (tick % SAB_RING) * snapshotByteLength(capacity);
}

// ── Scene configuration ───────────────────────────────────────────────────────
export interface SceneConfig {
  readonly name: string;
  readonly seed: number;
  readonly units: number;
}

// ── Commands (applied by the sim at the start of the next tick) ───────────────
export type SimCommand =
  | { readonly kind: 'spawnRandom'; readonly count: number }
  | { readonly kind: 'despawn'; readonly handles: Int32Array };

// ── Messages ──────────────────────────────────────────────────────────────────
export type Transport = 'sab' | 'transfer';

export type ToSim =
  | { readonly type: 'init'; readonly scene: SceneConfig; readonly transport: Transport; readonly sab?: SharedArrayBuffer }
  | { readonly type: 'command'; readonly cmd: SimCommand }
  | { readonly type: 'control'; readonly paused?: boolean; readonly timeScale?: number; readonly step?: boolean }
  | { readonly type: 'returnBuffer'; readonly buffer: ArrayBuffer };

export type FromSim =
  | { readonly type: 'ready'; readonly mapW: number; readonly mapH: number }
  | { readonly type: 'snapshot'; readonly tick: number; readonly buffer: ArrayBuffer }
  | { readonly type: 'error'; readonly message: string };

/** Minimal port shape shared by DedicatedWorkerGlobalScope and Worker. */
export interface Port<TOut, TIn> {
  postMessage(message: TOut, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<TIn>) => void) | null;
}
