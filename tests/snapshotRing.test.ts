import { describe, expect, it } from 'vitest';
import { SnapshotRing, type Snapshot } from '../src/app/snapshotRing';
import { H_TICK, snapshotByteLength } from '../src/shared/protocol';

function buf(tick: number): ArrayBuffer {
  const b = new ArrayBuffer(snapshotByteLength(16));
  new Int32Array(b)[H_TICK] = tick;
  return b;
}

describe('SnapshotRing', () => {
  it('brackets render time and evicts the oldest buffers', () => {
    const evicted: number[] = [];
    const ring = new SnapshotRing(3, (b) => evicted.push(new Int32Array(b)[H_TICK]));
    for (const t of [1, 2, 3, 4]) ring.push(buf(t));
    expect(evicted).toEqual([1]);
    const out: { a: Snapshot | null; b: Snapshot | null; alpha: number } = { a: null, b: null, alpha: 0 };
    ring.bracket(2.25, out);
    expect(out.a?.tick).toBe(2);
    expect(out.b?.tick).toBe(3);
    expect(out.alpha).toBeCloseTo(0.25);
    ring.bracket(9, out);
    expect(out.a?.tick).toBe(4);
    expect(out.b?.tick).toBe(4);
  });

  it('interpolates across gaps and rejects stale ticks', () => {
    const evicted: number[] = [];
    const ring = new SnapshotRing(4, (b) => evicted.push(new Int32Array(b)[H_TICK]));
    ring.push(buf(10));
    ring.push(buf(14));
    ring.push(buf(12));
    expect(evicted).toEqual([12]);
    const out: { a: Snapshot | null; b: Snapshot | null; alpha: number } = { a: null, b: null, alpha: 0 };
    ring.bracket(11, out);
    expect(out.a?.tick).toBe(10);
    expect(out.b?.tick).toBe(14);
    expect(out.alpha).toBeCloseTo(0.25);
  });
});
