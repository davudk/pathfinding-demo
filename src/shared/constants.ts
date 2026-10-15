/** Fixed simulation rate. Rendering interpolates between ticks. */
export const SIM_HZ = 30;
export const SIM_DT = 1 / SIM_HZ;
export const SIM_DT_MS = 1000 / SIM_HZ;

/** Maximum simultaneously alive units (slots). Power of two. */
export const UNIT_CAPACITY = 16384;

/** Default map edge length in world units (1 unit = 1 SC2 cell). */
export const DEFAULT_MAP_SIZE = 512;
