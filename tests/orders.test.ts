import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { step } from '../src/sim/step';
import { magicBox } from '../src/sim/move/orders';
import { ArchetypeId } from '../src/shared/archetypes';
import { MoveState } from '../src/sim/store/units';

function world(): World {
  return createWorld({ name: 'test', seed: 2, units: 0, mapSeed: 1337 }, 512);
}

describe('magic box', () => {
  const w = world();
  const slots = [0, 1, 2].map((k) => w.units.spawn(ArchetypeId.Trooper, 0, 100 + k * 2, 120) & 0xffff);
  const bases = [100, 120, 102, 120, 104, 120];

  it('keeps formation when the click is outside the group box', () => {
    const t = magicBox(w, slots, bases, 120, 60);
    expect(Array.from(t)).toEqual([118, 60, 120, 60, 122, 60]);
  });

  it('converges when the click is inside the group box', () => {
    const t = magicBox(w, slots, bases, 102, 120);
    expect(Array.from(t)).toEqual([102, 120, 102, 120, 102, 120]);
  });

  it('compresses spread-out groups', () => {
    const t = magicBox(w, slots, [60, 120, 100, 120, 140, 120], 100, 30);
    expect(Math.abs(t[0] - t[4])).toBeLessThan(15);
  });
});

describe('queues and patrol', () => {
  it('shift-queued moves are visited in order', () => {
    const w = world();
    const h = w.units.spawn(ArchetypeId.Walker, 0, 100, 120);
    const i = h & 0xffff;
    const hs = Int32Array.of(h);
    step(w, [{ kind: 'move', handles: hs, x: 120, y: 120 }, { kind: 'move', handles: hs, x: 120, y: 100, queue: true }]);
    expect(w.queues.len[i]).toBe(2);
    let visitedFirst = false;
    for (let t = 0; t < 30 * 30 && w.units.state[i] === MoveState.Moving; t++) {
      step(w, []);
      if (Math.hypot(w.units.posX[i] - 120, w.units.posY[i] - 120) < 0.5) visitedFirst = true;
    }
    expect(visitedFirst).toBe(true);
    expect(Math.hypot(w.units.posX[i] - 120, w.units.posY[i] - 100)).toBeLessThan(0.5);
    expect(w.queues.len[i]).toBe(0);
  });

  it('patrol cycles between the start and the target until stopped', () => {
    const w = world();
    const h = w.units.spawn(ArchetypeId.Walker, 0, 100, 120);
    const i = h & 0xffff;
    step(w, [{ kind: 'patrol', handles: Int32Array.of(h), x: 125, y: 120 }]);
    let atB = 0, atA = 0, wasAtB = false;
    for (let t = 0; t < 30 * 40; t++) {
      step(w, []);
      const dB = Math.hypot(w.units.posX[i] - 125, w.units.posY[i] - 120);
      const dA = Math.hypot(w.units.posX[i] - 100, w.units.posY[i] - 120);
      if (dB < 0.5 && !wasAtB) {
        atB++;
        wasAtB = true;
      }
      if (dA < 0.5 && wasAtB) {
        atA++;
        wasAtB = false;
      }
    }
    expect(atB).toBeGreaterThanOrEqual(3);
    expect(atA).toBeGreaterThanOrEqual(2);
    expect(w.units.state[i]).toBe(MoveState.Moving);
    step(w, [{ kind: 'stop', handles: Int32Array.of(h) }]);
    expect(w.queues.len[i]).toBe(0);
    expect(w.units.state[i]).toBe(MoveState.Idle);
    expect(w.orders.size).toBe(0);
  });
});
