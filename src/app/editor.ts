/**
 * In-app map editor: place / erase buildings, draw rock or carve polygons, paint with a
 * circular brush. Every edit is an id-based command with an inverse, so undo/redo is just
 * replaying inverses. Ghosts preview each tool; building placement is validated client-side
 * with the same checker the simulation uses.
 */
import { pointInRing, rectRing, type Polygon } from '../shared/geometry';
import type { BuildingDef, TerrainShape } from '../shared/mapFormat';
import type { SimCommand } from '../shared/protocol';
import { Faction } from '../shared/factions';
import { PlacementChecker, buildingRing } from '../sim/map/normalize';
import type { Camera } from '../render/camera';
import { rgba, type LineBatch } from '../render/passes/lines';

export type EditorTool = 'building' | 'erase' | 'rock' | 'carve' | 'brushAdd' | 'brushCarve';

type Edit =
  | { readonly kind: 'place'; readonly def: BuildingDef }
  | { readonly kind: 'remove'; readonly def: BuildingDef }
  | { readonly kind: 'terrain'; readonly shape: TerrainShape };

const BUILD_SIZES: readonly (readonly [number, number])[] = [[2, 2], [3, 3], [4, 3], [5, 5], [6, 6], [8, 2], [2, 8]];
const BRUSH_RADII = [1.5, 2.5, 4, 6, 9];
const OK = rgba(90, 235, 130, 230);
const BAD = rgba(240, 80, 80, 230);
const ROCK = rgba(170, 185, 210, 230);
const CARVE = rgba(250, 200, 80, 230);

export class Editor {
  tool: EditorTool | null = null;
  private sizeIdx = 1;
  private brushIdx = 1;
  private buildings: readonly BuildingDef[] = [];
  private terrain: readonly Polygon[] = [];
  private checker: PlacementChecker | null = null;
  private poly: number[] = [];
  private cursorX = 0;
  private cursorY = 0;
  private readonly undoStack: Edit[] = [];
  private readonly redoStack: Edit[] = [];
  private nextId = 1;
  private readonly session = Math.random().toString(36).slice(2, 6);
  private lastClick = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cam: Camera,
    readonly ghost: LineBatch,
    private readonly mapSize: () => { w: number; h: number },
    private readonly send: (cmd: SimCommand) => void,
    private readonly onChange: () => void,
  ) {
    canvas.addEventListener('pointerdown', this.onDown, { capture: true });
    canvas.addEventListener('pointermove', (e) => {
      this.cursorX = cam.screenToWorldX(e.offsetX);
      this.cursorY = cam.screenToWorldY(e.offsetY);
    });
  }

  get active(): boolean {
    return this.tool !== null;
  }

  get hint(): string {
    switch (this.tool) {
      case 'building': {
        const [w, h] = BUILD_SIZES[this.sizeIdx];
        return `Building ${w}×${h} — click to place · Q/E size · Esc done`;
      }
      case 'erase':
        return 'Erase — click a building to remove it · Esc done';
      case 'rock':
      case 'carve':
        return `${this.tool === 'rock' ? 'Rock' : 'Carve'} polygon — click vertices · Enter / double-click / click first point to close · Backspace undo point · Esc cancel`;
      case 'brushAdd':
      case 'brushCarve':
        return `${this.tool === 'brushAdd' ? 'Rock' : 'Carve'} brush r=${BRUSH_RADII[this.brushIdx]} — click to stamp · Q/E size · Esc done`;
      default:
        return '';
    }
  }

  /** Short tool status for the touch tool strip (no keyboard hints). */
  get label(): string {
    switch (this.tool) {
      case 'building': {
        const [w, h] = BUILD_SIZES[this.sizeIdx];
        return `Building ${w}×${h} · tap to place`;
      }
      case 'erase':
        return 'Erase · tap a building';
      case 'rock':
      case 'carve':
        return `${this.tool === 'rock' ? 'Rock' : 'Carve'} polygon · ${this.poly.length / 2} points`;
      case 'brushAdd':
      case 'brushCarve':
        return `${this.tool === 'brushAdd' ? 'Rock' : 'Carve'} brush r=${BRUSH_RADII[this.brushIdx]} · tap to stamp`;
      default:
        return '';
    }
  }

  /** True for tools with a size (buildings, brushes). */
  get sizable(): boolean {
    return this.tool === 'building' || this.tool === 'brushAdd' || this.tool === 'brushCarve';
  }

  /** True while a polygon is being drawn. */
  get drawing(): boolean {
    return this.tool === 'rock' || this.tool === 'carve';
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  setTool(tool: EditorTool | null): void {
    this.tool = this.tool === tool ? null : tool;
    this.poly = [];
    this.canvas.style.cursor = this.tool ? 'crosshair' : 'default';
    this.onChange();
  }

  setMapData(terrain: readonly Polygon[], buildings: readonly BuildingDef[]): void {
    this.terrain = terrain;
    this.buildings = buildings;
    const { w, h } = this.mapSize();
    this.checker = new PlacementChecker(terrain, w, h);
    for (const b of buildings) this.checker.add(b.id, buildingRing(b));
  }

  setBuildings(buildings: readonly BuildingDef[]): void {
    this.setMapData(this.terrain, buildings);
  }

  /** Q / E. */
  resize(delta: number): void {
    if (this.tool === 'building') this.sizeIdx = (this.sizeIdx + delta + BUILD_SIZES.length) % BUILD_SIZES.length;
    else if (this.tool === 'brushAdd' || this.tool === 'brushCarve') this.brushIdx = Math.max(0, Math.min(BRUSH_RADII.length - 1, this.brushIdx + delta));
    this.onChange();
  }

  /** Enter: close the polygon being drawn. */
  finishPolygon(): void {
    if ((this.tool === 'rock' || this.tool === 'carve') && this.poly.length >= 6) {
      this.commit({ kind: 'terrain', shape: this.shape(this.tool === 'rock' ? 'add' : 'subtract', this.poly) });
    }
    this.poly = [];
    this.onChange();
  }

  /** Backspace while drawing: drop the last vertex. Returns true if it consumed the key. */
  popVertex(): boolean {
    if (this.poly.length === 0) return false;
    this.poly.length -= 2;
    this.onChange();
    return true;
  }

  cancel(): void {
    if (this.poly.length) {
      this.poly = [];
      this.onChange();
    } else this.setTool(null);
  }

  undo(): void {
    const e = this.undoStack.pop();
    if (!e) return;
    this.send(inverse(e));
    this.redoStack.push(e);
    this.onChange();
  }

  redo(): void {
    const e = this.redoStack.pop();
    if (!e) return;
    this.send(forward(e));
    this.undoStack.push(e);
    this.onChange();
  }

  /** The simulation refused an edit: forget it. */
  rejected(id: string): void {
    const idOf = (e: Edit): string => (e.kind === 'terrain' ? e.shape.id : e.def.id);
    const i = this.undoStack.findIndex((e) => idOf(e) === id);
    if (i >= 0) this.undoStack.splice(i, 1);
    this.onChange();
  }

  private commit(e: Edit): void {
    this.send(forward(e));
    this.undoStack.push(e);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    this.onChange();
  }

  private newId(prefix: string): string {
    return `${prefix}${this.session}-${this.nextId++}`;
  }

  private shape(op: 'add' | 'subtract', ring: number[]): TerrainShape {
    return { id: this.newId('t'), kind: 'rock', op, rings: [ring.map((v) => Math.round(v * 16) / 16)] };
  }

  private buildingDef(x: number, y: number): BuildingDef {
    const [w, h] = BUILD_SIZES[this.sizeIdx];
    const snapHalf = (v: number): number => Math.round(v * 2) / 2;
    const cx = snapHalf(x - (w % 2) / 2) + (w % 2) / 2, cy = snapHalf(y - (h % 2) / 2) + (h % 2) / 2;
    return { id: this.newId('b'), faction: Faction.Player, type: w * h >= 25 ? 'hall' : w === h && w <= 2 ? 'depot' : 'barracks', center: [cx, cy], size: [w, h], rot: 0 };
  }

  private buildingAt(x: number, y: number): BuildingDef | null {
    for (const b of this.buildings) if (pointInRing(buildingRing(b), x, y)) return b;
    return null;
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (!this.tool || e.button !== 0) return;
    e.stopImmediatePropagation();
    this.clickAt(e.offsetX, e.offsetY);
  };

  /** A click or tap at a screen point with the current tool. */
  clickAt(sx: number, sy: number): void {
    if (!this.tool) return;
    const x = this.cam.screenToWorldX(sx), y = this.cam.screenToWorldY(sy);
    this.cursorX = x;
    this.cursorY = y;
    const now = performance.now();
    const dbl = now - this.lastClick < 300;
    this.lastClick = now;
    switch (this.tool) {
      case 'building': {
        const def = this.buildingDef(x, y);
        if (this.checker?.check(buildingRing(def))) return;
        this.commit({ kind: 'place', def });
        break;
      }
      case 'erase': {
        const b = this.buildingAt(x, y);
        if (b) this.commit({ kind: 'remove', def: b });
        break;
      }
      case 'rock':
      case 'carve': {
        const px = Math.round(x * 4) / 4, py = Math.round(y * 4) / 4;
        const closes = this.poly.length >= 6 && (dbl || Math.hypot(px - this.poly[0], py - this.poly[1]) < 6 / this.cam.zoom);
        if (closes) this.finishPolygon();
        else this.poly.push(px, py);
        break;
      }
      case 'brushAdd':
      case 'brushCarve': {
        const r = BRUSH_RADII[this.brushIdx];
        const ring: number[] = [];
        const n = Math.max(12, Math.round(r * 6));
        for (let k = 0; k < n; k++) ring.push(x + Math.cos((k / n) * Math.PI * 2) * r, y + Math.sin((k / n) * Math.PI * 2) * r);
        this.commit({ kind: 'terrain', shape: this.shape(this.tool === 'brushAdd' ? 'add' : 'subtract', ring) });
        break;
      }
    }
    this.onChange();
  }

  /** Redraws the tool ghost at the cursor. */
  update(): void {
    const g = this.ghost;
    g.clear();
    if (!this.tool) return;
    const x = this.cursorX, y = this.cursorY;
    switch (this.tool) {
      case 'building': {
        const def = this.buildingDef(x, y);
        const ok = !this.checker?.check(buildingRing(def));
        const r = rectRing(def.center[0], def.center[1], def.size[0], def.size[1]);
        g.polyline(r, true, ok ? OK : BAD, 2);
        if (!ok) g.add(r[0], r[1], r[4], r[5], BAD, 1.5);
        break;
      }
      case 'erase': {
        const b = this.buildingAt(x, y);
        if (b) {
          const r = buildingRing(b);
          g.polyline(r, true, BAD, 2.5);
          g.add(r[0], r[1], r[4], r[5], BAD, 2);
          g.add(r[2], r[3], r[6], r[7], BAD, 2);
        }
        break;
      }
      case 'rock':
      case 'carve': {
        const col = this.tool === 'rock' ? ROCK : CARVE;
        const p = this.poly;
        for (let k = 0; k + 3 < p.length; k += 2) g.add(p[k], p[k + 1], p[k + 2], p[k + 3], col, 2);
        if (p.length >= 2) {
          g.add(p[p.length - 2], p[p.length - 1], x, y, col, 1.25);
          if (p.length >= 4) g.add(x, y, p[0], p[1], (col & 0x00ffffff) | (90 << 24), 1);
        }
        cross(g, x, y, col);
        break;
      }
      case 'brushAdd':
      case 'brushCarve': {
        const r = BRUSH_RADII[this.brushIdx];
        const col = this.tool === 'brushAdd' ? ROCK : CARVE;
        const n = 40;
        for (let k = 0; k < n; k++) {
          const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
          g.add(x + Math.cos(a0) * r, y + Math.sin(a0) * r, x + Math.cos(a1) * r, y + Math.sin(a1) * r, col, 2);
        }
        break;
      }
    }
  }
}

function cross(g: LineBatch, x: number, y: number, col: number): void {
  g.add(x - 0.4, y, x + 0.4, y, col, 1.5);
  g.add(x, y - 0.4, x, y + 0.4, col, 1.5);
}

function forward(e: Edit): SimCommand {
  switch (e.kind) {
    case 'place':
      return { kind: 'placeBuilding', def: e.def };
    case 'remove':
      return { kind: 'removeBuilding', id: e.def.id };
    case 'terrain':
      return { kind: 'addTerrain', shape: e.shape };
  }
}

function inverse(e: Edit): SimCommand {
  switch (e.kind) {
    case 'place':
      return { kind: 'removeBuilding', id: e.def.id };
    case 'remove':
      return { kind: 'placeBuilding', def: e.def };
    case 'terrain':
      return { kind: 'removeTerrain', id: e.shape.id };
  }
}
