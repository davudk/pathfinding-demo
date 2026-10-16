import type { Polygon } from '../shared/geometry';
import type { BuildingDef } from '../shared/mapFormat';
import { FACTION_COLORS } from '../shared/factions';
import { H_HIGH_WATER, I_ATTRS, I_RADIUS, I_X, I_Y, INST_WORDS, SNAP_HEADER_WORDS, attrFaction, type SnapshotViews } from '../shared/protocol';
import type { Camera } from '../render/camera';

const REFRESH_MS = 100;

/**
 * Minimap: terrain and buildings baked into an image once, unit dots refreshed at 10 Hz,
 * camera frustum on top. Left click/drag moves the camera, right click orders a move.
 */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private base: ImageData | null = null;
  private frame: ImageData | null = null;
  private frame32: Uint32Array | null = null;
  private colors: Uint32Array;
  private buildings: readonly BuildingDef[] = [];
  private palette: readonly (readonly [number, number, number])[] = FACTION_COLORS;
  private px = 1;
  private mapW = 1;
  private mapH = 1;
  private terrain: readonly Polygon[] = [];
  private lastDraw = 0;
  private dragging = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly cam: Camera,
    private readonly onCenter: (x: number, y: number) => void,
    private readonly onOrder: (x: number, y: number, queue: boolean) => void,
    /** Left click while a targeting mode is armed: return true if it issued the order. */
    private readonly onTarget: (x: number, y: number, queue: boolean) => boolean = () => false,
    private cssSize = 208,
  ) {
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    this.colors = new Uint32Array(FACTION_COLORS.map(([r, g, b]) => abgr(r * 255 * 1.1, g * 255 * 1.1, b * 255 * 1.1)));
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  }

  setMap(terrain: readonly Polygon[], buildings: readonly BuildingDef[], mapW: number, mapH: number): void {
    this.terrain = terrain;
    this.mapW = mapW;
    this.mapH = mapH;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.px = Math.round(this.cssSize * dpr);
    this.canvas.width = this.px;
    this.canvas.height = Math.round((this.px * mapH) / mapW);
    this.canvas.style.width = `${this.cssSize}px`;
    this.canvas.style.height = `${(this.cssSize * mapH) / mapW}px`;
    this.setBuildings(buildings);
  }

  /** Changes the on-screen width (responsive layout) and re-bakes at the new resolution. */
  resize(cssSize: number): void {
    if (cssSize === this.cssSize) return;
    this.cssSize = cssSize;
    if (this.base) this.setMap(this.terrain, this.buildings, this.mapW, this.mapH);
  }

  setPalette(colors: readonly (readonly [number, number, number])[]): void {
    this.palette = colors;
    this.colors = new Uint32Array(colors.map(([r, g, b]) => abgr(r * 255 * 1.1, g * 255 * 1.1, b * 255 * 1.1)));
    this.setBuildings(this.buildings);
  }

  /** Re-bakes the static layer (terrain + buildings). */
  setBuildings(buildings: readonly BuildingDef[]): void {
    this.buildings = buildings;
    const { ctx } = this;
    const s = this.canvas.width / this.mapW;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#15181e';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.fillStyle = '#3a414f';
    ctx.beginPath();
    for (const p of this.terrain) {
      for (const r of p.rings) {
        ctx.moveTo(r[0], r[1]);
        for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i], r[i + 1]);
        ctx.closePath();
      }
    }
    ctx.fill('evenodd');
    for (const b of buildings) {
      const [cr, cg, cb] = this.palette[b.faction] ?? this.palette[4];
      ctx.fillStyle = `rgb(${(cr * 120 + 40) | 0}, ${(cg * 120 + 40) | 0}, ${(cb * 120 + 40) | 0})`;
      ctx.fillRect(b.center[0] - b.size[0] / 2, b.center[1] - b.size[1] / 2, b.size[0], b.size[1]);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.base = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.frame = new ImageData(this.canvas.width, this.canvas.height);
    this.frame32 = new Uint32Array(this.frame.data.buffer);
    this.lastDraw = 0;
  }

  /** Redraws at most every REFRESH_MS (units) and every call it's dirty (camera). */
  update(now: number, s: SnapshotViews | null, selectedSlots: Uint8Array): void {
    if (!this.base || !this.frame || !this.frame32 || !s) return;
    if (now - this.lastDraw < REFRESH_MS) {
      this.drawCamera();
      return;
    }
    this.lastDraw = now;
    const w = this.canvas.width, h = this.canvas.height;
    const scale = w / this.mapW;
    const f32 = s.f32, u32 = s.u32;
    const fr = this.frame32;
    new Uint32Array(this.frame.data.buffer).set(new Uint32Array(this.base.data.buffer));
    const hw = s.i32[H_HIGH_WATER];
    const sel = abgr(140, 255, 160);
    for (let i = 0, o = SNAP_HEADER_WORDS; i < hw; i++, o += INST_WORDS) {
      const r = f32[o + I_RADIUS];
      if (r <= 0) continue;
      const x = (f32[o + I_X] * scale) | 0, y = (f32[o + I_Y] * scale) | 0;
      const c = selectedSlots[i] & 1 ? sel : this.colors[attrFaction(u32[o + I_ATTRS])];
      const size = r >= 1 ? 2 : 1;
      for (let dy = 0; dy <= size - 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = 0; dx <= size - 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) fr[yy * w + xx] = c;
        }
      }
    }
    this.drawCamera();
  }

  private drawCamera(): void {
    if (!this.frame) return;
    const { ctx, cam } = this;
    ctx.putImageData(this.frame, 0, 0);
    const s = this.canvas.width / this.mapW;
    const x0 = cam.screenToWorldX(0) * s, y0 = cam.screenToWorldY(0) * s;
    const x1 = cam.screenToWorldX(cam.viewW) * s, y1 = cam.screenToWorldY(cam.viewH) * s;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1, this.canvas.width / this.cssSize);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }

  private toWorld(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.mapW, ((e.clientY - r.top) / r.height) * this.mapH];
  }

  private readonly onDown = (e: PointerEvent): void => {
    e.preventDefault();
    const [x, y] = this.toWorld(e);
    if (e.button === 2) {
      this.onOrder(x, y, e.shiftKey);
      return;
    }
    if (e.button !== 0) return;
    if (this.onTarget(x, y, e.shiftKey)) return;
    this.dragging = true;
    this.canvas.setPointerCapture(e.pointerId);
    this.onCenter(x, y);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const [x, y] = this.toWorld(e);
    this.onCenter(Math.max(0, Math.min(this.mapW, x)), Math.max(0, Math.min(this.mapH, y)));
  };

  private readonly onUp = (e: PointerEvent): void => {
    this.dragging = false;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };
}

function abgr(r: number, g: number, b: number): number {
  const c = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return ((255 << 24) | (c(b) << 16) | (c(g) << 8) | c(r)) >>> 0;
}
