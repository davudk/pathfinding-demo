import { SimSys } from '../shared/profiler';
import type { SimCommand } from '../shared/protocol';
import { spawnRandomUnits } from './scenarios/stress';
import { issueMove, issueStop } from './move/orders';
import { detachField, updateFieldFollowers } from './move/fieldFollow';
import { editTerrain, placeBuilding, removeBuilding, snapBuildingCenter } from './edit';
import type { World } from './world';

function applyCommand(world: World, cmd: SimCommand): void {
  switch (cmd.kind) {
    case 'spawnRandom':
      spawnRandomUnits(world, cmd.count);
      break;
    case 'despawn':
      for (const h of cmd.handles) world.units.despawn(h);
      break;
    case 'placeBuilding': {
      const d = cmd.def;
      const [cx, cy] = snapBuildingCenter(d.center[0], d.center[1], d.size[0], d.size[1]);
      placeBuilding(world, { ...d, center: [cx, cy] });
      break;
    }
    case 'removeBuilding':
      if (!removeBuilding(world, cmd.id)) world.events.push({ type: 'editRejected', id: cmd.id });
      break;
    case 'addTerrain':
      if (editTerrain(world, { add: cmd.shape })) world.events.push({ type: 'editRejected', id: cmd.shape.id });
      break;
    case 'tune':
      if (cmd.key in world.tuning) world.tuning[cmd.key] = cmd.value;
      break;
    case 'removeTerrain':
      if (editTerrain(world, { removeId: cmd.id })) world.events.push({ type: 'editRejected', id: cmd.id });
      break;
    case 'move':
      issueMove(world, cmd.handles, cmd.x, cmd.y, cmd.queue === true);
      break;
    case 'patrol':
      issueMove(world, cmd.handles, cmd.x, cmd.y, cmd.queue === true, true);
      break;
    case 'stop':
      issueStop(world, cmd.handles, false);
      break;
    case 'hold':
      issueStop(world, cmd.handles, true);
      break;
  }
}

/** Path search work per tick, in A* node expansions (≈ 3–4 ms in the worker). */
const PATH_BUDGET_EXPANSIONS = 9_000;
/** Destination-field work per tick, in settled triangles (player group orders go first). */
const FIELD_BUDGET = 24_000;

/** Advances the world by one fixed tick. `commands` were stamped for this tick. */
export function step(world: World, commands: readonly SimCommand[]): void {
  const p = world.prof;
  p.begin(SimSys.Total);

  p.begin(SimSys.Commands);
  while (world.script.length > 0 && world.script[0].tick <= world.tick) applyCommand(world, world.script.shift()!.cmd);
  for (const c of commands) applyCommand(world, c);
  world.brains.think(world);
  p.end(SimSys.Commands);

  p.begin(SimSys.Path);
  world.fields.expandAll(FIELD_BUDGET);
  world.pathQueue.process(world.units, PATH_BUDGET_EXPANSIONS, (slot, ok) => {
    // The unit's goal becomes the (snapped / reachable) end of its path.
    const pts = world.paths.points[slot];
    detachField(world, slot); // an individual path supersedes the field
    if (ok && pts) {
      world.units.goalX[slot] = pts[pts.length - 2];
      world.units.goalY[slot] = pts[pts.length - 1];
    }
  });
  p.end(SimSys.Path);

  p.begin(SimSys.Move);
  p.begin(SimSys.Follow);
  updateFieldFollowers(world);
  p.end(SimSys.Follow);
  world.locomotion.step(world);
  p.end(SimSys.Move);

  world.tick++;
  p.end(SimSys.Total);
}
