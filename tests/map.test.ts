import { describe, expect, it } from 'vitest';
import { FillRule, union } from 'clipper2-ts';
import { generateMap } from '../src/sim/map/generate';
import { loadWorldMap } from '../src/sim/map/worldMap';
import { normalizeTerrain, validateBuildings } from '../src/sim/map/normalize';
import { marchingSquares } from '../src/sim/map/marchingSquares';
import { polygonsToPaths, rectPath, subtract, toPolygons } from '../src/sim/map/clip';
import { parseMap, serializeMap, MAP_FORMAT, MAP_VERSION, type MapData, type TerrainShape } from '../src/shared/mapFormat';
import { LATTICE, ringArea, pointInPolygon } from '../src/shared/geometry';
import { buildingRing } from '../src/sim/map/normalize';

function mapWith(terrain: TerrainShape[], size = 64): MapData {
  return { format: MAP_FORMAT, version: MAP_VERSION, name: 't', size: [size, size], seed: 0, terrain, buildings: [], spawns: [], routes: [], zones: [] };
}
const rectShape = (id: string, x0: number, y0: number, x1: number, y1: number, op: 'add' | 'subtract' = 'add'): TerrainShape =>
  ({ id, kind: 'rock', op, rings: [[x0, y0, x1, y0, x1, y1, x0, y1]] });

describe('marchingSquares', () => {
  it('traces a disc as one ring with the right area', () => {
    const n = 64, vals = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) vals[j * n + i] = 20 - Math.hypot(i - 32, j - 32);
    const rings = marchingSquares(vals, n, n, 0, 0, 1, 0);
    expect(rings.length).toBe(1);
    expect(Math.abs(ringArea(rings[0]))).toBeCloseTo(Math.PI * 400, -1);
  });

  it('closes rings at the grid border', () => {
    const vals = new Float32Array(16).fill(1);
    const rings = marchingSquares(vals, 4, 4, 0, 0, 1, 0.5);
    expect(rings.length).toBe(1);
    expect(Math.abs(ringArea(rings[0]))).toBeCloseTo(9);
  });
});

describe('normalizeTerrain', () => {
  it('closes gaps narrower than the smallest unit and keeps wider ones', () => {
    const narrow = normalizeTerrain(mapWith([rectShape('a', 10, 10, 20, 20), rectShape('b', 20.3, 10, 30, 20)]));
    expect(narrow.polygons.length).toBe(1);
    const wide = normalizeTerrain(mapWith([rectShape('a', 10, 10, 20, 20), rectShape('b', 20.75, 10, 30, 20)]));
    expect(wide.polygons.length).toBe(2);
  });

  it('applies subtract shapes in order', () => {
    const t = normalizeTerrain(mapWith([rectShape('a', 10, 10, 30, 30), rectShape('b', 15, 5, 20, 35, 'subtract')]));
    expect(t.polygons.length).toBe(2);
  });

  it('fills walkable pockets disconnected from the main region', () => {
    const ring: TerrainShape = { id: 'r', kind: 'wall', op: 'add', rings: [[10, 10, 40, 10, 40, 40, 10, 40], [15, 15, 35, 15, 35, 35, 15, 35]] };
    const t = normalizeTerrain(mapWith([ring]), [2, 2]);
    expect(t.filledPockets).toBe(1);
    expect(t.polygons.length).toBe(1);
    expect(t.polygons[0].rings.length).toBe(1);
    expect(pointInPolygon(t.polygons[0], 25, 25)).toBe(true);
  });
});

describe('generated map', () => {
  const gen = generateMap(1337);
  const wm = loadWorldMap(gen.map, gen.mainPoint);

  it('is deterministic per seed and round-trips through JSON', () => {
    expect(serializeMap(generateMap(1337).map)).toBe(serializeMap(gen.map));
    expect(serializeMap(generateMap(7).map)).not.toBe(serializeMap(gen.map));
    const parsed = parseMap(serializeMap(gen.map));
    expect(serializeMap(parsed)).toBe(serializeMap(gen.map));
  });

  it('produces valid lattice polygons with consistent orientation', () => {
    expect(wm.terrain.length).toBeGreaterThan(50);
    for (const p of wm.terrain) {
      expect(ringArea(p.rings[0])).toBeGreaterThan(0);
      for (let k = 1; k < p.rings.length; k++) expect(ringArea(p.rings[k])).toBeLessThan(0);
      for (const r of p.rings) for (const v of r) expect(Number.isInteger(v * LATTICE)).toBe(true);
    }
    // Normalized polygons never overlap: union area equals summed area.
    const paths = polygonsToPaths(wm.terrain);
    const sum = wm.terrain.reduce((a, p) => a + p.rings.reduce((b, r) => b + ringArea(r), 0), 0);
    const merged = toPolygons(union(paths, FillRule.NonZero)).reduce((a, p) => a + p.rings.reduce((b, r) => b + ringArea(r), 0), 0);
    expect(merged).toBeCloseTo(sum, 3);
  });

  it('leaves exactly one connected walkable region containing the main point', () => {
    const free = toPolygons(subtract([rectPath(0, 0, wm.width, wm.height)], polygonsToPaths(wm.terrain)));
    expect(free.length).toBe(1);
    expect(pointInPolygon(free[0], gen.mainPoint[0], gen.mainPoint[1])).toBe(true);
  });

  it('keeps buildings off terrain and off each other', () => {
    expect(wm.buildings.length).toBeGreaterThan(80);
    const again = validateBuildings(wm.terrain, wm.buildings, wm.width, wm.height);
    expect(again.rejected).toEqual([]);
    for (const b of wm.buildings) {
      const r = buildingRing(b);
      expect(ringArea(r)).toBeGreaterThan(0);
    }
  });

  it('reports sensible stats', () => {
    console.info('[map stats]', wm.stats);
    expect(wm.stats.totalMs).toBeLessThan(5000);
  });
});

describe('parseMap', () => {
  it('rejects malformed documents with a path', () => {
    expect(() => parseMap({ format: 'nope' })).toThrow(/map\.format/);
    expect(() => parseMap({ ...mapWith([]), terrain: [{ id: 'x', kind: 'rock', rings: [[0, 0, 1]] }] })).toThrow(/terrain\[0\]\.rings\[0\]/);
  });
});
