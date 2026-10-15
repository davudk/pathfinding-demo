import { describe, expect, it } from 'vitest';
import { UnitStore } from '../src/sim/store/units';
import { handleGen, handleIndex, NULL_HANDLE } from '../src/shared/handles';
import { ArchetypeId } from '../src/shared/archetypes';
import { Rng } from '../src/shared/rng';

describe('UnitStore', () => {
  it('spawns with valid handles and keeps the dense active list consistent', () => {
    const s = new UnitStore(64);
    const hs = Array.from({ length: 10 }, (_, k) => s.spawn(ArchetypeId.Trooper, 0, k, k));
    expect(s.count).toBe(10);
    for (const h of hs) expect(s.isValid(h)).toBe(true);
    expect(s.despawn(hs[3])).toBe(true);
    expect(s.isValid(hs[3])).toBe(false);
    expect(s.despawn(hs[3])).toBe(false);
    expect(s.count).toBe(9);
    const live = new Set(Array.from(s.active.subarray(0, s.count)));
    expect(live.has(handleIndex(hs[3]))).toBe(false);
    for (let k = 0; k < s.count; k++) expect(s.denseIndex[s.active[k]]).toBe(k);
  });

  it('reuses slots with a new generation so stale handles stay invalid', () => {
    const s = new UnitStore(4);
    const a = s.spawn(ArchetypeId.Tank, 1, 0, 0);
    s.despawn(a);
    const b = s.spawn(ArchetypeId.Tank, 1, 0, 0);
    expect(handleIndex(b)).toBe(handleIndex(a));
    expect(handleGen(b)).not.toBe(handleGen(a));
    expect(s.isValid(a)).toBe(false);
    expect(s.isValid(b)).toBe(true);
  });

  it('returns NULL_HANDLE when full and survives random churn', () => {
    const s = new UnitStore(32);
    const rng = new Rng(7);
    const live: number[] = [];
    for (let step = 0; step < 5000; step++) {
      if (live.length > 0 && rng.float() < 0.45) {
        const k = rng.int(live.length);
        expect(s.despawn(live[k])).toBe(true);
        live.splice(k, 1);
      } else {
        const h = s.spawn(ArchetypeId.Critter, 4, 1, 1);
        if (live.length === 32) expect(h).toBe(NULL_HANDLE);
        else live.push(h);
      }
      expect(s.count).toBe(live.length);
    }
    for (const h of live) expect(s.isValid(h)).toBe(true);
  });
});
