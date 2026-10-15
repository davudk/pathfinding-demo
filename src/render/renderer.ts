import type { Snapshot } from '../app/snapshotRing';
import { FACTION_COLORS } from '../shared/factions';
import { Camera } from './camera';
import type { MapRenderData } from '../shared/protocol';
import { BuildingsPass } from './passes/buildings';
import { GroundPass } from './passes/ground';
import { TerrainPass } from './passes/terrain';
import { LinePass, type LineBatch } from './passes/lines';
import { UnitsPass } from './passes/units';

const MAX_DPR = 2;

/** What the renderer draws in one frame. */
export interface FrameInput {
  readonly a: Snapshot;
  readonly b: Snapshot;
  readonly alpha: number;
  readonly mapW: number;
  readonly mapH: number;
  /** Line batches drawn under units (terrain outlines, debug) and over units (UI). */
  readonly under: readonly LineBatch[];
  readonly over: readonly LineBatch[];
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly camera = new Camera();
  readonly lines: LinePass;
  readonly units: UnitsPass;
  readonly terrain: TerrainPass;
  readonly buildings: BuildingsPass;
  private readonly ground: GroundPass;
  private readonly view = new Float32Array(9);
  private deviceW = 1;
  private deviceH = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
      desynchronized: true,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.ground = new GroundPass(gl);
    this.terrain = new TerrainPass(gl);
    this.buildings = new BuildingsPass(gl);
    this.lines = new LinePass(gl);
    this.units = new UnitsPass(gl);
    this.units.setFactionColors(FACTION_COLORS);
    this.observeSize();
  }

  private observeSize(): void {
    const apply = (cssW: number, cssH: number, devW?: number, devH?: number): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const cam = this.camera;
      cam.viewW = Math.max(1, cssW);
      cam.viewH = Math.max(1, cssH);
      cam.dpr = dpr;
      const scale = dpr / (window.devicePixelRatio || 1);
      this.deviceW = Math.max(1, Math.round(devW !== undefined ? devW * scale : cssW * dpr));
      this.deviceH = Math.max(1, Math.round(devH !== undefined ? devH * scale : cssH * dpr));
    };
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const dev = e.devicePixelContentBoxSize?.[0];
        const css = e.contentBoxSize[0];
        apply(css.inlineSize, css.blockSize, dev?.inlineSize, dev?.blockSize);
      }
    });
    try {
      ro.observe(this.canvas, { box: 'device-pixel-content-box' });
    } catch {
      ro.observe(this.canvas);
    }
    const r = this.canvas.getBoundingClientRect();
    apply(r.width, r.height);
  }

  /** Uploads static map geometry. Returns timing info for the HUD. */
  setMap(map: MapRenderData, mapW: number, mapH: number): { triangles: number; ms: number } {
    this.buildings.setBuildings(map.buildings);
    return this.terrain.setTerrain(map.terrain, mapW, mapH);
  }

  render(f: FrameInput): void {
    const gl = this.gl;
    const cam = this.camera;
    if (this.canvas.width !== this.deviceW || this.canvas.height !== this.deviceH) {
      this.canvas.width = this.deviceW;
      this.canvas.height = this.deviceH;
    }
    // Effective device px per unit from the actual backbuffer (exact even when DPR is capped).
    const pxPerUnit = cam.zoom * (this.deviceW / cam.viewW);
    gl.viewport(0, 0, this.deviceW, this.deviceH);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    cam.viewMatrix(this.view);
    this.terrain.bindSdf(0);
    this.ground.draw(cam.centerX, cam.centerY, cam.viewW / cam.zoom / 2, cam.viewH / cam.zoom / 2, f.mapW, f.mapH, pxPerUnit);
    this.buildings.drawShadows(this.view, pxPerUnit);
    this.terrain.draw(this.view, pxPerUnit);
    this.buildings.draw(this.view, pxPerUnit);
    for (const b of f.under) b.draw(this.view, pxPerUnit);
    this.units.draw(this.view, f.a, f.b, f.alpha, pxPerUnit);
    for (const b of f.over) b.draw(this.view, pxPerUnit);
  }
}
