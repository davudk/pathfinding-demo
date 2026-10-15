export const Faction = {
  Player: 0,
  HostileA: 1,
  HostileB: 2,
  Ally: 3,
  Neutral: 4,
} as const;
export type Faction = (typeof Faction)[keyof typeof Faction];

export const FACTION_COUNT = 5;

export const FACTION_NAMES: readonly string[] = ['Player', 'Hostile A', 'Hostile B', 'Ally', 'Neutral'];

/** Linear-ish sRGB colors in 0..1. Green is reserved for UI (selection, move orders). */
export const FACTION_COLORS: readonly (readonly [number, number, number])[] = [
  [0x3b / 255, 0x82 / 255, 0xf6 / 255], // blue
  [0xef / 255, 0x44 / 255, 0x44 / 255], // red
  [0xf5 / 255, 0x9e / 255, 0x0b / 255], // orange
  [0x14 / 255, 0xb8 / 255, 0xa6 / 255], // teal
  [0xa8 / 255, 0xa2 / 255, 0x9e / 255], // warm grey
];

/** Colour-blind friendly alternative: red → magenta, teal → yellow. */
export const FACTION_COLORS_CB: readonly (readonly [number, number, number])[] = [
  [0x3b / 255, 0x82 / 255, 0xf6 / 255],
  [0xd9 / 255, 0x46 / 255, 0xef / 255],
  [0xf5 / 255, 0x9e / 255, 0x0b / 255],
  [0xfa / 255, 0xcc / 255, 0x15 / 255],
  [0xa8 / 255, 0xa2 / 255, 0x9e / 255],
];
