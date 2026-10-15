/**
 * Allocation-free per-system timer. `begin(i)` / `end(i)` accumulate milliseconds for
 * system `i` in the current frame/tick; `commit()` pushes the frame into ring buffers.
 */
export class Profiler {
  readonly names: readonly string[];
  readonly current: Float32Array;
  readonly history: Float32Array[];
  readonly historyLength: number;
  private readonly started: Float64Array;
  private cursor = 0;
  private filled = 0;

  constructor(names: readonly string[], historyLength = 240) {
    this.names = names;
    this.historyLength = historyLength;
    this.current = new Float32Array(names.length);
    this.started = new Float64Array(names.length);
    this.history = names.map(() => new Float32Array(historyLength));
  }

  begin(i: number): void {
    this.started[i] = performance.now();
  }

  end(i: number): void {
    this.current[i] += performance.now() - this.started[i];
  }

  commit(): void {
    const c = this.cursor;
    for (let i = 0; i < this.names.length; i++) {
      this.history[i][c] = this.current[i];
      this.current[i] = 0;
    }
    this.cursor = (c + 1) % this.historyLength;
    if (this.filled < this.historyLength) this.filled++;
  }

  /** Latest committed value of system i. */
  last(i: number): number {
    return this.history[i][(this.cursor + this.historyLength - 1) % this.historyLength];
  }

  /** Copies the last `filled` samples of system i (oldest first) into `out`; returns count. */
  samples(i: number, out: Float32Array): number {
    const n = Math.min(this.filled, out.length);
    const h = this.history[i];
    for (let k = 0; k < n; k++) out[k] = h[(this.cursor - n + k + this.historyLength) % this.historyLength];
    return n;
  }
}

/** Percentile of the first n values of `values` (copied into scratch, sorted). */
export function percentile(values: Float32Array, n: number, p: number, scratch: Float32Array): number {
  if (n === 0) return 0;
  const s = scratch.subarray(0, n);
  s.set(values.subarray(0, n));
  s.sort();
  return s[Math.min(n - 1, Math.floor(p * n))];
}

/** Sim-side system ids. Order matches SIM_SYSTEM_NAMES; written into snapshot headers. */
export const SimSys = {
  Commands: 0,
  Move: 1,
  Snapshot: 2,
  Total: 3,
} as const;
export const SIM_SYSTEM_NAMES: readonly string[] = ['commands', 'move', 'snapshot', 'total'];
