/**
 * Turns source map geometry into the canonical obstacle set the navmesh is built from:
 * valid, non-overlapping, lattice-snapped polygons with holes, where every remaining
 * walkable area is one connected region wide enough for the smallest unit.
 */
import { FillRule, union } from 'clipper2-ts';
import type { BuildingDef, MapData } from '../../shared/mapFormat';
import { pointInPolygon, rectRing, ringBounds, type Bounds, type Polygon } from '../../shared/geometry';
import {
  close, intersectPaths, pathAreaWorld, rectPath, ringToPath, ringsToPaths, simplify,
  subtract, toPolygons, unionTwo, polygonsToPaths, type Paths64,
} from './clip';

/** Smallest unit radius: gaps narrower than 2× this are closed. */
export const MIN_UNIT_RADIUS = 0.25;
/** Obstacles smaller than this (world units²) are dropped. */
export const SLIVER_AREA = 0.25;
/** Max deviation introduced by simplification (world units). */
export const SIMPLIFY_EPS = 0.06;

export interface NormalizedTerrain {
  readonly polygons: Polygon[];
  /** Walkable pockets disconnected from the main area that were filled in. */
  readonly filledPockets: number;
  readonly vertexCount: number;
}

/**
 * Applies the terrain shapes in order, clips to the map, closes sub-unit gaps, simplifies,
 * and fills walkable pockets not connected to the main region (the one containing
 * `mainPoint`, or the largest).
 */
export function normalizeTerrain(map: MapData, mainPoint?: readonly [number, number]): NormalizedTerrain {
  const [W, H] = map.size;
  let acc: Paths64 = [];

  // Apply runs of same-op shapes in one boolean op each.
  let k = 0;
  while (k < map.terrain.length) {
    const op = map.terrain[k].op;
    let run: Paths64 = [];
    while (k < map.terrain.length && map.terrain[k].op === op) {
      // Each shape is even-odd internally (lets a shape carry its own holes).
      run = run.concat(union(ringsToPaths(map.terrain[k].rings), FillRule.EvenOdd));
      k++;
    }
    acc = op === 'add' ? unionTwo(acc, run) : subtract(acc, run);
  }

  const mapRect = [rectPath(0, 0, W, H)];
  // A frame outside the map takes part in closing, so slivers between rock and the map edge close too.
  const m = 4;
  const frame = subtract([rectPath(-m, -m, W + m, H + m)], mapRect);
  acc = close(unionTwo(acc, frame), MIN_UNIT_RADIUS);
  acc = intersectPaths(simplify(acc, SIMPLIFY_EPS), mapRect);
  acc = union(acc, FillRule.NonZero);

  // Walkable space and its connected components.
  const free = toPolygons(subtract(mapRect, acc));
  let main = -1;
  if (mainPoint) main = free.findIndex((p) => pointInPolygon(p, mainPoint[0], mainPoint[1]));
  if (main < 0) {
    let best = -Infinity;
    free.forEach((p, i) => {
      const a = pathAreaWorld(ringToPath(p.rings[0]));
      if (a > best) {
        best = a;
        main = i;
      }
    });
  }
  const filledPockets = Math.max(0, free.length - 1);
  const obstacles = main >= 0 ? subtract(mapRect, polygonsToPaths([free[main]])) : mapRect;

  const polygons = toPolygons(obstacles).filter((p) => Math.abs(pathAreaWorld(ringToPath(p.rings[0]))) >= SLIVER_AREA);
  let vertexCount = 0;
  for (const p of polygons) for (const r of p.rings) vertexCount += r.length / 2;
  return { polygons, filledPockets, vertexCount };
}

export function buildingRing(b: BuildingDef): Float64Array {
  return rectRing(b.center[0], b.center[1], b.size[0], b.size[1], b.rot);
}

export interface BuildingCheck {
  readonly accepted: BuildingDef[];
  readonly rejected: { readonly id: string; readonly reason: string }[];
}

/**
 * Placement validation (the navmesh's no-crossing contract): a building must lie inside the
 * map (with a 1-unit margin) and must not overlap terrain or another building. Touching
 * along edges is allowed.
 */
export class PlacementChecker {
  private readonly terrainBounds: Bounds[];
  private readonly terrainPaths: Paths64[];
  private readonly placed = new Map<string, { b: Bounds; path: Paths64 }>();

  constructor(terrain: readonly Polygon[], private readonly W: number, private readonly H: number) {
    this.terrainBounds = terrain.map((p) => ringBounds(p.rings[0]));
    this.terrainPaths = terrain.map((p) => polygonsToPaths([p]));
  }

  /** Returns a reason the footprint can't be placed, or null if it can. */
  check(ring: Float64Array): string | null {
    const bb = ringBounds(ring);
    if (bb.minX < 1 || bb.minY < 1 || bb.maxX > this.W - 1 || bb.maxY > this.H - 1) return 'outside map';
    const path = [ringToPath(ring)];
    for (let i = 0; i < this.terrainPaths.length; i++) {
      if (overlaps(bb, this.terrainBounds[i]) && hasArea(intersectPaths(path, this.terrainPaths[i]))) return 'overlaps terrain';
    }
    for (const o of this.placed.values()) {
      if (overlaps(bb, o.b) && hasArea(intersectPaths(path, o.path))) return 'overlaps building';
    }
    return null;
  }

  add(id: string, ring: Float64Array): void {
    this.placed.set(id, { b: ringBounds(ring), path: [ringToPath(ring)] });
  }

  remove(id: string): void {
    this.placed.delete(id);
  }
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

function hasArea(paths: Paths64): boolean {
  return paths.some((p) => Math.abs(pathAreaWorld(p)) > 1e-9);
}

/** Validates a list of buildings in order; later ones must not overlap earlier accepted ones. */
export function validateBuildings(terrain: readonly Polygon[], buildings: readonly BuildingDef[], W: number, H: number): BuildingCheck {
  const checker = new PlacementChecker(terrain, W, H);
  const accepted: BuildingDef[] = [];
  const rejected: { id: string; reason: string }[] = [];
  for (const b of buildings) {
    const ring = buildingRing(b);
    const reason = checker.check(ring);
    if (reason) {
      rejected.push({ id: b.id, reason });
      continue;
    }
    checker.add(b.id, ring);
    accepted.push(b);
  }
  return { accepted, rejected };
}
