/**
 * Thin wrappers over Clipper2 in lattice space: world coordinates × LATTICE are integers,
 * so Clipper's 64-bit integer engine operates exactly on our lattice points.
 */
import {
  ClipType, EndType, FillRule, JoinType, PolyTree64,
  booleanOpWithPolyTree, inflatePaths, simplifyPaths, union, difference, intersect,
  type Path64, type Paths64, type PolyPath64,
} from 'clipper2-ts';
import { LATTICE, type Polygon } from '../../shared/geometry';

export { FillRule, JoinType, EndType };
export type { Paths64 };

export function ringToPath(r: ArrayLike<number>): Path64 {
  const p: Path64 = [];
  for (let i = 0; i + 1 < r.length; i += 2) p.push({ x: Math.round(r[i] * LATTICE), y: Math.round(r[i + 1] * LATTICE) });
  return p;
}

export function ringsToPaths(rings: readonly ArrayLike<number>[]): Paths64 {
  return rings.map(ringToPath);
}

export function pathToRing(p: Path64): Float64Array {
  const r = new Float64Array(p.length * 2);
  for (let i = 0; i < p.length; i++) {
    r[2 * i] = p[i].x / LATTICE;
    r[2 * i + 1] = p[i].y / LATTICE;
  }
  return r;
}

export function rectPath(x0: number, y0: number, x1: number, y1: number): Path64 {
  return ringToPath([x0, y0, x1, y0, x1, y1, x0, y1]);
}

export const unionPaths = (a: Paths64, fill: FillRule = FillRule.NonZero): Paths64 => union(a, fill);
export const unionTwo = (a: Paths64, b: Paths64): Paths64 => union(a, b, FillRule.NonZero);
export const subtract = (a: Paths64, b: Paths64): Paths64 => difference(a, b, FillRule.NonZero);
export const intersectPaths = (a: Paths64, b: Paths64): Paths64 => intersect(a, b, FillRule.NonZero);

/** Offsets closed paths by `delta` world units (positive grows). Miter joins keep corners crisp. */
export function offset(paths: Paths64, delta: number, join: JoinType = JoinType.Miter): Paths64 {
  return inflatePaths(paths, delta * LATTICE, join, EndType.Polygon, 2.5, 0.25 * LATTICE);
}

/** Thickens open polylines (flat [x,y,...]) into closed areas of total width `width`. */
export function strokePolyline(pts: ArrayLike<number>, width: number, end: EndType = EndType.Round): Paths64 {
  return inflatePaths([ringToPath(pts)], (width / 2) * LATTICE, JoinType.Round, end, 2, 0.1 * LATTICE);
}

/** Morphological closing: fills gaps and notches narrower than 2·r. */
export function close(paths: Paths64, r: number): Paths64 {
  return offset(offset(paths, r), -r);
}

/** Morphological opening: removes features thinner than 2·r. */
export function open(paths: Paths64, r: number): Paths64 {
  return offset(offset(paths, -r), r);
}

export function simplify(paths: Paths64, epsilon: number): Paths64 {
  return simplifyPaths(paths, epsilon * LATTICE, true);
}

/** Absolute area in world units² of a Clipper path. */
export function pathAreaWorld(p: Path64): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j].x * p[i].y - p[i].x * p[j].y;
  return a / 2 / (LATTICE * LATTICE);
}

/**
 * Builds a PolyTree from paths (NonZero union) and flattens it into polygons with holes.
 * Outer rings get positive area, holes negative (see shared/geometry.ts).
 */
export function toPolygons(paths: Paths64, fill: FillRule = FillRule.NonZero): Polygon[] {
  const tree = new PolyTree64();
  booleanOpWithPolyTree(ClipType.Union, paths, null, tree, fill);
  const out: Polygon[] = [];
  const visitOuter = (node: PolyPath64): void => {
    const poly = node.poly;
    if (!poly) return;
    const rings = [orient(pathToRing(poly), true)];
    for (let h = 0; h < node.count; h++) {
      const hole = node.child(h);
      if (hole.poly) rings.push(orient(pathToRing(hole.poly), false));
      for (let k = 0; k < hole.count; k++) visitOuter(hole.child(k));
    }
    out.push({ rings });
  };
  for (let i = 0; i < tree.count; i++) visitOuter(tree.child(i));
  return out;
}

export function polygonsToPaths(polys: readonly Polygon[]): Paths64 {
  const out: Paths64 = [];
  for (const p of polys) for (const r of p.rings) out.push(ringToPath(r));
  return out;
}

function orient(r: Float64Array, outer: boolean): Float64Array {
  let a = 0;
  const n = r.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1];
  if (a > 0 === outer) return r;
  const rev = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    rev[i] = r[n - 2 - i];
    rev[i + 1] = r[n - 1 - i];
  }
  return rev;
}
