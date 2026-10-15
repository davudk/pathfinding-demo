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
 * map and must not overlap terrain or another building. Touching along edges is allowed.
 */
export function validateBuildings(terrain: readonly Polygon[], buildings: readonly BuildingDef[], W: number, H: number): BuildingCheck {
  const terrainBounds = terrain.map((p) => ringBounds(p.rings[0]));
  const terrainPaths = terrain.map((p) => polygonsToPaths([p]));
  const accepted: BuildingDef[] = [];
  const acceptedRings: { b: Bounds; path: Paths64 }[] = [];
  const rejected: { id: string; reason: string }[] = [];
  const overlaps = (a: Bounds, b: Bounds): boolean => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

  outer: for (const b of buildings) {
    const ring = buildingRing(b);
    const bb = ringBounds(ring);
    if (bb.minX < 0 || bb.minY < 0 || bb.maxX > W || bb.maxY > H) {
      rejected.push({ id: b.id, reason: 'outside map' });
      continue;
    }
    const path = [ringToPath(ring)];
    for (let i = 0; i < terrain.length; i++) {
      if (!overlaps(bb, terrainBounds[i])) continue;
      if (intersectPaths(path, terrainPaths[i]).some((p) => Math.abs(pathAreaWorld(p)) > 1e-9)) {
        rejected.push({ id: b.id, reason: 'overlaps terrain' });
        continue outer;
      }
    }
    for (const o of acceptedRings) {
      if (!overlaps(bb, o.b)) continue;
      if (intersectPaths(path, o.path).some((p) => Math.abs(pathAreaWorld(p)) > 1e-9)) {
        rejected.push({ id: b.id, reason: 'overlaps building' });
        continue outer;
      }
    }
    accepted.push(b);
    acceptedRings.push({ b: bb, path });
  }
  return { accepted, rejected };
}
