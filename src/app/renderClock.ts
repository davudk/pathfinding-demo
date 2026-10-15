import { SIM_HZ } from '../shared/constants';

/** How far behind the newest snapshot rendering runs, in ticks (1 tick + jitter slack). */
const DELAY_TICKS = 1.25;
/** Fraction of the timing error corrected per frame. */
const CORRECTION = 0.08;
/** Errors larger than this (ticks) snap instead of easing. */
const SNAP_TICKS = 3;

/**
 * Continuous render time in ticks. Advances smoothly at the sim rate and is eased toward
 * where the newest snapshot says the sim is, so worker timing jitter never shows as stutter.
 */
export class RenderClock {
  t = -1;

  /**
   * @param frameDtMs     wall time since the previous frame
   * @param latestTick    newest snapshot tick
   * @param latestTimeAbs newest snapshot publish time (timeOrigin-relative absolute ms)
   */
  update(frameDtMs: number, latestTick: number, latestTimeAbs: number, timeScale: number, paused: boolean): number {
    const rate = paused ? 0 : (SIM_HZ * timeScale) / 1000;
    const nowAbs = performance.timeOrigin + performance.now();
    const target = paused ? latestTick : latestTick + Math.max(0, nowAbs - latestTimeAbs) * rate - DELAY_TICKS;
    if (this.t < 0 || Math.abs(target - this.t) > SNAP_TICKS) {
      this.t = target;
    } else {
      this.t += frameDtMs * rate;
      this.t += (target - this.t) * CORRECTION;
    }
    if (this.t > latestTick) this.t = latestTick;
    return this.t;
  }
}
