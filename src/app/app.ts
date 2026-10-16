import { parseMap, type BuildingDef } from '../shared/mapFormat';
import { H_ALIVE, H_NAV_VERSION, H_PATH_QUEUE, H_PATH_SERVED, H_SYS_BASE, H_TIME_F64, type FromSim, type SceneConfig } from '../shared/protocol';
import { NavOverlay } from './navOverlay';
import { FieldOverlay } from './fieldOverlay';
import { ClickMarkers, MARKER_MOVE, MARKER_PATROL, PathOverlay } from './pathOverlay';
import { Editor, type EditorTool } from './editor';
import type { Polygon } from '../shared/geometry';
import { CommandController } from '../input/commandController';
import { ControlGroups } from '../input/controlGroups';
import { Minimap } from '../ui/minimap';
import { SelectionPanel } from '../ui/selectionPanel';
import { I_HANDLE, INST_WORDS, SNAP_HEADER_WORDS, I_X, I_Y } from '../shared/protocol';
import { Profiler, SIM_SYSTEM_NAMES, SimSys, percentile } from '../shared/profiler';
import { SIM_HZ } from '../shared/constants';
import { Renderer } from '../render/renderer';
import { rgba, type LineBatch } from '../render/passes/lines';
import { CameraController, isTypingTarget } from '../input/cameraController';
import { Selection } from '../input/selection';
import { SelectionController } from '../input/selectionController';
import { Hud } from '../ui/hud';
import { FrameGraph } from '../debug/frameGraph';
import { RenderClock } from './renderClock';
import { createSimHost, type SimHost } from './simHost';
import type { Snapshot } from './snapshotRing';

const FrameSys = { Frame: 0, Cpu: 1 } as const;

export const CUSTOM_MAP_KEY = 'rts-custom-map';

function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface AppElements {
  readonly canvas: HTMLCanvasElement;
  readonly hud: HTMLElement;
  readonly graph: HTMLCanvasElement;
  readonly selBox: HTMLElement;
  readonly help: HTMLElement;
  readonly toast: HTMLElement;
  readonly minimap: HTMLCanvasElement;
  readonly selSummary: HTMLElement;
  readonly groupBar: HTMLElement;
}

export function sceneFromUrl(params: URLSearchParams): SceneConfig {
  const num = (k: string, d: number): number => {
    const v = Number(params.get(k));
    return Number.isFinite(v) && params.has(k) ? v : d;
  };
  return {
    name: params.get('scene') ?? 'stress',
    seed: num('seed', 42) >>> 0,
    units: Math.max(0, Math.min(16000, num('units', 10000))),
    mapSeed: num('mapSeed', 1337) >>> 0,
    ...(params.get('map') === 'custom' && sessionStorage.getItem(CUSTOM_MAP_KEY) ? { mapJson: sessionStorage.getItem(CUSTOM_MAP_KEY)! } : {}),
  };
}

export class App {
  private readonly renderer: Renderer;
  private readonly host: SimHost;
  private readonly clock = new RenderClock();
  private readonly selection = new Selection();
  private readonly camCtl: CameraController;
  private readonly selCtl: SelectionController;
  private readonly hud: Hud;
  private readonly graph: FrameGraph;
  private readonly frameProf = new Profiler(['frame', 'cpu'], 240);
  private readonly simTotals = new Float32Array(240);
  private simTotalsN = 0;
  private readonly scratchA = new Float32Array(240);
  private readonly scratchB = new Float32Array(240);
  private readonly bracket: { a: Snapshot | null; b: Snapshot | null; alpha: number } = { a: null, b: null, alpha: 0 };
  private readonly underLines: LineBatch[] = [];
  private readonly overLines: LineBatch[] = [];
  private mapW = 1;
  private mapH = 1;
  private lastFrame = 0;
  private lastHud = 0;
  private lastSeenTick = -1;
  private validatedTick = -1;
  private paused = false;
  private timeScale = 1;
  private mapInfo = '';
  private readonly nav: NavOverlay;
  private readonly fieldOverlay: FieldOverlay;
  private readonly pathOverlay: PathOverlay;
  private readonly markers: ClickMarkers;
  private readonly commands: CommandController;
  private readonly groups = new ControlGroups();
  private readonly minimap: Minimap;
  private readonly panel: SelectionPanel;
  private readonly editor: Editor;
  private outlines: LineBatch | null = null;
  private lastPrune = 0;
  private watchedVersion = -1;
  private toastTimer = 0;

  constructor(private readonly el: AppElements, scene: SceneConfig, hostOpts: { main: boolean; forceTransfer: boolean }) {
    this.renderer = new Renderer(el.canvas);
    this.host = createSimHost(scene, hostOpts);
    this.hud = new Hud(el.hud);
    this.graph = new FrameGraph(el.graph);
    const cam = this.renderer.camera;
    this.camCtl = new CameraController(el.canvas, cam, () => ({ w: this.mapW, h: this.mapH }));
    this.selCtl = new SelectionController(el.canvas, cam, this.selection, el.selBox, () => this.bracket.b?.views ?? null);
    this.nav = new NavOverlay(this.renderer.gl, this.renderer.lines, (cls) => this.host.requestNavDebug(cls));
    this.pathOverlay = new PathOverlay(this.renderer.lines.batch(4096));
    this.fieldOverlay = new FieldOverlay(this.renderer.lines.batch(65536), () => this.host.requestFieldDebug());
    this.underLines.push(this.fieldOverlay.batch);
    this.markers = new ClickMarkers(this.renderer.lines.batch(256));
    this.overLines.push(this.pathOverlay.batch, this.markers.batch);
    this.commands = new CommandController(el.canvas, cam, this.selection, () => ({ w: this.mapW, h: this.mapH }), (cmd, x, y) => {
      this.host.command(cmd);
      this.markers.add(x, y, cmd.kind === 'patrol' ? MARKER_PATROL : MARKER_MOVE);
    });
    this.minimap = new Minimap(
      el.minimap,
      cam,
      (x, y) => this.camCtl.centerOn(x, y),
      (x, y, queue) => this.commands.orderAt('move', x, y, queue),
    );
    this.panel = new SelectionPanel(el.selSummary, el.groupBar);
    this.editor = new Editor(el.canvas, cam, this.renderer.lines.batch(256), () => ({ w: this.mapW, h: this.mapH }), (cmd) => this.host.command(cmd), () => this.syncEditorPanel());
    this.overLines.push(this.editor.ghost);
    this.wireEditorPanel();
    this.host.onEvent = this.onSimEvent;
    window.addEventListener('keydown', this.onKey);
  }

  private readonly onSimEvent = (msg: FromSim): void => {
    switch (msg.type) {
      case 'buildings':
        this.renderer.buildings.setBuildings(msg.buildings);
        this.minimap.setBuildings(msg.buildings);
        this.editor.setBuildings(msg.buildings);
        this.buildingsCache = msg.buildings;
        break;
      case 'terrain':
        this.setTerrain(msg.terrain);
        break;
      case 'editRejected':
        this.editor.rejected(msg.id);
        break;
      case 'mapJson':
        downloadText('map.json', msg.json);
        break;
      case 'notice':
        this.showToast(msg.text);
        break;
      case 'navDebug':
        this.nav.receive(msg.data);
        break;
      case 'paths':
        this.pathOverlay.receive(msg.entries, msg.cleared);
        break;
      case 'fieldDebug':
        this.fieldOverlay.receive(msg.arrows, msg.fields, msg.settled);
        break;
    }
  };



  private buildingsCache: readonly BuildingDef[] = [];

  /** Crisp rock outlines on top of the distance-field shading. */
  private setOutlines(terrain: readonly Polygon[]): void {
    let n = 16;
    for (const p of terrain) for (const r of p.rings) n += r.length / 2;
    const batch = this.outlines ?? this.renderer.lines.batch(n);
    batch.clear();
    for (const p of terrain) for (const r of p.rings) batch.polyline(r, true, rgba(150, 165, 190, 110), 1.1);
    if (!this.outlines) {
      this.outlines = batch;
      this.underLines.push(batch);
    }
  }

  /** New terrain from an edit: fill mesh, distance field, outlines, minimap, editor checks. */
  private setTerrain(terrain: readonly Polygon[]): void {
    this.renderer.terrain.setTerrain(terrain, this.mapW, this.mapH);
    this.setOutlines(terrain);
    this.minimap.setMap(terrain, this.buildingsCache, this.mapW, this.mapH);
    this.editor.setMapData(terrain, this.buildingsCache);
  }

  private wireEditorPanel(): void {
    for (const b of document.querySelectorAll<HTMLButtonElement>('#editor [data-tool]')) {
      b.addEventListener('click', () => this.editor.setTool(b.dataset.tool as EditorTool));
    }
    const on = (id: string, fn: () => void): void => document.getElementById(id)?.addEventListener('click', fn);
    on('ed-undo', () => this.editor.undo());
    on('ed-redo', () => this.editor.redo());
    on('ed-export', () => this.host.requestMapJson());
    const file = document.getElementById('ed-file') as HTMLInputElement | null;
    on('ed-import', () => file?.click());
    file?.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      const text = await f.text();
      try {
        parseMap(text);
        sessionStorage.setItem(CUSTOM_MAP_KEY, text);
        const q = new URLSearchParams(location.search);
        q.set('map', 'custom');
        location.search = q.toString();
      } catch (err) {
        this.showToast(`Invalid map: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    this.syncEditorPanel();
  }

  private syncEditorPanel(): void {
    for (const b of document.querySelectorAll<HTMLButtonElement>('#editor [data-tool]')) {
      b.classList.toggle('on', b.dataset.tool === this.editor.tool);
    }
    const undo = document.getElementById('ed-undo') as HTMLButtonElement | null;
    const redo = document.getElementById('ed-redo') as HTMLButtonElement | null;
    if (undo) undo.disabled = !this.editor.canUndo;
    if (redo) redo.disabled = !this.editor.canRedo;
    const hint = document.getElementById('ed-hint');
    if (hint) hint.textContent = this.editor.hint;
  }

  /** Centers the camera on the centroid of the given units (control-group double tap). */
  private centerOnHandles(handles: readonly number[]): void {
    const s = this.host.ring.latest?.views;
    if (!s) return;
    let x = 0, y = 0, n = 0;
    for (const h of handles) {
      const o = SNAP_HEADER_WORDS + (h & 0xffff) * INST_WORDS;
      if (s.u32[o + I_HANDLE] !== h) continue;
      x += s.f32[o + I_X];
      y += s.f32[o + I_Y];
      n++;
    }
    if (n > 0) this.camCtl.centerOn(x / n, y / n);
  }

  private showToast(text: string): void {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), 1800);
  }

  async start(): Promise<void> {
    const { mapW, mapH, map } = await this.host.ready;
    this.mapW = mapW;
    this.mapH = mapH;
    const up = this.renderer.setMap(map, mapW, mapH);
    this.minimap.setMap(map.terrain, map.buildings, mapW, mapH);
    this.editor.setMapData(map.terrain, map.buildings);
    this.buildingsCache = map.buildings;
    const st = map.stats;
    this.mapInfo = `${map.name} · ${st.terrainPolygons} rock polys / ${st.terrainVertices} verts · ${st.buildings} buildings · gen ${st.totalMs.toFixed(0)} ms · gpu upload ${up.ms.toFixed(0)} ms`;
    const cam = this.renderer.camera;
    cam.centerX = mapW / 2;
    cam.centerY = mapH / 2;
    this.camCtl.setZoom(Math.max(cam.minZoom, Math.min(cam.viewW / mapW, cam.viewH / mapH) * 2.5));

    const border = this.renderer.lines.batch(8);
    border.polyline([0, 0, mapW, 0, mapW, mapH, 0, mapH], true, rgba(120, 132, 150, 200), 2);
    this.underLines.push(border);
    this.setOutlines(map.terrain);

    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const fp = this.frameProf;
    const dtMs = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    fp.current[FrameSys.Frame] = dtMs;
    fp.begin(FrameSys.Cpu);

    this.host.poll();
    this.camCtl.update(dtMs / 1000);

    const ring = this.host.ring;
    const latest = ring.latest;
    if (latest) {
      if (latest.tick !== this.lastSeenTick) {
        this.lastSeenTick = latest.tick;
        this.simTotals.copyWithin(0, 1);
        this.simTotals[this.simTotals.length - 1] = latest.views.f32[H_SYS_BASE + SimSys.Total];
        this.simTotalsN = Math.min(this.simTotals.length, this.simTotalsN + 1);
      }
      const t = this.clock.update(dtMs, latest.tick, latest.views.f64[H_TIME_F64], this.timeScale, this.paused);
      ring.bracket(t, this.bracket);
      const { a, b, alpha } = this.bracket;
      if (a && b) {
        if (b.tick !== this.validatedTick) {
          this.selection.validate(b.views);
          this.validatedTick = b.tick;
        }
        this.selCtl.update();
        const n = this.selection.syncFlags();
        if (n >= 0) this.renderer.units.uploadSelection(this.selection.flags, n);
        this.nav.update(b.views.i32[H_NAV_VERSION]);
        if (this.selection.version !== this.watchedVersion) {
          this.watchedVersion = this.selection.version;
          this.pathOverlay.reset();
          this.host.watchPaths(Int32Array.from(this.selection.handles));
        }
        this.pathOverlay.update(a, b, alpha);
        this.markers.update(now, this.renderer.camera.zoom);
        this.fieldOverlay.update(now);
        this.editor.update();
        this.minimap.update(now, b.views, this.selection.flags);
        this.panel.update(b.views, this.selection.handles, this.groups);
        if (now - this.lastPrune > 2000) {
          this.lastPrune = now;
          const v = b.views;
          this.groups.prune((h) => v.u32[SNAP_HEADER_WORDS + (h & 0xffff) * INST_WORDS + I_HANDLE] === h);
        }
        const under = this.nav.enabled ? [...this.underLines, this.nav.edges] : this.underLines;
        this.renderer.render({
          a, b, alpha, mapW: this.mapW, mapH: this.mapH, under, over: this.overLines,
          overlayTris: this.nav.enabled ? this.nav.fill : null,
        });
      }
    }

    fp.end(FrameSys.Cpu);
    fp.commit();
    if (now - this.lastHud > 250) {
      this.lastHud = now;
      this.updateHud();
    }
  };

  private updateHud(): void {
    const fp = this.frameProf;
    const n = fp.samples(FrameSys.Frame, this.scratchA);
    const p50 = percentile(this.scratchA, n, 0.5, this.scratchB);
    const p95 = percentile(this.scratchA, n, 0.95, this.scratchB);
    const fps = p50 > 0 ? 1000 / p50 : 0;
    const cpuN = fp.samples(FrameSys.Cpu, this.scratchB);
    let cpu = 0;
    for (let k = 0; k < cpuN; k++) cpu += this.scratchB[k];
    cpu /= Math.max(1, cpuN);

    const h = this.hud;
    h.set('fps', 'FPS', `${fps.toFixed(0)}  (p50 ${p50.toFixed(1)} ms · p95 ${p95.toFixed(1)} ms)`);
    h.set('cpu', 'Main CPU', `${cpu.toFixed(2)} ms/frame`);
    const latest = this.host.ring.latest;
    if (latest) {
      const f = latest.views.f32;
      const parts = SIM_SYSTEM_NAMES.map((name, i) => `${name} ${f[H_SYS_BASE + i].toFixed(2)}`);
      const simP95 = percentile(this.simTotals.subarray(this.simTotals.length - this.simTotalsN), this.simTotalsN, 0.95, this.scratchB);
      h.set('sim', 'Sim tick', `${f[H_SYS_BASE + SimSys.Total].toFixed(2)} ms (p95 ${simP95.toFixed(2)}) @ ${SIM_HZ} Hz`);
      h.set('sys', 'Systems', parts.join(' · '));
      h.set('tick', 'Tick', `${latest.tick}${this.paused ? '  ⏸ paused' : ''}${this.timeScale !== 1 ? `  ×${this.timeScale}` : ''}`);
      h.set('units', 'Units', `${latest.views.i32[H_ALIVE]}`);
      h.set('paths', 'Paths', `${latest.views.i32[H_PATH_SERVED]} served/tick · ${latest.views.i32[H_PATH_QUEUE]} queued`);
    }
    h.set('sel', 'Selected', `${this.selection.handles.size}`);
    h.set('mode', 'Sim host', this.host.mode);
    h.set('map', 'Map', this.mapInfo);
    h.set('nav', 'Navmesh', this.nav.enabled ? this.nav.info : 'F2 to show');
    h.set('fields', 'Fields', this.fieldOverlay.info);
    const sn = Math.min(this.simTotalsN, 240);
    this.graph.draw(this.scratchA, n, this.simTotals.subarray(this.simTotals.length - sn), sn);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (isTypingTarget(e.target) || e.repeat) return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        this.paused = !this.paused;
        this.host.control({ paused: this.paused });
        break;
      case 'Period':
        if (this.paused) this.host.control({ step: true });
        break;
      case 'BracketLeft':
      case 'BracketRight': {
        const scales = [0.125, 0.25, 0.5, 1, 2, 4];
        const i = scales.indexOf(this.timeScale);
        const j = Math.max(0, Math.min(scales.length - 1, (i < 0 ? 3 : i) + (e.code === 'BracketLeft' ? -1 : 1)));
        this.timeScale = scales[j];
        this.host.control({ timeScale: this.timeScale });
        break;
      }
      case 'Backquote':
        this.el.hud.parentElement?.classList.toggle('hidden');
        break;
      case 'Escape':
        if (this.editor.active) this.editor.cancel();
        else if (this.commands.mode !== 'none') this.commands.setMode('none');
        else this.selection.clear();
        break;
      case 'KeyM':
        this.commands.setMode('move');
        break;
      case 'KeyP':
        this.commands.setMode('patrol');
        break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5':
      case 'Digit6': case 'Digit7': case 'Digit8': case 'Digit9': case 'Digit0': {
        const n = Number(e.code.slice(5));
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          this.groups.assign(n, this.selection.handles);
          this.showToast(`Control group ${n}: ${this.selection.handles.size} units`);
        } else if (e.shiftKey) {
          this.groups.add(n, this.selection.handles);
        } else {
          const { handles, double } = this.groups.recall(n, performance.now());
          if (handles.length === 0) break;
          this.selection.set(handles, false);
          if (double) this.centerOnHandles(handles);
        }
        break;
      }
      case 'Equal':
        this.host.command({ kind: 'spawnRandom', count: 1000 });
        break;
      case 'Delete':
      case 'Backspace':
        if (this.editor.active && this.editor.popVertex()) break;
        if (this.selection.handles.size > 0) {
          this.host.command({ kind: 'despawn', handles: Int32Array.from(this.selection.handles) });
          this.selection.clear();
        }
        break;
      case 'F1':
        e.preventDefault();
        this.el.help.classList.toggle('hidden');
        break;
      case 'F2':
        e.preventDefault();
        this.nav.toggle();
        break;
      case 'F3':
        e.preventDefault();
        this.nav.cycleClass();
        break;
      case 'F4':
        e.preventDefault();
        this.fieldOverlay.toggle();
        break;
      case 'KeyB':
        this.editor.setTool('building');
        break;
      case 'KeyR':
        this.editor.setTool('rock');
        break;
      case 'KeyT':
        this.editor.setTool('carve');
        break;
      case 'KeyG':
        this.editor.setTool('brushAdd');
        break;
      case 'KeyC':
        this.editor.setTool('brushCarve');
        break;
      case 'KeyQ':
      case 'KeyE':
        this.editor.resize(e.code === 'KeyE' ? 1 : -1);
        break;
      case 'KeyZ':
      case 'KeyY':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (e.code === 'KeyY' || e.shiftKey) this.editor.redo();
          else this.editor.undo();
        }
        break;
      case 'Enter':
        this.editor.finishPolygon();
        break;
      case 'KeyS':
      case 'KeyH':
        if (this.selection.handles.size > 0) {
          this.host.command({ kind: e.code === 'KeyS' ? 'stop' : 'hold', handles: Int32Array.from(this.selection.handles) });
        }
        break;
      case 'KeyX':
        this.editor.setTool('erase');
        break;
    }
  };
}
