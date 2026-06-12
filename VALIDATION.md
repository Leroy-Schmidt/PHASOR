# PHASOR — Validation log

Gate log per DESIGN.md §6. Automated gates: `node --test` summary pasted verbatim.
Human gates: dated checklist entry signed by the Operator.

| Date | Commit | Gate | Result | Numbers / notes |
|---|---|---|---|---|
| 2026-06-12 | aff51fd | G0.1 (auto) | PASS | `node --test`: 18 pass / 0 fail. Painter: overlap order, shared-face split 32/32 exact, 3-box sandwich vs brute-force reference exact. Presets: wall1d 84 cells (eps 28 / brick 40 / plaster 16, counts exact vs tick intervals); corner2d corner cell = eps (insulation wraps), grading h(corner) < 0.5·h(max). |
| 2026-06-12 | 264aa45 | G0.2 (human) | PASS | Operator sign-off: corner2d layer order/thicknesses correct (eps 160 / brick 240 / plaster 15, exterior → interior; eps wraps the outer corner), grading visibly refines toward the interior corner. Caveat noted: mesh density along the outer→inner corner diagonal is relatively low — to be re-checked once M1's solver can measure it via convergence / f_Rsi gates (see BACKLOG.md). |
