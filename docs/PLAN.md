# RTS Pathfinding Demo — Architecture & Implementation Plan

Status: **draft for review**, 2026-10-15. This plan combines the five research notes in `docs/research/` (01 navmesh, 02 avoidance/pushing, 03 path-query scaling, 04 engine/rendering, 05 gameplay/maps). Where those notes disagree, the decision taken here is called out under **Resolved conflicts**.

Scope agreed with you so far:
- **Movement only.** No combat, so no attack-move. Factions affect push rules and colors only.
- **Runtime-editable world.** Buildings can be placed and removed while units move, and an editor can draw and erase terrain.
- **Stack:** TypeScript (strict), Vite, raw WebGL2. No game framework.

---

## 1. Goals and targets

| Target | Value |
|---|---|
| Units alive | **10,000** at a solid 60 fps on a recent laptop (store capacity 16,384) |
| Map | 512 × 512 world units (1 unit = 1 SC2 cell), 9 themed zones |
| Sim tick | fixed **30 Hz** in a Web Worker; rendering runs at display rate with interpolation |
| Sim budget | ≤ 12 ms per tick at 10k units; path work ≤ 3 ms per tick (player orders may burst to 8 ms) |
| Click-to-motion latency | ≤ 2 ticks (~66 ms) for any player order, at any group size |
| Building place/remove | < 1 ms of navmesh work. Affected units replan within a few ticks; none walk through it |
| Determinism | same seed + same command stream gives the same state hash (single engine). Tested in CI |

Quality bar, which reads straight off the research:
- No unit overlaps an obstacle.
- Unit-unit overlap stays soft and short-lived.
- No dancing at destinations: chain arrival, and arrived units never re-seek their goal.
- No left/right dithering: avoidance side hysteresis.
- Paths hug corners at the right clearance for each radius.
- Big units never take corridors they don't fit.

---

## 2. Architecture overview

```
 Main thread                                   Sim worker (authoritative, 30 Hz)
 ───────────                                   ──────────────────────────────────
 Input → Controller → Commands ──postMessage──▶ command queue (tick-stamped)
 Selection / control groups (handles)          ORDERS  → order queues, magic box, path requests
 Camera, minimap                               AI      → brains (staggered) emit orders
 WebGL2 renderer                               PATH    → budgeted queue: dest fields + A*
   reads snapshot (SAB triple buffer           GRID    → counting-sort spatial hash
   or transferable ping-pong),                 MOVE    → follow → steer → integrate →
   interpolates on GPU                                   contacts+walls → arrival → stuck
 DOM HUD, profiler overlay, editor UI          NAV     → DynamicCDT, widths, regions
 Debug overlays ◀── on-demand buffers ───────  snapshot write + per-system timings
```

- **One sim codebase, two hosts.** `sim/` is pure. It never touches the DOM or globals and is seeded-RNG only. It runs in the worker in normal use, and on the main thread for tests and `?sim=main` debugging.
- **Transport.** Transferable ping-pong buffers are built first because they always work. SharedArrayBuffer triple-buffering is used when `crossOriginIsolated` is true; Vite sends COOP/COEP headers.
- **Dependency rule.** `sim/` imports only `shared/`. `render/`, `input/` and `ui/` see only snapshots and `shared/protocol.ts`.

---

## 3. Subsystem decisions

### 3.1 Navigation mesh (research 01)
- **One global dynamic constrained Delaunay triangulation (CDT)** in halfedge form on typed arrays, as SC2 does.
  - Vertices are stored as `Float64` on a 1/16-unit lattice.
  - Exact `orient2d`/`incircle` come from `robust-predicates`.
- **Bootstrap** with `delaunator` + `@kninnug/constrainautor`. Those two also serve as a **test oracle** for our own `DynamicCDT`.
- **Buildings** are inserted and removed incrementally:
  - Insertion uses vertex insert plus Sloan flips.
  - Each constraint edge has a refcount. When it reaches 0, the vertex is flipped down to degree 3 and removed, followed by Lawson legalization.
  - Placement is validated so that constraints never cross (no Steiner points from intersections).
- **Terrain edits** in the editor are rarer and can overlap arbitrarily. They go through Clipper2 normalization and then a full rebuild (estimated 20–50 ms for ~30k triangles, acceptable for an editor action). After a rebuild, path invalidation is done by diff.
- **One mesh serves every radius:**
  - Each triangle stores 3 Demyen widths, clamped to `2·rMax`. A* prunes any step narrower than `2r`.
  - Per radius class, connected-region labels give an O(1) "unreachable" answer, with fallback to the closest reachable point.
- **Search:** TA*-style A* over (triangle, entry-edge) nodes with edge-point g-costs and a bounded anytime refinement.
- **Smoothing:** a radius-aware Simple Stupid Funnel. Corners are treated as circles of radius r and connected by circle-to-circle tangents. Its output is a path of tangent segments plus corner arcs.
- **Point location:** a bucket-grid hint plus a stochastic walk. Units cache their triangle as `(id, gen)` and revalidate it before use.
- **Plan B**, if the dynamic CDT proves flaky under fuzzing: tile-local rebuilds (64×64 tiles, delaunator + constrainautor per tile). It sits behind the same `NavMesh` interface, so nothing above it changes.

### 3.2 Path queries at scale (research 03)
- **Group orders with ≥ 5 units** get one **destination field** per (goal, radius class):
  - It is a bounded, resumable reverse Dijkstra over triangles, storing `dist` and `next portal` for each.
  - Units follow it by funnelling over the next ~8 triangles. That makes the cost O(1) per unit per order.
  - Fields are deduplicated by key, reference-counted and pooled.
- **≤ 4 units, AI units and ambient units** use per-unit A*. Ambient units also get an LRU corridor cache keyed by `(startTri, goalTri, class, meshVersion)`.
- **Radius classes:** 4 conservative classes (≤0.375, ≤0.625, ≤1.25, ≤2.0), used for fields and regions. The per-unit funnel still uses the exact radius.
- **Scheduler:** one prioritized queue of resumable searches, served in this order: player orders, repaths near a change, AI orders, field resumes, ambient. Older requests age up in priority, a new request for the same unit replaces its pending one, and the queue runs to a time budget measured every 256 expansions.
- **Waiting for a path:** units start moving right away along their old path or a straight line. Units in a field may start once their own triangle is settled.
- **Invalidation:** each field or corridor records the AABBs or tiles it touches.
  - Placing a building re-queues only the fields and corridors that intersect it, nearest units first.
  - Removing a building only queues low-priority improvements, because no path becomes invalid.
- **Safety net:** a staggered corridor check every ~2 s.

### 3.3 Locomotion: steering, pushing, collisions (research 02)
SC2-style: **steering for velocity, then a priority-weighted positional contact solver, then wall sliding.** ORCA is not used; it may come back later as an optional experiment behind the same interface.

Per-tick pipeline:
1. **Follow:** take the next target from the corridor or field, and get a preferred velocity with arrive-deceleration.
2. **Steer:**
   - light separation, applied to same-order and idle neighbors only;
   - time-to-collision **avoidance of units we can't push only**, with a 0.5 s side hysteresis;
   - weak alignment and cohesion within the group;
   - an acceleration limit, with damping for idle units.
3. **Integrate** to get predicted positions.
4. **Contacts:**
   - 3–4 Jacobi iterations with over-relaxation, deterministic and order-independent.
   - Each pair's weights come from the **push priority**:
     - a higher-priority unit pushes a lower one;
     - equal priority splits the correction by area;
     - hold-position and other-faction units are never pushed.
   - Units are projected out of walls *inside* each iteration, so a wall absorbs pushes.
   - Chain arrival is detected here.
5. **Velocities:**
   - Movers keep their steered velocity, minus any into-wall component.
   - Pushed idle units take their velocity from the displacement, then damp.
   - Displacement per tick is capped (no teleporting).
6. **Arrival:**
   - goal radius scaled to group area;
   - chain arrival (touching an arrived group-mate);
   - blocked-progress arrival.

   Arrived units become idle and pushable and **never re-seek**.
7. **Stuck ladder:** squeeze mode (allow overlap, extra priority), then local repath, then give up and go idle.
8. **Heading:** turn-rate-limited facing, with render-side smoothing.

Push matrix (research 05): allies push idle or arrived allies; moving allies share the correction softly; hold-position units are rocks; **different factions never push each other** (they only avoid); neutral critters get a "flee" steering nudge when an army approaches.

### 3.4 Group movement
- **Magic box.**
  - Click outside the group's capped bounding box: keep relative offsets.
  - Click inside: converge on spiral slots, assigned by angle so paths don't cross, with the largest units nearest the center.
  - All targets are snapped onto the walkable mesh for each unit's radius and region.
- Offsets are blended in only near the destination (smoothstep), so groups compress through chokepoints and spread out again on arrival.
- Optional **"formation move"** toggle: a virtual leader moves at the slowest unit's speed, with catch-up multipliers. Off by default, as in SC2.

### 3.5 Orders and AI (research 05)
- Per-unit ring-buffer **order queue** of capacity 8, holding Move, Patrol, FollowPath, Wander and Follow.
- A plain click replaces the queue and Shift appends. **Stop** and **Hold** are instant: they clear the queue.
- Movement states: Idle, Moving, Arrived, Holding, Blocked.
- **Ambient AI** uses small FSM "brains" that put orders into the same queue the player uses, so a player command overrides AI trivially.
  - Brains run at staggered `nextThinkAt` times on a seeded RNG.
  - Behaviors: wander (around home, reachability checked), patrol (ping-pong), convoy loops (shared, precomputed route polylines), herds (one wandering virtual leader plus boids-lite followers), idle fidget.
- **Factions:** Player (blue), Hostile A (red), Hostile B (orange), Ally AI (teal), Neutral (warm grey). Green is reserved for UI, as in SC2. A colour-blind palette toggle is included.

### 3.6 Unit archetypes
Values are SC2-derived and should be re-checked against Liquipedia before tuning is frozen.

| Archetype | Radius | Speed | Accel | Push priority | Turn rate | Role |
|---|---|---|---|---|---|---|
| skitter | 0.375 | 4.1 | 60 | 20 | 20 | swarms, chokepoint stress |
| trooper | 0.375 | 3.15 | 40 | 20 | 14 | default infantry |
| walker | 0.625 | 4.1 | 30 | 30 | 10 | mid-size, overtakes troopers |
| tank | 0.875 | 3.15 | 12 | 40 | 4 | slow turner |
| behemoth | 1.25 | 2.6 | 6 | 50 | 3 | clearance tests |
| colossal | 2.0 | 2.0 | 4 | 60 | 2 | refused by narrow corridors |
| critter (neutral) | 0.25 | 2.0 | 20 | 5 | 12 | herds and wanderers |

### 3.7 Engine and rendering (research 04)
- **Tooling:**
  - **Vite 8, TypeScript 7 (strict), Vitest 5, pnpm.** Versions get re-checked at scaffold time.
  - Separate tsconfigs for the app and the worker, so the sim cannot touch the DOM.
  - The import rule is enforced by lint.
- **Simulation storage:**
  - Structure-of-Arrays on typed arrays: positions and velocities `Float64` in the sim, `Float32` in snapshots.
  - Handles are index + generation. There is a free list and a dense active list.
  - Paths live in a pooled arena.
  - Target: **zero allocations per tick**.
- **Neighbors:** a uniform grid of 2-unit cells, rebuilt each tick by counting sort. Units larger than a cell are kept in a separate small list.
- **WebGL2 renderer:**
  - **Units are one instanced draw.** Each is an SDF circle carrying faction rim, heading tick, selection and hover state. The vertex shader interpolates from prev to curr, so per-unit data is uploaded once per tick, not once per frame.
  - Terrain and buildings are static vertex buffers.
  - A batched thick-line renderer draws overlays.
  - Click markers are animated in-shader.
  - The minimap updates at 10 Hz.
  - All of it sits behind a `Renderer` interface, so WebGPU can be added later.
- **The UI is a DOM overlay:** HUD, selection panel, control-group bar, editor tools and profiler text.
- **Profiler:**
  - an allocation-free ring buffer of per-system ms on both threads;
  - a frame-time sparkline;
  - a GPU timer query where available;
  - URL benchmark scenes (`?scene=stress10k&seed=42`).

### 3.8 Input (SC2 conventions)
| Input | Action |
|---|---|
| Left click / drag | select, box-select |
| Shift + click / drag | add to selection or remove from it |
| Double-click or Ctrl+click | select same type in view |
| Ctrl+1..9 / Shift+1..9 / 1..9 | assign / add to / recall a control group; double-tap a number to center on it |
| Right-click | move, with a click marker |
| Shift+right-click | queue a waypoint; green lines are drawn when selected |
| P + click | patrol |
| S | stop |
| H | hold |
| Camera | arrow keys (letters are command hotkeys, as in SC2), edge pan, middle-drag, zoom-to-cursor wheel, minimap click/drag; right-click on the minimap moves |
| Editor (`E` toggles) | place building (Q/E cycle footprint), draw polygon, erase, brush add/subtract, route tool, undo/redo |
| Debug | F1–F9 overlays (navmesh, widths/clearance for the selected radius, paths and corridors, velocities and avoidance, fields, congestion heatmap, state glyphs, spatial grid, profiler); Space pause; `.` step; `[` `]` time scale |

### 3.9 Map content
- 512² map in **9 zones**: player base with ramp, chokepoint field (4- and 8-wide gaps), open plains, maze, winding canyon (widths 3 → 1.5 → 5), rock garden, spiral/U-trap, two AI bases with wall-offs, and a neutral town.
- Obstacle pipeline:
  1. simplex fBm noise and zone masks;
  2. marching squares;
  3. RDP simplify;
  4. Clipper2 union and clean;
  5. drop slivers, orient rings, snap to the lattice;
  6. connectivity check that fills unreachable islands.
- Maps are stored as versioned JSON. Source polygons are kept so edits stay reversible, with a generator block (seed + params). Maps save and load via localStorage autosave, file import/export, and `?map=`.

### 3.10 Demo scenarios (one click each, seeded)
1. Chokepoint 200
2. Crossing armies (300 v 300)
3. Size-mix through the canyon
4. 10k stress: wanderers plus herds plus armies
5. Building drop on a marching column
6. Maze solve
7. Concave trap
8. Hold the line, with a 1-unit gap
9. Patrol & convoy city
10. Shift-queue showcase

---

## 4. Resolved conflicts between research notes

1. **Global dynamic CDT (01) vs tiled navmesh (03/05).**
   - Chosen: global dynamic CDT. It has exact geometry, widths and funnels stay seam-free, and placing a building is O(local).
   - Terrain edits use a full rebuild (rare, editor-only).
   - Tiles stay as Plan B behind the `NavMesh` interface. Invalidation uses AABBs instead of tile bitsets.
2. **Radius handling:** both notes are kept. Exact per-unit width checks and funnel radius apply to A*. Four conservative radius classes apply to shared fields and region labels.
3. **Position precision:** Float32 (04) vs Float64 (02). The sim uses Float64; snapshots and the GPU use Float32.
4. **Map size:** 256² (01) vs 512² (05). Chosen: **512²**, to demonstrate scale. Triangle count is expected to be 20–60k, which is fine.

---

## 5. Directory layout

```
src/
  main.ts
  app/        loop.ts, simHost.ts (worker | in-thread), snapshot.ts (SAB | transfer)
  shared/     protocol.ts, handles.ts, math.ts, rng.ts, constants.ts, archetypes.ts
  sim/        world.ts, step.ts, sim.worker.ts
    store/    units.ts (SoA, allocator), orders.ts (ring queues)
    spatial/  grid.ts
    nav/      cdt/ (DynamicCDT, predicates, bootstrap), widths.ts, locate.ts, regions.ts,
              astar.ts, funnel.ts, field.ts, pathQueue.ts, snap.ts
    move/     follow.ts, steer.ts, contacts.ts, walls.ts, arrival.ts, stuck.ts, groups.ts
    ai/       brains.ts (wander, patrol, convoy, herd, fidget)
    map/      format.ts, normalize.ts (Clipper2), generate.ts, zones.ts
    scenarios/
  render/     gl/, shaders/, passes/ (terrain, buildings, units, rings, lines, markers, minimap), camera.ts
  input/      inputState.ts, controller.ts, selection.ts, controlGroups.ts, editor.ts
  ui/         hud, panels, editor toolbar, debug toggles
  debug/      profiler.ts, overlay builders
tests/        unit + fuzz (CDT vs oracle), determinism hash, bench/*.bench.ts
```

---

## 6. Implementation milestones

Each milestone ends with something runnable and with tests. Every milestone is checked in the browser, by watching the scenarios, and not only by unit tests.

| # | Milestone | Done when |
|---|---|---|
| M0 | **Scaffold & engine shell** | Vite/TS/Vitest/lint; worker host with both transports; 30 Hz loop with interpolation; WebGL2 renderer; camera; 10k dummy units bouncing at 60 fps; profiler overlay |
| M1 | **Map & geometry** | JSON format; Clipper2 normalization; 9-zone generator; terrain rendering |
| M2 | **NavMesh core** | Bootstrap CDT; `DynamicCDT` insert/remove; widths; point location; regions; fuzz tests against the constrainautor oracle; navmesh overlay |
| M3 | **Single-unit pathing** | TA* with radius pruning; radius funnel with tangent arcs; snap-to-walkable; unreachable fallback; path queue and budget; path overlay. A colossal correctly refuses narrow corridors |
| M4 | **Locomotion** | Grid; follow, steer, contacts, walls, arrival, stuck; push matrix; heading. Chokepoint and hold-the-line scenarios look right |
| M5 | **Orders & input** | Selection, control groups, move, shift-queue, patrol, stop, hold; magic box and slots; click markers and waypoint lines; minimap |
| M6 | **Group fields** | Destination fields per class, dedup and pooling, last-mile slots. A 500-unit order costs ≤ 2 ticks to start moving |
| M7 | **Dynamic world** | Building place/remove at runtime with unit ejection and selective invalidation; editor tools with undo; terrain-edit rebuild |
| M8 | **Ambient AI & factions** | Wander, patrol, convoy, herd and fidget brains; staggered thinking; LRU cache; neutral flee |
| M9 | **Scenarios, polish, perf** | All 10 scenarios; tuning panel (lil-gui); colour-blind palette; 10k benchmark meets targets; determinism test in CI |

Execution plan:
- M0–M3 are sequential, since each depends on the one before.
- After M3 the work branches out: locomotion (M4) and orders/input (M5) touch mostly separate files. The CDT fuzzing and hardening work can run alongside them.
- I'll run parallel Opus subagents on separable pieces, and review and integrate their work myself.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The dynamic CDT has robustness bugs | lattice coordinates, exact predicates, a no-crossing contract, fuzzing against the oracle after every operation, and Plan B tiles behind the interface |
| Demyen's width search is slow or wrong in edge cases | widths are clamped to `2·rMax`, so recursion stays bounded; NaN in the funnel tangent is logged in debug; fallback is LCT-style refinement |
| Avoidance or contacts look jittery | the tuning table in research 02, sliders, side hysteresis, idle damping, allowed-overlap slack |
| A 10k-unit tick goes over budget | profile per system; TS kernels are pure functions over typed arrays so they can be ported to Rust/WASM; a path-worker pool if paths exceed 30% of the tick |
| Repath storms after a building drop | per-tick budget, nearest-first ordering, stale data kept until the new path arrives, shared group fields |

---

## 8. Open questions for you

1. **Hosting.** Will this be deployed anywhere, such as GitHub Pages? That decides whether SharedArrayBuffer is available without the service-worker shim. Either way, the transfer fallback works.
2. **Target hardware for the 10k / 60 fps budget.** I'm assuming an Apple Silicon Mac.
3. **Git.** The folder isn't a repo yet. Shall I run `git init` and commit at each milestone?
4. **Visual style.** I plan clean, flat SC2-ish vector visuals (SDF circles, beveled rock polygons, dark ground). Sprites aren't planned.

---

## 9. Implementation notes (decisions made while building)

**M1 — map**
- Zones sit on a 170-unit integer pitch; the last row and column take up the remainder. Every building coordinate therefore lands on the 0.5 lattice.
- Normalization applies morphological closing at the smallest unit radius (0.25), so no walkable gap is narrower than 0.5. Every walkable pocket not connected to the main region is filled in.
- Buildings keep a 1-unit margin from the map edge, so building corners are never hull vertices.

**M2 — navmesh**
- **No interior Steiner points.** Every vertex is an obstacle corner or a map-border point (every 16 units). This is the assumption behind Demyen's width computation.
- **Vertex removal** re-triangulates the deleted vertex's star by ear clipping, then legalizes. Flip-to-degree-3 is not robust when neighbors are collinear, which lattice rectangles produce constantly.
- **Bootstrap.** Delaunator triangulates all points, then *our own* `insertConstraint` adds every obstacle edge, so the runtime code path is exercised at startup. Constrainautor is not used. Correctness is checked by invariant fuzzing instead:
  - structure, orientation and twin symmetry;
  - constrained-Delaunay property;
  - blocked flags against point-in-polygon;
  - area sum.

  CDT edge sets aren't unique under the heavy cocircularity of lattice rectangles, so an edge-set oracle comparison wouldn't be meaningful.
- **Blocked flags** are per-triangle obstacle *coverage counts*. They are flood-filled per obstacle from the interior side of its first edge and inherited through splits and flips. Unconstrained edges always separate triangles with equal counts.
- **Regions** use a necessary condition: a crossed edge must be ≥ 2r long, because both of its endpoints are obstacle points. They are recomputed globally after an edit: about 1.5 ms in Node and 3–4 ms in the worker. *Follow-up (M7):* make regions incremental, or defer them until the first query after an edit.
- **Edit cost:** CDT plus width update is about 0.05 ms per building. The rest is region recomputation, plus a full occupancy-raster rebuild done on the sim thread.

**M3 — single-unit pathing**
- **Search.** A* nodes are entry halfedges. A transition from entry n to exit x requires corner width ≥ 2r + `PASSAGE_SLACK` (2 cm) and exit-edge length ≥ 2r + slack.
  - Exactly-fitting passages are refused: they make the funnel's inner tangents degenerate, and they would leave locomotion zero slack.
  - g uses the best crossing point on each edge (shrunk by r), and h is Euclidean.
  - The anytime refinement (+50% expansions) starts only after the first *clearance-valid* goal arrival.
- **Funnel.** A Simple Stupid Funnel over corner circles, using circle-to-circle tangents, with three post-passes:
  1. *Corner repair:* any vertex within two triangle-rings of the corridor that a straight run passes closer than r to is inserted as a corner on its actual side. This covers start/goal-triangle corners.
  2. *Clearance repair:* samples closer than r to the real mesh (near tangent touch points and arcs) are pushed out to r, plus the chord sagitta.
  3. *Validation:* the path is sampled against true mesh clearance. Goal arrivals that fail are skipped; if none pass, the best one is returned with `clear: false` (under 2% of random queries in fuzzing).
- **Tolerance.** `CLEARANCE_TOLERANCE` is 1 cm.
- **Unreachable goals** resolve to the path toward the reachable crossing point closest to the goal, considering only valid positions. Goals and starts are snapped to valid positions first: clicking on rock moves to the nearest spot the unit fits.
- **Cost.** About 1 ms per query on average and about 7 ms worst (cross-map colossal) in Node, roughly 2 ms per cross-map path in the worker. A 300-unit order is served over about 100 ticks under the 4 ms per-tick budget. M6 group fields address this.
- **Temporary follower.** M3 has a simple waypoint follower with no acceleration and no unit interaction. M4 replaces it.
