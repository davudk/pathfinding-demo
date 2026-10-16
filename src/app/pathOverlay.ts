import { INST_WORDS, I_HANDLE, I_X, I_Y, SNAP_HEADER_WORDS, type PathEntry } from '../shared/protocol';
import { rgba, type LineBatch } from '../render/passes/lines';
import type { Snapshot } from './snapshotRing';

interface Watched {
  points: Float32Array | null;
  cursor: number;
  complete: boolean;
  queue: Float32Array;
  loop: boolean;
  patrolNow: boolean;
}

const MAX_DRAWN = 400;
const GREEN = rgba(90, 235, 130, 190);
const GREEN_DIM = rgba(90, 235, 130, 110);
const YELLOW = rgba(250, 210, 70, 200);
const ORANGE = rgba(255, 170, 60, 200);
const EMPTY = new Float32Array(0);

/**
 * SC2-style order lines for selected units: the remaining path from each unit's interpolated
 * position, then straight legs through its queued waypoints (green moves, yellow patrol loops).
 */
export class PathOverlay {
  private readonly paths = new Map<number, Watched>();
  enabled = true;

  constructor(readonly batch: LineBatch) {}

  reset(): void {
    this.paths.clear();
  }

  receive(entries: readonly PathEntry[], cleared: Int32Array): void {
    for (const h of cleared) this.paths.delete(h);
    for (const e of entries) {
      let w = this.paths.get(e.handle);
      if (!w) {
        w = { points: null, cursor: 0, complete: true, queue: EMPTY, loop: false, patrolNow: false };
        this.paths.set(e.handle, w);
      }
      if (e.points) w.points = e.points;
      w.cursor = e.cursor;
      w.complete = e.complete;
      w.patrolNow = e.patrolNow;
      if (e.queue) {
        w.queue = e.queue;
        w.loop = e.loop;
      }
    }
  }

  /** Rebuilds the line batch for this frame. */
  update(a: Snapshot, b: Snapshot, alpha: number): void {
    const batch = this.batch;
    batch.clear();
    if (!this.enabled) return;
    let drawn = 0;
    for (const [h, w] of this.paths) {
      if (drawn++ >= MAX_DRAWN) break;
      const slot = h & 0xffff;
      const ob = SNAP_HEADER_WORDS + slot * INST_WORDS;
      if (b.views.u32[ob + I_HANDLE] !== h) continue;
      let x = b.views.f32[ob + I_X], y = b.views.f32[ob + I_Y];
      if (a.views.u32[ob + I_HANDLE] === h) {
        x = a.views.f32[ob + I_X] + (x - a.views.f32[ob + I_X]) * alpha;
        y = a.views.f32[ob + I_Y] + (y - a.views.f32[ob + I_Y]) * alpha;
      }
      const patrolling = w.loop;
      const pathCol = !w.complete ? ORANGE : w.patrolNow ? YELLOW : GREEN;
      let px = x, py = y;
      const p = w.points;
      if (p) {
        const n = p.length >> 1;
        for (let k = w.cursor; k < n; k++) {
          batch.add(px, py, p[2 * k], p[2 * k + 1], pathCol, 1.5);
          px = p[2 * k];
          py = p[2 * k + 1];
        }
      }
      const loopStartX = px, loopStartY = py;
      marker(batch, px, py, pathCol);
      // Queued orders: straight legs (their real paths are planned when they start).
      const q = w.queue;
      for (let k = 0; k < q.length; k += 3) {
        const col = q[k + 2] === 2 ? YELLOW : GREEN_DIM;
        batch.add(px, py, q[k], q[k + 1], col, 1.25);
        px = q[k];
        py = q[k + 1];
        marker(batch, px, py, col);
      }
      if (patrolling && q.length > 0) batch.add(px, py, loopStartX, loopStartY, YELLOW, 1.25);
    }
  }
}

function marker(batch: LineBatch, x: number, y: number, col: number): void {
  const s = 0.35;
  batch.add(x - s, y - s, x + s, y + s, col, 1.5);
  batch.add(x - s, y + s, x + s, y - s, col, 1.5);
}

/** Shrinking ground rings where orders were given (green move, yellow patrol). */
export class ClickMarkers {
  private readonly items: { x: number; y: number; t0: number; color: number }[] = [];

  constructor(readonly batch: LineBatch) {}

  add(x: number, y: number, color = rgba(90, 235, 130, 255)): void {
    this.items.push({ x, y, t0: performance.now(), color });
  }

  update(now: number, zoom: number): void {
    const b = this.batch;
    b.clear();
    const life = 420;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const m = this.items[i];
      const t = (now - m.t0) / life;
      if (t >= 1) {
        this.items.splice(i, 1);
        continue;
      }
      // Ring shrinks toward the click point (SC2 style), constant size on screen.
      const r = ((1 - t) * 14 + 3) / zoom;
      const alpha = Math.round(255 * (1 - t * t));
      const col = ((m.color & 0x00ffffff) | (alpha << 24)) >>> 0;
      const seg = 24;
      for (let k = 0; k < seg; k++) {
        const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
        b.add(m.x + Math.cos(a0) * r, m.y + Math.sin(a0) * r, m.x + Math.cos(a1) * r, m.y + Math.sin(a1) * r, col, 2);
      }
    }
  }
}

export const MARKER_MOVE = rgba(90, 235, 130, 255);
export const MARKER_PATROL = rgba(250, 210, 70, 255);
