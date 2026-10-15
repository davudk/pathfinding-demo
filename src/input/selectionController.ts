import type { Camera } from '../render/camera';
import type { SnapshotViews } from '../shared/protocol';
import { boxSelect, pickUnit, selectSameType, type Selection } from './selection';

const DRAG_THRESHOLD_PX = 4;
const DOUBLE_CLICK_MS = 350;

/** Left-click / box selection with Shift (add/toggle), Ctrl or double-click (same type in view). */
export class SelectionController {
  private down = false;
  private dragging = false;
  private sx0 = 0;
  private sy0 = 0;
  private sx1 = 0;
  private sy1 = 0;
  private hoverX = -1;
  private hoverY = -1;
  private lastClickAt = 0;
  private lastClickHandle = 0;
  private readonly scratch: number[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cam: Camera,
    private readonly sel: Selection,
    private readonly boxEl: HTMLElement,
    private readonly snapshot: () => SnapshotViews | null,
  ) {
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', () => { this.hoverX = -1; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Per-frame: refresh the hover highlight. */
  update(): void {
    const s = this.snapshot();
    if (!s || this.hoverX < 0 || this.dragging) {
      this.sel.setHovered(0);
      return;
    }
    const slop = 3 / this.cam.zoom;
    this.sel.setHovered(pickUnit(s, this.cam.screenToWorldX(this.hoverX), this.cam.screenToWorldY(this.hoverY), slop));
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.down = true;
    this.dragging = false;
    this.sx0 = this.sx1 = e.offsetX;
    this.sy0 = this.sy1 = e.offsetY;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private readonly onMove = (e: PointerEvent): void => {
    this.hoverX = e.offsetX;
    this.hoverY = e.offsetY;
    if (!this.down) return;
    this.sx1 = e.offsetX;
    this.sy1 = e.offsetY;
    if (!this.dragging && Math.hypot(this.sx1 - this.sx0, this.sy1 - this.sy0) > DRAG_THRESHOLD_PX) this.dragging = true;
    if (this.dragging) {
      const st = this.boxEl.style;
      st.display = 'block';
      st.left = `${Math.min(this.sx0, this.sx1)}px`;
      st.top = `${Math.min(this.sy0, this.sy1)}px`;
      st.width = `${Math.abs(this.sx1 - this.sx0)}px`;
      st.height = `${Math.abs(this.sy1 - this.sy0)}px`;
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.down) return;
    this.down = false;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.boxEl.style.display = 'none';
    const s = this.snapshot();
    if (!s) return;
    const cam = this.cam;
    const out = this.scratch;
    out.length = 0;

    if (this.dragging) {
      this.dragging = false;
      boxSelect(s, cam.screenToWorldX(this.sx0), cam.screenToWorldY(this.sy0), cam.screenToWorldX(this.sx1), cam.screenToWorldY(this.sy1), out);
      this.sel.set(out, e.shiftKey);
      return;
    }

    const h = pickUnit(s, cam.screenToWorldX(e.offsetX), cam.screenToWorldY(e.offsetY), 3 / cam.zoom);
    const now = performance.now();
    const isDouble = h !== 0 && h === this.lastClickHandle && now - this.lastClickAt < DOUBLE_CLICK_MS;
    this.lastClickAt = now;
    this.lastClickHandle = h;
    if (h === 0) {
      if (!e.shiftKey) this.sel.clear();
      return;
    }
    if (isDouble || e.ctrlKey || e.metaKey) {
      selectSameType(s, h, cam.screenToWorldX(0), cam.screenToWorldY(0), cam.screenToWorldX(cam.viewW), cam.screenToWorldY(cam.viewH), out);
      this.sel.set(out, e.shiftKey);
    } else if (e.shiftKey) {
      this.sel.toggle(h);
    } else {
      this.sel.set([h], false);
    }
  };
}
