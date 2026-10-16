import {
  H_HIGH_WATER, H_TICK, INST_BYTES, SAB_CTRL_LATEST, SAB_RING, SNAP_HEADER_BYTES,
  sabByteLength, sabSlotOffset, snapshotByteLength, snapshotViews,
  type FromSim, type MapRenderData, type SceneConfig, type SimCommand, type SnapshotViews, type ToSim,
} from '../shared/protocol';
import { SimRunner, type SnapshotSink } from '../sim/host/runner';
import { mapRenderData } from '../sim/map/worldMap';
import { SnapshotRing } from './snapshotRing';

export type SimHostMode = 'worker-sab' | 'worker-transfer' | 'main';

export interface SimReady {
  readonly mapW: number;
  readonly mapH: number;
  readonly map: MapRenderData;
}

export interface SimHost {
  readonly mode: SimHostMode;
  readonly ring: SnapshotRing;
  readonly ready: Promise<SimReady>;
  command(cmd: SimCommand): void;
  control(c: { paused?: boolean; timeScale?: number; step?: boolean }): void;
  /** Requests navmesh debug geometry; arrives as a 'navDebug' event. */
  requestNavDebug(cls: number): void;
  /** Subscribes to path updates of these units (arrive as 'paths' events). */
  watchPaths(handles: Int32Array): void;
  /** Requests destination-field arrows (arrive as a 'fieldDebug' event). */
  requestFieldDebug(): void;
  /** Requests the current map as JSON (arrives as a 'mapJson' event). */
  requestMapJson(): void;
  /** Receives sim events (buildings changed, notices, debug data). */
  onEvent: (msg: FromSim) => void;
  /** Pulls new snapshots (shared-memory mode); no-op otherwise. Call once per frame. */
  poll(): void;
}

const RING_CAPACITY = 6;

/**
 * Picks the best available host: a worker with shared-memory snapshots when the page is
 * cross-origin isolated, else a worker with transferable buffers. `?sim=main` forces the
 * main thread; `?transport=transfer` forces the fallback transport.
 */
export function createSimHost(scene: SceneConfig, opts: { main: boolean; forceTransfer: boolean }): SimHost {
  if (opts.main) return createMainThreadHost(scene);
  return createWorkerHost(scene, globalThis.crossOriginIsolated === true && !opts.forceTransfer);
}

function createWorkerHost(scene: SceneConfig, useSab: boolean): SimHost {
  const worker = new Worker(new URL('../sim/sim.worker.ts', import.meta.url), { type: 'module', name: 'sim' });
  const post = (m: ToSim, transfer: Transferable[] = []): void => worker.postMessage(m, transfer);

  let ring: SnapshotRing;
  let poll = (): void => {};

  if (useSab) {
    const sab = new SharedArrayBuffer(sabByteLength());
    const ctrl = new Int32Array(sab, 0, 16);
    Atomics.store(ctrl, SAB_CTRL_LATEST, -1);
    const pool: ArrayBuffer[] = [];
    ring = new SnapshotRing(RING_CAPACITY, (b) => pool.push(b));
    let pulled = -1;
    poll = () => {
      const latest = Atomics.load(ctrl, SAB_CTRL_LATEST);
      if (latest <= pulled) return;
      for (let t = Math.max(pulled + 1, latest - SAB_RING + 2); t <= latest; t++) {
        const off = sabSlotOffset(t);
        const src = snapshotViews(sab, off);
        const len = SNAP_HEADER_BYTES + Math.max(0, src.i32[H_HIGH_WATER]) * INST_BYTES;
        const buf = pool.pop() ?? new ArrayBuffer(snapshotByteLength());
        new Uint8Array(buf, 0, len).set(new Uint8Array(sab, off, len));
        // Seqlock-style validation: the slot must still hold tick t after the copy.
        if (new Int32Array(buf, 0, 1)[H_TICK] !== t || src.i32[H_TICK] !== t) {
          pool.push(buf);
          continue;
        }
        ring.push(buf);
      }
      pulled = latest;
    };
    post({ type: 'init', scene, transport: 'sab', sab });
  } else {
    ring = new SnapshotRing(RING_CAPACITY, (buffer) => post({ type: 'returnBuffer', buffer }, [buffer]));
    post({ type: 'init', scene, transport: 'transfer' });
  }

  const ready = new Promise<SimReady>((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<FromSim>) => {
      const msg = ev.data;
      switch (msg.type) {
        case 'ready':
          resolve({ mapW: msg.mapW, mapH: msg.mapH, map: msg.map });
          break;
        case 'snapshot':
          ring.push(msg.buffer);
          break;
        case 'buildings':
        case 'notice':
        case 'navDebug':
        case 'paths':
        case 'fieldDebug':
        case 'terrain':
        case 'editRejected':
        case 'mapJson':
          host.onEvent(msg);
          break;
        case 'error':
          console.error('[sim worker]', msg.message);
          reject(new Error(msg.message));
          break;
      }
    };
    worker.onerror = (e) => {
      console.error('[sim worker]', e.message);
      reject(new Error(e.message));
    };
  });

  const host: SimHost = {
    mode: useSab ? 'worker-sab' : 'worker-transfer',
    ring,
    ready,
    command: (cmd) => post({ type: 'command', cmd }),
    control: (c) => post({ type: 'control', ...c }),
    requestNavDebug: (cls) => post({ type: 'debugNavmesh', cls }),
    watchPaths: (handles) => post({ type: 'watchPaths', handles }),
    requestFieldDebug: () => post({ type: 'debugFields' }),
    requestMapJson: () => post({ type: 'exportMap' }),
    onEvent: () => {},
    poll: () => poll(),
  };
  return host;
}

function createMainThreadHost(scene: SceneConfig): SimHost {
  const pool: ArrayBuffer[] = [];
  const ring = new SnapshotRing(RING_CAPACITY, (b) => pool.push(b));
  const sink: SnapshotSink = {
    acquire: (): SnapshotViews => snapshotViews(pool.pop() ?? new ArrayBuffer(snapshotByteLength())),
    commit: (_tick, views) => ring.push(views.buffer as ArrayBuffer),
  };
  const runner: SimRunner = new SimRunner(scene, sink, (msg) => queueMicrotask(() => host.onEvent(msg)));
  runner.start();
  const host: SimHost = {
    mode: 'main',
    ring,
    ready: Promise.resolve({ mapW: runner.world.mapW, mapH: runner.world.mapH, map: mapRenderData(runner.world.map) }),
    command: (cmd) => runner.enqueue(cmd),
    control: (c) => runner.control(c.paused, c.timeScale, c.step),
    requestNavDebug: (cls) => runner.navDebug(cls),
    watchPaths: (handles) => runner.watchPaths(handles),
    requestFieldDebug: () => runner.fieldDebug(),
    requestMapJson: () => runner.exportMap(),
    onEvent: () => {},
    poll: () => {},
  };
  return host;
}
