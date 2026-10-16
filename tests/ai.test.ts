import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { step } from '../src/sim/step';
import { Brain } from '../src/sim/ai/brains';
import { clearance, snapToWalkable } from '../src/sim/nav/query';
import { MoveState } from '../src/sim/store/units';
import { ArchetypeId } from '../src/shared/archetypes';
import { Faction } from '../src/shared/factions';
import { SIM_HZ } from '../src/shared/constants';

describe('ambient AI', () => {
  it('an ambient world keeps moving, stays out of walls, and keeps its path backlog bounded', { timeout: 120_000 }, () => {
    const w = createWorld({ name: 'stress', seed: 9, units: 2000, mapSeed: 1337 }, 4096);
    const u = w.units;
    const sx = Float64Array.from(u.posX), sy = Float64Array.from(u.posY);
    let wallPen = 0, maxQueue = 0;
    for (let t = 0; t < 60 * SIM_HZ; t++) {
      step(w, []);
      maxQueue = Math.max(maxQueue, w.pathQueue.size);
      if (t % 60 === 0) {
        for (let k = 0; k < u.count; k++) {
          const i = u.active[k];
          wallPen = Math.max(wallPen, u.radius[i] - clearance(w.nav, u.posX[i], u.posY[i], u.radius[i] + 0.1).dist);
        }
      }
    }
    let wanderers = 0, travelled = 0;
    for (let k = 0; k < u.count; k++) {
      const i = u.active[k];
      if (w.brains.kind[i] !== Brain.Wander) continue;
      wanderers++;
      if (Math.hypot(u.posX[i] - sx[i], u.posY[i] - sy[i]) > 4) travelled++;
    }
    // Herds stay together.
    const spreads: number[] = [];
    for (const herd of w.brains.herds) {
      if (!u.isValid(herd.leader)) continue;
      const li = herd.leader & 0xffff;
      for (const h of herd.members) {
        const i = h & 0xffff;
        spreads.push(Math.hypot(u.posX[i] - u.posX[li], u.posY[i] - u.posY[li]) / herd.radius);
      }
    }
    spreads.sort((a, b) => a - b);
    const medianSpread = spreads[spreads.length >> 1];
    const search = w.pathQueue.search;
    console.info(`[ambient] ${u.count} units · wanderers moved ${travelled}/${wanderers} · max path queue ${maxQueue} · wallPen ${wallPen.toFixed(3)} · herd median spread ${medianSpread.toFixed(2)}·R · cache ${search.cacheHits}/${search.cacheHits + search.cacheMisses}`);
    expect(travelled / wanderers).toBeGreaterThan(0.8);
    expect(maxQueue).toBeLessThan(400);
    expect(wallPen).toBeLessThan(0.05);
    expect(medianSpread).toBeLessThan(2.5);
    expect(search.cacheHits).toBeGreaterThan(0);
  });

  it('a player order overrides the brain, which waits before taking over again', () => {
    const w = createWorld({ name: 'empty', seed: 1, units: 0, mapSeed: 1337 }, 64);
    const p = snapToWalkable(w.nav, 100, 120, 0.375)!;
    const h = w.units.spawn(ArchetypeId.Trooper, Faction.HostileA, p[0], p[1]);
    const i = h & 0xffff;
    w.brains.assign(w, h, Brain.Wander, { radius: 8 });
    for (let t = 0; t < 5 * SIM_HZ; t++) step(w, []);
    step(w, [{ kind: 'move', handles: Int32Array.of(h), x: 60, y: 120 }]);
    let arrivedAt = -1;
    for (let t = 0; t < 30 * SIM_HZ; t++) {
      step(w, []);
      if (arrivedAt < 0 && w.units.state[i] !== MoveState.Moving) arrivedAt = w.tick;
    }
    // It went where the player said and is still there (the brain is in its quiet period, then wanders near the new home).
    expect(arrivedAt).toBeGreaterThan(0);
    expect(Math.hypot(w.units.posX[i] - 60, w.units.posY[i] - 120)).toBeLessThan(10);
    expect(Math.hypot(w.brains.homeX[i] - 60, w.brains.homeY[i] - 120)).toBeLessThan(2);
  });

  it('critters scatter from a marching unit instead of being pushed', () => {
    const w = createWorld({ name: 'empty', seed: 1, units: 0, mapSeed: 1337 }, 64);
    const critters: number[] = [];
    for (let k = 0; k < 6; k++) critters.push(w.units.spawn(ArchetypeId.Critter, Faction.Neutral, 90 + k * 0.6, 120));
    const tank = w.units.spawn(ArchetypeId.Tank, Faction.Player, 70, 120);
    step(w, [{ kind: 'move', handles: Int32Array.of(tank), x: 115, y: 120 }]);
    let minGap = Infinity;
    for (let t = 0; t < 15 * SIM_HZ; t++) {
      step(w, []);
      const ti = tank & 0xffff;
      for (const c of critters) {
        const i = c & 0xffff;
        minGap = Math.min(minGap, Math.hypot(w.units.posX[i] - w.units.posX[ti], w.units.posY[i] - w.units.posY[ti]) - w.units.radius[i] - w.units.radius[ti]);
      }
    }
    expect(Math.hypot(w.units.posX[tank & 0xffff] - 115, w.units.posY[tank & 0xffff] - 120)).toBeLessThan(1.5);
    expect(minGap).toBeGreaterThan(-0.05);
  });
});
