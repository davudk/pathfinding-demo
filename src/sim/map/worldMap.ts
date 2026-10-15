import type { Polygon } from '../../shared/geometry';
import type { BuildingDef, MapData } from '../../shared/mapFormat';
import type { MapRenderData } from '../../shared/protocol';
import { buildingRing, normalizeTerrain, validateBuildings } from './normalize';
import { Occupancy } from './occupancy';

/** The loaded, normalized map the simulation runs on. */
export interface WorldMap {
  readonly data: MapData;
  readonly width: number;
  readonly height: number;
  readonly terrain: Polygon[];
  readonly buildings: BuildingDef[];
  readonly buildingRings: Float64Array[];
  readonly occupancy: Occupancy;
  readonly stats: MapRenderData['stats'];
}

export function loadWorldMap(data: MapData, mainPoint?: readonly [number, number]): WorldMap {
  const t0 = performance.now();
  const [W, H] = data.size;
  const norm = normalizeTerrain(data, mainPoint);
  const t1 = performance.now();
  const check = validateBuildings(norm.polygons, data.buildings, W, H);
  const buildingRings = check.accepted.map(buildingRing);
  const occupancy = new Occupancy(W, H);
  occupancy.rebuild(norm.polygons, buildingRings);
  const t2 = performance.now();
  return {
    data,
    width: W,
    height: H,
    terrain: norm.polygons,
    buildings: check.accepted,
    buildingRings,
    occupancy,
    stats: {
      terrainPolygons: norm.polygons.length,
      terrainVertices: norm.vertexCount,
      filledPockets: norm.filledPockets,
      buildings: check.accepted.length,
      rejectedBuildings: check.rejected.length,
      normalizeMs: t1 - t0,
      totalMs: t2 - t0,
    },
  };
}

export function mapRenderData(m: WorldMap): MapRenderData {
  return {
    name: m.data.name,
    terrain: m.terrain.map((p) => ({ rings: p.rings.map((r) => new Float64Array(r)) })),
    buildings: m.buildings,
    zones: m.data.zones,
    stats: m.stats,
  };
}
