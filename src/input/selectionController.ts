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
    if (this.dragging) this.showBox(this.sx0, this.sy0, this.sx1, this.sy1);
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.down) return;
    this.down = false;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.hideBox();
    if (this.dragging) {
      this.dragging = false;
      this.boxSelect(this.sx0, this.sy0, this.sx1, this.sy1, e.shiftKey);
      return;
    }
    this.clickAt(e.offsetX, e.offsetY, e.shiftKey, e.ctrlKey || e.metaKey);
  };

  /** Draws the selection rectangle between two screen points. */
  showBox(x0: number, y0: number, x1: number, y1: number): void {
    const st = this.boxEl.style;
    st.display = 'block';
    st.left = `${Math.min(x0, x1)}px`;
    st.top = `${Math.min(y0, y1)}px`;
    st.width = `${Math.abs(x1 - x0)}px`;
    st.height = `${Math.abs(y1 - y0)}px`;
  }

  hideBox(): void {
    this.boxEl.style.display = 'none';
  }

  /** Selects the units inside a screen rectangle (`add`: Shift). */
  boxSelect(x0: number, y0: number, x1: number, y1: number, add: boolean): void {
    const s = this.snapshot();
    if (!s) return;
    const cam = this.cam;
    const out = this.scratch;
    out.length = 0;
    boxSelect(s, cam.screenToWorldX(x0), cam.screenToWorldY(y0), cam.screenToWorldX(x1), cam.screenToWorldY(y1), out);
    this.sel.set(out, add);
  }

  /** The unit under a screen point (0 if none), with a few pixels of slop (more for fingers). */
  pickAt(sx: number, sy: number, slopPx = 3): number {
    const s = this.snapshot();
    return s ? pickUnit(s, this.cam.screenToWorldX(sx), this.cam.screenToWorldY(sy), slopPx / this.cam.zoom) : 0;
  }

  /** A click at a screen point: select, toggle (Shift), or same type in view (double-click / Ctrl). */
  clickAt(sx: number, sy: number, shift: boolean, sameType: boolean, slopPx = 3): void {
    const s = this.snapshot();
    if (!s) return;
    const cam = this.cam;
    const out = this.scratch;
    out.length = 0;
    const h = this.pickAt(sx, sy, slopPx);
    const now = performance.now();
    const isDouble = h !== 0 && h === this.lastClickHandle && now - this.lastClickAt < DOUBLE_CLICK_MS;
    this.lastClickAt = now;
    this.lastClickHandle = h;
    if (h === 0) {
      if (!shift) this.sel.clear();
      return;
    }
    if (isDouble || sameType) {
      selectSameType(s, h, cam.screenToWorldX(0), cam.screenToWorldY(0), cam.screenToWorldX(cam.viewW), cam.screenToWorldY(cam.viewH), out);
      this.sel.set(out, shift);
    } else if (shift) {
      this.sel.toggle(h);
    } else {
      this.sel.set([h], false);
    }
  }
}
