import { ARCHETYPES } from '../../shared/archetypes';
import { makeHandle, handleIndex, handleGen, nextGen, NULL_HANDLE, type Handle } from '../../shared/handles';

/** Movement state, shared with rendering via snapshot attrs. */
export const MoveState = {
  Idle: 0,
  Moving: 1,
  Arrived: 2,
  Holding: 3,
  Blocked: 4,
} as const;
export type MoveState = (typeof MoveState)[keyof typeof MoveState];

/**
 * Structure-of-arrays unit storage with fixed capacity, generation-checked handles,
 * a free list, and a dense active list (iterate `active[0..count)` — every entry is alive).
 */
export class UnitStore {
  readonly capacity: number;

  // Kinematics (Float64 in the sim; snapshots narrow to Float32).
  readonly posX: Float64Array;
  readonly posY: Float64Array;
  readonly velX: Float64Array;
  readonly velY: Float64Array;
  readonly heading: Float64Array;

  // Per-unit constants copied from the archetype at spawn.
  readonly radius: Float32Array;
  readonly maxSpeed: Float32Array;
  readonly accel: Float32Array;
  readonly turnRate: Float32Array;
  readonly pushPriority: Uint8Array;

  readonly faction: Uint8Array;
  readonly archetype: Uint8Array;
  readonly state: Uint8Array;
  readonly flags: Uint32Array;

  /** Generation per slot; 0 = never used. */
  readonly gen: Uint16Array;
  readonly alive: Uint8Array;

  readonly active: Int32Array;
  /** Position of a slot inside `active`, or -1. */
  readonly denseIndex: Int32Array;
  private readonly freeList: Int32Array;
  private freeCount = 0;

  count = 0;
  /** One past the highest slot ever used. Snapshots cover [0, highWater). */
  highWater = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.posX = new Float64Array(capacity);
    this.posY = new Float64Array(capacity);
    this.velX = new Float64Array(capacity);
    this.velY = new Float64Array(capacity);
    this.heading = new Float64Array(capacity);
    this.radius = new Float32Array(capacity);
    this.maxSpeed = new Float32Array(capacity);
    this.accel = new Float32Array(capacity);
    this.turnRate = new Float32Array(capacity);
    this.pushPriority = new Uint8Array(capacity);
    this.faction = new Uint8Array(capacity);
    this.archetype = new Uint8Array(capacity);
    this.state = new Uint8Array(capacity);
    this.flags = new Uint32Array(capacity);
    this.gen = new Uint16Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.active = new Int32Array(capacity);
    this.denseIndex = new Int32Array(capacity).fill(-1);
    this.freeList = new Int32Array(capacity);
  }

  /** Spawns a unit; returns NULL_HANDLE when full. */
  spawn(archetype: number, faction: number, x: number, y: number, heading = 0): Handle {
    let i: number;
    if (this.freeCount > 0) i = this.freeList[--this.freeCount];
    else if (this.highWater < this.capacity) i = this.highWater++;
    else return NULL_HANDLE;

    const a = ARCHETYPES[archetype];
    this.gen[i] = nextGen(this.gen[i]);
    this.alive[i] = 1;
    this.posX[i] = x;
    this.posY[i] = y;
    this.velX[i] = 0;
    this.velY[i] = 0;
    this.heading[i] = heading;
    this.radius[i] = a.radius;
    this.maxSpeed[i] = a.speed;
    this.accel[i] = a.accel;
    this.turnRate[i] = a.turnRate;
    this.pushPriority[i] = a.pushPriority;
    this.faction[i] = faction;
    this.archetype[i] = archetype;
    this.state[i] = MoveState.Idle;
    this.flags[i] = 0;

    this.denseIndex[i] = this.count;
    this.active[this.count++] = i;
    return makeHandle(i, this.gen[i]);
  }

  despawn(h: Handle): boolean {
    if (!this.isValid(h)) return false;
    const i = handleIndex(h);
    this.alive[i] = 0;
    this.radius[i] = 0;
    // Swap-remove from the dense list.
    const d = this.denseIndex[i];
    const last = this.active[--this.count];
    this.active[d] = last;
    this.denseIndex[last] = d;
    this.denseIndex[i] = -1;
    this.freeList[this.freeCount++] = i;
    return true;
  }

  isValid(h: Handle): boolean {
    const i = handleIndex(h);
    return h !== NULL_HANDLE && i < this.highWater && this.alive[i] === 1 && this.gen[i] === handleGen(h);
  }

  handleOf(i: number): Handle {
    return makeHandle(i, this.gen[i]);
  }
}
