/**
 * Unit archetypes. Radii and speeds are derived from SC2 (world unit = 1 SC2 cell,
 * speeds in cells/second at "Faster"); re-verify against Liquipedia before freezing.
 */
export interface Archetype {
  readonly name: string;
  readonly radius: number;
  /** Max speed, world units / second. */
  readonly speed: number;
  /** Acceleration, world units / second². */
  readonly accel: number;
  /** Higher pushes lower; equal splits by area. */
  readonly pushPriority: number;
  /** Radians / second. */
  readonly turnRate: number;
  /** Rendered without outline (small ambient creatures). */
  readonly plain: boolean;
}

export const ARCHETYPES: readonly Archetype[] = [
  { name: 'skitter', radius: 0.375, speed: 4.1, accel: 60, pushPriority: 20, turnRate: 20, plain: false },
  { name: 'trooper', radius: 0.375, speed: 3.15, accel: 40, pushPriority: 20, turnRate: 14, plain: false },
  { name: 'walker', radius: 0.625, speed: 4.1, accel: 30, pushPriority: 30, turnRate: 10, plain: false },
  { name: 'tank', radius: 0.875, speed: 3.15, accel: 12, pushPriority: 40, turnRate: 4, plain: false },
  { name: 'behemoth', radius: 1.25, speed: 2.6, accel: 6, pushPriority: 50, turnRate: 3, plain: false },
  { name: 'colossal', radius: 2.0, speed: 2.0, accel: 4, pushPriority: 60, turnRate: 2, plain: false },
  { name: 'critter', radius: 0.25, speed: 2.0, accel: 20, pushPriority: 5, turnRate: 12, plain: true },
];

export const ArchetypeId = {
  Skitter: 0,
  Trooper: 1,
  Walker: 2,
  Tank: 3,
  Behemoth: 4,
  Colossal: 5,
  Critter: 6,
} as const;
export type ArchetypeId = (typeof ArchetypeId)[keyof typeof ArchetypeId];

export const MAX_UNIT_RADIUS = 2.0;
