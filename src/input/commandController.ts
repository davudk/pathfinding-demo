import type { Camera } from '../render/camera';
import type { SimCommand } from '../shared/protocol';
import type { Selection } from './selection';

export type CommandMode = 'none' | 'move' | 'patrol';

/**
 * Turns clicks into orders. Right-click = move (Shift queues). M / P arm a targeting mode in
 * which the next left click issues the order (Shift keeps the mode armed, as in SC2).
 */
export class CommandController {
  mode: CommandMode = 'none';

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cam: Camera,
    private readonly sel: Selection,
    private readonly bounds: () => { w: number; h: number },
    private readonly issue: (cmd: SimCommand, x: number, y: number) => void,
  ) {
    // Capture phase so a targeting click never starts a box selection.
    canvas.addEventListener('pointerdown', this.onDown, { capture: true });
  }

  setMode(mode: CommandMode): void {
    this.mode = this.sel.handles.size > 0 ? mode : 'none';
    this.canvas.style.cursor = this.mode === 'none' ? 'default' : 'crosshair';
  }

  /** Issues an order at a world point for the current selection. */
  orderAt(kind: 'move' | 'patrol', x: number, y: number, queue: boolean): void {
    if (this.sel.handles.size === 0) return;
    const b = this.bounds();
    if (x < 0 || y < 0 || x > b.w || y > b.h) return;
    const handles = Int32Array.from(this.sel.handles);
    this.issue({ kind, handles, x, y, queue }, x, y);
  }

  private readonly onDown = (e: PointerEvent): void => {
    const x = this.cam.screenToWorldX(e.offsetX), y = this.cam.screenToWorldY(e.offsetY);
    if (e.button === 2) {
      this.orderAt('move', x, y, e.shiftKey);
      this.setMode('none');
      return;
    }
    if (e.button === 0 && this.mode !== 'none') {
      e.stopImmediatePropagation();
      this.orderAt(this.mode, x, y, e.shiftKey);
      if (!e.shiftKey) this.setMode('none');
    }
  };
}
