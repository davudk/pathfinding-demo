import { UNIT_CAPACITY, DEFAULT_MAP_SIZE } from '../shared/constants';
import { generateMap } from './map/generate';
import { parseMap } from '../shared/mapFormat';
import { loadWorldMap, type WorldMap } from './map/worldMap';
import { Rng } from '../shared/rng';
import { Profiler, SIM_SYSTEM_NAMES } from '../shared/profiler';
import type { FromSim, SceneConfig } from '../shared/protocol';
import { NavMesh } from './nav/navmesh';
import { PathQueue, PathStore } from './nav/pathQueue';
import { FieldRegistry } from './nav/field';
import { OrderQueues, Orders } from './move/orders';
import { Locomotion } from './move/locomotion';
import { UnitGrid } from './spatial/grid';
import { WallGrid } from './spatial/wallGrid';
import { UnitStore } from './store/units';
import { setupScenario, type ScriptedCommand } from './scenarios';

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
  readonly fields: FieldRegistry;
  readonly orders: Orders;
  readonly queues: OrderQueues;
  readonly grid: UnitGrid;
  readonly walls: WallGrid;
  readonly locomotion: Locomotion;
  /** Scenario commands waiting for their tick. */
  script: ScriptedCommand[];
  /** Messages for the main thread, flushed by the runner after each tick. */
  readonly events: FromSim[];
  readonly prof: Profiler;
}

export function createWorld(scene: SceneConfig, capacity = UNIT_CAPACITY): World {
  let map;
  if (scene.mapJson) {
    map = loadWorldMap(parseMap(scene.mapJson));
  } else {
    const gen = generateMap(scene.mapSeed, DEFAULT_MAP_SIZE);
    map = loadWorldMap(gen.map, gen.mainPoint);
  }
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
    fields: new FieldRegistry(nav),
    orders: new Orders(),
    queues: new OrderQueues(capacity),
    grid: new UnitGrid(map.width, map.height, 2, capacity),
    walls: new WallGrid(map.width, map.height),
    locomotion: new Locomotion(capacity),
    script: [],
    events: [],
    prof: new Profiler(SIM_SYSTEM_NAMES, 120),
  };
  world.walls.rebuild(nav);
  world.script = setupScenario(world, scene.name, scene.units);
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
