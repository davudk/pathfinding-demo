/**
 * Local detours around units that can't be pushed (holders, enemies). The global path
 * ignores units, so when a unit is stuck behind a wall of them, plan a short route on a local
 * grid that marks both static obstacles and those blockers, and splice it into the path.
 */
import { MoveState } from '../store/units';
import type { World } from '../world';

const RES = 4; // cells per world unit
/** Window half-sizes tried in order (world units): small and cheap first, then wide. */
const WINDOWS = [12, 26];
const N_MAX = 2 * WINDOWS[WINDOWS.length - 1] * RES;
const TEAM = [0, 1, 2, 0, 3];

const blocked = new Uint8Array(N_MAX * N_MAX);
const dist = new Int32Array(N_MAX * N_MAX);
const prev = new Int32Array(N_MAX * N_MAX);
const queue = new Int32Array(N_MAX * N_MAX);
const range = new Int32Array(4);
let N = 0;

/**
 * Tries to splice a detour into unit i's path that avoids non-pushable units. Returns false
 * if no local route was found (the caller falls back to giving up).
 */
export function planDetour(world: World, i: number): boolean {
  for (const half of WINDOWS) if (planIn(world, i, half)) return true;
  return false;
}

function planIn(world: World, i: number, HALF: number): boolean {
  N = 2 * HALF * RES;
  const { units: u, paths, grid } = world;
  const pts = paths.points[i];
  if (!pts) return false;
  const r = u.radius[i];
  const cx = u.posX[i], cy = u.posY[i];
  const ox = cx - HALF, oy = cy - HALF;
  const occ = world.map.occupancy;
  const team = TEAM[u.faction[i]];

  // Static obstacles: a cell is free if the unit fits there.
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const x = ox + (gx + 0.5) / RES, y = oy + (gy + 0.5) / RES;
      blocked[gy * N + gx] = occ.isFreeCircle(x, y, r) ? 0 : 1;
    }
  }
  // Dynamic blockers: units that won't move out of the way.
  grid.range(cx, cy, HALF + 2, range);
  for (let gyc = range[1]; gyc <= range[3]; gyc++) {
    for (let gxc = range[0]; gxc <= range[2]; gxc++) {
      const c = gyc * grid.cols + gxc;
      for (let q = grid.cellStart[c]; q < grid.cellStart[c + 1]; q++) {
        const j = grid.items[q];
        if (j === i) continue;
        const holding = u.state[j] === MoveState.Holding;
        const enemyStill = TEAM[u.faction[j]] !== team && u.state[j] !== MoveState.Moving;
        if (!holding && !enemyStill) continue;
        const R = r + u.radius[j] + 0.05;
        const x0 = Math.max(0, Math.floor((u.posX[j] - R - ox) * RES));
        const x1 = Math.min(N - 1, Math.floor((u.posX[j] + R - ox) * RES));
        const y0 = Math.max(0, Math.floor((u.posY[j] - R - oy) * RES));
        const y1 = Math.min(N - 1, Math.floor((u.posY[j] + R - oy) * RES));
        for (let gy = y0; gy <= y1; gy++) {
          for (let gx = x0; gx <= x1; gx++) {
            const x = ox + (gx + 0.5) / RES, y = oy + (gy + 0.5) / RES;
            if ((x - u.posX[j]) ** 2 + (y - u.posY[j]) ** 2 < R * R) blocked[gy * N + gx] = 1;
          }
        }
      }
    }
  }

  // Target: the farthest point along the remaining path (sampled, not just its vertices)
  // that is still inside the window and on a free cell.
  const m = pts.length >> 1;
  let target = -1, targetIdx = -1, tx = 0, ty = 0;
  let ax = cx, ay = cy;
  outer: for (let k = paths.cursor[i]; k < m; k++) {
    const bx = pts[2 * k], by = pts[2 * k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / 0.5));
    for (let s = 1; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
      const gx = Math.floor((x - ox) * RES), gy = Math.floor((y - oy) * RES);
      if (gx < 2 || gy < 2 || gx >= N - 2 || gy >= N - 2) break outer;
      if (!blocked[gy * N + gx]) {
        target = gy * N + gx;
        targetIdx = s === steps ? k + 1 : k;
        tx = x;
        ty = y;
      }
    }
    ax = bx;
    ay = by;
  }
  if (target < 0) return false;

  // BFS (8-connected) from the unit's cell.
  const sx = Math.min(N - 1, Math.max(0, Math.floor((cx - ox) * RES)));
  const sy = Math.min(N - 1, Math.max(0, Math.floor((cy - oy) * RES)));
  const start = sy * N + sx;
  dist.fill(-1, 0, N * N);
  let head = 0, tail = 0;
  dist[start] = 0;
  prev[start] = -1;
  queue[tail++] = start;
  blocked[start] = 0;
  let found = false;
  while (head < tail) {
    const c = queue[head++];
    if (c === target) {
      found = true;
      break;
    }
    const gx = c % N, gy = (c / N) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const nc = ny * N + nx;
        if (blocked[nc] || dist[nc] >= 0) continue;
        // No diagonal corner cutting.
        if (dx !== 0 && dy !== 0 && (blocked[gy * N + nx] || blocked[ny * N + gx])) continue;
        dist[nc] = dist[c] + 1;
        prev[nc] = c;
        queue[tail++] = nc;
      }
    }
  }
  if (!found) return false;

  // Cells → points, then string-pull with grid line-of-sight.
  const cells: number[] = [];
  for (let c = target; c >= 0; c = prev[c]) cells.push(c);
  cells.reverse();
  const way: number[] = [cx, cy];
  let anchor = 0;
  for (let k = 2; k < cells.length; k++) {
    if (!lineFree(cells[anchor], cells[k])) {
      anchor = k - 1;
      const c = cells[anchor];
      way.push(ox + ((c % N) + 0.5) / RES, oy + (((c / N) | 0) + 0.5) / RES);
    }
  }
  // Rejoin the original path at the target point, then continue along it.
  way.push(tx, ty);
  for (let k = targetIdx; k < m; k++) way.push(pts[2 * k], pts[2 * k + 1]);
  const complete = paths.complete[i] === 1;
  paths.set(i, Float64Array.from(way), complete);
  return true;
}

function lineFree(a: number, b: number): boolean {
  let x0 = a % N, y0 = (a / N) | 0;
  const x1 = b % N, y1 = (b / N) | 0;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (blocked[y0 * N + x0]) return false;
    if (x0 === x1 && y0 === y1) return true;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}
