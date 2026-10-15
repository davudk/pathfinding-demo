# 05 — Gameplay/behavior layer, unit archetypes and map content

Scope: everything *above* the pathfinder and local avoidance. Orders, ambient AI, unit roster, map generation, editor, scenarios, debug views, and faction colours. The navmesh/path/avoidance agents own the layers below. This document specifies only the interface we need from them.

---

## 0. TL;DR (opinionated)

- **Orders**: each unit gets a small ring-buffer **order queue**. Each order is a tagged union (`Move | AttackMove* | Patrol | Hold | Stop | FollowPath | Wander | Follow`). Only the head order is "active". The head order drives a **movement state machine** (`Idle → Moving → Arrived → Idle`, plus `Holding` and `Blocked`). Shift-click appends; a normal click replaces. Use SC2 semantics wherever they exist.
- **Push rules**: a 3-bit "pushability" matrix keyed by (faction relation × target state). Allies push idle/arrived allies. Nobody pushes `Holding` units. Enemies and neutrals never push each other; they only avoid.
- **Ambient AI**: no behavior trees. Use **one tiny FSM per behavior** that emits orders into the same queue the player uses. Decisions are time-sliced: each AI unit gets a `nextThinkAt` with random jitter, and a per-frame budget caps re-plans (e.g. 64 path requests/frame).
- **Units**: use SC2 radii verbatim with **1 world unit = 1 SC2 cell**, and speeds in SC2 "Faster" units/s. Six archetypes span radii from 0.375 to 2.0.
- **Maps**: author obstacles as polygons. Procedural cliffs come from noise → marching squares → RDP simplify → **clipper2-js union/offset**. Buildings are axis-aligned or rotated rects snapped to a 0.5 grid. Validate everything through one `normalizeObstacles()` pass (union, then clean, then orient, then drop slivers). Store maps as versioned JSON.
- **Demo**: 8–10 one-click scenarios plus a layered debug overlay toggled by number keys. A stats HUD shows ms/frame per subsystem.

---

## 1. Order / command system

### 1.1 How SC2 does it (the parts worth copying)

- Each unit holds an **order queue**. A plain right-click or command *clears* the queue and issues a new order. Holding **Shift** appends to the queue; queued waypoints are shown as lines when the unit is selected. The SC2 queue holds up to 32 orders. ([Liquipedia: Shift-queue / Hotkeys](https://liquipedia.net/starcraft2/Hotkeys), [Liquipedia: Commands](https://liquipedia.net/starcraft2/Commands))
- **Stop (S)** clears the queue and leaves the unit idle and pushable. **Hold Position (H)** clears the queue and pins the unit: it will not be pushed by friendly units and will not chase. **Patrol (P)** moves between the current position and the target forever. Shift-queued patrol points extend the loop. ([Liquipedia: Hold Position](https://liquipedia.net/starcraft2/Hold_Position), [Patrol](https://liquipedia.net/starcraft2/Patrol))
- **Group move behaviour**: when a group is ordered to a point, SC2 keeps a rough formation if the group is clumped. If the units are spread out (the target lies inside the group's bounding area) they converge on the point. Units "arrive" when they are within a radius-dependent tolerance or when they are touching an already-arrived friend. That last rule is the main trick that stops 50 marines fighting over one pixel. ([GDC 2011, James Anhalt, *StarCraft II: Navigation*](https://www.gdcvault.com/play/1014514/AI-Navigation-It-s-Not), slides mirrored at [Mikko Mononen's blog](http://digestingduck.blogspot.com/))
- **Pushing**: moving units push *idle friendly* units out of the way. Units on hold position are never pushed. Enemy units are never pushed; they block you, and you path or steer around them. Workers mining ignore collision entirely. ([Liquipedia: Unit collision / Mechanics](https://liquipedia.net/starcraft2/Mechanics))

### 1.2 Data model (TypeScript)

```ts
type OrderKind = 'move' | 'patrol' | 'hold' | 'stop' | 'followPath' | 'wander' | 'follow';
interface OrderBase { kind: OrderKind; issuedAt: number; groupId?: number }
type Order =
  | OrderBase & { kind: 'move'; target: Vec2 }
  | OrderBase & { kind: 'patrol'; points: Vec2[]; idx: number; dir: 1 | -1 }   // ping-pong
  | OrderBase & { kind: 'followPath'; points: Vec2[]; idx: number; loop: boolean }
  | OrderBase & { kind: 'wander'; home: Vec2; radius: number; pauseMin: number; pauseMax: number }
  | OrderBase & { kind: 'follow'; targetUnit: number; offset?: Vec2 }
  | OrderBase & { kind: 'hold' } | OrderBase & { kind: 'stop' };
```

- Store per-unit queues in a **fixed-capacity ring** (capacity 8; 32 is overkill for a demo). Keep them in a side table indexed by unit id, and keep the hot SoA arrays (pos/vel/radius/state) separate. Units without orders cost nothing.
- `stop` and `hold` are *instant* orders. They clear the queue, set state, and never sit in the queue. Model them as commands, not queue entries.
- **Shift semantics**: `issue(units, order, {queue: shift})`. If `shift`, push to the tail; otherwise clear and push. A shifted `patrol` appended after `move`s inherits the last queued point as its start, as in SC2.
- **Order completion** is decided by the order, not the mover. `move` completes on `Arrived`. `patrol`/`followPath(loop)`/`wander` never complete; they advance an internal index. `follow` re-targets every N ms.

### 1.3 Movement states (the contract with the locomotion layer)

| State | Meaning | Entered when | Pushable by allies |
|---|---|---|---|
| `Idle` | no active order | queue empty / `stop` | yes |
| `Moving` | following a path corridor | path assigned | yes, but reduced (soft priority) |
| `Arrived` | reached goal this order | within `arriveTol` or touching an arrived groupmate with the same `groupId` | yes (becomes `Idle` after ~0.25 s) |
| `Holding` | pinned | `hold` command | **no** (acts as static obstacle for allies) |
| `Blocked` | no progress for T seconds or path request failed | progress watchdog | yes |

- **Arrival rule** (copy SC2): `dist(goal) < max(radius, 0.5)`, OR (`groupId` matches a neighbour in `Arrived` that I'm touching AND `dist(goal) < groupSpreadRadius`). Here `groupSpreadRadius ≈ sqrt(sum(πr²)/π) * 1.3`, computed once at order issue. This one rule produces the satisfying "blob settles" look.
- **Blocked watchdog**: track the best distance-to-goal. If it does not improve by 0.5 units in 2 s, set `Blocked`. Request a re-path once. If still blocked after 2 more s, complete the order (move) or skip to the next waypoint (patrol/path) so ambient units never jam forever.
- **Group move offsets**: if the group's bounding radius is under ~4× the distance to target, preserve relative offsets (clamped to a navigable point). Otherwise send everyone to the same point and let arrival-by-contact spread them. Share **one path request per group** (leader path plus per-unit corridor offset). This is the biggest CPU win for player orders.

### 1.4 Push / collision rule matrix

Each tick, the avoidance layer asks `canPush(mover, other): 0 | 1 | 2`, where 0 = treat as hard obstacle, 1 = soft (mutual separation), and 2 = push freely.

| mover \ other | ally Idle/Arrived | ally Moving | ally Holding | enemy (any) | neutral |
|---|---|---|---|---|---|
| player/ally | 2 | 1 | 0 | 0 | 0 (but neutrals yield, see below) |
| enemy | 0 | 0 | 0 | 2/1 inside own faction | 0 |
| neutral critter | 0 | 0 | 0 | 0 | 1 |

- Within a faction: push idle and arrived units, soft-separate moving ones, and treat holding units as rocks.
- **Across factions: never push.** That is the SC2 rule and it makes clashes readable. The avoidance layer still *steers* around them.
- **Neutrals yield**: when a non-neutral mover is within 2 radii, a neutral critter gets a short `flee` impulse (a steering force, not a push). This lets herds visibly scatter out of the army's way without breaking the no-cross-push rule.
- Use a **mass/priority tiebreak** inside soft separation: a heavier or higher-priority unit gets the smaller share of the displacement. Huge units barely budge for zerglings.
- Implement it as a 2D lookup table `PUSH[relation][otherState]` with `relation = same | ally | enemy | neutral`. It's branch-free and trivial to expose in the debug panel.

---

## 2. Ambient AI behaviours

### 2.1 Architecture choice: order-emitting FSMs, not behaviour trees

Ambient behaviours here are 2–3 states each. A behaviour tree adds per-tick traversal cost and indirection for no gain, and thousands of BT ticks per frame waste budget. Instead, each ambient unit has a `brain` id plus a few bytes of state, and **brains only run when `now >= nextThinkAt`**. A brain's only output is orders pushed into the same queue the player uses. Benefit: player commands override AI trivially. Issue an order and set `brain.suspendedUntil`. After the queue empties and a timeout passes, the brain resumes. (Background: [Game AI Pro, "Behavior Selection Algorithms"](http://www.gameaipro.com/GameAIPro/GameAIPro_Chapter04_Behavior_Selection_Algorithms.pdf). An FSM is the right tool when the state count is tiny.)

### 2.2 Behaviours

- **Wander**: `Pause(rand 1–4 s) → PickPoint → Move → Pause`. To pick a point, sample up to 4 random points in a disc of radius R around `home` (not the current position, or units drift away over time), and accept the first one that is on the navmesh and reachable within the same navmesh island. Ask the navmesh agent for `randomPointInCircle(home, R)` or `isOnMesh(p)`. If all 4 samples fail, pause and retry later. Bias toward a slowly rotating heading (Reynolds-style wander angle jitter) so motion looks purposeful rather than Brownian. ([Reynolds, *Steering Behaviors*](https://www.red3d.com/cwr/steer/gdc99/))
- **Patrol**: ping-pong between 2+ points (SC2 patrol), with a 0–0.5 s dwell at each end.
- **Waypoint loop** (`followPath loop:true`): fixed route defined in map JSON and shared by a **convoy** of N units with staggered start indices or spawn times. Precompute the path between consecutive waypoints once per route and cache it, since it is static. Invalidate the cache when the map editor changes the obstacles in that region.
- **Herds (neutral critters)**: one virtual *herd leader* wanders (cheap: one path every few seconds). Members run boids-lite (cohesion to leader offset, alignment, separation is done by avoidance) and only path individually if they lose line-of-sight to the leader for over 1 s. This allows 5000 critters at roughly 100 path queries per second. ([Reynolds, *Flocks, Herds, and Schools*](https://www.red3d.com/cwr/boids/))
- **Guard / idle fidget** (cheap filler): random facing changes every few seconds. Shuffling a few cells costs nothing and makes static bases feel alive.

### 2.3 Load spreading

- `nextThinkAt = now + base + rand()*jitter`. Seed with a random phase at spawn so 5000 wanderers never sync.
- **Global path-request budget**: brains enqueue requests into a priority queue. Priority goes player orders > blocked units > convoys > wanderers. The pathfinder services K per frame (time-boxed, e.g. 2 ms). Wanderers that wait just stand idle a bit longer, which is invisible to the viewer.
- **LOD**: units off-screen at low zoom can think at 1/4 rate. Keep simulation deterministic by making the decision schedule independent of the camera; drop only the *render-side* LOD if determinism matters for replays.
- Use a **seeded PRNG** (mulberry32 / sfc32) per scenario so stress tests are reproducible and benchmarks comparable.

---

## 3. Unit archetypes (SC2 reference)

**World scale: 1 world unit = 1 SC2 cell** (a 1×1 pathing-grid square; a Supply Depot is 2×2, a Command Center 5×5). Speeds use SC2 "Faster" game speed in cells/second, the figures Liquipedia lists. Rendering: 1 unit = 16 px at default zoom (a marine is about 12 px wide). SC2 reference values below are from Liquipedia unit pages and the SC2 editor's `Radius` field. Liquipedia blocked automated fetches during this research, so **re-verify** against [Liquipedia LotV unit statistics](https://liquipedia.net/starcraft2/Unit_Statistics_(Legacy_of_the_Void)) before freezing balance numbers; they are well known and stable.

| SC2 unit | radius | speed (Faster) |
|---|---|---|
| Zergling | 0.375 | 4.13 (6.58 w/ Metabolic Boost) |
| Marine / SCV / Probe / Drone | 0.375 | 3.15 / 3.94 / 3.94 / 3.94 |
| Baneling | 0.375 | 3.5 |
| Zealot | 0.5 | 3.15 (4.72 w/ Charge) |
| Stalker / Roach / Hydralisk | 0.625 | 4.13 / 3.15 / 3.15 |
| Immortal | 0.75 | 3.15 |
| Siege Tank | 0.875 | 3.15 |
| Ultralisk / Archon / Colossus | 1.0 | 4.13 / 3.94 / 3.15 |
| Thor | 1.25 | 2.62 |

Recommended demo archetypes (names our own, values SC2-derived):

| Archetype | radius | speed | accel (u/s²) | mass | role in demo |
|---|---|---|---|---|---|
| `skitter` | 0.375 | 4.1 (burst 6.5 toggle) | 60 (instant-ish) | 1 | swarms, chokepoint stress |
| `trooper` | 0.375 | 3.15 | 40 | 1 | default player infantry |
| `walker` | 0.625 | 4.1 | 30 | 2 | mid-size, overtakes troopers |
| `tank` | 0.875 | 3.15 | 12 | 4 | slow turners in mixed groups |
| `behemoth` | 1.25 | 2.6 | 6 | 10 | Thor-like, tests clearance on narrow paths |
| `colossal` | 2.0 | 2.0 | 4 | 25 | stresses clearance-aware paths; must be refused by 3-wide corridors |
| `critter` (neutral) | 0.25 | 2.0 | 20 | 0.5 | herds/wanderers, cheapest |

Notes:
- Six radius classes matter for the pathfinding agents. A navmesh with **clearance-aware queries** (or per-radius eroded meshes for 0.375, 0.875, 1.25, 2.0) is needed so a colossal unit never takes a corridor narrower than 4 units. The map generator must deliberately include corridors of width 1.0, 2.0, 3.0 and 5.0 to show this.
- Add a **turn rate** (rad/s) per archetype: skitter 20, tank/behemoth 4, colossal 2. Slow turners look heavy and expose steering quality.
- Different speeds inside one group: SC2 does *not* sync speeds by default. Offer a toggle, "group moves at slowest speed", as a demo option.

---

## 4. Map content and generation

### 4.1 Map scale and layout

- **Map size 512 × 512 units** (SC2 1v1 maps are about 150–200 playable cells per side; ours is larger to show scaling). Divide it into ~9 zones on a 3×3 macro grid, each with a distinct stress role:
  1. Player main base (open, building cluster, single **ramp** of width 3 out).
  2. **Chokepoint field**: two massive rock walls with a 4-wide and an 8-wide gap.
  3. **Open plains**: few obstacles, herds of critters, two-army crossing area.
  4. **Maze**: grid-maze carved procedurally (recursive backtracker on a coarse 12-unit grid, corridor widths varying between 2 and 6).
  5. **Canyon**: long narrow winding corridor (width 3 → 1.5 → 5), a convoy loop route through it.
  6. **Rock garden**: hundreds of small noise-generated boulders (polygon-count stress for the navmesh).
  7. **Spiral / U-trap**: concave pockets that defeat naive steering (a classic local-minimum demo).
  8. AI faction bases ×2 (building clusters with gaps of 1–2 units between buildings: "wall-off" tests).
  9. Neutral town: dense small buildings, alleyways.

### 4.2 Procedural obstacle pipeline

1. **Noise field**: [simplex-noise](https://github.com/jwagner/simplex-noise.js) fBm (3–4 octaves), plus a radial/zone mask that forces open space where zones demand it. Threshold → binary occupancy on a 0.5-unit raster.
2. **Contours**: marching squares (e.g. [d3-contour](https://github.com/d3/d3-contour), which returns GeoJSON MultiPolygons with holes) → raw rings.
3. **Simplify**: Ramer–Douglas–Peucker with ε ≈ 0.35 ([simplify-js](https://github.com/mourner/simplify-js)). Optional Chaikin smoothing pass *before* simplify for organic cliffs.
4. **Hand-authored overlays**: walls, ramps, maze cells, spiral and buildings, expressed as polygons in the same coordinate space.
5. **Normalize** (single source of truth, run after generation *and* after every editor change):
   - `union` all obstacle polygons with **[clipper2-js](https://github.com/countertype/clipper2-ts)** (TypeScript port of Angus Johnson's Clipper2: robust, integer coordinates, handles holes, also does offsetting). [polygon-clipping](https://github.com/mfogel/polygon-clipping) is a simpler pure-JS alternative but slower and float-based. Pick Clipper2: scale coords by 1000 → int64 → union with `FillRule.NonZero`.
   - `SimplifyPaths` / remove collinear points, drop rings with area under 0.25 u² (slivers), drop holes smaller than the smallest unit's footprint (unreachable pockets).
   - Orient outer rings CCW and holes CW. Verify simplicity: Clipper output is guaranteed non-self-intersecting, but assert in dev with a cheap segment-sweep check.
   - Optionally **erode/dilate by ±0.1** (Clipper `InflatePaths`) to close hairline gaps the noise left. Those gaps would otherwise create 0.01-wide corridors that confuse clearance logic.
   - Clip everything against the map bounds rectangle.
6. **Connectivity check**: after building the navmesh, flood-fill from the player base. Any walkable island under X area becomes an obstacle (fill it). Scenario spawn points must lie in the main island. Report the number of islands in the debug HUD.

Keep **buildings separate from terrain** in the data model (they are removable at runtime) but feed both into the same normalized obstacle set for navmesh builds. Buildings: rectangles (optionally rotated, optionally L-shaped polygons), with footprints snapped to a 0.5 grid. Clusters come from a "base template" (Town Hall 5×5 center, 6–12 satellites of 2×2 / 3×3 within radius 12, minimum gap 0 or 1 chosen per template to create intentional wall-offs or walkways).

### 4.3 JSON format

```jsonc
{
  "format": "rts-map", "version": 1,
  "size": [512, 512], "seed": 1337, "units": "sc2-cells",
  "terrain":   [ { "id": "t1", "kind": "cliff", "rings": [[[x,y],...], [[hole...]]] } ],
  "buildings": [ { "id": "b17", "faction": "red", "type": "barracks",
                   "shape": "rect", "center": [120.5, 88], "size": [3, 3], "rot": 0 } ],
  "spawns":    [ { "faction": "player", "archetype": "trooper", "count": 60,
                   "area": { "circle": [60, 60, 8] }, "behavior": null } ],
  "routes":    [ { "id": "r1", "loop": true, "points": [[...],[...]] } ],
  "behaviors": [ { "spawnRef": 3, "kind": "followPath", "route": "r1", "stagger": 1.5 } ],
  "zones":     [ { "name": "Chokepoint", "rect": [x,y,w,h] } ]
}
```

- Store *source* polygons (pre-union) so edits are reversible. Normalized geometry is derived on load and cached.
- Add a `"generator": { "algo": "noise-v1", "params": {...} }` block so a procedural map can be regenerated from its seed instead of stored point by point. Hand edits then become a diff layer on top.
- Save/load via `localStorage` (autosave), file download/upload, and a `?map=` URL param for the built-in presets.

### 4.4 In-app editor (cheap, high payoff)

- Tools: **Place building** (cycle footprint with Q/E, rotate with R), **Draw polygon** (click vertices, double-click to close), **Erase** (click to remove a building or terrain polygon), **Brush add/subtract** (circle stamped through Clipper union/difference: great for carving tunnels live), **Route tool** (place waypoints).
- Each edit produces a **dirty AABB**. The navmesh agent rebuilds only affected tiles (tiled navmesh recommended). Units whose current path corridor intersects the dirty AABB get re-path requests through the same budgeted queue.
- An undo/redo stack of edit commands (each one stores the added/removed source polygons).

---

## 5. Demo scenarios and debug visualizations

### 5.1 Scenarios (scenario picker, each deterministic by seed)

1. **Chokepoint 200**: 200 mixed troopers/skitters through the 4-wide gap. Measures time-to-clear and peak congestion.
2. **Crossing armies**: two factions of 300 each, ordered to swap sides through each other on the plains. No cross-faction pushing, so this shows pure avoidance quality.
3. **Size-mix squeeze**: group containing every archetype ordered through the canyon. Colossals must route around (clearance), and smalls must not get stuck behind slow behemoths forever.
4. **5000 wanderers**: neutral critter herds plus wanderers across the whole map. Benchmark mode with an FPS/ms graph.
5. **Building drop**: a column of 100 units marches down a road; press B to drop a 6×6 building onto the column. Units inside get ejected to the nearest free point. Others re-path in real time.
6. **Maze solve**: 50 units ordered from maze entrance to exit, with paths drawn.
7. **Concave trap**: units ordered into the U/spiral pocket from behind, demonstrating global path vs local steering.
8. **Hold the line**: 20 units on hold position form a wall with a 1-unit gap. 200 allies move through; they must not push holders and must funnel through the gap.
9. **Patrol & convoy city**: dozens of patrols and looping convoys in the neutral town, with the player army cutting across. Shows the push matrix and neutral yielding.
10. **Shift-queue showcase**: pre-scripted waypoints drawn on screen, plus a patrol loop extended with shift.

### 5.2 Debug overlays (number-key toggles, layered on a canvas/WebGL pass)

- `1` Navmesh triangles/polygons (thin lines, islands tinted). `2` Clearance-eroded mesh for the selected unit's radius.
- `3` Path polylines + corridor portals for selected units (SC2-style green waypoint lines for shift-queues are mandatory for the "feels like SC2" factor).
- `4` Velocity (preferred velocity in white, actual in faction colour) and avoidance/ORCA half-planes for the hovered unit.
- `5` Flow-field arrows (if the pathfinding agents use flow fields for big groups).
- `6` **Congestion heatmap**: accumulate occupancy per 2×2 cell with exponential decay. Shows chokepoint pressure beautifully.
- `7` Unit state glyphs: a dot colour per state (idle grey, moving white, arrived green, holding yellow ring, blocked red flashing).
- `8` Spatial-hash grid cells and neighbour links. `9` Brain think-schedule (units flash on think).
- HUD: units by faction, path requests per frame (queued/served), ms per subsystem (orders, AI, path, avoidance, integrate, render), blocked count, islands count. Use a small sparkline. [stats.js](https://github.com/mrdoob/stats.js) is fine as a base.
- **Slow-mo / single-step** (`,` / `.`) and a time-scale slider. Indispensable for showing avoidance details.

---

## 6. Faction colours and visual language

- Factions: **Player = blue** (#3B82F6), **Hostile A = red** (#EF4444), **Hostile B = orange** (#F59E0B), **Ally (AI) = teal** (#14B8A6), **Neutral = warm grey/beige** (#A8A29E). Critters are smaller, desaturated, and have no outline. SC2 itself uses blue/red as the default player pair, and players instantly read this. Avoid green as a faction colour so green stays reserved for UI (selection, move waypoints) as in SC2.
- Units: filled circle in the faction colour, a 1-px darker outline, and a short **heading tick** from centre to edge. Selected units get a **green ellipse** (circle) at radius+0.15. Hover gets a thin white ring.
- Order feedback: **green** for move markers and waypoint lines, **yellow** for patrol, **red** reserved for attack (not in scope, but keeps the vocabulary SC2-correct). Click markers animate as a shrinking ring (300 ms).
- Terrain: cliffs/rock in dark slate with a lighter top-edge stroke (fake bevel). Buildings are rounded rects tinted with the owner's faction colour at 35% over a neutral base, so they are distinct from units. Walkable ground is a very dark background with a subtle 8-unit grid.
- Colour-blind safety: blue/orange is the safest pair. Add a palette toggle that swaps red to magenta and teal to yellow, and keep shape cues (building = square, unit = circle, critter = small dot) so faction is never conveyed by colour alone.

---

## 7. Interfaces this layer needs from the other layers

- Navmesh: `isWalkable(p, radius)`, `nearestWalkable(p, radius)`, `randomPointInCircle(c, r, radius)`, `sameIsland(a, b)`, `rebuild(dirtyAABB)`.
- Pathfinder: async-ish `requestPath(from, to, radius, priority) → ticket`, with group request support (one path, many units). Results delivered in a later frame.
- Avoidance: per-unit `prefVelocity`, `state`, `faction`, `mass`, plus the `PUSH` table callback; returns actual velocity.
- Everything runs on a fixed 30 Hz or 60 Hz sim tick, decoupled from render (interpolate positions), with the SoA typed arrays shared so the sim can move to a Web Worker later.

---

## References

- James Anhalt (Blizzard), *StarCraft II pathfinding and unit movement*, GDC 2011 AI Summit "AI Navigation: It's Not a Solved Problem – Yet": https://www.gdcvault.com/play/1014514/AI-Navigation-It-s-Not
- Liquipedia SC2: Hotkeys / shift-queue: https://liquipedia.net/starcraft2/Hotkeys ; Patrol: https://liquipedia.net/starcraft2/Patrol ; Hold Position: https://liquipedia.net/starcraft2/Hold_Position ; Mechanics: https://liquipedia.net/starcraft2/Mechanics
- Liquipedia unit statistics (radius/speed): https://liquipedia.net/starcraft2/Unit_Statistics_(Legacy_of_the_Void) and https://liquipedia.net/starcraft2/Unit_Statistics_(Wings_of_Liberty)
- Blizzard 5.0.14 patch notes (example of radius as a balance field, Infestor 0.75 → 0.625): https://news.blizzard.com/en-us/article/24162754/starcraft-ii-5-0-14-patch-notes
- Craig Reynolds, *Steering Behaviors For Autonomous Characters*: https://www.red3d.com/cwr/steer/gdc99/ ; *Boids*: https://www.red3d.com/cwr/boids/
- Game AI Pro ch. 4, *Behavior Selection Algorithms*: http://www.gameaipro.com/GameAIPro/GameAIPro_Chapter04_Behavior_Selection_Algorithms.pdf
- Clipper2 (Angus Johnson): https://github.com/AngusJohnson/Clipper2 ; TS ports: npm `clipper2-js` (https://github.com/IRobot1/clipper2-ts, v1.2.x) and npm `clipper2-ts` (https://github.com/countertype/clipper2-ts) ; polygon-clipping: https://github.com/mfogel/polygon-clipping
- simplex-noise.js: https://github.com/jwagner/simplex-noise.js ; d3-contour (marching squares): https://github.com/d3/d3-contour ; simplify-js (RDP): https://github.com/mourner/simplify-js
- Mikko Mononen, Recast/Detour (tiled navmesh rebuilds, `findRandomPointAroundCircle`): https://github.com/recastnavigation/recastnavigation ; blog: http://digestingduck.blogspot.com/
- Red Blob Games, map generation and pathfinding articles: https://www.redblobgames.com/
- stats.js: https://github.com/mrdoob/stats.js
