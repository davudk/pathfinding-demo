import { SimSys } from '../shared/profiler';
import type { SimCommand } from '../shared/protocol';
import { spawnRandomUnits } from './scenarios/stress';
import { driftUnits } from './move/drift';
import type { World } from './world';

function applyCommand(world: World, cmd: SimCommand): void {
  switch (cmd.kind) {
    case 'spawnRandom':
      spawnRandomUnits(world, cmd.count);
      break;
    case 'despawn':
      for (const h of cmd.handles) world.units.despawn(h);
      break;
  }
}

/** Advances the world by one fixed tick. `commands` were stamped for this tick. */
export function step(world: World, commands: readonly SimCommand[]): void {
  const p = world.prof;
  p.begin(SimSys.Total);

  p.begin(SimSys.Commands);
  for (const c of commands) applyCommand(world, c);
  p.end(SimSys.Commands);

  p.begin(SimSys.Move);
  driftUnits(world);
  p.end(SimSys.Move);

  world.tick++;
  p.end(SimSys.Total);
}
