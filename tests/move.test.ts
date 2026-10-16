import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { step } from '../src/sim/step';
import { ArchetypeId, ARCHETYPES } from '../src/shared/archetypes';
import { clearance, snapToWalkable } from '../src/sim/nav/query';
import { CLEARANCE_TOLERANCE } from '../src/sim/nav/astar';
import { MoveState } from '../src/sim/store/units';

describe('move orders', () => {
  it('units of every size reach their goals without entering obstacles', () => {
    const w = createWorld({ name: 'test', seed: 1, units: 0, mapSeed: 1337 }, 256);
    const archs = [ArchetypeId.Skitter, ArchetypeId.Walker, ArchetypeId.Tank, ArchetypeId.Behemoth, ArchetypeId.Colossal];
    const handles: number[] = [];
    archs.forEach((a, k) => {
      const r = ARCHETYPES[a].radius;
      const p = snapToWalkable(w.nav, 70 + k * 6, 100, r)!;
      handles.push(w.units.spawn(a, 0, p[0], p[1]));
    });
    const goal: [number, number] = [210, 64]; // through the ramp, into the chokepoint field
    step(w, [{ kind: 'move', handles: Int32Array.from(handles), x: goal[0], y: goal[1] }]);
    let worst = Infinity;
    for (let t = 0; t < 30 * 90 && handles.some((h) => w.units.state[h & 0xffff] === MoveState.Moving); t++) {
      step(w, []);
      for (const h of handles) {
        const i = h & 0xffff;
        const r = w.units.radius[i];
        worst = Math.min(worst, clearance(w.nav, w.units.posX[i], w.units.posY[i], r + 1).dist - r);
      }
    }
    expect(worst).toBeGreaterThanOrEqual(-CLEARANCE_TOLERANCE);
    for (const h of handles) {
      const i = h & 0xffff;
      expect(w.units.state[i]).not.toBe(MoveState.Moving);
      // Everyone settles around the goal, within about the group's packing radius.
      const r2 = archs.reduce((s, a) => s + ARCHETYPES[a].radius ** 2, 0);
      const groupR = Math.sqrt(r2 / 0.75);
      expect(Math.hypot(w.units.posX[i] - goal[0], w.units.posY[i] - goal[1])).toBeLessThan(2 * groupR + 2);
    }
  });
});
