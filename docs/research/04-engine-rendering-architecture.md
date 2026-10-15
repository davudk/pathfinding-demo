# 04 — Engine architecture, performance and rendering

Status: research recommendation, 2026-10-15. Scope: tooling, renderer, simulation data layout, main loop and threading, WASM vs TS, instrumentation, RTS input/UX, code layout. Pathfinding algorithms themselves (navmesh, funnel, flow fields, local avoidance) are covered by sibling research docs; this doc defines the engine they plug into.

## TL;DR (opinionated)

| Decision | Recommendation |
|---|---|
| Tooling | Vite 8 + TypeScript strict + Vitest 5, pnpm, ESLint/Biome; no framework for the game view |
| Renderer | **Raw WebGL2, hand-written thin renderer**, instanced SDF quads for units, one batched line/triangle renderer for terrain and debug. WebGPU backend later behind the same interface, not first |
| UI | DOM overlay (HTML/CSS) for HUD, panels, stats text; canvas-only for in-world markers |
| Sim data | SoA in typed arrays, fixed capacity (16k), 32-bit handles = index + generation, free list, dense active list |
| Neighbors | Uniform grid rebuilt each tick by counting sort; cell size ≈ 2× max common radius; large units inserted in all overlapped cells |
| Loop | Fixed 30 Hz simulation tick, render at display rate (60–144 Hz) with interpolation between last two ticks |
| Threading | **Simulation in a dedicated Web Worker** from day one; snapshot via SharedArrayBuffer when `crossOriginIsolated`, fallback to transferable ping-pong buffers. Same sim code also runs on main thread for tests/headless |
| WASM | Not initially. Plain TS over typed arrays is within ~1.5–2× of WASM for this kind of code; revisit only for a measured hot kernel (e.g. RVO) |
| Instrumentation | Own ring-buffer profiler (per-system ms, per tick and per frame), canvas sparkline graph, GPU timer query when available, `performance.mark` for DevTools |

## 1. Build tooling

Current stable versions checked via `npm view` on 2026-10-15:

- `vite` 8.3.4 (Rolldown-based bundler; fast dev server, native worker support via `new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })`).
- `vitest` 5.0.5 (shares Vite config; use `environment: 'node'` for sim tests — the simulation must not touch DOM).
- `typescript` 7.0.2 (the native Go port, `tsgo`; much faster type-check). Keep `tsc --noEmit` as a CI step; Vite only strips types.
- Supporting: `@webgpu/types` 0.1.74 (only if/when WebGPU backend lands), `lil-gui` 0.21.0 for debug toggles, `vite-plugin-glsl` 1.6.2 (optional; plain `?raw` imports of `.glsl` files are enough).

`tsconfig.json` essentials: `"strict": true`, `"noUncheckedIndexedAccess": true` (but see note below), `"exactOptionalPropertyTypes": true`, `"noImplicitOverride": true`, `"verbatimModuleSyntax": true`, `"target": "ES2023"`, `"module": "ESNext"`, `"moduleResolution": "bundler"`, `"lib": ["ES2023", "DOM", "WebWorker"]` (split into two tsconfigs: `tsconfig.app.json` with DOM, `tsconfig.worker.json` with WebWorker, so the sim cannot accidentally use `document`).

Note on `noUncheckedIndexedAccess`: typed-array reads become `number | undefined`, which is noisy in hot loops. Keep it on globally; in `sim/` kernels use local `const x = posX` aliases and the `!` operator sparingly, or disable it only for the `sim/kernels` tsconfig project. Do not sprinkle `?? 0` in hot loops (adds branches).

Testing: Vitest for pure logic (geometry predicates, grid, handle allocator, pathfinding correctness, determinism hash after N ticks). Add `vitest bench` for kernel micro-benchmarks (grid rebuild, neighbor query, steering at 10k). Playwright for a single smoke test (page loads, 10k units spawn, no console errors, frame time p95 under budget on CI hardware — informative, not gating).

## 2. Rendering

### Options compared

| | Raw WebGL2 | PixiJS v8 (8.22.0) | Three.js (r186) | WebGPU |
|---|---|---|---|---|
| 10k instanced SDF circles | Trivial, 1 draw call | Possible via custom `Mesh`/shader, but sprite path does per-sprite CPU batching | Possible via `InstancedMesh` + custom `ShaderMaterial` | Trivial, plus compute shaders |
| Per-frame CPU cost at 10k | Minimal: one `bufferSubData` of ~10k × 16–32 B | Scene graph + batcher overhead per display object unless you bypass it | Scene graph overhead small with instancing, but 3D-oriented | Minimal |
| Debug lines (100k+ segments) | Own batched line renderer | `Graphics` re-tessellation is costly when rebuilt per frame | `LineSegments`, fine | Own |
| Control / crispness | Full (SDF AA with `fwidth`) | Good | Good | Full |
| Support late 2026 | Universal | Universal (WebGL2/WebGPU backends) | Universal | Chrome/Edge, Safari 26; Firefox Windows + Apple Silicon macOS, Linux/Android still incomplete |
| Bundle | ~0 | ~200–300 kB | ~600 kB+ | ~0 |

### Recommendation: raw WebGL2, thin custom renderer

The scene is entirely 2D, consisting of a handful of primitive kinds that all reduce to *instanced quads* and *batched line/triangle lists*. A general-purpose scene graph buys nothing and costs per-object overhead, while we need exact control over buffer layouts so that the sim snapshot can be uploaded nearly verbatim. ~1,500 lines of renderer code is a small price. WebGPU is attractive (compute-shader culling, storage buffers) but Firefox's platform gaps make it a poor sole target; design the renderer behind a small `Renderer` interface (`beginFrame`, `drawUnits`, `drawLines`, `drawPolys`, `endFrame`) so a WebGPU backend can be added later.

### Pipelines (draw order)

1. **Terrain**: static triangle mesh of walkable ground + obstacle polygons (triangulated once with earcut or the navmesh triangulator), one VBO, one draw call. Obstacle outlines as thick lines.
2. **Buildings**: instanced rounded-rect SDF or polygon mesh; static-ish, re-upload only on change.
3. **Selection rings / ground decals**: instanced SDF ring pass under units (only for selected units — upload a compact list).
4. **Units**: one instanced draw. Per-instance attributes (interleaved, 16–24 bytes): `prevX, prevY, currX, currY` (f32 ×4) or just current position if interpolation is done on the CPU, `radius` (f16/f32), `faction|type|flags` (u8×4 normalized), `heading` (u8/u16 normalized), `hp` (u8 normalized). Vertex shader expands a unit quad by `radius + aaPad`; fragment shader computes `d = length(p) - r` and `alpha = clamp(0.5 - d / fwidth(d), 0, 1)` for crisp edges at any zoom. Facing indicator, faction rim, and HP arc are all computed in the same fragment shader (no extra draws). Doing interpolation in the vertex shader (`mix(prev, curr, alpha)` uniform) means the CPU never touches per-unit data between ticks: upload once per sim tick, not per frame.
5. **Health bars**: either inside the unit shader (arc) or a separate instanced pass only for damaged/selected/hovered units.
6. **Debug overlays**: a single dynamic `LineBatch` (positions + RGBA8 colors, `GL_LINES`, or instanced quads for thick lines since `lineWidth > 1` is not supported on most platforms). Navmesh triangles are static: build once into their own VBO and toggle. Paths, flow-field arrows, avoidance velocities and grid cells are dynamic and only for selected units (cap at e.g. 2,000 segments per category) — never draw debug for all 10k units by default.
7. **Ground click marker / rally lines**: tiny instanced pass, animated by time uniform.
8. **Minimap**: render to a separate small canvas (or an FBO region) at low frequency (10 Hz): static terrain texture baked once + units as 1–2 px points (`GL_POINTS` from the same instance buffer) + camera frustum rectangle.

Practical notes:
- Use `devicePixelRatio`-aware canvas sizing (`ResizeObserver` with `devicePixelContentBoxSize`) for crispness; cap DPR at 2 for fill-rate.
- Disable MSAA (`antialias: false`), rely on SDF AA; use `powerPreference: 'high-performance'`, `desynchronized: true` can reduce latency on some platforms.
- Camera is an orthographic 2D transform (3×3 matrix uniform). Cull on CPU only at coarse level (skip uploading off-screen units is not worth it at 10k; GPU vertex cost is negligible). Let the GPU clip.
- Use `EXT_disjoint_timer_query_webgl2` (when exposed — usually Chrome desktop) to measure GPU time per pass.
- Avoid `gl.getError()` and any sync readback in release builds.

### Text / UI

DOM overlay, absolutely positioned over the canvas: HUD, selection panel (unit portraits grid), command card, control-group bar, stats overlay text, settings. DOM is accessible, crisp, trivially styled and costs nothing if updated at ≤10 Hz and only on change (diff before writing `textContent`). Avoid per-unit DOM nodes. In-world text (unit IDs for debug) only for a capped hovered/selected set — either DOM labels (≤50) or an SDF/MSDF font atlas if more are needed later. Set `pointer-events: none` on overlay containers except interactive panels so the canvas keeps receiving input.

## 3. Simulation data layout

### Structure of Arrays

```ts
const CAP = 16384; // power of two, fixed; reallocate never in hot path
export interface UnitStore {
  posX: Float32Array; posY: Float32Array;     // current
  velX: Float32Array; velY: Float32Array;
  prefVX: Float32Array; prefVY: Float32Array; // desired velocity from pathing
  radius: Float32Array; maxSpeed: Float32Array;
  faction: Uint8Array; type: Uint16Array; flags: Uint16Array; // moving, holding, selected-hint...
  order: Uint8Array; goalX: Float32Array; goalY: Float32Array;
  pathId: Int32Array; pathCursor: Uint16Array;
  gen: Uint16Array;                            // generation per slot
}
```

Use `Float32Array` for positions (map up to ~16k world units keeps ~1e-3 precision; enough). Use `Float64Array` only if determinism/precision issues appear. All arrays can be views into one big `ArrayBuffer`/`SharedArrayBuffer` so the whole state is one allocation (handy for snapshotting and for SAB sharing).

### Handles

`handle = (gen << 16) | index` packed in a 32-bit int (16k cap → 14 bits index; use 16 for headroom; gen 15 bits to stay positive smi). On free, `gen[i] = (gen[i] + 1) & 0x7fff`; validate with `gen[h & 0xffff] === h >>> 16`. Free list as an `Int32Array` stack. Maintain a **dense active list** (`active: Int32Array`, `activeCount`, plus `denseIndex[slot]` for O(1) swap-remove) so systems iterate `for (let k = 0; k < activeCount; k++) { const i = active[k]; ... }` without testing liveness. Orders, selection sets and control groups store handles, never raw indices.

### Avoiding GC

- No closures, `Array.prototype.map/forEach`, object spread, tuples or `{x, y}` returns in per-unit loops. Return results via out-params into scratch typed arrays.
- Preallocate scratch buffers (neighbor list, path buffers, command buffers) at init.
- Keep hot functions monomorphic: same argument types/shapes; avoid mixing `number` and `undefined`.
- Variable-length data (paths) goes into a pooled arena: `pathPoints: Float32Array` + per-path offset/length, with a simple slab/free-list allocator, rather than JS arrays per unit.
- Verify with DevTools Memory "Allocation sampling" — target zero allocations per tick at steady state.

### Spatial grid with counting sort

Rebuilt every tick from scratch (cheaper and simpler than incremental updates at 10k moving units):

1. `cellOf[i] = cy * gridW + cx` for each active unit (clamped).
2. `cellCount.fill(0)`; histogram.
3. Exclusive prefix sum into `cellStart` (length `cells + 1`).
4. Scatter unit indices into `cellItems` using a cursor copy of `cellStart`.

O(n + cells), cache-friendly, zero allocation. Cell size: about `2 × typical radius + max query margin` (e.g. small units r=0.5, cell = 2). Varying radii: query range is `r_i + r_max_neighbor + margin`; for the rare big units (r > cell size) either (a) insert them in every overlapped cell (need a second "multi-cell" list, since counting sort assumes one cell per item), or (b) keep large units in a separate small list checked by everyone — (b) is simpler and fine when large units are < 1%. Optional: reorder SoA arrays by cell every N ticks (spatial sorting) for cache locality — measure first. Map 256×256 world units with 2-unit cells = 16k cells: trivially small.

Static obstacles and buildings live in a separate static grid/BVH built once (updated on build/destroy).

## 4. Main loop and threading

### Fixed timestep with interpolation

Per Fiedler's "Fix Your Timestep!": accumulate real time, run `while (acc >= dt) { tick(); acc -= dt; }`, render with `alpha = acc / dt` interpolating `prev`→`curr`. Clamp frame delta (e.g. 250 ms) to avoid spiral of death; when ticks fall behind, slow game time rather than skipping.

**Tick rate: 30 Hz** (SC2 runs 16 game loops/game-second, ×1.4 on Faster = 22.4 Hz). 30 Hz halves sim cost vs 60 Hz and leaves headroom for 10k units with avoidance; interpolation hides it entirely at 120 Hz display. Make it a constant (`SIM_HZ`) so 60 Hz can be tried. Input commands are timestamped with the tick they apply to (lockstep-style command queue) — this also gives determinism and replay for free.

### Worker vs main thread: run the sim in a Worker

At 120 Hz the frame budget is 8.3 ms. A 30 Hz tick costing 5–8 ms at 10k units (grid + avoidance + path following + occasional path requests) on the main thread would cause a long frame every 4th frame — visible judder that interpolation cannot fix. Moving the sim to a dedicated worker decouples them: the main thread only handles input, interpolation (on GPU) and rendering, staying well under budget.

Design:
- **Commands main → worker**: `postMessage` of small structured command objects (select is main-thread-only; move/stop/patrol/hold carry handle lists as `Int32Array`, transferable). Commands target `currentTick + 1` (or +2).
- **Snapshots worker → main**: after each tick, publish a render snapshot: `tick`, `count`, and interleaved per-unit render data (`x, y, radius, packedAttrs`, plus `handle` for picking). Two transport modes behind one interface:
  - **SAB mode** (when `self.crossOriginIsolated`): triple-buffered snapshot region in a `SharedArrayBuffer`; worker writes buffer `w`, then `Atomics.store(latest, w)`; main thread reads `Atomics.load(latest)` each frame and keeps the previous one for interpolation. No copies beyond GPU upload, no messages per tick.
  - **Transfer mode** (fallback, e.g. plain static hosting): pool of 3–4 `ArrayBuffer`s ping-ponged with transfer lists — zero-copy, zero GC, ~320 kB per tick at 10k units, fine.
- **Picking/selection** done on main thread from the latest snapshot (box select is a scan of ≤10k positions — < 0.1 ms; or build a small grid there).
- **Debug data** (navmesh triangles, selected units' paths, flow fields) requested on demand by the main thread and sent as separate transferable buffers when toggled or when the selection changes.
- The sim module is pure (`createWorld`, `step(world, commands)`), so Vitest and a `?sim=main` URL flag can run it on the main thread for debugging with breakpoints.

COOP/COEP for SAB — Vite config:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
const coi = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
export default defineConfig({
  server: { headers: coi },
  preview: { headers: coi },
  worker: { format: 'es' },
  build: { target: 'es2023', sourcemap: true },
});
```

For production on hosts that cannot set headers (GitHub Pages), the transfer fallback works; alternatively the `coi-serviceworker` shim re-serves the page with the headers. `COEP: credentialless` is an option if third-party assets are needed (Chromium/Firefox).

Optional later: split pathfinding into a second worker (path requests are bursty — a 200-unit move order on a big map should not stall the tick); results come back asynchronously and units follow a straight-line/flow-field placeholder until the path arrives.

## 5. WASM vs TypeScript

At 10k units the hot loops (grid rebuild, neighbor iteration, steering/ORCA, integration) are simple float arithmetic over typed arrays. Modern JITs (V8 TurboFan/Maglev, JSC FTL) compile such monomorphic code close to native; typical measurements put well-written TS within 1.2–2× of WASM for these kernels, while WASM adds a toolchain, a JS↔WASM boundary, and harder debugging. The real performance risks are algorithmic (O(n²) neighbors, too-frequent repaths) and GC, both solved in TS by the design above. WASM SIMD can win 2–4× on wide data-parallel kernels — so: **TS first**, keep kernels as pure functions over typed arrays with no object arguments (which is also exactly the shape that ports mechanically to Rust/Zig later), benchmark with `vitest bench`, and port a single kernel to Rust (`wasm-bindgen`, shared linear memory) only if a profiled kernel exceeds budget. AssemblyScript is not recommended (smaller ecosystem, marginal gains over TS).

Budget target (30 Hz tick, worker): total ≤ 12 ms at 10k units, leaving headroom on mid-range laptops. Rough allocation: grid 0.3 ms, local avoidance 4–6 ms, path following/flow field 1–2 ms, collisions/push-out 1–2 ms, snapshot write 0.2 ms.

## 6. Performance instrumentation

Build a tiny profiler, not a dependency:
- `prof.begin(SYS_AVOID)` / `prof.end(SYS_AVOID)` writing `performance.now()` deltas into `Float32Array` ring buffers (256 samples per system), zero allocation. Worker sends its per-tick timing array along with each snapshot.
- Overlay (toggle `F3` / backtick): frame time sparkline (canvas 2D, 240 samples, lines at 8.3/16.7/33 ms), sim tick time stacked by system, FPS, p50/p95/p99 frame time, unit count, active paths, path requests/s, draw calls, instance count, GPU time (timer query), JS heap (`performance.memory` where available).
- `performance.mark/measure` behind a debug flag so traces line up in the DevTools Performance panel.
- Reproducible benchmark scenes via URL params (`?scene=stress10k&seed=42`) and an automated "run 30 s, report p95" mode for regressions.
- `stats-gl` (4.2.3) is an acceptable quick start for FPS/GPU graphs, but the custom per-system breakdown is what matters.

## 7. Input and UX

Coordinate conventions: world units in "cells" (1 unit = smallest pathing cell; small unit radius ≈ 0.375–0.5 like SC2). **World: +X right, +Y down** (matches screen and canvas, avoids flip bugs in picking; the shader handles projection). Origin at map top-left. Angles in radians, 0 = +X, clockwise visually. Three spaces with explicit conversion functions: `screen (CSS px)` ↔ `world` via `Camera` (`center`, `zoom` = px per world unit), `world` ↔ `cell` (grid). Never mix; name variables `sx/sy`, `wx/wy`, `cx/cy`.

Input architecture: raw DOM events → `InputState` (keys down, mouse buttons, positions, modifiers, sampled once per frame) → `Controller` maps to intents → `CommandBuffer` sent to sim. Use Pointer Events with `setPointerCapture` for drags; `contextmenu` prevented on the canvas; `KeyboardEvent.code` (layout-independent) for hotkeys.

| Action | Behavior |
|---|---|
| Left click | Select single unit under cursor (pick by radius distance from snapshot; prefer own faction) |
| Left drag | Box select (draw in DOM or as a line batch); threshold 4 px before it counts as drag; own units preferred over others, units over buildings |
| Shift + click/drag | Toggle/add to selection |
| Ctrl + click / double-click | Select all of same type within the viewport |
| Ctrl+1..9 | Assign control group; Shift+1..9 add; 1..9 recall; double-tap 1..9 centers camera |
| Right click ground | Move; spawn click marker (expanding ring, ~0.5 s) at world point; formation offsets preserved (move-as-group: keep relative offsets if group is compact, else converge) |
| Shift + right click | Queue waypoint; draw queued waypoints as lines for selected units |
| A + click | Attack-move (stub if no combat) |
| P + click | Patrol between current position and point |
| S | Stop (clear orders) |
| H | Hold position (unit refuses to be pushed by friendly avoidance) |
| Camera | Edge pan (only when pointer locked or window focused and cursor in 8 px border), WASD/arrows, middle-drag pan (grab: world point stays under cursor), wheel zoom to cursor (keep world point under cursor fixed: `center += (wBefore - wAfter)`), smooth exponential damping, clamp to map bounds |
| Minimap | Click/drag moves camera; right click issues move order |
| Debug | F1–F9 toggle overlays (navmesh, grid, paths, flow field, velocities, profiler), `Space` pause, `.` single-step tick, `[`/`]` sim speed |

Selection and control groups live on the main thread as handle sets; stale handles are filtered by generation check against the latest snapshot.

## 8. Directory layout

```
pathfinding-demo/
  index.html
  vite.config.ts  tsconfig.json  tsconfig.app.json  tsconfig.worker.json  vitest.config.ts
  src/
    main.ts                 # bootstrap: canvas, renderer, worker, loop
    app/                    # main-thread orchestration
      loop.ts               # rAF loop, interpolation alpha, frame profiler
      simHost.ts            # worker or in-thread sim behind one interface
      snapshot.ts           # SAB / transfer ring buffers
    shared/                 # used by both threads, no DOM
      protocol.ts           # command + message types, snapshot layout constants
      handles.ts  math.ts  rng.ts  constants.ts
    sim/                    # pure, deterministic, no DOM, no globals
      world.ts  step.ts     # createWorld, step(world, commands)
      store/units.ts        # SoA store, allocator, active list
      spatial/grid.ts       # counting-sort uniform grid
      nav/                  # navmesh, triangulation, A*, funnel, flow fields (per sibling docs)
      steer/                # path following, separation, RVO/ORCA
      orders/               # move, queue, patrol, hold, stop
      scenarios/            # map + spawn definitions, seeds
      sim.worker.ts
    render/
      gl/                   # context, shader/program utils, buffers, timer queries
      shaders/*.glsl
      passes/               # terrain, units, rings, lines, markers, minimap
      camera.ts  renderer.ts
    input/                  # InputState, controller, hotkeys, selection, control groups
    ui/                     # DOM HUD, panels, stats overlay, debug toggles
    debug/                  # profiler, overlay data builders
  tests/                    # or co-located *.test.ts; bench/*.bench.ts
  docs/research/
```

Dependency rule (enforce with ESLint `no-restricted-imports` or `dependency-cruiser`): `sim/` imports only `shared/`; `render/`, `input/`, `ui/` never import `sim/` internals — they consume snapshots and `shared/protocol.ts`.

## References

- Glenn Fiedler, "Fix Your Timestep!": https://gafferongames.com/post/fix_your_timestep/
- Vite docs, server headers and workers: https://vite.dev/config/server-options#server-headers , https://vite.dev/guide/features#web-workers
- Vitest: https://vitest.dev/ ; benchmarking: https://vitest.dev/guide/features#benchmarking
- TypeScript native port (TS 7): https://devblogs.microsoft.com/typescript/
- MDN, SharedArrayBuffer security requirements (COOP/COEP): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements
- web.dev, "Making your website cross-origin isolated": https://web.dev/articles/coop-coep
- coi-serviceworker: https://github.com/gzuidhof/coi-serviceworker
- MDN, Transferable objects: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects
- WebGL2 Fundamentals, instanced drawing: https://webgl2fundamentals.org/webgl/lessons/webgl-instanced-drawing.html
- Inigo Quilez, 2D SDFs: https://iquilezles.org/articles/distfunctions2d/
- EXT_disjoint_timer_query_webgl2: https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/
- WebGPU implementation status: https://github.com/gpuweb/gpuweb/wiki/Implementation-Status ; Khronos SIGGRAPH 2026 WebGL/WebGPU: https://www.khronos.org/developers/linkto/webgl-and-webgpu-sigg26 ; WebGPU vs WebGL 2026 overview: https://app.cinevva.com/guides/webgpu-vs-webgl-games
- PixiJS v8: https://pixijs.com/ ; Three.js InstancedMesh: https://threejs.org/docs/#api/en/objects/InstancedMesh
- Matthias Müller et al. / spatial hashing with counting sort ("Ten Minute Physics" #11): https://matthias-research.github.io/pages/tenMinutePhysics/
- Data-oriented design (Richard Fabian): https://www.dataorienteddesign.com/dodbook/
- V8 performance tips (hidden classes, monomorphism): https://v8.dev/blog/elements-kinds
- SC2 game loop timing (Liquipedia, "Game Speed"): https://liquipedia.net/starcraft2/Game_Speed
- earcut polygon triangulation: https://github.com/mapbox/earcut
- stats-gl: https://github.com/RenaudRohlinger/stats-gl ; lil-gui: https://lil-gui.georgealways.com/
