# RTS Pathfinding Demo

A StarCraft II–style pathfinding and unit-movement demo in the browser. **10,000 circular units** of different sizes and speeds move across a 512×512 map with polygonal terrain, buildings you can place and remove at runtime, and several factions. It's written in TypeScript with a raw WebGL2 renderer, and the deterministic simulation runs in a Web Worker.

- **Navigation:** a dynamic constrained Delaunay navmesh with Demyen clearance widths. One mesh serves every unit radius, and buildings are inserted and removed incrementally.
- **Paths:** radius-aware A* over triangles, a circle-tangent funnel, and shared destination fields for group orders. A 500-unit order has paths for every unit within 2 ticks.
- **Locomotion:** SC2-style. Steering with keep-right avoidance; priority pushing (idle allies get shoved, hold-position units never yield, enemies never push); wall sliding; chain arrival without dancing; local detours around walls of units that won't move.
- **Orders:** move, Shift-queue, patrol, stop and hold; magic-box formations; control groups; minimap.
- **Living world:** wanderers, patrols, a convoy, and critter herds that scatter from armies.
- **Editor:** buildings, rock and carve polygons and brushes, undo/redo, map export and import.

Measured in a production build on Apple Silicon with 10,000 units: the simulation takes p50 8.6 ms and p95 11.0 ms per 30 Hz tick in its worker, while rendering holds 120 fps (frame p99 9.3 ms).

See [docs/PLAN.md](docs/PLAN.md) for the architecture, the per-milestone implementation notes and the measurements, and [docs/research/](docs/research/) for the background research.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173 and press **F1** for controls. Pick a scenario in the panel at the top right.

### Controls (SC2 conventions)

| Input | Action |
|---|---|
| Left click / drag | Select / box select (Shift: add, double-click or Ctrl: same type in view) |
| Right click | Move (Shift: queue a waypoint) |
| M / P + click | Move / patrol (Shift keeps the mode armed) |
| S / H | Stop / hold position |
| Ctrl/⌘ + 1–9, Shift + 1–9, 1–9 | Assign / add to / recall a control group (press twice to center on it) |
| Two-finger scroll, arrow keys, screen edge, middle drag | Pan |
| Pinch, mouse wheel | Zoom to cursor |
| B / X | Place / erase buildings (Q/E: size) |
| R / T, G / C | Rock / carve polygon (Enter closes), rock / carve brush |
| Ctrl/⌘ + Z, Shift + Z | Undo / redo edits |
| F2 / F3 / F4 | Navmesh overlay / radius class / destination-field arrows |
| F5 | Tuning panel (steering, contacts, display options, colour-blind palette) |
| Space / . / [ ] | Pause / step / slower or faster |
| = / Delete | Spawn 1000 ambient units / remove the selection |

### URL parameters

| Param | Default | Meaning |
|---|---|---|
| `scene` | `stress` | `stress` (ambient 10k world), `choke`, `holdline`, `cross`, `blob`, `drop`, `canyon`, `maze`, `trap`, `town`, `queue`, `empty`. All are also in the picker. |
| `units` | 10000 | Units in the ambient world |
| `seed` / `mapSeed` | 42 / 1337 | Simulation and map seeds. The simulation is deterministic per seed and command stream. |
| `bench=N` | — | After a 5 s warm-up, record N seconds of frame and sim timings and show percentiles (also in `window.__bench`) |
| `map=custom` | — | Load the map last imported through the editor |
| `sim=main` | — | Run the simulation on the main thread (for debugging with breakpoints) |
| `transport=transfer` | — | Force transferable-buffer snapshots instead of SharedArrayBuffer |

For representative performance numbers, benchmark a production build:

```bash
npm run build
```

```bash
npx vite preview
```

Then open `http://localhost:4173/?bench=30`.

## Scripts

| Script | |
|---|---|
| `npm run dev` | Vite dev server (sends COOP/COEP headers so SharedArrayBuffer is available). About 2× slower than a production build. |
| `npm run typecheck` | Type-checks the app and the worker separately (the sim can't touch DOM APIs) |
| `npm test` | Unit, fuzz, scenario, determinism and module-boundary tests |
| `npm run bench` | Micro-benchmarks. Numbers are relative only, because Vite's Node transform slows module-constant access. |
| `npm run build` | Type-check, then production build |

## Layout

- `src/sim/` — the deterministic simulation: no DOM, seeded RNG only. It runs in the worker.
  - `map/` — the 9-zone generator, Clipper2 normalization, placement validation, occupancy raster
  - `nav/` — dynamic CDT, navmesh widths and regions, A*, funnel, clearance queries, path queue and cache, destination fields
  - `move/` — orders and queues, magic box, locomotion (steering, contacts, arrival, stuck handling), detours, field followers
  - `ai/` — ambient brains · `scenarios/` · `edit.ts` (runtime building and terrain edits)
- `src/shared/` — protocol and snapshot layout, geometry, map format, archetypes, factions, tuning, profiler
- `src/app/` — main-thread orchestration: sim host, snapshot ring, render clock, overlays, editor, tuning panel, benchmark
- `src/render/` — WebGL2: distance-field terrain (bevel, ambient occlusion, cast shadows), instanced buildings and SDF units, thick lines, debug fills
- `src/input/` — camera, selection, commands, control groups · `src/ui/` — HUD, minimap, selection panel
