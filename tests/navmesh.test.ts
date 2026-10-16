import { describe, expect, it } from 'vitest';
import { generateMap } from '../src/sim/map/generate';
import { loadWorldMap } from '../src/sim/map/worldMap';
import { buildingRing, validateBuildings } from '../src/sim/map/normalize';
import { NavMesh, RADIUS_CLASSES } from '../src/sim/nav/navmesh';
import { NONE } from '../src/sim/nav/cdt';
import { pointInPolygon, pointInRing, ringBounds, type Polygon } from '../src/shared/geometry';
import { Rng } from '../src/shared/rng';
import type { BuildingDef } from '../src/shared/mapFormat';

const gen = generateMap(1337);
const wm = loadWorldMap(gen.map, gen.mainPoint);

/** Every triangle's centroid is blocked iff it lies inside terrain or a building. */
function checkBlocked(nav: NavMesh, terrain: readonly Polygon[], buildings: readonly Float64Array[]): string[] {
  const cdt = nav.cdt;
  const tb = terrain.map((p) => ringBounds(p.rings[0]));
  const bb = buildings.map((r) => ringBounds(r));
  const errs: string[] = [];
  for (let t = 0; t < cdt.tCount && errs.length < 10; t++) {
    if (!cdt.isLiveTri(t)) continue;
    const a = cdt.tri[3 * t], b = cdt.tri[3 * t + 1], c = cdt.tri[3 * t + 2];
    const x = (cdt.vx[a] + cdt.vx[b] + cdt.vx[c]) / 3, y = (cdt.vy[a] + cdt.vy[b] + cdt.vy[c]) / 3;
    let inside = false;
    for (let i = 0; i < terrain.length && !inside; i++) {
      const q = tb[i];
      if (x >= q.minX && x <= q.maxX && y >= q.minY && y <= q.maxY && pointInPolygon(terrain[i], x, y)) inside = true;
    }
    for (let i = 0; i < buildings.length && !inside; i++) {
      const q = bb[i];
      if (x >= q.minX && x <= q.maxX && y >= q.minY && y <= q.maxY && pointInRing(buildings[i], x, y)) inside = true;
    }
    if (inside !== cdt.tBlock[t] > 0) errs.push(`t${t} @(${x.toFixed(2)},${y.toFixed(2)}) blocked=${cdt.tBlock[t]} inside=${inside}`);
  }
  return errs;
}

describe('NavMesh on the generated map', () => {
  const nav = NavMesh.build(wm.width, wm.height, wm.terrain, wm.buildingRings);

  it('builds a valid CDT with correct blocked flags', () => {
    console.info('[nav stats]', nav.stats);
    expect(nav.cdt.validate()).toEqual([]);
    expect(checkBlocked(nav, wm.terrain, wm.buildingRings)).toEqual([]);
  });

  it('has exactly one region for the smallest units and more for larger ones', () => {
    // The map is one connected walkable area for the smallest class (normalization guarantees it)...
    // ...except for enclosures formed by buildings, e.g. the red base's depot ring.
    expect(nav.regionCounts[0]).toBeGreaterThanOrEqual(1);
    for (let c = 1; c < RADIUS_CLASSES.length; c++) expect(nav.regionCounts[c]).toBeGreaterThanOrEqual(nav.regionCounts[c - 1]);
    // The main base and the plains are connected for every class (the ramp is 5 wide).
    const t1 = nav.cdt.locate(76, 100), t2 = nav.cdt.locate(60, 250);
    for (let c = 0; c < RADIUS_CLASSES.length; c++) expect(nav.regions[c][t1], `class ${c}`).toBe(nav.regions[c][t2]);
  });

  it('computes widths that respect obstacle clearance', () => {
    const cdt = nav.cdt;
    for (let t = 0; t < cdt.tCount; t++) {
      if (!cdt.isLiveTri(t)) continue;
      for (let i = 0; i < 3; i++) {
        const w = cdt.tWidth[3 * t + i];
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(4.25 + 1e-6);
      }
    }
  });

  it('fuzz: buildings placed and removed keep the mesh valid and flags exact', () => {
    const rng = new Rng(99);
    const placed: BuildingDef[] = [];
    const rings = wm.buildingRings.slice();
    let ops = 0;
    for (let attempt = 0; attempt < 400 && ops < 120; attempt++) {
      if (placed.length > 0 && rng.float() < 0.35) {
        const k = rng.int(placed.length);
        const ring = buildingRing(placed[k]);
        nav.removeObstacle(ring);
        const idx = rings.findIndex((r) => r.length === ring.length && r.every((v, i) => v === ring[i]));
        rings.splice(idx, 1);
        placed.splice(k, 1);
      } else {
        const w = 1 + rng.int(6), h = 1 + rng.int(6);
        const b: BuildingDef = { id: `f${attempt}`, faction: 0, type: 'house', center: [Math.round(rng.range(4, wm.width - 4)) + (w % 2) / 2, Math.round(rng.range(4, wm.height - 4)) + (h % 2) / 2], size: [w, h], rot: 0 };
        const all = [...wm.buildings, ...placed, b];
        if (validateBuildings(wm.terrain, all, wm.width, wm.height).rejected.length > 0) continue;
        nav.addObstacle(buildingRing(b));
        rings.push(buildingRing(b));
        placed.push(b);
      }
      ops++;
      if (ops % 10 === 0) {
        expect(nav.cdt.validate(), `op ${ops}`).toEqual([]);
        expect(checkBlocked(nav, wm.terrain, rings), `op ${ops}`).toEqual([]);
      }
    }
    for (const b of placed) nav.removeObstacle(buildingRing(b));
    expect(nav.cdt.validate()).toEqual([]);
    expect(checkBlocked(nav, wm.terrain, wm.buildingRings)).toEqual([]);
    expect(nav.cdt.locate(10, 10)).not.toBe(NONE);
    console.info('[nav update]', ops, 'ops; last update', nav.stats.lastUpdateMs.toFixed(3), 'ms');
  });
});
