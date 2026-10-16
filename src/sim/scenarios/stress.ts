import { ARCHETYPES, ArchetypeId } from '../../shared/archetypes';
import { Faction } from '../../shared/factions';
import { TAU } from '../../shared/math';
import type { SpawnDef } from '../../shared/mapFormat';
import { Brain } from '../ai/brains';
import { snapToWalkable } from '../nav/query';
import type { World } from '../world';

/** Archetype mix for random ambient spawns: mostly small units, a few huge ones. */
const MIX: readonly (readonly [number, number])[] = [
  [ArchetypeId.Skitter, 0.22],
  [ArchetypeId.Trooper, 0.3],
  [ArchetypeId.Walker, 0.14],
  [ArchetypeId.Tank, 0.07],
  [ArchetypeId.Behemoth, 0.03],
  [ArchetypeId.Colossal, 0.01],
  [ArchetypeId.Critter, 0.23],
];

function randomFreeSpot(world: World, r: number): [number, number] | null {
  const { rng, mapW, mapH } = world;
  const occ = world.map.occupancy;
  for (let tries = 0; tries < 64; tries++) {
    const x = rng.range(r, mapW - r), y = rng.range(r, mapH - r);
    if (occ.isFreeCircle(x, y, r + 0.1)) return [x, y];
  }
  return null;
}

/**
 * Random ambient units across the map (never the player's faction): 60% wander around their
 * spawn, 25% patrol to a nearby point, 15% stand around fidgeting.
 */
export function spawnRandomUnits(world: World, count: number): void {
  const { rng, units } = world;
  for (let n = 0; n < count; n++) {
    let roll = rng.float();
    let arch: number = ArchetypeId.Trooper;
    for (const [id, p] of MIX) {
      if (roll < p) {
        arch = id;
        break;
      }
      roll -= p;
    }
    const faction = arch === ArchetypeId.Critter ? Faction.Neutral : 1 + rng.int(3);
    const r = ARCHETYPES[arch].radius;
    const spot = randomFreeSpot(world, r);
    if (!spot) continue;
    const h = units.spawn(arch, faction, spot[0], spot[1], rng.range(-Math.PI, Math.PI));
    if (h === 0) return;
    const b = rng.float();
    if (b < 0.6) {
      world.brains.assign(world, h, Brain.Wander, { radius: rng.range(12, 40) });
    } else if (b < 0.85) {
      const a = rng.range(0, TAU), d = rng.range(15, 45);
      const t = snapToWalkable(world.nav, spot[0] + Math.cos(a) * d, spot[1] + Math.sin(a) * d, r, 8);
      if (t) world.brains.assign(world, h, Brain.Patrol, { targetX: t[0], targetY: t[1] });
      else world.brains.assign(world, h, Brain.Wander, { radius: 20 });
    } else {
      world.brains.assign(world, h, Brain.Fidget);
    }
  }
}

/** Units from the map's spawn definitions, with their behaviours. Returns how many spawned. */
export function spawnFromMap(world: World): number {
  const routeIds = new Map<string, number>();
  for (const r of world.map.data.routes) routeIds.set(r.id, world.brains.addRoute(subsample(r.points, 8), r.loop));
  let total = 0;
  for (const s of world.map.data.spawns) total += spawnGroup(world, s, routeIds);
  return total;
}

function spawnGroup(world: World, s: SpawnDef, routeIds: Map<string, number>): number {
  const { rng, units } = world;
  const r = ARCHETYPES[s.archetype]?.radius ?? 0.5;
  const handles: number[] = [];
  const [cx, cy, R] = s.circle;
  for (let k = 0; k < s.count * 4 && handles.length < s.count; k++) {
    const a = rng.range(0, TAU), d = Math.sqrt(rng.float()) * R;
    const p = snapToWalkable(world.nav, cx + Math.cos(a) * d, cy + Math.sin(a) * d, r, 2);
    if (!p || !world.map.occupancy.isFreeCircle(p[0], p[1], r)) continue;
    const h = units.spawn(s.archetype, s.faction, p[0], p[1], rng.range(-Math.PI, Math.PI));
    if (h) handles.push(h);
  }
  switch (s.behavior) {
    case 'wander':
      for (const h of handles) world.brains.assign(world, h, Brain.Wander, { radius: R * 1.2 + 10 });
      break;
    case 'patrol':
      for (const h of handles) {
        const i = h & 0xffff;
        const a = rng.range(0, TAU), d = rng.range(R, R * 2.5 + 10);
        const t = snapToWalkable(world.nav, units.posX[i] + Math.cos(a) * d, units.posY[i] + Math.sin(a) * d, r, 8);
        if (t) world.brains.assign(world, h, Brain.Patrol, { targetX: t[0], targetY: t[1] });
        else world.brains.assign(world, h, Brain.Fidget);
      }
      break;
    case 'route': {
      const id = s.route !== undefined ? routeIds.get(s.route) : undefined;
      handles.forEach((h, k) => {
        world.brains.assign(world, h, id === undefined ? Brain.Fidget : Brain.Route, { param: id ?? 0 });
        // Stagger convoy members so they leave one after another.
        world.brains.nextThink[h & 0xffff] = world.tick + 1 + k * 45;
      });
      break;
    }
    case 'herd':
      world.brains.addHerd(world, handles, R * 2 + 25);
      break;
    default:
      for (const h of handles) world.brains.assign(world, h, Brain.Fidget);
  }
  return handles.length;
}

function subsample(points: readonly number[], max: number): number[] {
  const n = points.length >> 1;
  if (n <= max) return points.slice();
  const out: number[] = [];
  for (let k = 0; k < max; k++) {
    const idx = Math.round((k * (n - 1)) / (max - 1));
    out.push(points[2 * idx], points[2 * idx + 1]);
  }
  return out;
}
