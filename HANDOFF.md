# PHASOR — session kickoff: S2-M1.5 comparison + "validate the standard"

Read `ROADMAP.md` (Stage-2 plan, priority layer above BACKLOG), CLAUDE.md,
VALIDATION.md (tail), and `git log --oneline -8`. **Stage 1 (M0–M5) is sealed.**
Stage 2 keeps Operator involvement low: gate headlessly, sign pre-built proofs.

## State you're inheriting (S2-M1.4 done, 2026-06-22)
- **S2-M1.2/M1.3/M1.4 done** (committed): heat-flow viz + `tools/proof.mjs`;
  harmonic-swing view; **annual heat-loss curve (earth vs air)**.
- **S2-M1.4 deliverables:**
  - `src/losscurve.mjs` (pure, DOM-free): `regionFluxReal`, `regionFluxPhasor`,
    `lossCurveSamples`, `lossAt` — the envelope-loss integral by superposition
    over flux.mjs. Gates **S2-G1.4a** (reconstruction == direct, rel < 1e-7) /
    **S2-G1.4b** (air mean loss > earth) in `test/losscurve.test.mjs`.
  - New preset **`basement_air`** (`model.mjs`): the same cellar standing in air
    (soil removed, outer faces on the air film). Same interior area as `basement`
    → fair comparison.
  - `worker.mjs` ships `loss:{earth,air}` (region-flux phasors; air only for
    `basement`, via `computeLoss`) — computed **before** the Tre/Tim buffers are
    transferred. New 3rd panel `src/lossview.mjs` (`LossView`) — earth-vs-air with
    the gap shaded; on `window.__phasor.loss`.
  - **Headline numbers:** earth mean loss **9.98 W**, air **40.85 W** →
    **earth/air = 0.24** (soil cuts annual-mean loss to 24 %); earth annual swing
    5.7 W vs air 37 W (soil damps); curves cross in summer (the ~2-month lag).
- `node --test`: **112/112**. `MIN_TESTS` 112. Proof sheets: `proofs/s2-m1.2/`,
  `proofs/s2-m1.3/`, `proofs/s2-m1.4/`.
- **Not pushed/tagged.** Last commit (M1.4) is HEAD on `main` (`git push` blocked
  for the agent — Operator pushes/tags). **S2-H1.2 (human) reserved:** Operator
  glances at the three proof sheets + the live 3D view (ROADMAP touchpoint 2).

## Decisions LOCKED for M1.5 (Operator, 2026-06-22 — ROADMAP touchpoint 3)
1. **Standards code lives in PHASOR:** a pure `src/standards.mjs` (13370/12831
   closed forms), so the annex calibration gate runs under `node --test`. **IP
   bright line:** norm PDFs / full tables stay gitignored (`norms/`) — only the
   formulas and the single worked annex example go in code (cf. Trittschall
   `references.js` / `verify.js`).
2. **Pin down the steady baseline** (the higher-effort path, chosen deliberately):
   get a *converged* steady ground-loss U to compare against 13370, by deepening
   the deep-Dirichlet boundary substantially **or** applying the ISO-13370
   characteristic-dimension / periodic-depth correction. Compare **both** steady
   and periodic against the standard. This is the session's main risk (ROADMAP
   ~0.6) — and it interacts with perf: a much deeper domain = bigger grid =
   slower solve (mind G2.5 / the 5 s budget). Consider a **dedicated coarse
   calibration solve** (deep + cheap) separate from the interactive display solve,
   rather than deepening every preset. Validate convergence: the steady U should
   stop moving as you deepen further (the opposite of the ~2.5 %/doubling drift
   that motivated this).

## Your job this session: S2-M1.5 — comparison + the calibration gate
Side-by-side: PHASOR earth / PHASOR air / DIN EN ISO 13370 annual-average /
DIN EN 12831 max load; the reduction factor earth÷air **computed, not looked up**
(M1.4 already gives 0.24). Closed forms in a pure helper (per decision 1).
- **Gate FIRST — S2-G1.5 (auto, the calibration gate):** reproduce a DIN EN ISO
  13370 annex worked example (steady + periodic) within the standard's own
  rounding — the same discipline as the Trittschall app's `test/verify.js` vs
  717-2 Annex C. This is the headline odds-shifter; write it before the panel.
- Build the comparison readout/panel (reuse `LossView`/readout plumbing).
- **Proof:** `tools/proof.mjs` → `proofs/s2-m1.5/`; batch the human glance with S2-H1.2.

## Driving the proof harness (learned across M1.2–1.4)
- Drive `window.__phasor` = `{ viz, slices, probe, loss, loadPreset, solve, ui }`;
  settle with `slices.mean != null && /^solved/.test(#status)`.
- **Read canvas pixels after a 2× `requestAnimationFrame` wait** (else `getImageData`
  sees an unpainted canvas, n=0). **Count `alpha > 0`, not `== 255`** — line-art
  panels (probe / loss) draw semi-transparent strokes over a transparent canvas.
- PNG dataURL exceeds the inline limit → dump via `+'!!!PAD!!!'+'A'.repeat(120000)`
  to force a tool-results file; decode in node (no `python` on PATH).
- Open the target panel's `<details>` (and collapse the others) before capturing —
  the loss panel is collapsed by default.

## ⚠ Still-open: the G2.5 wall-clock flake
G2.5 (48³ COCG < 10 s) flakes at its boundary under load and can trip the
pre-commit hook. **Not a regression.** Run guardrails in the **foreground** on a
quiet machine (stop the preview server first; never run the suite in the
background — it gets starved, seen at 525 s once). Don't touch the budget without
Operator sign-off. Real fix = S2-M2 (perf, pure-JS preconditioner first).

## Standing rules
- Gates before features; tolerances are law; raise `MIN_TESTS` when adding gates.
- One subgoal per session, `node --test` + guardrails green + commit between.
- 2D = agent-verifiable (canvas pixels via proof.mjs); 3D WebGL = human channel.
- Scope watch: one gentle flag for out-of-scope / sloped / later-milestone work,
  then respect the choice; park in BACKLOG.md.
- Windows: node on PATH (no `python`); `git push origin main` blocked for the agent.

## After M1.5: S2-M1.6 — export (Explainer seam)
Versioned JSON/CSV of the computed numbers (readouts + loss curve + comparison).
Gate S2-G1.6: schema validates; round-trip lossless; matches in-app readouts.
Reuse `downloadBlob`/`exportText` (index.html) + the `lineProbeCSV` pattern. Then
all of S2-M1 is green → tag `s2-m1-pass` (Operator) after the S2-H1.2 glance.
