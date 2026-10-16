import { SIM_DT } from '../../shared/constants';
import { turnToward } from '../../shared/math';
import { MoveState, UNIT_FLAG_DRIFT } from '../store/units';
import type { World } from '../world';

/**
 * Placeholder locomotion for the engine shell (M0): units drift with a slowly wandering
 * heading and bounce off the map edges. Replaced by the real movement pipeline in M4.
 */
export function driftUnits(world: World): void {
  const { units: u, rng, mapW, mapH } = world;
  const occ = world.map.occupancy;
  const dt = SIM_DT;
  for (let k = 0; k < u.count; k++) {
    const i = u.active[k];
    if ((u.flags[i] & UNIT_FLAG_DRIFT) === 0) continue;
    const r = u.radius[i];
    let vx = u.velX[i];
    let vy = u.velY[i];

    // Gentle random steering: rotate velocity by a small jittered angle.
    const jitter = (rng.float() - 0.5) * 0.6 * dt * u.turnRate[i] * 0.25;
    const c = Math.cos(jitter);
    const s = Math.sin(jitter);
    const nvx = vx * c - vy * s;
    vy = vx * s + vy * c;
    vx = nvx;

    const px = u.posX[i], py = u.posY[i];
    let x = px + vx * dt;
    let y = py + vy * dt;
    if (x < r) { x = r; vx = Math.abs(vx); }
    else if (x > mapW - r) { x = mapW - r; vx = -Math.abs(vx); }
    if (y < r) { y = r; vy = Math.abs(vy); }
    else if (y > mapH - r) { y = mapH - r; vy = -Math.abs(vy); }
    // Placeholder obstacle response: slide along one axis, else bounce back.
    if (!occ.isFreeCircle(x, y, r)) {
      if (occ.isFreeCircle(x, py, r)) { y = py; vy = -vy; }
      else if (occ.isFreeCircle(px, y, r)) { x = px; vx = -vx; }
      else { x = px; y = py; vx = -vx; vy = -vy; }
    }

    u.posX[i] = x;
    u.posY[i] = y;
    u.velX[i] = vx;
    u.velY[i] = vy;
    u.heading[i] = turnToward(u.heading[i], Math.atan2(vy, vx), u.turnRate[i] * dt);
    u.state[i] = MoveState.Moving;
  }
}
