/**
 * Deterministic demo/test scenarios: spawns plus a script of commands at given ticks.
 * `stress` (default) is the ambient random scene; the others isolate one behaviour each.
 */
import { ArchetypeId, ARCHETYPES } from '../../shared/archetypes';
import { Faction } from '../../shared/factions';
import type { SimCommand } from '../../shared/protocol';
import { snapToWalkable } from '../nav/query';
import type { World } from '../world';
import { spawnRandomUnits } from './stress';

export interface ScriptedCommand {
  readonly tick: number;
  readonly cmd: SimCommand;
}

export const SCENARIOS = ['stress', 'choke', 'holdline', 'cross', 'blob', 'drop'] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

/** Spawns `count` units of an archetype in a jittered grid filling the rect; returns handles. */
function block(world: World, arch: number, faction: number, x0: number, y0: number, x1: number, y1: number, count: number): number[] {
  const r = ARCHETYPES[arch].radius;
  const pitch = 2 * r + 0.3;
  const cols = Math.max(1, Math.floor((x1 - x0) / pitch));
  const out: number[] = [];
  for (let k = 0; k < count * 4 && out.length < count; k++) {
    const c = k % cols, row = Math.floor(k / cols);
    const x = x0 + (c + 0.5) * pitch + world.rng.range(-0.1, 0.1);
    const y = y0 + (row + 0.5) * pitch + world.rng.range(-0.1, 0.1);
    if (y > y1) break;
    const p = snapToWalkable(world.nav, x, y, r, 0.5);
    if (!p) continue;
    const h = world.units.spawn(arch, faction, p[0], p[1], world.rng.range(-Math.PI, Math.PI));
    if (h) out.push(h);
  }
  return out;
}

export function setupScenario(world: World, name: string, units: number): ScriptedCommand[] {
  const script: ScriptedCommand[] = [];
  const move = (tick: number, handles: number[], x: number, y: number): void => {
    script.push({ tick, cmd: { kind: 'move', handles: Int32Array.from(handles), x, y } });
  };
  switch (name) {
    case 'choke': {
      // 200 small units squeeze through the 4-wide gap of the first chokepoint wall.
      const a = block(world, ArchetypeId.Trooper, Faction.Player, 180, 40, 214, 90, 120);
      const b = block(world, ArchetypeId.Skitter, Faction.Player, 180, 92, 214, 112, 80);
      move(30, [...a, ...b], 262, 64);
      break;
    }
    case 'holdline': {
      // A line of holders across the strip between the walls, with one 1-wide gap.
      const holders: number[] = [];
      const y = 100, r = ARCHETYPES[ArchetypeId.Trooper].radius;
      for (let x = 230 + r; x < 280 - r + 0.01; x += 2 * r) {
        if (Math.abs(x - 255) < 0.5 + r) continue; // the gap: 1 unit + a unit's width
        const p = snapToWalkable(world.nav, x, y, r, 0.6);
        if (!p) continue;
        const h = world.units.spawn(ArchetypeId.Trooper, Faction.Player, p[0], p[1], Math.PI / 2);
        if (h) holders.push(h);
      }
      script.push({ tick: 1, cmd: { kind: 'hold', handles: Int32Array.from(holders) } });
      const movers = block(world, ArchetypeId.Trooper, Faction.Player, 236, 55, 274, 92, 200);
      move(30, movers, 255, 140);
      break;
    }
    case 'cross': {
      // Two armies swap sides through each other inside the main base.
      const blue = block(world, ArchetypeId.Trooper, Faction.Player, 26, 104, 46, 138, 150);
      const red = block(world, ArchetypeId.Trooper, Faction.HostileA, 116, 104, 136, 138, 150);
      move(30, blue, 126, 121);
      move(30, red, 36, 121);
      break;
    }
    case 'blob': {
      // A mixed group converging on one point: tests chain arrival / no dancing.
      const hs = [
        ...block(world, ArchetypeId.Trooper, Faction.Player, 26, 100, 60, 136, 80),
        ...block(world, ArchetypeId.Skitter, Faction.Player, 62, 110, 80, 136, 40),
        ...block(world, ArchetypeId.Tank, Faction.Player, 96, 110, 136, 136, 12),
        ...block(world, ArchetypeId.Behemoth, Faction.Player, 100, 96, 136, 108, 4),
      ];
      move(30, hs, 110, 60);
      break;
    }
    case 'drop': {
      // A column marches east; two seconds in, a 6×6 building lands on it.
      const col = block(world, ArchetypeId.Trooper, Faction.Player, 26, 116, 76, 124, 100);
      move(30, col, 132, 120);
      script.push({ tick: 90, cmd: { kind: 'placeBuilding', def: { id: 'drop', faction: Faction.Neutral, type: 'hall', center: [70, 120], size: [6, 6], rot: 0 } } });
      break;
    }
    default:
      spawnRandomUnits(world, units);
  }
  return script;
}
