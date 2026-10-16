/** Scenario catalogue for the picker (the sim implements them in sim/scenarios). */
export interface ScenarioInfo {
  readonly id: string;
  readonly label: string;
  readonly about: string;
}

export const SCENARIO_INFO: readonly ScenarioInfo[] = [
  { id: 'stress', label: 'Ambient world (10k)', about: 'Armies, patrols, convoys, critter herds and wanderers across the whole map.' },
  { id: 'choke', label: 'Chokepoint 200', about: '200 units squeeze through a 4-wide gap.' },
  { id: 'holdline', label: 'Hold the line', about: 'Movers funnel through a 1-wide gap in a line of hold-position units — nobody pushes the holders.' },
  { id: 'cross', label: 'Crossing armies', about: 'Two armies swap sides through each other and form lanes.' },
  { id: 'blob', label: 'Converging blob', about: 'A mixed group converges on one point and settles without dancing.' },
  { id: 'drop', label: 'Building drop', about: 'A building lands on a marching column: units are ejected and re-route.' },
  { id: 'canyon', label: 'Size-mix canyon', about: 'Every unit size heads through a canyon whose throat only small units fit.' },
  { id: 'maze', label: 'Maze solve', about: 'A squad crosses the maze; corridor widths shrink row by row.' },
  { id: 'trap', label: 'Concave trap', about: 'Units ordered into a U-shaped pocket from behind go around, not into the wall.' },
  { id: 'town', label: 'Town crossing', about: 'An army cuts through a town full of patrols and alleys.' },
  { id: 'queue', label: 'Shift-queue & patrol', about: 'Queued waypoints and a patrol loop, drawn as SC2-style order lines.' },
  { id: 'empty', label: 'Empty map', about: 'Just the map — use the editor and spawn units with =.' },
];
