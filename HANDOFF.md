# PHASOR — session kickoff: solver performance (M5 #2, acceleration)

Read DESIGN.md (§3.3–§3.5 numerics + budget), VALIDATION.md, CLAUDE.md,
OPERATOR_NOTES.md, and `git log --oneline -12`. The instrument is feature-complete;
this session is about **making the fine volumetric cellar interactive** without
breaking a single gate.

## State you're inheriting (recover from here)
- **M0–M4 sealed**; `basement3d` (volumetric quarter-symmetry cellar) shipped as
  the M5 stretch, plus a polish increment (stable colormap, play/pause, full-cellar
  symmetry mirror). `node --test` **94/94**.
- All of it is committed **locally on `main`** up to the polish commits but **not
  pushed/tagged** — `git push origin main` is blocked for the agent; the Operator
  pushes and tags. Don't assume a remote is up to date.
- The instrument: 6 presets (wall1d, corner2d, slab_junction, basement,
  **basement3d**, soil_rod); steady + harmonic solves in a Web Worker; solve-free
  scrubbing (≥30 fps phasor eval); 2D slice + line probe + 3D voxels with an
  in-scene field plane that breathes with the scrubber; PNG/CSV export. Readouts:
  ψ (external dims), f_Rsi, Φ.

## The problem (why this session exists)
`basement3d` ships at a **coarse** default (maxH 0.8, 14.4 k nodes, ~4.7 s) because
the **fine** grid (maxH 0.5, 31.7 k nodes) re-solves in **~18–19 s**, over the
DESIGN §3.5 **5 s** budget. This is the documented trigger for the WASM/WebGPU
matvec — but **profile before you port** (Operator decision below).

Baseline from `tools/perf.mjs basement3d 0.5` (isolated; reproduce it first):

| stage              | ms    | iters | ms/iter |
|--------------------|-------|-------|---------|
| steady (display)   | ~7200 | 287   | ~25     |
| steady (R_si=0.25) | ~7200 | 287   | ~25     |
| annual (COCG)      | ~3400 | 231   | ~15     |
| diurnal (COCG)     | ~1300 | 74    | ~17     |
| **TOTAL**          | ~19 k |       |         |

f_Rsi 0.160, Φ_ext 198.07 W — keep these fixed; a "faster but wrong" result moves them.

## The one rule that frames this session
**A performance change must be a within-tolerance behavioral no-op.** It may not
move any physics result beyond solver tolerance, and it may **never** loosen a
gate tolerance (CLAUDE.md: tolerances are law). If a tolerance "needs" loosening,
the optimization is wrong, not the test.

## Operator decision (2026-06-19): profile-first, pure-JS-first
Exhaust pure-JS wins before any WASM/WebGPU. Honors the no-build-step invariant +
OPERATOR_NOTES §9 and keeps everything headless-gateable as long as possible. Pick
the lever from **attribution data**, not assumption.

### The key insight
**~14.4 s of the ~19 s is the two steady solves, at 287 CG iterations each.** Two
independent levers:
- **Fewer iterations** — a better *preconditioner*. Attacks conditioning.
- **Faster matvec** — WASM-SIMD / WebGPU / JS micro-opt. Speeds each iteration but
  does **not** reduce the 287.

The steady solve looks iteration-bound, and `basement3d` is nearly uniform-λ (soil
2.0 / concrete 2.1) — the regime where geometric multigrid behaves. A
preconditioner is likely the bigger, lower-risk win, helps **both** steady solves,
and needs zero new tooling. Try it before porting a matvec.

## Tiered plan (in order; stop when the fine grid is < 5 s)
- **Tier 0 — Profile.** `tools/perf.mjs` already exists and reproduces the
  baseline above. Use it for every before/after; **always isolated, never in
  `node --test`** (parallelism inflates wall-clock).
- **Tier 1 — Pure JS (zero tooling, full `node --test` gating).**
  - (a) **Preconditioner** for the steady solve (dominant cost): geometric
    multigrid V-cycle on the rectilinear grid (or cheaper SSOR / block-Jacobi).
    Likely `src/multigrid.mjs` + an optional preconditioner hook in `cg`/`cocg`
    (`src/solver.mjs`). Keep Jacobi-CG as the certified fallback.
  - (b) **Matvec micro-opts** in `scatterKHC` / `scatterKH` (`src/fem.mjs` ~L466):
    SoA element tables, alloc hygiene, optional Float32 *iteration* copies (Float64
    for the assembled load + readouts).
- **Tier 2 — Port the matvec** (only if Tier 1 is insufficient AND profiling says
  throughput-bound). Bring the WASM-vs-WebGPU choice back to the Operator **with
  numbers**:
  - *WASM-SIMD* — matrix-free apply ports cleanly (the M0 reason for matrix-free);
    **Node runs `.wasm`, so equivalence + dense-LU gates run under `node --test`**.
    Cost: a one-time toolchain to regenerate the `.wasm` (commit binary + source +
    build command; serve-time stays build-free). Keep CG/COCG vector ops in JS.
  - *WebGPU* — WGSL is runtime-compiled (best no-build-step fit) but can't be gated
    headlessly and forces the *whole* solver onto the GPU (matvec + dots + axpy).
    Larger surface, weaker gates. Reserve for a decisive GPU win.

## How to gate it (backend-agnostic; write the equivalence gate FIRST)
**Correctness (every accelerated path, before merge):**
- **G-A Operator equivalence** vs the canonical JS `applyA` / `applyAComplex`
  (`src/fem.mjs`): random vectors on a graded multi-material grid (basement3d-like),
  real (ω=0) < 1e-12 relative, complex (ω>0) < 1e-10. JS apply is the oracle. WASM →
  `node --test`; WebGPU → a `preview_eval` harness. *(A preconditioner keeps the
  operator identical — gate it via G-B/G-C/G-D instead.)*
- **G-B Dense-LU certification** — rerun G2.3 (`cocg` vs `denseLUSolveComplex`
  < 1e-8) with the new apply / preconditioner.
- **G-C All existing gates green with acceleration ENABLED**, tolerances unchanged.
- **G-D Determinism** — each preset solved JS-vs-accelerated, fields agree to solver
  tol (regression test).
- **G-E Fallback** — feature-detect; unavailable backend → automatic JS fallback;
  app still works (test the branch).

**Performance (the goal):**
- **G-P** `basement3d` fine (maxH 0.5) full re-solve **< 5 s** isolated via
  `tools/perf.mjs`; report the per-stage + iteration breakdown. Secondary: **no
  regression on wall1d / corner2d** (no fixed-overhead penalty on small solves).

## Why this is low-risk: the seam already exists
- `cg` / `cocg` take `apply` as a **function** (`src/solver.mjs`) → an accelerated
  apply or a preconditioner hook slots in with no solver-structure change.
- The kernel's data is already assembled + **deduplicated**:
  `problem._elem.{KeList, CeList, cellElem}` (+ `EimList` per ω), `robinFaces`, the
  `free` mask, `FACE_P` (`src/fem.mjs`). Pack into flat typed arrays once per solve.
- `worker.mjs` selects the apply (feature-detect + flag); the scrub path is
  untouched (solve-free, DESIGN §3.5).

## Standing rules (don't relearn these the hard way)
- **Gates before features; tolerances are law.** Write the equivalence/regression
  gate before the optimization. One lever at a time, `node --test` green +
  committed between.
- **Measure isolated** (`tools/perf.mjs`), not in `node --test`.
- **Windows:** node on PATH; `git push origin main` blocked for the agent — commit +
  tag locally, the Operator pushes. Dev server `tools/devserver.mjs` on 8123
  (`preview_start phasor`); WebGL can't be screenshotted here — use `canvas.toBlob`
  + `preview_eval`, lean on the Operator's eyes for visuals.
- **Scope watch:** one gentle flag for out-of-scope / sloped / later-milestone work,
  then respect the choice; park good ideas in BACKLOG.md.
- **Don't drift:** DESIGN §1 out-of-scope is still binding. This session is *one*
  thing — make the fine cellar interactive without breaking a gate.
