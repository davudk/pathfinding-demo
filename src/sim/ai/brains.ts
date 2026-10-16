/**
 * Ambient AI "brains": tiny per-unit state machines that issue orders into the same queues the
 * player uses (so a player command simply takes over). Decisions are time-sliced: a brain
 * only runs when its `nextThink` tick comes up, with random jitter so thousands of them never
 * synchronize, and path requests go to the low-priority queue.
 *
 *   Wander  — pause, pick a reachable point near home, walk there, repeat
 *   Patrol  — patrol between home and a point (SC2 patrol); re-issued if interrupted
 *   Route   — convoy along a shared route (ping-pong unless the route loops)
 *   Herd    — follow the herd leader (itself a slow wanderer); stragglers regroup
 *   Fidget  — idle units occasionally look around
 */
import { TAU } from '../../shared/math';
import { handleIndex } from '../../shared/handles';
import { MoveState, UNIT_FLAG_PLAYER } from '../store/units';
import { snapToWalkable } from '../nav/query';
import { issueMove, QUEUE_CAP } from '../move/orders';
import type { World } from '../world';

export const Brain = { None: 0, Wander: 1, Patrol: 2, Route: 3, Herd: 4, Fidget: 5 } as const;
export type Brain = (typeof Brain)[keyof typeof Brain];

/** After a player order finishes, the brain stays quiet this long before taking over again. */
const SUSPEND_TICKS = 300;
/** Cap on brain-issued orders per tick (keeps the low-priority path queue sane). */
const ORDERS_PER_TICK = 40;

interface Herd {
  leader: number;
  members: number[];
  radius: number;
}

export class Brains {
  readonly kind: Uint8Array;
  readonly homeX: Float32Array;
  readonly homeY: Float32Array;
  readonly radius: Float32Array;
  readonly targetX: Float32Array;
  readonly targetY: Float32Array;
  readonly nextThink: Int32Array;
  /** Route index or herd index. */
  readonly param: Int32Array;
  /** 1 while a wanderer is pausing between walks. */
  readonly pausing: Uint8Array;
  readonly routes: { points: number[]; loop: boolean }[] = [];
  readonly herds: Herd[] = [];
  ordersLastTick = 0;

  constructor(capacity: number) {
    this.kind = new Uint8Array(capacity);
    this.homeX = new Float32Array(capacity);
    this.homeY = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.targetX = new Float32Array(capacity);
    this.targetY = new Float32Array(capacity);
    this.nextThink = new Int32Array(capacity);
    this.param = new Int32Array(capacity);
    this.pausing = new Uint8Array(capacity);
  }

  assign(world: World, handle: number, kind: Brain, opts: { radius?: number; targetX?: number; targetY?: number; param?: number } = {}): void {
    const i = handleIndex(handle);
    const u = world.units;
    this.kind[i] = kind;
    this.homeX[i] = u.posX[i];
    this.homeY[i] = u.posY[i];
    this.radius[i] = opts.radius ?? 20;
    this.targetX[i] = opts.targetX ?? u.posX[i];
    this.targetY[i] = opts.targetY ?? u.posY[i];
    this.param[i] = opts.param ?? 0;
    this.pausing[i] = 0;
    // Stagger first thoughts over 0–4 s.
    this.nextThink[i] = world.tick + 1 + world.rng.int(120);
  }

  addRoute(points: number[], loop: boolean): number {
    this.routes.push({ points, loop });
    return this.routes.length - 1;
  }

  /** Creates a herd: the first handle leads (slow wanderer), the rest follow. */
  addHerd(world: World, handles: number[], wanderRadius: number): void {
    if (handles.length === 0) return;
    const id = this.herds.length;
    const herd: Herd = { leader: handles[0], members: handles.slice(1), radius: Math.max(4, Math.sqrt(handles.length) * 0.9) };
    this.herds.push(herd);
    this.assign(world, handles[0], Brain.Wander, { radius: wanderRadius });
    for (const h of herd.members) this.assign(world, h, Brain.Herd, { param: id });
  }

  think(world: World): void {
    const { units: u, rng, queues } = world;
    const tick = world.tick;
    let orders = 0;
    for (let k = 0; k < u.count; k++) {
      const i = u.active[k];
      const kind = this.kind[i];
      if (kind === Brain.None || tick < this.nextThink[i]) continue;
      // A player order owns the unit until it's done, then the brain waits a while.
      if (u.flags[i] & UNIT_FLAG_PLAYER) {
        if (queues.len[i] === 0 && u.state[i] !== MoveState.Moving && u.state[i] !== MoveState.Holding) {
          u.flags[i] &= ~UNIT_FLAG_PLAYER;
          this.homeX[i] = u.posX[i];
          this.homeY[i] = u.posY[i];
          this.nextThink[i] = tick + SUSPEND_TICKS;
        } else {
          this.nextThink[i] = tick + 30;
        }
        continue;
      }
      if (u.state[i] === MoveState.Holding) {
        this.nextThink[i] = tick + 60;
        continue;
      }
      if (orders >= ORDERS_PER_TICK) {
        this.nextThink[i] = tick + 1 + rng.int(10);
        continue;
      }
      const idle = queues.len[i] === 0 && u.state[i] !== MoveState.Moving;
      const h = u.handleOf(i);
      switch (kind) {
        case Brain.Wander: {
          if (!idle) {
            this.nextThink[i] = tick + 15;
            break;
          }
          if (!this.pausing[i]) {
            this.pausing[i] = 1;
            this.nextThink[i] = tick + 30 + rng.int(120); // pause 1–5 s
            break;
          }
          const R = this.radius[i];
          const a = rng.range(0, TAU), d = rng.range(0.3, 1) * R;
          const p = snapToWalkable(world.nav, this.homeX[i] + Math.cos(a) * d, this.homeY[i] + Math.sin(a) * d, u.radius[i], 4);
          if (p) {
            issueMove(world, Int32Array.of(h), p[0], p[1], false, false, true);
            orders++;
            this.pausing[i] = 0;
          }
          this.nextThink[i] = tick + 15 + rng.int(15);
          break;
        }
        case Brain.Patrol: {
          if (idle) {
            // Go to the far point, then patrol back and forth (home ↔ target).
            const atHome = Math.hypot(u.posX[i] - this.homeX[i], u.posY[i] - this.homeY[i]) < 2;
            const [tx, ty] = atHome ? [this.targetX[i], this.targetY[i]] : [this.homeX[i], this.homeY[i]];
            issueMove(world, Int32Array.of(h), tx, ty, false, true, true);
            orders++;
          }
          this.nextThink[i] = tick + 60 + rng.int(30);
          break;
        }
        case Brain.Route: {
          if (idle) {
            const route = this.routes[this.param[i]];
            if (route) {
              const pts = route.points;
              const n = pts.length >> 1;
              // Start at the nearest point and loop (ping-pong unless the route is a loop).
              let start = 0, best = Infinity;
              for (let k2 = 0; k2 < n; k2++) {
                const dd = Math.hypot(pts[2 * k2] - u.posX[i], pts[2 * k2 + 1] - u.posY[i]);
                if (dd < best) {
                  best = dd;
                  start = k2;
                }
              }
              const order: number[] = [];
              for (let k2 = 0; k2 < n; k2++) order.push((start + k2) % n);
              if (!route.loop) for (let k2 = n - 2; k2 >= 1; k2--) order.push((start + k2) % n);
              const hs = Int32Array.of(h);
              order.slice(0, QUEUE_CAP).forEach((idx, j) => issueMove(world, hs, pts[2 * idx], pts[2 * idx + 1], j > 0, true, true));
              orders++;
            }
          }
          this.nextThink[i] = tick + 90 + rng.int(30);
          break;
        }
        case Brain.Herd: {
          const herd = this.herds[this.param[i]];
          if (!herd || !u.isValid(herd.leader)) {
            this.kind[i] = Brain.Wander;
            break;
          }
          const li = handleIndex(herd.leader);
          const lx = u.posX[li], ly = u.posY[li];
          const d = Math.hypot(u.posX[i] - lx, u.posY[i] - ly);
          if (d > herd.radius && (idle || d > herd.radius * 2.5)) {
            // Regroup around the leader at a random spot inside the herd.
            const a = rng.range(0, TAU), rr = rng.range(0.2, 0.9) * herd.radius;
            const p = snapToWalkable(world.nav, lx + Math.cos(a) * rr, ly + Math.sin(a) * rr, u.radius[i], 4);
            if (p) {
              issueMove(world, Int32Array.of(h), p[0], p[1], false, false, true);
              orders++;
            }
          } else if (idle && rng.float() < 0.3) {
            // Graze: small shuffle.
            const a = rng.range(0, TAU);
            const p = snapToWalkable(world.nav, u.posX[i] + Math.cos(a) * 1.5, u.posY[i] + Math.sin(a) * 1.5, u.radius[i], 1);
            if (p) {
              issueMove(world, Int32Array.of(h), p[0], p[1], false, false, true);
              orders++;
            }
          }
          this.nextThink[i] = tick + 20 + rng.int(40);
          break;
        }
        case Brain.Fidget: {
          if (idle) u.heading[i] += rng.range(-1.2, 1.2);
          this.nextThink[i] = tick + 60 + rng.int(150);
          break;
        }
      }
    }
    this.ordersLastTick = orders;
  }
}
