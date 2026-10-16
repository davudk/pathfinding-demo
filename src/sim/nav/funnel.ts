/**
 * Radius-aware "simple stupid funnel" (Mononen) over a triangle corridor. Portal endpoints
 * are obstacle corners; the unit keeps distance r from them, so corners are circles and the
 * funnel compares directions of circle-to-circle tangent lines instead of raw points.
 *
 * Output: a polyline that runs along tangent segments and wraps each corner circle with a
 * short arc — paths hug corners at exactly the unit's clearance.
 */

/** Portal endpoint: vertex id (or START / GOAL), position, and which side of travel it is on. */
export const START = -1;
export const GOAL = -2;

/** +1 = left of travel (path passes to its right), -1 = right of travel, 0 = a point. */
type Side = -1 | 0 | 1;

export interface Corridor {
  /** Per portal: left vertex id, right vertex id, and their coordinates. */
  readonly leftId: Int32Array;
  readonly rightId: Int32Array;
  readonly lx: Float64Array;
  readonly ly: Float64Array;
  readonly rx: Float64Array;
  readonly ry: Float64Array;
  readonly count: number;
}

export interface FunnelResult {
  /** Polyline [x0, y0, x1, y1, ...] from start to goal. */
  readonly points: Float64Array;
  /** Corners wrapped: [x, y, side, ...] (for debug drawing). */
  readonly corners: Float64Array;
  /** Total polyline length. */
  readonly length: number;
}

interface Node {
  id: number;
  x: number;
  y: number;
  s: Side;
}

/**
 * Direction (unit vector, written to out[0..1]) of the tangent line leaving circle A and
 * arriving at circle B, where each circle has radius r·|side| and the path keeps left
 * corners on its left and right corners on its right.
 */
function tangentDir(a: Node, b: Node, r: number, out: Float64Array): void {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) {
    out[0] = 1;
    out[1] = 0;
    return;
  }
  const ux = dx / len, uy = dy / len;
  // Touch point on a circle with side s along direction d is  V + s·r·(dy, −dx).
  // Requiring the touch-to-touch vector to be parallel to d gives sin(θ − φ) = −k/|D|.
  const k = r * (b.s - a.s);
  let sn = -k / len;
  if (sn > 1) sn = 1;
  else if (sn < -1) sn = -1;
  const cs = Math.sqrt(1 - sn * sn);
  out[0] = ux * cs - uy * sn;
  out[1] = ux * sn + uy * cs;
}

function touch(n: Node, r: number, dx: number, dy: number, out: Float64Array, o: number): void {
  out[o] = n.x + n.s * r * dy;
  out[o + 1] = n.y - n.s * r * dx;
}

const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

/**
 * Runs the funnel. Portals must be ordered from start to goal; a degenerate goal portal is
 * appended internally.
 */
export function funnel(
  c: Corridor, sx: number, sy: number, gx: number, gy: number, r: number,
  /** Obstacle vertices around the corridor as [x, y, id, ...] for the clearance repair pass. */
  guards?: Float64Array,
): FunnelResult {
  const n = c.count;
  // Portal list including the final goal "portal".
  const L: Node[] = [];
  const R: Node[] = [];
  for (let i = 0; i < n; i++) {
    L.push({ id: c.leftId[i], x: c.lx[i], y: c.ly[i], s: 1 });
    R.push({ id: c.rightId[i], x: c.rx[i], y: c.ry[i], s: -1 });
  }
  const goal: Node = { id: GOAL, x: gx, y: gy, s: 0 };
  L.push(goal);
  R.push(goal);

  const corners: Node[] = [];
  let apex: Node = { id: START, x: sx, y: sy, s: 0 };
  let left = L[0], right = R[0];
  let apexIdx = 0, leftIdx = 0, rightIdx = 0;
  const da = new Float64Array(2), db = new Float64Array(2);
  /** Sign of the turn from direction apex→p to apex→q (tangent directions). */
  const turn = (p: Node, q: Node): number => {
    tangentDir(apex, p, r, da);
    tangentDir(apex, q, r, db);
    return cross(da[0], da[1], db[0], db[1]);
  };

  for (let i = 1, guard = 0; i < L.length && guard < 100_000; i++, guard++) {
    const pl = L[i], pr = R[i];

    // Tighten the right side (pr at or left of the current right ray).
    if (right.id === apex.id || turn(right, pr) >= 0) {
      if (right.id === apex.id || left.id === apex.id || turn(left, pr) < 0) {
        right = pr;
        rightIdx = i;
      } else {
        // Right crossed over left: the left corner becomes the apex; restart after it.
        corners.push(left);
        apex = left;
        apexIdx = leftIdx;
        right = left;
        rightIdx = leftIdx;
        i = apexIdx;
        continue;
      }
    }

    // Tighten the left side (pl at or right of the current left ray).
    if (left.id === apex.id || turn(left, pl) <= 0) {
      if (left.id === apex.id || right.id === apex.id || turn(right, pl) > 0) {
        left = pl;
        leftIdx = i;
      } else {
        corners.push(right);
        apex = right;
        apexIdx = rightIdx;
        left = right;
        leftIdx = rightIdx;
        i = apexIdx;
        continue;
      }
    }
  }
  if (corners.length > 0 && corners[corners.length - 1].id === GOAL) corners.pop();
  if (guards && r > 0) repairCorners({ id: START, x: sx, y: sy, s: 0 }, corners, goal, r, guards);

  return buildPolyline({ id: START, x: sx, y: sy, s: 0 }, corners, goal, r);
}

/**
 * The funnel only sees portal endpoints; obstacle corners of the start/goal triangles (and
 * any corner a tangent shortcut grazes) can end up closer than r to a straight run. Insert
 * each offending vertex as a corner on the side it actually lies, until every run is clear.
 */
function repairCorners(start: Node, corners: Node[], goal: Node, r: number, guards: Float64Array): void {
  const d = new Float64Array(2), t = new Float64Array(4);
  const limit = r - 1e-6;
  for (let pass = 0; pass < 16; pass++) {
    const seq = [start, ...corners, goal];
    let fixed = false;
    for (let i = 0; i + 1 < seq.length && !fixed; i++) {
      const a = seq[i], b = seq[i + 1];
      tangentDir(a, b, r, d);
      touch(a, r, d[0], d[1], t, 0);
      touch(b, r, d[0], d[1], t, 2);
      const ex = t[2] - t[0], ey = t[3] - t[1];
      const l2 = ex * ex + ey * ey;
      if (l2 < 1e-12) continue;
      let worst = -1, worstD = limit;
      for (let g = 0; g < guards.length; g += 3) {
        const id = guards[g + 2];
        if (id === a.id || id === b.id) continue;
        const vx = guards[g], vy = guards[g + 1];
        const u = ((vx - t[0]) * ex + (vy - t[1]) * ey) / l2;
        if (u <= 0 || u >= 1) continue; // endpoints are already clear (corner circles / valid points)
        const dist = Math.hypot(vx - (t[0] + ex * u), vy - (t[1] + ey * u));
        if (dist < worstD) {
          worstD = dist;
          worst = g;
        }
      }
      if (worst < 0) continue;
      const vx = guards[worst], vy = guards[worst + 1];
      const side: Side = cross(ex, ey, vx - t[0], vy - t[1]) > 0 ? 1 : -1;
      corners.splice(i, 0, { id: guards[worst + 2], x: vx, y: vy, s: side });
      fixed = true;
    }
    if (!fixed) return;
  }
}

/** Turns start → corner circles → goal into a polyline of tangents and sampled arcs. */
function buildPolyline(start: Node, corners: Node[], goal: Node, r: number): FunnelResult {
  const seq = [start, ...corners, goal];
  const pts: number[] = [start.x, start.y];
  const cornerOut: number[] = [];
  const d = new Float64Array(2), t = new Float64Array(4);
  let prevOutX = start.x, prevOutY = start.y;
  let length = 0;
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i], b = seq[i + 1];
    tangentDir(a, b, r, d);
    touch(a, r, d[0], d[1], t, 0); // leave a
    touch(b, r, d[0], d[1], t, 2); // arrive at b
    if (i > 0) {
      // Arc around corner a from where we arrived (prevOut) to where we leave (t[0..1]).
      appendArc(a, r, prevOutX, prevOutY, t[0], t[1], pts);
      cornerOut.push(a.x, a.y, a.s);
    }
    length += Math.hypot(t[2] - t[0], t[3] - t[1]);
    if (i + 1 < seq.length - 1) pts.push(t[2], t[3]);
    prevOutX = t[2];
    prevOutY = t[3];
  }
  pts.push(goal.x, goal.y);
  // Arc lengths are small; include them via the polyline itself.
  length = 0;
  for (let i = 2; i < pts.length; i += 2) length += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return { points: Float64Array.from(pts), corners: Float64Array.from(cornerOut), length };
}

/** Appends arc samples on circle (c, r) from point p to point q, going the short way that keeps c on side c.s. */
function appendArc(c: Node, r: number, px: number, py: number, qx: number, qy: number, out: number[]): void {
  if (r <= 0) {
    out.push(qx, qy);
    return;
  }
  const a0 = Math.atan2(py - c.y, px - c.x);
  let a1 = Math.atan2(qy - c.y, qx - c.x);
  // A corner on our left (s = +1) is circled with increasing angle (formula sense); a corner on
  // our right with decreasing angle.
  let da = a1 - a0;
  if (c.s > 0) {
    while (da < 0) da += 2 * Math.PI;
  } else {
    while (da > 0) da -= 2 * Math.PI;
  }
  // Guard against wrapping almost a full turn on degenerate input.
  if (Math.abs(da) > Math.PI * 1.5) da = da > 0 ? da - 2 * Math.PI : da + 2 * Math.PI;
  a1 = a0 + da;
  const steps = Math.max(1, Math.ceil(Math.abs(da) / (Math.PI / 10)));
  // Interior samples sit at r / cos(step/2) so every chord stays outside the clearance circle.
  const ro = r / Math.cos(Math.abs(da) / steps / 2);
  for (let k = 1; k <= steps; k++) {
    const a = a0 + (da * (k - 0.5)) / steps;
    out.push(c.x + Math.cos(a) * ro, c.y + Math.sin(a) * ro);
  }
  out.push(qx, qy);
}
