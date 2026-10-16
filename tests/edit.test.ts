import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { step } from '../src/sim/step';
import { buildingRing } from '../src/sim/map/normalize';
import { pointInRing } from '../src/shared/geometry';
import { MoveState } from '../src/sim/store/units';
import { ArchetypeId } from '../src/shared/archetypes';
import { PathSearch } from '../src/sim/nav/astar';
import { snapToWalkable } from '../src/sim/nav/query';
import { SIM_HZ } from '../src/shared/constants';
import type { BuildingDef } from '../src/shared/mapFormat';

const NOTICE = (w: ReturnType<typeof createWorld>): string[] => w.events.filter((e) => e.type === 'notice').map((e) => (e as { text: string }).text);

describe('runtime edits', () => {
  it('a building dropped on a marching column ejects units and everyone still arrives', () => {
    const w = createWorld({ name: 'drop', seed: 1, units: 0, mapSeed: 1337 }, 512);
    const u = w.units;
    let inside = 0;
    let t = 0;
    for (; t < 60 * SIM_HZ; t++) {
      step(w, []);
      const b = w.map.buildings.find((x) => x.id === 'drop');
      if (b) {
        const ring = buildingRing(b);
        for (let k = 0; k < u.count; k++) {
          const i = u.active[k];
          if (pointInRing(ring, u.posX[i], u.posY[i])) inside++;
        }
      }
      if (t > 100 && Array.from(u.active.subarray(0, u.count)).every((i) => u.state[i] !== MoveState.Moving)) break;
    }
    expect(w.map.buildings.some((b) => b.id === 'drop')).toBe(true);
    expect(inside).toBe(0);
    let near = 0;
    for (let k = 0; k < u.count; k++) {
      const i = u.active[k];
      if (Math.hypot(u.posX[i] - 132, u.posY[i] - 120) < 14) near++;
    }
    expect(near).toBeGreaterThanOrEqual(98);
    expect(w.nav.cdt.validate()).toEqual([]);
  });

  it('a building far from all routes triggers no repaths or field restarts; undo restores the mesh', () => {
    const w = createWorld({ name: 'test', seed: 1, units: 0, mapSeed: 1337 }, 512);
    const hs: number[] = [];
    for (let k = 0; k < 20; k++) hs.push(w.units.spawn(ArchetypeId.Trooper, 0, 40 + (k % 5) * 1.2, 120 + Math.floor(k / 5) * 1.2));
    step(w, [{ kind: 'move', handles: Int32Array.from(hs), x: 120, y: 120 }]);
    for (let t = 0; t < 10; t++) step(w, []);
    const tris = w.nav.stats.triangles;
    // A spot far beyond the field's bounded search (> 250 units from the goal) where a 4×4 fits.
    let def: BuildingDef | null = null;
    for (let y = 300; y < 500 && !def; y += 7) {
      for (let x = 300; x < 500 && !def; x += 7) {
        const d: BuildingDef = { id: 'far', faction: 0, type: 'house', center: [x, y], size: [4, 4], rot: 0 };
        if (!w.map.placement.check(buildingRing(d))) def = d;
      }
    }
    expect(def).not.toBeNull();
    w.events.length = 0;
    step(w, [{ kind: 'placeBuilding', def: def! }]);
    const msg = NOTICE(w).join(' ');
    console.info('[edit notice]', msg);
    expect(msg).toMatch(/0 ejected · 0 repaths · 0 fields restarted/);
    step(w, [{ kind: 'removeBuilding', id: 'far' }]);
    expect(w.nav.cdt.validate()).toEqual([]);
    expect(Math.abs(w.nav.stats.triangles - tris)).toBeLessThanOrEqual(4);
  });

  it('carving a tunnel through a wall shortens routes; removing it restores them; rock ejects units', () => {
    const w = createWorld({ name: 'test', seed: 1, units: 0, mapSeed: 1337 }, 512);
    const search = new PathSearch(w.nav);
    const route = (): number => {
      const a = snapToWalkable(w.nav, 200, 140, 0.375)!, b = snapToWalkable(w.nav, 250, 140, 0.375)!;
      return search.find({ sx: a[0], sy: a[1], gx: b[0], gy: b[1], r: 0.375 })!.length;
    };
    const before = route();
    const tunnel = { id: 'tun', kind: 'rock' as const, op: 'subtract' as const, rings: [[210, 137, 240, 137, 240, 143, 210, 143]] };
    step(w, [{ kind: 'addTerrain', shape: tunnel }]);
    const carved = route();
    expect(carved).toBeLessThan(before - 20);
    expect(w.nav.cdt.validate()).toEqual([]);
    step(w, [{ kind: 'removeTerrain', id: 'tun' }]);
    expect(route()).toBeCloseTo(before, 3);

    // Rock dropped on units: they end up outside it.
    const h = w.units.spawn(ArchetypeId.Tank, 0, 100, 120);
    const rock = { id: 'boulder', kind: 'rock' as const, op: 'add' as const, rings: [[97, 117, 103, 117, 103, 123, 97, 123]] };
    step(w, [{ kind: 'addTerrain', shape: rock }]);
    const i = h & 0xffff;
    const x = w.units.posX[i], y = w.units.posY[i];
    expect(x < 97 - 0.8 || x > 103 + 0.8 || y < 117 - 0.8 || y > 123 + 0.8).toBe(true);
  });
});
