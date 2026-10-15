/**
 * Even-odd scanline fill of rings into a cell grid (`res` cells per world unit). A cell is set
 * when its center is inside. Rings are flat [x, y, ...] in world units.
 */
export function scanlineFill(rings: readonly ArrayLike<number>[], w: number, h: number, res: number, out: Uint8Array, value = 1): void {
  const rows: number[][] = Array.from({ length: h }, () => []);
  for (const r of rings) {
    const n = r.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const x0 = r[j], y0 = r[j + 1], x1 = r[i], y1 = r[i + 1];
      if (y0 === y1) continue;
      const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
      const j0 = Math.max(0, Math.ceil(ya * res - 0.5));
      const j1 = Math.min(h - 1, Math.ceil(yb * res - 0.5) - 1);
      for (let row = j0; row <= j1; row++) {
        const yc = (row + 0.5) / res;
        rows[row].push(x0 + ((yc - y0) * (x1 - x0)) / (y1 - y0));
      }
    }
  }
  for (let row = 0; row < h; row++) {
    const xs = rows[row];
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const base = row * w;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] * res - 0.5));
      const i1 = Math.min(w - 1, Math.ceil(xs[k + 1] * res - 0.5) - 1);
      for (let i = i0; i <= i1; i++) out[base + i] = value;
    }
  }
}

/**
 * Signed distance field (world units, negative inside) from a binary mask, via two exact
 * Euclidean distance transforms (Felzenszwalb & Huttenlocher). Distances are between cell
 * centers, offset by half a cell so the zero level sits on the boundary between cells.
 */
export function signedDistanceField(mask: Uint8Array, w: number, h: number, res: number): Float32Array {
  const INF = 1e20;
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const grid = new Float64Array(w * h);

  const edt = (featureValue: number, out: Float64Array): void => {
    for (let i = 0; i < w * h; i++) grid[i] = mask[i] === featureValue ? 0 : INF;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
      edt1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
      edt1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) out[y * w + x] = d[x];
    }
  };

  const toInside = new Float64Array(w * h);
  const toOutside = new Float64Array(w * h);
  edt(1, toInside);
  edt(0, toOutside);
  const sdf = new Float32Array(w * h);
  const half = 0.5;
  for (let i = 0; i < w * h; i++) {
    sdf[i] = mask[i] ? -(Math.sqrt(toOutside[i]) - half) / res : (Math.sqrt(toInside[i]) - half) / res;
  }
  return sdf;
}

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}
