# PHASOR — Backlog (parking lot)

Good ideas that are out of scope or belong to a later milestone land here
instead of being argued with. One line each, date + idea.

- 2026-06-12 — Mesh quality (M1+): corner2d grading refines along each axis
  toward the inner corner, but cells along the outer→inner corner *diagonal*
  stay relatively coarse — exactly where the re-entrant cold spot / isotherm
  crowding lives. Don't tune blind; verify against G1.2 (O(h²)), G1.5 (f_Rsi
  monotonic), G2.1 once the solver exists, then refine the grading if needed.
- 2026-06-12 — Watch: orbit-rotate occasionally stalled with a `not-allowed`
  cursor. Applied preventive CSS (`user-select:none` on #view, `touch-action:none`
  + `-webkit-user-drag:none` on the canvas). If it resurfaces, suspect a
  pointer-capture / OrbitControls version issue.
