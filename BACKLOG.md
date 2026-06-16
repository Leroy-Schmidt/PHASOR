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
- 2026-06-12 — Watch: orbit-rotate occasionally stalled with a `not-allowed`
  cursor. Applied preventive CSS (`user-select:none` on #view, `touch-action:none`
  + `-webkit-user-drag:none` on the canvas). If it resurfaces, suspect a
  pointer-capture / OrbitControls version issue.
