/**
 * Destination fields (docs/research/03 §2): one reverse Dijkstra over navmesh triangles from a
 * group's goal, per radius class, shared by every unit of the order. Each settled triangle
 * knows which edge to cross next and how far the goal is, so units need no search of their
 * own — they funnel a short corridor read straight off the field.
 *
 * Fields are bounded (they stop once every member's triangle is settled, plus a margin) and
 * resumable (a unit that wanders into an unsettled triangle just asks for it).
 */
import { MAX_UNIT_RADIUS } from '../../shared/archetypes';
import { NONE, next, prev } from './cdt';
import { Heap, PASSAGE_SLACK } from './astar';
import { RADIUS_CLASSES, type NavMesh } from './navmesh';
import { snapToWalkable } from './query';

export class DestField {
  readonly id: number;
  readonly key: string;
  readonly cls: number;
  /** Class radius (conservative for every member of the class). */
  readonly r: number;
  goalX: number;
  goalY: number;
  /** Goal triangle, or NONE when the goal is unusable (then nothing settles). */
  tg = NONE;
  /** Navmesh version the data refers to. */
  version = -1;
  dist = new Float64Array(0);
  /** Halfedge of the triangle to cross next toward the goal (NONE = goal / unsettled). */
  next = new Int32Array(0);
  /** Crossing point on that edge. */
  px = new Float64Array(0);
  py = new Float64Array(0);
  settled = new Uint8Array(0);
  settledCount = 0;
  /** Bounding box of settled triangles (selective invalidation on mesh edits). */
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  private readonly heap = new Heap();
  /** Triangles some member needs settled. */
  private readonly pending = new Set<number>();
  private maxPendingDist = 0;
  /** True when the search has stopped (bounded) or exhausted the reachable region. */
  done = false;
  exhausted = false;
  refs = 0;

  constructor(id: number, key: string, cls: number, goalX: number, goalY: number, private readonly nav: NavMesh) {
    this.id = id;
    this.key = key;
    this.cls = cls;
    this.r = RADIUS_CLASSES[cls];
    this.goalX = goalX;
    this.goalY = goalY;
    this.reset();
  }

  /** (Re)starts the search on the current mesh. */
  reset(): void {
    const cdt = this.nav.cdt;
    const cap = cdt.tFlags.length;
    if (this.dist.length !== cap) {
      this.dist = new Float64Array(cap);
      this.next = new Int32Array(cap);
      this.px = new Float64Array(cap);
      this.py = new Float64Array(cap);
      this.settled = new Uint8Array(cap);
    }
    this.dist.fill(Infinity);
    this.next.fill(NONE);
    this.settled.fill(0);
    this.settledCount = 0;
    this.minX = this.minY = Infinity;
    this.maxX = this.maxY = -Infinity;
    this.heap.clear();
    this.pending.clear();
    this.maxPendingDist = 0;
    this.done = false;
    this.exhausted = false;
    this.version = this.nav.version;
    // Snap the goal to a spot the whole class fits.
    const s = snapToWalkable(this.nav, this.goalX, this.goalY, this.r, 24);
    this.tg = NONE;
    if (!s) {
      this.done = this.exhausted = true;
      return;
    }
    this.goalX = s[0];
    this.goalY = s[1];
    const tg = cdt.locate(s[0], s[1]);
    if (tg === NONE || cdt.tBlock[tg] > 0) {
      this.done = this.exhausted = true;
      return;
    }
    this.tg = tg;
    this.dist[tg] = 0;
    this.px[tg] = s[0];
    this.py[tg] = s[1];
    this.heap.push(tg, 0);
  }

  /** A member is in triangle t: make sure it gets settled (resumes a finished search). */
  need(t: number): void {
    if (t === NONE || this.settled[t] || this.exhausted) return;
    this.pending.add(t);
    this.done = false;
  }

  /** Expands up to `budget` triangles; returns how many were expanded. */
  expand(budget: number): number {
    if (this.done) return 0;
    const cdt = this.nav.cdt;
    const { dist, nxt, px, py, settled } = { dist: this.dist, nxt: this.next, px: this.px, py: this.py, settled: this.settled };
    const twoR = 2 * this.r + PASSAGE_SLACK;
    const r = this.r;
    let n = 0;
    while (n < budget) {
      if (this.heap.size === 0) {
        this.done = this.exhausted = true;
        break;
      }
      // Bounded: once every member is settled, keep a margin of slack and stop.
      if (this.pending.size === 0 && this.heap.topKey() > this.maxPendingDist * 1.25 + 4 * MAX_UNIT_RADIUS + 16) {
        this.done = true;
        break;
      }
      const t = this.heap.pop();
      if (settled[t]) continue;
      settled[t] = 1;
      this.settledCount++;
      n++;
      for (let k = 0; k < 3; k++) {
        const v = cdt.tri[3 * t + k];
        const vx = cdt.vx[v], vy = cdt.vy[v];
        if (vx < this.minX) this.minX = vx;
        if (vx > this.maxX) this.maxX = vx;
        if (vy < this.minY) this.minY = vy;
        if (vy > this.maxY) this.maxY = vy;
      }
      if (this.pending.delete(t)) this.maxPendingDist = Math.max(this.maxPendingDist, dist[t]);
      const exit = nxt[t];
      for (let k = 0; k < 3; k++) {
        const e = 3 * t + k;
        if (e === exit) continue;
        const f = cdt.opp[e];
        if (f === NONE || cdt.cRef[e] > 0) continue;
        const u = (f / 3) | 0;
        if (settled[u] || cdt.tBlock[u] > 0) continue;
        const a = cdt.tri[e], b = cdt.tri[next(e)];
        const ax = cdt.vx[a], ay = cdt.vy[a], bx = cdt.vx[b], by = cdt.vy[b];
        const ex = bx - ax, ey = by - ay;
        const len = Math.hypot(ex, ey);
        if (len < twoR) continue;
        // Passing through t from this edge to its exit goes around the vertex they share.
        if (exit !== NONE) {
          const slot = exit === next(e) ? exit % 3 : exit === prev(e) ? e % 3 : -1;
          if (slot >= 0 && cdt.tWidth[3 * t + slot] < twoR) continue;
        }
        // Crossing point: closest point (on the edge shrunk by r) to t's own point.
        const sh = Math.min(r, len * 0.5) / len;
        const sx = ax + ex * sh, sy = ay + ey * sh;
        const lx = ex * (1 - 2 * sh), ly = ey * (1 - 2 * sh);
        const l2 = lx * lx + ly * ly;
        let w = l2 > 0 ? ((px[t] - sx) * lx + (py[t] - sy) * ly) / l2 : 0;
        w = w < 0 ? 0 : w > 1 ? 1 : w;
        const cx = sx + lx * w, cy = sy + ly * w;
        const g = dist[t] + Math.hypot(cx - px[t], cy - py[t]);
        if (g < dist[u]) {
          dist[u] = g;
          nxt[u] = f; // u's halfedge facing t
          px[u] = cx;
          py[u] = cy;
          this.heap.push(u, g);
        }
      }
    }
    return n;
  }

  /**
   * After a mesh edit: the field is stale only if one of the rewritten / freed triangles was
   * settled in it (any chain into the edited area passes through such a triangle). Otherwise
   * every settled id and next-pointer is unchanged and the field is kept as is.
   */
  onMeshEdit(dirtyTris: readonly number[] | null): boolean {
    let hit = dirtyTris === null;
    if (!hit) for (const t of dirtyTris!) if (t < this.settled.length && this.settled[t]) { hit = true; break; }
    if (hit) {
      this.reset();
      return true;
    }
    // Untouched: grow arrays if the mesh grew, keep everything else.
    const cap = this.nav.cdt.tFlags.length;
    if (this.dist.length < cap) {
      const grow = <T extends Float64Array | Int32Array | Uint8Array>(a: T, fill: number): T => {
        const b = new (a.constructor as new (n: number) => T)(cap);
        b.fill(fill);
        b.set(a);
        return b;
      };
      this.dist = grow(this.dist, Infinity);
      this.next = grow(this.next, NONE);
      this.px = grow(this.px, 0);
      this.py = grow(this.py, 0);
      this.settled = grow(this.settled, 0);
    }
    this.version = this.nav.version;
    return false;
  }

  /** Memory footprint (bytes), for stats. */
  get bytes(): number {
    return this.dist.byteLength + this.next.byteLength + this.px.byteLength + this.py.byteLength + this.settled.byteLength;
  }
}

/** Deduplicated, ref-counted fields keyed by (goal, class); expanded under a shared budget. */
export class FieldRegistry {
  private readonly byId = new Map<number, DestField>();
  private readonly byKey = new Map<string, DestField>();
  private nextId = 1;
  /** Stats for the HUD. */
  expandedLastTick = 0;

  constructor(private readonly nav: NavMesh) {}

  get(id: number): DestField | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }

  /** Debug arrows (x0, y0, x1, y1, cls) from settled triangle centroids to their crossing point. */
  exportArrows(maxArrows = 60_000): { arrows: Float32Array; settled: number } {
    const cdt = this.nav.cdt;
    const out: number[] = [];
    let settled = 0;
    for (const f of this.byId.values()) {
      if (f.version !== this.nav.version) continue;
      for (let t = 0; t < cdt.tCount && out.length < maxArrows * 5; t++) {
        if (!f.settled[t] || !cdt.isLiveTri(t)) continue;
        settled++;
        const a = cdt.tri[3 * t], b = cdt.tri[3 * t + 1], c = cdt.tri[3 * t + 2];
        const cx = (cdt.vx[a] + cdt.vx[b] + cdt.vx[c]) / 3, cy = (cdt.vy[a] + cdt.vy[b] + cdt.vy[c]) / 3;
        const tx = t === f.tg ? f.goalX : f.px[t], ty = t === f.tg ? f.goalY : f.py[t];
        out.push(cx, cy, tx, ty, f.cls);
      }
    }
    return { arrows: Float32Array.from(out), settled };
  }

  /** Field toward (x, y) for radius class `cls`; shares an existing one when possible. */
  acquire(x: number, y: number, cls: number): DestField {
    const key = `${Math.round(x * 2)},${Math.round(y * 2)},${cls}`;
    let f = this.byKey.get(key);
    if (!f) {
      f = new DestField(this.nextId++, key, cls, x, y, this.nav);
      this.byId.set(f.id, f);
      this.byKey.set(key, f);
    }
    f.refs++;
    return f;
  }

  release(id: number): void {
    const f = this.byId.get(id);
    if (!f || --f.refs > 0) return;
    this.byId.delete(id);
    this.byKey.delete(f.key);
  }

  /** Applies a mesh edit to every field; returns how many had to restart. */
  onMeshEdit(dirtyTris: readonly number[] | null): number {
    let reset = 0;
    for (const f of this.byId.values()) if (f.onMeshEdit(dirtyTris)) reset++;
    return reset;
  }

  /** Expands fields round-robin until `budget` triangles are settled this tick. */
  expandAll(budget: number): number {
    let used = 0;
    for (const f of this.byId.values()) {
      if (f.version !== this.nav.version) f.reset(); // mesh changed: start over
    }
    let progress = true;
    while (used < budget && progress) {
      progress = false;
      for (const f of this.byId.values()) {
        if (f.done) continue;
        const k = f.expand(Math.min(4096, budget - used));
        used += k;
        if (k > 0) progress = true;
        if (used >= budget) break;
      }
    }
    this.expandedLastTick = used;
    return used;
  }
}
