import { UNIT_CAPACITY, DEFAULT_MAP_SIZE } from '../shared/constants';
import { generateMap } from './map/generate';
import { loadWorldMap, type WorldMap } from './map/worldMap';
import { Rng } from '../shared/rng';
import { Profiler, SIM_SYSTEM_NAMES } from '../shared/profiler';
import type { FromSim, SceneConfig } from '../shared/protocol';
import { NavMesh } from './nav/navmesh';
import { PathQueue, PathStore } from './nav/pathQueue';
import { UnitStore } from './store/units';
import { spawnRandomUnits } from './scenarios/stress';

export interface World {
  tick: number;
  readonly mapW: number;
  readonly mapH: number;
  readonly rng: Rng;
  readonly units: UnitStore;
  readonly map: WorldMap;
  readonly nav: NavMesh;
  readonly paths: PathStore;
  readonly pathQueue: PathQueue;
  /** Messages for the main thread, flushed by the runner after each tick. */
  readonly events: FromSim[];
  readonly prof: Profiler;
}

export function createWorld(scene: SceneConfig, capacity = UNIT_CAPACITY): World {
  const gen = generateMap(scene.mapSeed, DEFAULT_MAP_SIZE);
  const map = loadWorldMap(gen.map, gen.mainPoint);
  const nav = NavMesh.build(map.width, map.height, map.terrain, map.buildingRings);
  const paths = new PathStore(capacity);
  const world: World = {
    tick: 0,
    mapW: map.width,
    mapH: map.height,
    rng: new Rng(scene.seed),
    units: new UnitStore(capacity),
    map,
    nav,
    paths,
    pathQueue: new PathQueue(nav, capacity, paths),
    events: [],
    prof: new Profiler(SIM_SYSTEM_NAMES, 120),
  };
  spawnRandomUnits(world, scene.units);
  return world;
}

/** Order-independent-ish hash of the full kinematic state, for determinism tests. */
export function hashWorld(world: World): number {
  const u = world.units;
  let h = 2166136261 >>> 0;
  const f = new Float64Array(1);
  const w = new Uint32Array(f.buffer);
  for (let k = 0; k < u.count; k++) {
    const i = u.active[k];
    for (const v of [u.posX[i], u.posY[i], u.velX[i], u.velY[i], u.heading[i]]) {
      f[0] = v;
      h = Math.imul(h ^ w[0], 16777619) >>> 0;
      h = Math.imul(h ^ w[1], 16777619) >>> 0;
    }
  }
  return (h ^ world.rng.stateHash() ^ world.tick) >>> 0;
}
