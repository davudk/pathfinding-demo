import { rgba, type LineBatch } from '../render/passes/lines';

const CLASS_COLORS = [rgba(110, 200, 255, 150), rgba(150, 255, 170, 150), rgba(255, 210, 110, 150), rgba(255, 130, 200, 150)];

/** Flow arrows of live destination fields (F4); refreshed a few times per second. */
export class FieldOverlay {
  enabled = false;
  info = 'F4 to show';
  private lastRequest = 0;
  private pending = false;

  constructor(readonly batch: LineBatch, private readonly request: () => void) {}

  toggle(): void {
    this.enabled = !this.enabled;
    if (!this.enabled) {
      this.batch.clear();
      this.info = 'F4 to show';
    }
  }

  update(now: number): void {
    if (!this.enabled || this.pending || now - this.lastRequest < 250) return;
    this.lastRequest = now;
    this.pending = true;
    this.request();
  }

  receive(arrows: Float32Array, fields: number, settled: number): void {
    this.pending = false;
    if (!this.enabled) return;
    const b = this.batch;
    b.clear();
    for (let k = 0; k < arrows.length; k += 5) {
      const x0 = arrows[k], y0 = arrows[k + 1], x1 = arrows[k + 2], y1 = arrows[k + 3];
      const col = CLASS_COLORS[arrows[k + 4]] ?? CLASS_COLORS[0];
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      // Shaft (shortened) and a small head.
      const ux = dx / len, uy = dy / len;
      const ex = x0 + dx * 0.85, ey = y0 + dy * 0.85;
      b.add(x0, y0, ex, ey, col, 1);
      const h = Math.min(0.6, len * 0.25);
      b.add(ex, ey, ex - ux * h - uy * h * 0.6, ey - uy * h + ux * h * 0.6, col, 1);
      b.add(ex, ey, ex - ux * h + uy * h * 0.6, ey - uy * h - ux * h * 0.6, col, 1);
    }
    this.info = `${fields} fields · ${settled} settled triangles`;
  }
}
