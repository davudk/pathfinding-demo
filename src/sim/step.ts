import { SimSys } from '../shared/profiler';
import type { SimCommand } from '../shared/protocol';
import { spawnRandomUnits } from './scenarios/stress';
import { driftUnits } from './move/drift';
import { followPaths } from './move/follow';
import { MoveState, UNIT_FLAG_DRIFT } from './store/units';
import { handleIndex } from '../shared/handles';
import { placeBuilding, removeBuildingAt } from './edit';
import type { World } from './world';

function applyCommand(world: World, cmd: SimCommand): void {
  switch (cmd.kind) {
    case 'spawnRandom':
      spawnRandomUnits(world, cmd.count);
      break;
    case 'despawn':
      for (const h of cmd.handles) world.units.despawn(h);
      break;
    case 'placeBuilding':
      placeBuilding(world, cmd.x, cmd.y, cmd.w, cmd.h, cmd.faction, cmd.type);
      break;
    case 'removeBuildingAt':
      removeBuildingAt(world, cmd.x, cmd.y);
      break;
    case 'move': {
      const u = world.units;
      for (const h of cmd.handles) {
        if (!u.isValid(h)) continue;
        const i = handleIndex(h);
        u.flags[i] &= ~UNIT_FLAG_DRIFT;
        u.state[i] = MoveState.Moving;
        world.pathQueue.request(h, cmd.x, cmd.y);
      }
      break;
    }
  }
}

/** Path search time per tick (player orders get served first in M5+). */
const PATH_BUDGET_MS = 4;

/** Advances the world by one fixed tick. `commands` were stamped for this tick. */
export function step(world: World, commands: readonly SimCommand[]): void {
  const p = world.prof;
  p.begin(SimSys.Total);

  p.begin(SimSys.Commands);
  for (const c of commands) applyCommand(world, c);
  p.end(SimSys.Commands);

  p.begin(SimSys.Path);
  world.pathQueue.process(world.units, PATH_BUDGET_MS, () => {});
  p.end(SimSys.Path);

  p.begin(SimSys.Move);
  followPaths(world);
  driftUnits(world);
  p.end(SimSys.Move);

  world.tick++;
  p.end(SimSys.Total);
}
