import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { step } from '../src/sim/step';
import { clearance } from '../src/sim/nav/query';
import { MoveState } from '../src/sim/store/units';
import { SIM_HZ } from '../src/shared/constants';

function run(name: string, seconds: number): { w: World; wallPen: number; moving: number } {
  const w = createWorld({ name, seed: 5, units: 0, mapSeed: 1337 }, 4096);
  const u = w.units;
  let wallPen = 0;
  for (let t = 0; t < seconds * SIM_HZ; t++) {
    step(w, []);
    if (t % 30 === 0) {
      for (let k = 0; k < u.count; k++) {
        const i = u.active[k];
        wallPen = Math.max(wallPen, u.radius[i] - clearance(w.nav, u.posX[i], u.posY[i], u.radius[i] + 0.1).dist);
      }
    }
  }
  let moving = 0;
  for (let k = 0; k < u.count; k++) if (u.state[u.active[k]] === MoveState.Moving) moving++;
  return { w, wallPen, moving };
}

describe('showcase scenarios', () => {
  it('trap: units go around the U and end up inside its pocket', { timeout: 60_000 }, () => {
    const { w, wallPen } = run('trap', 60);
    expect(wallPen).toBeLessThan(0.05);
    let inside = 0;
    for (const h of w.initialSelect) {
      const i = h & 0xffff;
      if (w.units.posY[i] > 380 && w.units.posY[i] < 463 && w.units.posX[i] > 197 && w.units.posX[i] < 253) inside++;
    }
    expect(inside / w.initialSelect.length).toBeGreaterThan(0.9);
  });

  it('canyon: small units take the throat, big ones never squeeze through it', { timeout: 120_000 }, () => {
    const { w, wallPen } = run('canyon', 90);
    expect(wallPen).toBeLessThan(0.05);
    // Nobody with r > 0.74 is ever inside the 1.5-wide throat region (≈ x 420–440 of the canyon).
    for (const h of w.initialSelect) {
      const i = h & 0xffff;
      if (w.units.radius[i] <= 0.625) continue;
      const pts = w.paths.points[i];
      if (!pts) continue;
      for (let k = 0; k < pts.length; k += 2) {
        const x = pts[k], y = pts[k + 1];
        const inThroat = x > 425 && x < 437 && y > 170 && y < 340 && Math.abs(y - 170 - 45 - (x - 338) / 176 * 80 - Math.sin(((x - 338) / 176) * Math.PI * 3) * 22) < 4;
        expect(inThroat, `r=${w.units.radius[i]} path through the throat at ${x.toFixed(1)},${y.toFixed(1)}`).toBe(false);
      }
    }
  });

  for (const name of ['maze', 'town', 'queue']) {
    it(`${name}: runs clean`, { timeout: 120_000 }, () => {
      const { wallPen } = run(name, 45);
      expect(wallPen).toBeLessThan(0.05);
    });
  }
});
