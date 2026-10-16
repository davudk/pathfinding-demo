/**
 * Per-unit path storage and a time-budgeted request queue. Requests are deduplicated per
 * unit (the newest wins); each tick the queue serves requests until its time budget is spent.
 */
import { handleIndex } from '../../shared/handles';
import type { UnitStore } from '../store/units';
import { PathSearch } from './astar';
import type { NavMesh } from './navmesh';
import { snapToWalkable } from './query';

export class PathStore {
  /** Polyline per unit slot (null = none). */
  readonly points: (Float64Array | null)[];
  /** Index (in points, not floats) of the next waypoint to reach. */
  readonly cursor: Int32Array;
  /** Bumped whenever a slot gets a new path (for client sync). */
  readonly version: Uint32Array;
  /** 1 while a request for this slot is queued. */
  readonly pending: Uint8Array;
  readonly complete: Uint8Array;

  constructor(capacity: number) {
    this.points = new Array<Float64Array | null>(capacity).fill(null);
    this.cursor = new Int32Array(capacity);
    this.version = new Uint32Array(capacity);
    this.pending = new Uint8Array(capacity);
    this.complete = new Uint8Array(capacity);
  }

  set(slot: number, pts: Float64Array | null, complete: boolean): void {
    this.points[slot] = pts;
    this.cursor[slot] = pts ? 1 : 0;
    this.complete[slot] = complete ? 1 : 0;
    this.version[slot]++;
  }

  clear(slot: number): void {
    if (this.points[slot] === null && !this.pending[slot]) return;
    this.points[slot] = null;
    this.pending[slot] = 0;
    this.version[slot]++;
  }
}

interface Request {
  handle: number;
  gx: number;
  gy: number;
  seq: number;
}

export interface PathStats {
  served: number;
  queued: number;
  ms: number;
  expansions: number;
}

export class PathQueue {
  private queue: Request[] = [];
  private head = 0;
  private seq = 0;
  /** Latest request sequence number per slot; older requests for the slot are dropped. */
  private latest: Int32Array;
  readonly search: PathSearch;
  readonly stats: PathStats = { served: 0, queued: 0, ms: 0, expansions: 0 };

  constructor(private readonly nav: NavMesh, capacity: number, private readonly paths: PathStore) {
    this.latest = new Int32Array(capacity).fill(-1);
    this.search = new PathSearch(nav);
  }

  request(handle: number, gx: number, gy: number): void {
    const slot = handleIndex(handle);
    const seq = this.seq++;
    this.latest[slot] = seq;
    this.paths.pending[slot] = 1;
    this.queue.push({ handle, gx, gy, seq });
  }

  cancel(slot: number): void {
    this.latest[slot] = -1;
    this.paths.pending[slot] = 0;
  }

  get size(): number {
    return this.queue.length - this.head;
  }

  /**
   * Serves requests until `budgetExpansions` search nodes have been expanded (at least one
   * request per call). The budget is counted in search work, not wall time, so the simulation
   * stays deterministic regardless of machine speed.
   */
  process(units: UnitStore, budgetExpansions: number, onDone: (slot: number, ok: boolean) => void): void {
    const t0 = performance.now();
    let served = 0;
    let expansions = 0;
    while (this.head < this.queue.length) {
      if (served > 0 && expansions >= budgetExpansions) break;
      const req = this.queue[this.head++];
      const slot = handleIndex(req.handle);
      if (this.latest[slot] !== req.seq || !units.isValid(req.handle)) continue;
      this.latest[slot] = -1;
      this.paths.pending[slot] = 0;
      served++;
      const r = units.radius[slot];
      const start = snapToWalkable(this.nav, units.posX[slot], units.posY[slot], r, 6);
      const goal = snapToWalkable(this.nav, req.gx, req.gy, r, 24);
      if (!start || !goal) {
        this.paths.set(slot, null, false);
        onDone(slot, false);
        continue;
      }
      const res = this.search.find({ sx: start[0], sy: start[1], gx: goal[0], gy: goal[1], r });
      // Count at least a nominal cost per request so trivial queries can't flood a tick.
      expansions += Math.max(64, this.search.lastExpansions);
      if (!res) {
        this.paths.set(slot, null, false);
        onDone(slot, false);
        continue;
      }
      // Begin from the unit's actual position (it may have been nudged by the snap).
      const pts = res.points;
      pts[0] = units.posX[slot];
      pts[1] = units.posY[slot];
      this.paths.set(slot, pts, res.complete);
      onDone(slot, true);
    }
    if (this.head > 1024 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    this.stats.served = served;
    this.stats.queued = this.size;
    this.stats.ms = performance.now() - t0;
    this.stats.expansions = expansions;
  }
}
