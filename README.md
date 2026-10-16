# RTS Pathfinding Demo

A StarCraft II–style pathfinding and unit-movement demo in the browser. Thousands of circular units of different sizes and speeds move across a large map with polygonal terrain and runtime-placeable buildings. Written in TypeScript with a raw WebGL2 renderer, and the simulation runs in a Web Worker.

See [docs/PLAN.md](docs/PLAN.md) for the architecture and milestones, and [docs/research/](docs/research/) for the background research.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173. Press **F1** in the app for controls.

URL parameters:

| Param | Default | Meaning |
|---|---|---|
| `scene` | stress | `stress` (10k ambient units), `choke` (200 through a 4-wide gap), `holdline` (movers funnel through a gap in a line of holders), `cross` (two armies swap sides), `blob` (mixed group converges and settles), `drop` (a building lands on a marching column) |
| `map=custom` | — | load the map last imported through the editor (Import button) |
| `units` | 10000 | number of units in the stress scene |
| `seed` | 42 | RNG seed (the simulation is deterministic per seed) |
| `mapSeed` | 1337 | seed of the procedural 9-zone map |
| `sim=main` | — | run the simulation on the main thread (for debugging with breakpoints) |
| `transport=transfer` | — | force transferable-buffer snapshots instead of SharedArrayBuffer |

## Scripts

| Script | |
|---|---|
| `npm run dev` | Vite dev server (sends COOP/COEP headers so SharedArrayBuffer is available) |
| `npm run typecheck` | type-checks the app and the worker separately (the sim cannot use DOM APIs) |
| `npm test` | unit, determinism and module-boundary tests |
| `npm run bench` | micro-benchmarks. Numbers are relative: Vite's Node transform slows module-constant access |
| `npm run build` | type-check, then production build |

## Layout

- `src/sim/` — the deterministic simulation. It imports only `shared/` and npm geometry packages, and runs in the worker.
  - `sim/map/` — map generation (9 zones), Clipper2 normalization into lattice-snapped obstacle polygons, building placement validation, and the occupancy raster.
- `src/shared/` — the protocol, snapshot layout, handles, RNG and archetypes.
- `src/app/` — main-thread orchestration: sim host, snapshot ring and render clock.
- `src/render/` — the WebGL2 renderer: ground with ambient occlusion and cast shadows from the terrain distance field, beveled rock, instanced buildings, instanced SDF units and thick lines.
- `src/input/` — camera and selection.
- `src/ui/` and `src/debug/` — the HUD and the frame graph.
