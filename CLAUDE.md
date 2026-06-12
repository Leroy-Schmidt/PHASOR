# PHASOR — agent constitution
You are implementing DESIGN.md. It is the spec; do not redesign it.

Invariants:
- No build step. Plain ES modules; pinned CDN import map. Code must run via a static server.
- src/{grid,fem,solver,physics}.mjs stay DOM-free and runnable under `node --test`.
- No time integration in the solver. Time-harmonic only. Convention e^{+iωt}; SI units.
- Tests are law. Never weaken a tolerance, skip a gate, or mark a test todo without
  the Operator saying so in this session.
- Before claiming a milestone done: run `node --test`, paste the summary, and list
  which DESIGN.md gates it covers. Update VALIDATION.md.
- Write tests for a gate BEFORE the feature where feasible.
- One milestone per session. If asked to continue mid-milestone, first read
  VALIDATION.md and `git log --oneline -10` to recover state.
- Read OPERATOR_NOTES.md and follow its §3 "Scope watch" convention: one gentle
  flag for out-of-scope / later-milestone / sloped-geometry requests, offer
  proceed / park in BACKLOG.md / stay on track, then respect the choice silently.

## Scope watch
If the Operator requests work that (a) appears in DESIGN.md §1 "out of scope",
(b) belongs to a later milestone than the current one, or (c) involves sloped /
non-axis-aligned geometry, give exactly ONE gentle flag before proceeding, e.g.:

  "Heads up: this is outside the current milestone (see OPERATOR_NOTES §2 —
   sloped surfaces staircase, with a non-vanishing Robin-BC area error).
   Want me to proceed anyway, park it in BACKLOG.md, or stay on Mn?"

Rules: one sentence of flag plus the three options, once per topic per session —
never repeat the warning for the same topic, never refuse, never lecture. If the
Operator says proceed, proceed without further comment and add a one-line note
to VALIDATION.md that the work was off-script. Maintain BACKLOG.md as the
parking lot so good ideas are captured instead of argued with.

## Decisions fixed in M0
- Node indexing: `idx = i + (nx+1)*(j + (ny+1)*k)`; cell indexing:
  `idx = i + nx*(j + ny*k)`. i ↔ x, j ↔ y, k ↔ z, fastest first.
- Lengths in metres everywhere; materials referenced by string id, painted as
  small-integer indices into the model's material list.
- Grid ticks include every box face coordinate exactly (Appendix A.1); grading is
  geometric within each interval, ratio ≤ 1.3, toward declared refinement points.

## Decisions fixed in M1
- ψ-value reference lengths use **external dimensions** (außenmaßbezogen,
  DIN 4108 Bbl 2 convention) — Operator decision 2026-06-13. State the
  convention next to every ψ on screen and in exports.
- Complex fields (M2+) stored as **separate** `re`/`im` Float64Arrays, never
  interleaved (DESIGN §3.4 left the choice open; fixed here).
- Background-material cells ("air") are void: excluded from the FEM domain.
  Inactive and Dirichlet nodes are handled by identity rows in the matrix-free
  apply (Dirichlet eliminated from the load), which keeps the operator SPD.
- f_Rsi readout always comes from a dedicated solve with R_si = 0.25 m²K/W
  (DIN 4108-2), independent of the display solve's editable R_si = 0.13.
