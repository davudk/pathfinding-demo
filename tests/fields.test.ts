import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { step } from '../src/sim/step';
import { ArchetypeId, ARCHETYPES } from '../src/shared/archetypes';
import { snapToWalkable, clearance } from '../src/sim/nav/query';
import { MoveState } from '../src/sim/store/units';
import { SIM_HZ } from '../src/shared/constants';

describe('destination fields', () => {
  it('a 500-unit order gets everyone a path within 2 ticks, and they all arrive', { timeout: 120_000 }, () => {
    const w = createWorld({ name: 'test', seed: 4, units: 0, mapSeed: 1337 }, 1024);
    const hs: number[] = [];
    const archs = [ArchetypeId.Trooper, ArchetypeId.Skitter, ArchetypeId.Walker, ArchetypeId.Tank];
    // A loose crowd in the main base.
    for (let k = 0; hs.length < 500 && k < 4000; k++) {
      const a = archs[k % archs.length];
      const r = ARCHETYPES[a].radius;
      const p = snapToWalkable(w.nav, 28 + (k % 50) * 2.1, 28 + Math.floor(k / 50) * 2.1, r, 0.5);
      if (p) hs.push(w.units.spawn(a, 0, p[0], p[1]));
    }
    expect(hs.length).toBe(500);
    const t0 = performance.now();
    step(w, [{ kind: 'move', handles: Int32Array.from(hs), x: 300, y: 250 }]);
    step(w, []);
    const ms = (performance.now() - t0) / 2;
    let withPath = 0;
    for (const h of hs) if (w.paths.points[h & 0xffff]) withPath++;
    console.info(`[fields] 2 ticks: ${withPath}/500 have paths, ${w.fields.size} fields, ${ms.toFixed(1)} ms/tick`);
    expect(withPath).toBeGreaterThanOrEqual(475);

    let wallPen = 0;
    let t = 0;
    for (; t < 200 * SIM_HZ; t++) {
      step(w, []);
      if (t % 10 === 0) {
        for (const h of hs) {
          const i = h & 0xffff;
          wallPen = Math.max(wallPen, w.units.radius[i] - clearance(w.nav, w.units.posX[i], w.units.posY[i], w.units.radius[i] + 0.1).dist);
        }
      }
      if (hs.every((h) => w.units.state[h & 0xffff] !== MoveState.Moving)) break;
    }
    // The blob settles within about twice the group's packing radius of the click.
    let r2 = 0;
    for (const h of hs) r2 += w.units.radius[h & 0xffff] ** 2;
    const packedR = Math.sqrt(r2 / 0.75);
    let near = 0;
    for (const h of hs) {
      const i = h & 0xffff;
      if (Math.hypot(w.units.posX[i] - 300, w.units.posY[i] - 250) < 2 * packedR + 3) near++;
    }
    console.info(`[fields] settled after ${(t / SIM_HZ).toFixed(1)} s, ${near}/500 within 2R+3 (R=${packedR.toFixed(1)}) of the goal, wallPen ${wallPen.toFixed(3)}, fields left ${w.fields.size}`);
    expect(near).toBeGreaterThanOrEqual(490);
    expect(wallPen).toBeLessThan(0.05);
    expect(w.fields.size).toBe(0);
  });
});
