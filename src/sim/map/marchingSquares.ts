/**
 * Marching squares over a scalar grid → closed iso-rings (flat [x, y, ...]) of the region
 * `value > threshold`. The grid border is treated as outside, so every ring closes.
 * Rings have arbitrary orientation; combine them with an even-odd fill.
 */
export function marchingSquares(
  values: Float32Array, nx: number, ny: number,
  x0: number, y0: number, cell: number, threshold: number,
): number[][] {
  const v = (i: number, j: number): number => (i < 0 || j < 0 || i >= nx || j >= ny ? -Infinity : values[j * nx + i]);

  // Edge-point ids: horizontal edge (i,j)-(i+1,j) → 2·(j·W + i); vertical (i,j)-(i,j+1) → 2·(j·W + i) + 1.
  // The padded lattice spans i, j ∈ [-1, n], hence the +1 offsets.
  const W = nx + 2;
  const hId = (i: number, j: number): number => 2 * ((j + 1) * W + (i + 1));
  const vId = (i: number, j: number): number => 2 * ((j + 1) * W + (i + 1)) + 1;
  const px = new Map<number, number>();
  const py = new Map<number, number>();
  const lerp = (a: number, b: number): number => {
    if (a === -Infinity) return 1;
    if (b === -Infinity) return 0;
    return (threshold - a) / (b - a);
  };
  const hPoint = (i: number, j: number): number => {
    const id = hId(i, j);
    if (!px.has(id)) {
      px.set(id, x0 + (i + lerp(v(i, j), v(i + 1, j))) * cell);
      py.set(id, y0 + j * cell);
    }
    return id;
  };
  const vPoint = (i: number, j: number): number => {
    const id = vId(i, j);
    if (!px.has(id)) {
      px.set(id, x0 + i * cell);
      py.set(id, y0 + (j + lerp(v(i, j), v(i, j + 1))) * cell);
    }
    return id;
  };

  // Adjacency: each edge point joins exactly two segments.
  const links = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    let la = links.get(a);
    if (!la) links.set(a, (la = []));
    la.push(b);
    let lb = links.get(b);
    if (!lb) links.set(b, (lb = []));
    lb.push(a);
  };

  for (let j = -1; j < ny; j++) {
    for (let i = -1; i < nx; i++) {
      const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1);
      const code = (a > threshold ? 1 : 0) | (b > threshold ? 2 : 0) | (c > threshold ? 4 : 0) | (d > threshold ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const top = (): number => hPoint(i, j);
      const right = (): number => vPoint(i + 1, j);
      const bottom = (): number => hPoint(i, j + 1);
      const left = (): number => vPoint(i, j);
      switch (code) {
        case 1: case 14: link(left(), top()); break;
        case 2: case 13: link(top(), right()); break;
        case 3: case 12: link(left(), right()); break;
        case 4: case 11: link(right(), bottom()); break;
        case 6: case 9: link(top(), bottom()); break;
        case 7: case 8: link(left(), bottom()); break;
        case 5: case 10: {
          // Saddle: disambiguate with the cell-center average. When the center is inside,
          // the two inside corners connect and the outside corners are cut off.
          const center = (a + b + c + d) / 4 > threshold;
          if ((code === 10) === center) {
            link(left(), top());
            link(right(), bottom());
          } else {
            link(top(), right());
            link(left(), bottom());
          }
          break;
        }
      }
    }
  }

  // Walk loops.
  const rings: number[][] = [];
  const visited = new Set<number>();
  for (const start of links.keys()) {
    if (visited.has(start)) continue;
    const ring: number[] = [];
    let prev = -1;
    let cur = start;
    for (;;) {
      visited.add(cur);
      ring.push(px.get(cur)!, py.get(cur)!);
      const nb = links.get(cur)!;
      const next = nb[0] !== prev ? nb[0] : nb[1];
      prev = cur;
      cur = next;
      if (cur === start || cur === undefined || visited.has(cur)) break;
    }
    if (ring.length >= 6) rings.push(ring);
  }
  return rings;
}
