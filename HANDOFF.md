# PHASOR — M4 session kickoff

Read DESIGN.md, VALIDATION.md, CLAUDE.md, OPERATOR_NOTES.md, and
`git log --oneline -10`. We're on **M4 — Interaction & polish**. M0–M3 are sealed
and pushed (`m3-pass` @ cf34776; `node --test` 77/77). Plan the work as a
checklist, write tests where feasible (most M4 gates are human/visual), and stop
and show me when it's working. One milestone — don't drift into M5 (WASM/WebGPU)
unless a real perf budget forces it.

## What you're inheriting
- 5 presets: wall1d, corner2d, slab_junction, basement, soil_rod. Steady +
  harmonic (annual/diurnal) solves run in a Web Worker; results superpose
  client-side (scrubbing never re-solves).
- 2D canvas instrument (the primary tool through M3): slice panel (viz2d.mjs)
  with isolines + colorbar, line probe (lineprobe.mjs), day/year time scrubber,
  field modes (T(t) | amplitude | phase), frequency selector, per-frequency
  toggles, foldable panels.
- three.js geometry view (viz3d.mjs): material voxels + a clip plane — but **no
  field colors yet** (that's M4).
- Readouts: ψ (external-dimension convention), f_Rsi, Φ.

## M4 deliverables & gates (DESIGN §6)
- In-scene slice planes in three.js (paint the field ONTO the 3D model).
- Parameter sliders with **auto re-solve**.
- Day/year scrub modes (already exist — verify/polish).
- PNG export of any panel; CSV export of line probes.
- **G4.1 (human):** scrub ≥ 30 fps; slider→updated-field < 5 s on the default
  presets; no UI freeze ever (Worker discipline).
- **G4.2 (human):** the 15-minute test — hand it to someone cold; they make a
  colored corner and answer "where is it coldest and when" with no instructions.

## Operator wishes worth weighting (see BACKLOG.md)
1. **Paint the temperature field onto the 3D model** — this is the headline he's
   picturing, and it's a core M4 deliverable (the in-scene slice planes).
2. **A genuinely volumetric 3D basement** — a real cellar with finite room +
   corners in a full 3D soil block. Note: it's a NEW PRESET, not in the M4
   deliverable list, and it's perf-sensitive (≥ 3·δ each way in three dimensions
   is big). Do the interaction work first; treat this as a capstone and watch
   solve time (matvec is already deduplicated — grid size is the lever; M5
   WASM/WebGPU is the escape hatch). Flag before sinking a whole session into it.

## Smaller polish
- **Controls that don't apply to the active preset read as "broken."** The
  Operator was briefly unsure whether the tool was buggy because Insulation does
  nothing on basement/soil_rod, Slice-z barely moves on thin presets, and Clip
  only moves the 3D view. It's not a pain point — just hide/disable controls that
  don't fit the current preset so nothing *looks* dead. Low effort. (Auto-resolve
  above also helps, since geometry changes won't sit waiting on a Solve press.)

## Gotchas (also in saved memory)
- **You can't screenshot the 3D view** — preview_screenshot hangs on the
  three.js/WebGL canvas on this Windows setup. Verify via preview_eval / DOM
  reads + timing numbers, and lean on the Operator's eyes for the visual gates.
  Plan verification around this from the start — M4 is the most visual milestone.
- **Scrubbing must never re-solve** (DESIGN §3.5): evaluate T̄ + Σ Re[T̂ e^{iωt}]
  per pixel. Slow interaction = an architectural bug (solving when you should
  evaluate), not numerics. Keep the 30 fps path solve-free.
- **Perf budgets:** measure the re-solve isolated — `node --test` runs files in
  parallel and inflates wall-clock. Default-preset re-solve < 5 s; corner2d
  (~6.7k cells) and basement (~4.8k) are the heavy ones.
- **Windows:** node on PATH (fallback `& "$env:LOCALAPPDATA\Programs\node\node.exe"`);
  python only via miniconda. **`git push origin main` is blocked for the agent** —
  commit + tag locally, ask the Operator to push.
- **Panel render tick:** canvases can first lay out at 0×0 (ResizeObserver/rAF
  retry handles it); if a panel looks blank after a programmatic solve, nudge a
  resize.
- **Yuki's rule:** ≤ 3 new controls per milestone. Auto-resolve may let you
  retire the Solve button (or keep it as a manual override) — budget your controls.
- **Operator is the instrument** and wants plain-language, senior-dev framing
  (low brainspace; triage + clickable choices over walls of text). Quantitative,
  readable views — numbered axes, line profiles, foldable panels.
- **Scope watch:** one gentle flag for out-of-scope / M5 / sloped-geometry
  requests, then respect the choice. Tolerances are law.

Welcome aboard — M3 gave you the physics and five presets; M4 is making it feel
alive and look 3D. Painting the field onto the 3D model is the headline.
