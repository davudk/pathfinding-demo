/**
 * 2D orthographic camera. World: +X right, +Y down, origin top-left of the map.
 * `zoom` is CSS pixels per world unit. Screen coordinates are CSS pixels relative to the canvas.
 */
export class Camera {
  centerX = 0;
  centerY = 0;
  zoom = 8;
  /** Canvas size in CSS pixels. */
  viewW = 1;
  viewH = 1;
  dpr = 1;

  minZoom = 1;
  maxZoom = 96;

  /** Fills `out` (mat3, column-major) with the world → clip transform. */
  viewMatrix(out: Float32Array): Float32Array {
    const sx = (2 * this.zoom) / this.viewW;
    const sy = (-2 * this.zoom) / this.viewH;
    out[0] = sx; out[1] = 0; out[2] = 0;
    out[3] = 0; out[4] = sy; out[5] = 0;
    out[6] = -this.centerX * sx; out[7] = -this.centerY * sy; out[8] = 1;
    return out;
  }

  screenToWorldX(sx: number): number {
    return this.centerX + (sx - this.viewW * 0.5) / this.zoom;
  }

  screenToWorldY(sy: number): number {
    return this.centerY + (sy - this.viewH * 0.5) / this.zoom;
  }

  worldToScreenX(wx: number): number {
    return (wx - this.centerX) * this.zoom + this.viewW * 0.5;
  }

  worldToScreenY(wy: number): number {
    return (wy - this.centerY) * this.zoom + this.viewH * 0.5;
  }

  /** Device pixels per world unit. */
  get pxPerUnit(): number {
    return this.zoom * this.dpr;
  }

  /** Zooms keeping the world point under screen point (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, newZoom: number): void {
    const wx = this.screenToWorldX(sx);
    const wy = this.screenToWorldY(sy);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, newZoom));
    this.centerX = wx - (sx - this.viewW * 0.5) / this.zoom;
    this.centerY = wy - (sy - this.viewH * 0.5) / this.zoom;
  }

  /** Keeps the view center inside the map (plus a margin of half a screen). */
  clampTo(mapW: number, mapH: number): void {
    const mx = this.viewW / this.zoom / 2;
    const my = this.viewH / this.zoom / 2;
    this.centerX = Math.min(mapW + mx * 0.5, Math.max(-mx * 0.5, this.centerX));
    this.centerY = Math.min(mapH + my * 0.5, Math.max(-my * 0.5, this.centerY));
  }
}
