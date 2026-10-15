import { test } from 'vitest';
import { createWorld } from '../../src/sim/world';
import { step } from '../../src/sim/step';
import { writeSnapshot } from '../../src/sim/snapshot';
import { snapshotByteLength, snapshotViews } from '../../src/shared/protocol';

// Run with `npm run bench`.
test('engine shell @ 10k units', async ({ bench }) => {
  const w = createWorld({ name: 'stress', seed: 1, units: 10000 });
  const views = snapshotViews(new ArrayBuffer(snapshotByteLength()));
  await bench.compare(
    bench('step (drift)', () => step(w, [])),
    bench('writeSnapshot', () => writeSnapshot(w, views)),
  );
});
