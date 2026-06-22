# PHASOR — session kickoff: S2-M1.3 harmonic-only view

Read `ROADMAP.md` (the Stage-2 plan — priority layer above BACKLOG), CLAUDE.md,
VALIDATION.md (tail), and `git log --oneline -8`. **Stage 1 (M0–M5) is sealed.**
Stage 2 is the teaching + validation build (ROADMAP), one hard constraint:
maximize the odds of a working app while keeping Operator involvement low — so
almost everything is gated headlessly and the Operator only signs pre-built proofs.

## State you're inheriting (S2-M1.2 done, 2026-06-22)
- **S2-M1.2 — heat-flow visualization DONE** (all auto gates green; S2-H1.2 human
  glance + tag reserved for the Operator):
  - `src/colormap.mjs`: new **`flux`** heat ramp (dark→amber→pale, monotone
    luminance). `src/flux.mjs`: pure **`fluxGlyphs(q, grid, k, {stride, scale})`**
    arrow-layout generator. Gates G1.2a (+3) / G1.2b (+2), written first.
  - `src/viz2d.mjs`: new SlicePanel mode **`'flux'`** ("Heat flow |q|") — recovers
    `cellFlux` of the instantaneous T(t) on the **solve-free scrub path**, paints
    per-cell |q| with the heat ramp, fixed colour scale = **99th-pct of the steady
    |q|** (robust to the re-entrant-corner singularity; stable across scrub so the
    field breathes — bright in winter, quiet in summer). Vector glyphs +
    "Flow arrows" toggle (`ui.mjs`, `index.html`). 3D plane keeps T(t).
  - **`tools/proof.mjs`** — the reusable Stage-2 proof harness: `buildCaptureSnippet`
    (drives `window.__phasor`, reads the 2D `<canvas>` pixels), node-side pixel
    `assert*` (`assertConcentration`/`assertBrighter`/`assertGlyphLayer`),
    `writeProofSheet`. Sheet for this milestone in **`proofs/s2-m1.2/`**.
  - `node --test`: **108/108**. `MIN_TESTS` 103→108.
- **Driving the harness from here:** the agent runs the snippet via `preview_eval`.
  Big results (the PNG dataURL) exceed the inline limit and get **saved to a
  tool-results file** — capture numbers in one small eval, then dump
  `canvas.toDataURL()+'!!!PAD!!!'+'A'.repeat(120000)` (forces the file save) and
  decode the PNG in node (slice `data:image/png;base64,…` up to `!!!PAD!!!`).
- **`window.__phasor`** = `{ viz, slices, probe, loadPreset, solve, ui }`; settle a
  solve by polling `slices.mean != null && /^solved/.test(#status)`.

## ⚠ Open item to resolve at the start of the session
**The G2.5 wall-clock gate (48³ COCG < 10 s) is flaking at the boundary** on this
machine (9.96 / 10.02 / 10.25 s — VALIDATION env note). It is **not** a regression
(the solver is untouched by M1.2). `node --test` is 108/108 on a light run, but
`node tools/guardrails.mjs` (the pre-commit hook) intermittently fails on it. Per
CLAUDE.md the 10 s budget is a tolerance — **do not change/skip it without Operator
sign-off this session.** S2-M2 (performance) is the real fix (preconditioner +
matvec; Tier-0 baseline in BACKLOG). If the M1.2 commit hasn't landed yet, that's
why — get the Operator's call (clean retry vs. one-time hook bypass).

## Your job this session: S2-M1.3 — harmonic-only view (DC-subtracted single frequency)
Render a single ω's amplitude/phase with the **steady field removed** — "the
basement goes flat" as a number, which catches DC leaking into the AC drive.
- **Gate FIRST — S2-G1.3 (auto):** a preset with zero interior harmonic amplitude →
  interior `|T̂|` < ε·peak. (Amplitude/phase modes already exist in `viz2d`; this
  milestone is about the DC-subtracted *single-frequency* presentation + the gate.)
- Then the view. Reuse the existing amplitude/phase plumbing; the new part is the
  explicit DC subtraction and the labeled single-frequency mode.
- **Proof:** run `tools/proof.mjs` for the visual (extend the capture states),
  write `proofs/s2-m1.3/`. Batch the human glance with S2-H1.2.

## Standing rules (don't relearn the hard way)
- **Gates before features; tolerances are law.** Write the gate first. **Run
  `node tools/guardrails.mjs` before claiming green and before every commit** — it
  is the pre-commit hook. Never set `GUARDRAILS_ALLOW_TOL_CHANGE` without Operator
  sign-off this session. Raise `MIN_TESTS` when you add gates.
- **One subgoal per session**, `node --test` green + committed between.
- **2D = agent-verifiable (canvas pixels via proof.mjs); 3D WebGL = human channel.**
- **Scope watch:** one gentle flag for out-of-scope / sloped / later-milestone work
  (custom geometry stays box-based — DESIGN §1), then respect the choice; park in
  BACKLOG.md.
- **Windows:** node on PATH (no `python`; use node for base64/decoding);
  `git push origin main` blocked for the agent — Operator pushes/tags.

## Open question still pending (resolve before S2-M1.5)
Where do the 13370/12831 closed-form formulas live? Leaning **(a)** a pure
`src/standards.mjs` inside PHASOR (keeps the 13370-annex calibration gate inside
`node --test`); (b) only in the Explainer app via the JSON seam. Confirm with the
Operator before building the comparison panel.
