import { describe, expect, it } from 'vitest';
import { createWorld, hashWorld } from '../src/sim/world';
import { step } from '../src/sim/step';

function run(seed: number, ticks: number): number {
  const w = createWorld({ name: 'stress', seed, units: 2000 }, 4096);
  for (let t = 0; t < ticks; t++) step(w, t === 50 ? [{ kind: 'spawnRandom', count: 100 }] : []);
  return hashWorld(w);
}

describe('determinism', () => {
  it('same seed and commands produce identical state', () => {
    expect(run(42, 300)).toBe(run(42, 300));
  });

  it('different seeds diverge', () => {
    expect(run(42, 300)).not.toBe(run(43, 300));
  });
});
