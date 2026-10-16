/**
 * Obstacle boundary segments (constrained navmesh edges with exactly one free side, plus the
 * map border) bucketed in a uniform grid, each with its unit normal pointing into free space.
 * Used to push units out of walls and to slide them along.
 */
import { NONE, next } from '../nav/cdt';
import type { NavMesh } from '../nav/navmesh';

const CELL = 4;

export class WallGrid {
  x0 = new Float64Array(0);
  y0 = new Float64Array(0);
  x1 = new Float64Array(0);
  y1 = new Float64Array(0);
  nx = new Float64Array(0);
  ny = new Float64Array(0);
  count = 0;
  readonly cols: number;
  readonly rows: number;
  cellStart = new Int32Array(0);
  items = new Int32Array(0);
  /** Per-segment visit stamps for de-duplicating queries that span several cells. */
  stamp = new Uint32Array(0);
  stampGen = 0;
  version = -1;

  constructor(readonly width: number, readonly height: number) {
    this.cols = Math.ceil(width / CELL);
    this.rows = Math.ceil(height / CELL);
  }

  rebuild(nav: NavMesh): void {
    const cdt = nav.cdt;
    const segs: number[] = [];
    for (let e = 0; e < cdt.tCount * 3; e++) {
      const t = (e / 3) | 0;
      if (!cdt.isLiveTri(t) || cdt.tBlock[t] > 0) continue; // e's owning side must be free
      const f = cdt.opp[e];
      const constrained = cdt.cRef[e] > 0 || f === NONE;
      if (!constrained) continue;
      if (f !== NONE && cdt.tBlock[(f / 3) | 0] === 0) continue; // free on both sides: not a wall
      const a = cdt.tri[e], b = cdt.tri[next(e)];
      const ax = cdt.vx[a], ay = cdt.vy[a], bx = cdt.vx[b], by = cdt.vy[b];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-9) continue;
      // The owning triangle (free) is on the left of a→b: left normal (−dy, dx).
      segs.push(ax, ay, bx, by, -(by - ay) / len, (bx - ax) / len);
    }
    const n = segs.length / 6;
    this.count = n;
    this.x0 = new Float64Array(n);
    this.y0 = new Float64Array(n);
    this.x1 = new Float64Array(n);
    this.y1 = new Float64Array(n);
    this.nx = new Float64Array(n);
    this.ny = new Float64Array(n);
    this.stamp = new Uint32Array(n);
    for (let s = 0; s < n; s++) {
      this.x0[s] = segs[6 * s];
      this.y0[s] = segs[6 * s + 1];
      this.x1[s] = segs[6 * s + 2];
      this.y1[s] = segs[6 * s + 3];
      this.nx[s] = segs[6 * s + 4];
      this.ny[s] = segs[6 * s + 5];
    }
    // Bucket by bounding box (CSR).
    const cells = this.cols * this.rows;
    const counts = new Int32Array(cells + 1);
    const forCells = (s: number, fn: (c: number) => void): void => {
      const cx0 = Math.max(0, Math.floor(Math.min(this.x0[s], this.x1[s]) / CELL));
      const cx1 = Math.min(this.cols - 1, Math.floor(Math.max(this.x0[s], this.x1[s]) / CELL));
      const cy0 = Math.max(0, Math.floor(Math.min(this.y0[s], this.y1[s]) / CELL));
      const cy1 = Math.min(this.rows - 1, Math.floor(Math.max(this.y0[s], this.y1[s]) / CELL));
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) fn(cy * this.cols + cx);
    };
    for (let s = 0; s < n; s++) forCells(s, (c) => counts[c + 1]++);
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    const items = new Int32Array(counts[cells]);
    const cur = counts.slice(0, cells);
    for (let s = 0; s < n; s++) forCells(s, (c) => (items[cur[c]++] = s));
    this.cellStart = counts;
    this.items = items;
    this.version = nav.version;
  }

  /**
   * Pushes a circle at (x, y) with radius r out of every wall it overlaps. Writes the corrected
   * position to out[0..1] and the accumulated push normal to out[2..3]; returns true if moved.
   */
  resolve(x: number, y: number, r: number, out: Float64Array): boolean {
    let px = x, py = y, pnx = 0, pny = 0;
    let moved = false;
    for (let pass = 0; pass < 2; pass++) {
      const gen = ++this.stampGen;
      const cx0 = Math.max(0, Math.floor((px - r) / CELL)), cx1 = Math.min(this.cols - 1, Math.floor((px + r) / CELL));
      const cy0 = Math.max(0, Math.floor((py - r) / CELL)), cy1 = Math.min(this.rows - 1, Math.floor((py + r) / CELL));
      let any = false;
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = cy * this.cols + cx;
          for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
            const s = this.items[k];
            if (this.stamp[s] === gen) continue;
            this.stamp[s] = gen;
            const ax = this.x0[s], ay = this.y0[s];
            const ex = this.x1[s] - ax, ey = this.y1[s] - ay;
            const l2 = ex * ex + ey * ey;
            let u = ((px - ax) * ex + (py - ay) * ey) / l2;
            u = u < 0 ? 0 : u > 1 ? 1 : u;
            const qx = ax + ex * u, qy = ay + ey * u;
            let dx = px - qx, dy = py - qy;
            if (u > 0 && u < 1) {
              // Interior of the segment: signed distance along the free-side normal. Points far
              // behind the line belong to the obstacle's other side and are left to that wall.
              const side = dx * this.nx[s] + dy * this.ny[s];
              if (side >= r || side <= -r) continue;
              const push = r - side;
              px += this.nx[s] * push;
              py += this.ny[s] * push;
              pnx += this.nx[s];
              pny += this.ny[s];
            } else {
              // Endpoint (corner): push radially away from it.
              const d = Math.hypot(dx, dy);
              if (d >= r) continue;
              if (d < 1e-9) {
                dx = this.nx[s];
                dy = this.ny[s];
              } else {
                dx /= d;
                dy /= d;
              }
              const push = r - d;
              px += dx * push;
              py += dy * push;
              pnx += dx;
              pny += dy;
            }
            any = true;
            moved = true;
          }
        }
      }
      if (!any) break;
    }
    out[0] = px;
    out[1] = py;
    const nl = Math.hypot(pnx, pny);
    out[2] = nl > 0 ? pnx / nl : 0;
    out[3] = nl > 0 ? pny / nl : 0;
    return moved;
  }
}
