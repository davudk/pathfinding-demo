import { H_ALIVE, H_NAV_VERSION, H_PATH_QUEUE, H_PATH_SERVED, H_SYS_BASE, H_TIME_F64, type FromSim, type SceneConfig } from '../shared/protocol';
import { Faction } from '../shared/factions';
import { NavOverlay } from './navOverlay';
import { ClickMarkers, PathOverlay } from './pathOverlay';
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

export interface AppElements {
  readonly canvas: HTMLCanvasElement;
  readonly hud: HTMLElement;
  readonly graph: HTMLCanvasElement;
  readonly selBox: HTMLElement;
  readonly help: HTMLElement;
  readonly toast: HTMLElement;
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
  private readonly pathOverlay: PathOverlay;
  private readonly markers: ClickMarkers;
  private watchedVersion = -1;
  private pointerX = -1;
  private pointerY = -1;
  private buildSize = 1;
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
    this.markers = new ClickMarkers(this.renderer.lines.batch(256));
    this.overLines.push(this.pathOverlay.batch, this.markers.batch);
    el.canvas.addEventListener('pointerdown', this.onRightDown);
    this.host.onEvent = this.onSimEvent;
    el.canvas.addEventListener('pointermove', (e) => {
      this.pointerX = e.offsetX;
      this.pointerY = e.offsetY;
    });
    window.addEventListener('keydown', this.onKey);
  }

  private readonly onSimEvent = (msg: FromSim): void => {
    switch (msg.type) {
      case 'buildings':
        this.renderer.buildings.setBuildings(msg.buildings);
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
    }
  };

  /** Right-click: move the selection to the clicked point. */
  private readonly onRightDown = (e: PointerEvent): void => {
    if (e.button !== 2 || this.selection.handles.size === 0) return;
    const cam = this.renderer.camera;
    const x = cam.screenToWorldX(e.offsetX), y = cam.screenToWorldY(e.offsetY);
    if (x < 0 || y < 0 || x > this.mapW || y > this.mapH) return;
    this.host.command({ kind: 'move', handles: Int32Array.from(this.selection.handles), x, y });
    this.markers.add(x, y);
  };

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
    const st = map.stats;
    this.mapInfo = `${map.name} · ${st.terrainPolygons} rock polys / ${st.terrainVertices} verts · ${st.buildings} buildings · gen ${st.totalMs.toFixed(0)} ms · gpu upload ${up.ms.toFixed(0)} ms`;
    const cam = this.renderer.camera;
    cam.centerX = mapW / 2;
    cam.centerY = mapH / 2;
    this.camCtl.setZoom(Math.max(cam.minZoom, Math.min(cam.viewW / mapW, cam.viewH / mapH) * 2.5));

    const border = this.renderer.lines.batch(8);
    border.polyline([0, 0, mapW, 0, mapW, mapH, 0, mapH], true, rgba(120, 132, 150, 200), 2);
    this.underLines.push(border);
    // Crisp rock outlines on top of the distance-field shading.
    const outlines = this.renderer.lines.batch(st.terrainVertices + 16);
    for (const p of map.terrain) for (const r of p.rings) outlines.polyline(r, true, rgba(150, 165, 190, 110), 1.1);
    this.underLines.push(outlines);

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
        this.selection.clear();
        break;
      case 'Equal':
        this.host.command({ kind: 'spawnRandom', count: 1000 });
        break;
      case 'Delete':
      case 'Backspace':
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
      case 'KeyB': {
        if (this.pointerX < 0) break;
        const sizes: [number, number][] = [[2, 2], [3, 3], [4, 3], [5, 5], [6, 6], [8, 2]];
        if (e.shiftKey) {
          this.buildSize = (this.buildSize + 1) % sizes.length;
          this.showToast(`Building size ${sizes[this.buildSize][0]}×${sizes[this.buildSize][1]}`);
          break;
        }
        const cam = this.renderer.camera;
        const [w, h] = sizes[this.buildSize];
        this.host.command({ kind: 'placeBuilding', x: cam.screenToWorldX(this.pointerX), y: cam.screenToWorldY(this.pointerY), w, h, faction: Faction.Player, type: 'barracks' });
        break;
      }
      case 'KeyX': {
        if (this.pointerX < 0) break;
        const cam = this.renderer.camera;
        this.host.command({ kind: 'removeBuildingAt', x: cam.screenToWorldX(this.pointerX), y: cam.screenToWorldY(this.pointerY) });
        break;
      }
    }
  };
}
