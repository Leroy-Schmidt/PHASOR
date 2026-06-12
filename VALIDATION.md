# PHASOR — Validation log

Gate log per DESIGN.md §6. Automated gates: `node --test` summary pasted verbatim.
Human gates: dated checklist entry signed by the Operator.

| Date | Commit | Gate | Result | Numbers / notes |
|---|---|---|---|---|
| 2026-06-12 | aff51fd | G0.1 (auto) | PASS | `node --test`: 18 pass / 0 fail. Painter: overlap order, shared-face split 32/32 exact, 3-box sandwich vs brute-force reference exact. Presets: wall1d 84 cells (eps 28 / brick 40 / plaster 16, counts exact vs tick intervals); corner2d corner cell = eps (insulation wraps), grading h(corner) < 0.5·h(max). |
| 2026-06-12 | — | G0.2 (human) | PENDING | Operator checklist: load corner2d via static server, sweep clip plane through the corner — (a) layer thicknesses/order correct (eps 160 / brick 240 / plaster 15, exterior → interior), (b) grading visibly refines toward the interior corner. Tag `m0-pass` after sign-off. |
