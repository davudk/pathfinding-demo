/**
 * Geometry conventions shared by the sim and the renderer.
 *
 * - World space: +X right, +Y down, units = SC2 cells.
 * - All obstacle coordinates lie on a lattice of 1/LATTICE units, so they are exact doubles
 *   and map 1:1 onto Clipper's integer space and the navmesh's exact predicates.
 * - Rings are flat Float64Arrays [x0, y0, x1, y1, ...], implicitly closed (no repeated point).
 * - Orientation: an outer ring has POSITIVE shoelace area (Σ xᵢyᵢ₊₁ − xᵢ₊₁yᵢ > 0), which is
 *   clockwise on screen because +Y points down. Holes have negative area.
 */

export const LATTICE = 16;

export function snap(v: number): number {
  return Math.round(v * LATTICE) / LATTICE;
}

/** A polygon with holes: rings[0] is the outer ring, the rest are holes. */
export interface Polygon {
  readonly rings: readonly Float64Array[];
}

/** Twice the signed area (shoelace). Positive = outer ring orientation. */
export function ringArea2(r: ArrayLike<number>): number {
  const n = r.length;
  let a = 0;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1];
  return a;
}

export function ringArea(r: ArrayLike<number>): number {
  return ringArea2(r) / 2;
}

/** Even-odd point-in-ring test. */
export function pointInRing(r: ArrayLike<number>, x: number, y: number): boolean {
  let inside = false;
  const n = r.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const yi = r[i + 1], yj = r[j + 1];
    if (yi > y !== yj > y) {
      const xi = r[i], xj = r[j];
      if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export function pointInPolygon(p: Polygon, x: number, y: number): boolean {
  if (!pointInRing(p.rings[0], x, y)) return false;
  for (let k = 1; k < p.rings.length; k++) if (pointInRing(p.rings[k], x, y)) return false;
  return true;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function ringBounds(r: ArrayLike<number>, out: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }): Bounds {
  for (let i = 0; i < r.length; i += 2) {
    const x = r[i], y = r[i + 1];
    if (x < out.minX) out.minX = x;
    if (x > out.maxX) out.maxX = x;
    if (y < out.minY) out.minY = y;
    if (y > out.maxY) out.maxY = y;
  }
  return out;
}

/** Corners of a (possibly rotated) rectangle as a positive-area ring, snapped to the lattice. */
export function rectRing(cx: number, cy: number, w: number, h: number, rot = 0): Float64Array {
  const c = Math.cos(rot), s = Math.sin(rot);
  const hw = w / 2, hh = h / 2;
  // Positive shoelace area with +Y down: (-,-) → (+,-) → (+,+) → (-,+).
  const local = [-hw, -hh, hw, -hh, hw, hh, -hw, hh];
  const out = new Float64Array(8);
  for (let i = 0; i < 8; i += 2) {
    out[i] = snap(cx + local[i] * c - local[i + 1] * s);
    out[i + 1] = snap(cy + local[i] * s + local[i + 1] * c);
  }
  return out;
}
