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

  /**
   * Re-rasterizes only the cells inside `box` (world units, padded), from the obstacles that
   * touch it — cheap enough to run on every building edit.
   */
  rebuildRegion(terrain: readonly Polygon[], extraRings: readonly Float64Array[], box: { minX: number; minY: number; maxX: number; maxY: number }): void {
    const pad = 1;
    const i0 = Math.max(0, Math.floor((box.minX - pad) * OCC_RES)), i1 = Math.min(this.w - 1, Math.ceil((box.maxX + pad) * OCC_RES));
    const j0 = Math.max(0, Math.floor((box.minY - pad) * OCC_RES)), j1 = Math.min(this.h - 1, Math.ceil((box.maxY + pad) * OCC_RES));
    if (i1 < i0 || j1 < j0) return;
    const x0 = i0 / OCC_RES, y0 = j0 / OCC_RES, x1 = (i1 + 1) / OCC_RES, y1 = (j1 + 1) / OCC_RES;
    const touches = (r: ArrayLike<number>): boolean => {
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (let k = 0; k < r.length; k += 2) {
        a = Math.min(a, r[k]);
        c = Math.max(c, r[k]);
        b = Math.min(b, r[k + 1]);
        d = Math.max(d, r[k + 1]);
      }
      return a <= x1 + 1 && c >= x0 - 1 && b <= y1 + 1 && d >= y0 - 1;
    };
    const paths: Paths64 = [];
    for (const p of terrain) if (touches(p.rings[0])) for (const r of p.rings) paths.push(ringToPath(r));
    for (const r of extraRings) if (touches(r)) paths.push(ringToPath(r));
    const rw = i1 - i0 + 1, rh = j1 - j0 + 1;
    const tmp = new Uint8Array(rw * rh);
    if (paths.length) {
      // Translate into the region's frame and fill.
      const rings = offset(paths, Math.SQRT1_2 / OCC_RES).map((p) => {
        const r = pathToRing(p);
        for (let k = 0; k < r.length; k += 2) {
          r[k] -= x0;
          r[k + 1] -= y0;
        }
        return r;
      });
      scanlineFill(rings, rw, rh, OCC_RES, tmp);
    }
    for (let j = 0; j < rh; j++) this.blocked.set(tmp.subarray(j * rw, (j + 1) * rw), (j0 + j) * this.w + i0);
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
