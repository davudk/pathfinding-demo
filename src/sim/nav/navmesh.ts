/**
 * The navigation mesh: a dynamic CDT whose constraints are obstacle boundaries, plus derived
 * data — blocked flags (obstacle interiors), Demyen clearance widths per triangle corner, and
 * connected regions per radius class.
 *
 * Invariant: every vertex is an obstacle corner or a map-border point (no interior Steiner
 * points), which is what Demyen's width computation assumes.
 */
import { MAX_UNIT_RADIUS } from '../../shared/archetypes';
import type { Polygon } from '../../shared/geometry';
import { DynamicCDT, NONE, V_FIXED, next, prev, CdtError } from './cdt';

/** Upper radius bound of each radius class (conservative for shared queries). */
export const RADIUS_CLASSES: readonly number[] = [0.375, 0.625, 1.25, 2.0];

export function radiusClass(r: number): number {
  for (let c = 0; c < RADIUS_CLASSES.length; c++) if (r <= RADIUS_CLASSES[c] + 1e-9) return c;
  return RADIUS_CLASSES.length - 1;
}

/** Widths are clamped here: enough to answer "fits the largest unit?" and keeps updates local. */
const WIDTH_CAP = 2 * MAX_UNIT_RADIUS + 0.25;
/** Map-border Steiner spacing (keeps hull triangles well shaped). */
const BORDER_STEP = 16;

export interface NavStats {
  vertices: number;
  triangles: number;
  buildMs: number;
  lastUpdateMs: number;
  regions: number[];
}

export class NavMesh {
  readonly cdt: DynamicCDT;
  /** Region id per triangle for each radius class; -1 = blocked / not traversable. */
  regions: Int32Array[] = [];
  regionCounts: number[] = [];
  version = 0;
  readonly stats: NavStats;
  /** Visited marks for floods (fillObstacle, width-update region). */
  private stamp: Uint32Array = new Uint32Array(0);
  private stampGen = 1;
  /** Separate visited marks for the width search, which runs inside floods. */
  private searchMark: Uint32Array = new Uint32Array(0);
  private searchGen = 1;

  private constructor(cdt: DynamicCDT, buildMs: number) {
    this.cdt = cdt;
    this.stats = { vertices: 0, triangles: 0, buildMs, lastUpdateMs: 0, regions: [] };
  }

  /** Builds the mesh for a map: border points + terrain + buildings, all as constraints. */
  static build(width: number, height: number, terrain: readonly Polygon[], buildings: readonly Float64Array[]): NavMesh {
    const t0 = performance.now();
    // Points: border (fixed), terrain vertices (fixed), building corners.
    const xs: number[] = [], ys: number[] = [], fixed: number[] = [];
    const seen = new Set<number>();
    const add = (x: number, y: number, f: boolean): void => {
      const key = Math.round(x * 16) * 1_048_576 + Math.round(y * 16);
      if (seen.has(key)) return;
      seen.add(key);
      xs.push(x);
      ys.push(y);
      fixed.push(f ? 1 : 0);
    };
    for (let x = 0; x <= width; x += BORDER_STEP) {
      add(x, 0, true);
      add(x, height, true);
    }
    for (let y = 0; y <= height; y += BORDER_STEP) {
      add(0, y, true);
      add(width, y, true);
    }
    add(width, height, true);
    for (const p of terrain) for (const r of p.rings) for (let i = 0; i < r.length; i += 2) add(r[i], r[i + 1], true);
    for (const r of buildings) for (let i = 0; i < r.length; i += 2) add(r[i], r[i + 1], false);

    const cdt = DynamicCDT.fromPoints(width, height, Float64Array.from(xs), Float64Array.from(ys), Uint8Array.from(fixed));
    const nav = new NavMesh(cdt, 0);
    for (const p of terrain) {
      for (const r of p.rings) nav.constrainRing(r, 1);
    }
    for (const r of buildings) nav.constrainRing(r, 1);
    // Blocked interiors: flood each obstacle from its first edge.
    for (const p of terrain) nav.fillObstacle(p.rings[0], 1);
    for (const r of buildings) nav.fillObstacle(r, 1);
    cdt.drainTouched();
    nav.computeAllWidths();
    nav.computeRegions();
    nav.stats.buildMs = performance.now() - t0;
    nav.refreshStats();
    return nav;
  }

  // ── Obstacles ───────────────────────────────────────────────────────────────

  private constrainRing(r: Float64Array, k: number): void {
    const cdt = this.cdt;
    const n = r.length / 2;
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = cdt.vertexAt(r[2 * i], r[2 * i + 1]);
      ids.push(v === NONE ? cdt.insertVertex(r[2 * i], r[2 * i + 1]) : v);
    }
    for (let i = 0; i < n; i++) cdt.insertConstraint(ids[i], ids[(i + 1) % n], k);
  }

  /**
   * Adds or removes one coverage level on the interior of a (positively oriented) obstacle
   * ring, flooding from the triangle left of its first edge without crossing constraints.
   */
  private fillObstacle(ring: Float64Array, delta: number): void {
    const cdt = this.cdt;
    const a = cdt.vertexAt(ring[0], ring[1]);
    const b = cdt.vertexAt(ring[2], ring[3]);
    if (a === NONE || b === NONE) throw new CdtError('fillObstacle: ring vertices missing');
    // The first subsegment from a toward b.
    const s: number[] = [];
    cdt.star(a, s);
    let start = NONE;
    for (const e of s) {
      const w = cdt.tri[next(e)];
      if (cdt.cRef[e] > 0 && (w === b || (cdt.orientV(a, b, w) === 0 &&
          (cdt.vx[w] - cdt.vx[a]) * (cdt.vx[b] - cdt.vx[a]) + (cdt.vy[w] - cdt.vy[a]) * (cdt.vy[b] - cdt.vy[a]) > 0))) {
        start = (e / 3) | 0; // triangle on the left of a→b = interior of a positive ring
        break;
      }
    }
    if (start === NONE) throw new CdtError('fillObstacle: first edge not found');
    const gen = this.nextStamp();
    const stack = [start];
    this.stamp[start] = gen;
    while (stack.length) {
      const t = stack.pop()!;
      cdt.tBlock[t] += delta;
      for (let k = 0; k < 3; k++) {
        const e = 3 * t + k;
        if (cdt.cRef[e] > 0) continue;
        const f = cdt.opp[e];
        if (f === NONE) continue;
        const u = (f / 3) | 0;
        if (this.stamp[u] === gen) continue;
        this.stamp[u] = gen;
        stack.push(u);
      }
    }
  }

  /** Inserts a building footprint (validated by the caller: no overlap with other obstacles). */
  addObstacle(ring: Float64Array): void {
    const t0 = performance.now();
    this.constrainRing(ring, 1);
    this.fillObstacle(ring, 1);
    this.afterEdit(t0);
  }

  /** Removes a building footprint previously added with addObstacle(). */
  removeObstacle(ring: Float64Array): void {
    const t0 = performance.now();
    const cdt = this.cdt;
    this.fillObstacle(ring, -1);
    const n = ring.length / 2;
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(cdt.vertexAt(ring[2 * i], ring[2 * i + 1]));
    const chain = new Set<number>();
    for (let i = 0; i < n; i++) for (const v of cdt.removeConstraint(ids[i], ids[(i + 1) % n], 1)) chain.add(v);
    for (const v of chain) {
      if ((cdt.vFlags[v] & V_FIXED) === 0 && !cdt.hasConstraint(v)) cdt.removeVertex(v);
    }
    this.afterEdit(t0);
  }

  private afterEdit(t0: number): void {
    const touched = this.cdt.drainTouched();
    this.updateWidthsNear(touched);
    this.computeRegions();
    this.version++;
    this.stats.lastUpdateMs = performance.now() - t0;
    this.refreshStats();
  }

  // ── Widths (Demyen) ─────────────────────────────────────────────────────────

  private computeAllWidths(): void {
    const cdt = this.cdt;
    for (let t = 0; t < cdt.tCount; t++) if (cdt.isLiveTri(t)) this.computeTriWidths(t);
  }

  /** Recomputes widths of every live triangle within WIDTH_CAP of any touched triangle. */
  private updateWidthsNear(touched: readonly number[]): void {
    const cdt = this.cdt;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const seeds: number[] = [];
    for (const t of touched) {
      if (!cdt.isLiveTri(t)) continue;
      seeds.push(t);
      for (let k = 0; k < 3; k++) {
        const v = cdt.tri[3 * t + k];
        minX = Math.min(minX, cdt.vx[v]);
        maxX = Math.max(maxX, cdt.vx[v]);
        minY = Math.min(minY, cdt.vy[v]);
        maxY = Math.max(maxY, cdt.vy[v]);
      }
    }
    if (!seeds.length) return;
    const m = WIDTH_CAP + 0.5;
    minX -= m; minY -= m; maxX += m; maxY += m;
    // Flood over all edges from the touched set, keeping triangles overlapping the box.
    const gen = this.nextStamp();
    const stack = seeds.slice();
    for (const t of seeds) this.stamp[t] = gen;
    while (stack.length) {
      const t = stack.pop()!;
      this.computeTriWidths(t);
      for (let k = 0; k < 3; k++) {
        const f = cdt.opp[3 * t + k];
        if (f === NONE) continue;
        const u = (f / 3) | 0;
        if (this.stamp[u] === gen) continue;
        this.stamp[u] = gen;
        let ux0 = Infinity, uy0 = Infinity, ux1 = -Infinity, uy1 = -Infinity;
        for (let j = 0; j < 3; j++) {
          const v = cdt.tri[3 * u + j];
          ux0 = Math.min(ux0, cdt.vx[v]);
          ux1 = Math.max(ux1, cdt.vx[v]);
          uy0 = Math.min(uy0, cdt.vy[v]);
          uy1 = Math.max(uy1, cdt.vy[v]);
        }
        if (ux1 < minX || ux0 > maxX || uy1 < minY || uy0 > maxY) continue;
        stack.push(u);
      }
    }
  }

  private computeTriWidths(t: number): void {
    for (let i = 0; i < 3; i++) this.cdt.tWidth[3 * t + i] = this.width(t, i);
  }

  /**
   * Demyen width of triangle t around its corner at slot i: the widest circle that can pass
   * through t between the two edges meeting at that corner (clamped to WIDTH_CAP).
   */
  private width(t: number, i: number): number {
    const cdt = this.cdt;
    const C = cdt.tri[3 * t + i];
    const ec = 3 * t + ((i + 1) % 3); // edge A→B opposite C
    const A = cdt.tri[ec], B = cdt.tri[next(ec)];
    const cx = cdt.vx[C], cy = cdt.vy[C];
    const ax = cdt.vx[A], ay = cdt.vy[A], bx = cdt.vx[B], by = cdt.vy[B];
    let d = Math.min(Math.hypot(ax - cx, ay - cy), Math.hypot(bx - cx, by - cy), WIDTH_CAP);
    // Obtuse (or right) angle at A or B: the near endpoint is the bottleneck.
    if ((cx - ax) * (bx - ax) + (cy - ay) * (by - ay) <= 0) return d;
    if ((cx - bx) * (ax - bx) + (cy - by) * (ay - by) <= 0) return d;
    if (cdt.cRef[ec] > 0 || cdt.opp[ec] === NONE) return Math.min(d, distPointSeg(cx, cy, ax, ay, bx, by));
    if (this.searchMark.length < cdt.tCount) this.searchMark = new Uint32Array(cdt.tFlags.length);
    const gen = ++this.searchGen;
    this.searchMark[t] = gen;
    return this.searchWidth(cx, cy, ec, d, gen);
  }

  /** Looks across edge e for obstacle edges closer to (cx, cy) than d. */
  private searchWidth(cx: number, cy: number, e: number, d: number, gen: number): number {
    const cdt = this.cdt;
    const f = cdt.opp[e];
    const u = (f / 3) | 0;
    if (this.searchMark[u] === gen) return d;
    this.searchMark[u] = gen;
    for (let side = 0; side < 2; side++) {
      const g = side === 0 ? next(f) : prev(f);
      const p = cdt.tri[g], q = cdt.tri[next(g)];
      const dg = distPointSeg(cx, cy, cdt.vx[p], cdt.vy[p], cdt.vx[q], cdt.vy[q]);
      if (dg >= d) continue;
      if (cdt.cRef[g] > 0 || cdt.opp[g] === NONE) d = dg;
      else d = this.searchWidth(cx, cy, g, d, gen);
    }
    return d;
  }

  // ── Regions ─────────────────────────────────────────────────────────────────

  /** Whether a unit of radius r can step from the triangle owning halfedge e to its neighbour. */
  canCross(e: number, r: number): boolean {
    const cdt = this.cdt;
    const f = cdt.opp[e];
    if (f === NONE || cdt.cRef[e] > 0) return false;
    if (cdt.tBlock[(f / 3) | 0] > 0) return false;
    const p = cdt.tri[e], q = cdt.tri[next(e)];
    return Math.hypot(cdt.vx[q] - cdt.vx[p], cdt.vy[q] - cdt.vy[p]) >= 2 * r;
  }

  private edgeLen: Float32Array = new Float32Array(0);
  private regionStack: Int32Array = new Int32Array(0);

  /** Flood-fills connected regions per radius class (over-approximation; A* checks exactly). */
  computeRegions(): void {
    const cdt = this.cdt;
    const n = cdt.tCount;
    const { tri, opp, cRef, tBlock, vx, vy } = cdt;
    // Edge "doors": length of each crossable halfedge (0 = never crossable), shared by all classes.
    if (this.edgeLen.length < n * 3) this.edgeLen = new Float32Array(cdt.tFlags.length * 3);
    if (this.regionStack.length < n) this.regionStack = new Int32Array(cdt.tFlags.length);
    const len = this.edgeLen;
    for (let t = 0; t < n; t++) {
      const live = cdt.isLiveTri(t);
      for (let k = 0; k < 3; k++) {
        const e = 3 * t + k;
        const f = opp[e];
        if (!live || f === NONE || cRef[e] > 0 || tBlock[(f / 3) | 0] > 0) {
          len[e] = 0;
          continue;
        }
        const p = tri[e], q = tri[next(e)];
        len[e] = Math.hypot(vx[q] - vx[p], vy[q] - vy[p]);
      }
    }
    const stack = this.regionStack;
    this.regionCounts = [];
    const prevRegions = this.regions;
    this.regions = RADIUS_CLASSES.map((r, c) => {
      const reuse = prevRegions[c];
      const reg = reuse && reuse.length >= n ? reuse : new Int32Array(cdt.tFlags.length);
      reg.fill(-1);
      const need = 2 * r;
      let nextId = 0;
      for (let t0 = 0; t0 < n; t0++) {
        if (reg[t0] >= 0 || tBlock[t0] > 0 || !cdt.isLiveTri(t0)) continue;
        const id = nextId++;
        reg[t0] = id;
        let sp = 0;
        stack[sp++] = t0;
        while (sp > 0) {
          const t = stack[--sp];
          const e0 = 3 * t;
          for (let k = 0; k < 3; k++) {
            const e = e0 + k;
            if (len[e] < need || len[e] === 0) continue;
            const u = (opp[e] / 3) | 0;
            if (reg[u] >= 0) continue;
            reg[u] = id;
            stack[sp++] = u;
          }
        }
      }
      this.regionCounts.push(nextId);
      return reg;
    });
  }

  // ── Misc ────────────────────────────────────────────────────────────────────

  private nextStamp(): number {
    if (this.stamp.length < this.cdt.tCount) this.stamp = new Uint32Array(this.cdt.tFlags.length);
    return ++this.stampGen;
  }

  private refreshStats(): void {
    this.stats.vertices = this.cdt.liveVertices();
    this.stats.triangles = this.cdt.liveTriangles();
    this.stats.regions = this.regionCounts.slice();
  }

  /**
   * Debug export: every live edge once (x0, y0, x1, y1, kind) where kind 0 = free, 1 = inside
   * obstacles, 2 = constrained; plus triangles (6 floats each) with their region per class.
   */
  exportDebug(cls: number): { edges: Float32Array; tris: Float32Array; region: Int32Array } {
    const cdt = this.cdt;
    const edges: number[] = [];
    const tris: number[] = [];
    const region: number[] = [];
    const reg = this.regions[cls];
    for (let t = 0; t < cdt.tCount; t++) {
      if (!cdt.isLiveTri(t)) continue;
      for (let k = 0; k < 3; k++) {
        const e = 3 * t + k;
        const f = cdt.opp[e];
        if (f !== NONE && f < e) continue;
        const p = cdt.tri[e], q = cdt.tri[next(e)];
        const blocked = cdt.tBlock[t] > 0 && (f === NONE || cdt.tBlock[(f / 3) | 0] > 0);
        edges.push(cdt.vx[p], cdt.vy[p], cdt.vx[q], cdt.vy[q], cdt.cRef[e] > 0 || f === NONE ? 2 : blocked ? 1 : 0);
      }
      const a = cdt.tri[3 * t], b = cdt.tri[3 * t + 1], c = cdt.tri[3 * t + 2];
      tris.push(cdt.vx[a], cdt.vy[a], cdt.vx[b], cdt.vy[b], cdt.vx[c], cdt.vy[c]);
      region.push(reg[t]);
    }
    return { edges: Float32Array.from(edges), tris: Float32Array.from(tris), region: Int32Array.from(region) };
  }
}

function distPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
