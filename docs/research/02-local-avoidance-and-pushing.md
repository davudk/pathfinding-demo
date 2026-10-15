# 02 — Local avoidance, pushing, collision resolution and group movement

Scope: how units interact with each other once each has a global path (navmesh or flow field, covered in other research notes). The goal is SC2-like feel: thousands of circular units with different radii and speeds, movers push idle friendlies aside, and a mover steers around anything it cannot push. Movement should be smooth, units should not overlap for long, and nobody should dance at the destination.

**Recommendation in one line:** don't use ORCA as the core. Use **steering (path-follow + lookahead avoidance + light separation) for the velocity, then a positional contact solver with priority-based inverse masses (soft PBD) for the actual de-overlap and pushing, then slide against static polygon edges**. Add SC2-style arrival rules and stuck detection on top. All of it runs on a fixed 1/32 s or 1/30 s tick over a uniform spatial hash.

---

## 1. What StarCraft II does

Primary source: the GDC 2011 AI Summit panel *"AI Navigation: It's Not a Solved Problem – Yet"* (James Anhalt of Blizzard, Alexander Kring, Nathan Sturtevant). The slides and video are in the GDC Vault. Below is the summary that circulates from that talk and from player-observable behaviour. Points the talk did not state explicitly are marked as *observed*.

- **Global path.** A constrained Delaunay triangulation navmesh, A* over triangles, then funnel/string-pulling. Buildings are cut into the mesh when placed. Units are **not** part of the navmesh. The pathfinder never routes around other units; local steering and pushing handle them.
- **Steering is boids-derived.** There are three forces:
  - **Separation** keeps units from stacking.
  - **Cohesion/alignment** acts only within a unit's own command group, and is weak.
  - **Avoidance** is predictive. Anhalt called it "horizon" analysis: look ahead along the current velocity and find the first unit you would hit within a short time horizon. Then steer to the side of it that is free and closer to your path direction. You only avoid units that are *not going to get out of the way*: idle units you can push are ignored by avoidance and simply shoved.
- **Pushing.** Moving units push stationary friendly units, and the pushed unit gets a short "move out of the way" displacement. Units on **Hold Position**, enemies, and units that are busy (attacking, casting, mining) are not pushed. The mover treats them as obstacles and steers around. The SC2 data editor exposes a per-unit **push priority** field. The rule is that a unit may push another only if its priority is greater than or equal to the other's. Massive units such as Ultralisks and Thors effectively push smaller ones. Workers are a special case: while mining they ignore unit collision entirely (*observed*, Liquipedia).
- **Clumping.** All units of a group move toward the same goal and separation is weak, so the group compresses into a ball en route. That is the classic SC2 "deathball", *observed*. It is a deliberate design choice (it makes splash damage matter). For a demo you may want a configurable cohesion/separation strength rather than SC2's exact ball.
- **Magic box.** For a group move order, compute the selection's bounding box. The box size is capped. Brood War used fixed boxes of 195x195 px for ground units and 255x255 px for air units, and SC2 uses a similar capped box.
  - If the click is **outside** the box, each unit's goal is `click + (unitPos − groupCentroid)`, which preserves the formation.
  - If the click is **inside** the box, all units get the click point and converge.

  Sources: Liquipedia *Magic Boxes*, *Basic Unit Commands*.
- **Arrival.** A unit stops when it reaches its goal, **or** when it touches a group-mate (same order) that has already arrived and it is within some distance of the goal. This "chain arrival" is what lets 50 Zerglings sent to one point form a blob instead of fighting over the single pixel. Arrived units turn back into idle units that can be pushed, so late arrivals can still nudge into the blob.
- **Stacking resolution.** When a stacked group (e.g. mineral-walking workers) receives a stop or attack command, the units un-stack immediately and push surrounding units away (Liquipedia SC2 bugs/mechanics). Overlap is resolved positionally, not by steering.

Takeaway: SC2 is **not** a velocity-obstacle system. It is steering plus priority-ordered positional pushing. That is cheaper and more controllable than ORCA, and it is what produces the "feel" players know.

## 2. Velocity-obstacle methods (RVO2 / ORCA / HRVO)

**ORCA** (van den Berg, Guy, Lin, Manocha, *Reciprocal n-Body Collision Avoidance*, ISRR 2009; RVO2 library). Each neighbour pair produces a half-plane constraint in velocity space. Each agent takes half the responsibility by default. The agent then solves a 2D linear program for the velocity closest to its preferred velocity. If the LP is infeasible, a 3D LP minimises the maximum penetration. Static obstacles are line-segment constraints that take full responsibility.

**HRVO** (Snape, van den Berg, Guy, Manocha, IEEE T-RO 2011) is a hybrid of VO and RVO. It removes the "reciprocal dance", where two agents both dodge to the same side, but its trajectories are less smooth than ORCA's and it costs more.

| Aspect | ORCA / HRVO | Steering + positional contacts (recommended) |
|---|---|---|
| Cost | Per agent, about 10 neighbours × LP. RVO2 claims thousands of agents at real-time rates in native code. In JS it costs roughly 3–6× more than steering and allocates unless carefully written. | One neighbour pass for steering plus 2–4 contact-solver iterations. Cheap, branch-light, and easy to write as typed arrays. |
| Guarantees | Collision-free *if* everyone obeys it and the LP is feasible. | No guarantees; overlap is fixed after the fact. That is acceptable for games. |
| Dense crowds | Deadlocks in symmetric scenarios (head-on equal agents, agents surrounding a goal). Gridlock at chokepoints, because nobody may enter a neighbour's VO. Freezing when the 3D LP fallback triggers. | Contacts "flow". Pushing naturally drains crowds through chokepoints. |
| Pushing idle units | Requires hacks. You can give the idle agent responsibility 1.0 and the mover 0.0, but an idle agent has preferred velocity 0, so it only moves out of the way reactively and slowly. | Native: inverse-mass ratios per contact. |
| Arrival | Agents still try to reach the exact point, so they jitter around crowded goals. | Arrival rules plus pushable idle units: units settle. |
| Determinism | LP iteration order and float sensitivity; achievable but fiddly. | Simple, ordered loops; easy. |

**Asymmetric responsibility.** If you do use ORCA, replace the 0.5 split with `α_A = w_B/(w_A+w_B)`, where `w` encodes priority. An immovable unit gets α=0 and the other agent takes everything. This is the standard way to mix pushing in. It still does not *move* idle units out of the way, though. You also need a positional push, so you end up building the contact solver anyway.

**Where ORCA does shine:** two moving groups crossing each other in open space, where predictive avoidance looks smarter. You get most of that benefit from a cheap time-to-collision avoidance term in steering (Reynolds' unaligned collision avoidance; Karamouzas et al. 2014, *Universal power law*). **Verdict:** keep ORCA as an optional experiment behind the same interface. Ship steering + PBD contacts.

**Position-based alternative literature:** Weiss, Litteneker, Jiang, Terzopoulos, *Position-Based Multi-Agent Dynamics for Real-Time Crowd Simulation* (MIG 2017). It combines a short-range hard contact constraint with a long-range predictive "avoidance" constraint, solved via PBD (Müller et al. 2007). That is essentially the recommended design, and it has been shown to be stable at thousands of agents.

## 3. Arrival and stopping

Oscillation at destinations comes from units that cannot occupy their goal but keep trying. The fixes, in order of importance:

1. **Goal radius scales with group size.** For a converge order (click inside the box), compute the area the group needs, `A = Σ π r_i² / 0.75` (packing factor). That gives `R_group = sqrt(A/π)`. A unit is "close enough" if `dist(goal) < max(r_i, R_group·k)`, where k is about 0.5–0.7.
2. **Chain arrival (SC2).** A unit is arrived if it overlaps or touches (`d < r_a + r_b + ε`) a unit with the **same order id** that has `arrived = true`, *and* `dist(goal) < R_group + r_i`. Check this every tick during the contact pass; it is free.
3. **Blocked-progress arrival.** If, within the last `T_stall` (≈0.5 s), the unit made less than `0.15·speed·T_stall` progress toward the goal, and it is within `2·R_group` of the goal, mark it arrived. This also covers goals inside crowds of *other* groups.
4. **On arrival, become idle.** Set velocity to 0 and clear the steering target. The unit becomes **pushable**, with idle priority. This step is crucial. Late arrivals push the early ones slightly, the blob settles, and nobody "seeks". Arrived units must **never** re-seek their goal point. They may only be displaced by pushes, and they don't walk back. (SC2 units do not walk back after being pushed. Optionally, return them after a long delay when they are out of combat.)
5. **Damping for idle units.** Push displacement goes through velocity with strong damping: an idle unit's velocity decays to 0 with a time constant of about 0.1 s, and anything below a small speed is snapped to 0. This kills micro-jitter.
6. **Arrive deceleration.** Use Reynolds' "arrive" behaviour: `desiredSpeed = min(maxSpeed, sqrt(2·decel·dist))` for the last stretch. Disable it for chain-arrival (just stop), otherwise blobs creep.

## 4. Static obstacles, sliding, stuck detection, repathing

**Static collision.** The navmesh boundary and building footprints are polygons. Each unit needs clearance `r_i` from them. Two layers:

- **Prevention.** Plan on a navmesh with **radius-specific clearance**: either one mesh per radius class, or a single mesh with per-edge clearance (handled in the pathfinding note). Funnel corners are offset by `r_i`, so paths never graze walls.
- **Correction (after the contact solver).** Query static segments in the unit's cell. For each segment within `r_i`, project the unit out along the segment normal: `p += n·(r_i − dist)`. For convex corners, use the closest-point vector. Do this **after** unit-unit pushes, and do it for 1–2 iterations, because pushes can shove units into walls. Then strip the into-wall velocity component, `v -= n·min(0, v·n)`. That gives sliding along walls for free.
- **Wall-aware pushing.** When a pushed unit is against a wall, its effective inverse mass in the push direction should drop to 0, so the push transfers to the mover, which then steers around. The simplest approximation: run the static projection *inside* each contact-solver iteration. The wall then "absorbs" the push and the next iteration re-resolves the pair, with the mover taking the remainder.

**Pushing a unit off its own path.** A pushed idle unit does not need a path. A pushed *moving* unit, which happens rarely because moving-vs-moving pushes are symmetric and soft, may end up off the funnel corridor. Keep the corridor (the list of navmesh polygons) and do a local "corridor fix-up" as in Detour's `dtPathCorridor::movePosition`. If the unit's current polygon is not in the corridor or adjacent to it, request a repath.

**Stuck detection.** Keep a ring buffer of positions sampled every 0.25 s.

- *Stuck* = progress along path < 10 % of expected over 1.5 s, while not arrived and not in combat.
- Response ladder:
  1. Enable "squeeze" mode: allow ~30 % overlap with friendlies and take double push priority for 1 s.
  2. Repath with the blocking *non-pushable* units (holding position, buildings under construction) temporarily stamped as obstacles. Use a cheap local grid A* over a 16×16-cell window, or a navmesh query with dynamic-obstacle cost.
  3. After 3 failed attempts, give up and become idle, with arrival = "best effort". SC2 also just gives up. For example, when a goal is inside a fully walled-off area, units go to the nearest reachable point.
- **Repath triggers:** a building was placed or destroyed whose bounds intersect the corridor; corridor invalid after a push; stuck ladder step 2; a goal that is an entity which moved more than its threshold.

## 5. Formations and group movement

- **Order = group.** Each move command creates a `MoveOrder { id, goal, mode: 'converge' | 'formation', offsets[], speedCap }`. Units hold `orderId`. Many orders coexist; groups are independent.
- **Formation offsets (magic box).** In formation mode, `goal_i = click + clampLen(pos_i − centroid, maxOffset)`. Compute offsets once at order time and freeze them. Path **one** shared route from centroid to click (or use the flow field toward the click). Each unit follows that route with its offset applied *only near the destination*. Mid-route, offsets get squeezed by chokepoints, and applying them would push units into walls. A good blend: `target_i = pathPoint + offset_i · smoothstep(D_far, D_near, distToGoal)`, which converges in narrow terrain and re-expands on arrival. Before assigning, validate each `goal_i` (project it onto the navmesh). If it is unreachable or inside an obstacle, snap it to the nearest valid point, or fall back to converge for that unit.
- **Speed matching.** Optional, toggled per order. Real SC2 does **not** speed-match, so fast units arrive first. A "formation move" toggle is nicer for a demo:
  - `speedCap = min(maxSpeed_i)` across the group.
  - Plus a **catch-up rule**: units behind their formation slot (projected slot distance > 1 radius) get up to `1.2×` cap until they catch up. Units ahead get `0.8×`.
  - Without the catch-up rule, formations drift apart.
- **Leader following.** Avoid a literal leader unit; if it dies or gets blocked, the group breaks. Use a **virtual leader**: a point advancing along the shared path at `speedCap`, which slows down if the average slot error exceeds a threshold. Units steer to `leader + R(leaderHeading)·offset`, or don't rotate the offset if you want SC2's non-rotating boxes. Rotating formations look "Total War"; non-rotating look "SC2". Pick non-rotating by default.
- **Cohesion/alignment.** Keep these weak, around 0.1–0.2× seek, and apply them only among same-order neighbours. Alignment smooths heading jitter in dense blobs; cohesion makes balls. Expose both as sliders.

## 6. Determinism and fixed timestep

- Run the simulation at a **fixed tick**: SC2 runs 16 game ticks per game-second ("normal") and 22.4 per real second on "faster". Use 30 Hz or 32 Hz. Render with interpolation between the last two states (Glenn Fiedler, *Fix Your Timestep!*). At 30 Hz with soft contacts, 2–4 solver iterations suffice. Steering at 30 Hz looks smooth once positions are interpolated and headings are low-pass filtered.
- **Deterministic iteration order.** Iterate units in ascending id. The spatial hash must return neighbours in a deterministic order: insert in id order and don't use JS `Map`/`Set` iteration over ids that may be inserted in a different order. Contact pairs are processed in a fixed order (sorted by `(minId, maxId)`), or use a Jacobi solve (accumulate corrections, then apply), which is order-independent.
- **Jacobi vs Gauss-Seidel.** Gauss-Seidel (apply each correction immediately) converges faster but is order-dependent and biased. It creates directional drift in symmetric blobs, which looks like a slow "swirl". **Use Jacobi with averaging** (divide each unit's accumulated correction by its contact count, times a relaxation factor of ~1.5) and 3–4 iterations. It is deterministic, symmetric, and parallelisable later in a worker or WASM.
- **Floats.** JS numbers are IEEE doubles. They are deterministic on one engine for `+ − × ÷ sqrt`, but `Math.sin/cos/atan2/exp` may differ across browsers. If you ever need lockstep multiplayer or replay files that work across browsers, use fixed-point (Q16.16 in Int32) or avoid transcendental functions (use vector normalisation, not angles). For a single-player demo, double-precision floats plus a seeded RNG (mulberry32) are enough. Never use `Math.random()` in the sim.
- **Symmetry breaking.** Exact head-on equal units deadlock in any method. Add a deterministic tie-break: when `|cross(dir, toOther)| < ε`, always dodge to the right (by convention, based on the lower id). Use the seeded RNG only for initial jitter.
- **Data layout.** Use struct-of-arrays `Float64Array`s (`px, py, vx, vy, r, invMass, ...`) and a uniform grid with cell size ≈ 2× the median diameter, rebuilt every tick with a counting sort. That is O(n), cache-friendly, and handles 5k units in about 1–2 ms in V8.

## 7. Recommended per-tick pipeline

### Unit state and priority

```ts
type MoveState = 'idle' | 'moving' | 'arrived' | 'holding' | 'busy';
// push priority (higher pushes lower; equal = share)
// base = unitType.pushPriority (e.g. worker 10, small 20, medium 30, massive 50)
function effectivePriority(u): number {
  switch (u.state) {
    case 'holding': case 'busy': return Infinity;   // never pushed
    case 'idle': case 'arrived': return u.basePriority - 100; // always pushable by movers
    case 'moving': return u.basePriority + (u.squeeze ? 15 : 0);
  }
}
```

Enemies: no pushing either way. Treat each as `Infinity` for the other side, which means a positional contact with equal share (both are displaced 50/50, so no one is pushed through) plus avoidance. Optionally, enemy pairs only get hard separation, with no avoidance.

### Inverse mass per contact

```ts
function contactWeights(a, b): [number, number] {   // share of correction each takes
  const pa = effectivePriority(a), pb = effectivePriority(b);
  if (pa === Infinity && pb === Infinity) return [0.5, 0.5]; // both "immovable": split (rare; prevents permanent overlap)
  if (pa > pb) return [0, 1];             // a pushes b entirely
  if (pb > pa) return [1, 0];
  // equal priority: mass ratio by area (bigger is heavier)
  const ma = a.r * a.r, mb = b.r * b.r;
  return [mb / (ma + mb), ma / (ma + mb)];
}
```

Use a soft priority instead of the hard 0/1 for moving-vs-moving pairs of different types, e.g. `[0.2, 0.8]`. This keeps a Thor from plowing through marines that are walking with it as if they were idle.

### Pipeline (fixed dt)

```text
1. ORDERS      apply new commands → MoveOrder, magic-box goals, request paths (budgeted, async-able)
2. GRID        rebuild spatial hash (counting sort by cell, id order)
3. PATH FOLLOW for moving units: advance along corridor/flow field → steering target
               compute preferred velocity v_pref (arrive-decel near final goal, speedCap)
4. STEERING    v_des = v_pref
               + w_sep  * separation(same-order & idle neighbours within r_i + r_j + margin)
               + w_avoid* avoidance(first non-pushable unit on time horizon τ)
               + w_ali/w_coh (same-order, weak)
               clamp |v_des| ≤ maxSpeed;  v = v + clamp(v_des − v, maxAccel·dt)   // accel limit kills jitter
               idle units: v *= exp(−dt/τ_damp)
5. INTEGRATE   p_pred = p + v·dt
6. CONTACTS    repeat K=3..4 (Jacobi):
                 for each overlapping pair (d < ra+rb): pen = ra+rb−d
                   [wa,wb] = contactWeights(a,b); corr = n·pen·stiffness(0.8)
                   acc[a] −= wa·corr; acc[b] += wb·corr; cnt[a]++, cnt[b]++
                   if same order & one arrived & other near goal → mark other arrived
                 apply p_pred += ω·acc/cnt  (ω≈1.2–1.5)
                 static projection (segments within r) for every unit touched
7. VELOCITY    v = (p_pred − p)/dt  for idle/pushed units (so pushes carry momentum, then damp)
               moving units: keep steering v but remove the into-wall component; cap |Δp| ≤ maxSpeed·dt·1.5 (no teleporting)
               p = p_pred
8. ARRIVAL     goal-radius test, blocked-progress test → state='arrived', v=0
9. STUCK       sample progress every 0.25s; ladder: squeeze → local repath → give up
10. HEADING    facing = slerp toward v if |v| > ε (turn-rate limited); render-only smoothing
```

### Avoidance term (step 4, the important one)

```ts
// Only avoid units we won't push: higher/equal priority, holding, busy, enemies, or moving against us.
function avoidance(u): Vec2 {
  let best = null, bestT = TAU;            // TAU ≈ 0.75–1.0 s
  for (const o of neighbours(u, u.speed * TAU + u.r + maxR)) {
    if (canPush(u, o)) continue;           // will just shove it
    const t = timeToCollision(u.p, u.v, o.p, o.v, u.r + o.r + PAD);
    if (t >= 0 && t < bestT) { bestT = t; best = o; }
  }
  if (!best) return ZERO;
  // side choice: pick side of `best` closer to path direction; if obstacle edge on that side, flip
  const toO = sub(best.p, u.p), side = sign(cross(u.pathDir, toO)) || tieBreak(u.id, best.id);
  const lateral = perp(normalize(toO), -side);   // steer away
  const urgency = 1 - bestT / TAU;
  return scale(lateral, u.maxSpeed * urgency * urgency);
}
```

**Side hysteresis:** remember `avoidSide` per unit for ~0.5 s and only flip it if the chosen side becomes blocked. This single trick removes most of the "dancing" left-right oscillation.

### Tuning parameters (starting values)

| Param | Value | Notes |
|---|---|---|
| tick | 30 Hz | render-interpolated |
| contact iterations K | 3–4 | 6 for very dense |
| contact stiffness | 0.8 | <1 leaves a small soft overlap, which looks organic |
| relaxation ω | 1.3 | Jacobi over-relaxation |
| allowed overlap (moving friendlies) | 5–10 % of r | skip correction below it, to avoid micro-jitter |
| separation radius margin | 0.25 r | |
| w_sep / w_avoid / w_ali / w_coh | 0.6 / 1.0 / 0.15 / 0.1 | |
| avoidance horizon τ | 0.8 s | |
| side hysteresis | 0.5 s | |
| maxAccel | 4–8 × maxSpeed /s | per unit type; heavy units slower |
| idle damping τ_damp | 0.1 s | snap to 0 below 0.02·r/tick |
| push transfer cap | 1.5 × maxSpeed·dt | pushed units never teleport |
| arrival packing factor | 0.75 | |
| stall window / threshold | 0.5 s / 15 % | |
| stuck window | 1.5 s | squeeze for 1 s |
| magic box cap | ≈ 6 × median diameter | ground; larger for air |

### Pitfalls to avoid

- **Don't let steering separation fight the contact solver.** Separation is a *soft, anticipatory* term with a small margin. Overlap is fixed only by contacts. If you make separation strong, it oscillates with the arrival logic.
- **Don't use idle units in avoidance.** That makes movers swerve around a blob instead of walking through it, which is the opposite of SC2.
- **Don't recompute velocities from positions for moving units.** The post-contact velocity of a mover is noisy. Keep the steered velocity, so headings stay smooth.
- **Don't make arrived units seek their goal.** That is the single biggest cause of destination dancing.
- **Don't let a push move a unit into a wall.** Do the static projection inside the contact iterations, not once after them.

## References

- GDC 2011 AI Summit, *AI Navigation: It's Not a Solved Problem – Yet* (Anhalt, Kring, Sturtevant): https://www.gdcvault.com/play/1014514/AI-Navigation-It-s-Not
- gamedev.net thread summarising the SC2 tech (CDT navmesh, boids, horizon analysis): https://www.gamedev.net/forums/topic/563819-whats-starcraft2s-pathfinding-tech/
- Liquipedia, Magic Boxes: https://liquipedia.net/starcraft/Magic_Boxes ; Basic Unit Commands: https://liquipedia.net/starcraft/Basic_Unit_Commands ; Bugs/mechanics (worker stacking, unstacking pushes): https://liquipedia.net/starcraft/Bugs
- TL.net magic box discussion: https://tl.net/forum/sc2-strategy/145719-zvt-muta-vs-thor
- RVO2 / ORCA library and paper (van den Berg et al., *Reciprocal n-Body Collision Avoidance*, ISRR 2009): https://gamma.cs.unc.edu/RVO2/ ; ORCA: https://gamma.cs.unc.edu/ORCA/
- HRVO (Snape et al., IEEE T-RO 2011): https://gamma.cs.unc.edu/HRVO/
- Comparative study of VO methods (deadlock in symmetric scenarios, ORCA scalability): https://eprints.whiterose.ac.uk/135915/1/UKACC18_0133_FI.pdf
- RRVO (deadlocks of reciprocal VOs with large agents): https://parasollab.web.illinois.edu/research/rrvo/
- Reynolds, *Steering Behaviors for Autonomous Characters* (GDC 1999): https://www.red3d.com/cwr/steer/
- Karamouzas, Skinner, Guy, *Universal Power Law Governing Pedestrian Interactions* (PRL 2014, time-to-collision avoidance): https://motion.cs.umn.edu/PowerLaw/
- Weiss et al., *Position-Based Multi-Agent Dynamics for Real-Time Crowd Simulation* (MIG 2017): https://arxiv.org/abs/1802.02673
- Müller et al., *Position Based Dynamics* (2007): https://matthias-research.github.io/pages/publications/posBasedDyn.pdf
- Emerson, *Crowd Pathfinding and Steering Using Flow Field Tiles* (Game AI Pro, Supreme Commander 2): https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter23_Crowd_Pathfinding_and_Steering_Using_Flow_Field_Tiles.pdf
- Recast/Detour (DetourCrowd, `dtPathCorridor` fix-up, obstacle avoidance): https://github.com/recastnavigation/recastnavigation
- 0 A.D. unit pushing commit (idle/moving push rules in an open-source RTS): https://code.wildfiregames.com/rP25182
- Glenn Fiedler, *Fix Your Timestep!*: https://gafferongames.com/post/fix_your_timestep/
