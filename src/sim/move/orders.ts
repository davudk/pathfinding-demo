/**
 * Orders: each command creates a shared MoveOrder (goal + group packing radius, used for
 * chain arrival); every unit keeps a small queue of entries that reference orders.
 *
 * SC2 semantics:
 *   - a plain command replaces the queue; Shift appends;
 *   - Stop / Hold clear the queue immediately;
 *   - Patrol cycles: a finished patrol entry goes to the back of the queue;
 *   - "magic box": if the click lands outside the group's bounding box the group keeps its
 *     formation (compressed if spread out); if inside, everyone converges on the point.
 */
import { handleIndex } from '../../shared/handles';
import { MoveState, UNIT_FLAG_PLAYER } from '../store/units';
import { PRIORITY_AI, PRIORITY_PLAYER } from '../nav/pathQueue';
import type { World } from '../world';
import { radiusClass } from '../nav/navmesh';
import { detachField } from './fieldFollow';

export interface MoveOrder {
  readonly id: number;
  readonly goalX: number;
  readonly goalY: number;
  /** Radius of a disc that holds the whole group packed (Σ r² / 0.75 → area). */
  readonly groupRadius: number;
  /** Queue entries referencing this order. */
  refs: number;
  /** Large groups follow shared destination fields instead of individual paths. */
  readonly group: boolean;
}

/** Hex-ish packing density used to size groups. */
const PACKING = 0.75;
/** Orders with at least this many units use destination fields. */
export const FIELD_MIN_GROUP = 5;

export class Orders {
  private nextId = 1;
  private readonly orders = new Map<number, MoveOrder>();

  get(id: number): MoveOrder | undefined {
    return this.orders.get(Math.abs(id));
  }

  create(goalX: number, goalY: number, radiusSqSum: number, members = 1): MoveOrder {
    const o: MoveOrder = {
      id: this.nextId++, goalX, goalY, groupRadius: Math.sqrt(radiusSqSum / PACKING), refs: 0, group: members >= FIELD_MIN_GROUP,
    };
    this.orders.set(o.id, o);
    return o;
  }

  retain(id: number): void {
    const o = this.orders.get(id);
    if (o) o.refs++;
  }

  release(id: number): void {
    const o = this.orders.get(id);
    if (o && --o.refs <= 0) this.orders.delete(id);
  }

  get size(): number {
    return this.orders.size;
  }
}

export const OrderKind = { Move: 1, Patrol: 2 } as const;
export type OrderKind = (typeof OrderKind)[keyof typeof OrderKind];

/** Queue capacity per unit (SC2 allows 32; 8 is plenty for the demo). */
export const QUEUE_CAP = 16;

/** Fixed-capacity per-unit ring buffers of order entries. */
export class OrderQueues {
  readonly kind: Uint8Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly order: Int32Array;
  readonly head: Uint8Array;
  readonly len: Uint8Array;
  /** Bumped when a unit's queue changes (client sync). */
  readonly version: Uint32Array;

  constructor(capacity: number) {
    this.kind = new Uint8Array(capacity * QUEUE_CAP);
    this.x = new Float64Array(capacity * QUEUE_CAP);
    this.y = new Float64Array(capacity * QUEUE_CAP);
    this.order = new Int32Array(capacity * QUEUE_CAP);
    this.head = new Uint8Array(capacity);
    this.len = new Uint8Array(capacity);
    this.version = new Uint32Array(capacity);
  }

  /** Flat index of the k-th entry (0 = front) of unit i. */
  at(i: number, k: number): number {
    return i * QUEUE_CAP + ((this.head[i] + k) % QUEUE_CAP);
  }

  push(i: number, kind: number, x: number, y: number, order: number): boolean {
    if (this.len[i] >= QUEUE_CAP) return false;
    const e = this.at(i, this.len[i]);
    this.kind[e] = kind;
    this.x[e] = x;
    this.y[e] = y;
    this.order[e] = order;
    this.len[i]++;
    this.version[i]++;
    return true;
  }

  /** Removes the front entry; returns its order id. */
  pop(i: number): number {
    const e = this.at(i, 0);
    const o = this.order[e];
    this.head[i] = (this.head[i] + 1) % QUEUE_CAP;
    this.len[i]--;
    this.version[i]++;
    return o;
  }

  /** Moves the front entry to the back (patrol loops). */
  rotate(i: number): void {
    const e = this.at(i, 0);
    const k = this.kind[e], x = this.x[e], y = this.y[e], o = this.order[e];
    this.head[i] = (this.head[i] + 1) % QUEUE_CAP;
    this.len[i]--;
    this.push(i, k, x, y, o);
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

function clearQueue(world: World, i: number): void {
  const q = world.queues;
  while (q.len[i] > 0) world.orders.release(q.pop(i));
}

function resetMotion(world: World, i: number): void {
  const u = world.units;
  u.stuckStage[i] = 0;
  u.stuckTick[i] = world.tick;
  u.stuckX[i] = u.posX[i];
  u.stuckY[i] = u.posY[i];
  u.squeezeUntil[i] = 0;
}

/** Starts executing the front of unit i's queue, or goes idle if it's empty. */
function startFront(world: World, i: number): void {
  const u = world.units, q = world.queues;
  if (q.len[i] === 0) {
    u.state[i] = MoveState.Idle;
    world.paths.clear(i);
    world.pathQueue.cancel(i);
    return;
  }
  const e = q.at(i, 0);
  u.orderId[i] = q.order[e];
  u.goalX[i] = q.x[e];
  u.goalY[i] = q.y[e];
  u.state[i] = MoveState.Moving;
  resetMotion(world, i);
  detachField(world, i);
  const order = world.orders.get(q.order[e]);
  if (order && order.group) {
    // Group order: share the field toward the order's point; last mile goes to our own slot.
    const f = world.fields.acquire(order.goalX, order.goalY, radiusClass(u.radius[i]));
    u.fieldId[i] = f.id;
    const t = world.nav.cdt.locate(u.posX[i], u.posY[i], u.navTri[i]);
    u.navTri[i] = t;
    f.need(t);
    world.pathQueue.cancel(i);
    world.paths.clear(i);
    world.paths.pending[i] = 1;
    return;
  }
  world.pathQueue.request(u.handleOf(i), q.x[e], q.y[e], u.flags[i] & UNIT_FLAG_PLAYER ? PRIORITY_PLAYER : PRIORITY_AI);
}

/** Where unit i will be when its current queue is done (the base for queued formations). */
function queueEnd(world: World, i: number): [number, number] {
  const q = world.queues, u = world.units;
  if (q.len[i] === 0) return [u.posX[i], u.posY[i]];
  const e = q.at(i, q.len[i] - 1);
  return [q.x[e], q.y[e]];
}

/**
 * Per-unit targets for a group command (SC2 magic box). Bases are unit positions, or the end
 * of their queues when shift-queuing. Returns flat [x0, y0, x1, y1, ...] in handle order.
 */
export function magicBox(world: World, slots: readonly number[], bases: readonly number[], x: number, y: number): Float64Array {
  const u = world.units;
  const n = slots.length;
  const out = new Float64Array(n * 2);
  let cx = 0, cy = 0, r2 = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k < n; k++) {
    const bx = bases[2 * k], by = bases[2 * k + 1];
    cx += bx;
    cy += by;
    r2 += u.radius[slots[k]] ** 2;
    minX = Math.min(minX, bx);
    maxX = Math.max(maxX, bx);
    minY = Math.min(minY, by);
    maxY = Math.max(maxY, by);
  }
  cx /= n;
  cy /= n;
  const inside = x >= minX && x <= maxX && y >= minY && y <= maxY;
  if (n === 1 || inside) {
    for (let k = 0; k < n; k++) {
      out[2 * k] = x;
      out[2 * k + 1] = y;
    }
    return out;
  }
  // Keep formation; compress groups that are spread out so stragglers don't get far slots.
  let spread = 0;
  for (let k = 0; k < n; k++) spread = Math.max(spread, Math.hypot(bases[2 * k] - cx, bases[2 * k + 1] - cy));
  const packedR = Math.sqrt(r2 / 0.75);
  const limit = Math.max(1.4 * packedR, 6);
  const s = spread > limit ? limit / spread : 1;
  for (let k = 0; k < n; k++) {
    out[2 * k] = x + (bases[2 * k] - cx) * s;
    out[2 * k + 1] = y + (bases[2 * k + 1] - cy) * s;
  }
  return out;
}

/** Move (or patrol, with `patrol`) command for a set of units; `queue` = Shift. */
export function issueMove(world: World, handles: Int32Array, x: number, y: number, queue: boolean, patrol = false, ai = false): void {
  const u = world.units, q = world.queues;
  const slots: number[] = [];
  for (const h of handles) if (u.isValid(h)) slots.push(handleIndex(h));
  if (slots.length === 0) return;
  for (const i of slots) {
    if (ai) u.flags[i] &= ~UNIT_FLAG_PLAYER;
    else u.flags[i] |= UNIT_FLAG_PLAYER;
  }
  const bases: number[] = [];
  let r2 = 0;
  for (const i of slots) {
    const [bx, by] = queue ? queueEnd(world, i) : [u.posX[i], u.posY[i]];
    bases.push(bx, by);
    r2 += u.radius[i] ** 2;
  }
  const targets = magicBox(world, slots, bases, x, y);
  const order = world.orders.create(x, y, r2, slots.length);
  // Patrol's return leg: one shared order whose goals are each unit's own base.
  let back = 0;

  slots.forEach((i, k) => {
    const tx = targets[2 * k], ty = targets[2 * k + 1];
    if (!queue) clearQueue(world, i);
    if (u.state[i] === MoveState.Holding && !queue) u.state[i] = MoveState.Idle;
    const wasEmpty = q.len[i] === 0;
    if (!patrol) {
      if (q.push(i, OrderKind.Move, tx, ty, order.id)) world.orders.retain(order.id);
    } else {
      const lastIsPatrol = q.len[i] > 0 && q.kind[q.at(i, q.len[i] - 1)] === OrderKind.Patrol;
      if (q.push(i, OrderKind.Patrol, tx, ty, order.id)) world.orders.retain(order.id);
      if (!lastIsPatrol) {
        // Loop back to where the unit started (or where its queue ended).
        if (back === 0) back = world.orders.create(bases[0], bases[1], r2, slots.length).id;
        if (q.push(i, OrderKind.Patrol, bases[2 * k], bases[2 * k + 1], back)) world.orders.retain(back);
      }
    }
    // Replaced or previously idle: start right away. Otherwise it runs after the current queue.
    if (!queue || wasEmpty) startFront(world, i);
  });
  if (order.refs === 0) world.orders.release(order.id);
}

/** Stop (S) / Hold (H): clear the queue and path; the unit becomes idle (pushable) or holds. */
export function issueStop(world: World, handles: Int32Array, hold: boolean): void {
  const u = world.units;
  for (const h of handles) {
    if (!u.isValid(h)) continue;
    const i = handleIndex(h);
    u.flags[i] |= UNIT_FLAG_PLAYER;
    clearQueue(world, i);
    resetMotion(world, i);
    detachField(world, i);
    u.orderId[i] = 0;
    world.pathQueue.cancel(i);
    world.paths.clear(i);
    u.goalX[i] = u.posX[i];
    u.goalY[i] = u.posY[i];
    u.state[i] = hold ? MoveState.Holding : MoveState.Idle;
  }
}

/**
 * The unit finished its current queue entry (arrived, or gave up). Patrol entries cycle to the
 * back; move entries are consumed. Starts the next entry, or settles as Arrived.
 */
export function arrive(world: World, i: number): void {
  const u = world.units, q = world.queues;
  if (q.len[i] > 0) {
    const e = q.at(i, 0);
    if (q.kind[e] === OrderKind.Patrol) q.rotate(i);
    else world.orders.release(q.pop(i));
  }
  if (q.len[i] > 0 && !(q.len[i] === 1 && q.kind[q.at(i, 0)] === OrderKind.Patrol)) {
    // Keep the finished order id negated for a moment so group-mates can still chain-arrive.
    startFront(world, i);
    return;
  }
  // Done: keep the id (negated) so late group-mates can chain-arrive on us.
  detachField(world, i);
  u.orderId[i] = -Math.abs(u.orderId[i]);
  u.state[i] = MoveState.Arrived;
  u.arrivedTick[i] = world.tick;
  world.paths.clear(i);
  world.pathQueue.cancel(i);
  if (q.len[i] === 1) world.orders.release(q.pop(i)); // a lone patrol point isn't a loop
}
