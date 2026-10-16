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
  /** 1 = the path is a local look-ahead (field corridor) that stops short of the goal. */
  readonly partial: Uint8Array;
  /** 1 = the path is a detour that must be walked out before field refreshes replace it. */
  readonly locked: Uint8Array;

  constructor(capacity: number) {
    this.points = new Array<Float64Array | null>(capacity).fill(null);
    this.cursor = new Int32Array(capacity);
    this.version = new Uint32Array(capacity);
    this.pending = new Uint8Array(capacity);
    this.complete = new Uint8Array(capacity);
    this.partial = new Uint8Array(capacity);
    this.locked = new Uint8Array(capacity);
  }

  set(slot: number, pts: Float64Array | null, complete: boolean, partial = false): void {
    this.points[slot] = pts;
    this.cursor[slot] = pts ? 1 : 0;
    this.complete[slot] = complete ? 1 : 0;
    this.partial[slot] = partial ? 1 : 0;
    this.locked[slot] = 0;
    this.version[slot]++;
  }

  clear(slot: number): void {
    if (this.points[slot] === null && !this.pending[slot]) return;
    this.points[slot] = null;
    this.pending[slot] = 0;
    this.partial[slot] = 0;
    this.locked[slot] = 0;
    this.version[slot]++;
  }
}

interface Request {
  handle: number;
  gx: number;
  gy: number;
  seq: number;
  priority: number;
}

export interface PathStats {
  served: number;
  queued: number;
  ms: number;
  expansions: number;
}

/** Request priorities: player orders are served before ambient AI. */
export const PRIORITY_PLAYER = 0;
export const PRIORITY_AI = 1;
/** Share of the per-tick path budget ambient AI may use. */
const AI_SHARE = 0.25;

class Fifo {
  items: Request[] = [];
  head = 0;
  get size(): number {
    return this.items.length - this.head;
  }
  push(r: Request): void {
    this.items.push(r);
  }
  shift(): Request {
    const r = this.items[this.head++];
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return r;
  }
}

export class PathQueue {
  private readonly queues = [new Fifo(), new Fifo()];
  private seq = 0;
  /** Latest request sequence number per slot; older requests for the slot are dropped. */
  private latest: Int32Array;
  readonly search: PathSearch;
  readonly stats: PathStats = { served: 0, queued: 0, ms: 0, expansions: 0 };

  constructor(private readonly nav: NavMesh, capacity: number, private readonly paths: PathStore) {
    this.latest = new Int32Array(capacity).fill(-1);
    this.search = new PathSearch(nav);
  }

  request(handle: number, gx: number, gy: number, priority = PRIORITY_PLAYER): void {
    const slot = handleIndex(handle);
    const seq = this.seq++;
    this.latest[slot] = seq;
    this.paths.pending[slot] = 1;
    this.queues[priority].push({ handle, gx, gy, seq, priority });
  }

  cancel(slot: number): void {
    this.latest[slot] = -1;
    this.paths.pending[slot] = 0;
  }

  get size(): number {
    return this.queues[0].size + this.queues[1].size;
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
    let aiServed = 0;
    let aiExpansions = 0;
    const aiBudget = budgetExpansions * AI_SHARE;
    for (;;) {
      if (served > 0 && expansions >= budgetExpansions) break;
      // Player requests first; ambient AI gets at most AI_SHARE of the budget (and at least one
      // request per tick, so it never starves) — this keeps AI bursts from spiking tick time.
      const aiTurn = this.queues[0].size === 0 || (aiServed === 0 && expansions > budgetExpansions * 0.8);
      if (aiTurn && (this.queues[1].size === 0 || (aiServed > 0 && aiExpansions >= aiBudget))) {
        if (this.queues[0].size === 0) break;
      }
      const useAi = aiTurn && this.queues[1].size > 0 && (aiServed === 0 || aiExpansions < aiBudget);
      const q = useAi ? this.queues[1] : this.queues[0];
      if (q.size === 0) break;
      const req = q.shift();
      if (useAi) aiServed++;
      const before = expansions;
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
      const res = this.search.find({ sx: start[0], sy: start[1], gx: goal[0], gy: goal[1], r, quick: req.priority === PRIORITY_AI });
      // Count at least a nominal cost per request so trivial queries can't flood a tick.
      expansions += Math.max(64, this.search.lastExpansions);
      if (useAi) aiExpansions += expansions - before;
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
    this.stats.served = served;
    this.stats.queued = this.size;
    this.stats.ms = performance.now() - t0;
    this.stats.expansions = expansions;
  }
}
