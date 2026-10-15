# 01 — Navigation Representation and Global Path Queries

Scope: how the world is represented for pathfinding, and how a single unit (any radius) gets a global path from A to B. Local avoidance, crowd steering and formation movement are covered in other research notes.

---

## 0. Recommendation summary

1. **Representation: one dynamic Constrained Delaunay Triangulation (CDT) over the whole map.** This is the SC2 approach. Static terrain polygons and building footprints are constrained edges. Every triangle is tagged walkable or blocked. A 256x256-cell SC2-scale map comes out at roughly 5k–30k triangles, against millions of fine grid cells.
2. **Unit radii: one mesh serves every radius.** Use Demyen's per-triangle width table (3 floats per triangle, clamped to the largest unit diameter) to prune A*. Then run a **radius-aware funnel** in which obstacle corners are circles of radius `r`. Do not build one mesh per radius class.
3. **Dynamic buildings: incremental constraint insertion and removal on the live CDT.** Insert with vertex insertion plus Sloan-style edge flipping. Remove with a constraint refcount, then unmark, flip the vertex down to degree 3, delete it and run Lawson legalization. Widths are recomputed only inside the touched region expanded by `2*rMax`. Expected cost is well under 0.5 ms per building.
4. **Robustness: snap all input coordinates to a fixed lattice and use `robust-predicates`** (Shewchuk's `orient2d`/`incircle`). Building placement is validated so that **constraints never cross**: buildings never overlap terrain or each other except along shared collinear edges, and those are refcounted. Every CDT vertex is then an exact input point, and exact predicates make the topology provably consistent.
5. **Libraries: write our own CDT core, about 2k lines of TypeScript on typed arrays.** Use `delaunator` + `@kninnug/constrainautor` only to **bootstrap** the static mesh (their halfedge layout is the one we use) and as a **test oracle**. Use `robust-predicates` at runtime. No existing JS library supports constraint removal.
6. **Search: TA*-style A* over triangles** with node = (triangle, entry edge). g-cost is an edge-point estimate, h is the Euclidean distance from the goal to the entry edge, and the search does a small bounded anytime refinement. Point location uses a bucket grid plus an `orient2d` walk. Starts inside obstacles snap to the nearest clear point. Unreachable goals fall back to the reachable node with minimum `h`.
7. **Smoothing: a Simple Stupid Funnel variant using circle-to-circle tangents.** It outputs a path of tangent segments plus corner circles (vertex, side, radius), which is exactly what steering needs to "hug" corners.

---

## 1. Why CDT (vs grid, visibility graph, Recast)

| Option | Problems at SC2 scale | Verdict |
|---|---|---|
| **Grid** (with JPS / clearance maps) | Unit radii from 0.375 to about 1.5 cells need sub-cell resolution. 1/8-cell gives 2048² ≈ 4M nodes. Clearance needs a per-radius-class map. Paths are 8-directional and need post-smoothing. Building updates are cheap but searches are expensive. | Simple fallback only |
| **Visibility graph** | O(n²) edges. Needs inflated obstacles per radius. Every building insert can change O(n) edges. | No |
| **Recast/Detour** (`recast-navigation-js`, WASM) | Voxelizes exact polygons (lossy). Agent radius is baked into the mesh, so you need N meshes for N radius classes. TileCache dynamic obstacles are limited to cylinders and boxes. Built for 3D. Large WASM payload. | Viable but wrong fit |
| **CDT** (SC2, Demyen) | Exact geometry and few nodes. Radius is handled at query time on one mesh. Local updates are O(touched triangles). It is harder to implement robustly. | **Chosen** |

Anhalt (GDC 2011) describes SC2's design: one CDT, rebuilt or patched locally when buildings change; A* on triangles; a funnel with unit radius; and steering/avoidance kept separate from global pathing. Demyen's thesis provides the formal pieces: TA* and TRA*, the width computation, and the modified funnel.

---

## 2. Data layout (performance-oriented)

Use a triangle-based halfedge structure compatible with Delaunator. Halfedge `e` belongs to triangle `t = floor(e/3)`. It runs from vertex `tri[e]` to `tri[next(e)]`, where `next(e) = e%3==2 ? e-2 : e+1`.

```ts
// vertices (capacity-doubling, free list)
vx, vy:        Float64Array   // exact lattice coords (doubles, required for predicates)
vFlags:        Uint8Array     // FIXED (map boundary / static terrain), DEAD
vEdge:         Int32Array     // one outgoing halfedge (for star iteration / removal)

// triangles: 3 halfedges each
tri:           Int32Array     // [3t+i] = start vertex of halfedge 3t+i
opp:           Int32Array     // twin halfedge or -1 (map boundary)
cRef:          Uint16Array    // constraint refcount per halfedge (kept equal on twins); >0 = constrained
tFlags:        Uint8Array     // BLOCKED, DEAD, DIRTY
tWidth:        Float32Array   // [3t+i] = Demyen width for passing through t "around" vertex tri[3t+i]
tGen:          Uint32Array    // bumped when triangle id is reused -> invalidates cached ids
freeTris:      Int32Array stack

// search scratch (allocated once, sized to capacity)
gCost, fCost:  Float64Array; parentEdge: Int32Array; stamp: Uint32Array // generation stamping, no clears
heap:          Int32Array + Float64Array keys (binary heap, decrease-key via duplicate push + stamp check)
pointX/Y:      Float64Array   // the edge point used for g (per node)
```

Notes:
- **Width indexing.** Passing through `t` from edge `a` to edge `b` always goes around the vertex `C` that the two edges share. That means 3 widths per triangle, keyed by vertex slot.
- **Bucket grid for point location.** Use a uniform grid of about 4x4 world units. Each cell stores one triangle id plus its `tGen` and serves as a walk hint. Units cache their current triangle and walk from it each frame, which is O(1) amortized.
- **Clamp widths** to `2*rMax + eps`. Width searches then stay bounded, and dynamic updates stay local (see 4.4).
- Store `region` per triangle (connected-component id per radius class). Compute it lazily and invalidate it on mesh change. It gives an O(1) "unreachable" early-out.

---

## 3. Radius handling

### 3.1 Demyen triangle width

A unit of radius `r` can pass through triangle `t` from edge `a` to edge `b` iff `width(t, C) >= 2r`, where `C` is the vertex shared by `a` and `b`. Let `A` be the other end of `a` and `B` the other end of `b`. Then `c = AB` is the third edge.

```
width(t, C):                       // A,B,C as above
  d = min(|CA|, |CB|)
  if angle(CAB) >= 90° or angle(CBA) >= 90°:   // use dot products, no trig
      return d
  if isConstrained(edge c):
      return distPointSegment(C, A, B)
  return searchWidth(C, t, c, d)

searchWidth(C, t, e, d):           // e = edge of t opposite C (halfedge into neighbour)
  U = neighbour triangle across e; if none: return d
  V = vertex of U not on e
  if V is inside the "perpendicular slab" of C w.r.t. e        // projections onto e's endpoints
     and dist(C,V) < d:
      d = dist(C,V)                                            // a vertex closer than d chokes
  for each other edge e' of U:
      if dist(C, segment e') >= d: continue                    // can't improve
      if isConstrained(e'): d = min(d, dist(C, e'))
      else: d = searchWidth(C, U, e', d)
  return min(d, 2*rMax+eps)                                     // clamp → bounded recursion
```

Also check the **start and goal triangles**. A unit at point `p` leaving through edge `e` needs `dist(p, constrained stuff) >= r`. Snapping (5.4) guarantees this. Also require `|edge| >= 2r` on any edge crossed between two triangles. The width check covers this for interior triangles, but check it explicitly for the first and last edges.

TA* uses widths only for **pruning**. A path that passes every width check is guaranteed to exist for the circle (Demyen, Thm. in ch. 5), because CDT triangles near choke points expose the true clearance.

### 3.2 Why not per-radius meshes

Erosion (Minkowski-inflating obstacles by `r`) creates arcs, which become polygonal approximations with many extra vertices. You need one mesh per radius class, and each building change must update all of them. SC2 has more than 10 distinct radii. A single mesh plus the width table costs 12 bytes per triangle.

### 3.3 Funnel with radius (string pulling around circles)

Treat each portal endpoint as a **circle of radius `r`**: the left endpoint is wrapped clockwise and the right endpoint counter-clockwise. The apex is a (vertex, side) pair, not a point. Directions are measured along **tangent lines** between the apex circle and the candidate circle.

```
tangent(P, sideP, Q, sideQ, r):   // sides: +1 = wrap left (CCW), -1 = wrap right (CW), 0 = point (start/goal)
  // same sides -> outer tangent; opposite sides -> inner (cross) tangent
  // returns the two touch points (p', q'); direction = q' - p'
  d = Q - P; L = |d|
  rP = r*|sideP|, rQ = r*|sideQ|
  k = (sideP*rP - sideQ*rQ) / L       // |k|<=1 guaranteed if portals were width-checked
  n = perp(d)/L
  u = d/L * k + n * sqrt(1-k*k)      // normal of tangent line (choose sign by sideP)
  p' = P - sideP*rP*u ; q' = Q - sideQ*rQ*u
```

```
funnelRadius(portals[ ], start, goal, r):        // portals as (left, right) vertex pairs, goal appended as (goal,goal)
  apex = (start, side 0); L = R = portal0
  for i in 1..n:
     (pl, pr) = portals[i]
     // right side tightening
     if cross(dir(apex, R), dir(apex, pr)) <= 0:
        if apexIs(R==apex) or cross(dir(apex, L), dir(apex, pr)) > 0:
             R = pr
        else:                                   // pr crosses over left: L becomes a corner
             emit corner (L, side=+1); apex = (L,+1); reset L=R=apex; i = indexOf(L); continue
     // symmetric for left
  emit goal
  // then expand corners: segment(tangent touch points) + arc on circle(corner, r) between touches
```

Here `dir(apex, X)` is the tangent direction from the apex circle to circle X with the side that X wraps. This is exactly Mononen's SSF with "point" replaced by "tangent from circle". Pitfalls:
- **Skip zero-length portal endpoints.** When consecutive portals share an endpoint, SSF's `vequal` test must compare vertex IDs, not floats.
- **Circles near the goal.** If the goal lies within `r` of a corner circle, the tangent is undefined because `|k|>1`. Snap the goal outward first (5.4).
- **Corner vertex where the obstacle angle is concave from the walkable side.** The unit's circle still touches only the vertex, so the formulation stays correct.
- Output `PathCorner {x, y, side, r}`. Steering follows the tangent segments. Steering should also re-funnel locally from the current position every N frames, which gives SC2's "cutting corners naturally" look.

---

## 4. Dynamic obstacles

### 4.1 Contract that makes it tractable

- All coordinates sit on a lattice, e.g. 1/16 cell. Building corners are integer half-cells, as in SC2. Static terrain is unioned and simplified offline (e.g., with Clipper2) and snapped.
- **Placement validation** happens on the footprint grid: no overlap with terrain or with other buildings. Shared collinear edges are allowed.
- Result: constraint segments never properly intersect, so **no Steiner points** arise from intersections. The only splits occur where a segment passes exactly through an existing vertex (`orient2d == 0` and the vertex lies between the endpoints). Those splits are lattice points, so the representation stays exact.
- Collinear overlapping edges (two adjacent buildings, or a building against the map edge) are handled by `cRef` refcounting on the subsegments.

### 4.2 Insert building polygon `P`

```
insertObstacle(P):
  for v in P: vid[v] = insertVertex(v)          // lookup by quantized coord in a Map first (dedupe)
  for each edge (a,b) of P: insertConstraint(vid[a], vid[b], +1)
  markBlocked(P)          // triangles in the cavity whose centroid is inside P (flood-fill bounded by P's constrained edges)
  recomputeWidths(region = AABB(P) ⊕ 2*rMax)
  emit MeshChanged(AABB(P))

insertVertex(p):
  t = locate(p)                                  // walk from grid hint, orient2d tests
  if p on edge e (orient2d==0): split edge -> 4 tris (if e constrained, the two halves inherit cRef)
  else split t -> 3 tris
  legalize(queue of the opposite edges)          // Lawson: flip if !constrained && incircle>0

insertConstraint(a, b, k):
  if edge(a,b) exists: cRef += k on both twins; return
  if some vertex v lies exactly on open segment (a,b): insertConstraint(a,v,k); insertConstraint(v,b,k); return
  crossed = edges intersected by (a,b), walking from a's star       // all unconstrained by contract
  while crossed not empty:                                          // Sloan 1993 / constrainautor
     e = crossed.shift()
     if quad(e) strictly convex: flip(e)
        if new diagonal still crosses (a,b): crossed.push(newDiag) else newEdges.push(newDiag)
     else crossed.push(e)                                           // retry later; terminates
  mark edge(a,b) cRef = k
  legalize(newEdges)                                                // restore Delaunay except across constraints
```

### 4.3 Remove building

```
removeObstacle(P):
  for each edge (a,b) of P: for each subsegment s on (a,b): s.cRef -= 1
  clearBlocked(triangles inside P)            // re-evaluate against static terrain + other buildings
  Q = all edges whose cRef reached 0
  legalize(Q)                                 // they may now be non-Delaunay
  for v in vid(P): if !FIXED(v) and no incident constrained edge: removeVertex(v)
  recomputeWidths(AABB(P) ⊕ 2*rMax); emit MeshChanged

removeVertex(v):                              // flip to degree 3, then delete (Devillers-style, simple form)
  while degree(v) > 3:
     find incident edge v–q with neighbours p, r in v's star such that
        quad (v,p,q,r) is strictly convex      // orient2d tests; such an "ear" always exists
     flip(v–q)                                 // → edge p–r, v degree -1
  merge the 3 triangles around v into one; free 2 triangle slots; free v
  legalize(edges of the merged triangle and its neighbours)
```

Lawson legalization converges to the CDT from any constrained triangulation, so ear choice does not affect correctness. A smarter ear order (Devillers' power criterion) only reduces flips. Removing only vertices the building introduced, and never FIXED ones, keeps static geometry intact.

### 4.4 Cost and robustness

- A building adds 4–8 vertices and 4–8 segments. Each insertion takes O(1) expected flips after an O(√n) walk, which drops to O(1) with the grid hint. Constraint insertion is O(k) in crossed edges, typically under 30. Measured in comparable C++ code, the total is about 10–50 µs. Expect under 0.3 ms in JS including width recompute, so a 100-building wall-off is fine.
- **Width recompute region.** A width can change only if some vertex or constrained edge within `2*rMax` changed, because widths are clamped. Recompute all triangles whose bbox intersects `changedAABB ⊕ 2*rMax`.
- **Path invalidation.** Each path stores the AABB of its triangle corridor. `MeshChanged(aabb)` marks intersecting paths for re-plan. Re-plans are queued and budgeted per frame (for example 2 ms). Units continue on the old path until the new one arrives, and the local layer stops them from walking into new buildings.
- **Triangle ID reuse.** Freed triangle slots are reused. Every cached triangle id (unit locations, grid hints, path corridors) stores `(id, tGen)` and revalidates before use.
- **Robustness.** With lattice coordinates, no intersection constructions and exact `orient2d`/`incircle`, every topological decision is exact. Treat `incircle == 0` as "do not flip" so cocircular grids terminate. The only floats that are not exact are distances, widths and tangents, which are used for costs and never for topology.
- **Alternative (Plan B): tiled rebuild.** Split the map into 32x32-cell tiles with fixed tile-border vertices, and rebuild an affected tile with Delaunator + Constrainautor (a few hundred points, about 0.2 ms). This is simpler and very robust, but it introduces tile-border slivers and seams that the width calculation and funnel must cross. Kallmann's "Dynamic and Robust Local Clearance Triangulations" (LCT) is the academic version of 4.2/4.3, with a refinement that guarantees clearance is computable locally. If the Demyen width search proves too slow or flaky, adopt LCT's "disturbance" refinement, which adds Steiner points so that local width equals true clearance.

---

## 5. A* over triangles

### 5.1 Node, cost, heuristic

Demyen's TA* searches triangles. A triangle's g-value is a **lower bound**: the larger of the parent's g plus the distance between the closest points of consecutive edges, and `|start − entryEdge|`. Because triangle-level states merge many geometric paths, the first path found is **not optimal**: a triangle reached first via a long corridor can be re-reached via a shorter one only through its other edges. TA* therefore keeps searching after the first solution (**anytime**). It computes the true length of each solution with the funnel and prunes nodes with `f >= bestLength`. It also allows revisiting a triangle with a different entry edge.

Practical variant for us:
- **Node = halfedge of entry.** Each triangle can be entered via 3 edges, giving 3 states.
- **Edge point.** For node `e`, set `pt(e)` to the point on segment `e`, shrunk by `r` at both ends, that is closest to the segment from `pt(parent)` to the goal. This gives a much tighter estimate than midpoints. Midpoints zig-zag and overestimate badly in large triangles. Centroids are worse.
- `g(e) = g(parent) + |pt(parent) − pt(e)|`. This is not a strict lower bound but is close to the funnel length. Set `h(e) = dist(goal, segment e)`, which is admissible.
- **Prune** any transition where `width(t, C) < 2r` or the edge is constrained or leads to a BLOCKED triangle.
- **Anytime.** After the first goal pop, run the funnel to get the length `L`. Continue popping while `f < L` and an expansion budget remains (e.g., +50% of nodes so far, or a time cap). On each further goal arrival, funnel and keep the best. This is TA*'s scheme with a cap, and in practice it fixes the "went around the wrong side of a big obstacle" cases.
- **Optional.** Polyanya (Cui, Harabor & Grastien, 2017) is an optimal any-angle navmesh search that works directly on CDTs. It does not natively handle radius: it would need an inflated mesh per radius class. Keep it as a reference rather than a v1 target.
- **TRA* (Demyen's abstraction).** It reduces triangles to degree-3 decision nodes and corridors. It is a meaningful speedup on huge maps, but complicates dynamic updates. Skip it for v1. A 20k-triangle A* in TS with typed arrays should run at about 0.2–1 ms.

### 5.2 Search loop sketch

```
search(start, goal, r):
  ts = locate(start); tg = locate(goal)
  if region_r(ts) != region_r(tg): goal = closestReachable(...)         // or let A* fallback handle it
  if ts == tg: return funnel([], start, goal, r)                          // still check straight-line clearance
  stamp++ ; push all 3 edges of ts that pass edge-length>=2r check
  best = ∞; bestNode = -1; closest = argmin h
  while heap not empty:
     e = pop(); if f(e) >= best: break
     t = triAcross(e)
     if t == tg: L = funnelLength(corridor(e)); if L < best: best=L; bestNode=e; continue
     for e2 in other two edges of t:
        C = shared vertex of e and e2
        if cRef[e2]>0 or BLOCKED(across e2) or tWidth[slot(t,C)] < 2r: continue
        relax(e2, g(e) + |pt(e)-pt(e2)|)
     if h(e) < h(closest): closest = e
     if expansions > budget: break
  if bestNode < 0: path to closestPointOn(edge closest, toward goal)        // unreachable fallback
```

Also check the goal triangle with radius: the unit must be able to pass from the entry edge to `goal` with clearance `r`. Snapping (5.4) ensures `goal` is at least `r` from constraints, so the funnel's tangent stays valid.

### 5.3 Point location

1. Take the hint from the bucket grid (if `tGen` is valid), or from the unit's cached triangle.
2. Run a **visibility walk**. Step across any edge `e` with `orient2d(e.a, e.b, p) < 0`. Choose among the candidate edges at random to avoid cycling on degenerate inputs (the "remembering stochastic walk").
3. On a boundary or edge hit (`orient2d == 0`), return the triangle and an `onEdge` flag.
4. Refresh grid hints lazily: after a walk, write the found triangle into its cell.

### 5.4 Start/goal inside obstacles, unreachable goals

- **Snap to walkable.** If `locate(p)` is BLOCKED, or `p` is within `r` of a constrained edge, BFS outward over triangles within a radius bound such as 8 cells. For each constrained edge found, compute the closest point on that edge offset by `r` along its walkable-side normal. Corners need care: offset along the bisector, i.e. a point on the circle of radius `r`. Validate candidates by locating them and checking clearance, and take the nearest valid one. SC2 behavior: when you right-click on a cliff or building, units go to the nearest reachable point.
- **Unreachable (different region, or enclosed by buildings).** Track the expanded node with minimum `h`, tie-broken by smaller `g`. When the open set empties, path to the closest point to the goal on that node's edge or triangle. Use per-radius-class region IDs (flood fill over passable transitions) to detect this cheaply *before* running A*. Approximate the per-triangle passability for regions as `max width over the 3 slots >= 2r`, then let A* make the exact check.
- **Cost guard.** Disconnected goals are the worst case for A*, which floods the whole component. The region check avoids that. When regions say "reachable" but A* still fails, which can happen because of the width approximation, cap expansions.

---

## 6. JS/TS library evaluation

| Library | What it is | Incremental add | Constraint remove | Robust | License | Use? |
|---|---|---|---|---|---|---|
| `delaunator` (mapbox) | Very fast static Delaunay (sweep-hull), triangles/halfedges arrays | No (`update()` re-triangulates all) | n/a | Yes (robust-predicates since v5) | ISC | **Bootstrap only** |
| `@kninnug/constrainautor` (v4.x) | Adds constraint edges to a Delaunator result via flips; `delaunify()` | Constraints yes, points no | **No** | Yes (robust-predicates, robust-segment-intersect) | ISC | **Bootstrap + oracle** |
| `robust-predicates` (mourner) | Shewchuk's orient2d/incircle port, fast | — | — | Exact | Unlicense | **Yes, runtime** |
| `cdt2d` (mikolalysenko) | Static CDT with exterior/interior classification | No | No | Yes (robust-* packages) | MIT | No (static, slow, unmaintained) |
| `poly2tri.js` | Sweep-line CDT of polygons with holes | Steiner points pre-build only | No | Fragile: throws on duplicate/collinear points, touching holes | BSD-3 | No |
| `earcut` | Ear-clipping polygon triangulation | No | No | Mostly | ISC | Rendering only (slivers, not Delaunay) |
| `navmesh` (mikewesthad) | A* over convex polygons + funnel, for Phaser | No | No | Float | MIT | No (no radius, no dynamics) |
| `recast-navigation-js` | WASM Recast/Detour + TileCache | Tile rebuild, cylinder/box obstacles | via TileCache | Yes | MIT | Plan C only |
| Shewchuk `Triangle` (WASM ports) | Gold-standard CDT | No | No | Exact | Non-commercial | No (license) |

**Decision.** Write our own `DynamicCDT` on the Section 2 layout. Bootstrap the static map with `delaunator` + `constrainautor`: the map rectangle corners are added as points so that the hull equals the map boundary. Copy their `triangles`/`halfedges` arrays into ours and convert constraint bits into `cRef`. Test it as follows:
1. Fuzz random building add/remove sequences.
2. After every operation, assert the CDT invariants: each unconstrained edge passes `incircle <= 0`, `opp` is symmetric, orientation is CCW, and Euler counts hold.
3. Compare edge sets against a fresh Delaunator + Constrainautor build of the same constraint set. For lattice inputs without cocircularity this must match exactly. For cocircular sets, compare only the invariants.

---

## 7. Pitfalls checklist

- Never use float `==` on coordinates. Use quantized-key maps for vertex dedupe, and vertex IDs for equality in the funnel.
- `incircle` sign convention depends on orientation. Keep all triangles CCW and assert it in debug builds.
- Midpoint/centroid g-costs give visibly bad routes in large open triangles. Use the edge-point g (5.1) and anytime refinement.
- Width tables go stale silently after mesh edits. Track a DIRTY flag and assert in debug that no DIRTY triangle is used.
- The funnel tangent `sqrt(1-k²)` goes NaN when two corner circles overlap (`|PQ| < 2r` with opposite sides). That means the width check missed a case. Clamp, and log it in debug.
- Sliver triangles along long map edges hurt walk performance, not correctness. Add a few Steiner points along very long boundary segments at bootstrap.
- Re-plan storms after a building drop. Budget re-plans and let groups share a path: compute one path for the largest radius in the group, and have followers offset.
- Bucket-grid hints and cached triangle ids must carry generation stamps (`tGen`).
- Removing a vertex shared by two buildings' collinear edges requires `cRef` to reach 0 on *all* incident edges. Check this before calling removeVertex.

---

## 8. References

- J. Anhalt, "AI Navigation: It's Not a Solved Problem – Yet", GDC 2011 (with Dave Mark, Kevin Dill et al.): https://www.gdcvault.com/play/1014514/AI-Navigation-It-s-Not
- D. Demyen, "Efficient Triangulation-Based Pathfinding", MSc thesis, U. Alberta 2007: https://era.library.ualberta.ca/items/3a3fb26a-1b1d-4b8e-9d0a-11d2a1c5ae2b (also the AAAI 2006 paper: https://www.aaai.org/Papers/AAAI/2006/AAAI06-148.pdf)
- M. Kallmann, "Dynamic and Robust Local Clearance Triangulations", ACM TOG 2014: https://graphics.ucmerced.edu/papers/14-tog-lct.pdf
- M. Kallmann, H. Bieri, D. Thalmann, "Fully Dynamic Constrained Delaunay Triangulations", 2003: https://graphics.ucmerced.edu/papers/03-geobook-dt.pdf
- S. W. Sloan, "A fast algorithm for generating constrained Delaunay triangulations", Computers & Structures 1993 (flip-based constraint insertion)
- O. Devillers, "On Deletion in Delaunay Triangulations", 1999: https://inria.hal.science/inria-00072998
- J. R. Shewchuk, "Adaptive Precision Floating-Point Arithmetic and Fast Robust Geometric Predicates": https://www.cs.cmu.edu/~quake/robust.html
- M. Mononen, "Simple Stupid Funnel Algorithm": http://digestingduck.blogspot.com/2010/03/simple-stupid-funnel-algorithm.html
- M. Cui, D. Harabor, A. Grastien, "Compromise-free Pathfinding on a Navigation Mesh" (Polyanya), IJCAI 2017: https://www.ijcai.org/proceedings/2017/0070.pdf
- Libraries: https://github.com/mapbox/delaunator · https://github.com/kninnug/Constrainautor · https://github.com/mourner/robust-predicates · https://github.com/mikolalysenko/cdt2d · https://github.com/r3mi/poly2tri.js · https://github.com/mapbox/earcut · https://github.com/mikewesthad/navmesh · https://github.com/isaac-mason/recast-navigation-js · https://github.com/AngusJohnson/Clipper2
