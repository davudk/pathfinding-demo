/**
 * Unit locomotion (SC2-style; see docs/research/02):
 *
 *   1. preferred velocity — follow the path (arrive-decel at the end), or wander (ambient)
 *   2. steering           — light separation + time-to-collision avoidance of units we can't
 *                           push (side hysteresis), acceleration-limited
 *   3. integrate + walls
 *   4. contacts           — Jacobi position solver; push priority decides who yields
 *   5. velocity           — movers keep their steered velocity (minus into-wall part);
 *                           pushed units inherit their displacement, then damp
 *   6. arrival / stuck / heading
 *
 * Everything runs over typed arrays with no per-tick allocation.
 */
import { SIM_DT } from '../../shared/constants';
import { MAX_UNIT_RADIUS } from '../../shared/archetypes';
import { turnToward } from '../../shared/math';
import { MoveState } from '../store/units';
import { SimSys } from '../../shared/profiler';
import type { World } from '../world';
import { arrive } from './orders';
import { planDetour } from './detour';

// ── Tuning (docs/research/02, §7) ────────────────────────────────────────────
const AVOID_HORIZON = 0.8; // s
const AVOID_LOOKAHEAD_MAX = 3; // world units
const W_SEP = 0.6;
const W_AVOID = 1.0;
const SIDE_HOLD_TICKS = 15; // 0.5 s
const IDLE_DAMP_TAU = 0.1; // s
const CONTACT_ITERS = 4;
const STIFFNESS = 0.8;
const OMEGA = 1.3;
const SLACK_FRAC = 0.03; // allowed soft overlap, fraction of the smaller radius
const SETTLE_TICKS = 8; // Arrived → Idle
const STUCK_WINDOW = 45; // ticks (1.5 s)
const STUCK_FRACTION = 0.12; // of expected travel
const STALL_WINDOW = 15; // ticks (0.5 s) for blocked-progress arrival
const SQUEEZE_TICKS = 30;
const SQUEEZE_BONUS = 15;
/** Neutral units start yielding when an army unit comes this close (beyond both radii). */
const FLEE_RADIUS = 2.5;
const NEUTRAL = 4;
/** Per-tick displacement below which a resting unit doesn't inherit momentum (0.9 u/s). */
const SHOVE_MIN = 0.03;
/** Local detour plans allowed per tick (each costs ~0.3 ms). */
const DETOURS_PER_TICK = 6;

/** Faction → team (allies share a team). Player 0, Hostile A 1, Hostile B 2, Ally 0, Neutral 3. */
const TEAM = Uint8Array.of(0, 1, 2, 0, 3);

// Hoisted enum values (hot loops).
const S_IDLE = MoveState.Idle;
const S_MOVING = MoveState.Moving;
const S_ARRIVED = MoveState.Arrived;
const S_HOLDING = MoveState.Holding;

export class Locomotion {
  private readonly oldX: Float64Array;
  private readonly oldY: Float64Array;
  private readonly accX: Float64Array;
  private readonly accY: Float64Array;
  private readonly cnt: Uint16Array;
  private readonly wallNX: Float64Array;
  private readonly wallNY: Float64Array;
  /** Distance to goal at the start of the stall window (blocked-progress arrival). */
  private readonly stallDist: Float64Array;
  /** Tick a unit last touched a moving group-mate (congestion, not stuck). */
  private readonly crowdTick: Int32Array;
  private pairI = new Int32Array(1 << 14);
  private pairJ = new Int32Array(1 << 14);
  private pairCount = 0;
  private readonly range = new Int32Array(4);
  private readonly tmp = new Float64Array(4);
  private gridReady = false;
  /** Stats for the HUD / tests. */
  pairs = 0;
  detoursTried = 0;
  detoursOk = 0;
  gaveUp = 0;

  constructor(capacity: number) {
    this.oldX = new Float64Array(capacity);
    this.oldY = new Float64Array(capacity);
    this.accX = new Float64Array(capacity);
    this.accY = new Float64Array(capacity);
    this.cnt = new Uint16Array(capacity);
    this.wallNX = new Float64Array(capacity);
    this.wallNY = new Float64Array(capacity);
    this.stallDist = new Float64Array(capacity).fill(Infinity);
    this.crowdTick = new Int32Array(capacity).fill(-1000);
  }

  step(world: World): void {
    const u = world.units;
    const n = u.count;
    const act = u.active;
    if (!this.gridReady) {
      world.grid.build(act, n, u.posX, u.posY);
      this.gridReady = true;
    }
    for (let k = 0; k < n; k++) {
      const i = act[k];
      this.oldX[i] = u.posX[i];
      this.oldY[i] = u.posY[i];
    }
    const p = world.prof;
    p.begin(SimSys.Follow);
    this.preferred(world);
    p.end(SimSys.Follow);
    p.begin(SimSys.Steer);
    this.steer(world);
    p.end(SimSys.Steer);
    p.begin(SimSys.Grid);
    this.integrate(world);
    world.grid.build(act, n, u.posX, u.posY);
    p.end(SimSys.Grid);
    p.begin(SimSys.Contacts);
    this.collectPairs(world);
    this.solveContacts(world);
    this.finishVelocities(world);
    p.end(SimSys.Contacts);
    this.arrivalAndStuck(world);
  }

  // ── 1. Preferred velocity ──────────────────────────────────────────────────

  private preferred(world: World): void {
    const { units: u, paths } = world;
    const n = u.count;
    const tick = world.tick;
    for (let k = 0; k < n; k++) {
      const i = u.active[k];
      const st = u.state[i];
      u.prefVX[i] = 0;
      u.prefVY[i] = 0;
      if (st === MoveState.Arrived && tick - u.arrivedTick[i] >= SETTLE_TICKS) u.state[i] = MoveState.Idle;
      if (st !== MoveState.Moving) continue;
      const pts = paths.points[i];
      const x = u.posX[i], y = u.posY[i];
      if (!pts) {
        if (paths.pending[i]) {
          // Waiting for a path: head straight for the goal meanwhile.
          this.towards(world, i, u.goalX[i], u.goalY[i], true);
        } else {
          u.state[i] = MoveState.Idle; // path failed
        }
        continue;
      }
      // Advance the cursor past waypoints we've reached or passed.
      const m = pts.length >> 1;
      let c = paths.cursor[i];
      const advDist = Math.max(0.35, u.radius[i] * 0.6);
      while (c < m - 1) {
        const wx = pts[2 * c], wy = pts[2 * c + 1];
        if (Math.hypot(wx - x, wy - y) < advDist) {
          c++;
          continue;
        }
        const sx = wx - pts[2 * c - 2], sy = wy - pts[2 * c - 1];
        if ((x - wx) * sx + (y - wy) * sy > 0) {
          c++;
          continue;
        }
        break;
      }
      paths.cursor[i] = c;
      // Far off the path (pushed away)? Ask for a new one now and then.
      if (((i + tick) & 15) === 0 && c > 0) {
        const ax = pts[2 * c - 2], ay = pts[2 * c - 1], bx = pts[2 * c], by = pts[2 * c + 1];
        if (distPointSeg(x, y, ax, ay, bx, by) > Math.max(1.5, 2 * u.radius[i]) && !paths.pending[i]) {
          world.pathQueue.request(u.handleOf(i), u.goalX[i], u.goalY[i]);
        }
      }
      this.towards(world, i, pts[2 * c], pts[2 * c + 1], c === m - 1 && paths.partial[i] === 0);
    }
  }

  /** Sets prefV toward (tx, ty); decelerates to stop there when it's the final point. */
  private towards(world: World, i: number, tx: number, ty: number, final: boolean): void {
    const u = world.units;
    const dx = tx - u.posX[i], dy = ty - u.posY[i];
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return;
    let s = u.maxSpeed[i];
    if (final) s = Math.min(s, Math.sqrt(2 * u.accel[i] * 0.5 * d) + 0.1, d / SIM_DT);
    u.prefVX[i] = (dx / d) * s;
    u.prefVY[i] = (dy / d) * s;
  }

  // ── 2. Steering ─────────────────────────────────────────────────────────────

  private steer(world: World): void {
    const { units: u, grid } = world;
    const n = u.count;
    const dt = SIM_DT;
    const tick = world.tick;
    const damp = Math.exp(-dt / IDLE_DAMP_TAU);
    const rg = this.range;
    const posX = u.posX, posY = u.posY, velX = u.velX, velY = u.velY, rad = u.radius;
    const state = u.state, faction = u.faction, orderId = u.orderId;
    const cellStart = grid.cellStart, items = grid.items, cols = grid.cols, cs = grid.cell;
    for (let k = 0; k < n; k++) {
      const i = u.active[k];
      const st = state[i];
      if (st === S_HOLDING) {
        velX[i] = 0;
        velY[i] = 0;
        continue;
      }
      if (st !== S_MOVING) {
        // Idle / arrived: coast out pushes, then rest. Neutral critters scatter from armies.
        let vx = velX[i] * damp, vy = velY[i] * damp;
        if (faction[i] === NEUTRAL && this.flee(world, i)) {
          vx += this.fleeX * u.maxSpeed[i];
          vy += this.fleeY * u.maxSpeed[i];
          const l = Math.hypot(vx, vy), m = u.maxSpeed[i];
          if (l > m) {
            vx *= m / l;
            vy *= m / l;
          }
        } else if (vx * vx + vy * vy < 0.0025) vx = vy = 0;
        velX[i] = vx;
        velY[i] = vy;
        continue;
      }
      const x = posX[i], y = posY[i], r = rad[i];
      const vx = velX[i], vy = velY[i];
      const pvx = u.prefVX[i], pvy = u.prefVY[i];
      const maxS = u.maxSpeed[i];
      const team = TEAM[faction[i]];
      const order = Math.abs(orderId[i]);
      const pLen = Math.hypot(pvx, pvy);
      const look = Math.min(AVOID_LOOKAHEAD_MAX, maxS * AVOID_HORIZON);
      // Query box shifted forward: avoidance looks ahead; separation only needs r + rMax around.
      const sp = Math.hypot(vx, vy);
      const shift = sp > 0.1 ? look * 0.5 : 0;
      const qx = sp > 0.1 ? x + (vx / sp) * shift : x, qy = sp > 0.1 ? y + (vy / sp) * shift : y;
      const half = r + MAX_UNIT_RADIUS + look - shift + 0.4;
      const reach2 = (r + MAX_UNIT_RADIUS + look + 0.1) ** 2;
      rg[0] = Math.max(0, Math.floor((qx - half) / cs));
      rg[1] = Math.max(0, Math.floor((qy - half) / cs));
      rg[2] = Math.min(cols - 1, Math.floor((qx + half) / cs));
      rg[3] = Math.min(grid.rows - 1, Math.floor((qy + half) / cs));
      let sepX = 0, sepY = 0;
      let bestT = AVOID_HORIZON, best = -1, bestW = 0;
      const sepMargin = 0.25 * r + 0.1;
      for (let cy = rg[1]; cy <= rg[3]; cy++) {
        const row = cy * cols;
        for (let cx = rg[0]; cx <= rg[2]; cx++) {
          const c = row + cx;
          const end = cellStart[c + 1];
          for (let q = cellStart[c]; q < end; q++) {
            const j = items[q];
            if (j === i) continue;
            const dx = posX[j] - x, dy = posY[j] - y;
            const d2 = dx * dx + dy * dy;
            if (d2 > reach2) continue;
            const R = r + rad[j];
            const sameTeam = TEAM[faction[j]] === team;
            const stj = state[j];
            const jIdle = stj === S_IDLE || stj === S_ARRIVED;
            const sameOrder = order !== 0 && (orderId[j] === order || orderId[j] === -order);
            // Separation: soft, anticipatory, only among group-mates and idle allies.
            const sepR = R + sepMargin;
            if (sameTeam && (sameOrder || jIdle) && d2 < sepR * sepR && d2 > 1e-12) {
              const d = Math.sqrt(d2);
              const w = Math.min(1, (sepR - d) / sepMargin);
              sepX -= (dx / d) * w;
              sepY -= (dy / d) * w;
            }
            // Avoidance: only units we won't simply push aside.
            if (sameTeam && (jIdle || sameOrder)) continue;
            const t = timeToCollision(dx, dy, vx - velX[j], vy - velY[j], R + 0.1);
            if (t >= 0 && t < bestT) {
              bestT = t;
              best = j;
              bestW = sameTeam && stj === S_MOVING ? 0.5 : 1;
            }
          }
        }
      }
      let dvx = pvx + W_SEP * sepX * maxS;
      let dvy = pvy + W_SEP * sepY * maxS;
      if (faction[i] === NEUTRAL && this.flee(world, i)) {
        dvx += this.fleeX * maxS * 1.5;
        dvy += this.fleeY * maxS * 1.5;
      }
      if (best >= 0 && pLen > 1e-6) {
        const dx = posX[best] - x, dy = posY[best] - y;
        const fx = pvx / pLen, fy = pvy / pLen;
        let side = u.avoidSide[i];
        if (side === 0 || tick >= u.avoidUntil[i]) {
          const cr = fx * dy - fy * dx; // > 0: obstacle on our left (formula sense)
          side = cr > 0 ? -1 : cr < 0 ? 1 : i < best ? 1 : -1;
          u.avoidSide[i] = side;
          u.avoidUntil[i] = tick + SIDE_HOLD_TICKS;
        }
        const urgency = 1 - bestT / AVOID_HORIZON;
        const mag = W_AVOID * bestW * maxS * urgency * urgency;
        // Lateral = left normal of the travel direction × side.
        dvx += -fy * side * mag;
        dvy += fx * side * mag;
        // Ease off when the threat is nearly head-on and close.
        const d = Math.hypot(dx, dy) || 1;
        const headOn = Math.abs(fx * dy - fy * dx) / d < 0.5 && fx * dx + fy * dy > 0;
        if (headOn) {
          dvx *= 1 - 0.4 * urgency * bestW;
          dvy *= 1 - 0.4 * urgency * bestW;
        }
      }
      const dl = Math.hypot(dvx, dvy);
      if (dl > maxS) {
        dvx *= maxS / dl;
        dvy *= maxS / dl;
      }
      // Acceleration limit.
      let ax = dvx - vx, ay = dvy - vy;
      const al = Math.hypot(ax, ay), amax = u.accel[i] * dt;
      if (al > amax) {
        ax *= amax / al;
        ay *= amax / al;
      }
      velX[i] = vx + ax;
      velY[i] = vy + ay;
    }
  }

  private fleeX = 0;
  private fleeY = 0;

  /**
   * Neutral units yield to armies with a steering nudge (never a push): away from non-neutral
   * moving units that come within a short radius. Writes the unit-length direction to fleeX/Y.
   */
  private flee(world: World, i: number): boolean {
    const { units: u, grid } = world;
    const x = u.posX[i], y = u.posY[i];
    const R = u.radius[i] + FLEE_RADIUS;
    const rg = this.range;
    grid.range(x, y, R + MAX_UNIT_RADIUS, rg);
    let fx = 0, fy = 0;
    for (let cy = rg[1]; cy <= rg[3]; cy++) {
      for (let cx = rg[0]; cx <= rg[2]; cx++) {
        const c = cy * grid.cols + cx;
        for (let q = grid.cellStart[c]; q < grid.cellStart[c + 1]; q++) {
          const j = grid.items[q];
          if (u.faction[j] === NEUTRAL || u.state[j] !== S_MOVING) continue;
          const dx = x - u.posX[j], dy = y - u.posY[j];
          const lim = R + u.radius[j];
          const d2 = dx * dx + dy * dy;
          if (d2 >= lim * lim || d2 < 1e-12) continue;
          const d = Math.sqrt(d2);
          const w = 1 - d / lim;
          fx += (dx / d) * w;
          fy += (dy / d) * w;
        }
      }
    }
    const l = Math.hypot(fx, fy);
    if (l < 1e-6) return false;
    this.fleeX = (fx / l) * Math.min(1, l);
    this.fleeY = (fy / l) * Math.min(1, l);
    return true;
  }

  // ── 3. Integrate + walls ─────────────────────────────────────────────────────

  private integrate(world: World): void {
    const { units: u, walls } = world;
    const dt = SIM_DT;
    const t = this.tmp;
    for (let k = 0; k < u.count; k++) {
      const i = u.active[k];
      this.wallNX[i] = 0;
      this.wallNY[i] = 0;
      const vx = u.velX[i], vy = u.velY[i];
      if (vx === 0 && vy === 0) continue;
      const x = u.posX[i] + vx * dt, y = u.posY[i] + vy * dt;
      if (walls.resolve(x, y, u.radius[i], t)) {
        u.posX[i] = t[0];
        u.posY[i] = t[1];
        this.wallNX[i] = t[2];
        this.wallNY[i] = t[3];
      } else {
        u.posX[i] = x;
        u.posY[i] = y;
      }
    }
  }

  // ── 4. Contacts ──────────────────────────────────────────────────────────────

  private collectPairs(world: World): void {
    const { units: u, grid } = world;
    const posX = u.posX, posY = u.posY, rad = u.radius;
    const cellStart = grid.cellStart, items = grid.items, cols = grid.cols, cs = grid.cell;
    let pc = 0;
    for (let k = 0; k < u.count; k++) {
      const i = u.active[k];
      const x = posX[i], y = posY[i], r = rad[i];
      const half = r + MAX_UNIT_RADIUS + 0.05;
      const cx0 = Math.max(0, Math.floor((x - half) / cs)), cx1 = Math.min(cols - 1, Math.floor((x + half) / cs));
      const cy0 = Math.max(0, Math.floor((y - half) / cs)), cy1 = Math.min(grid.rows - 1, Math.floor((y + half) / cs));
      for (let cy = cy0; cy <= cy1; cy++) {
        const row = cy * cols;
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = row + cx;
          const end = cellStart[c + 1];
          for (let q = cellStart[c]; q < end; q++) {
            const j = items[q];
            if (j <= i) continue;
            const dx = posX[j] - x, dy = posY[j] - y;
            const R = r + rad[j] + 0.05;
            if (dx * dx + dy * dy >= R * R) continue;
            if (pc === this.pairI.length) {
              const ni = new Int32Array(pc * 2);
              ni.set(this.pairI);
              this.pairI = ni;
              const nj = new Int32Array(pc * 2);
              nj.set(this.pairJ);
              this.pairJ = nj;
            }
            this.pairI[pc] = i;
            this.pairJ[pc] = j;
            pc++;
          }
        }
      }
    }
    this.pairCount = pc;
    this.pairs = pc;
  }

  /** Effective push priority: holders never yield; idle units always yield to movers. */
  private priority(world: World, i: number): number {
    const u = world.units;
    const st = u.state[i];
    if (st === MoveState.Holding) return 1000;
    if (st === MoveState.Idle || st === MoveState.Arrived) return u.pushPriority[i] - 100;
    return u.pushPriority[i] + (u.squeezeUntil[i] > world.tick ? SQUEEZE_BONUS : 0);
  }

  private solveContacts(world: World): void {
    const { units: u, walls } = world;
    const { accX, accY, cnt, pairI, pairJ } = this;
    const pc = this.pairCount;
    const t = this.tmp;
    for (let it = 0; it < CONTACT_ITERS; it++) {
      let any = false;
      for (let p = 0; p < pc; p++) {
        const i = pairI[p], j = pairJ[p];
        let dx = u.posX[j] - u.posX[i], dy = u.posY[j] - u.posY[i];
        const ri = u.radius[i], rj = u.radius[j];
        const R = ri + rj;
        const d2 = dx * dx + dy * dy;
        if (d2 >= R * R) continue;
        let d = Math.sqrt(d2);
        if (it === 0) {
          this.chainArrival(world, i, j);
          // Pressed against a moving group-mate: congestion (waiting in line), not being stuck.
          const oi = u.orderId[i];
          if (oi > 0 && oi === u.orderId[j] && u.state[i] === S_MOVING && u.state[j] === S_MOVING) {
            this.crowdTick[i] = world.tick;
            this.crowdTick[j] = world.tick;
          }
        }
        const pen = R - d;
        if (pen <= SLACK_FRAC * Math.min(ri, rj)) continue;
        if (d < 1e-9) {
          // Exactly coincident: separate along a deterministic direction.
          const a = (((i * 73856093) ^ (j * 19349663)) >>> 0) % 6283 / 1000;
          dx = Math.cos(a);
          dy = Math.sin(a);
          d = 1;
        } else {
          dx /= d;
          dy /= d;
        }
        // Who yields.
        let wi: number, wj: number;
        const mi = ri * ri, mj = rj * rj;
        if (TEAM[u.faction[i]] !== TEAM[u.faction[j]]) {
          // Enemies never push each other: a stationary unit doesn't yield to an enemy mover
          // (the mover must go around); two movers split by mass.
          const si = u.state[i] !== MoveState.Moving, sj = u.state[j] !== MoveState.Moving;
          if (si && !sj) {
            wi = 0;
            wj = 1;
          } else if (sj && !si) {
            wi = 1;
            wj = 0;
          } else {
            wi = mj / (mi + mj);
            wj = mi / (mi + mj);
          }
        } else {
          const pi = this.priority(world, i), pj = this.priority(world, j);
          if (pi === pj) {
            wi = mj / (mi + mj);
            wj = mi / (mi + mj);
          } else {
            const movingPair = pi > 0 && pj > 0 && pi < 1000 && pj < 1000;
            const hiYield = movingPair ? 0.25 : 0;
            if (pi > pj) {
              wi = hiYield;
              wj = 1 - hiYield;
            } else {
              wi = 1 - hiYield;
              wj = hiYield;
            }
          }
        }
        const corr = pen * STIFFNESS;
        accX[i] -= dx * corr * wi;
        accY[i] -= dy * corr * wi;
        accX[j] += dx * corr * wj;
        accY[j] += dy * corr * wj;
        cnt[i]++;
        cnt[j]++;
        any = true;
      }
      if (!any) break;
      // Apply averaged corrections; keep corrected units out of walls.
      for (let p = 0; p < pc; p++) {
        for (let s = 0; s < 2; s++) {
          const i = s === 0 ? pairI[p] : pairJ[p];
          const c = cnt[i];
          if (c === 0) continue;
          // Clamp the per-iteration correction so a crowd can't tunnel a unit through a wall.
          let cx = (OMEGA * accX[i]) / c, cy = (OMEGA * accY[i]) / c;
          const cl = Math.hypot(cx, cy), cmax = 0.3 * u.radius[i];
          if (cl > cmax) {
            cx *= cmax / cl;
            cy *= cmax / cl;
          }
          const x = u.posX[i] + cx, y = u.posY[i] + cy;
          accX[i] = 0;
          accY[i] = 0;
          cnt[i] = 0;
          if (walls.resolve(x, y, u.radius[i], t)) {
            u.posX[i] = t[0];
            u.posY[i] = t[1];
            this.wallNX[i] = t[2];
            this.wallNY[i] = t[3];
          } else {
            u.posX[i] = x;
            u.posY[i] = y;
          }
        }
      }
    }
  }

  /** SC2 chain arrival: a mover touching an arrived group-mate near the goal arrives too. */
  private chainArrival(world: World, i: number, j: number): void {
    const u = world.units;
    const oi = u.orderId[i], oj = u.orderId[j];
    if (oi === 0 || oj === 0 || Math.abs(oi) !== Math.abs(oj)) return;
    let mover: number;
    if (oi > 0 && oj < 0 && u.state[i] === MoveState.Moving) mover = i;
    else if (oj > 0 && oi < 0 && u.state[j] === MoveState.Moving) mover = j;
    else return;
    const order = world.orders.get(Math.abs(oi));
    const R = (order ? order.groupRadius : 0) + u.radius[mover];
    if (Math.hypot(u.posX[mover] - u.goalX[mover], u.posY[mover] - u.goalY[mover]) < R) arrive(world, mover);
  }

  // ── 5. Velocities ────────────────────────────────────────────────────────────

  private finishVelocities(world: World): void {
    const u = world.units;
    const dt = SIM_DT;
    for (let k = 0; k < u.count; k++) {
      const i = u.active[k];
      let dx = u.posX[i] - this.oldX[i], dy = u.posY[i] - this.oldY[i];
      // No teleporting: cap the per-tick displacement.
      const cap = Math.max(u.maxSpeed[i], 3) * 1.6 * dt;
      const dl = Math.hypot(dx, dy);
      if (dl > cap) {
        dx *= cap / dl;
        dy *= cap / dl;
        let nx = this.oldX[i] + dx, ny = this.oldY[i] + dy;
        if (world.walls.resolve(nx, ny, u.radius[i], this.tmp)) {
          nx = this.tmp[0];
          ny = this.tmp[1];
        }
        u.posX[i] = nx;
        u.posY[i] = ny;
        dx = nx - this.oldX[i];
        dy = ny - this.oldY[i];
      }
      // Final safety pass: anything that moved ends outside walls and inside the map.
      if (dx !== 0 || dy !== 0) {
        const r = u.radius[i];
        let fx = u.posX[i], fy = u.posY[i];
        if (world.walls.resolve(fx, fy, r, this.tmp)) {
          fx = this.tmp[0];
          fy = this.tmp[1];
          this.wallNX[i] = this.tmp[2];
          this.wallNY[i] = this.tmp[3];
        }
        fx = Math.min(world.mapW - r, Math.max(r, fx));
        fy = Math.min(world.mapH - r, Math.max(r, fy));
        u.posX[i] = fx;
        u.posY[i] = fy;
        dx = fx - this.oldX[i];
        dy = fy - this.oldY[i];
      }
      const st = u.state[i];
      if (st === MoveState.Moving) {
        // Keep the steered velocity (smooth headings), minus any into-wall component.
        const nx = this.wallNX[i], ny = this.wallNY[i];
        if (nx !== 0 || ny !== 0) {
          const vn = u.velX[i] * nx + u.velY[i] * ny;
          if (vn < 0) {
            u.velX[i] -= nx * vn;
            u.velY[i] -= ny * vn;
          }
        }
      } else if (st !== MoveState.Holding) {
        // A real shove (from a mover) carries on as momentum that then damps out; tiny
        // settling corrections among resting units must not, or a settled blob keeps shuffling.
        const shoved = dx * dx + dy * dy > SHOVE_MIN * SHOVE_MIN;
        u.velX[i] = shoved ? dx / dt : 0;
        u.velY[i] = shoved ? dy / dt : 0;
      }
    }
  }

  // ── 6. Arrival, stuck, heading ───────────────────────────────────────────────

  private arrivalAndStuck(world: World): void {
    const { units: u, paths } = world;
    const tick = world.tick;
    const dt = SIM_DT;
    let detours = 0;
    for (let k = 0; k < u.count; k++) {
      const i = u.active[k];
      // Heading follows motion.
      const vx = u.velX[i], vy = u.velY[i];
      const sp = Math.hypot(vx, vy);
      if (sp > 0.15 * u.maxSpeed[i] && u.state[i] === MoveState.Moving) {
        u.heading[i] = turnToward(u.heading[i], Math.atan2(vy, vx), u.turnRate[i] * dt);
      }
      if (u.state[i] !== MoveState.Moving || u.orderId[i] <= 0) continue;

      const x = u.posX[i], y = u.posY[i];
      const dGoal = Math.hypot(u.goalX[i] - x, u.goalY[i] - y);
      const pts = paths.points[i];
      const atEnd = pts !== null && paths.partial[i] === 0 && paths.cursor[i] >= (pts.length >> 1) - 1;
      // Direct arrival.
      if (dGoal < Math.max(0.2, u.radius[i] * 0.4) && (atEnd || pts === null) && !paths.pending[i]) {
        arrive(world, i);
        continue;
      }
      const order = world.orders.get(u.orderId[i]);
      const gr = order ? order.groupRadius : u.radius[i];
      // Blocked-progress arrival: near the goal but not getting closer.
      if ((tick + i) % STALL_WINDOW === 0) {
        const prev = this.stallDist[i];
        this.stallDist[i] = dGoal;
        const expected = u.maxSpeed[i] * STALL_WINDOW * dt;
        if (dGoal < 2 * gr + u.radius[i] && prev - dGoal < 0.15 * expected) {
          arrive(world, i);
          this.stallDist[i] = Infinity;
          continue;
        }
      }
      // Stuck ladder: squeeze + local detour → global repath → detour again → give up.
      if (tick - u.stuckTick[i] >= STUCK_WINDOW) {
        const moved = Math.hypot(x - u.stuckX[i], y - u.stuckY[i]);
        const expected = u.maxSpeed[i] * STUCK_WINDOW * dt;
        if (moved < STUCK_FRACTION * expected && tick - this.crowdTick[i] < 10) {
          // Waiting in line behind group-mates: squeeze a little, but never escalate.
          u.squeezeUntil[i] = tick + SQUEEZE_TICKS;
          u.stuckStage[i] = 0;
        } else if (moved < STUCK_FRACTION * expected) {
          const stage = u.stuckStage[i] + 1;
          const wantsDetour = stage === 1 || stage === 3;
          if (wantsDetour && detours >= DETOURS_PER_TICK) {
            // Over budget: retry this unit in a few ticks.
            u.stuckTick[i] = tick - STUCK_WINDOW + 3;
            continue;
          }
          u.stuckStage[i] = stage;
          if (stage === 1) {
            u.squeezeUntil[i] = tick + SQUEEZE_TICKS;
            detours++;
            this.detoursTried++;
            if (planDetour(world, i)) this.detoursOk++;
          } else if (stage === 2) {
            world.pathQueue.request(u.handleOf(i), u.goalX[i], u.goalY[i]);
          } else if (stage === 3) {
            detours++;
            this.detoursTried++;
            if (planDetour(world, i)) this.detoursOk++;
            else u.stuckStage[i] = 4;
          } else {
            this.gaveUp++;
            arrive(world, i);
          }
        } else {
          u.stuckStage[i] = 0;
        }
        u.stuckTick[i] = tick;
        u.stuckX[i] = x;
        u.stuckY[i] = y;
      }
    }
  }
}

/** Time until two circles (relative position d, relative velocity v = vi − vj) touch; −1 if never. */
function timeToCollision(dx: number, dy: number, vx: number, vy: number, R: number): number {
  const c = dx * dx + dy * dy - R * R;
  if (c < 0) return 0;
  const a = vx * vx + vy * vy;
  if (a < 1e-12) return -1;
  const b = dx * vx + dy * vy; // > 0: closing
  if (b <= 0) return -1;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  return (b - Math.sqrt(disc)) / a;
}

function distPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax, ey = by - ay;
  const l2 = ex * ex + ey * ey;
  let t = l2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ax - ex * t, py - ay - ey * t);
}
