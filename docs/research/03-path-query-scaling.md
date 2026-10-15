# 03 — Scaling Global Path Queries to Thousands of Units

Scope: how global path queries are issued, shared, scheduled, threaded, invalidated and cached. The navmesh itself (CDT, radius-aware A*, funnel) is covered in a separate document. This document assumes:

- the world is 512² to 1024² world units, with roughly 5k to 50k triangles;
- units are circles with a handful of distinct radii;
- buildings can be placed at runtime, which forces a local re-triangulation;
- there are thousands of units at once, and many of them receive the same order.

## TL;DR (the recommendation)

1. **Make the move order the unit of work, not the unit.** One player order produces one **destination field**: a reverse Dijkstra over navmesh triangles, starting at the goal, with one field per radius class. Every triangle stores a `next` portal toward the goal. Units steer by running a short funnel over the next few triangles of the field. That makes the cost per order O(triangles touched) and the cost per unit O(1).
2. **Make the field lazy and bounded.** Stop Dijkstra once every unit in the group has its triangle settled, plus a margin. Keep the open list so the field can resume later. A unit that wanders into an unsettled triangle triggers resumption, not a new search.
3. **Use per-unit A\*** only for single units and small groups (≤ 4 units) and for ambient AI. Feed it through a prioritized, time-budgeted, resumable request queue.
4. **Assign arrival slots** in an area-packed blob around the goal, using the SC2 rule. If the click lands outside the group's bounding box, units keep their relative offsets. If it lands inside, they converge.
5. **Skip HPA\* for now.** At ≤ 50k triangles it isn't needed. Two things are needed: **connected-component IDs per radius class**, so unreachable queries are rejected in O(1), and a **tiled navmesh**, which makes rebuilds local and gives a free hierarchy later.
6. **Threads:** run the simulation and pathfinding in one **sim worker** at a fixed tick (20–30 Hz). The main thread renders by interpolating snapshots that arrive through a `SharedArrayBuffer` (COOP/COEP headers are set in Vite). If profiling demands it, add a path-worker pool that holds read-only, versioned navmesh copies. The fallback is `postMessage` with transferable buffers.
7. **Invalidation:** use a navmesh version number plus a dirty-tile bitset. Fields and corridors record which tiles they touch. When a building is placed, only intersecting fields and corridors are re-queued at high priority. Units keep moving on the stale data until the replacement arrives, unless their next portal is actually blocked.
8. **Ambient AI:** use an LRU path cache keyed by `(startTri, goalTri, radiusClass, meshVersion)`. Patrol and waypoint routes are precomputed polylines. Popular destinations such as drop-off points, rally points and town halls get **persistent fields**.

---

## 1. Group pathing

### Why per-unit A\* doesn't scale by itself

Take a 200-unit order across a 30k-triangle mesh. Each unit search might expand 2k–10k nodes, which costs roughly 0.3–2 ms in well-written TypeScript with typed arrays and a binary heap (an estimate; profile it). The order costs 60–400 ms in total, which is several seconds of budget at 2–4 ms/tick, and 200 nearly identical corridors are computed along the way. Box-select-and-right-click is the most common RTS input, so this is the case to optimize.

### Options, ranked

| Approach | Cost per order | Quality | Notes |
|---|---|---|---|
| Per-unit A\* | N × A\* | Best per unit | Fine for N ≤ 4 |
| Leader path + followers | 1 A\* + local | Breaks when followers are on a different side of an obstacle | SC2-ish for clumped groups only |
| Few clustered A\* | k × A\* (k = clusters) | Good | Cluster by start component and proximity |
| **Reverse Dijkstra field over triangles** | 1 bounded Dijkstra | Good. Every unit gets its own optimal route through triangle centroids/portals | **Recommended default for N > 4** |

The field subsumes the other options. A spread-out group around a lake gets two different routes for free. The leader/follower approach handles that case badly.

### SC2 behaviour worth copying

Blizzard's GDC 2011 talk (James Anhalt, in the "AI Navigation: It's Not a Solved Problem — Yet" panel) and community analysis of SC2 describe the following:

- **The "magic box" rule.** If the target point lies outside the selection's bounding box (or the group is clumped), units move to `goal + (unitPos - groupCenter)`, which preserves the formation. If the target lies inside the box, or the group is very spread out, everyone converges on the point.
- **Arrival.** Units that reach the goal area stop when they bump into already-arrived units that share the same order. This avoids endless jostling at a single point.
- **Steering.** Paths are shared corridors. Separation and avoidance come from local steering, not from the global planner.

### Per-unit offset targets (recommended algorithm)

```ts
function assignTargets(units: Unit[], goal: Vec2, cls: RadiusClass): Vec2[] {
  const c = centroid(units);
  const box = bbox(units);
  const spread = maxDist(units, c);
  const packedR = Math.sqrt(sum(units, u => u.r * u.r) / 0.75); // ~hex packing density
  const keepFormation = !box.contains(goal) && spread < 2.5 * packedR;
  let targets: Vec2[];
  if (keepFormation) {
    // Preserve relative layout, compressed so stragglers don't get far-away slots.
    const k = Math.min(1, (1.3 * packedR) / Math.max(spread, 1e-3));
    targets = units.map(u => add(goal, scale(sub(u.pos, c), k)));
  } else {
    // Converge: hex/spiral slots around goal, assigned by angle so paths don't cross.
    const slots = spiralSlots(goal, units.map(u => u.r));       // largest units nearest centre
    targets = assignByAngleThenDistance(units, slots, goal);    // O(n log n), good enough vs Hungarian
  }
  // Snap every target onto walkable mesh for that unit's radius, in the goal's component.
  return targets.map((t, i) => nav.clampToWalkable(t, units[i].r, compOf(goal, cls)));
}
```

The slot targets only matter for the **last mile**. The shared field is built to the single goal point, possibly to the goal triangle plus its neighbours. When a unit's own straight line to its slot target is clear (a raycast on the navmesh at the unit's radius, with a cheap triangle walk), it leaves the field and steers straight to the slot. If a slot lies behind a thin wall, raycasting fails and the unit keeps following the field to the goal triangle, then runs a tiny local A\* (bounded to ~200 expansions) to reach its slot.

## 2. Flow fields vs navmesh A\*, and the hybrid

### Literature

- **Continuum Crowds** (Treuille, Cooper, Popović 2006) solves a per-group eikonal equation on a grid every frame. Density and velocity feed the cost, so avoidance is implicit. It looks beautiful but is expensive. The cost is O(grid cells × groups) per update, which is a poor fit for thousands of units with many independent orders and variable radii. Don't use it.
- **Supreme Commander 2** (Elijah Emerson, *Game AI Pro* ch. "Crowd Pathfinding and Steering Using Flow Field Tiles") divides a grid into 10×10 sectors with portals:
  1. A\* runs on the portal graph.
  2. Integration fields (Dijkstra/eikonal) and flow fields are built **only for sectors on the corridor**.
  3. Fields are cached and shared by every unit with the same goal.
  4. Dynamic obstacles only dirty their own sectors.

  The architectural ideas are what to steal: lazy, corridor-restricted and tiled fields. The grid representation is not.
- Grid flow fields win when **many units share one goal** and the map is a grid anyway, as in tower defense or SupCom2. They lose on memory and precision at large world scales (a 1024² map at 0.5-unit cells is 4M cells), and on variable radii, because each clearance needs its own cost field.

### Flow field over a navmesh: yes, this is the recommendation

A navmesh is a graph of about 30k nodes, not 4M cells, so a full reverse Dijkstra from the goal costs about the same as a single long A\*. Define, per radius class `c`:

- `dist[t]`: geodesic distance estimate from triangle `t` to the goal. Use edge-midpoint or "closest portal point" metrics, as in TRA\* by Demyen and Buro. Pure centroid distances zigzag.
- `next[t]`: the portal edge index to cross. A portal is only traversable if its clearance is ≥ `r_c`, and that clearance comes from the navmesh document's radius-aware edge widths.

```ts
interface DestField {
  goal: Vec2; goalTri: number; cls: number; meshVersion: number;
  dist: Float32Array;   // per triangle, +Inf = unsettled
  next: Int32Array;     // portal edge id, -1 = goal tri / unsettled
  entry: Float32Array;  // x,y per triangle: point on next portal used for g (for better metric)
  heap: MinHeap;        // kept alive => resumable
  tilesTouched: Uint32Array; // bitset for invalidation
  pending: Set<number>; // triangles of units we still need settled
  refCount: number;     // units still using it
}

function expand(f: DestField, budgetNodes: number) {
  while (budgetNodes-- > 0 && !f.heap.empty()) {
    const t = f.heap.pop();
    if (f.closed(t)) continue;
    f.close(t); f.pending.delete(t); markTile(f, tileOf(t));
    if (f.pending.size === 0 && f.dist[t] > f.stopDist) return DONE;
    for (const e of portals(t)) {
      if (clearance(e) < radiusOf(f.cls)) continue;
      const n = across(t, e);
      const p = closestPointOnSegment(e, entryPoint(f, t)); // Demyen-style
      const g = f.dist[t] + dist(entryPoint(f, t), p);
      if (g < f.dist[n]) { f.dist[n] = g; f.next[n] = e; setEntry(f, n, p); f.heap.push(n, g); }
    }
  }
}
```

- **Bounding:** set `stopDist = maxPendingDist * 1.2 + margin`. This settles a "lens" of triangles around the group-to-goal corridor, not the whole map. It's a reverse multi-target Dijkstra. You could add an A\*-style heuristic toward the group's bounding box, but plain Dijkstra keeps the field correct for knocked-off units, so prefer it.
- **Resume:** if a unit stands in a triangle with `dist = +Inf`, add it to `pending` and call `expand` again. The heap is still alive, so this is incremental.
- **Path following:** each unit, every ~200 ms or whenever its triangle changes:
  1. Walk `next` for K = 6–10 triangles to build a short corridor.
  2. Run the radius-aware funnel on that corridor.
  3. Steer toward the first corner.

  This gives string-pulled motion without per-unit search. It's the same idea as Detour's `dtPathCorridor`, but sourced from a shared field.
- **Memory:** 30k triangles × (4 + 4 + 8) bytes ≈ 480 KB per field. Pool the fields, reference-count them, and free a field once its last unit arrives or is reassigned. Expect tens of live fields, not thousands.
- **Dedup:** key fields by `(goalTri, quantized goal point, cls, meshVersion)`. Two orders to the same spot share one field. Rally points and drop-offs become persistent fields (see §7).
- **Radius classes:** quantize radii into 3–4 classes. Use the class's upper bound for clearance so it's conservative. A mixed group of 200 then needs ≤ 4 fields that share one goal. You could share one Dijkstra across classes by tracking the bottleneck clearance per label, but that's multi-criteria and not worth the complexity.

**When to use what:**

| Situation | Method |
|---|---|
| Player order, N ≥ 5 (or any N whose members are spread out) | Destination field per class |
| Player order, N ≤ 4 | Per-unit A\* (high priority) |
| AI attack waves | Destination field (same as the player) |
| Ambient or individual AI | Cached A\* (low priority) |
| Last mile to slot | Raycast, else tiny local A\* |

## 3. Hierarchical pathfinding: needed?

**Not initially.** HPA\* (Botea, Müller and Schaeffer 2004) pays off on grids with millions of cells. Our navmesh is already an abstraction: 5k–50k nodes, and a full Dijkstra over it is a few ms (estimated). With fields, the number of searches per order is roughly 1–4, so the remaining A\* load comes from ambient units and small orders.

Two "almost-hierarchy" features *are* required:

1. **Connected components per radius class.** Compute them with a flood fill after every mesh change, and keep them incremental per tile where possible. Recompute globally anyway, since it's cheap: about 1 ms for 30k triangles. An unreachable target would otherwise cause a full-map failed search, which is the classic RTS worst case when someone clicks on a cliff or walls in a unit. Resolve the order to the nearest point in the unit's own component before searching.
2. **Tiled navmesh.** Use 32×32 or 64×64 world-unit tiles, each triangulated independently with shared, stitched border edges. Rebuilding after a building placement only touches the 1–4 affected tiles. The tile adjacency graph, with portal clearance per class, *is* the HPA\* abstract level if we ever need it: run an abstract A\* over tiles to find a tile corridor, then a field or A\* restricted to those tiles (the SupCom2 trick). Treat it as an optional optimization, triggered only if profiling at 50k+ triangles shows A\* > 3 ms p95.

## 4. Time budgeting

- **One request queue**, owned by the sim worker. Each request is a resumable search object: an A\* or field expansion with its own heap, plus `step(maxNodes)`.
- **Priorities**, served highest first:
  1. Player orders, both fields and small-group A\*.
  2. Repaths caused by invalidation where the unit is near the obstruction (sort by distance).
  3. AI military orders.
  4. Field resumptions for stragglers.
  5. Ambient AI.

  Use aging so that low-priority requests can't starve.
- **Budget:** about 3 ms of path work per sim tick at 30 Hz, which is ~9% of a 33 ms tick in a worker, leaving headroom for steering and collision. Measure with `performance.now()` every 256 node expansions, not every node. Player-priority work may exceed the budget up to about 8 ms, so that a click produces visible motion within 1–2 ticks. Responsiveness beats smoothness for player input.
- **Anytime behaviour while waiting:** a unit with a pending request immediately starts moving toward the target in a straight line, or along the old path if one exists. It doesn't stand still. For fields, units can start moving once *their own* triangle is settled, before the whole field is done.
- **Dedup and coalescing:** a new order for a unit cancels its pending request (decrement the field's refcount). Spam-clicking 10 times per second must not queue 10 searches; keep only the latest per unit or group.
- **Stagger:** periodic field-corridor refreshes (the K-step funnel) are spread round-robin across ticks (`unitId % 6 === tick % 6`).
- **Worst-case guard:** cap A\* expansions at about 4 × the triangle count of the source component. Hitting the cap is a bug, because components should have prevented it, so log it.

```ts
function runPathBudget(deadline: number) {
  while (queue.size && performance.now() < deadline) {
    const req = queue.peek();
    const r = req.step(256);
    if (r !== RUNNING) { queue.pop(); deliver(req, r); }
    else if (req.priority < PLAYER) queue.rotate(req); // time-slice same-priority work
  }
}
```

## 5. Web Workers architecture

### Recommended layout

```
Main thread                         Sim worker (authoritative, fixed tick 30 Hz)
-----------                         -------------------------------------------
input -> commands --postMessage-->  command queue (tick-stamped)
render (WebGL/Canvas2D/Pixi)        navmesh + tiles + components
  reads SAB snapshot A/B, lerps     path queue (fields, A*), budgeted
  by alpha = (now - tPrev)/dt       steering/avoidance, collision, buildings
debug overlays <--postMessage--     writes positions -> SAB snapshot, bumps seq
                                       |
                                       +-- optional path worker pool (2-3)
                                           read-only navmesh copy per version
```

- **Run the simulation in a worker, not on the main thread.** Rendering thousands of sprites plus GC pauses on the main thread would otherwise eat the path budget, and the reverse is also true. A fixed-tick simulation with render interpolation (Glenn Fiedler's "Fix Your Timestep") decouples the 30 Hz sim from 60–144 Hz rendering.
- **Snapshot transport with SAB:** use a triple buffer of `Float32Array` [x, y, angle, state] × maxUnits, plus an `Int32Array` header holding `{latestIndex, tick, seq}`.
  - The worker writes into the free buffer, then calls `Atomics.store(header, LATEST, idx)`.
  - Main reads `Atomics.load` at each frame start and keeps the previous buffer for lerp.
  - Nobody blocks: there is no `Atomics.wait` on the main thread, which isn't allowed there anyway.
- **Fallback without cross-origin isolation:** the worker `postMessage`s a transferable `ArrayBuffer` snapshot each tick, and main returns it after use (ping-pong pool of 3). At 5k units × 16 B = 80 KB/tick this is trivial. Implement this path first, because it always works. Add SAB when `crossOriginIsolated === true`.
- **Path worker pool:** start with **zero**. Paths run inside the sim worker under the budget. Add a pool when a profile shows path work > 30% of the tick.
  - Each path worker gets the navmesh as SAB views: triangle arrays, adjacency, clearance, components, and a version number. The sim worker never mutates a published version. A rebuild produces a new SAB (or new tile slices) and broadcasts `{version, buffers}`.
  - Requests carry `meshVersion`. Results computed on a stale version are discarded or re-validated.
  - Fields are written into SAB-backed `dist`/`next` arrays so the sim reads them with zero copy.
- **Determinism:** if lockstep multiplayer or replays are ever wanted, async workers break determinism unless results are applied at a fixed `tickIssued + D` (e.g. D = 2), where the sim stalls if the result isn't ready. Design the request/delivery API around tick stamps from day one. It costs nothing now.

### Vite configuration (COOP/COEP)

```ts
// vite.config.ts
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
export default defineConfig({
  server:  { headers: isolation },
  preview: { headers: isolation },
  worker:  { format: 'es' },
});
```

- Load workers with `new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })`.
- With `require-corp`, cross-origin assets such as CDN fonts and images need CORP/CORS, so self-host everything.
- The production host must send the same two headers. GitHub Pages can't, so the fallback is a `coi-serviceworker` shim, or simply the transferable-buffer fallback above.
- Check `self.crossOriginIsolated` at runtime and pick the transport accordingly.

## 6. Repathing on dynamic obstacles

When a building is placed:

1. **Validate placement** against units. Units inside the footprint are pushed out, or placement is rejected (SC2 does the latter for blocking units, which then move aside).
2. **Rebuild the affected tiles**, then bump `meshVersion`. Triangle IDs in those tiles change, while IDs in untouched tiles stay stable. Use tile-local IDs (`tileId << 16 | localIdx`) so that holds.
3. **Recompute components** for each class. If a component split (a wall-off), any order whose goal ended up in a different component is re-resolved to the nearest reachable point.
4. **Invalidate selectively:**
   - **Fields:** if `f.tilesTouched ∩ dirtyTiles ≠ ∅`, re-queue a fresh field at priority 2. Units keep following the old field, using a lookup that maps through the new triangle locator for positions in dirty tiles, until the new one is ready. Exception: a unit whose next portal now intersects the footprint, or whose position is inside a dirty tile, gets "straight toward the goal or local avoidance" for those 1–2 ticks.
   - **Per-unit corridors** (A\* results stored as a polyline of portal points plus the list of tiles crossed): only those that cross a dirty tile get re-validated. Run a cheap check first, a segment-vs-footprint test on the remaining polyline. Repath only if it actually intersects. Order repaths by distance-to-obstruction along the path, so the nearest units repath first and units 400 units away can wait.
5. **Obstacle removal** (a building destroyed) opens shortcuts. No path becomes *invalid*, only suboptimal. Re-queue affected fields at priority 4 and leave per-unit A\* paths alone. Units will pick up the improvement on their next natural repath.
6. **Periodic safety net:** every unit's corridor gets a cheap validity check every ~2 s, staggered. That covers anything the dirty-tile logic misses.

Avoid D\* Lite / LPA\* for this. They shine for a single agent with a persistent search tree. With thousands of short-lived searches and a local re-triangulation that changes node identity, "mark dirty, recompute from scratch, lazily and by priority" is simpler and fast enough. Fields are cheap to rebuild.

## 7. Caching and reuse for ambient AI

- **Patrols and waypoint followers:** precompute the polyline between consecutive waypoints once, per class, at spawn time or lazily on first use. Store it on the route object, not the unit, so 50 guards on the same route share it. Store the tiles it crosses too, so the invalidation in §6 applies.
- **LRU path cache:** use `Map<string, Path>` keyed by `${startTri}|${goalTri}|${cls}|${meshVersion}` with about 2k entries. The value is the triangle corridor. The funnel is re-run with the actual start/end points, which is cheap: O(corridor length). The hit rate is high for wanderers that move between a small set of points of interest (POIs).
- **Wanderers:** choose destinations by **random walk on the triangle graph** (N hops from the current triangle, weighted by area), or from a precomputed POI list per region. That keeps searches short, local and cheap. Never pick uniformly over the whole map.
- **Persistent fields** for hot destinations: resource drop-offs, town halls, rally points, the map centre for attack waves. One field per `(destination, class)` serves every worker that ever returns cargo, which is the single largest saving in SC2-style economies. Rebuild these fields on invalidation at priority 3.
- **Throttling under load:** if the queue's backlog exceeds the budget × 10 ticks, ambient requests are deferred. Wanderers idle or keep their old destination, which costs nothing visible.

## Concrete starting numbers (to tune by profiling)

| Parameter | Start value |
|---|---|
| Sim tick | 30 Hz |
| Path budget per tick | 3 ms (player-priority burst to 8 ms) |
| Radius classes | 3–4 |
| Field corridor lookahead K | 8 triangles |
| Field corridor refresh | every 6 ticks per unit, staggered |
| Group threshold for fields | N ≥ 5 |
| Nav tile size | 64 × 64 world units |
| Path cache | 2k entries, LRU |
| Path workers | 0, then 2 if profiling shows path work > 30% of tick |

## References

- Treuille, Cooper, Popović, "Continuum Crowds", SIGGRAPH 2006 — https://grail.cs.washington.edu/projects/crowd-flows/
- Emerson, "Crowd Pathfinding and Steering Using Flow Field Tiles", *Game AI Pro* (also in *Game AI Pro 360: Movement and Pathfinding*, ch. 7) — http://www.gameaipro.com/ (the chapter PDF is linked from the GameAIPro site; URL not re-verified) and https://www.routledge.com/products/9780367151133
- GameDev.net discussion of flow field architecture — https://gamedev.net/forums/topic/701267-flow-field-architecture-advice
- Botea, Müller, Schaeffer, "Near Optimal Hierarchical Path-Finding (HPA\*)", 2004 — https://webdocs.cs.ualberta.ca/~mmueller/ps/hpastar.pdf
- Demyen, Buro, "Efficient Triangulation-Based Pathfinding" (TA\*/TRA\*), AAAI 2006 — https://skatgame.net/mburo/ps/thesis_demyen_2006.pdf
- Anhalt et al., "AI Navigation: It's Not a Solved Problem — Yet", GDC 2011 (SC2 section) — https://www.gdcvault.com/play/1014514/AI-Navigation-It-s-Not
- Recast/Detour (`dtPathCorridor`, `dtTileCache`, `dtCrowd`; tiled navmesh and path-corridor replanning) — https://github.com/recastnavigation/recastnavigation
- Koenig, Likhachev, "D\* Lite", AAAI 2002 (considered, not recommended) — http://idm-lab.org/bib/abstracts/papers/aaai02b.pdf
- Red Blob Games, flow field / Dijkstra map intro — https://www.redblobgames.com/pathfinding/tower-defense/
- Fiedler, "Fix Your Timestep!" — https://gafferongames.com/post/fix_your_timestep/
- MDN, SharedArrayBuffer security requirements — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements
- web.dev, "Making your website cross-origin isolated using COOP and COEP" — https://web.dev/articles/coop-coep
- Vite `server.headers` — https://vite.dev/config/server-options#server-headers ; worked example — https://wavelength.lightning.engineering/web/get-started/cross-origin-isolation/
- Vite cross-origin isolation plugin — https://github.com/chaosprint/vite-plugin-cross-origin-isolation
