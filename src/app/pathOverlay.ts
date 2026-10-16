import { INST_WORDS, I_HANDLE, I_X, I_Y, SNAP_HEADER_WORDS, type PathEntry } from '../shared/protocol';
import { rgba, type LineBatch } from '../render/passes/lines';
import type { Snapshot } from './snapshotRing';

interface Watched {
  points: Float32Array;
  cursor: number;
  complete: boolean;
}

const MAX_DRAWN = 400;
const COLOR = rgba(90, 235, 130, 190);
const COLOR_INCOMPLETE = rgba(255, 170, 60, 200);

/** Draws the remaining path of each selected unit, from its interpolated position onward. */
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
      if (e.points) this.paths.set(e.handle, { points: e.points, cursor: e.cursor, complete: e.complete });
      else {
        const w = this.paths.get(e.handle);
        if (w) w.cursor = e.cursor;
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
      const p = w.points;
      const n = p.length >> 1;
      if (w.cursor >= n) continue;
      const col = w.complete ? COLOR : COLOR_INCOMPLETE;
      let px = x, py = y;
      for (let k = w.cursor; k < n; k++) {
        batch.add(px, py, p[2 * k], p[2 * k + 1], col, 1.5);
        px = p[2 * k];
        py = p[2 * k + 1];
      }
      // End marker: a small cross.
      const s = 0.35;
      batch.add(px - s, py - s, px + s, py + s, col, 1.5);
      batch.add(px - s, py + s, px + s, py - s, col, 1.5);
    }
  }
}

/** Expanding/fading ground rings where move orders were given. */
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
      const col = (m.color & 0x00ffffff) | (alpha << 24);
      const seg = 24;
      for (let k = 0; k < seg; k++) {
        const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
        b.add(m.x + Math.cos(a0) * r, m.y + Math.sin(a0) * r, m.x + Math.cos(a1) * r, m.y + Math.sin(a1) * r, col >>> 0, 2);
      }
    }
  }
}
