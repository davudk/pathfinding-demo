/**
 * TA*-style A* over navmesh triangles for a circle of radius r (Demyen).
 *
 * Search nodes are halfedges: node n = the edge through which triangle ⌊n/3⌋ was entered.
 * A transition from entry n to exit x of the same triangle passes around the vertex the two
 * edges share and requires that corner's width ≥ 2r. g uses the best crossing point on each
 * edge (shrunk by r at both ends); after the first goal arrival the search keeps going
 * (anytime) and keeps the corridor whose funnelled length is shortest.
 */
import { DynamicCDT, NONE, next, prev } from './cdt';
import { funnel, type Corridor, type FunnelResult } from './funnel';
import { clearance, type Clearance } from './query';
import type { NavMesh } from './navmesh';

/**
 * Extra width a passage needs beyond the unit's diameter. Exactly-fitting passages make the
 * funnel's inner tangents degenerate (and leave locomotion zero slack), so they're refused.
 */
export const PASSAGE_SLACK = 0.02;

/** Paths may come this much closer than r to obstacles (sampling resolution; 1 cm). */
export const CLEARANCE_TOLERANCE = 0.01;

export interface PathQuery {
  sx: number;
  sy: number;
  gx: number;
  gy: number;
  r: number;
  /** Max node expansions (safety cap). */
  maxExpansions?: number;
}

export interface PathResult extends FunnelResult {
  /** True when the goal was reached; false = path to the closest reachable point. */
  readonly complete: boolean;
  readonly expansions: number;
  /** Triangles of the corridor (start → end). */
  readonly corridor: Int32Array;
  /** False if no clearance-valid route was found and this one grazes an obstacle. */
  readonly clear: boolean;
}

class Heap {
  ids = new Int32Array(1024);
  keys = new Float64Array(1024);
  size = 0;
  clear(): void {
    this.size = 0;
  }
  push(id: number, key: number): void {
    if (this.size === this.ids.length) {
      const ni = new Int32Array(this.size * 2);
      ni.set(this.ids);
      this.ids = ni;
      const nk = new Float64Array(this.size * 2);
      nk.set(this.keys);
      this.keys = nk;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p];
      this.keys[i] = this.keys[p];
      i = p;
    }
    this.ids[i] = id;
    this.keys[i] = key;
  }
  topKey(): number {
    return this.keys[0];
  }
  pop(): number {
    const top = this.ids[0];
    const id = this.ids[--this.size];
    const key = this.keys[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.ids[i] = this.ids[c];
      this.keys[i] = this.keys[c];
      i = c;
    }
    this.ids[i] = id;
    this.keys[i] = key;
    return top;
  }
}

/** Reusable search state; one per thread. Arrays grow with the mesh. */
export class PathSearch {
  private g = new Float64Array(0);
  private px = new Float64Array(0);
  private py = new Float64Array(0);
  private parent = new Int32Array(0);
  private stamp = new Uint32Array(0);
  private closed = new Uint32Array(0);
  private gen = 0;
  private readonly heap = new Heap();
  lastExpansions = 0;

  constructor(private readonly nav: NavMesh) {}

  private ensure(n: number): void {
    if (this.g.length >= n) return;
    const cap = Math.max(n, this.g.length * 2);
    this.g = new Float64Array(cap);
    this.px = new Float64Array(cap);
    this.py = new Float64Array(cap);
    this.parent = new Int32Array(cap);
    this.stamp = new Uint32Array(cap);
    this.closed = new Uint32Array(cap);
    this.gen = 0;
  }

  /**
   * Finds a path for a circle of radius q.r. Start and goal must already be valid positions
   * (see snapToWalkable). Returns null only if the start lies outside the mesh or in an obstacle.
   */
  find(q: PathQuery): PathResult | null {
    const cdt = this.nav.cdt;
    const { sx, sy, gx, gy, r } = q;
    const ts = cdt.locate(sx, sy);
    if (ts === NONE || cdt.tBlock[ts] > 0) return null;
    const tg = cdt.locate(gx, gy);
    if (ts === tg) return this.straight(q, ts);

    this.ensure(cdt.tCount * 3);
    const gen = ++this.gen;
    const heap = this.heap;
    heap.clear();
    const { g, px, py, parent, stamp, closed } = this;
    const maxExp = q.maxExpansions ?? 60_000;
    const twoR = 2 * r + PASSAGE_SLACK;
    const goalFree = tg !== NONE && cdt.tBlock[tg] === 0;

    // Seed: cross each edge of the start triangle.
    for (let k = 0; k < 3; k++) {
      const x = 3 * ts + k;
      const n = this.enterable(x, twoR);
      if (n === NONE) continue;
      this.edgePoint(n, sx, sy, gx, gy, r);
      const d = Math.hypot(px[n] - sx, py[n] - sy);
      g[n] = d;
      parent[n] = NONE;
      stamp[n] = gen;
      heap.push(n, d + Math.hypot(gx - px[n], gy - py[n]));
    }

    let best = Infinity;
    let bestNode = NONE;
    let bestResult: FunnelResult | null = null;
    let closest = NONE;
    let closestH = Infinity;
    let expansions = 0;
    let budgetAfterFirst = Infinity;
    let fallback: FunnelResult | null = null;
    let fallbackNode = NONE;
    let fallbackLen = Infinity;

    while (heap.size > 0) {
      if (heap.topKey() >= best) break;
      const n = heap.pop();
      if (closed[n] === gen) continue;
      closed[n] = gen;
      if (++expansions > maxExp || expansions > budgetAfterFirst) break;
      const t = (n / 3) | 0;
      const h = Math.hypot(gx - px[n], gy - py[n]);
      if (h < closestH && clearance(this.nav, px[n], py[n], r, this.clr).dist >= r - 1e-6) {
        closestH = h;
        closest = n;
      }
      if (t === tg && goalFree) {
        const raw = this.funnelFor(n, sx, sy, gx, gy, r);
        if (raw.length < best) {
          const res = this.repair(raw, r);
          if (this.isClear(res, r)) {
            best = res.length;
            bestNode = n;
            bestResult = res;
            // Anytime refinement: allow ~50% more expansions to find a shorter corridor.
            if (budgetAfterFirst === Infinity) budgetAfterFirst = Math.ceil(expansions * 1.5) + 64;
          } else if (res.length < fallbackLen) {
            fallbackLen = res.length;
            fallbackNode = n;
            fallback = res;
          }
        }
        continue;
      }
      // Exits: next(n) shares vertex tri[next(n)]; prev(n) shares vertex tri[n].
      for (let side = 0; side < 2; side++) {
        const x = side === 0 ? next(n) : prev(n);
        const cornerSlot = side === 0 ? next(n) % 3 : n % 3;
        if (cdt.tWidth[3 * t + cornerSlot] < twoR) continue;
        const m = this.enterable(x, twoR);
        if (m === NONE) continue;
        if (closed[m] === gen) continue;
        const ox = px[m], oy = py[m];
        this.edgePoint(m, px[n], py[n], gx, gy, r);
        const ng = g[n] + Math.hypot(px[m] - px[n], py[m] - py[n]);
        if (stamp[m] === gen && ng >= g[m]) {
          px[m] = ox;
          py[m] = oy;
          continue;
        }
        stamp[m] = gen;
        g[m] = ng;
        parent[m] = n;
        heap.push(m, ng + Math.hypot(gx - px[m], gy - py[m]));
      }
    }
    this.lastExpansions = expansions;

    if (bestResult && bestNode !== NONE) {
      return { ...bestResult, complete: true, clear: true, expansions, corridor: this.corridorTris(bestNode, ts) };
    }
    if (fallback && fallbackNode !== NONE) {
      return { ...fallback, complete: true, clear: false, expansions, corridor: this.corridorTris(fallbackNode, ts) };
    }
    if (closest === NONE) {
      // Boxed in: stay put.
      return { points: Float64Array.of(sx, sy, sx, sy), corners: new Float64Array(0), length: 0, complete: false, clear: true, expansions, corridor: Int32Array.of(ts) };
    }
    // Unreachable: go to the reachable crossing point closest to the goal.
    const res = this.repair(this.funnelFor(closest, sx, sy, px[closest], py[closest], r), r);
    return { ...res, complete: false, clear: this.isClear(res, r), expansions, corridor: this.corridorTris(closest, ts) };
  }

  private readonly clr: Clearance = { dist: 0, cx: 0, cy: 0 };

  /**
   * Sample parameters along segment a→b: dense (`step`) within `near` of either end, where
   * tangent touch points and arcs can dip below r, and every 1 unit in between (mid-run vertex
   * grazes are already handled exactly by the funnel's corner repair; edges can't get closer
   * mid-run because distance to a line is linear).
   */
  private samples(len: number, step: number, near: number, out: number[]): void {
    out.length = 0;
    if (len <= 2 * near) {
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 1; k <= n; k++) out.push(k / n);
      return;
    }
    const nNear = Math.max(1, Math.ceil(near / step));
    for (let k = 1; k <= nNear; k++) out.push((near * k) / nNear / len);
    const mid = len - 2 * near;
    const nMid = Math.max(1, Math.ceil(mid / 1.0));
    for (let k = 1; k < nMid; k++) out.push((near + (mid * k) / nMid) / len);
    for (let k = 0; k < nNear; k++) out.push((len - near + (near * k) / nNear) / len);
    out.push(1);
  }
  private readonly sampleBuf: number[] = [];

  /**
   * The circle funnel approximates clearance at portal corners only; in tight spots a run can
   * dip below r near an edge adjacent to its corner. Push every sample that is closer than r to
   * an obstacle back out to r (along walls this yields a parallel offset, around corners an arc).
   */
  private repair(res: FunnelResult, r: number): FunnelResult {
    if (r <= 0) return res;
    let pts = res.points;
    const step = Math.max(0.15, r * 0.25);
    // Chords between pushed samples around a corner sag inward by r·(1 − cos(step / 2r)).
    const pad = r * (1 - Math.cos(step / (2 * r))) + 0.004;
    const c = this.clr;
    for (let pass = 0; pass < 3; pass++) {
      const out: number[] = [pts[0], pts[1]];
      let changed = false;
      for (let i = 2; i < pts.length; i += 2) {
        const ax = pts[i - 2], ay = pts[i - 1], bx = pts[i], by = pts[i + 1];
        const last = i === pts.length - 2;
        const ts = this.sampleBuf;
        this.samples(Math.hypot(bx - ax, by - ay), step, 2 * r + 0.5, ts);
        const n = ts.length;
        for (let k = 1; k <= n; k++) {
          const isVertex = k === n;
          let x = isVertex ? bx : ax + (bx - ax) * ts[k - 1];
          let y = isVertex ? by : ay + (by - ay) * ts[k - 1];
          if (isVertex && last) {
            out.push(x, y); // the goal never moves
            break;
          }
          if (clearance(this.nav, x, y, r, c).dist >= r - 1e-3) {
            if (isVertex) out.push(x, y);
            continue;
          }
          let ok = false;
          for (let it = 0; it < 4; it++) {
            const dx = x - c.cx, dy = y - c.cy;
            const d = Math.hypot(dx, dy);
            if (d < 1e-9) break;
            x = c.cx + (dx / d) * (r + pad);
            y = c.cy + (dy / d) * (r + pad);
            if (clearance(this.nav, x, y, r, c).dist >= r - 1e-3) {
              ok = true;
              break;
            }
          }
          if (ok) {
            out.push(x, y);
            changed = true;
          } else if (isVertex) {
            out.push(bx, by);
          }
        }
      }
      pts = Float64Array.from(out);
      if (!changed) break;
    }
    if (pts === res.points) return res;
    let length = 0;
    for (let i = 2; i < pts.length; i += 2) length += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    return { points: pts, corners: res.corners, length };
  }

  /** Samples the polyline and checks clearance ≥ r against the actual mesh. */
  private isClear(res: FunnelResult, r: number): boolean {
    const pts = res.points;
    const step = Math.max(0.15, r * 0.25);
    const need = r - CLEARANCE_TOLERANCE;
    for (let i = 2; i < pts.length; i += 2) {
      const ax = pts[i - 2], ay = pts[i - 1], bx = pts[i], by = pts[i + 1];
      const ts = this.sampleBuf;
      this.samples(Math.hypot(bx - ax, by - ay), step, 2 * r + 0.5, ts);
      for (const t of ts) {
        if (clearance(this.nav, ax + (bx - ax) * t, ay + (by - ay) * t, r, this.clr).dist < need) return false;
      }
    }
    return true;
  }

  /** Halfedge of the neighbour entered through x, or NONE if x can't be crossed with clearance 2r. */
  private enterable(x: number, twoR: number): number {
    const cdt = this.nav.cdt;
    if (cdt.cRef[x] > 0) return NONE;
    const m = cdt.opp[x];
    if (m === NONE || cdt.tBlock[(m / 3) | 0] > 0) return NONE;
    const a = cdt.tri[x], b = cdt.tri[next(x)];
    if (Math.hypot(cdt.vx[b] - cdt.vx[a], cdt.vy[b] - cdt.vy[a]) < twoR) return NONE;
    return m;
  }

  /**
   * Crossing point on edge n (shrunk by r at both ends) minimizing |from − p| + |p − goal|:
   * the intersection with the from→goal line if it falls inside, else the better endpoint.
   */
  private edgePoint(n: number, fx: number, fy: number, gx: number, gy: number, r: number): void {
    const cdt = this.nav.cdt;
    const a = cdt.tri[n], b = cdt.tri[next(n)];
    let ax = cdt.vx[a], ay = cdt.vy[a], bx = cdt.vx[b], by = cdt.vy[b];
    const ex = bx - ax, ey = by - ay;
    const len = Math.hypot(ex, ey);
    const shrink = Math.min(r, len * 0.5) / len;
    ax += ex * shrink;
    ay += ey * shrink;
    bx -= ex * shrink;
    by -= ey * shrink;
    // Intersection of line (f → g) with segment (a, b).
    const dx = gx - fx, dy = gy - fy;
    const sx = bx - ax, sy = by - ay;
    const den = dx * sy - dy * sx;
    if (Math.abs(den) > 1e-12) {
      const u = ((ax - fx) * dy - (ay - fy) * dx) / den; // along segment
      const t = ((ax - fx) * sy - (ay - fy) * sx) / den; // along f→g
      if (u >= 0 && u <= 1 && t >= 0) {
        this.px[n] = ax + sx * u;
        this.py[n] = ay + sy * u;
        return;
      }
    }
    const ca = Math.hypot(ax - fx, ay - fy) + Math.hypot(gx - ax, gy - ay);
    const cb = Math.hypot(bx - fx, by - fy) + Math.hypot(gx - bx, gy - by);
    if (ca <= cb) {
      this.px[n] = ax;
      this.py[n] = ay;
    } else {
      this.px[n] = bx;
      this.py[n] = by;
    }
  }

  private nodeChain(end: number): number[] {
    const chain: number[] = [];
    for (let n = end; n !== NONE; n = this.parent[n]) chain.push(n);
    return chain.reverse();
  }

  private corridorTris(end: number, ts: number): Int32Array {
    const chain = this.nodeChain(end);
    const out = new Int32Array(chain.length + 1);
    out[0] = ts;
    chain.forEach((n, i) => (out[i + 1] = (n / 3) | 0));
    return out;
  }

  private funnelFor(end: number, sx: number, sy: number, gx: number, gy: number, r: number): FunnelResult {
    const chain = this.nodeChain(end);
    return funnel(buildCorridor(this.nav.cdt, chain), sx, sy, gx, gy, r, this.guardVertices(chain));
  }

  /**
   * Obstacle vertices that a run through the corridor could pass within r of: vertices of the
   * corridor triangles and of the triangles up to two steps away from them, as [x, y, id, ...].
   */
  private guardVertices(chain: readonly number[]): Float64Array {
    const cdt = this.nav.cdt;
    const tris = new Set<number>();
    if (chain.length > 0) tris.add((cdt.opp[chain[0]] / 3) | 0);
    for (const n of chain) tris.add((n / 3) | 0);
    return ringVertices(cdt, tris, 2);
  }

  private straight(q: PathQuery, t: number): PathResult {
    const cdt = this.nav.cdt;
    const res = this.repair(funnel(buildCorridor(cdt, []), q.sx, q.sy, q.gx, q.gy, q.r, ringVertices(cdt, new Set([t]), 2)), q.r);
    return { ...res, complete: true, clear: this.isClear(res, q.r), expansions: 0, corridor: Int32Array.of(t) };
  }
}

/** Vertices of `tris` grown by `rings` steps of edge adjacency, as [x, y, id, ...]. */
function ringVertices(cdt: DynamicCDT, tris: Set<number>, rings: number): Float64Array {
  let frontier = [...tris];
  for (let k = 0; k < rings; k++) {
    const nextFrontier: number[] = [];
    for (const t of frontier) {
      for (let j = 0; j < 3; j++) {
        const f = cdt.opp[3 * t + j];
        if (f === NONE) continue;
        const u = (f / 3) | 0;
        if (!tris.has(u)) {
          tris.add(u);
          nextFrontier.push(u);
        }
      }
    }
    frontier = nextFrontier;
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const t of tris) {
    for (let j = 0; j < 3; j++) {
      const v = cdt.tri[3 * t + j];
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(cdt.vx[v], cdt.vy[v], v);
    }
  }
  return Float64Array.from(out);
}

/**
 * Portals for a chain of entry halfedges. Entering through n = Q→P (owned by the new
 * triangle) means we crossed P→Q from the previous one: left = Q = tri[n], right = P.
 */
export function buildCorridor(cdt: DynamicCDT, chain: readonly number[]): Corridor {
  const k = chain.length;
  const c = {
    leftId: new Int32Array(k), rightId: new Int32Array(k),
    lx: new Float64Array(k), ly: new Float64Array(k), rx: new Float64Array(k), ry: new Float64Array(k),
    count: k,
  };
  for (let i = 0; i < k; i++) {
    const n = chain[i];
    const l = cdt.tri[n], r = cdt.tri[next(n)];
    c.leftId[i] = l;
    c.rightId[i] = r;
    c.lx[i] = cdt.vx[l];
    c.ly[i] = cdt.vy[l];
    c.rx[i] = cdt.vx[r];
    c.ry[i] = cdt.vy[r];
  }
  return c;
}
