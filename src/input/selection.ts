import { Faction } from '../shared/factions';
import {
  H_HIGH_WATER, I_ATTRS, I_HANDLE, I_RADIUS, I_X, I_Y, INST_WORDS, SNAP_HEADER_WORDS,
  attrArchetype, attrFaction, type SnapshotViews,
} from '../shared/protocol';
import { UNIT_CAPACITY } from '../shared/constants';
import { SEL_HOVERED, SEL_SELECTED } from '../render/passes/units';

/**
 * Main-thread selection state. Stores handles (generation-checked against each snapshot),
 * and maintains the per-slot flag bytes the unit renderer reads.
 */
export class Selection {
  readonly handles = new Set<number>();
  readonly flags = new Uint8Array(UNIT_CAPACITY);
  hovered = 0;
  private flagsDirty = true;
  private flagCount = 0;
  /** Bumped on every change, for UI diffing. */
  version = 0;

  clear(): void {
    if (this.handles.size === 0) return;
    this.handles.clear();
    this.changed();
  }

  set(handles: Iterable<number>, additive: boolean): void {
    if (!additive) this.handles.clear();
    for (const h of handles) this.handles.add(h);
    this.changed();
  }

  toggle(h: number): void {
    if (this.handles.has(h)) this.handles.delete(h);
    else this.handles.add(h);
    this.changed();
  }

  setHovered(h: number): void {
    if (h === this.hovered) return;
    this.hovered = h;
    this.flagsDirty = true;
  }

  /** Drops handles whose slot now holds a different (or no) unit. */
  validate(s: SnapshotViews): void {
    const hw = s.i32[H_HIGH_WATER];
    let removed = false;
    for (const h of this.handles) {
      const slot = h & 0xffff;
      if (slot >= hw || s.u32[SNAP_HEADER_WORDS + slot * INST_WORDS + I_HANDLE] !== h) {
        this.handles.delete(h);
        removed = true;
      }
    }
    if (removed) this.changed();
  }

  /** Rebuilds per-slot flags if needed; returns the byte count to upload, or -1 if unchanged. */
  syncFlags(): number {
    if (!this.flagsDirty) return -1;
    this.flags.fill(0, 0, this.flagCount);
    let maxSlot = -1;
    for (const h of this.handles) {
      const slot = h & 0xffff;
      this.flags[slot] |= SEL_SELECTED;
      if (slot > maxSlot) maxSlot = slot;
    }
    if (this.hovered !== 0) {
      const slot = this.hovered & 0xffff;
      this.flags[slot] |= SEL_HOVERED;
      if (slot > maxSlot) maxSlot = slot;
    }
    const prev = this.flagCount;
    this.flagCount = maxSlot + 1;
    this.flagsDirty = false;
    return Math.max(prev, this.flagCount);
  }

  private changed(): void {
    this.flagsDirty = true;
    this.version++;
  }
}

/** Finds the unit whose disc contains (wx, wy) (with `slop` world units of tolerance). Prefers player units. */
export function pickUnit(s: SnapshotViews, wx: number, wy: number, slop: number): number {
  const { f32, u32, i32 } = s;
  const hw = i32[H_HIGH_WATER];
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0, o = SNAP_HEADER_WORDS; i < hw; i++, o += INST_WORDS) {
    const r = f32[o + I_RADIUS];
    if (r <= 0) continue;
    const dx = f32[o + I_X] - wx;
    const dy = f32[o + I_Y] - wy;
    const lim = r + slop;
    const d2 = dx * dx + dy * dy;
    if (d2 > lim * lim) continue;
    const own = attrFaction(u32[o + I_ATTRS]) === Faction.Player;
    const score = Math.sqrt(d2) - r + (own ? 0 : 1000);
    if (score < bestScore) {
      bestScore = score;
      best = u32[o + I_HANDLE];
    }
  }
  return best;
}

/**
 * Box select: player units whose disc intersects the box. If there are none, the single
 * non-player unit closest to the box center (SC2 behaviour).
 */
export function boxSelect(s: SnapshotViews, x0: number, y0: number, x1: number, y1: number, out: number[]): void {
  const { f32, u32, i32 } = s;
  const hw = i32[H_HIGH_WATER];
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  let other = 0;
  let otherD = Infinity;
  for (let i = 0, o = SNAP_HEADER_WORDS; i < hw; i++, o += INST_WORDS) {
    const r = f32[o + I_RADIUS];
    if (r <= 0) continue;
    const x = f32[o + I_X], y = f32[o + I_Y];
    const nx = Math.max(minX, Math.min(maxX, x));
    const ny = Math.max(minY, Math.min(maxY, y));
    if ((nx - x) ** 2 + (ny - y) ** 2 > r * r) continue;
    if (attrFaction(u32[o + I_ATTRS]) === Faction.Player) {
      out.push(u32[o + I_HANDLE]);
    } else {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < otherD) {
        otherD = d;
        other = u32[o + I_HANDLE];
      }
    }
  }
  if (out.length === 0 && other !== 0) out.push(other);
}

/** All units of the same faction + archetype as `h` inside the given world rect. */
export function selectSameType(s: SnapshotViews, h: number, x0: number, y0: number, x1: number, y1: number, out: number[]): void {
  const { f32, u32, i32 } = s;
  const slot = h & 0xffff;
  const ref = u32[SNAP_HEADER_WORDS + slot * INST_WORDS + I_ATTRS];
  const fac = attrFaction(ref), arch = attrArchetype(ref);
  const hw = i32[H_HIGH_WATER];
  for (let i = 0, o = SNAP_HEADER_WORDS; i < hw; i++, o += INST_WORDS) {
    if (f32[o + I_RADIUS] <= 0) continue;
    const a = u32[o + I_ATTRS];
    if (attrFaction(a) !== fac || attrArchetype(a) !== arch) continue;
    const x = f32[o + I_X], y = f32[o + I_Y];
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push(u32[o + I_HANDLE]);
  }
}
