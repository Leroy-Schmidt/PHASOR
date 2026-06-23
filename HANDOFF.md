# PHASOR — session kickoff: S2-M1 closed; next is perf (S2-M2) or the general-tool track

Read `ROADMAP.md` (Stage-2 plan + the new **general-tool vision** section),
CLAUDE.md, VALIDATION.md (tail), and `git log --oneline -10`. **Stage 1 (M0–M5)
is sealed.** Stage 2 keeps Operator involvement low: gate headlessly, sign
pre-built proofs.

## State you're inheriting (S2-M1 substantially complete, 2026-06-23)
- **S2-M1 done** (committed on `main`): M1.1 flux field · M1.2 heat-flow viz +
  `tools/proof.mjs` · M1.3 harmonic-only swing · M1.4 annual loss curve (earth vs
  air) · **M1.5 part 1** `src/standards.mjs` + 13370 calibration gate · **M1.6**
  export seam · plus the **3D cutting-plane view rework**.
- `node --test`: **124/124.** `MIN_TESTS` 124. Recent commits: view rework
  `5879777`, standards `12eb0a9`, loss curve `6ed9943`.
- **Not pushed/tagged.** Operator pushes `main` + tags **`s2-m1-pass`** after the
  S2-H1.2 proof-sheet glance (sheets: `proofs/s2-m1.{2,3,4}/`).

## ⚠ Parked (Operator decisions — don't silently revive)
- **M1.5 part 2: 13370-vs-PHASOR comparison panel + steady-baseline pinning.**
  Parked 2026-06-23. The loose cross-method bit (13370 ≈ 36.5 vs PHASOR ≈ 49.9 W/m,
  ratio 0.73; the gap *is* the steady pinning task — deepen the deep-Dirichlet
  boundary / ISO-13370 correction). `standards.mjs` + the calibration gate already
  exist; this is the comparison *view* + the pinning. Best done on the reworked 3D.
- **Viz polish (BACKLOG 2026-06-23):** 3D flux arrows too small (bump
  `viz3d._rebuildArrows` `L`/`MIN_LEN` + a size control); steady-vs-component
  separation (a "steady only" field/flux view). Folds into S2-M4 / general-tool.

## Two candidate next directions (Operator's call)
The Operator asked how far to a **general-purpose axis-aligned f_Rsi/ψ tool** — see
ROADMAP "The general-tool vision". Key finding: **the engine is already there**
(f_Rsi is geometry-agnostic; the solver does arbitrary axis-aligned boxes). The
gap is authoring + ψ-automation + trust, not physics. Likely next:
1. **S2-M2 Performance** — the Operator is straining on `basement3d` (quarter-
   symmetry, ~287-iter steady ground solve) and wants 5–10×. **Preconditioner-
   first / pure-JS-first** (multigrid V-cycle in `solver.mjs` via a `precond(r,z)`
   hook; Jacobi-CG stays the certified fallback) — the iteration-bound steady solve
   is the bottleneck, so a preconditioner is the bigger, **buildless**, safer lever
   than WebGPU/WASM (which is the second lever, *with profiling numbers first*).
   Gates G-A…G-P in ROADMAP; `tools/perf.mjs` measures isolated (never in
   `node --test`). Prereq for interactive 3D details.
2. **General-tool authoring (S2-M3)** — define constructions without editing
   `model.mjs`: JSON load/validate (cheap; presets *are* the JSON) → 2D
   cross-section editor + click-a-face BC assignment (the fiddly part) → **auto-ψ**
   from picked surfaces (BACKLOG; removes hardcoded `psiSpec`) → material editor →
   trust guardrails (grid-convergence + flux-balance + staircasing warning).

## Standing rules
- Gates before features; tolerances are law; raise `MIN_TESTS` when adding gates.
  Run `node tools/guardrails.mjs` before claiming green / committing (pre-commit
  hook). **Never** set `GUARDRAILS_ALLOW_TOL_CHANGE` without Operator sign-off this
  session (one rename override was authorized 2026-06-23 for the view rework).
- One subgoal per session, `node --test` + guardrails green + commit between.
- **G2.5 wall-clock flake** (48³ < 10 s) trips the hook under load — not a
  regression; run guardrails in the **foreground** on a quiet machine, retry; never
  run the suite in the background (it gets starved, seen at 525 s). The real fix is
  S2-M2.
- 2D = agent-verifiable (canvas pixels via proof.mjs); **3D WebGL = human channel**
  — but you can `toDataURL` the renderer canvas (preserveDrawingBuffer) + decode in
  node to eyeball it yourself (used in the view rework).
- Windows: node on PATH; `pdftotext` is at `/mingw64/bin` (norm PDFs in `norms/`,
  gitignored — IP); no `python` (use node for base64/decode). `git push origin main`
  blocked for the agent — Operator pushes/tags.
