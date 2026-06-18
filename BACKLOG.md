# PHASOR — Backlog (parking lot)

Good ideas that are out of scope or belong to a later milestone land here
instead of being argued with. One line each, date + idea.

- 2026-06-12 — Mesh quality (M1+): corner2d grading refines along each axis
  toward the inner corner, but cells along the outer→inner corner *diagonal*
  stay relatively coarse — exactly where the re-entrant cold spot / isotherm
  crowding lives. Don't tune blind; verify against G1.2 (O(h²)), G1.5 (f_Rsi
  monotonic), G2.1 once the solver exists, then refine the grading if needed.
- 2026-06-16 — Basement steady ground heat loss (M3): the *total* steady flux to
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
- 2026-06-18 — Phase-lag colormap (M4 polish): on `basement` the τ map spans
  0–365 d because deep nodes (|T̂|→0 at the Dirichlet) have ill-defined, wrapping
  phase, which blows out the color scale and hides the meaningful near-surface
  gradient. Mask/ξ-clamp low-amplitude nodes (e.g. |T̂| < ε of the surface amp)
  in the phase map. The line probe — the G3.2 instrument — is unaffected.
- 2026-06-18 — UX: **sliders feel dead** (Operator feedback; M4 "interaction"
  milestone). Three causes: (1) geometry changes need a manual **Solve** press →
  pull M4 auto-resolve forward (solve on lil-gui `onFinishChange`); (2)
  **Insulation [m]** is a no-op on `basement`/`soil_rod` (no insulation) and on
  `slab_junction` (ignores `layers`) — hide/disable controls that don't apply to
  the active preset, or wire insulation to `slab_junction`'s eps; (3) **Clip**
  only moves the 3D view and **Slice z** barely moves on thin extruded presets —
  label/scope per preset.
- 2026-06-18 — **Field colors ON the 3D model** (Operator ask; M4): today the
  heatmap lives on the flat 2D side-panels. Render the T / amplitude / phase
  field onto the three.js geometry (vertex colors or an in-scene slice-plane
  texture). This is DESIGN §6 M4 "in-scene slice planes."
- 2026-06-18 — **Genuinely volumetric 3D basement** (Operator ask; new preset,
  beyond M3's 2D-extruded ψ presets): a real cellar with a finite room + corners
  in a full 3D soil block. Engine/grid/painter are already 3D — main risk is grid
  size / solve time (≥ 3·δ each way in three dimensions is large) → needs perf
  care (M5 WASM/WebGPU matvec is the escape hatch). The thin-slice presets are
  the fast 2D path for thermal-bridge numbers; this is the showcase version.
- 2026-06-18 — `slab_junction` is the **aggressive flush, fully-exposed** slab
  (ψ≈1.0 W/(m·K), balcony-class). To match a milder "intermediate-floor,
  interrupted-insulation" catalogue figure (~0.5–0.7), recess the slab behind the
  eps or add an edge-insulation strip. Optional; G3.3 passed as-is.
- 2026-06-12 — Watch: orbit-rotate occasionally stalled with a `not-allowed`
  cursor. Applied preventive CSS (`user-select:none` on #view, `touch-action:none`
  + `-webkit-user-drag:none` on the canvas). If it resurfaces, suspect a
  pointer-capture / OrbitControls version issue.
