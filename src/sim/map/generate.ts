/**
 * Procedural 9-zone demo map ("noise-v1"). Each zone stresses a different aspect of
 * pathfinding and movement; the zones are separated by organic cliff bands with
 * guaranteed gates. Deterministic for a given seed.
 */
import { createNoise2D } from 'simplex-noise';
import { Rng } from '../../shared/rng';
import { ArchetypeId } from '../../shared/archetypes';
import { Faction } from '../../shared/factions';
import { snap } from '../../shared/geometry';
import {
  MAP_FORMAT, MAP_VERSION,
  type BuildingDef, type MapData, type RouteDef, type SpawnDef, type TerrainShape, type ZoneDef,
} from '../../shared/mapFormat';
import { pathToRing, ringsToPaths, simplify, strokePolyline, unionPaths, EndType } from './clip';
import { marchingSquares } from './marchingSquares';
import { boulder, jaggedRect, rect, scatter, spiral } from './shapes';

export const GENERATOR_ALGO = 'noise-v1';

export interface GeneratedMap {
  readonly map: MapData;
  /** Point inside the main walkable region (the player's base). */
  readonly mainPoint: readonly [number, number];
}

export function generateMap(seed: number, size = 512): GeneratedMap {
  const rng = new Rng(seed);
  const noise = createNoise2D(() => rng.float());
  const fbm = (x: number, y: number, octaves = 4): number => {
    let v = 0, amp = 0.5, f = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      v += amp * noise(x * f, y * f);
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return v / norm;
  };

  const W = size, H = size, Z = Math.floor(size / 3); // zone pitch; the last row/column absorbs the remainder
  const terrain: TerrainShape[] = [];
  const buildings: BuildingDef[] = [];
  const spawns: SpawnDef[] = [];
  const routes: RouteDef[] = [];
  const zones: ZoneDef[] = [];
  let nextId = 0;
  const id = (p: string): string => `${p}${nextId++}`;
  const add = (kind: TerrainShape['kind'], rings: number[][]): void => {
    if (rings.length) terrain.push({ id: id('t'), kind, op: 'add', rings: rings.map(snapRing) });
  };
  const sub = (rings: number[][]): void => {
    if (rings.length) terrain.push({ id: id('t'), kind: 'rock', op: 'subtract', rings: rings.map(snapRing) });
  };
  const building = (faction: number, type: string, cx: number, cy: number, w: number, h: number): void => {
    buildings.push({ id: id('b'), faction, type, center: [snapHalf(cx), snapHalf(cy)], size: [w, h], rot: 0 });
  };
  const zone = (c: number, r: number, name: string): [number, number] => {
    zones.push({ name, rect: [c * Z, r * Z, c === 2 ? W - 2 * Z : Z, r === 2 ? H - 2 * Z : Z] });
    return [c * Z, r * Z];
  };
  const stroke = (pts: number[], width: number, end = EndType.Round): number[][] =>
    strokePolyline(pts, width, end).map(pathToRing).map((r) => Array.from(r));

  // ── Cliff bands between zones, with two gates per shared border ──────────────
  {
    const cell = 1;
    const nx = Math.ceil(W / cell) + 1, ny = Math.ceil(H / cell) + 1;
    const vals = new Float32Array(nx * ny);
    const gates: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const gateW = 26;
    for (let k = 1; k <= 2; k++) {
      for (let s = 0; s < 3; s++) {
        for (let g = 0; g < 2; g++) {
          const t = s * Z + Z * (0.15 + 0.35 * g) + rng.range(0, Z * 0.3);
          gates.push({ x0: k * Z - 12, y0: t, x1: k * Z + 12, y1: t + gateW }); // vertical border
          gates.push({ x0: t, y0: k * Z - 12, x1: t + gateW, y1: k * Z + 12 }); // horizontal border
        }
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = i * cell, y = j * cell;
        const dv = Math.min(Math.abs(x - Z), Math.abs(x - 2 * Z));
        const dh = Math.min(Math.abs(y - Z), Math.abs(y - 2 * Z));
        const d = Math.min(dv, dh);
        let band = smoothstep(10, 3, d);
        if (band <= 0) continue;
        for (const g of gates) if (x >= g.x0 && x <= g.x1 && y >= g.y0 && y <= g.y1) band = 0;
        vals[j * nx + i] = band * (0.55 + 0.45 * fbm(x * 0.045, y * 0.045, 3));
      }
    }
    const rings = marchingSquares(vals, nx, ny, 0, 0, cell, 0.5);
    add('cliff', simplifyRings(rings, 0.3));
  }

  // ── (0,0) Player main: plateau rim with a 5-wide ramp and a 1.25-wide back door ─
  {
    const [ox, oy] = zone(0, 0, 'Main Base');
    const n = (x: number, y: number): number => fbm(x + 3.1, y + 7.7, 3);
    add('cliff', [jaggedRect(ox + 12, oy + 12, ox + 150, oy + 150, 3, 2.2, n), jaggedRect(ox + 20, oy + 20, ox + 142, oy + 142, 3, 1.6, n)]);
    sub([rect(ox + 136, oy + 108, ox + 158, oy + 113)]); // ramp, width 5
    sub([rect(ox + 40, oy + 136, ox + 41.25, oy + 158)]); // back door, width 1.25
    placeBase(rng, building, Faction.Player, ox + 76, oy + 76, 1);
    spawns.push(
      { faction: Faction.Player, archetype: ArchetypeId.Trooper, count: 60, circle: [ox + 100, oy + 110, 10], behavior: 'idle' },
      { faction: Faction.Player, archetype: ArchetypeId.Skitter, count: 40, circle: [ox + 60, oy + 115, 9], behavior: 'idle' },
      { faction: Faction.Player, archetype: ArchetypeId.Walker, count: 16, circle: [ox + 45, oy + 60, 7], behavior: 'idle' },
      { faction: Faction.Player, archetype: ArchetypeId.Tank, count: 8, circle: [ox + 110, oy + 50, 7], behavior: 'idle' },
      { faction: Faction.Player, archetype: ArchetypeId.Behemoth, count: 4, circle: [ox + 110, oy + 75, 6], behavior: 'idle' },
      { faction: Faction.Player, archetype: ArchetypeId.Colossal, count: 2, circle: [ox + 45, oy + 95, 6], behavior: 'idle' },
    );
  }

  // ── (1,0) Chokepoint field: two rough walls with 2-, 4- and 8-wide gaps ──────
  {
    const [ox, oy] = zone(1, 0, 'Chokepoints');
    const n = (x: number, y: number): number => fbm(x + 11, y - 5, 3);
    add('wall', [jaggedRect(ox + 48, oy - 4, ox + 60, oy + Z + 4, 2.5, 1.6, n)]);
    add('wall', [jaggedRect(ox + 110, oy - 4, ox + 122, oy + Z + 4, 2.5, 1.6, n)]);
    sub([rect(ox + 44, oy + 62, ox + 64, oy + 66)]); // 4 wide
    sub([rect(ox + 106, oy + 100, ox + 126, oy + 108)]); // 8 wide
    sub([rect(ox + 106, oy + 38, ox + 126, oy + 40)]); // 2 wide
  }

  // ── (2,0) Red base with wall-offs ──────────────────────────────────────────
  {
    const [ox, oy] = zone(2, 0, 'Red Base');
    const cx = ox + 95, cy = oy + 70;
    placeBase(rng, building, Faction.HostileA, cx, cy, 0);
    // Fully enclosing depot ring (half-size 30): a 1-wide gap west, a 2-wide gap south.
    // Only units with radius ≤ 0.5 / ≤ 1 can get in or out.
    const R = 30;
    depotLine(building, Faction.HostileA, cx - R, cy - R, cx + R, cy - R, []);
    depotLine(building, Faction.HostileA, cx - R, cy + R, cx + R, cy + R, [[cx - 6, cx - 4]]);
    depotLine(building, Faction.HostileA, cx - R, cy - R + 2, cx - R, cy + R - 2, [[cy + 2, cy + 3]]);
    depotLine(building, Faction.HostileA, cx + R, cy - R + 2, cx + R, cy + R - 2, []);
    for (let k = 0; k < 7; k++) add('rock', [boulder(rng, ox + rng.range(20, 150), oy + rng.range(110, 160), rng.range(2.5, 5), 7, 0.25)]);
    spawns.push(
      { faction: Faction.HostileA, archetype: ArchetypeId.Trooper, count: 80, circle: [ox + 95, oy + 115, 12], behavior: 'patrol' },
      { faction: Faction.HostileA, archetype: ArchetypeId.Tank, count: 12, circle: [ox + 60, oy + 40, 8], behavior: 'idle' },
    );
  }

  // ── (0,1) Open plains: a few large formations, orange outpost, critter herds ─
  {
    const [ox, oy] = zone(0, 1, 'Open Plains');
    const cell = 1;
    const nx = Math.ceil(Z / cell), ny = Math.ceil(Z / cell);
    const vals = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = ox + i * cell, y = oy + j * cell;
        const edge = smoothstep(0, 18, Math.min(i, j, nx - 1 - i, ny - 1 - j) * cell);
        vals[j * nx + i] = fbm(x * 0.022 + 40, y * 0.022, 4) * edge;
      }
    }
    add('rock', simplifyRings(marchingSquares(vals, nx, ny, ox, oy, cell, 0.32), 0.3));
    placeBase(rng, building, Faction.HostileB, ox + 135, oy + 140, 1, 6);
    spawns.push(
      { faction: Faction.Neutral, archetype: ArchetypeId.Critter, count: 120, circle: [ox + 60, oy + 60, 14], behavior: 'herd' },
      { faction: Faction.Neutral, archetype: ArchetypeId.Critter, count: 80, circle: [ox + 110, oy + 50, 10], behavior: 'herd' },
      { faction: Faction.HostileB, archetype: ArchetypeId.Walker, count: 30, circle: [ox + 120, oy + 115, 8], behavior: 'idle' },
    );
  }

  // ── (1,1) Rock garden: hundreds of small boulders ──────────────────────────
  {
    const [ox, oy] = zone(1, 1, 'Rock Garden');
    const pts = scatter(rng, ox + 8, oy + 8, ox + Z - 8, oy + Z - 8, 5.2, 4000);
    const rings: number[][] = [];
    for (let k = 0; k < pts.length; k += 2) {
      rings.push(boulder(rng, pts[k], pts[k + 1], rng.range(0.6, 2.3), 5 + rng.int(4), 0.28));
    }
    add('rock', unionAll(rings));
    spawns.push({ faction: Faction.Neutral, archetype: ArchetypeId.Critter, count: 150, circle: [ox + Z / 2, oy + Z / 2, 60], behavior: 'wander' });
  }

  // ── (2,1) Canyon: rock mass with a winding channel of varying width ─────────
  {
    const [ox, oy] = zone(2, 1, 'Canyon');
    const n = (x: number, y: number): number => fbm(x - 9, y + 2, 3);
    add('cliff', [jaggedRect(ox + 8, oy + 14, ox + Z - 4, oy + Z - 14, 3, 2.5, n)]);
    // Smooth meander; width eases 6 → 3 → 1.5 (narrowest) → 3 → 6 along the channel.
    const path: number[] = [];
    const samples = 64;
    for (let k = 0; k <= samples; k++) {
      const t = k / samples;
      path.push(ox - 2 + t * (Z + 4), oy + 45 + t * 80 + Math.sin(t * Math.PI * 3) * 22);
    }
    const widthAt = (t: number): number => {
      const keys = [[0, 6], [0.2, 5], [0.35, 3], [0.48, 1.5], [0.58, 1.5], [0.7, 3], [0.85, 5], [1, 6]];
      for (let k = 1; k < keys.length; k++) {
        if (t <= keys[k][0]) {
          const u = (t - keys[k - 1][0]) / (keys[k][0] - keys[k - 1][0]);
          return keys[k - 1][1] + (keys[k][1] - keys[k - 1][1]) * u * u * (3 - 2 * u);
        }
      }
      return 6;
    };
    const channel: number[][] = [];
    for (let k = 0; k < samples; k++) channel.push(...stroke(path.slice(2 * k, 2 * k + 4), widthAt((k + 0.5) / samples)));
    // A side branch from the north, width 4.
    const mid = 2 * Math.round(samples * 0.3);
    channel.push(...stroke([ox + 95, oy - 2, ox + 98, oy + 40, path[mid], path[mid + 1]], 4));
    sub(unionAll(channel));
    routes.push({ id: 'canyon', loop: false, points: path.filter((_, i) => (i >> 1) % 8 === 0).map(snapHalf) });
    spawns.push({ faction: Faction.Ally, archetype: ArchetypeId.Tank, count: 6, circle: [path[0] + 6, path[1], 3], behavior: 'route', route: 'canyon' });
  }

  // ── (0,2) Maze: recursive backtracker, corridor width by band (6 / 4 / 2.5) ──
  {
    const [ox, oy] = zone(0, 2, 'Maze');
    const N = 15, pitch = 10, x0 = ox + 10, y0 = oy + 10;
    const width = (r: number): number => (r < 5 ? 6 : r < 10 ? 4 : 2.5);
    const visited = new Uint8Array(N * N);
    const carved: number[][] = [];
    const cellRect = (c: number, r: number): number[] => {
      const w = width(r), cx = x0 + (c + 0.5) * pitch, cy = y0 + (r + 0.5) * pitch;
      return rect(cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2);
    };
    const passage = (c0: number, r0: number, c1: number, r1: number): number[] => {
      const w = Math.min(width(r0), width(r1));
      const ax = x0 + (c0 + 0.5) * pitch, ay = y0 + (r0 + 0.5) * pitch;
      const bx = x0 + (c1 + 0.5) * pitch, by = y0 + (r1 + 0.5) * pitch;
      return rect(Math.min(ax, bx) - w / 2, Math.min(ay, by) - w / 2, Math.max(ax, bx) + w / 2, Math.max(ay, by) + w / 2);
    };
    const stack = [0];
    visited[0] = 1;
    carved.push(cellRect(0, 0));
    while (stack.length) {
      const cur = stack[stack.length - 1];
      const c = cur % N, r = (cur / N) | 0;
      const options: number[] = [];
      if (c > 0 && !visited[cur - 1]) options.push(cur - 1);
      if (c < N - 1 && !visited[cur + 1]) options.push(cur + 1);
      if (r > 0 && !visited[cur - N]) options.push(cur - N);
      if (r < N - 1 && !visited[cur + N]) options.push(cur + N);
      if (!options.length) {
        stack.pop();
        continue;
      }
      const nxt = options[rng.int(options.length)];
      visited[nxt] = 1;
      carved.push(cellRect(nxt % N, (nxt / N) | 0), passage(c, r, nxt % N, (nxt / N) | 0));
      stack.push(nxt);
    }
    // Entrances: west of (0,0) and east of (N-1, N-1).
    carved.push(rect(x0 - 12, y0 + 2, x0 + 5, y0 + 8));
    carved.push(rect(x0 + N * pitch - 5, y0 + N * pitch - 6.25, x0 + N * pitch + 12, y0 + N * pitch - 3.75));
    add('wall', [rect(x0, y0, x0 + N * pitch, y0 + N * pitch)]);
    sub(unionAll(carved));
  }

  // ── (1,2) Spiral and U-trap: concave pockets that defeat naive steering ─────
  {
    const [ox, oy] = zone(1, 2, 'Spiral & U-Trap');
    add('wall', stroke([ox + 25, oy + 35, ox + 25, oy + 125, ox + 85, oy + 125, ox + 85, oy + 35], 4, EndType.Square));
    add('wall', stroke(spiral(ox + 125, oy + 95, 6, 38, 2.4, 0), 3));
  }

  // ── (2,2) Neutral town: dense blocks of small buildings and alleys ──────────
  {
    const [ox, oy] = zone(2, 2, 'Neutral Town');
    let y = oy + 16;
    let row = 0;
    while (y < oy + Z - 16) {
      const h = rng.int(2) === 0 ? 3 : 4;
      let x = ox + 14;
      while (x < ox + Z - 18) {
        const w = 2 + rng.int(3);
        if (rng.float() > 0.12) building(Faction.Neutral, 'house', x + w / 2, y + h / 2, w, h);
        x += w + [1.5, 2, 3][rng.int(3)];
        if (rng.float() < 0.08) x += 7; // cross street
      }
      row++;
      y += h + (row % 4 === 0 ? 8 : [1.5, 2.5][rng.int(2)]);
    }
    spawns.push({ faction: Faction.Neutral, archetype: ArchetypeId.Trooper, count: 40, circle: [ox + Z / 2, oy + Z / 2, 50], behavior: 'patrol' });
  }

  const map: MapData = {
    format: MAP_FORMAT,
    version: MAP_VERSION,
    name: `Generated ${seed}`,
    size: [W, H],
    seed,
    generator: { algo: GENERATOR_ALGO, params: { seed, size } },
    terrain,
    buildings,
    spawns,
    routes,
    zones,
  };
  return { map, mainPoint: [76, 100] };
}

/** Town hall plus satellites on a jittered ring. `gap` = minimum spacing between buildings. */
function placeBase(
  rng: Rng,
  building: (faction: number, type: string, cx: number, cy: number, w: number, h: number) => void,
  faction: number, cx: number, cy: number, gap: number, count = 10,
): void {
  building(faction, 'hall', cx, cy, 5, 5);
  const placed: number[] = [cx - 2.5 - gap, cy - 2.5 - gap, cx + 2.5 + gap, cy + 2.5 + gap];
  const sizes: [number, number][] = [[2, 2], [3, 3], [3, 2], [2, 3], [4, 3]];
  let made = 0;
  for (let attempt = 0; attempt < 200 && made < count; attempt++) {
    const [w, h] = sizes[rng.int(sizes.length)];
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(7, 18);
    const x = snapHalf(cx + Math.cos(a) * r), y = snapHalf(cy + Math.sin(a) * r);
    const box = [x - w / 2 - gap, y - h / 2 - gap, x + w / 2 + gap, y + h / 2 + gap];
    let ok = true;
    for (let k = 0; k < placed.length; k += 4) {
      if (box[0] < placed[k + 2] && placed[k] < box[2] && box[1] < placed[k + 3] && placed[k + 1] < box[3]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    placed.push(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
    building(faction, made % 3 === 0 ? 'factory' : 'barracks', x, y, w, h);
    made++;
  }
}

/**
 * Fills the axis-aligned segment a→b (its centerline) with touching 2-thick depots, leaving
 * the given [from, to) gaps (coordinates along the segment's axis). Pieces shorter than 2
 * become 1-long depots so walls stay gap-free.
 */
function depotLine(
  building: (faction: number, type: string, cx: number, cy: number, w: number, h: number) => void,
  faction: number, ax: number, ay: number, bx: number, by: number, gaps: [number, number][],
): void {
  const horizontal = ay === by;
  const lo = horizontal ? Math.min(ax, bx) - 1 : Math.min(ay, by) - 1;
  const hi = horizontal ? Math.max(ax, bx) + 1 : Math.max(ay, by) + 1;
  const solid: [number, number][] = [];
  let t = lo;
  for (const [g0, g1] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (g0 > t) solid.push([t, g0]);
    t = Math.max(t, g1);
  }
  if (hi > t) solid.push([t, hi]);
  for (const [s0, s1] of solid) {
    let u = s0;
    while (s1 - u >= 1) {
      const len = s1 - u >= 2 ? 2 : 1;
      const mid = u + len / 2;
      if (horizontal) building(faction, 'depot', mid, ay, len, 2);
      else building(faction, 'depot', ax, mid, 2, len);
      u += len;
    }
  }
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function snapRing(r: number[]): number[] {
  return r.map(snap);
}

function snapHalf(v: number): number {
  return Math.round(v * 2) / 2;
}

function simplifyRings(rings: number[][], eps: number): number[][] {
  return simplify(ringsToPaths(rings), eps).filter((p) => p.length >= 3).map((p) => Array.from(pathToRing(p)));
}

function unionAll(rings: number[][]): number[][] {
  return unionPaths(ringsToPaths(rings)).map((p) => Array.from(pathToRing(p)));
}
