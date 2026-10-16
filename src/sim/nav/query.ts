/** Point queries on the navmesh: clearance to obstacles and snapping to valid positions. */
import { NONE, next } from './cdt';
import type { NavMesh } from './navmesh';

export interface Clearance {
  /** Distance to the nearest obstacle edge (capped at maxR); 0 if inside an obstacle. */
  dist: number;
  /** Closest obstacle point (valid when dist < maxR). */
  cx: number;
  cy: number;
}

const scratch: Clearance = { dist: 0, cx: 0, cy: 0 };
let visit = new Uint32Array(0);
let visitGen = 0;

/** Distance from (x, y) to the nearest constrained or hull edge, searching up to maxR. */
export function clearance(nav: NavMesh, x: number, y: number, maxR: number, out: Clearance = scratch): Clearance {
  const cdt = nav.cdt;
  out.dist = 0;
  out.cx = x;
  out.cy = y;
  const t0 = cdt.locate(x, y);
  if (t0 === NONE || cdt.tBlock[t0] > 0) return out;
  if (visit.length < cdt.tCount) visit = new Uint32Array(cdt.tFlags.length);
  const gen = ++visitGen;
  let best = maxR;
  const stack = [t0];
  visit[t0] = gen;
  while (stack.length) {
    const t = stack.pop()!;
    for (let k = 0; k < 3; k++) {
      const e = 3 * t + k;
      const a = cdt.tri[e], b = cdt.tri[next(e)];
      const ax = cdt.vx[a], ay = cdt.vy[a], bx = cdt.vx[b], by = cdt.vy[b];
      const ex = bx - ax, ey = by - ay;
      const l2 = ex * ex + ey * ey;
      let u = l2 > 0 ? ((x - ax) * ex + (y - ay) * ey) / l2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = ax + ex * u, qy = ay + ey * u;
      const d = Math.hypot(x - qx, y - qy);
      if (d >= best) continue;
      const f = cdt.opp[e];
      if (cdt.cRef[e] > 0 || f === NONE) {
        best = d;
        out.cx = qx;
        out.cy = qy;
        continue;
      }
      const n = (f / 3) | 0;
      if (visit[n] === gen) continue;
      visit[n] = gen;
      stack.push(n);
    }
  }
  out.dist = best;
  return out;
}

/** True when a circle of radius r at (x, y) is in free space. */
export function isValidPosition(nav: NavMesh, x: number, y: number, r: number): boolean {
  return clearance(nav, x, y, r + 1e-6).dist >= r - 1e-9;
}

/**
 * Nearest position within maxDist of (x, y) where a circle of radius r fits. Returns null if
 * none was found. Candidates come from obstacle edges and corners around the point, then get
 * pushed out of any remaining overlap.
 */
export function snapToWalkable(nav: NavMesh, x: number, y: number, r: number, maxDist = 12): [number, number] | null {
  if (isValidPosition(nav, x, y, r)) return [x, y];
  const cdt = nav.cdt;
  const t0 = cdt.locate(Math.min(cdt.width, Math.max(0, x)), Math.min(cdt.height, Math.max(0, y)));
  if (t0 === NONE) return null;
  if (visit.length < cdt.tCount) visit = new Uint32Array(cdt.tFlags.length);
  const gen = ++visitGen;
  const pad = r + 0.02;
  const reach = maxDist + r;
  const cands: number[] = [];
  const stack = [t0];
  visit[t0] = gen;
  while (stack.length) {
    const t = stack.pop()!;
    for (let k = 0; k < 3; k++) {
      const e = 3 * t + k;
      const a = cdt.tri[e], b = cdt.tri[next(e)];
      const ax = cdt.vx[a], ay = cdt.vy[a], bx = cdt.vx[b], by = cdt.vy[b];
      const ex = bx - ax, ey = by - ay;
      const len = Math.hypot(ex, ey);
      let u = len > 0 ? ((x - ax) * ex + (y - ay) * ey) / (len * len) : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = ax + ex * u, qy = ay + ey * u;
      if (Math.hypot(x - qx, y - qy) > reach) continue;
      const f = cdt.opp[e];
      const constrained = cdt.cRef[e] > 0 || f === NONE;
      if (constrained && len > 0) {
        // Free side: the owning triangle (left of a→b) if free, else the right side.
        const leftFree = cdt.tBlock[t] === 0;
        const nx = (leftFree ? -ey : ey) / len, ny = (leftFree ? ex : -ex) / len;
        cands.push(qx + nx * pad, qy + ny * pad);
        cands.push(ax + nx * pad, ay + ny * pad, bx + nx * pad, by + ny * pad);
      }
      if (f === NONE) continue;
      const n = (f / 3) | 0;
      if (visit[n] === gen) continue;
      visit[n] = gen;
      stack.push(n);
    }
  }
  let best: [number, number] | null = null;
  let bestD = Infinity;
  const c: Clearance = { dist: 0, cx: 0, cy: 0 };
  for (let i = 0; i < cands.length; i += 2) {
    let px = cands[i], py = cands[i + 1];
    if (Math.hypot(px - x, py - y) >= bestD) continue;
    // Push out of remaining overlaps (concave corners need a few iterations).
    let ok = false;
    for (let it = 0; it < 6; it++) {
      if (px < 0 || py < 0 || px > cdt.width || py > cdt.height) break;
      clearance(nav, px, py, r + 0.05, c);
      const t = cdt.locate(px, py);
      if (t === NONE || cdt.tBlock[t] > 0) break;
      if (c.dist >= r - 1e-6) {
        ok = true;
        break;
      }
      const dx = px - c.cx, dy = py - c.cy;
      const d = Math.hypot(dx, dy) || 1;
      px += (dx / d) * (r - c.dist + 0.02);
      py += (dy / d) * (r - c.dist + 0.02);
    }
    if (!ok) continue;
    const d = Math.hypot(px - x, py - y);
    if (d < bestD && d <= maxDist + r) {
      bestD = d;
      best = [px, py];
    }
  }
  return best;
}
