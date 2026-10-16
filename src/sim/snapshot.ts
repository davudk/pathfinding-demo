import {
  H_ALIVE, H_HIGH_WATER, H_MAP_H, H_MAP_W, H_NAV_VERSION, H_PATH_QUEUE, H_PATH_SERVED, H_SYS_BASE, H_SYS_MAX, H_TICK, H_TIME_F64,
  I_ATTRS, I_HANDLE, I_HEADING, I_RADIUS, I_X, I_Y, INST_WORDS, SNAP_HEADER_WORDS,
  packAttrs, type SnapshotViews,
} from '../shared/protocol';
import type { World } from './world';

/** Writes the render snapshot for the current tick. Slot-indexed; empty slots get radius 0. */
export function writeSnapshot(world: World, out: SnapshotViews): void {
  const u = world.units;
  const { i32, f32, u32 } = out;
  const hw = u.highWater;

  i32[H_TICK] = world.tick;
  i32[H_HIGH_WATER] = hw;
  i32[H_ALIVE] = u.count;
  i32[H_MAP_W] = world.mapW;
  i32[H_MAP_H] = world.mapH;
  i32[H_NAV_VERSION] = world.nav.version;
  i32[H_PATH_QUEUE] = world.pathQueue.stats.queued;
  i32[H_PATH_SERVED] = world.pathQueue.stats.served;

  let o = SNAP_HEADER_WORDS;
  for (let i = 0; i < hw; i++, o += INST_WORDS) {
    if (u.alive[i] === 0) {
      f32[o + I_RADIUS] = 0;
      u32[o + I_HANDLE] = 0;
      continue;
    }
    f32[o + I_X] = u.posX[i];
    f32[o + I_Y] = u.posY[i];
    f32[o + I_HEADING] = u.heading[i];
    f32[o + I_RADIUS] = u.radius[i];
    u32[o + I_ATTRS] = packAttrs(u.faction[i], u.archetype[i], u.state[i], u.flags[i]);
    u32[o + I_HANDLE] = u.handleOf(i);
  }
}

/** Copies the last committed per-system timings into the header. */
export function writeTimings(world: World, out: SnapshotViews): void {
  out.f64[H_TIME_F64] = performance.timeOrigin + performance.now();
  const p = world.prof;
  const n = Math.min(p.names.length, H_SYS_MAX);
  for (let s = 0; s < n; s++) out.f32[H_SYS_BASE + s] = p.last(s);
}
