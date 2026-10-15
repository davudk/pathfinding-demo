import {
  SAB_CTRL_LATEST, sabSlotOffset, snapshotByteLength, snapshotViews,
  type SnapshotViews,
} from '../../shared/protocol';
import { UNIT_CAPACITY } from '../../shared/constants';
import type { SnapshotSink } from './runner';

/**
 * Transfer transport: a pool of ArrayBuffers ping-ponged with the consumer.
 * When the consumer hasn't returned any buffer, the tick is skipped (renderer copes with gaps).
 */
export class TransferSink implements SnapshotSink {
  private readonly pool: ArrayBuffer[] = [];
  private allocated = 0;

  constructor(
    private readonly send: (tick: number, buffer: ArrayBuffer) => void,
    private readonly maxBuffers = 8,
  ) {}

  giveBack(buffer: ArrayBuffer): void {
    this.pool.push(buffer);
  }

  acquire(): SnapshotViews | null {
    let buf = this.pool.pop();
    if (!buf) {
      if (this.allocated >= this.maxBuffers) return null;
      buf = new ArrayBuffer(snapshotByteLength(UNIT_CAPACITY));
      this.allocated++;
    }
    return snapshotViews(buf);
  }

  commit(tick: number, views: SnapshotViews): void {
    this.send(tick, views.buffer as ArrayBuffer);
  }
}

/**
 * Shared-memory transport: a fixed ring of snapshot slots in one SharedArrayBuffer.
 * The writer fills slot (tick % ring) then publishes `latest = tick` with Atomics.store.
 */
export class SharedRingSink implements SnapshotSink {
  private readonly ctrl: Int32Array;
  private readonly views: SnapshotViews[] = [];

  constructor(private readonly sab: SharedArrayBuffer) {
    this.ctrl = new Int32Array(sab, 0, 16);
    Atomics.store(this.ctrl, SAB_CTRL_LATEST, -1);
  }

  acquire(tick: number): SnapshotViews {
    const off = sabSlotOffset(tick);
    let v = this.views.find((x) => x.i32.byteOffset === off);
    if (!v) {
      v = snapshotViews(this.sab, off);
      this.views.push(v);
    }
    return v;
  }

  commit(tick: number): void {
    Atomics.store(this.ctrl, SAB_CTRL_LATEST, tick);
  }
}
