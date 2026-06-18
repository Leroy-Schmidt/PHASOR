# PHASOR — M5 session kickoff

Read DESIGN.md (esp. §6 M5 + §1 out-of-scope), VALIDATION.md, CLAUDE.md,
OPERATOR_NOTES.md, and `git log --oneline -10`. We're on **M5 — Stretch**. M0–M4
are sealed and tagged (`m4-pass` @ 3822440; `node --test` **86/86**).

**The one rule that defines M5 (DESIGN §6 + §7.2):** *pick at most ONE stretch
item per session, and only after M4 is tagged (it is).* M5 is a menu, not a
checklist — there is no "finish M5." Each item is independent; do one well, tag
it, stop. Don't chain two.

## What you're inheriting (the instrument is complete)
A finished, fast, browser-only harmonic heat tool:
- **5 presets:** wall1d, corner2d, slab_junction, basement, soil_rod. Steady +
  harmonic (annual/diurnal) solves run in a Web Worker; results superpose
  client-side (scrubbing never re-solves).
- **2D instrument:** slice panel (viz2d) with isolines + colorbar + low-amplitude
  phase masking, line probe (lineprobe), day/year scrubber, field modes
  (T(t) | amplitude | phase-lag-vs-outdoor), per-frequency toggles, foldable panels.
- **3D instrument (M4):** three.js voxels + clip plane + an **in-scene field
  slice plane** (`Viz3D.setFieldSlice`) that paints the panel's exact
  field/range/colormap onto the model via a DataTexture quad and **breathes with
  the scrubber** (driven by `SlicePanel.onFieldUpdate`). Colormaps are shared via
  `src/colormap.mjs`.
- **Interaction (M4):** auto re-solve on slider release (Solve button retired);
  per-preset control hiding; PNG export of every panel + the 3D view; CSV export
  of the line probe (`lineProbeCSV`).
- **Readouts:** ψ (external-dimension convention), f_Rsi, Φ.
- **Phase-lag is now intuitive:** `timeLagRelative(re,im,ω,φ_ref)` references the
  lag to the outdoor forcing (worker ships per-harmonic `refRe/refIm`), so the
  exterior surface reads ≈ 0 and the lag grows inward. Use this, not the bare
  absolute `timeLag`, for any new phase readout.

## The M5 menu (DESIGN §6) — ranked by payoff/risk, pick one

**1. Fourier climate import — highest payoff, lowest risk. Recommended first.**
Read an hourly climate file (a test-reference-year / TRY), FFT it, keep the N
largest harmonics, superpose → real climate response from ~10 solves. The
architecture *already* supports an arbitrary frequency list (the harmonic loop
and the visualizer's superposition don't care how many frequencies there are),
so this is **mostly I/O + an FFT + a frequency-picker**, not a solver change. No
perf cliff (10 solves at current preset sizes is seconds). Watch: keep the
e^{+iωt} sign convention end-to-end (reuse `climatePhasor`'s minimum-at-offset
logic as the oracle); the worker already maps `f`→ω via `OMEGA_BY_FREQ`, so
generalize that to a passed-in frequency list rather than the hard-coded
`['annual','diurnal']`. This is the item that turns a teaching toy into a tool a
building physicist would actually run.

**2. WASM-SIMD or WebGPU matvec — only if a real use case exceeds the budget.**
Do NOT do this speculatively (DESIGN: "only if a real use case exceeds the
budget"; OPERATOR_NOTES §1.9: refuse tooling upgrades without need). The honest
trigger is the **volumetric 3D basement** (BACKLOG): a real cellar + corners in a
full 3D soil block needs ≥ 3·δ_annual (~9 m) each way in *three* dimensions, so
a 48³–64³ grid (≈110k–260k nodes) vs today's ~5–7k-cell 2D-extruded presets.
Current isolated re-solve: wall1d 47 ms / corner2d 946 ms / basement 1888 ms —
all under the 5 s budget; a true-3D basement is the thing that could blow it.
Plan if you take this: (a) build the volumetric basement preset first as the
*motivating use case*, measure the isolated re-solve; (b) if it's over budget,
port the matrix-free element apply (already deduplicated, `applyA` /
`applyAComplex`) to WASM-SIMD or a WebGPU compute matvec — the matrix-free
representation was chosen in M0 precisely to port cleanly. Measure **isolated**,
not inside `node --test` (parallelism inflates wall-clock — saved memory).

**3. Click-a-face BC editing via raycast — low priority (cosmetic).** Presets
already cover the real details, so this is convenience, not capability. Leave it
unless the Operator specifically wants it.

**4. Chladni mode.** Yuki's joke line (different PDE, same machinery). Only if the
Operator asks for fun.

## Carried-forward BACKLOG (not M5 items, but adjacent)
- **Volumetric 3D basement** — the Operator's showcase ask; the natural use case
  that justifies M5 item #2. A *new preset*, perf-sensitive. Engine/grid/painter
  are already 3D; grid size is the only lever.
- **Play/pause continuous scrub** — Operator QoL ask. ~10 lines: a rAF loop that
  advances `scrub-range.value` and calls `applyScrub()`, stop on pause/drag. Pure
  phasor eval (the existing solve-free ≥30 fps path). A nice low-effort warm-up if
  you want a quick win before/around the chosen M5 item — but it's QoL, not M5.
- Other items in BACKLOG.md (slab recess for a milder ψ, mesh-diagonal grading)
  are park-only; don't chase them.

## Gotchas (also in saved memory)
- **You can't screenshot the 3D view** — `preview_screenshot` hangs on the
  three.js/WebGL canvas on this Windows box. BUT `canvas.toBlob('image/png')` via
  `preview_eval` works (that's how M4's 3D PNG export is verified). Verify 3D via
  `preview_eval` state reads + timing + `toBlob` size; lean on the Operator's eyes
  for the visual gates.
- **Scrubbing must never re-solve** (DESIGN §3.5): evaluate T̄ + Σ Re[T̂ e^{iωt}]
  per pixel/texel. Slow interaction = an architectural bug (solving when you
  should evaluate), not numerics. Keep the 30 fps path solve-free — this still
  holds with N>2 Fourier frequencies.
- **Perf budgets:** measure re-solve **isolated** (a tiny standalone `.mjs` in the
  repo root, `node ./_x.mjs`, then delete — relative imports need repo cwd).
  `node --test` runs files in parallel and inflates wall-clock.
- **Windows:** node on PATH (fallback `& "$env:LOCALAPPDATA\Programs\node\node.exe"`);
  python only via miniconda full path (`& "C:\Users\Nutzer\miniconda3\python.exe"`).
  **`git push origin main` is blocked for the agent** — commit + tag locally, ask
  the Operator to push.
- **Dev server:** `tools/devserver.mjs` (node, zero deps), wired into
  `.claude/launch.json` as `phasor` on port 8123. Use `preview_start`.
- **Panel render tick:** canvases can first lay out at 0×0 (ResizeObserver/rAF
  retry handles it); if a panel looks blank after a programmatic solve, nudge a
  resize.
- **Yuki's rule:** ≤ 3 new controls per milestone. Fourier import probably wants a
  file-load button + maybe a "# harmonics" control — budget accordingly.
- **Operator is the instrument:** plain senior-dev framing, low brainspace, triage
  + clickable choices. Numbered axes, line profiles, foldable panels.
- **Scope watch:** one gentle flag for out-of-scope / sloped-geometry requests,
  then respect the choice. Tolerances are law; never loosen one without sign-off.

## Don't drift
DESIGN §1 out-of-scope is still binding (no moisture/Glaser, no solar/radiation,
no nonlinearity, no CAD/STL/unstructured meshing, no non-periodic transients). M5
is a *single* curated stretch, not the door to all of them. If unsure which item,
ask the Operator with clickable choices before building.

Welcome aboard — M4 made it feel alive and look 3D. M5 is one well-chosen reach:
the obvious one is real climate (Fourier import); the ambitious one is a genuinely
volumetric 3D basement, with WASM/WebGPU as its escape hatch if the grid blows the
budget. Pick one.
