import type { Camera } from '../render/camera';

const PAN_SPEED_PX = 1100; // CSS px / second at any zoom
const EDGE_PX = 8;
const ZOOM_STEP = 0.0016;  // per wheel delta pixel
const ZOOM_EASE = 18;      // 1/s, exponential approach to target zoom

/**
 * SC2-style camera: arrow keys (letters are reserved for commands), screen-edge pan (only while the pointer is in the window),
 * middle-drag grab pan, and smooth wheel zoom anchored at the cursor.
 */
export class CameraController {
  private readonly keys = new Set<string>();
  private pointerInside = false;
  private px = 0;
  private py = 0;
  private dragging = false;
  private dragWorldX = 0;
  private dragWorldY = 0;
  private zoomTarget: number;
  private zoomAnchorX = 0;
  private zoomAnchorY = 0;
  edgePan = true;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cam: Camera,
    private readonly bounds: () => { w: number; h: number },
  ) {
    this.zoomTarget = cam.zoom;
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerenter', () => { this.pointerInside = true; });
    canvas.addEventListener('pointerleave', () => { this.pointerInside = false; });
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (!isTypingTarget(e.target)) this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.pointerInside = false;
    });
  }

  /** Jumps the camera (e.g. minimap click, control-group double tap). */
  centerOn(x: number, y: number): void {
    this.cam.centerX = x;
    this.cam.centerY = y;
  }

  setZoom(z: number): void {
    this.zoomTarget = z;
    this.cam.zoom = z;
  }

  update(dtSec: number): void {
    const cam = this.cam;
    // Smooth zoom toward target, keeping the anchor world point fixed under the cursor.
    if (Math.abs(this.zoomTarget - cam.zoom) > 1e-4 * cam.zoom) {
      const k = 1 - Math.exp(-ZOOM_EASE * dtSec);
      cam.zoomAt(this.zoomAnchorX, this.zoomAnchorY, cam.zoom + (this.zoomTarget - cam.zoom) * k);
    }

    if (!this.dragging) {
      let dx = 0;
      let dy = 0;
      const k = this.keys;
      if (k.has('ArrowLeft')) dx -= 1;
      if (k.has('ArrowRight')) dx += 1;
      if (k.has('ArrowUp')) dy -= 1;
      if (k.has('ArrowDown')) dy += 1;
      if (this.edgePan && this.pointerInside && document.hasFocus()) {
        if (this.px <= EDGE_PX) dx -= 1;
        if (this.px >= cam.viewW - EDGE_PX) dx += 1;
        if (this.py <= EDGE_PX) dy -= 1;
        if (this.py >= cam.viewH - EDGE_PX) dy += 1;
      }
      if (dx !== 0 || dy !== 0) {
        const len = Math.hypot(dx, dy);
        const step = (PAN_SPEED_PX * dtSec) / cam.zoom / len;
        cam.centerX += dx * step;
        cam.centerY += dy * step;
      }
    }
    const b = this.bounds();
    cam.clampTo(b.w, b.h);
  }

  private readonly onMove = (e: PointerEvent): void => {
    this.pointerInside = true;
    this.px = e.offsetX;
    this.py = e.offsetY;
    if (this.dragging) {
      // Grab: keep the world point under the cursor.
      this.cam.centerX = this.dragWorldX - (e.offsetX - this.cam.viewW * 0.5) / this.cam.zoom;
      this.cam.centerY = this.dragWorldY - (e.offsetY - this.cam.viewH * 0.5) / this.cam.zoom;
    }
  };

  private readonly onDown = (e: PointerEvent): void => {
    if (e.button !== 1) return;
    e.preventDefault();
    this.dragging = true;
    this.dragWorldX = this.cam.screenToWorldX(e.offsetX);
    this.dragWorldY = this.cam.screenToWorldY(e.offsetY);
    this.canvas.setPointerCapture(e.pointerId);
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.button !== 1) return;
    this.dragging = false;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoomTarget = Math.min(this.cam.maxZoom, Math.max(this.cam.minZoom, this.zoomTarget * Math.exp(-delta * ZOOM_STEP)));
    this.zoomAnchorX = e.offsetX;
    this.zoomAnchorY = e.offsetY;
  };
}

export function isTypingTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}
