import { ArchetypeId } from '../../shared/archetypes';
import { Faction } from '../../shared/factions';
import { TAU } from '../../shared/math';
import type { World } from '../world';

/** Archetype mix for random stress spawns: mostly small units, a few huge ones. */
const MIX: readonly (readonly [number, number])[] = [
  [ArchetypeId.Skitter, 0.22],
  [ArchetypeId.Trooper, 0.3],
  [ArchetypeId.Walker, 0.14],
  [ArchetypeId.Tank, 0.07],
  [ArchetypeId.Behemoth, 0.03],
  [ArchetypeId.Colossal, 0.01],
  [ArchetypeId.Critter, 0.23],
];

export function spawnRandomUnits(world: World, count: number): void {
  const { rng, units, mapW, mapH } = world;
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
    const faction = arch === ArchetypeId.Critter ? Faction.Neutral : rng.int(4);
    const margin = 4;
    const x = rng.range(margin, mapW - margin);
    const y = rng.range(margin, mapH - margin);
    const h = units.spawn(arch, faction, x, y, rng.range(-Math.PI, Math.PI));
    if (h === 0) return;
    const i = h & 0xffff;
    const a = rng.range(0, TAU);
    const s = units.maxSpeed[i] * rng.range(0.4, 1);
    units.velX[i] = Math.cos(a) * s;
    units.velY[i] = Math.sin(a) * s;
  }
}
