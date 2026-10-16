import { SIM_DT_MS } from '../../shared/constants';
import { SimSys } from '../../shared/profiler';
import type { FromSim, NavDebugData, SceneConfig, SimCommand, SnapshotViews } from '../../shared/protocol';
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
  /** Units whose paths the client wants (selection); last version / cursor sent per slot. */
  private watched: Int32Array = new Int32Array(0);
  private sentVersion = new Map<number, number>();
  private sentCursor = new Map<number, number>();

  constructor(scene: SceneConfig, sink: SnapshotSink, private readonly emit: (msg: FromSim, transfer?: Transferable[]) => void) {
    this.world = createWorld(scene);
    this.sink = sink;
  }

  /** Navmesh geometry for the debug overlay (radius class `cls`). */
  navDebug(cls: number): void {
    const nav = this.world.nav;
    const d = nav.exportDebug(cls);
    const data: NavDebugData = { version: nav.version, cls, ...d, stats: { ...nav.stats, regions: nav.stats.regions.slice() } };
    this.emit({ type: 'navDebug', data }, [d.edges.buffer, d.tris.buffer, d.region.buffer]);
  }

  watchPaths(handles: Int32Array): void {
    this.watched = handles;
    this.sentVersion.clear();
    this.sentCursor.clear();
    this.emitPaths();
  }

  /** Sends new paths and cursor changes for watched units. */
  private emitPaths(): void {
    if (this.watched.length === 0) return;
    const { units, paths } = this.world;
    const entries: { handle: number; points: Float32Array | null; cursor: number; complete: boolean }[] = [];
    const cleared: number[] = [];
    for (const h of this.watched) {
      if (!units.isValid(h)) continue;
      const i = h & 0xffff;
      const pts = paths.points[i];
      const ver = paths.version[i];
      const prevVer = this.sentVersion.get(h);
      if (!pts) {
        if (prevVer !== undefined && prevVer !== ver) cleared.push(h);
        this.sentVersion.set(h, ver);
        continue;
      }
      const cur = paths.cursor[i];
      if (prevVer !== ver) {
        entries.push({ handle: h, points: Float32Array.from(pts), cursor: cur, complete: paths.complete[i] === 1 });
      } else if (this.sentCursor.get(h) !== cur) {
        entries.push({ handle: h, points: null, cursor: cur, complete: paths.complete[i] === 1 });
      } else continue;
      this.sentVersion.set(h, ver);
      this.sentCursor.set(h, cur);
    }
    if (entries.length || cleared.length) this.emit({ type: 'paths', entries, cleared: Int32Array.from(cleared) });
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
    this.emitPaths();
    const ev = this.world.events;
    if (ev.length) {
      for (const m of ev) this.emit(m);
      ev.length = 0;
    }
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
