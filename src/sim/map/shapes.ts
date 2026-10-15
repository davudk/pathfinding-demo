/** Shape builders for map generation. All return rings as flat [x, y, ...] arrays. */
import type { Rng } from '../../shared/rng';
import { TAU } from '../../shared/math';
import { snap } from '../../shared/geometry';

/** Axis-aligned rectangle. */
export function rect(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

/** Irregular convex-ish polygon ("boulder") around (cx, cy). */
export function boulder(rng: Rng, cx: number, cy: number, r: number, sides: number, jitter: number): number[] {
  const out: number[] = [];
  const phase = rng.range(0, TAU);
  for (let k = 0; k < sides; k++) {
    const a = phase + (k / sides) * TAU + rng.range(-0.25, 0.25) * (TAU / sides);
    const rr = r * (1 + rng.range(-jitter, jitter));
    out.push(snap(cx + Math.cos(a) * rr), snap(cy + Math.sin(a) * rr));
  }
  return out;
}

/**
 * Rectangle outline whose edges are subdivided every `step` units and displaced along the
 * edge normal by `amp · n(x, y)`, giving rough rock walls. `noise` returns values in [-1, 1].
 */
export function jaggedRect(
  x0: number, y0: number, x1: number, y1: number,
  step: number, amp: number, noise: (x: number, y: number) => number,
): number[] {
  const out: number[] = [];
  const edge = (ax: number, ay: number, bx: number, by: number, nx: number, ny: number): void => {
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      // Corners stay put so adjacent edges meet cleanly.
      const d = k === 0 ? 0 : amp * noise(x * 0.11, y * 0.11);
      out.push(snap(x + nx * d), snap(y + ny * d));
    }
  };
  edge(x0, y0, x1, y0, 0, -1);
  edge(x1, y0, x1, y1, 1, 0);
  edge(x1, y1, x0, y1, 0, 1);
  edge(x0, y1, x0, y0, -1, 0);
  return out;
}

/** Archimedean spiral polyline from radius r0 to r1 over `turns` turns. */
export function spiral(cx: number, cy: number, r0: number, r1: number, turns: number, startAngle: number): number[] {
  const out: number[] = [];
  const steps = Math.ceil(turns * 48);
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const a = startAngle + t * turns * TAU;
    const r = r0 + (r1 - r0) * t;
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

/** Poisson-disk-ish sampling (dart throwing with a grid) inside a rectangle. */
export function scatter(rng: Rng, x0: number, y0: number, x1: number, y1: number, minDist: number, attempts: number): number[] {
  const cell = minDist / Math.SQRT2;
  const gw = Math.ceil((x1 - x0) / cell);
  const gh = Math.ceil((y1 - y0) / cell);
  const grid = new Int32Array(gw * gh).fill(-1);
  const pts: number[] = [];
  for (let n = 0; n < attempts; n++) {
    const x = rng.range(x0, x1);
    const y = rng.range(y0, y1);
    const gx = Math.floor((x - x0) / cell);
    const gy = Math.floor((y - y0) / cell);
    let ok = true;
    for (let j = Math.max(0, gy - 2); ok && j <= Math.min(gh - 1, gy + 2); j++) {
      for (let i = Math.max(0, gx - 2); i <= Math.min(gw - 1, gx + 2); i++) {
        const k = grid[j * gw + i];
        if (k >= 0 && (pts[2 * k] - x) ** 2 + (pts[2 * k + 1] - y) ** 2 < minDist * minDist) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) continue;
    grid[gy * gw + gx] = pts.length / 2;
    pts.push(x, y);
  }
  return pts;
}
