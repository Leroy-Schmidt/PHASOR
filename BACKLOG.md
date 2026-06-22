# PHASOR — Backlog (parking lot)

Good ideas that are out of scope or belong to a later milestone land here
instead of being argued with. One line each, date + idea.

**Priority layer: see `ROADMAP.md`.** Items promoted to a Stage-2 milestone are
tagged `→ ROADMAP S2-Mx` below; everything else is still raw parking lot. This
keeps the backlog from rotting into a dumping ground — `ROADMAP.md` is the
sequenced, gated plan; this file is the unsorted pool it draws from.

- 2026-06-12 — Mesh quality (M1+): corner2d grading refines along each axis
  toward the inner corner, but cells along the outer→inner corner *diagonal*
  stay relatively coarse — exactly where the re-entrant cold spot / isotherm
  crowding lives. Don't tune blind; verify against G1.2 (O(h²)), G1.5 (f_Rsi
  monotonic), G2.1 once the solver exists, then refine the grading if needed.
- 2026-06-16 — **→ ROADMAP S2-M1** (prerequisite, promoted 2026-06-19). Basement steady ground heat loss (M3): the *total* steady flux to
  the deep T_mean Dirichlet is long-range (a fixed-temperature sink, not a far
  field) — full domain-doubling moves it ~2.5 %, converging only ~1/depth. G3.1
  certifies the domain on the δ-governed periodic quantities (annual amplitude /
  flux < 0.1 %) + the lateral steady flux (< 0.3 %) instead. If a precise
  *steady* ground-loss U-value is ever needed (ISO 13370 territory), revisit the
  deep boundary (place it much deeper, or use an ISO-13370 characteristic
  correction). Out of scope for M3.
- 2026-06-16 — Basement annual amplitude vs the pure semi-infinite e^{−y/δ}: the
  finite deep Dirichlet (T̂=0) biases the decay ~15 % low even at a fine grid
  (it's physical, not discretization). G3.2 is therefore pinned on the phase
  *lag* (the September timing, robust). If a quantitative amplitude-decay readout
  is wanted, sample well above the bottom or model deeper.
- 2026-06-18 — **Phase-lag map is correct but unintuitive** — **DONE M4** (fixed
  this session: `timeLagRelative` referenced to the outdoor forcing → surface ≈ 0,
  + low-amplitude mask kills the deep-node noise; verified corner2d annual/diurnal
  + basement annual; covers both causes below). Kept for the record. TWO causes,
  confirmed on corner2d/annual:
  (1) **Absolute reference.** τ = −arg(T̂)/ω is measured from midnight Jan 1, not
  from the outdoor signal. The climate peaks ~197.6 d after Jan 1, so the exterior
  *surface* — which is perfectly in sync with the forcing — reads **197.6 d**, not
  the 0 d a physicist expects. Fix: display lag **relative to the exterior forcing
  phase** (subtract the climate harmonic's own arg), so the surface → ~0 and the
  interior shows the genuine extra delay (corner ~2 d; basement ~2-month September
  story). (2) **Low-amplitude phase noise.** Where the interior is held constant
  (corner2d, basement) deep nodes have |T̂|→0 and wrapping/garbage phase that blows
  out the 0–365 d color scale and hides the near-surface gradient. Mask/clamp nodes
  with |T̂| < ε·(max amp) in the phase map. The line probe (G3.2 instrument) and the
  amplitude / T(t) maps are unaffected. Small, contained fix in viz2d/lineprobe.
- 2026-06-18 — **Play/pause continuous time scroll** (Operator QoL ask, M4+) —
  **DONE 2026-06-19** (polish D2, `b2faa82`): ▶/⏸ button drives a rAF loop over
  the solve-free scrub path (`advanceFraction` in `src/scrub.mjs`); stops on pause
  / manual drag. Smooth-animation heartbeat is the Operator's visual gate.
- 2026-06-18 — UX: **sliders feel dead** (Operator feedback; M4) — **DONE M4**:
  (1) Solve button retired, geometry changes auto-resolve in the Worker
  (`onChange` previews geometry, `onFinishChange` fires one solve); (2)
  **Insulation [m]** now hidden on presets that ignore it (basement/soil_rod/
  slab_junction), shown on wall1d/corner2d; (3) **Slice z** hidden when the
  geometry is z-uniform (all current presets) — re-appears for a true-3D preset.
  Clip stays (it visibly clips the voxels).
- 2026-06-18 — **Field colors ON the 3D model** (Operator ask; M4) — **DONE M4**:
  `Viz3D.setFieldSlice` paints an in-scene XY slice plane (DataTexture) mirroring
  the 2D panel's field/range/colormap; breathes with the scrubber. DESIGN §6
  "in-scene slice planes." (Vertex-coloring the voxels remains a possible future
  alternative if a fuller volumetric paint is ever wanted.)
- 2026-06-18 — **Genuinely volumetric 3D basement** — **DONE M5** (`basement3d`
  preset, quarter-symmetry cellar with a real 3D wall–wall + trihedral corner; 3
  gates green, Slice-z + in-scene field plane light up for free). A real cellar
  with a finite room + corners in a full 3D soil block. Engine/grid/painter were
  already 3D — the risk was grid size / solve time, and it bit: see next item.
- 2026-06-18 — **→ ROADMAP S2-M2** (promoted 2026-06-19; now "Performance", preconditioner-first). **M5 #2: WASM-SIMD / WebGPU matvec** (the escape hatch, NOT chained
  into the `basement3d` session — one M5 item per session). Motivating use case
  now exists and is measured: `basement3d` at the **fine** maxH 0.5 grid (30×32×30
  = 31.7 k nodes) takes **18.2 s** isolated, OVER the 5 s budget — the steady
  ground-loss solve dominates (~11.5 s / 287 CG it, a long-range deep-Dirichlet
  sink). The shipped default coarsens to maxH 0.8 (14.4 k nodes, 4.7 s) to stay
  interactive. To run the fine field interactively, port the matrix-free element
  apply (`applyA` / `applyAComplex`, already deduplicated — chosen in M0 to port
  cleanly) to WASM-SIMD or a WebGPU compute matvec. DESIGN §3.5 trigger met
  ("only if a real use case exceeds the budget"). Measure isolated, not in
  `node --test`. A whole M5 session on its own.
- 2026-06-18 — `slab_junction` is the **aggressive flush, fully-exposed** slab
  (ψ≈1.0 W/(m·K), balcony-class). To match a milder "intermediate-floor,
  interrupted-insulation" catalogue figure (~0.5–0.7), recess the slab behind the
  eps or add an edge-insulation strip. Optional; G3.3 passed as-is.
- 2026-06-19 — **Acoustics fork — reuse map** (stretch; brainstorm note, NOT M-scope).
  The codebase is, at its core, a Helmholtz/Laplace FEM engine on a rectilinear
  grid; room acoustics is a plausible second tenant. Decision: **fork and copy,
  let duplication hurt, extract a shared core only once the seams are proven** —
  do NOT build a generic multiphysics framework up front.
  REUSE (carries over near-directly): `grid.mjs` (rectilinear grid + grading +
  box painting); the matrix-free **apply-as-a-function seam** (solver takes
  `apply`); **COCG** (driven Helmholtz is complex-symmetric, same form as the
  thermal harmonic solve); element assembly for **K** (Laplacian = acoustic
  stiffness) and **C↔M** (capacity matrix is structurally the mass matrix);
  **Robin BC** machinery (acoustic impedance / radiation BCs are Robin-like); the
  whole **test/perf-harness + VALIDATION/gates discipline**.
  NEW (must build): an **eigensolver** (Lanczos / LOBPCG) — room modes are
  Kφ=λMφ, an eigenproblem, not a linear solve, genuinely new; a new **physics
  layer** (materials: density ρ + sound speed c instead of λ/ρc; dispersion k=ω/c);
  new **readouts** (SPL, insertion loss, mode shapes, resonator coupling).
  LEAVE OUT (as important as what goes in): the thermal standards layer
  (13370/12831/f_Rsi/4108) — domain-specific, don't drag it along; thermal
  vocabulary/units; and the assumption that the solver stack transfers wholesale
  — the eigen path is a new beast the current COCG-only stack doesn't cover.
- 2026-06-22 — **Viz UX rework (Operator flag, details pending).** The Operator
  flagged that "the view" doesn't do what users will like / expect — to revisit
  after M1. Details to come; likely touches the field-mode presentation
  (T(t)/swing/amplitude/phase/flux) and/or the panel layout. Capture the specifics
  when given, then scope against S2-M4 (UI / self-explanatory).
- 2026-06-12 — Watch: orbit-rotate occasionally stalled with a `not-allowed`
  cursor. Applied preventive CSS (`user-select:none` on #view, `touch-action:none`
  + `-webkit-user-drag:none` on the canvas). If it resurfaces, suspect a
  pointer-capture / OrbitControls version issue.
