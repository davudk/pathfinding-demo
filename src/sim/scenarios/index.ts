/**
 * Deterministic demo/test scenarios: spawns plus a script of commands at given ticks.
 * `stress` (default) is the ambient random scene; the others isolate one behaviour each.
 */
import { ArchetypeId, ARCHETYPES } from '../../shared/archetypes';
import { Faction } from '../../shared/factions';
import type { SimCommand } from '../../shared/protocol';
import { snapToWalkable } from '../nav/query';
import type { World } from '../world';
import { spawnFromMap, spawnRandomUnits } from './stress';

export interface ScriptedCommand {
  readonly tick: number;
  readonly cmd: SimCommand;
}

export interface ScenarioSetup {
  readonly script: ScriptedCommand[];
  /** Where the camera starts (world x, y and zoom in px/unit). */
  readonly focus: { x: number; y: number; zoom: number } | null;
  /** Units the client selects at start (their order lines show right away). */
  readonly select: number[];
}

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

export function setupScenario(world: World, name: string, units: number): ScenarioSetup {
  const script: ScriptedCommand[] = [];
  let focus: ScenarioSetup['focus'] = null;
  let select: number[] = [];
  const move = (tick: number, handles: number[], x: number, y: number, queue = false): void => {
    script.push({ tick, cmd: { kind: 'move', handles: Int32Array.from(handles), x, y, queue } });
  };
  const patrol = (tick: number, handles: number[], x: number, y: number, queue = false): void => {
    script.push({ tick, cmd: { kind: 'patrol', handles: Int32Array.from(handles), x, y, queue } });
  };
  switch (name) {
    case 'choke': {
      // 200 small units squeeze through the 4-wide gap of the first chokepoint wall.
      const a = block(world, ArchetypeId.Trooper, Faction.Player, 180, 40, 214, 90, 120);
      const b = block(world, ArchetypeId.Skitter, Faction.Player, 180, 92, 214, 112, 80);
      move(30, [...a, ...b], 262, 64);
      focus = { x: 226, y: 72, zoom: 9 };
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
      focus = { x: 255, y: 100, zoom: 11 };
      break;
    }
    case 'cross': {
      // Two armies swap sides through each other inside the main base.
      const blue = block(world, ArchetypeId.Trooper, Faction.Player, 26, 104, 46, 138, 150);
      const red = block(world, ArchetypeId.Trooper, Faction.HostileA, 116, 104, 136, 138, 150);
      move(30, blue, 126, 121);
      move(30, red, 36, 121);
      focus = { x: 81, y: 121, zoom: 7 };
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
      focus = { x: 85, y: 95, zoom: 5.5 };
      break;
    }
    case 'drop': {
      // A column marches east; two seconds in, a 6×6 building lands on it.
      const col = block(world, ArchetypeId.Trooper, Faction.Player, 26, 116, 76, 124, 100);
      move(30, col, 132, 120);
      script.push({ tick: 90, cmd: { kind: 'placeBuilding', def: { id: 'drop', faction: Faction.Neutral, type: 'hall', center: [70, 120], size: [6, 6], rot: 0 } } });
      focus = { x: 80, y: 120, zoom: 9 };
      select = col;
      break;
    }
    case 'canyon': {
      // Every size heads east through the canyon; only small units fit its 1.5-wide throat.
      const hs = [
        ...block(world, ArchetypeId.Trooper, Faction.Player, 316, 200, 334, 212, 14),
        ...block(world, ArchetypeId.Walker, Faction.Player, 316, 213, 334, 222, 8),
        ...block(world, ArchetypeId.Tank, Faction.Player, 308, 223, 334, 230, 6),
        ...block(world, ArchetypeId.Behemoth, Faction.Player, 300, 231, 334, 236, 3),
        ...block(world, ArchetypeId.Colossal, Faction.Player, 296, 237, 334, 242, 2),
      ];
      move(30, hs, 505, 295);
      focus = { x: 420, y: 255, zoom: 2.6 };
      select = hs;
      break;
    }
    case 'maze': {
      // A squad crosses the maze from its west entrance to its east exit.
      const hs = [
        ...block(world, ArchetypeId.Skitter, Faction.Player, 1, 326, 9, 348, 24),
        ...block(world, ArchetypeId.Trooper, Faction.Player, 10, 326, 30, 340, 26),
      ];
      move(30, hs, 172, 497);
      focus = { x: 85, y: 425, zoom: 3.6 };
      select = hs;
      break;
    }
    case 'trap': {
      // Units south of the U-trap are ordered into its pocket: they must go around and in.
      const hs = block(world, ArchetypeId.Trooper, Faction.Player, 212, 480, 238, 490, 30);
      move(30, hs, 225, 455);
      focus = { x: 225, y: 440, zoom: 5 };
      select = hs;
      break;
    }
    case 'town': {
      // The neutral town's patrols, plus an army cutting through the alleys.
      spawnFromMap(world);
      const army = [
        ...block(world, ArchetypeId.Trooper, Faction.Player, 318, 404, 336, 436, 50),
        ...block(world, ArchetypeId.Tank, Faction.Player, 304, 410, 317, 430, 8),
      ];
      move(30, army, 505, 420);
      focus = { x: 420, y: 420, zoom: 3.4 };
      select = army;
      break;
    }
    case 'queue': {
      // Queued waypoints and a patrol loop, drawn as order lines.
      const hs = block(world, ArchetypeId.Walker, Faction.Player, 60, 110, 74, 124, 16);
      move(20, hs, 110, 120);
      move(20, hs, 110, 60, true);
      move(20, hs, 50, 50, true);
      patrol(20, hs, 50, 100, true);
      focus = { x: 85, y: 90, zoom: 5 };
      select = hs;
      break;
    }
    case 'empty':
      break;
    default: {
      if (name !== 'stress') break; // unknown scenario names start empty (tests use this)
      // Ambient world: the map's own armies, patrols, herds and convoys, topped up with
      // random wanderers / patrols of the other factions to reach `units`.
      const n = spawnFromMap(world);
      spawnRandomUnits(world, Math.max(0, units - n));
    }
  }
  script.sort((a, b) => a.tick - b.tick);
  return { script, focus, select };
}
