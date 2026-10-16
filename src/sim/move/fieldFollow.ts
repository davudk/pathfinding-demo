/**
 * Units on a destination field don't own a full path. Every few ticks (staggered), each one
 * reads a short corridor off its field — the next triangles toward the goal — and funnels it
 * into a local path that locomotion follows like any other. Near its own slot target the
 * unit switches to a short individual A* path for the last mile.
 */
import { buildCorridor } from '../nav/astar';
import { NONE } from '../nav/cdt';
import { funnel } from '../nav/funnel';
import { MoveState } from '../store/units';
import type { World } from '../world';

/** Triangles of look-ahead per refresh. */
const LOOKAHEAD = 24;
/** Ticks between periodic refreshes (staggered by unit). */
const REFRESH_TICKS = 6;
/** Switch to an individual path when this close (world units) to the unit's own goal. */
const LAST_MILE = 10;

export function detachField(world: World, i: number): void {
  const id = world.units.fieldId[i];
  if (id === 0) return;
  world.fields.release(id);
  world.units.fieldId[i] = 0;
}

export function updateFieldFollowers(world: World): void {
  const { units: u, paths, fields, nav } = world;
  const cdt = nav.cdt;
  const tick = world.tick;
  const chain: number[] = [];
  for (let k = 0; k < u.count; k++) {
    const i = u.active[k];
    const id = u.fieldId[i];
    if (id === 0) continue;
    if (u.state[i] !== MoveState.Moving) {
      detachField(world, i);
      continue;
    }
    const f = fields.get(id);
    if (!f) {
      u.fieldId[i] = 0;
      continue;
    }
    const pts = paths.points[i];
    const m = pts ? pts.length >> 1 : 0;
    const nearEnd = !pts || paths.cursor[i] >= m - 2;
    if (paths.locked[i] && !nearEnd) continue; // walking out a detour
    if (!nearEnd && (i + tick) % REFRESH_TICKS !== 0) continue;

    const x = u.posX[i], y = u.posY[i], r = u.radius[i];
    // Last mile: plan an exact path to the unit's own slot.
    if (Math.hypot(u.goalX[i] - x, u.goalY[i] - y) < LAST_MILE) {
      detachField(world, i);
      world.pathQueue.request(u.handleOf(i), u.goalX[i], u.goalY[i]);
      continue;
    }
    const t = cdt.locate(x, y, u.navTri[i]);
    u.navTri[i] = t;
    if (t === NONE) continue;
    if (cdt.tBlock[t] > 0) {
      // Pushed into an obstacle's footprint (e.g. a fresh building): fall back to A*.
      detachField(world, i);
      world.pathQueue.request(u.handleOf(i), u.goalX[i], u.goalY[i]);
      continue;
    }
    if (!f.settled[t]) {
      if (f.exhausted) {
        // The field will never reach this unit (other region / too narrow): individual path.
        detachField(world, i);
        world.pathQueue.request(u.handleOf(i), u.goalX[i], u.goalY[i]);
        continue;
      }
      f.need(t);
      if (!pts) paths.pending[i] = 1; // head straight for the goal meanwhile
      continue;
    }
    // Walk the field.
    chain.length = 0;
    let cur = t;
    let reached = cur === f.tg;
    for (let s = 0; s < LOOKAHEAD && !reached; s++) {
      const h = f.next[cur];
      if (h === NONE) break;
      chain.push(cdt.opp[h]); // entry halfedge of the next triangle
      cur = (cdt.opp[h] / 3) | 0;
      if (!f.settled[cur]) break;
      reached = cur === f.tg;
    }
    let ex: number, ey: number;
    if (reached) {
      ex = f.goalX;
      ey = f.goalY;
    } else {
      // End on the crossing point that leads out of the last corridor triangle.
      const last = chain.length > 0 ? (chain[chain.length - 1] / 3) | 0 : t;
      ex = f.px[last];
      ey = f.py[last];
    }
    const res = funnel(buildCorridor(cdt, chain), x, y, ex, ey, r);
    paths.set(i, res.points, true, !reached || (ex !== u.goalX[i] || ey !== u.goalY[i]));
    paths.pending[i] = 0;
  }
}
