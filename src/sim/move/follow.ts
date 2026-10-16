import { SIM_DT } from '../../shared/constants';
import { turnToward } from '../../shared/math';
import { MoveState, UNIT_FLAG_DRIFT } from '../store/units';
import type { World } from '../world';

/**
 * Temporary locomotion for M3: units with a path walk its polyline at full speed (no
 * acceleration, no unit-unit interaction); idle units stand still; drifting ambient units use
 * the M0 drift. The real steering + contact pipeline replaces this in M4.
 */
export function followPaths(world: World): void {
  const { units: u, paths } = world;
  const dt = SIM_DT;
  for (let k = 0; k < u.count; k++) {
    const i = u.active[k];
    if (u.flags[i] & UNIT_FLAG_DRIFT) continue;
    const pts = paths.points[i];
    if (!pts) {
      u.velX[i] = 0;
      u.velY[i] = 0;
      if (u.state[i] === MoveState.Moving && !paths.pending[i]) u.state[i] = MoveState.Idle;
      continue;
    }
    let budget = u.maxSpeed[i] * dt;
    let x = u.posX[i], y = u.posY[i];
    let c = paths.cursor[i];
    const n = pts.length >> 1;
    let dirX = 0, dirY = 0;
    while (budget > 0 && c < n) {
      const tx = pts[2 * c], ty = pts[2 * c + 1];
      const dx = tx - x, dy = ty - y;
      const d = Math.hypot(dx, dy);
      if (d <= budget) {
        x = tx;
        y = ty;
        budget -= d;
        c++;
        if (d > 1e-9) {
          dirX = dx / d;
          dirY = dy / d;
        }
      } else {
        dirX = dx / d;
        dirY = dy / d;
        x += dirX * budget;
        y += dirY * budget;
        budget = 0;
      }
    }
    u.velX[i] = (x - u.posX[i]) / dt;
    u.velY[i] = (y - u.posY[i]) / dt;
    u.posX[i] = x;
    u.posY[i] = y;
    paths.cursor[i] = c;
    if (dirX !== 0 || dirY !== 0) u.heading[i] = turnToward(u.heading[i], Math.atan2(dirY, dirX), u.turnRate[i] * dt);
    if (c >= n) {
      paths.points[i] = null;
      paths.version[i]++;
      u.state[i] = MoveState.Idle;
      u.velX[i] = 0;
      u.velY[i] = 0;
    } else {
      u.state[i] = MoveState.Moving;
    }
  }
}
