import { H_ALIVE, H_SYS_BASE } from '../shared/protocol';
import { SIM_SYSTEM_NAMES, SimSys } from '../shared/profiler';
import type { SimHost } from './simHost';

export interface BenchResult {
  readonly seconds: number;
  readonly units: number;
  readonly frame: { readonly p50: number; readonly p95: number; readonly p99: number; readonly max: number };
  readonly sim: { readonly p50: number; readonly p95: number; readonly p99: number; readonly max: number };
  readonly systems: Readonly<Record<string, number>>;
  readonly host: string;
}

const pct = (a: number[], p: number): number => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};
const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * `?bench=N`: after a 5 s warm-up, records N seconds of frame intervals and sim tick costs,
 * then reports percentiles (DOM overlay, console, and `window.__bench`).
 */
export function runBenchmark(host: SimHost, seconds: number, show: (text: string) => void): void {
  const warmup = 5000;
  const t0 = performance.now();
  const frames: number[] = [];
  const ticks: number[] = [];
  const sys = new Float64Array(SIM_SYSTEM_NAMES.length);
  let lastTick = -1;
  let last = t0;
  let sysN = 0;
  const loop = (now: number): void => {
    const el = now - t0;
    if (el > warmup) {
      frames.push(now - last);
      const s = host.ring.latest;
      if (s && s.tick !== lastTick) {
        lastTick = s.tick;
        ticks.push(s.views.f32[H_SYS_BASE + SimSys.Total]);
        for (let k = 0; k < sys.length; k++) sys[k] += s.views.f32[H_SYS_BASE + k];
        sysN++;
      }
    }
    last = now;
    if (el < warmup + seconds * 1000) {
      requestAnimationFrame(loop);
      return;
    }
    const units = host.ring.latest?.views.i32[H_ALIVE] ?? 0;
    const systems: Record<string, number> = {};
    SIM_SYSTEM_NAMES.forEach((n, k) => (systems[n] = r2(sys[k] / Math.max(1, sysN))));
    const res: BenchResult = {
      seconds,
      units,
      frame: { p50: r2(pct(frames, 0.5)), p95: r2(pct(frames, 0.95)), p99: r2(pct(frames, 0.99)), max: r2(pct(frames, 1)) },
      sim: { p50: r2(pct(ticks, 0.5)), p95: r2(pct(ticks, 0.95)), p99: r2(pct(ticks, 0.99)), max: r2(pct(ticks, 1)) },
      systems,
      host: host.mode,
    };
    (window as unknown as { __bench: BenchResult }).__bench = res;
    console.info('[bench]', JSON.stringify(res));
    show(
      `Benchmark (${seconds}s, ${units} units, ${host.mode})\n` +
        `frame  p50 ${res.frame.p50}  p95 ${res.frame.p95}  p99 ${res.frame.p99} ms\n` +
        `sim    p50 ${res.sim.p50}  p95 ${res.sim.p95}  p99 ${res.sim.p99} ms\n` +
        Object.entries(systems).map(([k, v]) => `${k} ${v}`).join(' · '),
    );
  };
  requestAnimationFrame(loop);
}
