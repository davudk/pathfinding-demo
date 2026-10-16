import { describe, expect, it } from 'vitest';
import { NavMesh, RADIUS_CLASSES } from '../src/sim/nav/navmesh';
import { CLEARANCE_TOLERANCE, PathSearch, type PathResult } from '../src/sim/nav/astar';
import { clearance, isValidPosition, snapToWalkable } from '../src/sim/nav/query';
import { generateMap } from '../src/sim/map/generate';
import { loadWorldMap } from '../src/sim/map/worldMap';
import { rectRing } from '../src/shared/geometry';
import { Rng } from '../src/shared/rng';

/** Smallest clearance along the path polyline (sampled every 0.05 units). */
function minClearance(nav: NavMesh, p: PathResult, r: number): { d: number; x: number; y: number } {
  let worst = { d: Infinity, x: 0, y: 0 };
  const pts = p.points;
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2], ay = pts[i - 1], bx = pts[i], by = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.05));
    for (let k = 0; k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
      const d = clearance(nav, x, y, r + 0.5).dist;
      if (d < worst.d) worst = { d, x, y };
    }
  }
  return worst;
}

describe('pathfinding on a small map', () => {
  // A wall across the map with a 3-wide gap: x ∈ [30, 34], gap y ∈ [30, 33].
  const wall1 = rectRing(32, 15, 4, 30); // y 0..30 (touching the top margin is not allowed, so 1..)
  const wall2 = rectRing(32, 48.5, 4, 31); // y 33..64
  const nav = NavMesh.build(64, 64, [{ rings: [new Float64Array([30, 0, 34, 0, 34, 30, 30, 30])] }, { rings: [new Float64Array([30, 33, 34, 33, 34, 64, 30, 64])] }], []);
  const search = new PathSearch(nav);
  void wall1; void wall2;

  it('routes through the gap with clearance', () => {
    const r = 0.5;
    const p = search.find({ sx: 10, sy: 10, gx: 54, gy: 54, r })!;
    expect(p.complete).toBe(true);
    expect(minClearance(nav, p, r).d).toBeGreaterThanOrEqual(r - CLEARANCE_TOLERANCE);
    // Must pass through the gap.
    let through = false;
    for (let i = 0; i < p.points.length; i += 2) if (p.points[i] > 29 && p.points[i] < 35 && p.points[i + 1] > 30 && p.points[i + 1] < 33) through = true;
    expect(through).toBe(true);
  });

  it('refuses a gap narrower than the unit', () => {
    const p = search.find({ sx: 10, sy: 10, gx: 54, gy: 54, r: 1.6 })!;
    expect(p.complete).toBe(false);
    // Ends on the start side, as close as it can get.
    expect(p.points[p.points.length - 2]).toBeLessThan(30);
  });

  it('snaps points inside obstacles to the nearest valid spot', () => {
    const s = snapToWalkable(nav, 31, 10, 0.5)!;
    expect(s).not.toBeNull();
    expect(isValidPosition(nav, s[0], s[1], 0.5)).toBe(true);
    expect(Math.abs(s[0] - 29.5)).toBeLessThan(0.1);
  });
});

describe('pathfinding on the generated map', () => {
  const g = generateMap(1337);
  const wm = loadWorldMap(g.map, g.mainPoint);
  const nav = NavMesh.build(wm.width, wm.height, wm.terrain, wm.buildingRings);
  const search = new PathSearch(nav);
  const zone = (name: string): readonly number[] => wm.data.zones.find((z) => z.name === name)!.rect;

  it('small units take the 2-wide gap, colossals detour', () => {
    const [ox, oy] = zone('Chokepoints');
    const q = (r: number): PathResult => {
      const s = snapToWalkable(nav, ox + 100, oy + 39, r)!, t = snapToWalkable(nav, ox + 135, oy + 39, r)!;
      return search.find({ sx: s[0], sy: s[1], gx: t[0], gy: t[1], r })!;
    };
    const small = q(0.375), big = q(2.0);
    expect(small.complete).toBe(true);
    expect(big.complete).toBe(true);
    expect(small.length).toBeLessThan(45);
    expect(big.length).toBeGreaterThan(100);
    expect(minClearance(nav, small, 0.375).d).toBeGreaterThanOrEqual(0.375 - CLEARANCE_TOLERANCE);
    expect(minClearance(nav, big, 2).d).toBeGreaterThanOrEqual(2 - CLEARANCE_TOLERANCE);
  });

  it('colossals cannot enter the red base enclosure', () => {
    const [ox, oy] = zone('Red Base');
    const goal = snapToWalkable(nav, ox + 95, oy + 85, 2)!;
    const p = search.find({ sx: 76, sy: 100, gx: goal[0], gy: goal[1], r: 2 })!;
    expect(p.complete).toBe(false);
    const small = snapToWalkable(nav, ox + 95, oy + 85, 0.375)!;
    expect(search.find({ sx: 76, sy: 100, gx: small[0], gy: small[1], r: 0.375 })!.complete).toBe(true);
  });

  it('fuzz: random valid queries yield clear paths for every radius class', () => {
    const rng = new Rng(Number(process.env.SEED ?? 5));
    let total = 0, ms = 0, worstMs = 0, complete = 0, grazing = 0;
    for (let i = 0; i < Number(process.env.N ?? 160); i++) {
      const r = RADIUS_CLASSES[rng.int(RADIUS_CLASSES.length)];
      const a = snapToWalkable(nav, rng.range(5, wm.width - 5), rng.range(5, wm.height - 5), r, 20);
      const b = snapToWalkable(nav, rng.range(5, wm.width - 5), rng.range(5, wm.height - 5), r, 20);
      if (!a || !b) continue;
      const t0 = performance.now();
      const p = search.find({ sx: a[0], sy: a[1], gx: b[0], gy: b[1], r });
      const dt = performance.now() - t0;
      ms += dt;
      worstMs = Math.max(worstMs, dt);
      total++;
      expect(p).not.toBeNull();
      if (!p) continue;
      if (p.complete) complete++;
      if (!p.clear) grazing++;
      if (!p.clear) continue;
      const w = minClearance(nav, p, r);
      expect(w.d, `query ${i} r=${r} (${a}) → (${b}) worst at ${w.x.toFixed(2)},${w.y.toFixed(2)}`).toBeGreaterThanOrEqual(r - CLEARANCE_TOLERANCE);
      expect(p.length + 1e-6).toBeGreaterThanOrEqual(Math.hypot(b[0] - a[0], b[1] - a[1]) * (p.complete ? 1 : 0));
    }
    expect(grazing).toBeLessThanOrEqual(Math.ceil(total * 0.02));
    console.info(`[path fuzz] ${total} queries, ${complete} complete, ${grazing} grazing, avg ${(ms / total).toFixed(2)} ms, worst ${worstMs.toFixed(2)} ms`);
  });
});
