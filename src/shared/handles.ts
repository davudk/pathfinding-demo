/**
 * Entity handles: `(generation << 16) | slotIndex`, packed into a positive int32.
 * Generations start at 1, so handle 0 is never valid and serves as the null handle.
 */
export type Handle = number;

export const NULL_HANDLE: Handle = 0;
export const INDEX_MASK = 0xffff;
export const GEN_MASK = 0x7fff;

export function makeHandle(index: number, gen: number): Handle {
  return ((gen & GEN_MASK) << 16) | (index & INDEX_MASK);
}

export function handleIndex(h: Handle): number {
  return h & INDEX_MASK;
}

export function handleGen(h: Handle): number {
  return (h >>> 16) & GEN_MASK;
}

/** Next generation for a slot, skipping 0 so handle 0 stays invalid. */
export function nextGen(gen: number): number {
  const g = (gen + 1) & GEN_MASK;
  return g === 0 ? 1 : g;
}
