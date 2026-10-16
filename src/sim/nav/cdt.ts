/**
 * Dynamic constrained Delaunay triangulation on typed arrays (halfedge layout compatible
 * with Delaunator: halfedge e belongs to triangle ⌊e/3⌋ and runs tri[e] → tri[next(e)]).
 *
 * Supports vertex insertion, constraint insertion (Sloan flips), constraint removal with
 * reference counts, and vertex removal (flip to degree 3, merge), all followed by Lawson
 * legalization. All topology decisions use exact predicates on lattice coordinates.
 *
 * Conventions: every live triangle has POSITIVE orientation (shoelace sign, see
 * shared/geometry.ts). The hull is the map rectangle; hull halfedges have opp = -1.
 */
import { incircle, orient2d } from 'robust-predicates';
import Delaunator from 'delaunator';
import { LATTICE } from '../../shared/geometry';

export const NONE = -1;

export const V_FIXED = 1;
export const V_DEAD = 2;
export const T_DEAD = 1;

export const next = (e: number): number => (e % 3 === 2 ? e - 2 : e + 1);
export const prev = (e: number): number => (e % 3 === 0 ? e + 2 : e - 1);

/** Thrown when an operation would violate the no-crossing-constraints contract. */
export class CdtError extends Error {}

const HINT_CELL = 8;

export class DynamicCDT {
  // Vertices.
  vx: Float64Array;
  vy: Float64Array;
  vFlags: Uint8Array;
  /** One outgoing halfedge per vertex. */
  vEdge: Int32Array;
  vCount = 0;
  private readonly vFree: number[] = [];
  private readonly vKey = new Map<number, number>();

  // Triangles / halfedges.
  tri: Int32Array;
  opp: Int32Array;
  /** Constraint reference count per halfedge (kept equal on twins); > 0 = constrained. */
  cRef: Uint16Array;
  tFlags: Uint8Array;
  /** Number of obstacles covering the triangle; > 0 = blocked. */
  tBlock: Uint8Array;
  /** Demyen widths per vertex slot (maintained by NavMesh). */
  tWidth: Float32Array;
  tCount = 0;
  private readonly tFree: number[] = [];

  /** Triangles rewritten since the last drainTouched() (deduplicated). */
  private touchedList: number[] = [];
  private touchedMark: Uint32Array;
  private touchedGen = 1;

  private readonly hint: Int32Array;
  private readonly hintW: number;
  private readonly hintH: number;
  private walkRot = 0;
  private lastTri = 0;

  /** Set by locate(): halfedge the point lies on, or NONE. */
  locEdge = NONE;

  constructor(readonly width: number, readonly height: number, vCap = 1024, tCap = 2048) {
    this.vx = new Float64Array(vCap);
    this.vy = new Float64Array(vCap);
    this.vFlags = new Uint8Array(vCap);
    this.vEdge = new Int32Array(vCap).fill(NONE);
    this.tri = new Int32Array(tCap * 3);
    this.opp = new Int32Array(tCap * 3).fill(NONE);
    this.cRef = new Uint16Array(tCap * 3);
    this.tFlags = new Uint8Array(tCap);
    this.tBlock = new Uint8Array(tCap);
    this.tWidth = new Float32Array(tCap * 3);
    this.touchedMark = new Uint32Array(tCap);
    this.hintW = Math.ceil(width / HINT_CELL);
    this.hintH = Math.ceil(height / HINT_CELL);
    this.hint = new Int32Array(this.hintW * this.hintH).fill(NONE);
  }

  // ── Construction ────────────────────────────────────────────────────────────

  /**
   * Builds the Delaunay triangulation of a point set whose convex hull is the map rectangle
   * (the four corners must be included). `fixed[i]` marks static vertices.
   */
  static fromPoints(width: number, height: number, xs: Float64Array, ys: Float64Array, fixed: Uint8Array): DynamicCDT {
    const n = xs.length;
    const coords = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      coords[2 * i] = xs[i];
      coords[2 * i + 1] = ys[i];
    }
    const d = new Delaunator(coords);
    const nt = d.triangles.length / 3;
    const cdt = new DynamicCDT(width, height, Math.max(1024, n * 2), Math.max(2048, nt * 2));
    for (let i = 0; i < n; i++) {
      const v = cdt.allocVertex(xs[i], ys[i]);
      if (fixed[i]) cdt.vFlags[v] |= V_FIXED;
    }
    // Delaunator's triangles are negatively oriented in our convention; reverse each one.
    for (let t = 0; t < nt; t++) {
      const p0 = d.triangles[3 * t], p1 = d.triangles[3 * t + 1], p2 = d.triangles[3 * t + 2];
      cdt.allocTri();
      cdt.setTri(t, p1, p0, p2);
    }
    // Reversed triangle (p1, p0, p2): slot0 = p1→p0 (rev of orig 0), slot1 = p0→p2 (rev of orig 2),
    // slot2 = p2→p1 (rev of orig 1). So orig k → slot [0, 2, 1][k].
    const slot = [0, 2, 1];
    for (let e = 0; e < nt * 3; e++) {
      const h = d.halfedges[e];
      const me = 3 * Math.floor(e / 3) + slot[e % 3];
      cdt.opp[me] = h < 0 ? NONE : 3 * Math.floor(h / 3) + slot[h % 3];
    }
    for (let t = 0; t < nt; t++) {
      if (cdt.orientV(cdt.tri[3 * t], cdt.tri[3 * t + 1], cdt.tri[3 * t + 2]) <= 0) {
        throw new CdtError(`bootstrap triangle ${t} not positively oriented`);
      }
    }
    return cdt;
  }

  // ── Predicates (positive = our orientation / inside) ─────────────────────────

  orientV(a: number, b: number, c: number): number {
    return -orient2d(this.vx[a], this.vy[a], this.vx[b], this.vy[b], this.vx[c], this.vy[c]);
  }

  orientP(a: number, b: number, px: number, py: number): number {
    return -orient2d(this.vx[a], this.vy[a], this.vx[b], this.vy[b], px, py);
  }

  /** > 0 when d is strictly inside the circumcircle of positive triangle (a, b, c). */
  inCircle(a: number, b: number, c: number, d: number): number {
    const { vx, vy } = this;
    return incircle(vx[a], vy[a], vx[b], vy[b], vx[c], vy[c], vx[d], vy[d]);
  }

  // ── Storage ─────────────────────────────────────────────────────────────────

  private allocVertex(x: number, y: number): number {
    let v = this.vFree.pop();
    if (v === undefined) {
      if (this.vCount === this.vx.length) this.growVertices();
      v = this.vCount++;
    }
    this.vx[v] = x;
    this.vy[v] = y;
    this.vFlags[v] = 0;
    this.vEdge[v] = NONE;
    this.vKey.set(latticeKey(x, y), v);
    return v;
  }

  private freeVertex(v: number): void {
    this.vKey.delete(latticeKey(this.vx[v], this.vy[v]));
    this.vFlags[v] = V_DEAD;
    this.vEdge[v] = NONE;
    this.vFree.push(v);
  }

  private allocTri(): number {
    let t = this.tFree.pop();
    if (t === undefined) {
      if (this.tCount * 3 === this.tri.length) this.growTriangles();
      t = this.tCount++;
    }
    this.tFlags[t] = 0;
    this.tBlock[t] = 0;
    return t;
  }

  private freeTri(t: number): void {
    this.tFlags[t] = T_DEAD;
    for (let k = 0; k < 3; k++) {
      this.opp[3 * t + k] = NONE;
      this.cRef[3 * t + k] = 0;
      this.tri[3 * t + k] = NONE;
    }
    this.tFree.push(t);
  }

  private growVertices(): void {
    const cap = this.vx.length * 2;
    this.vx = grow(this.vx, cap);
    this.vy = grow(this.vy, cap);
    this.vFlags = grow(this.vFlags, cap);
    const e = new Int32Array(cap).fill(NONE);
    e.set(this.vEdge);
    this.vEdge = e;
  }

  private growTriangles(): void {
    const cap = this.tFlags.length * 2;
    this.tri = grow(this.tri, cap * 3);
    const o = new Int32Array(cap * 3).fill(NONE);
    o.set(this.opp);
    this.opp = o;
    this.cRef = grow(this.cRef, cap * 3);
    this.tFlags = grow(this.tFlags, cap);
    this.tBlock = grow(this.tBlock, cap);
    this.tWidth = grow(this.tWidth, cap * 3);
    this.touchedMark = grow(this.touchedMark, cap);
  }

  private setTri(t: number, a: number, b: number, c: number): void {
    const e = 3 * t;
    this.tri[e] = a;
    this.tri[e + 1] = b;
    this.tri[e + 2] = c;
    this.vEdge[a] = e;
    this.vEdge[b] = e + 1;
    this.vEdge[c] = e + 2;
    if (this.touchedMark[t] !== this.touchedGen) {
      this.touchedMark[t] = this.touchedGen;
      this.touchedList.push(t);
    }
  }

  private link(e: number, f: number): void {
    this.opp[e] = f;
    if (f !== NONE) this.opp[f] = e;
  }

  /** Returns and clears the list of triangles rewritten since the last call. */
  drainTouched(): number[] {
    const list = this.touchedList;
    this.touchedList = [];
    this.touchedGen++;
    return list;
  }

  isLiveTri(t: number): boolean {
    return t >= 0 && t < this.tCount && (this.tFlags[t] & T_DEAD) === 0;
  }

  // ── Navigation helpers ──────────────────────────────────────────────────────

  /** Collects outgoing halfedges of v into `out` (rotation order); returns true if v is on the hull. */
  star(v: number, out: number[]): boolean {
    out.length = 0;
    const e0 = this.vEdge[v];
    let e = e0;
    let boundary = false;
    for (;;) {
      out.push(e);
      const o = this.opp[prev(e)];
      if (o === NONE) {
        boundary = true;
        break;
      }
      e = o;
      if (e === e0) return false;
    }
    // Hit the hull: walk the other way from e0.
    let o = this.opp[e0];
    while (o !== NONE) {
      const f = next(o);
      out.unshift(f);
      o = this.opp[f];
    }
    return boundary;
  }

  private readonly starBuf: number[] = [];

  /** Halfedge a → b, or NONE. */
  findEdge(a: number, b: number): number {
    const s = this.starBuf;
    this.star(a, s);
    for (const e of s) if (this.tri[next(e)] === b) return e;
    return NONE;
  }

  vertexAt(x: number, y: number): number {
    return this.vKey.get(latticeKey(x, y)) ?? NONE;
  }

  /**
   * Triangle containing (px, py), walking from a hint. Sets `locEdge` when the point lies
   * exactly on an edge. Returns NONE outside the hull.
   */
  locate(px: number, py: number, hintTri = NONE): number {
    let t = hintTri;
    if (!this.isLiveTri(t)) {
      const hx = Math.min(this.hintW - 1, Math.max(0, Math.floor(px / HINT_CELL)));
      const hy = Math.min(this.hintH - 1, Math.max(0, Math.floor(py / HINT_CELL)));
      t = this.hint[hy * this.hintW + hx];
      if (!this.isLiveTri(t)) t = this.isLiveTri(this.lastTri) ? this.lastTri : this.anyLiveTri();
    }
    this.locEdge = NONE;
    const maxSteps = this.tCount * 3 + 64;
    for (let step = 0; step < maxSteps; step++) {
      this.walkRot = (this.walkRot + 1) % 3;
      let moved = false;
      let zero = NONE;
      for (let k = 0; k < 3; k++) {
        const e = 3 * t + ((this.walkRot + k) % 3);
        const o = this.orientP(this.tri[e], this.tri[next(e)], px, py);
        if (o < 0) {
          const f = this.opp[e];
          if (f === NONE) return NONE;
          t = (f / 3) | 0;
          moved = true;
          break;
        }
        if (o === 0) zero = e;
      }
      if (!moved) {
        this.locEdge = zero;
        this.lastTri = t;
        const hx = Math.floor(px / HINT_CELL), hy = Math.floor(py / HINT_CELL);
        if (hx >= 0 && hy >= 0 && hx < this.hintW && hy < this.hintH) this.hint[hy * this.hintW + hx] = t;
        return t;
      }
    }
    throw new CdtError('locate: walk did not terminate');
  }

  private anyLiveTri(): number {
    for (let t = 0; t < this.tCount; t++) if (this.isLiveTri(t)) return t;
    throw new CdtError('no live triangles');
  }

  // ── Flips and legalization ───────────────────────────────────────────────────

  /** Whether the quad around interior halfedge e is strictly convex (so e can be flipped). */
  isFlippable(e: number): boolean {
    const f = this.opp[e];
    if (f === NONE) return false;
    const a = this.tri[e], b = this.tri[next(e)], c = this.tri[prev(e)], d = this.tri[prev(f)];
    return this.orientV(c, a, d) > 0 && this.orientV(d, b, c) > 0;
  }

  /**
   * Flips interior halfedge e (a→b, triangles (a,b,c) and (b,a,d)) to the diagonal c–d.
   * Returns the new diagonal halfedge d→c.
   */
  flip(e: number): number {
    const f = this.opp[e];
    const t0 = (e / 3) | 0, t1 = (f / 3) | 0;
    const e1 = next(e), e2 = prev(e), f1 = next(f), f2 = prev(f);
    const a = this.tri[e], b = this.tri[e1], c = this.tri[e2], d = this.tri[f2];
    const oE1 = this.opp[e1], oE2 = this.opp[e2], oF1 = this.opp[f1], oF2 = this.opp[f2];
    const cE1 = this.cRef[e1], cE2 = this.cRef[e2], cF1 = this.cRef[f1], cF2 = this.cRef[f2];
    this.setTri(t0, c, a, d);
    this.setTri(t1, d, b, c);
    const b0 = 3 * t0, b1 = 3 * t1;
    this.link(b0, oE2);
    this.link(b0 + 1, oF1);
    this.link(b1, oF2);
    this.link(b1 + 1, oE1);
    this.link(b0 + 2, b1 + 2);
    this.cRef[b0] = cE2;
    this.cRef[b0 + 1] = cF1;
    this.cRef[b1] = cF2;
    this.cRef[b1 + 1] = cE1;
    this.cRef[b0 + 2] = 0;
    this.cRef[b1 + 2] = 0;
    return b0 + 2;
  }

  private isIllegal(e: number): boolean {
    const f = this.opp[e];
    if (f === NONE || this.cRef[e] > 0) return false;
    return this.inCircle(this.tri[e], this.tri[next(e)], this.tri[prev(e)], this.tri[prev(f)]) > 0;
  }

  /** Lawson flips over a stack of edges given as flat vertex pairs [u0, v0, u1, v1, ...]. */
  legalize(stack: number[]): void {
    let guard = 0;
    while (stack.length > 0) {
      const v = stack.pop()!;
      const u = stack.pop()!;
      const e = this.findEdge(u, v);
      if (e === NONE || !this.isIllegal(e)) continue;
      if (++guard > 1_000_000) throw new CdtError('legalize: too many flips');
      const f = this.opp[e];
      const a = this.tri[e], b = this.tri[next(e)], c = this.tri[prev(e)], d = this.tri[prev(f)];
      this.flip(e);
      stack.push(c, a, a, d, d, b, b, c);
    }
  }

  // ── Vertex insertion ────────────────────────────────────────────────────────

  /** Inserts (or finds) the vertex at (x, y), which must be inside the hull. */
  insertVertex(x: number, y: number, fixed = false): number {
    const existing = this.vertexAt(x, y);
    if (existing !== NONE) {
      if (fixed) this.vFlags[existing] |= V_FIXED;
      return existing;
    }
    const t = this.locate(x, y);
    if (t === NONE) throw new CdtError(`insertVertex: (${x}, ${y}) outside the hull`);
    const onEdge = this.locEdge;
    const p = this.allocVertex(x, y);
    if (fixed) this.vFlags[p] |= V_FIXED;
    const stack: number[] = [];
    if (onEdge !== NONE) this.splitEdge(onEdge, p, stack);
    else this.splitTri(t, p, stack);
    this.legalize(stack);
    return p;
  }

  private splitTri(t: number, p: number, stack: number[]): void {
    const e = 3 * t;
    const a = this.tri[e], b = this.tri[e + 1], c = this.tri[e + 2];
    const oAB = this.opp[e], oBC = this.opp[e + 1], oCA = this.opp[e + 2];
    const cAB = this.cRef[e], cBC = this.cRef[e + 1], cCA = this.cRef[e + 2];
    const blk = this.tBlock[t];
    const t1 = this.allocTri(), t2 = this.allocTri();
    this.tBlock[t1] = blk;
    this.tBlock[t2] = blk;
    this.setTri(t, a, b, p);
    this.setTri(t1, b, c, p);
    this.setTri(t2, c, a, p);
    const b0 = 3 * t, b1 = 3 * t1, b2 = 3 * t2;
    this.link(b0, oAB);
    this.link(b1, oBC);
    this.link(b2, oCA);
    this.link(b0 + 1, b1 + 2);
    this.link(b1 + 1, b2 + 2);
    this.link(b2 + 1, b0 + 2);
    this.cRef[b0] = cAB;
    this.cRef[b1] = cBC;
    this.cRef[b2] = cCA;
    this.cRef[b0 + 1] = this.cRef[b0 + 2] = 0;
    this.cRef[b1 + 1] = this.cRef[b1 + 2] = 0;
    this.cRef[b2 + 1] = this.cRef[b2 + 2] = 0;
    stack.push(a, b, b, c, c, a);
  }

  private splitEdge(e: number, p: number, stack: number[]): void {
    const f = this.opp[e];
    const t0 = (e / 3) | 0;
    const a = this.tri[e], b = this.tri[next(e)], c = this.tri[prev(e)];
    const oBC = this.opp[next(e)], oCA = this.opp[prev(e)];
    const cBC = this.cRef[next(e)], cCA = this.cRef[prev(e)];
    const cE = this.cRef[e];
    const blk0 = this.tBlock[t0];

    const n0 = this.allocTri();
    this.tBlock[n0] = blk0;
    this.setTri(t0, c, a, p);
    this.setTri(n0, b, c, p);
    const b0 = 3 * t0, m0 = 3 * n0;
    this.link(b0, oCA);
    this.link(m0, oBC);
    this.link(m0 + 1, b0 + 2);
    this.cRef[b0] = cCA;
    this.cRef[m0] = cBC;
    this.cRef[b0 + 1] = cE;
    this.cRef[m0 + 2] = cE;
    this.cRef[b0 + 2] = this.cRef[m0 + 1] = 0;
    stack.push(c, a, b, c);

    if (f === NONE) {
      this.opp[b0 + 1] = NONE;
      this.opp[m0 + 2] = NONE;
      return;
    }
    const t1 = (f / 3) | 0;
    const d = this.tri[prev(f)];
    const oAD = this.opp[next(f)], oDB = this.opp[prev(f)];
    const cAD = this.cRef[next(f)], cDB = this.cRef[prev(f)];
    const blk1 = this.tBlock[t1];
    const n1 = this.allocTri();
    this.tBlock[n1] = blk1;
    this.setTri(t1, d, b, p);
    this.setTri(n1, a, d, p);
    const b1 = 3 * t1, m1 = 3 * n1;
    this.link(b1, oDB);
    this.link(m1, oAD);
    this.link(m1 + 1, b1 + 2);
    this.link(b0 + 1, m1 + 2); // a→p ↔ p→a
    this.link(b1 + 1, m0 + 2); // b→p ↔ p→b
    this.cRef[b1] = cDB;
    this.cRef[m1] = cAD;
    this.cRef[b1 + 1] = cE;
    this.cRef[m1 + 2] = cE;
    this.cRef[b1 + 2] = this.cRef[m1 + 1] = 0;
    stack.push(d, b, a, d);
  }

  // ── Constraints ─────────────────────────────────────────────────────────────

  /**
   * Adds `k` references to the constraint a–b. Existing collinear vertices on the segment
   * split it into subsegments. Throws CdtError if the segment would cross a constrained edge.
   */
  insertConstraint(a: number, b: number, k = 1): void {
    for (let guard = 0; a !== b; guard++) {
      if (guard > 100_000) throw new CdtError('insertConstraint: no progress');
      const existing = this.findEdge(a, b);
      if (existing !== NONE) {
        this.addRef(existing, k);
        return;
      }
      const stop = this.collectCrossings(a, b);
      const end = stop.end;
      if (stop.crossed.length === 0) {
        // `end` is a neighbour of a lying on the segment.
        this.addRef(this.findEdge(a, end), k);
      } else {
        this.recoverEdge(a, end, stop.crossed, k);
      }
      a = end;
    }
  }

  private addRef(e: number, k: number): void {
    if (e === NONE) throw new CdtError('addRef: missing edge');
    this.cRef[e] += k;
    const f = this.opp[e];
    if (f !== NONE) this.cRef[f] += k;
  }

  /**
   * Walks from a toward b collecting crossed edges (as vertex pairs) until reaching b or a
   * vertex exactly on the segment. Returns that end vertex and the crossed edges.
   */
  private collectCrossings(a: number, b: number): { end: number; crossed: number[] } {
    const s = this.starBuf;
    this.star(a, s);
    const bx = this.vx[b], by = this.vy[b];
    const ax = this.vx[a], ay = this.vy[a];
    const ahead = (w: number): boolean => (this.vx[w] - ax) * (bx - ax) + (this.vy[w] - ay) * (by - ay) > 0;
    // A neighbour exactly on the segment ends this piece.
    for (const e of s) {
      const w = this.tri[next(e)];
      if (this.orientV(a, b, w) === 0 && ahead(w)) return { end: w, crossed: [] };
    }
    // Find the triangle around a whose wedge contains the direction a→b.
    let cur = NONE;
    for (const e of s) {
      const w = this.tri[next(e)], x = this.tri[prev(e)];
      if (this.orientV(a, w, b) > 0 && this.orientV(a, b, x) > 0) {
        cur = next(e); // w→x, crossed by the segment
        break;
      }
    }
    if (cur === NONE) throw new CdtError('insertConstraint: start wedge not found');
    const crossed: number[] = [];
    for (let guard = 0; ; guard++) {
      if (guard > 1_000_000) throw new CdtError('insertConstraint: walk did not terminate');
      if (this.cRef[cur] > 0) {
        throw new CdtError(`constraint (${ax},${ay})→(${bx},${by}) crosses an existing constraint`);
      }
      const w = this.tri[cur], x = this.tri[next(cur)]; // w on the right (orient < 0), x on the left
      crossed.push(w, x);
      const f = this.opp[cur];
      if (f === NONE) throw new CdtError('insertConstraint: walked off the hull');
      const y = this.tri[prev(f)];
      if (y === b) return { end: b, crossed };
      const oy = this.orientV(a, b, y);
      if (oy === 0) return { end: y, crossed };
      // Triangle (x, w, y) with f = x→w: exit through w→y if y is left of the segment, else y→x.
      cur = oy > 0 ? next(f) : prev(f);
    }
  }

  /** Sloan's flipping: makes a–b an edge given the edges it crosses, then adds k references. */
  private recoverEdge(a: number, b: number, crossed: number[], k: number): void {
    const queue = crossed.slice();
    const created: number[] = [];
    let head = 0;
    let guard = 0;
    while (head < queue.length) {
      if (++guard > 1_000_000) throw new CdtError('recoverEdge: did not terminate');
      const u = queue[head++], v = queue[head++];
      const e = this.findEdge(u, v);
      if (e === NONE) throw new CdtError('recoverEdge: crossed edge vanished');
      if (!this.isFlippable(e)) {
        queue.push(u, v);
        continue;
      }
      const c = this.tri[prev(e)], d = this.tri[prev(this.opp[e])];
      this.flip(e);
      if (this.crossesProperly(a, b, c, d)) queue.push(c, d);
      else created.push(c, d);
      if (head > 4096 && head * 2 > queue.length) {
        queue.splice(0, head);
        head = 0;
      }
    }
    // Restore Delaunay-ness of the new edges (the constraint itself is skipped: it gets cRef next).
    const stack: number[] = [];
    for (let i = 0; i < created.length; i += 2) {
      const c = created[i], d = created[i + 1];
      if ((c === a && d === b) || (c === b && d === a)) continue;
      stack.push(c, d);
    }
    // Mark the constraint first so legalization never flips it.
    const ab = this.findEdge(a, b);
    if (ab === NONE) throw new CdtError('recoverEdge: edge not recovered');
    this.addRef(ab, k);
    this.legalize(stack);
  }

  private crossesProperly(a: number, b: number, c: number, d: number): boolean {
    const o1 = Math.sign(this.orientV(a, b, c)), o2 = Math.sign(this.orientV(a, b, d));
    const o3 = Math.sign(this.orientV(c, d, a)), o4 = Math.sign(this.orientV(c, d, b));
    return o1 * o2 < 0 && o3 * o4 < 0;
  }

  /**
   * Removes `k` references from the constraint a–b (following its collinear subsegments).
   * Returns the chain of vertices along the segment (a … b).
   */
  removeConstraint(a: number, b: number, k = 1): number[] {
    const chain = [a];
    const zeroed: number[] = [];
    const ax = this.vx[a], ay = this.vy[a], bx = this.vx[b], by = this.vy[b];
    let cur = a;
    const s: number[] = [];
    for (let guard = 0; cur !== b; guard++) {
      if (guard > 100_000) throw new CdtError('removeConstraint: no progress');
      this.star(cur, s);
      let step = NONE;
      for (const e of s) {
        const w = this.tri[next(e)];
        if (this.cRef[e] === 0 || this.orientV(a, b, w) !== 0) continue;
        if ((this.vx[w] - this.vx[cur]) * (bx - ax) + (this.vy[w] - this.vy[cur]) * (by - ay) > 0) {
          step = e;
          break;
        }
      }
      if (step === NONE) throw new CdtError('removeConstraint: constraint not found');
      const w = this.tri[next(step)];
      if (this.cRef[step] < k) throw new CdtError('removeConstraint: reference count underflow');
      this.addRef(step, -k);
      if (this.cRef[step] === 0) zeroed.push(cur, w);
      chain.push(w);
      cur = w;
    }
    this.legalize(zeroed);
    return chain;
  }

  /** True when v has an incident constrained edge. */
  hasConstraint(v: number): boolean {
    const s = this.starBuf;
    this.star(v, s);
    for (const e of s) if (this.cRef[e] > 0 || this.cRef[prev(e)] > 0) return true;
    return false;
  }

  /**
   * Removes an interior, unconstrained, non-fixed vertex: deletes its star, re-triangulates
   * the star polygon by ear clipping (robust to collinear neighbours), then re-legalizes.
   */
  removeVertex(v: number): void {
    if (this.vFlags[v] & (V_FIXED | V_DEAD)) throw new CdtError('removeVertex: vertex is fixed or dead');
    const s: number[] = [];
    if (this.star(v, s)) throw new CdtError('removeVertex: hull vertex');
    const k = s.length;
    // Hole boundary in positive order: ring[i] → ring[i+1] is halfedge next(s[i]).
    const ring: number[] = [];
    const outerOpp: number[] = [];
    const outerRef: number[] = [];
    const tris: number[] = [];
    for (const e of s) {
      if (this.cRef[e] > 0) throw new CdtError('removeVertex: vertex still constrained');
      const be = next(e);
      ring.push(this.tri[be]);
      outerOpp.push(this.opp[be]);
      outerRef.push(this.cRef[be]);
      tris.push((e / 3) | 0);
    }
    const blk = this.tBlock[tris[0]];
    const boundary = new Map<number, number>(); // directed boundary edge key → index i
    for (let i = 0; i < k; i++) boundary.set(edgeKey(ring[i], ring[(i + 1) % k]), i);
    for (const t of tris) this.freeTri(t);
    this.freeVertex(v);

    // Ear clipping.
    const poly = ring.slice();
    const out: number[] = [];
    let guard = 0;
    while (poly.length > 3) {
      if (++guard > 10_000) throw new CdtError('removeVertex: ear clipping stuck');
      let clipped = false;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[(i + poly.length - 1) % poly.length], b = poly[i], c = poly[(i + 1) % poly.length];
        if (this.orientV(a, b, c) <= 0) continue;
        let blocked = false;
        for (const w of poly) {
          if (w === a || w === b || w === c) continue;
          if (this.orientV(a, b, w) >= 0 && this.orientV(b, c, w) >= 0 && this.orientV(c, a, w) >= 0) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        out.push(a, b, c);
        poly.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) throw new CdtError('removeVertex: no ear found');
    }
    if (this.orientV(poly[0], poly[1], poly[2]) <= 0) throw new CdtError('removeVertex: degenerate final triangle');
    out.push(poly[0], poly[1], poly[2]);

    // Emit triangles and stitch them to each other and to the outside.
    const inner = new Map<number, number>();
    const stack: number[] = [];
    for (let j = 0; j < out.length; j += 3) {
      const t = this.allocTri();
      this.tBlock[t] = blk;
      this.setTri(t, out[j], out[j + 1], out[j + 2]);
      for (let m = 0; m < 3; m++) {
        const e = 3 * t + m;
        const u = this.tri[e], w = this.tri[next(e)];
        stack.push(u, w);
        const bi = boundary.get(edgeKey(u, w));
        if (bi !== undefined) {
          this.link(e, outerOpp[bi]);
          this.cRef[e] = outerRef[bi];
          continue;
        }
        this.cRef[e] = 0;
        const twin = inner.get(edgeKey(w, u));
        if (twin !== undefined) {
          this.link(e, twin);
          inner.delete(edgeKey(w, u));
        } else {
          this.opp[e] = NONE;
          inner.set(edgeKey(u, w), e);
        }
      }
    }
    if (inner.size !== 0) throw new CdtError('removeVertex: unmatched diagonals');
    this.legalize(stack);
  }

  // ── Validation (tests / debug) ───────────────────────────────────────────────

  /** Checks structural and Delaunay invariants; returns a list of problems (empty = valid). */
  validate(maxProblems = 20): string[] {
    const errs: string[] = [];
    const err = (m: string): boolean => {
      errs.push(m);
      return errs.length >= maxProblems;
    };
    let area2 = 0;
    for (let t = 0; t < this.tCount; t++) {
      if (!this.isLiveTri(t)) continue;
      const a = this.tri[3 * t], b = this.tri[3 * t + 1], c = this.tri[3 * t + 2];
      if (this.vFlags[a] & V_DEAD || this.vFlags[b] & V_DEAD || this.vFlags[c] & V_DEAD) {
        if (err(`t${t} references a dead vertex`)) return errs;
      }
      if (this.orientV(a, b, c) <= 0 && err(`t${t} not positive`)) return errs;
      const { vx, vy } = this;
      area2 += (vx[b] - vx[a]) * (vy[c] - vy[a]) - (vy[b] - vy[a]) * (vx[c] - vx[a]);
      for (let k = 0; k < 3; k++) {
        const e = 3 * t + k;
        const f = this.opp[e];
        if (f === NONE) {
          // Hull edges must lie on the map boundary.
          const p = this.tri[e], q = this.tri[next(e)];
          const onBoundary =
            (vx[p] === 0 && vx[q] === 0) || (vx[p] === this.width && vx[q] === this.width) ||
            (vy[p] === 0 && vy[q] === 0) || (vy[p] === this.height && vy[q] === this.height);
          if (!onBoundary && err(`hull edge ${e} not on the map boundary`)) return errs;
          continue;
        }
        if (this.opp[f] !== e && err(`opp not symmetric at ${e}`)) return errs;
        if ((this.tri[f] !== this.tri[next(e)] || this.tri[next(f)] !== this.tri[e]) && err(`twin mismatch at ${e}`)) return errs;
        if (this.cRef[e] !== this.cRef[f] && err(`cRef mismatch at ${e}`)) return errs;
        if (this.cRef[e] === 0 && this.isIllegal(e) && err(`edge ${e} not Delaunay`)) return errs;
        if (this.cRef[e] === 0 && this.tBlock[t] !== this.tBlock[(f / 3) | 0] && err(`block mismatch across unconstrained edge ${e}`)) return errs;
      }
    }
    for (let v = 0; v < this.vCount; v++) {
      if (this.vFlags[v] & V_DEAD) continue;
      const e = this.vEdge[v];
      if ((e === NONE || this.tri[e] !== v || !this.isLiveTri((e / 3) | 0)) && err(`v${v} has a bad vEdge`)) return errs;
    }
    const expected = 2 * this.width * this.height;
    if (Math.abs(area2 - expected) > 1e-6 * expected) err(`area ${area2 / 2} ≠ ${expected / 2}`);
    return errs;
  }

  /** Live triangle count. */
  liveTriangles(): number {
    return this.tCount - this.tFree.length;
  }

  liveVertices(): number {
    return this.vCount - this.vFree.length;
  }
}

function edgeKey(u: number, v: number): number {
  return u * 4_194_304 + v;
}

function latticeKey(x: number, y: number): number {
  return Math.round(x * LATTICE) * 1_048_576 + Math.round(y * LATTICE);
}

function grow<T extends Float64Array | Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array>(a: T, cap: number): T {
  const out = new (a.constructor as new (n: number) => T)(cap);
  out.set(a);
  return out;
}
