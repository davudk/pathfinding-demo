/**
 * Move orders. Every move command creates an order shared by the units it was given to; the
 * order carries the group's packing radius, which arrival uses so a blob settles around the
 * goal instead of every unit fighting for the exact point.
 */
import { handleIndex } from '../../shared/handles';
import { MoveState, UNIT_FLAG_DRIFT } from '../store/units';
import type { World } from '../world';

export interface MoveOrder {
  readonly id: number;
  readonly goalX: number;
  readonly goalY: number;
  /** Radius of a disc that holds the whole group packed (Σ r² / 0.75 → area). */
  readonly groupRadius: number;
  members: number;
}

/** Hex-ish packing density used to size groups. */
const PACKING = 0.75;

export class Orders {
  private nextId = 1;
  private readonly orders = new Map<number, MoveOrder>();

  get(id: number): MoveOrder | undefined {
    return this.orders.get(id);
  }

  create(goalX: number, goalY: number, radiusSqSum: number, members: number): MoveOrder {
    const o: MoveOrder = { id: this.nextId++, goalX, goalY, groupRadius: Math.sqrt(radiusSqSum / PACKING), members };
    this.orders.set(o.id, o);
    return o;
  }

  /** A unit leaves its order (arrived, re-ordered, stopped, or died). */
  leave(id: number): void {
    const o = this.orders.get(id);
    if (!o) return;
    if (--o.members <= 0) this.orders.delete(id);
  }

  get size(): number {
    return this.orders.size;
  }
}

function prepare(world: World, i: number): void {
  const u = world.units;
  u.flags[i] &= ~UNIT_FLAG_DRIFT;
  if (u.orderId[i] > 0) world.orders.leave(u.orderId[i]);
  u.orderId[i] = 0;
  u.stuckStage[i] = 0;
  u.stuckTick[i] = world.tick;
  u.stuckX[i] = u.posX[i];
  u.stuckY[i] = u.posY[i];
  u.squeezeUntil[i] = 0;
}

export function issueMove(world: World, handles: Int32Array, x: number, y: number): void {
  const u = world.units;
  let r2 = 0, n = 0;
  for (const h of handles) {
    if (!u.isValid(h)) continue;
    const i = handleIndex(h);
    r2 += u.radius[i] * u.radius[i];
    n++;
  }
  if (n === 0) return;
  const order = world.orders.create(x, y, r2, n);
  for (const h of handles) {
    if (!u.isValid(h)) continue;
    const i = handleIndex(h);
    prepare(world, i);
    u.orderId[i] = order.id;
    u.goalX[i] = x;
    u.goalY[i] = y;
    u.state[i] = MoveState.Moving;
    world.pathQueue.request(h, x, y);
  }
}

/** Stop (S): drop the order and path; the unit becomes idle and pushable. */
export function issueStop(world: World, handles: Int32Array, hold: boolean): void {
  const u = world.units;
  for (const h of handles) {
    if (!u.isValid(h)) continue;
    const i = handleIndex(h);
    prepare(world, i);
    world.pathQueue.cancel(i);
    world.paths.clear(i);
    u.goalX[i] = u.posX[i];
    u.goalY[i] = u.posY[i];
    u.state[i] = hold ? MoveState.Holding : MoveState.Idle;
  }
}

/** Marks a unit as arrived (its order is done for it). */
export function arrive(world: World, i: number): void {
  const u = world.units;
  if (u.orderId[i] > 0) world.orders.leave(u.orderId[i]);
  u.orderId[i] = -Math.abs(u.orderId[i]); // keep the id (negated) so group-mates can still chain-arrive on us
  u.state[i] = MoveState.Arrived;
  u.arrivedTick[i] = world.tick;
  world.paths.clear(i);
  world.pathQueue.cancel(i);
}
