/**
 * World edits at runtime: buildings (incremental navmesh update) and terrain shapes (full
 * rebuild). After every edit: units caught inside new obstacles are ejected to the nearest
 * spot they fit; only paths and fields that touch the edited area are invalidated; the
 * occupancy raster is patched locally; clients get the new geometry.
 */
import { pointInRing, ringBounds, type Bounds } from '../shared/geometry';
import type { BuildingDef, TerrainShape } from '../shared/mapFormat';
import { buildingRing, normalizeTerrain, PlacementChecker } from './map/normalize';
import { ringsToPaths, subtract, pathToRing, unionPaths } from './map/clip';
import { isValidPosition, snapToWalkable } from './nav/query';
import type { World } from './world';

export function placeBuilding(world: World, def: BuildingDef): string | null {
  const ring = buildingRing(def);
  const m = world.map;
  if (m.buildings.some((b) => b.id === def.id)) return 'duplicate id';
  const reason = m.placement.check(ring);
  if (reason) {
    world.events.push({ type: 'notice', text: `Can't place here: ${reason}` });
    world.events.push({ type: 'editRejected', id: def.id });
    return reason;
  }
  m.placement.add(def.id, ring);
  m.buildings.push(def);
  m.buildingRings.push(ring);
  world.nav.addObstacle(ring);
  afterLocalEdit(world, ringBounds(ring));
  return null;
}

export function removeBuilding(world: World, id: string): boolean {
  const m = world.map;
  const i = m.buildings.findIndex((b) => b.id === id);
  if (i < 0) return false;
  const ring = m.buildingRings[i];
  world.nav.removeObstacle(ring);
  m.placement.remove(id);
  m.buildings.splice(i, 1);
  m.buildingRings.splice(i, 1);
  afterLocalEdit(world, ringBounds(ring));
  return true;
}

export function buildingAt(world: World, x: number, y: number): BuildingDef | null {
  const m = world.map;
  const i = m.buildingRings.findIndex((r) => pointInRing(r, x, y));
  return i < 0 ? null : m.buildings[i];
}

/** Snaps a building center so its edges land on half units for any (integer) size. */
export function snapBuildingCenter(x: number, y: number, w: number, h: number): [number, number] {
  const snapHalf = (v: number): number => Math.round(v * 2) / 2;
  return [snapHalf(x - (w % 2) / 2) + (w % 2) / 2, snapHalf(y - (h % 2) / 2) + (h % 2) / 2];
}

function afterLocalEdit(world: World, footprint: Bounds): void {
  const t0 = performance.now();
  const m = world.map;
  world.walls.rebuild(world.nav);
  m.occupancy.rebuildRegion(m.terrain, m.buildingRings, footprint);
  const resetFields = world.fields.onMeshEdit(world.nav.lastDirtyTris);
  const ejected = ejectUnits(world, footprint);
  const repaths = invalidatePaths(world, footprint);
  world.events.push({ type: 'buildings', buildings: m.buildings.slice() });
  const ms = performance.now() - t0 + world.nav.stats.lastUpdateMs;
  world.events.push({
    type: 'notice',
    text: `Edit applied in ${ms.toFixed(1)} ms · ${ejected} ejected · ${repaths} repaths · ${resetFields} fields restarted`,
  });
}

/**
 * Applies a terrain change — add a shape, or remove one by id — re-normalizes the terrain
 * and rebuilds the navmesh. Added rock is clipped around existing buildings; buildings that
 * end up overlapping terrain (e.g. undoing a carve) are removed.
 */
export function editTerrain(world: World, change: { add: TerrainShape } | { removeId: string }): string | null {
  const t0 = performance.now();
  const m = world.map;
  let list = m.data.terrain.slice();
  if ('add' in change) {
    let shape = change.add;
    if (shape.op === 'add' && m.buildingRings.length) {
      // Keep buildings intact: carve their footprints out of new rock.
      const clipped = subtract(unionPaths(ringsToPaths(shape.rings)), ringsToPaths(m.buildingRings)).map((p) => Array.from(pathToRing(p)));
      if (clipped.length === 0) return 'nothing left after clipping';
      shape = { ...shape, rings: clipped };
    }
    list.push(shape);
  } else {
    const before = list.length;
    list = list.filter((s) => s.id !== change.removeId);
    if (list.length === before) return 'no such shape';
  }
  const data = { ...m.data, terrain: list };
  const norm = normalizeTerrain(data, m.mainPoint);
  m.data = data;
  m.terrain = norm.polygons;
  // Buildings that now overlap terrain go away.
  const placement = new PlacementChecker(norm.polygons, m.width, m.height);
  const removed: string[] = [];
  for (let i = m.buildings.length - 1; i >= 0; i--) {
    if (placement.check(m.buildingRings[i]) === 'overlaps terrain') {
      removed.push(m.buildings[i].id);
      m.buildings.splice(i, 1);
      m.buildingRings.splice(i, 1);
    }
  }
  m.buildings.forEach((b, i) => placement.add(b.id, m.buildingRings[i]));
  m.placement = placement;
  m.occupancy.rebuild(m.terrain, m.buildingRings);
  world.nav.rebuild(m.terrain, m.buildingRings);
  world.walls.rebuild(world.nav);
  world.fields.onMeshEdit(null);
  const ejected = ejectUnits(world, null);
  const repaths = invalidatePaths(world, null);
  world.events.push({ type: 'terrain', terrain: m.terrain.map((p) => ({ rings: p.rings.map((r) => new Float64Array(r)) })) });
  world.events.push({ type: 'buildings', buildings: m.buildings.slice() });
  const ms = performance.now() - t0;
  world.events.push({
    type: 'notice',
    text: `Terrain rebuilt in ${ms.toFixed(0)} ms · ${world.nav.stats.triangles} triangles · ${ejected} ejected · ${repaths} repaths${removed.length ? ` · ${removed.length} buildings removed` : ''}`,
  });
  return null;
}

/** Moves units that no longer fit where they stand to the nearest free spot. */
function ejectUnits(world: World, box: Bounds | null): number {
  const { units: u, nav } = world;
  let n = 0;
  for (let k = 0; k < u.count; k++) {
    const i = u.active[k];
    const x = u.posX[i], y = u.posY[i], r = u.radius[i];
    if (box && (x + r < box.minX || x - r > box.maxX || y + r < box.minY || y - r > box.maxY)) continue;
    if (isValidPosition(nav, x, y, r * 0.9)) continue;
    const p = snapToWalkable(nav, x, y, r, 24);
    if (!p) continue;
    u.posX[i] = p[0];
    u.posY[i] = p[1];
    u.velX[i] = 0;
    u.velY[i] = 0;
    u.navTri[i] = -1;
    n++;
  }
  return n;
}

/**
 * Units whose remaining route crosses the edited area replan: individual paths are
 * re-requested; field followers drop their local corridor so it's re-read this tick.
 * With `box === null` (terrain rebuild) every route is affected.
 */
function invalidatePaths(world: World, box: Bounds | null): number {
  const { units: u, paths } = world;
  let n = 0;
  for (let k = 0; k < u.count; k++) {
    const i = u.active[k];
    const pts = paths.points[i];
    if (!pts && !paths.pending[i]) continue;
    if (box && pts && !polylineHitsBox(pts, paths.cursor[i], u.posX[i], u.posY[i], box, u.radius[i] + 0.1)) continue;
    if (box && !pts) continue;
    n++;
    if (u.fieldId[i] !== 0) {
      paths.points[i] = null;
      paths.pending[i] = 1;
    } else {
      world.pathQueue.request(u.handleOf(i), u.goalX[i], u.goalY[i]);
    }
  }
  return n;
}

/** Whether the remaining polyline (from the unit through pts[cursor..]) passes within pad of box. */
function polylineHitsBox(pts: Float64Array, cursor: number, x: number, y: number, b: Bounds, pad: number): boolean {
  let ax = x, ay = y;
  const minX = b.minX - pad, minY = b.minY - pad, maxX = b.maxX + pad, maxY = b.maxY + pad;
  for (let k = Math.max(1, cursor); k < pts.length >> 1; k++) {
    const bx = pts[2 * k], by = pts[2 * k + 1];
    if (segmentHitsBox(ax, ay, bx, by, minX, minY, maxX, maxY)) return true;
    ax = bx;
    ay = by;
  }
  return false;
}

/** Liang–Barsky segment vs axis-aligned box. */
function segmentHitsBox(x0: number, y0: number, x1: number, y1: number, minX: number, minY: number, maxX: number, maxY: number): boolean {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, x0 - minX) && clip(dx, maxX - x0) && clip(-dy, y0 - minY) && clip(dy, maxY - y0);
}
