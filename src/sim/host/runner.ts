import { SIM_DT_MS } from '../../shared/constants';
import { SimSys } from '../../shared/profiler';
import type { SceneConfig, SimCommand, SnapshotViews } from '../../shared/protocol';
import { createWorld, type World } from '../world';
import { step } from '../step';
import { writeSnapshot, writeTimings } from '../snapshot';

/** Where finished snapshots go: a transfer pool, a shared-memory ring, or the main thread. */
export interface SnapshotSink {
  /** Returns views to write tick `tick` into, or null to skip publishing this tick. */
  acquire(tick: number): SnapshotViews | null;
  commit(tick: number, views: SnapshotViews): void;
}

/** Ticks run per wake-up at most; beyond that, game time slows instead of spiralling. */
const MAX_CATCH_UP = 4;

/**
 * Drives a World at a fixed rate with an accumulator and publishes a snapshot per tick.
 * Host-agnostic: runs inside the sim worker or on the main thread (`?sim=main`).
 */
export class SimRunner {
  readonly world: World;
  private readonly sink: SnapshotSink;
  private pending: SimCommand[] = [];
  private paused = false;
  private timeScale = 1;
  private acc = 0;
  private last = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(scene: SceneConfig, sink: SnapshotSink) {
    this.world = createWorld(scene);
    this.sink = sink;
  }

  start(): void {
    this.last = performance.now();
    this.publish();
    this.schedule(0);
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  enqueue(cmd: SimCommand): void {
    this.pending.push(cmd);
  }

  control(paused?: boolean, timeScale?: number, stepOnce?: boolean): void {
    if (paused !== undefined) this.paused = paused;
    if (timeScale !== undefined) this.timeScale = Math.max(0.05, Math.min(8, timeScale));
    if (stepOnce) this.tickOnce();
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(this.loop, delayMs);
  }

  private readonly loop = (): void => {
    const now = performance.now();
    const elapsed = Math.min(now - this.last, 250);
    this.last = now;
    if (!this.paused) this.acc += elapsed * this.timeScale;
    let n = 0;
    while (this.acc >= SIM_DT_MS && n < MAX_CATCH_UP) {
      this.tickOnce();
      this.acc -= SIM_DT_MS;
      n++;
    }
    if (this.acc >= SIM_DT_MS) this.acc = SIM_DT_MS * 0.5;
    const delay = this.paused ? 16 : Math.max(0, (SIM_DT_MS - this.acc) / this.timeScale);
    this.schedule(delay);
  };

  private tickOnce(): void {
    const cmds = this.pending;
    this.pending = [];
    step(this.world, cmds);
    this.publish();
  }

  private publish(): void {
    const w = this.world;
    const views = this.sink.acquire(w.tick);
    w.prof.begin(SimSys.Snapshot);
    if (views) writeSnapshot(w, views);
    w.prof.end(SimSys.Snapshot);
    w.prof.commit();
    if (views) {
      writeTimings(w, views);
      this.sink.commit(w.tick, views);
    }
  }
}
