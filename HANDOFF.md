# PHASOR — session kickoff: S2-M1.4 annual heat-loss curve (earth vs. air)

Read `ROADMAP.md` (the Stage-2 plan — priority layer above BACKLOG), CLAUDE.md,
VALIDATION.md (tail), and `git log --oneline -8`. **Stage 1 (M0–M5) is sealed.**
Stage 2 is the teaching + validation build (ROADMAP), one hard constraint:
maximize the odds of a working app while keeping Operator involvement low — so
almost everything is gated headlessly and the Operator only signs pre-built proofs.

## State you're inheriting (S2-M1.3 done, 2026-06-22)
- **S2-M1.2 — heat-flow viz DONE** (committed `a7bdac4`): `flux` heat ramp +
  `fluxGlyphs` (gates G1.2a/b), SlicePanel `'flux'` mode (|q| on the solve-free
  scrub path, 99th-pct-of-steady scale, glyph overlay), and **`tools/proof.mjs`**
  (the reusable Stage-2 proof harness). Sheet: `proofs/s2-m1.2/`.
- **S2-M1.3 — harmonic-only view DONE** (this session): SlicePanel `'swing'` mode
  ("Harmonic swing Δθ(t)") — single-frequency AC deviation Δθ(t)=Re[T̂_ω e^{iωt}],
  steady field removed, diverging map, fixed symmetric ±|T̂|max, breathes with the
  scrubber. Gate **S2-G1.3** (`test/harmonic-only.test.mjs`): the diurnal swing
  dies in the wall → interior |T̂| < 1 % of peak (DC-leak detector). Sheet:
  `proofs/s2-m1.3/`; new harness assertion `assertSignFlip`.
- `node --test`: **110/110**. `MIN_TESTS` 110.
- **Not pushed/tagged.** M1.2 is committed (`a7bdac4`); M1.3 commit is the last one
  on `main` (`git push` blocked for the agent — Operator pushes/tags).
- **S2-H1.2 (human) still reserved:** Operator glances at `proofs/s2-m1.2/` +
  `proofs/s2-m1.3/` sheets + the live 3D-WebGL view (ROADMAP touchpoint 2). Heads-up
  the one taste knob is heat-flow glyph density (`GLYPH_TARGET` in viz2d.mjs).

## Driving the proof harness (learned this session)
- The agent runs the capture snippet via `preview_eval`. **Read pixels after a
  rAF wait** (`requestAnimationFrame` ×2) or `getImageData` sees an unpainted
  canvas (n=0). Drive `window.__phasor` = `{ viz, slices, probe, loadPreset, solve,
  ui }`; settle a solve by polling `slices.mean != null && /^solved/.test(#status)`.
- The PNG dataURL exceeds the inline limit → **save it to a file** by returning
  `canvas.toDataURL()+'!!!PAD!!!'+'A'.repeat(120000)` (forces the tool to dump to a
  tool-results file); decode in node (slice `data:image/png;base64,…` to `!!!PAD!!!`).
- **No `python` on PATH** — use node for base64/decoding.

## ⚠ Still-open item: the G2.5 wall-clock flake
The G2.5 gate (48³ COCG < 10 s) flakes at its boundary under load (9.96–10.25 s)
and intermittently fails the pre-commit hook. **Not a regression** (solver
untouched). `node --test` is green on a light run; if a commit's hook trips,
**retry on a quiet machine** (stop the preview server first — it adds load). Per
CLAUDE.md the 10 s budget is a tolerance: **do not change/skip it without Operator
sign-off.** The real fix is S2-M2 (performance) — pure-JS preconditioner first.

## Your job this session: S2-M1.4 — annual heat-loss curve, earth vs. air
Integrate the envelope heat flux across the year by **superposition (no
re-solve)** and chart it. "Air case" = the basement with the soil deleted /
replaced by an exterior-air Robin BC. Use the chart-with-gap idiom (the bundled
Trittschall app's measured-vs-reference chart is the reference pattern).
- **Gate FIRST — S2-G1.4a (auto):** the reconstructed annual loss curve ==
  direct superposition to solver tol (two ways to the same number).
- **S2-G1.4b (auto):** the air-case solves, and its annual-mean loss **>** the
  earth case (correct sign — earth damps/insulates).
- The flux integral already lives in `flux.mjs` (`regionFlux`, gated G1.1d). The
  worker likely needs to expose an **air-case solve** (soil→air Robin); see
  ROADMAP S2-M1 "Touched" list (`worker.mjs`, `ui.mjs`).
- **Proof:** run `tools/proof.mjs`, write `proofs/s2-m1.4/`; batch the human
  glance with S2-H1.2.

## Standing rules (don't relearn the hard way)
- **Gates before features; tolerances are law.** Write the gate first. **Run
  `node tools/guardrails.mjs` before claiming green and before every commit** — it
  is the pre-commit hook. Never set `GUARDRAILS_ALLOW_TOL_CHANGE` without Operator
  sign-off this session. Raise `MIN_TESTS` when you add gates.
- **One subgoal per session**, `node --test` green + committed between.
- **2D = agent-verifiable (canvas pixels via proof.mjs); 3D WebGL = human channel.**
- **Scope watch:** one gentle flag for out-of-scope / sloped / later-milestone work
  (custom geometry stays box-based — DESIGN §1), then respect the choice; park in
  BACKLOG.md. (M2 was floated 2026-06-22, then deferred — finish S2-M1 first.)
- **Windows:** node on PATH (no `python`); `git push origin main` blocked for the
  agent — Operator pushes/tags.

## Open question (resolve before S2-M1.5)
Where do the 13370/12831 closed forms live? Leaning **(a)** a pure
`src/standards.mjs` inside PHASOR (keeps the 13370-annex calibration gate inside
`node --test`); (b) only in the Explainer app via the JSON seam. Confirm with the
Operator before building the comparison panel.
