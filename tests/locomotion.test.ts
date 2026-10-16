import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { step } from '../src/sim/step';
import { clearance } from '../src/sim/nav/query';
import { MoveState } from '../src/sim/store/units';
import { SIM_HZ } from '../src/shared/constants';

interface Metrics {
  units: number;
  /** Seconds until no unit is Moving (or the cap). */
  settleS: number;
  stillMoving: number;
  /** Worst penetration into walls over the whole run (world units). */
  wallPen: number;
  /** Worst unit–unit overlap at the end, as a fraction of the smaller radius. */
  endOverlap: number;
  /** Mean / max displacement of idle units over the 3 s after settling. */
  jitterMean: number;
  jitterMax: number;
  ms: number;
}

function run(name: string, capS = 90): { w: World; m: Metrics } {
  const w = createWorld({ name, seed: 7, units: 0, mapSeed: 1337 }, 2048);
  const u = w.units;
  let wallPen = 0;
  let settle = -1;
  const t0 = performance.now();
  for (let t = 0; t < capS * SIM_HZ; t++) {
    step(w, []);
    if (t % 5 === 0) {
      for (let k = 0; k < u.count; k++) {
        const i = u.active[k];
        const c = clearance(w.nav, u.posX[i], u.posY[i], u.radius[i] + 0.1).dist;
        wallPen = Math.max(wallPen, u.radius[i] - c);
      }
    }
    if (t > 40) {
      let moving = 0;
      for (let k = 0; k < u.count; k++) if (u.state[u.active[k]] === MoveState.Moving) moving++;
      if (moving === 0) {
        settle = t / SIM_HZ;
        break;
      }
    }
  }
  const ms = performance.now() - t0;
  let stillMoving = 0;
  for (let k = 0; k < u.count; k++) if (u.state[u.active[k]] === MoveState.Moving) stillMoving++;
  // Jitter after settling: let arrival compression relax for 6 s, then measure 3 s.
  for (let t = 0; t < 6 * SIM_HZ; t++) step(w, []);
  const px = Float64Array.from(u.posX), py = Float64Array.from(u.posY);
  for (let t = 0; t < 3 * SIM_HZ; t++) step(w, []);
  let jm = 0, jx = 0, idle = 0;
  for (let k = 0; k < u.count; k++) {
    const i = u.active[k];
    if (u.state[i] === MoveState.Moving) continue;
    const d = Math.hypot(u.posX[i] - px[i], u.posY[i] - py[i]);
    jm += d;
    jx = Math.max(jx, d);
    idle++;
  }
  let overlap = 0;
  for (let a = 0; a < u.count; a++) {
    for (let b = a + 1; b < u.count; b++) {
      const i = u.active[a], j = u.active[b];
      const d = Math.hypot(u.posX[i] - u.posX[j], u.posY[i] - u.posY[j]);
      const pen = u.radius[i] + u.radius[j] - d;
      if (pen > 0) overlap = Math.max(overlap, pen / Math.min(u.radius[i], u.radius[j]));
    }
  }
  const m: Metrics = { units: u.count, settleS: settle < 0 ? capS : settle, stillMoving, wallPen, endOverlap: overlap, jitterMean: jm / Math.max(1, idle), jitterMax: jx, ms };
  const L = w.locomotion;
  console.info(`[${name}] detours ${L.detoursOk}/${L.detoursTried} gaveUp ${L.gaveUp}`);
  console.info(`[${name}]`, JSON.stringify(m, (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));
  return { w, m };
}

describe('locomotion scenarios', () => {
  it('choke: 200 units squeeze through a 4-wide gap', () => {
    const { m } = run('choke');
    expect(m.stillMoving).toBe(0);
    expect(m.wallPen).toBeLessThan(0.05);
    expect(m.endOverlap).toBeLessThan(0.25);
    expect(m.jitterMean).toBeLessThan(0.005);
  });

  it('holdline: holders are never pushed, movers funnel through the 1-wide gap', () => {
    const { w, m } = run('holdline', 120);
    expect(m.wallPen).toBeLessThan(0.05);
    // Holders stayed in place.
    const u = w.units;
    let held = 0, maxDrift = 0;
    for (let k = 0; k < u.count; k++) {
      const i = u.active[k];
      if (u.state[i] !== MoveState.Holding) continue;
      held++;
      maxDrift = Math.max(maxDrift, Math.abs(u.posY[i] - 100));
    }
    expect(held).toBeGreaterThan(50);
    expect(maxDrift).toBeLessThan(0.1);
    // Most movers made it past the line.
    let past = 0, movers = 0;
    for (let k = 0; k < u.count; k++) {
      const i = u.active[k];
      if (u.state[i] === MoveState.Holding) continue;
      movers++;
      if (u.posY[i] > 101) past++;
    }
    expect(past / movers).toBeGreaterThan(0.95);
  });

  it('cross: two armies swap sides without deadlock', () => {
    const { m } = run('cross');
    expect(m.stillMoving).toBe(0);
    expect(m.settleS).toBeLessThan(60);
    expect(m.wallPen).toBeLessThan(0.05);
  });

  it('blob: a converging group settles without dancing', () => {
    const { m } = run('blob');
    expect(m.stillMoving).toBe(0);
    expect(m.jitterMean).toBeLessThan(0.02);
    expect(m.jitterMax).toBeLessThan(0.1);
    expect(m.endOverlap).toBeLessThan(0.25);
  });
});
