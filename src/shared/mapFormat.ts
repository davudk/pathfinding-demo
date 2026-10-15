/**
 * Map file format (JSON). Stores *source* geometry: terrain shapes are applied in order
 * (add = union, subtract = difference) and normalized on load, so edits stay reversible.
 */

export const MAP_FORMAT = 'rts-map';
export const MAP_VERSION = 1;

export type TerrainOp = 'add' | 'subtract';

export interface TerrainShape {
  readonly id: string;
  /** Visual/semantic kind; all kinds block movement. */
  readonly kind: 'rock' | 'cliff' | 'wall';
  readonly op: TerrainOp;
  /** Rings as flat [x0, y0, x1, y1, ...]; any orientation; even-odd within one shape. */
  readonly rings: number[][];
}

export interface BuildingDef {
  readonly id: string;
  readonly faction: number;
  readonly type: string;
  readonly center: readonly [number, number];
  readonly size: readonly [number, number];
  /** Radians. */
  readonly rot: number;
}

export interface SpawnDef {
  readonly faction: number;
  readonly archetype: number;
  readonly count: number;
  readonly circle: readonly [number, number, number];
  readonly behavior: 'idle' | 'wander' | 'patrol' | 'route' | 'herd';
  readonly route?: string;
}

export interface RouteDef {
  readonly id: string;
  readonly loop: boolean;
  /** Flat [x0, y0, x1, y1, ...]. */
  readonly points: number[];
}

export interface ZoneDef {
  readonly name: string;
  /** [x, y, w, h] */
  readonly rect: readonly [number, number, number, number];
}

export interface MapData {
  readonly format: typeof MAP_FORMAT;
  readonly version: typeof MAP_VERSION;
  readonly name: string;
  readonly size: readonly [number, number];
  readonly seed: number;
  readonly generator?: { readonly algo: string; readonly params: Readonly<Record<string, number | string | boolean>> };
  readonly terrain: readonly TerrainShape[];
  readonly buildings: readonly BuildingDef[];
  readonly spawns: readonly SpawnDef[];
  readonly routes: readonly RouteDef[];
  readonly zones: readonly ZoneDef[];
}

export class MapFormatError extends Error {}

/** Parses and validates a map JSON document. Throws MapFormatError with a path on bad input. */
export function parseMap(json: string | unknown): MapData {
  const d = (typeof json === 'string' ? JSON.parse(json) : json) as Record<string, unknown>;
  const fail = (path: string, what: string): never => {
    throw new MapFormatError(`map.${path}: ${what}`);
  };
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const numArr = (v: unknown, path: string, len?: number): number[] => {
    if (!Array.isArray(v) || !v.every(isNum)) return fail(path, 'expected an array of finite numbers');
    if (len !== undefined && v.length !== len) fail(path, `expected ${len} numbers`);
    return v as number[];
  };
  const arr = (v: unknown, path: string): unknown[] => (Array.isArray(v) ? v : fail(path, 'expected an array'));
  const obj = (v: unknown, path: string): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(path, 'expected an object');
  const str = (v: unknown, path: string): string => (typeof v === 'string' ? v : fail(path, 'expected a string'));

  if (d.format !== MAP_FORMAT) fail('format', `expected "${MAP_FORMAT}"`);
  if (d.version !== MAP_VERSION) fail('version', `unsupported version ${String(d.version)}`);
  const size = numArr(d.size, 'size', 2);
  if (size[0] < 16 || size[1] < 16 || size[0] > 4096 || size[1] > 4096) fail('size', 'must be within 16..4096');

  const terrain = arr(d.terrain, 'terrain').map((t, i) => {
    const o = obj(t, `terrain[${i}]`);
    const kind = str(o.kind, `terrain[${i}].kind`);
    if (kind !== 'rock' && kind !== 'cliff' && kind !== 'wall') fail(`terrain[${i}].kind`, 'unknown kind');
    const op = o.op === undefined ? 'add' : str(o.op, `terrain[${i}].op`);
    if (op !== 'add' && op !== 'subtract') fail(`terrain[${i}].op`, 'expected add|subtract');
    const rings = arr(o.rings, `terrain[${i}].rings`).map((r, k) => {
      const ring = numArr(r, `terrain[${i}].rings[${k}]`);
      if (ring.length < 6 || ring.length % 2 !== 0) fail(`terrain[${i}].rings[${k}]`, 'needs ≥ 3 points');
      return ring;
    });
    return { id: str(o.id, `terrain[${i}].id`), kind, op, rings } as TerrainShape;
  });

  const buildings = arr(d.buildings, 'buildings').map((b, i) => {
    const o = obj(b, `buildings[${i}]`);
    const center = numArr(o.center, `buildings[${i}].center`, 2);
    const sz = numArr(o.size, `buildings[${i}].size`, 2);
    if (sz[0] <= 0 || sz[1] <= 0) fail(`buildings[${i}].size`, 'must be positive');
    return {
      id: str(o.id, `buildings[${i}].id`),
      faction: isNum(o.faction) ? o.faction : fail(`buildings[${i}].faction`, 'expected a number'),
      type: str(o.type, `buildings[${i}].type`),
      center: [center[0], center[1]],
      size: [sz[0], sz[1]],
      rot: o.rot === undefined ? 0 : isNum(o.rot) ? o.rot : fail(`buildings[${i}].rot`, 'expected a number'),
    } as BuildingDef;
  });

  const spawns = (d.spawns === undefined ? [] : arr(d.spawns, 'spawns')).map((s, i) => {
    const o = obj(s, `spawns[${i}]`);
    const circle = numArr(o.circle, `spawns[${i}].circle`, 3);
    return {
      faction: isNum(o.faction) ? o.faction : fail(`spawns[${i}].faction`, 'expected a number'),
      archetype: isNum(o.archetype) ? o.archetype : fail(`spawns[${i}].archetype`, 'expected a number'),
      count: isNum(o.count) ? o.count : fail(`spawns[${i}].count`, 'expected a number'),
      circle: [circle[0], circle[1], circle[2]],
      behavior: str(o.behavior ?? 'idle', `spawns[${i}].behavior`),
      ...(o.route !== undefined ? { route: str(o.route, `spawns[${i}].route`) } : {}),
    } as SpawnDef;
  });

  const routes = (d.routes === undefined ? [] : arr(d.routes, 'routes')).map((r, i) => {
    const o = obj(r, `routes[${i}]`);
    return { id: str(o.id, `routes[${i}].id`), loop: o.loop === true, points: numArr(o.points, `routes[${i}].points`) } as RouteDef;
  });

  const zones = (d.zones === undefined ? [] : arr(d.zones, 'zones')).map((z, i) => {
    const o = obj(z, `zones[${i}]`);
    const r = numArr(o.rect, `zones[${i}].rect`, 4);
    return { name: str(o.name, `zones[${i}].name`), rect: [r[0], r[1], r[2], r[3]] } as ZoneDef;
  });

  return {
    format: MAP_FORMAT,
    version: MAP_VERSION,
    name: typeof d.name === 'string' ? d.name : 'untitled',
    size: [size[0], size[1]],
    seed: isNum(d.seed) ? d.seed : 0,
    ...(d.generator !== undefined ? { generator: d.generator as MapData['generator'] & object } : {}),
    terrain,
    buildings,
    spawns,
    routes,
    zones,
  };
}

/** Serializes with coordinates rounded to the lattice (compact, stable diffs). */
export function serializeMap(m: MapData): string {
  return JSON.stringify(m, (_k, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v));
}
