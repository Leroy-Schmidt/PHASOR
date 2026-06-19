# PHASOR — session kickoff: S2-M1.2 heat-flow visualization

Read `ROADMAP.md` (the Stage-2 plan — it's the priority layer above BACKLOG),
CLAUDE.md, VALIDATION.md (tail), and `git log --oneline -8`. **Stage 1 (M0–M5) is
sealed.** Stage 2 is the teaching + validation build, governed by ROADMAP.md, with
one hard constraint: maximize the odds of a working app while keeping Operator
involvement low — so almost everything is gated headlessly and the Operator only
signs pre-built proofs.

## State you're inheriting (Stage-2 kickoff session, 2026-06-19)
- **ROADMAP.md written** — approved detailed Stage-2 plan: S2-M1 (flux & heat-loss
  story, the hero) → S2-M2 (performance) → S2-M3 (box-based custom geometry) →
  S2-M4 (UI) → S2-M5 (Wärmebrücken detail catalogue, stretch). Track T1 = a
  separate Norm-Explainer app. Per-milestone gates + forecasts are in there.
- **S2-M1.1 DONE** (`7c6a766`): new `src/flux.mjs` — the heat-flux field, the
  single source of truth for the heat-flow viz AND the annual-loss curve:
  - `cellFlux(problem, T)` → `{qx,qy,qz,nx,ny,nz}` cell-centre q = −λ∇T (real).
  - `cellFluxComplex(problem, Tre, Tim)` → re/im flux phasor q̂ = −λ∇T̂.
  - `regionFlux(problem, q, region)` → envelope integral; equals `boundaryFlux`
    (fem.mjs) on the exact `wall1d` solution (the independent-oracle gate G1.1d).
  - Recovery = trilinear gradient at the cell centre = face-mean difference per
    axis; exact for linear fields. One additive `fem.mjs` line: `face.cell`.
  - Gates G1.1a/b/d/e green (`test/flux.test.mjs`, written gate-first).
- **Process guardrails BAKED + ENFORCED** (`f420b2f`, `2e7dab0`): the Operator's
  review checks are now machinery —
  - `test/golden.test.mjs` pins steady readouts (f_Rsi/ψ/Φ, 4 presets) at rel 1e-6
    → a "no-op" change that moves physics fails the suite (#5).
  - `tools/guardrails.mjs`: `node --test` must show fail/skipped/todo = 0 and
    count ≥ **103**; then blocks any removed/loosened tolerance line in
    `test/`+`src/` unless `GUARDRAILS_ALLOW_TOL_CHANGE=1` (Operator sign-off ONLY)
    (#4 + #3). Dogfooded (loosen 1e-7→1e-3 → blocked).
  - Wired as `.githooks/pre-commit` (active via `git config core.hooksPath
    .githooks`; re-run that once on a fresh clone). Rule is in CLAUDE.md invariants.
- `node --test`: **103 pass, 0 fail, 0 skipped, 0 todo.**
- **Not pushed/tagged.** All four commits are local on `main` (`git push` blocked
  for the agent — the Operator pushes/tags). Recent: `2e7dab0` LF pin, `f420b2f`
  guardrails, `7c6a766` flux, `0a724fd` roadmap+backlog.

## Your job this session: S2-M1.2 — heat-flow visualization (the early-priority crowd-pleaser)
The flux field exists and is gated; now make it visible. Two steps, in order:

1. **`tools/proof.mjs` FIRST** (the reusable verification harness — biggest
   leverage, gates this viz and every later one). It should: boot the dev server
   (`tools/devserver.mjs` on :8123; `preview_start phasor`), drive the app to fixed
   states, capture the **2D panel** via `canvas.toBlob` + `preview_eval`, scrape
   the on-screen readouts to JSON, run pixel assertions, and write
   `proofs/s2-mX/` (PNGs + a one-page `index.html`) for the Operator to sign.
   Why the 2D panel: it's plain `<canvas>` so the agent can read its pixels;
   `viz3d.mjs` is WebGL and CANNOT be screenshotted here (lean on Operator's eyes).
2. **Heat-flow rendering in `viz2d.mjs`**: (a) dynamic **|q| magnitude colormap**
   driven by the existing solve-free scrub path (`scrub.mjs`, never re-solves —
   DESIGN §3.5); (b) a **vector-glyph / streamline** layer toggle. Put the glyph
   LAYOUT generator in `flux.mjs` (pure → unit-tested), render in viz2d.

### Gates to write FIRST (S2-M1.2)
- **G1.2a (auto):** colormap value→RGB unit-tested (extend `colormap.mjs`).
- **G1.2b (auto):** glyph generator — direction == normalized −∇T, length ∝
  clamped |q|, count == sampling stride — tested against the flux array.
- **G1.2c (agent-visual, via `proof.mjs`):** `toBlob` pixel assertions — the
  high-|q| band at the thermal bridge is brighter than the field interior; the
  glyph layer is non-empty over the envelope. (No human.)
- **S2-H1.2 (human, batched):** Operator glances at the proof sheet — "looks like
  heat flowing around the corner" + the 3D-WebGL view. (ROADMAP touchpoint 2.)

## Standing rules (don't relearn the hard way)
- **Gates before features; tolerances are law.** Write the gate first. **Run
  `node tools/guardrails.mjs` before claiming green and before every commit** — it
  is the pre-commit hook now. Never set `GUARDRAILS_ALLOW_TOL_CHANGE` without the
  Operator's sign-off this session. Raise `MIN_TESTS` when you add gates.
- **One subgoal per session**, `node --test` green + committed between.
- **2D = agent-verifiable (toBlob pixels); 3D WebGL = human channel.** Don't try to
  screenshot WebGL here.
- **Performance (S2-M2) is still open**, deliberately deferred behind M1 (it's the
  prereq for M3, not M1). Tier-0 baseline is captured in BACKLOG/VALIDATION: fine
  `basement3d` (maxH 0.5, 31.7 k nodes) ~19–21 s, two steady solves dominate at 287
  CG iters — preconditioner-first (multigrid V-cycle; Jacobi-CG stays the certified
  fallback). Don't chain it into M1. Measure isolated via `tools/perf.mjs`.
- **Scope watch:** one gentle flag for out-of-scope / sloped / later-milestone work
  (custom geometry stays **box-based** — DESIGN §1 forbids CAD/STL/unstructured),
  then respect the choice; park ideas in BACKLOG.md.
- **Windows:** node on PATH; `git push origin main` blocked for the agent —
  Operator pushes/tags. Copyrighted norm PDFs (`norms/`) and the Trittschall
  explainer app are gitignored — keep them out of git (IP bright line).

## Open question to resolve before S2-M1.5
Where do the 13370/12831 closed-form formulas live? Leaning **(a)** a pure
`src/standards.mjs` inside PHASOR (keeps the "reproduce the 13370 annex" calibration
gate inside `node --test`); (b) only in the Explainer app via the JSON seam.
Confirm with the Operator before building the comparison panel.
