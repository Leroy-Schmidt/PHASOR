# PHASOR — Design Document v0.1

**A browser tool for periodic 3D heat conduction in building details.**

Prepared by Meshwork (Priya, Marcus, Yuki, Dmitri, Sam) for the Operator.
Status: ready for execution. Intended consumer: Claude Code, supervised by a physicist who cannot read stack traces but can read temperature fields.

---

## 1. What this is — and is not

PHASOR solves the periodic steady-state of the heat equation in 3D building details (corners, slab junctions, basement walls) and renders the result interactively in a browser. Instead of time-stepping, it exploits linearity: the boundary climate is decomposed into a mean value plus harmonics (annual, diurnal), each harmonic is solved as **one stationary complex-valued linear problem**, and the time behaviour is reconstructed by superposition in the visualizer. There is no time integration anywhere in the solver. This single modelling decision deletes CFL conditions, transient burn-in, and most of the runtime cost, and it is the reason this project is feasible at all.

**Core invariant (write it on the wall): if you find yourself writing a time loop in the solver, stop. Time exists only in the visualizer.**

### In scope
- 3D heat conduction, constant material properties, on parametric axis-aligned geometry (layered boxes).
- Mean (steady) + harmonic solutions at the annual and diurnal frequencies; superposition; arbitrary extra frequencies later.
- Robin (surface-resistance) boundary conditions, Dirichlet far-field, adiabatic symmetry/cut planes.
- Derived quantities: amplitude and phase-lag fields, instantaneous temperature at any scrubbed time, surface heat flux, ψ-value (linear thermal transmittance) from the steady solve, f_Rsi (temperature factor, mold criterion).
- Runs entirely in the browser. No server, no Docker, no build step.

### Explicitly out of scope (do not let the agent drift here)
- Moisture transport, Glaser, condensation beyond the f_Rsi criterion.
- Solar radiation, sky radiation, ventilated cavities (use effective λ values).
- Temperature-dependent λ, phase change, any nonlinearity. Linearity is load-bearing.
- General CAD/STL import, unstructured meshing, arbitrary geometry. Presets only.
- Non-periodic transients (heat-up curves, step responses).

---

## 2. Physics model

### 2.1 Governing equation and harmonic ansatz

Heat conduction: ρc ∂T/∂t = ∇·(λ∇T), with λ(x), ρc(x) piecewise constant per material.

Because the problem is linear and the forcing is periodic, write

T(x, t) = T̄(x) + Σ_k Re[ T̂_k(x) · e^{+iω_k t} ]

Substituting one harmonic gives the per-frequency problem:

**∇·(λ∇T̂) − iω ρc T̂ = 0**  in Ω

For ω = 0 this reduces to steady-state conduction for T̄. Each frequency is an independent solve; results superpose.

### 2.2 Boundary conditions

- **Robin (building surfaces):** −λ ∂T̂/∂n = h (T̂ − T̂_amb), with h = 1/R_s. Defaults: R_si = 0.13 m²K/W (internal), R_se = 0.04 m²K/W (external). For the f_Rsi mold check, the relevant convention uses R_si = 0.25 m²K/W — make R_si editable and document which value a given output used.
- **Dirichlet (far field):** deep soil at the mean annual temperature: T̄ = T_mean, T̂_k = 0 for k ≥ 1.
- **Adiabatic (cut/symmetry planes):** natural BC, i.e. do nothing. Free of charge in FEM.

Ambient temperatures are complex phasors per frequency, e.g. external air: T̄_e = 9 °C, annual amplitude 10 K (phase chosen so the minimum falls in January), diurnal amplitude 5 K. Internal air: constant 20 °C (all harmonic amplitudes zero) by default.

### 2.3 The key length scale

Periodic penetration depth: **δ = sqrt(2λ / (ρc·ω)) = sqrt(2a/ω)**, a = λ/ρc.

| Material (typical) | a [m²/s] | δ diurnal | δ annual |
|---|---|---|---|
| Concrete (λ=2.1, ρc=2.4·10⁶) | 8.8·10⁻⁷ | ≈ 0.155 m | ≈ 2.96 m |
| Soil (λ=2.0, ρc=2.5·10⁶) | 8.0·10⁻⁷ | ≈ 0.148 m | ≈ 2.84 m |

Note δ_annual / δ_diurnal = sqrt(365.25) ≈ 19.1 always. Consequences: diurnal waves die within ~15 cm of concrete (only the outer layers matter); annual waves penetrate metres of soil (the basement domain must be metres deep). Domain sizing rule: **every truncated direction must extend ≥ 3δ of the relevant frequency**, verified by a domain-doubling gate (G3.1).

### 2.4 Analytical anchors (used as test oracles)

**Semi-infinite solid**, surface temperature T̄ + A·cos(ωt):

T(x,t) = T̄ + A · e^{−x/δ} · cos(ωt − x/δ)

Amplitude decays as e^{−x/δ}; phase lag grows linearly as x/δ radians, i.e. time lag τ(x) = x/(δω). At x = δ the amplitude is 37 % and the lag is 1 rad (≈ 3.8 h diurnal, ≈ 58 days annual). This single formula validates the entire harmonic machinery.

**Layered wall (1D):** the exact periodic response of a multilayer wall follows from the transfer-matrix method (ISO 13786 "dynamic thermal characteristics"). For one layer of thickness d, with complex wavenumber κ = (1+i)/δ, the matrix relating (T̂, q̂) on the two faces is

M = [ [cosh(κd), −sinh(κd)/(λκ)], [−λκ·sinh(κd), cosh(κd)] ]

Multiply layer matrices, add surface-resistance matrices [[1, −R_s],[0, 1]] at both faces, and you obtain surface phasors, decrement factor, and time shift. **Operator homework #1:** implement this in a standalone Python script (~40 lines, numpy), independent of the app, including verifying the sign convention against e^{+iωt}. It becomes your independent oracle for gate G2.2 — and if the doc above has a sign slip, your derivation beats the doc.

**2D Laplace benchmark:** on the unit square with T = sin(πx) on the top edge and T = 0 on the other three, the exact solution is T(x,y) = sin(πx)·sinh(πy)/sinh(π). Self-contained, no standards document needed.

### 2.5 Derived quantities

- **Instantaneous field:** T(x,t) = T̄ + Σ_k [Re(T̂_k)cos(ω_k t) − Im(T̂_k)sin(ω_k t)]. Evaluated in the visualizer only.
- **Amplitude / phase maps:** |T̂_k| and τ_k = −arg(T̂_k)/ω_k (display in hours/days). Phase must increase with depth into the construction — see gate G2.4.
- **Heat flux:** q = −λ∇T, per frequency q̂ = −λ∇T̂.
- **ψ-value (steady, extruded presets):** ψ = L_2D − Σ_j U_j·l_j, with L_2D = Φ/(ΔT·L_extrusion). Reference lengths/convention (internal vs external dimensions) must be stated next to the number.
- **f_Rsi:** f_Rsi = (θ_si,min − θ_e)/(θ_i − θ_e) from the steady solve with R_si = 0.25. Flag values < 0.70 (the usual mold criterion).

### 2.6 Conventions (the blood-ink section)

- Time convention **e^{+iωt}**, everywhere, forever. A field that *lags* has **negative** phase angle; reported time lag τ = −arg(T̂)/ω should come out ≥ 0 going inward.
- SI units internally; temperatures in °C are fine (the problem is linear in T, offsets are harmless) but never mix °C and K in one array.
- ω_annual = 2π/31 557 600 s ≈ 1.9910·10⁻⁷ rad/s, ω_diurnal = 2π/86 400 s ≈ 7.2722·10⁻⁵ rad/s.
- Phase zero = midnight Jan 1 of an idealized year. Climate phasors carry their own phase offsets.

---

## 3. Numerical method

### 3.1 Mesh

Rectilinear tensor-product grid: three spacing arrays (dx[i], dy[j], dz[k]), graded geometrically toward material interfaces and junction corners. Geometry is defined as an ordered list of axis-aligned material boxes "painted" into the cell array (later boxes overwrite earlier — painter's algorithm). Every cell has exactly one material. There is **no mesh generator**; this is the second load-bearing scope deletion.

Default resolution target ≤ ~300 k nodes (e.g. 64×64×64); hard cap configurable. Rule of thumb: ≥ 4 cells across each material layer, ≥ 6 cells per penetration depth of the highest resolved frequency in any material where that frequency matters.

### 3.2 Discretization

Trilinear (8-node) hexahedral finite elements — honest Galerkin FEM, weak form:

∫ λ ∇T̂·∇v dV + iω ∫ ρc T̂ v dV + ∮ h T̂ v dA = ∮ h T̂_amb v dA  for all test functions v

Discrete system: **(K + iωC + H) T̂ = b**, with K (conductivity stiffness), C (heat-capacity "mass", consistent), H (Robin surface matrix), b (Robin load). For a rectilinear box element with constant material, K_e, C_e, H_e have closed forms via Kronecker products of the 1D matrices (1D stiffness (1/h)[[1,−1],[−1,1]], 1D mass (h/6)[[2,1],[1,2]]). The agent should derive/verify these symbolically once (sympy) and hard-code the result.

For ω = 0 the system is real, symmetric positive definite.

### 3.3 Operator application: matrix-free

Do **not** build a global sparse matrix format. Apply the operator element-by-element: loop cells, gather 8 nodal values, multiply by the precomputed 8×8 element matrix (complex: K_e + iωC_e), scatter-add. Assemble only the global diagonal (for the preconditioner) and the load vector. This avoids CSR plumbing entirely, is cache-friendly, and is the representation that ports cleanly to WASM/WebGPU later.

### 3.4 Linear solver

- ω = 0: preconditioned **Conjugate Gradient** (Jacobi). SPD, guaranteed.
- ω > 0: the matrix is **complex symmetric (not Hermitian)**. Use **COCG** (conjugate-orthogonal CG: CG with the unconjugated bilinear form ⟨x,y⟩ = Σ x_i y_i — about 40 lines), Jacobi-preconditioned. Fallback if convergence stalls: BiCGSTAB. Relative residual tolerance 10⁻⁸.
- **Oracle:** a dense complex LU solver (naive Gaussian elimination) for grids ≤ ~12³, used only in tests to certify the iterative solver (gate G2.3).

Storage: two Float64Arrays (re, im) per field, or interleaved — agent's choice, but pick once and document in CLAUDE.md.

### 3.5 Performance budget

| Stage | Grid | Budget | Tech |
|---|---|---|---|
| M2 acceptance | 48³ | < 10 s per frequency | plain JS, typed arrays, Worker |
| M4 acceptance | default preset | < 5 s re-solve on slider change | same |
| M4 acceptance | time scrub | ≥ 30 fps | phasor evaluation only — no solve |
| M5 (only if needed) | 96³ | < 5 s | WASM-SIMD or WebGPU matvec |

Scrubbing never re-solves: it evaluates T̄ + Σ Re[T̂ e^{iωt}] per visible voxel/pixel, which is trivially real-time. If interaction feels slow, the bug is architectural (solving when you should be evaluating), not numerical.

---

## 4. Software architecture

### 4.1 Decisions (made, not open)

1. **Browser-only, no build step.** Plain ES modules + an import map pinning three.js and lil-gui from a CDN. The repo runs by opening `index.html` via any static file server (`python -m http.server`). No bundler, no TypeScript, no framework. JSDoc comments for types.
2. **Numerics are pure and headless.** `grid/fem/solver/physics` modules import nothing from the DOM and run identically in Node. This is what makes automated gates possible (`node --test`). UI imports numerics; never the reverse.
3. **Single source of truth:** one plain `model` object {grid spec, boxes, materials, BCs, frequencies}. `solve(model) → fields` is a pure function. UI events mutate the model, then trigger re-solve, then re-render. Unidirectional. No hidden state in widgets.
4. **Solver runs in a Web Worker** (UI thread never blocks); progress messages (iteration, residual) stream to a status line.
5. **Visualization in two stages:** result slices render to plain 2D `<canvas>` panels first (debuggable, screenshot-able); the three.js scene shows geometry/materials from M0 and gains in-scene slice planes only in M4.

### 4.2 Repository layout

```
phasor/
  index.html
  CLAUDE.md            ← agent constitution (template in §8)
  DESIGN.md            ← this document
  VALIDATION.md        ← gate log: date, commit, gate id, result, numbers
  src/
    model.mjs          ← state, presets, materials table
    grid.mjs           ← rectilinear grid, box painter, grading
    fem.mjs            ← element matrices, matrix-free apply, diagonal, loads
    solver.mjs         ← CG, COCG, BiCGSTAB, dense-LU oracle
    physics.mjs        ← δ, analytical solutions, ψ, f_Rsi, phasor eval
    worker.mjs         ← solve worker wrapper
    viz2d.mjs          ← canvas slice panels, colormaps, scrubber
    viz3d.mjs          ← three.js geometry view (+ slice planes in M4)
    ui.mjs             ← lil-gui bindings, presets menu
  test/
    *.test.mjs         ← every automated gate lives here (node --test)
  tools/
    iso13786_oracle.py ← Operator homework #1 (independent, not imported)
```

### 4.3 UI specification

Philosophy: instrument, not dashboard. One signature element — the **time scrubber** that sweeps a day or a year while the field breathes — and everything else stays quiet: one accent color, generous whitespace, no decorative chrome. Controls are named for what the physicist controls ("Insulation thickness", "Outdoor swing ±K"), never for internals ("rebuild grid"). Errors say what to do next ("Solver stalled — refine grid or report residual plot"), and every number on screen carries its unit.

Layout: left = three.js viewport (geometry, later slice planes). Right = three canvas slice panels (XY/XZ/YZ with position sliders). Bottom = time scrubber with day/year toggle. Side panel (lil-gui): preset selector, geometry parameters, material assignment, BC values, frequency toggles, field selector (T(t) | amplitude | phase lag | flux | f_Rsi overlay), Solve button with live residual.

Hard rule from Yuki: maximum three new controls per milestone. Every control must change something visible within 5 seconds or stream progress.

---

## 5. Presets and materials

### 5.1 Presets (each is a parametric function returning boxes + BCs + suggested grid)

1. **`wall1d`** — multilayer wall as a thin 3D slab (validation workhorse; adiabatic lateral faces make it exactly 1D). Parameters: layer list (material, thickness).
2. **`corner2d`** — two exterior walls meeting at 90°, extruded 1 m, adiabatic ends. The classic geometric thermal bridge; ψ and f_Rsi demo.
3. **`slab_junction`** — exterior wall with penetrating concrete floor slab (interrupted insulation), extruded. The classic constructive thermal bridge.
4. **`basement`** — basement wall + floor against a soil block; ground surface gets the external climate phasors, soil block ≥ 3δ_annual (~9 m) sideways and down, bottom Dirichlet at T_mean. This is the "why does the cellar peak in September" demo.

### 5.2 Default material table (editable; typical values — replace with project data when it matters)

| id | λ [W/mK] | ρ [kg/m³] | c [J/kgK] |
|---|---|---|---|
| concrete | 2.1 | 2400 | 1000 |
| brick | 0.70 | 1800 | 1000 |
| eps | 0.035 | 20 | 1450 |
| mineral_wool | 0.035 | 50 | 1030 |
| plaster | 0.51 | 1300 | 1000 |
| wood | 0.13 | 500 | 1600 |
| soil | 2.0 | 2000 | 1250 |

### 5.3 Default climate

External: T̄ = 9 °C; annual amplitude 10 K (minimum mid-January); diurnal amplitude 5 K (minimum ~04:00). Internal: 20 °C constant. All editable as (mean, amplitude, phase) triples per frequency.

---

## 6. Milestone ladder and verification gates

Process rules: (1) One milestone per agent session. (2) A milestone is done when **all** its gates pass — automated gates as `node --test` results pasted into VALIDATION.md, human gates as a dated checklist entry. (3) Tolerances in tests are law; the agent may never loosen one without Operator sign-off. (4) Git-tag every passed milestone (`m1-pass` …) so a flailing session can be rolled back losslessly.

### M0 — Skeleton & geometry (≈ 1 evening)
Deliverable: repo scaffold, grid + box painter, three.js view of material voxels with a movable clip plane, preset selector for `wall1d` and `corner2d`.
- **G0.1 (auto):** painter unit tests — overlapping boxes, painter order, cell counts per material exact.
- **G0.2 (human):** load `corner2d`, clip through it; layers have the right thicknesses and order; grading visibly refines toward the corner.

### M1 — Steady-state solver (≈ 2–3 evenings)
Deliverable: real SPD solve (ω=0) with Robin BCs, temperature slice rendering, f_Rsi and ψ readouts.
- **G1.1 (auto):** `wall1d` vs analytical series-resistance solution: interface temperatures agree to **solver tolerance** (< 10⁻⁶ K), on a *coarse* mesh — trilinear elements represent the piecewise-linear 1D solution exactly, so any mesh-dependent error here means a bug, not discretization.
- **G1.2 (auto):** 2D Laplace benchmark (§2.4): max-norm error decreases ~O(h²); assert error(h)/error(h/2) ∈ [3.2, 4.8].
- **G1.3 (auto):** global flux balance: Σ over all boundary faces of ∮q·n dA = 0 within 10⁻⁶ of total throughput Φ.
- **G1.4 (auto):** mirror-symmetric preset → field symmetric to < 10⁻⁹ relative.
- **G1.5 (human):** `corner2d` isotherms bend around the corner the way every Wärmebrücken textbook figure says they should; inner corner is the cold spot; f_Rsi responds monotonically to the insulation-thickness slider.

### M2 — Harmonic solver (≈ 2–3 evenings)
Deliverable: complex solve per frequency, amplitude & phase-lag fields, superposed instantaneous field, time scrubber on the 2D panels.
- **G2.1 (auto):** semi-infinite check on `wall1d` (single thick concrete layer ≥ 5δ, far end Dirichlet T̂=0): |T̂(x)| vs A·e^{−x/δ} and lag vs x/δ within 1 % at the fine mesh, with O(h²) convergence. Run for both diurnal and annual ω.
- **G2.2 (semi-auto):** multilayer `wall1d` inner-surface phasor vs **your** ISO-13786 Python oracle: amplitude and phase within 0.5 %. (This gate certifies the doc's sign conventions too.)
- **G2.3 (auto):** 10³ grid: COCG solution vs dense-LU oracle, relative difference < 10⁻⁸.
- **G2.4 (auto+human):** phase direction: time lag strictly increases with depth into the construction. (Catches the classic conjugation bug; a wall that anticipates the weather has the sign flipped.)
- **G2.5 (auto):** performance: 48³, one frequency, < 10 s in the Worker.

### M3 — Presets & derived physics (≈ 2–3 evenings)
Deliverable: `slab_junction` and `basement` presets; ψ-value readout with stated convention; f_Rsi report; per-frequency toggles.
- **G3.1 (auto):** domain-size independence for `basement`: doubling the soil box changes inner-surface temperatures < 1 % and Φ < 1 %.
- **G3.2 (human, quantitative):** basement annual cycle: pick a depth, read the phase lag, compare with x/δ from soil properties (expect ~2 months at ~3 m). The September-maximum story must come out of the model, not the documentation.
- **G3.3 (human):** ψ of `slab_junction` is plausible against any published thermal-bridge catalogue detail of similar build-up (expect agreement to ~±15 % — catalogues vary in conventions; investigate, don't panic, if outside).
- **G3.4 (auto):** with all harmonic amplitudes set to 0, harmonic path reproduces the steady solve exactly.

### M4 — Interaction & polish (≈ 2 evenings)
Deliverable: in-scene slice planes in three.js, parameter sliders with auto re-solve, day/year scrub modes, PNG export of any panel, CSV export of line probes.
- **G4.1 (human):** scrub ≥ 30 fps; slider-to-updated-field < 5 s on default presets; no UI freeze ever (Worker discipline).
- **G4.2 (human):** the 15-minute test — hand the tool to someone who hasn't seen it; they must produce a colored corner and answer "where is it coldest and when" without instructions.

### M5 — Stretch (pick at most one per session, only after M4)
- WASM-SIMD or WebGPU matvec (only if a real use case exceeds the budget).
- Fourier import: read an hourly climate file (e.g. a test-reference-year), FFT, keep the N largest harmonics, superpose — real climate response from ~10 solves. (The architecture already supports arbitrary frequency lists; this is mostly I/O.)
- Click-a-face BC editing via raycast (presets make this cosmetic, which is why it's last, not first).
- Chladni mode. Yuki insisted this line exist. Different PDE, same machinery; see Appendix Z, which we have not written.

---

## 7. Working with the agent (operating manual)

### 7.1 CLAUDE.md template (put this in the repo root)

```markdown
# PHASOR — agent constitution
You are implementing DESIGN.md. It is the spec; do not redesign it.

Invariants:
- No build step. Plain ES modules; pinned CDN import map. Code must run via a static server.
- src/{grid,fem,solver,physics}.mjs stay DOM-free and runnable under `node --test`.
- No time integration in the solver. Time-harmonic only. Convention e^{+iωt}; SI units.
- Tests are law. Never weaken a tolerance, skip a gate, or mark a test todo without
  the Operator saying so in this session.
- Before claiming a milestone done: run `node --test`, paste the summary, and list
  which DESIGN.md gates it covers. Update VALIDATION.md.
- Write tests for a gate BEFORE the feature where feasible.
- One milestone per session. If asked to continue mid-milestone, first read
  VALIDATION.md and `git log --oneline -10` to recover state.
- Read OPERATOR_NOTES.md and follow its §3 "Scope watch" convention: one gentle
  flag for out-of-scope / later-milestone / sloped-geometry requests, offer
  proceed / park in BACKLOG.md / stay on track, then respect the choice silently.
```

### 7.2 Session protocol

1. Open a session with: "Read DESIGN.md and VALIDATION.md. We are on milestone Mn. Plan the work as a checklist, write the gate tests first, then implement. Stop and show me when the tests pass."
2. You verify the **human gates** yourself, in physics language, and record them in VALIDATION.md. You are the supervisor; the gates are your instrument panel.
3. When something breaks: paste the *complete* error or the failing test output, plus one sentence of physics if you have it ("amplitude grows with depth — suspect a conjugation/sign error in the Robin load"). Physics hints outperform code hints.
4. If the agent flails twice on the same problem: `git reset --hard <last-tag>`, start a fresh session, and re-prompt with a *narrower* task. Sunk-cost-free rollback is the whole point of tagging.
5. Scope discipline: if the agent proposes anything from §1 "out of scope," the answer is no, even when it sounds easy. Especially when it sounds easy.

### 7.3 Operator homework (your part of the harness)

1. Implement the ISO-13786 transfer-matrix oracle in Python (§2.4), independent of the app. Derive κ and the layer matrix yourself once; fix the sign convention.
2. Re-derive δ and the semi-infinite solution on paper. You will use both weekly.
3. Choose one catalogue detail (any published thermal-bridge catalogue you have access to) as the G3.3 plausibility anchor before M3 starts.
4. Decide and write down the ψ dimension convention (internal/external) you will use.

---

## 8. Risks and fallbacks

| Risk | Likelihood | Mitigation / fallback |
|---|---|---|
| COCG stalls on high-contrast materials (insulation vs concrete) | medium | BiCGSTAB fallback; stronger diagonal scaling; if persistent, accept ω=0 + diurnal-only near-surface submodel while investigating |
| Sign/conjugation bug producing plausible-but-wrong phase | high (once) | Gates G2.2 + G2.4 exist precisely for this; do not skip them |
| three.js plumbing eats sessions | medium | viz2d canvas panels are the primary instrument through M3; 3D slices are polish |
| Browser memory at large grids | low | node cap; Float32 for visualization copies, Float64 for solve |
| Agent context drift across sessions | high | CLAUDE.md + VALIDATION.md + git tags + one-milestone-per-session; rollback early |
| Scope creep toward COMSOL | certain | §1 out-of-scope list; the Operator says no |

Forecast (Dmitri, for the record): M0–M2 in one week of evenings ≈ 75 %; full M0–M4 in two weeks ≈ 85 %, conditional on the gates being enforced. The number is conditional on the gates. It always was.

---

## 9. References (for the Operator's bookshelf, not the agent's)

- ISO 13786 — dynamic thermal characteristics, transfer-matrix method (oracle for G2.2).
- ISO 10211 — thermal bridges, numerical calculation conventions; its validation cases are an optional extra gate if you have library access.
- ISO 6946 — surface resistances, U-value layer calculus (oracle for G1.1).
- DIN 4108-2 — f_Rsi ≥ 0.70 mold criterion and the R_si = 0.25 convention.
- Hagentoft, *Introduction to Building Physics* — periodic conduction chapter; Carslaw & Jaeger for the semi-infinite solution.

---

## Appendix A — Geometry schema and the natural-language geometry compiler

### A.1 The parametric model, precisely

All geometry is an **ordered list of axis-aligned boxes**:

```json
{
  "units": "m",
  "boxes": [
    { "name": "wall",          "x": [0.00, 0.45], "y": [0, 1.2], "z": [0, 1.5], "material": "brick" },
    { "name": "eps",           "x": [-0.16, 0.00], "y": [0, 1.2], "z": [0, 1.5], "material": "eps" },
    { "name": "window_opening","x": [0.00, 0.45], "y": [0.3, 0.9], "z": [0.3, 1.2], "material": "air_opening" },
    { "name": "frame",         "x": [0.03, 0.17], "y": [0.3, 0.9], "z": [0.3, 1.2], "material": "wood" },
    { "name": "glazing",       "x": [0.08, 0.124],"y": [0.36, 0.84],"z": [0.36, 1.14],"material": "glazing_eq" },
    { "name": "eps_overlap",   "x": [-0.16, 0.00], "y": [0.28, 0.92],"z": [0.28, 1.22],"material": "eps" }
  ],
  "bc_regions": [
    { "name": "exterior", "select": "faces at x = min, plus opening reveals facing out", "h": 25.0,
      "T": { "mean": 9, "harmonics": [ {"f": "annual", "amp": 10, "phase_days": 15},
                                        {"f": "diurnal", "amp": 5, "phase_hours": 4} ] } },
    { "name": "interior", "select": "faces at x = max", "h": 7.69, "T": { "mean": 20 } },
    { "name": "cuts", "select": "y/z extremes", "type": "adiabatic" }
  ]
}
```

Semantics: **painter's order** — later boxes overwrite earlier ones cell-by-cell, so you build details the way you build buildings: structure first, insulation over it, openings punched through, frames inserted. Every box face is snapped onto a grid plane (the grid generator collects all box coordinates as mandatory grid lines, then grades between them), so material interfaces are resolved *exactly* — no stair-stepping. Touching solids are automatically in perfect thermal contact; for contact resistance, insert a thin low-λ box. Derived/equivalent materials (e.g. `glazing_eq`: pick thickness d, set λ_eq = d / (1/U_g − R_si − R_se)) go into the material table like any other.

### A.2 The NL→geometry compiler (workflow, not feature)

Complex details are tedious to type as coordinates. Solution: a **separate Claude chat** (not app code) acting as a compiler from construction prose to this JSON. Setup: a short system prompt containing the schema above, the material table, the painter's-order semantics, and the instruction to (a) state every assumed dimension explicitly, (b) compute any equivalent properties showing the arithmetic, (c) output JSON only. You paste the result into PHASOR's geometry editor.

**The verification loop is the point:** the M0 material viewer renders the boxes instantly, before any solve. A misplaced frame or a wrong overlap is visually obvious in seconds. Iterate in the chat ("the EPS should overlap the Rohbau gap by 2 cm, it currently doesn't") until the picture matches the detail drawing. Only then solve. LLM does fuzzy parsing; deterministic painter does geometry; your eyes are the gate.

### A.3 Warnings

- This is a **workflow** layered on M3's raw box editor. Build nothing for it before M4 is green; resist making it an in-app feature (runtime API calls, keys, error handling — a tar pit for zero gain over copy-paste).
- Window details: equivalent-λ glazing is fine for **installation** thermal bridges (ψ_install, reveal temperatures, f_Rsi at the Laibung). It is *not* a substitute for ISO 10077-2 frame/spacer modeling (cavity radiation). Model the spacer as a thin conductive box if relevant; label results as estimates.
- BC region selection for custom geometry is the fiddly part: regions are defined by face predicates (axis + coordinate + bounding rectangle). The compiler prompt must output these too, and they are the most common thing to fix by hand.

---

*— Meshwork, Oakland. The agent doesn't need to be smart; the harness needs to be unforgiving.*
