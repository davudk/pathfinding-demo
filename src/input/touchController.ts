import type { CameraController } from './cameraController';

const TAP_SLOP_PX = 10;
const LONG_PRESS_MS = 420;

export interface TouchHandlers {
  /** A short tap at a canvas point. */
  tap(sx: number, sy: number): void;
  /** Long-press drag: live box (`done` false) and the final box (`done` true). */
  box(x0: number, y0: number, x1: number, y1: number, done: boolean): void;
  /** Called when a box is abandoned (a second finger arrived). */
  cancelBox(): void;
}

type Mode = 'idle' | 'pending' | 'pan' | 'box' | 'gesture';

/**
 * Touch input for the map canvas. It intercepts touch pointers on the window in the capture
 * phase, so the mouse-oriented controllers never see them, and maps them to:
 *   one-finger drag → pan · two fingers → pan + pinch zoom · tap → `tap`
 *   long press, then drag → box select
 */
export class TouchController {
  private readonly pts = new Map<number, { x: number; y: number }>();
  private mode: Mode = 'idle';
  private sx = 0;
  private sy = 0;
  private lastX = 0;
  private lastY = 0;
  private lastDist = 1;
  private timer = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camCtl: CameraController,
    private readonly handlers: TouchHandlers,
  ) {
    const opts = { capture: true, passive: false };
    window.addEventListener('pointerdown', this.onDown, opts);
    window.addEventListener('pointermove', this.onMove, opts);
    window.addEventListener('pointerup', this.onUp, opts);
    window.addEventListener('pointercancel', this.onUp, opts);
    for (const t of ['pointerover', 'pointerenter', 'pointerout', 'pointerleave'] as const) {
      window.addEventListener(t, (e) => {
        if (e.pointerType === 'touch' && e.target === canvas) e.stopPropagation();
      }, opts);
    }
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private mine(e: PointerEvent): boolean {
    return e.pointerType === 'touch' && (e.target === this.canvas || this.pts.has(e.pointerId));
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (!this.mine(e)) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer (e.g. synthetic events); window listeners still see its moves.
    }
    const p = this.local(e);
    this.pts.set(e.pointerId, p);
    this.camCtl.touching = true;
    if (this.pts.size === 1) {
      this.mode = 'pending';
      this.sx = this.lastX = p.x;
      this.sy = this.lastY = p.y;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        if (this.mode !== 'pending') return;
        this.mode = 'box';
        navigator.vibrate?.(8);
        this.handlers.box(this.sx, this.sy, this.sx, this.sy, false);
      }, LONG_PRESS_MS);
    } else if (this.pts.size === 2) {
      clearTimeout(this.timer);
      if (this.mode === 'box') this.handlers.cancelBox();
      this.mode = 'gesture';
      this.startGesture();
    }
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.pts.has(e.pointerId)) return;
    e.stopPropagation();
    e.preventDefault();
    const p = this.local(e);
    this.pts.set(e.pointerId, p);
    switch (this.mode) {
      case 'pending':
        if (Math.hypot(p.x - this.sx, p.y - this.sy) > TAP_SLOP_PX) {
          clearTimeout(this.timer);
          this.mode = 'pan';
          this.panTo(p.x, p.y);
        }
        break;
      case 'pan':
        this.panTo(p.x, p.y);
        break;
      case 'box':
        this.handlers.box(this.sx, this.sy, p.x, p.y, false);
        break;
      case 'gesture': {
        const g = this.twoFinger();
        if (!g) break;
        this.camCtl.panScreen(g.cx - this.lastX, g.cy - this.lastY);
        this.camCtl.pinchAt(g.cx, g.cy, g.d / this.lastDist);
        this.lastX = g.cx;
        this.lastY = g.cy;
        this.lastDist = g.d;
        break;
      }
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (!this.pts.has(e.pointerId)) return;
    e.stopPropagation();
    const p = this.local(e);
    this.pts.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const cancelled = e.type === 'pointercancel';
    if (this.pts.size === 0) {
      clearTimeout(this.timer);
      if (this.mode === 'pending' && !cancelled) this.handlers.tap(this.sx, this.sy);
      else if (this.mode === 'box') {
        if (cancelled) this.handlers.cancelBox();
        else this.handlers.box(this.sx, this.sy, p.x, p.y, true);
      }
      this.mode = 'idle';
      this.camCtl.touching = false;
      return;
    }
    if (this.mode === 'gesture') {
      if (this.pts.size >= 2) {
        this.startGesture();
      } else {
        // One finger left: keep panning with it, without a jump.
        const rest = this.pts.values().next().value!;
        this.mode = 'pan';
        this.lastX = rest.x;
        this.lastY = rest.y;
      }
    }
  };

  private panTo(x: number, y: number): void {
    this.camCtl.panScreen(x - this.lastX, y - this.lastY);
    this.lastX = x;
    this.lastY = y;
  }

  private startGesture(): void {
    const g = this.twoFinger();
    if (!g) return;
    this.lastX = g.cx;
    this.lastY = g.cy;
    this.lastDist = Math.max(1, g.d);
  }

  private twoFinger(): { cx: number; cy: number; d: number } | null {
    const it = this.pts.values();
    const a = it.next().value, b = it.next().value;
    if (!a || !b) return null;
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }
}
