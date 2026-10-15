/** Canvas-2D sparkline of frame times with 8.3 / 16.7 / 33.3 ms guides. */
export class FrameGraph {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly w: number;
  private readonly h: number;
  private readonly maxMs = 40;

  constructor(readonly canvas: HTMLCanvasElement, cssW = 240, cssH = 52) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.w = cssW;
    this.h = cssH;
  }

  /** frame: frame interval samples; sim: sim tick cost samples (may be shorter). */
  draw(frame: Float32Array, n: number, sim: Float32Array, m: number): void {
    const { ctx, w, h, maxMs } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(8, 10, 14, 0.55)';
    ctx.fillRect(0, 0, w, h);
    const y = (ms: number): number => h - Math.min(ms, maxMs) / maxMs * (h - 2) - 1;
    ctx.lineWidth = 1;
    for (const [ms, col] of [[8.33, 'rgba(120,200,140,0.35)'], [16.67, 'rgba(230,200,90,0.35)'], [33.3, 'rgba(240,110,100,0.35)']] as const) {
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y(ms)) + 0.5);
      ctx.lineTo(w, Math.round(y(ms)) + 0.5);
      ctx.stroke();
    }
    const plot = (data: Float32Array, count: number, color: string): void => {
      if (count < 2) return;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let k = 0; k < count; k++) {
        const x = w - (count - 1 - k) * (w / (frame.length - 1));
        if (k === 0) ctx.moveTo(x, y(data[k]));
        else ctx.lineTo(x, y(data[k]));
      }
      ctx.stroke();
    };
    plot(sim, m, 'rgba(120, 170, 255, 0.9)');
    plot(frame, n, 'rgba(235, 235, 235, 0.95)');
  }
}
