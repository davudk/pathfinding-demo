/**
 * Conservative blocked-cell raster (2 cells per world unit). Obstacles are inflated by half a
 * cell diagonal before rasterizing, so any cell touching an obstacle counts as blocked.
 * Used for spawn placement and quick "is this spot clear" checks; exact geometry lives in
 * the navmesh.
 */
import type { Polygon } from '../../shared/geometry';
import { scanlineFill } from '../../shared/raster';
import { offset, pathToRing, polygonsToPaths, ringToPath, type Paths64 } from './clip';

export const OCC_RES = 2;

export class Occupancy {
  readonly w: number;
  readonly h: number;
  readonly blocked: Uint8Array;

  constructor(readonly mapW: number, readonly mapH: number) {
    this.w = Math.ceil(mapW * OCC_RES);
    this.h = Math.ceil(mapH * OCC_RES);
    this.blocked = new Uint8Array(this.w * this.h);
  }

  /** Rebuilds from terrain polygons plus extra rings (building footprints). */
  rebuild(terrain: readonly Polygon[], extraRings: readonly Float64Array[]): void {
    this.blocked.fill(0);
    const paths: Paths64 = polygonsToPaths(terrain);
    for (const r of extraRings) paths.push(ringToPath(r));
    const inflated = offset(paths, Math.SQRT1_2 / OCC_RES);
    scanlineFill(inflated.map(pathToRing), this.w, this.h, OCC_RES, this.blocked);
  }

  /** True when no blocked cell center lies within r of (x, y) and the circle is inside the map. */
  isFreeCircle(x: number, y: number, r: number): boolean {
    if (x - r < 0 || y - r < 0 || x + r > this.mapW || y + r > this.mapH) return false;
    const i0 = Math.max(0, Math.floor((x - r) * OCC_RES));
    const i1 = Math.min(this.w - 1, Math.floor((x + r) * OCC_RES));
    const j0 = Math.max(0, Math.floor((y - r) * OCC_RES));
    const j1 = Math.min(this.h - 1, Math.floor((y + r) * OCC_RES));
    const r2 = (r + 0.5 / OCC_RES) * (r + 0.5 / OCC_RES);
    for (let j = j0; j <= j1; j++) {
      const dy = (j + 0.5) / OCC_RES - y;
      const base = j * this.w;
      for (let i = i0; i <= i1; i++) {
        if (this.blocked[base + i] === 0) continue;
        const dx = (i + 0.5) / OCC_RES - x;
        if (dx * dx + dy * dy <= r2) return false;
      }
    }
    return true;
  }

  isBlockedAt(x: number, y: number): boolean {
    const i = Math.floor(x * OCC_RES), j = Math.floor(y * OCC_RES);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return true;
    return this.blocked[j * this.w + i] === 1;
  }
}
