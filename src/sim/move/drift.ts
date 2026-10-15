import { SIM_DT } from '../../shared/constants';
import { turnToward } from '../../shared/math';
import { MoveState } from '../store/units';
import type { World } from '../world';

/**
 * Placeholder locomotion for the engine shell (M0): units drift with a slowly wandering
 * heading and bounce off the map edges. Replaced by the real movement pipeline in M4.
 */
export function driftUnits(world: World): void {
  const { units: u, rng, mapW, mapH } = world;
  const dt = SIM_DT;
  for (let k = 0; k < u.count; k++) {
    const i = u.active[k];
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

    let x = u.posX[i] + vx * dt;
    let y = u.posY[i] + vy * dt;
    if (x < r) { x = r; vx = Math.abs(vx); }
    else if (x > mapW - r) { x = mapW - r; vx = -Math.abs(vx); }
    if (y < r) { y = r; vy = Math.abs(vy); }
    else if (y > mapH - r) { y = mapH - r; vy = -Math.abs(vy); }

    u.posX[i] = x;
    u.posY[i] = y;
    u.velX[i] = vx;
    u.velY[i] = vy;
    u.heading[i] = turnToward(u.heading[i], Math.atan2(vy, vx), u.turnRate[i] * dt);
    u.state[i] = MoveState.Moving;
  }
}
