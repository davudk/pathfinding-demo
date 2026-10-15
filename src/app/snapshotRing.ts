import { H_TICK, snapshotViews, type SnapshotViews } from '../shared/protocol';

export interface Snapshot {
  readonly tick: number;
  readonly views: SnapshotViews;
}

/**
 * The last few snapshots received from the simulation, ordered by tick.
 * Evicted buffers are handed back through `onEvict` (returned to the worker or a local pool).
 */
export class SnapshotRing {
  private readonly items: Snapshot[] = [];
  /** Wall time (performance.now) at which the newest snapshot was received. */
  latestArrival = 0;

  constructor(
    private readonly capacity: number,
    private readonly onEvict: (buffer: ArrayBuffer) => void,
  ) {}

  get latest(): Snapshot | null {
    return this.items.length > 0 ? this.items[this.items.length - 1] : null;
  }

  get oldest(): Snapshot | null {
    return this.items.length > 0 ? this.items[0] : null;
  }

  push(buffer: ArrayBuffer): void {
    const views = snapshotViews(buffer);
    const tick = views.i32[H_TICK];
    const latest = this.latest;
    if (latest && tick <= latest.tick) {
      this.onEvict(buffer); // stale or duplicate
      return;
    }
    this.items.push({ tick, views });
    this.latestArrival = performance.now();
    while (this.items.length > this.capacity) this.onEvict(this.items.shift()!.views.buffer as ArrayBuffer);
  }

  /**
   * Finds snapshots bracketing render time `t` (in ticks): a.tick ≤ t < b.tick.
   * Returns false when nothing has arrived yet. When `t` is past the newest, a = b = newest.
   */
  bracket(t: number, out: { a: Snapshot | null; b: Snapshot | null; alpha: number }): boolean {
    const n = this.items.length;
    if (n === 0) return false;
    let a = this.items[0];
    let b = a;
    for (let k = 0; k < n; k++) {
      const s = this.items[k];
      if (s.tick <= t) a = s;
      if (s.tick > t) {
        b = s;
        break;
      }
      b = s;
    }
    out.a = a;
    out.b = b;
    out.alpha = b.tick > a.tick ? Math.min(1, Math.max(0, (t - a.tick) / (b.tick - a.tick))) : 0;
    if (b.tick <= t) out.a = b; // past the newest: hold it
    return true;
  }
}
