/** World edits: building placement and removal (navmesh, occupancy and clients kept in sync). */
import { pointInRing, type Polygon } from '../shared/geometry';
import type { BuildingDef } from '../shared/mapFormat';
import { buildingRing } from './map/normalize';
import type { World } from './world';

export function placeBuilding(world: World, x: number, y: number, w: number, h: number, faction: number, type: string): string | null {
  const snapHalf = (v: number): number => Math.round(v * 2) / 2;
  // Centers snap so edges land on half-units for even and odd sizes alike.
  const cx = snapHalf(x - (w % 2) / 2) + (w % 2) / 2, cy = snapHalf(y - (h % 2) / 2) + (h % 2) / 2;
  const def: BuildingDef = { id: `p${world.tick}:${cx},${cy}`, faction, type, center: [cx, cy], size: [w, h], rot: 0 };
  const ring = buildingRing(def);
  const m = world.map;
  const reason = m.placement.check(ring);
  if (reason) {
    world.events.push({ type: 'notice', text: `Can't place here: ${reason}` });
    return reason;
  }
  m.placement.add(def.id, ring);
  m.buildings.push(def);
  m.buildingRings.push(ring);
  world.nav.addObstacle(ring);
  afterBuildingsChanged(world);
  return null;
}

export function removeBuildingAt(world: World, x: number, y: number): boolean {
  const m = world.map;
  const i = m.buildingRings.findIndex((r) => pointInRing(r, x, y));
  if (i < 0) return false;
  const ring = m.buildingRings[i];
  world.nav.removeObstacle(ring);
  m.placement.remove(m.buildings[i].id);
  m.buildings.splice(i, 1);
  m.buildingRings.splice(i, 1);
  afterBuildingsChanged(world);
  return true;
}

function afterBuildingsChanged(world: World): void {
  const m = world.map;
  m.occupancy.rebuild(m.terrain as Polygon[], m.buildingRings);
  world.events.push({ type: 'buildings', buildings: m.buildings.slice() });
  const st = world.nav.stats;
  world.events.push({ type: 'notice', text: `Navmesh updated in ${st.lastUpdateMs.toFixed(2)} ms · ${st.triangles} triangles` });
}
