import type { NavDebugData } from '../shared/protocol';
import { rgba, type LineBatch, type LinePass } from '../render/passes/lines';
import { TriBatch } from '../render/passes/tris';

export const RADIUS_CLASS_LABELS = ['r ≤ 0.375', 'r ≤ 0.625', 'r ≤ 1.25', 'r ≤ 2.0'];

/**
 * Navmesh debug overlay: triangle edges (free / inside obstacles / constrained) and regions
 * for one radius class, tinted per connected region. Re-requested when the mesh changes.
 */
export class NavOverlay {
  enabled = false;
  cls = 0;
  readonly fill: TriBatch;
  readonly edges: LineBatch;
  private shownVersion = -1;
  private shownCls = -1;
  private pending = false;
  info = '';

  constructor(gl: WebGL2RenderingContext, lines: LinePass, private readonly request: (cls: number) => void) {
    this.fill = new TriBatch(gl);
    this.edges = lines.batch(65536);
  }

  toggle(): void {
    this.enabled = !this.enabled;
  }

  cycleClass(): void {
    this.cls = (this.cls + 1) % RADIUS_CLASS_LABELS.length;
    if (!this.enabled) this.enabled = true;
  }

  /** Call per frame with the navmesh version from the latest snapshot. */
  update(navVersion: number): void {
    if (!this.enabled || this.pending) return;
    if (navVersion !== this.shownVersion || this.cls !== this.shownCls) {
      this.pending = true;
      this.request(this.cls);
    }
  }

  receive(d: NavDebugData): void {
    this.pending = false;
    this.shownVersion = d.version;
    this.shownCls = d.cls;
    const nTri = d.region.length;
    const colors = new Uint32Array(nTri);
    // Count triangles per region so the dominant region gets a calm color and small ones pop.
    const sizes = new Map<number, number>();
    for (let t = 0; t < nTri; t++) if (d.region[t] >= 0) sizes.set(d.region[t], (sizes.get(d.region[t]) ?? 0) + 1);
    let main = -1, best = -1;
    for (const [r, n] of sizes) if (n > best) { best = n; main = r; }
    for (let t = 0; t < nTri; t++) {
      const r = d.region[t];
      if (r < 0) continue;
      if (r === main) colors[t] = rgba(70, 140, 255, 26);
      else {
        const [cr, cg, cb] = hue((r * 0.618034) % 1);
        colors[t] = rgba(cr, cg, cb, 90);
      }
    }
    this.fill.set(d.tris, colors);

    this.edges.clear();
    const e = d.edges;
    for (let i = 0; i < e.length; i += 5) {
      const kind = e[i + 4];
      if (kind === 1) continue; // edges buried inside obstacles add noise
      if (kind === 2) this.edges.add(e[i], e[i + 1], e[i + 2], e[i + 3], rgba(255, 170, 60, 220), 1.4);
      else this.edges.add(e[i], e[i + 1], e[i + 2], e[i + 3], rgba(120, 200, 255, 95), 1);
    }
    const s = d.stats;
    this.info = `${s.triangles} tris · ${s.vertices} verts · regions ${s.regions.join('/')} · build ${s.buildMs.toFixed(1)} ms · last edit ${s.lastUpdateMs.toFixed(2)} ms · showing ${RADIUS_CLASS_LABELS[d.cls]}`;
  }
}

function hue(h: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h * 6) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1)) * 0.75));
  };
  return [f(5), f(3), f(1)];
}
