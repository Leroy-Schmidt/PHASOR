# PHASOR — Stage 2 roadmap (low-human-involvement build)

Stage 1 (DESIGN.md M0–M5) is sealed: the instrument solves and visualizes,
94/94 tests green. **Stage 2 turns it into a teaching + validation tool** (and an
approximation of a production app), built to one hard constraint: **maximize the
odds of a working, satisfying app while keeping Operator involvement low.**

This file is the **priority layer**. `BACKLOG.md` stays the raw pool; an idea
earns a place here only once it's promoted to a sequenced milestone. `DESIGN.md`
remains the frozen Stage-1 spec; where Stage 2 extends it or touches its §1
"out of scope" line, the milestone says so. Process rules carry over from
DESIGN §6: **one milestone per session, gates are law (never loosen a tolerance),
write the gate before the feature, git-tag every pass** (`s2-m1-pass`, …).

---

## The organizing principle: shrink the human to a signature

The expensive, unreliable resource is Operator attention. Every choice below is
bent toward letting an agent **self-verify headlessly** and present a pre-built
proof, instead of asking the Operator to drive the live app. Three mechanisms:

**1. Data / pixel split — push correctness into pure data.** All physics (flux
field, reconstruction, integrals, comparisons, harmonic decomposition) lives in
**DOM-free `src/*.mjs` returning plain arrays/objects**, 100 % gated under
`node --test`. The agent verifies every *number* alone. Only *pixels* need eyes.

**2. Two visual channels — route the verifiable one to the agent.**
- **2D panel (`viz2d.mjs`) = agent-verifiable.** Plain `<canvas>`, so the agent
  pulls pixels via `canvas.toBlob` + `preview_eval` and asserts invariants itself
  ("envelope warmer than soil," "arrow layer non-empty," "colorbar monotonic").
  No human. The heat-flow viz is gated here.
- **3D in-scene (`viz3d.mjs`) = human channel.** WebGL can't be screenshotted in
  this environment, so the 3D flux plane is *cosmetic mirroring* of already-
  verified 2D data; its only human gate is a glance at a batched proof sheet.

**3. Batched proof sheets + autonomous session loop.** `tools/proof.mjs` drives
the dev server to fixed states, captures 2D `toBlob` PNGs + scrapes on-screen
readouts to JSON, runs the pixel assertions, writes `proofs/s2-mX/` (PNGs + a
one-page `index.html`). The agent runs it every subgoal; the Operator reviews the
*sheet* (~2 min). Each subgoal is one session: gate → implement → `node --test`
green → `proof.mjs` → commit → update HANDOFF.md.

### Human Involvement Budget (the auditable claim)

| # | Touchpoint | Milestone | Why irreducible | Est. |
|---|------------|-----------|-----------------|------|
| 1 | Approve this roadmap | — | scope/sequencing is the Operator's call | 10 m |
| 2 | Sign M1 proof sheet (heat-flow looks like heat; curve sane) | S2-M1 | aesthetics + 3D-WebGL glance | 5 m |
| 3 | 13370 steady comparison — fix deep boundary, or scope to periodic? | S2-M1.5 | modeling judgment, flagged with numbers | 5 m |
| 4 | WASM-vs-WebGPU decision *iff* Tier-1 perf falls short | S2-M2 | architecture + build-step tradeoff | 10 m |
| 5 | Sign M2 proof sheet (no visual regression at speed) | S2-M2 | confirm "behavioral no-op" | 3 m |
| 6 | The 15-minute usability test (×1–2 rounds) | S2-M3/M4 | usability is definitionally human | 15–30 m |
| 7 | Sign final proof sheet | S2-M4 | acceptance | 5 m |

**Total irreducible Operator time ≈ 1–1.5 h across all of Stage 2**, almost all
reviewing pre-built artifacts. Everything else is agent-autonomous.

---

## Sequencing & forecast (rationalist hat)

`S2-M1 Flux & heat-loss story` (hero; heat-flow viz; needs no perf) → `S2-M2
Performance` (prereq for M3) → `S2-M3 Custom geometry` (box-based) → `S2-M4 UI /
self-explanatory` → `S2-M5 Wärmebrücken detail catalogue` (stretch, needs M3).
**Parallel track T1:** Norm-Explainer app. **Far stretch:** Acoustics fork.

**Recommended: M1 first** — heat flow + the loss curve are the "is it worth the
weekend" payoff, reuse already-validated solved fields (no re-solve, no perf), and
the Operator twice steered toward visual/teaching value first. The perf session is
already cracked open (Tier-0 baseline in HANDOFF) so resuming later is cheap.

| Milestone | P(lands cleanly) | Dominant failure mode |
|-----------|------------------|------------------------|
| S2-M1 numbers | ~0.9 | flux gradient recovery on graded cells noisier than expected → recovery scheme |
| S2-M1 viz *satisfying* | ~0.75 | glyph density/scaling is a taste loop; pixel-gate + 1 glance |
| S2-M1.5 13370 *steady* annex | ~0.6 | deep-Dirichlet sink (~2.5 % under-converged) vs half-space model |
| S2-M1.5 13370 *periodic* annex | ~0.85 | δ-governed; domain already certified (G3.1) |
| S2-M2 hit <5 s | ~0.9 something works | which lever: V-cycle ~0.55 first try; SSOR ~0.7 partial; WASM ~0.85 but toolchain |
| S2-M3 box-geometry editor | ~0.7 | BC face-predicate UX is fiddly (DESIGN §7) |
| S2-M4 15-min test | ~0.8 | needs 1–2 human rounds; expected, not failure |

### Per-session pass odds under vibe coding
P(milestone goes clean in its vibe sessions | previous clean). Driver: how
headlessly verifiable the work is (declines M1→M4; harness quality compounds up).

| Milestone | P(clean, vibe) | Why |
|-----------|----------------|-----|
| S2-M1 | ~0.70 | pure numerics, pre-writable gates; dragged by viz-taste + 13370-steady call |
| S2-M2 | ~0.50 | trough — algorithm uncertainty; <5 s is a hard threshold. P(correct) ~0.9 via gates+fallback |
| S2-M3 | ~0.55 | strong headless gate but fiddly BC UX |
| S2-M4 | ~0.40 | lowest — usability can't converge headlessly |
| S2-M5 | ~0.65 | curated content on a proven editor |

**The chain trap:** P(all clean first-pass) ≈ 0.7·0.5·0.55·0.4 ≈ **0.08** — but
that's the wrong metric. Every gate is unforgiving and every green state is
committed/tagged, so a failed session is detected and cheap → **P(eventually
correct, bounded human cost) ≈ 0.85+**. The harness converts low one-shot odds
into high eventual success with a capped blast radius. That conversion is the
product. **Common-cause warning:** a weak gate or bad abstraction in M1 silently
lowers *every* later P — so highest-leverage spend is early (`flux.mjs` API +
`proof.mjs` harness condition the whole chain).

**Odds-shifters (signed):** gate-first independent-oracle gates (two computations
of one number: flux↔boundaryFlux, COCG↔denseLU) **+0.15–0.20**, biggest lever;
one-session subgoals + commit/tag each green **+0.10–0.15**; build `proof.mjs`
early **+0.10** to all later; Jacobi-CG certified fallback **+0.10** on M2; pin
physics invariants numerically **+0.10**; HANDOFF every session **+0.05–0.10**.
*Mistakes:* feature-before-gate **−0.20–0.30** + poisons chain; loosen a tolerance
to go green **−0.30** (silent); loose "looks-right" gates **−0.15** (undetected);
oversized sessions **−0.15**; trust "tests green" w/o cross-checks **−0.10**;
vibe-code UX headlessly **−0.10**.

---

## S2-M1 — Flux & the heat-loss story (the hero)

New module **`src/flux.mjs`** (DOM-free) is the single source of truth: the
volumetric `q(x) = −λ∇T` field, the glyph/streamline data, and the envelope
integral. Both the viz and the loss curve read it. Reuses element geometry from
`fem.mjs`; cross-checks against existing `boundaryFlux` (fem.mjs:617).

**S2-M1.1 — `flux.mjs`: the q = −λ∇T field.** Cell-centre gradient of the
trilinear field → flux vectors (`cellFlux`) + envelope integral (`regionFlux`);
complex variant `cellFluxComplex` (q̂ = −λ∇T̂) for phasor fields.
- **S2-G1.1a (auto):** linear field → cell-centre q exact (trilinear is exact for
  linears, mirrors G1.1).
- **S2-G1.1b (auto):** `wall1d` interior q uniform, transverse components ≈ 0.
- **S2-G1.1c (auto):** linear field → discrete divergence ≈ 0 (constant flux).
- **S2-G1.1d (auto), the cross-check:** `regionFlux` == `boundaryFlux` Robin value
  per region on `wall1d` (exact solution) to solver tol. Two independent flux
  computations agreeing — the headline independent-oracle gate.

**S2-M1.2 — Heat-flow visualization (2D panel; early-priority crowd-pleaser).** In
`viz2d.mjs`: (a) dynamic **|q| magnitude colormap** on the scrub path (solve-free,
`scrub.mjs`); (b) **vector glyphs / streamlines** layer. Glyph layout generated in
`flux.mjs` (pure, unit-tested), rendered in viz2d.
- **S2-G1.2a (auto):** colormap fn unit-tested (extends `colormap.mjs`).
- **S2-G1.2b (auto):** glyph generator (dir == −∇T normalized, length ∝ clamped
  |q|, count == stride) tested against the field array.
- **S2-G1.2c (agent-visual, `proof.mjs`):** `toBlob` pixel assertions — high-|q|
  band at the bridge brighter than interior; glyph layer non-empty on envelope.
- **S2-H1.2 (human, batched):** proof-sheet glance — "looks like heat flowing."

**S2-M1.3 — Harmonic-only view (DC-subtracted single frequency).** Render a ω's
amplitude/phase with the steady field removed.
- **S2-G1.3 (auto):** preset with zero interior harmonic amplitude → interior
  `|T̂|` < ε·peak. "The basement goes flat" as a **number**; catches DC leaking
  into the AC drive.

**S2-M1.4 — Annual heat-loss curve, earth vs. air.** Integrate envelope q across
the year by superposition (no re-solve). "Air case" = basement with soil deleted /
replaced by exterior-air Robin. Chart-with-gap idiom (Trittschall app's
measured-vs-reference chart).
- **S2-G1.4a (auto):** reconstructed curve == direct superposition to solver tol.
- **S2-G1.4b (auto):** air-case solves; annual mean loss > earth case (correct sign).

**S2-M1.5 — Comparison + the "validate the standard" gate.** PHASOR earth / PHASOR
air / 13370 annual-average / 12831 max load side by side; earth÷air = the reduction
factor, computed not looked up. Closed forms in a pure helper (`src/standards.mjs`).
- **S2-G1.5 (auto, NEW — calibration gate):** reproduce a DIN EN ISO 13370 annex
  worked example (steady + periodic) within the standard's own rounding — same
  discipline as the Trittschall app's `verify.js` vs 717-2 Annex C.
- **Prereq (promoted from BACKLOG 2026-06-16):** the steady ground-loss is only
  ~1/depth converged (~2.5 %) — deep-Dirichlet sink. Fix (deeper boundary / ISO
  characteristic correction) **or** scope to the periodic part with the limitation
  shown on screen. **Operator decision (touchpoint 3), flagged with numbers.**

**S2-M1.6 — Export (Explainer seam).** Versioned JSON/CSV of the computed numbers.
- **S2-G1.6 (auto):** schema validates; round-trip lossless; matches in-app readouts.

**Touched:** new `src/flux.mjs`; `viz2d.mjs`, `colormap.mjs`, `scrub.mjs`,
`worker.mjs` (expose flux + air-case solve), `ui.mjs` (toggles, comparison, export);
new `tools/proof.mjs`; tests under `test/`. `viz3d.mjs` mirrors the 2D flux plane
(cosmetic). New `src/standards.mjs`.

---

## S2-M2 — Performance (make the fine field interactive)

Prereq for a pleasant custom-geometry UX (arbitrary grids must solve in the §3.5
budget). In flight; Tier-0 baseline captured (HANDOFF): fine `basement3d` ~19–21 s,
two steady solves dominate at 287 CG iters each.

**Approach (2026-06-19 Operator decision — profile-first, pure-JS-first):**
preconditioner for the steady solve via a `precond(r,z)` hook in `cg`
(`solver.mjs`) — multigrid V-cycle (`src/multigrid.mjs`), SSOR/block-Jacobi as the
cheaper probe; **Jacobi-CG kept as certified fallback**. Then matvec micro-opts in
`scatterKH`. WASM-SIMD / WebGPU only if Tier-1 is insufficient *and* profiling says
throughput-bound (bring the choice back with numbers — touchpoint 4).

**Gates (backend-agnostic, equivalence gate first — from HANDOFF):** G-A operator
equivalence vs JS `applyA`/`applyAComplex`; G-B dense-LU re-cert (G2.3); G-C all
existing gates green with acceleration on, tolerances unchanged; G-D determinism
JS-vs-accelerated per preset; G-E feature-detect + JS fallback tested; **G-P
`basement3d` fine < 5 s isolated via `tools/perf.mjs`, no small-preset regression.**
A preconditioner keeps the operator identical → gated by G-B/C/D. A perf change is
a within-tolerance behavioral no-op; f_Rsi 0.160 / Φ 198.07 stay fixed.
**S2-H2 (human, batched):** proof sheet — fields visually identical before/after.

---

## S2-M3 — Custom geometry (box-based)

**SCOPE:** box-based only — axis-aligned boxes, painter order, fed by DESIGN §7
JSON (boxes + materials + face-predicate BC regions). Arbitrary CAD/STL/
unstructured stays **out** (DESIGN §1). Depends on S2-M2.

**Deliverable:** a geometry editor accepting the §7 JSON; prose→JSON compiler
workflow documented; a user describes a basement + per-layer λ/thickness and solves.
**Gates:** painter/round-trip (extends G0.1); **a user-built replica of a preset
reproduces its readouts to solver tol**; BC-region face predicates validated.

---

## S2-M4 — UI / self-explanatory

**Deliverable:** labeled total-field vs. harmonic-only toggle (the ambiguity bug),
onboarding, click-a-face BC editing (DESIGN M5), polish.
**Gate G4.2 extended (human):** a new user builds a custom basement and reads its
winter loss + worst corner without instructions.

---

## S2-M5 — Wärmebrücken detail catalogue (stretch; depends on M3)

The payoff of box-geometry: a library of real construction details, cheap content
once the M3 editor exists. Where the app **produces value to users** and where the
3D moat shows — published catalogues are 2D, so PHASOR's 3D corner ψ/f_Rsi is the
genuine value-add (the corner is what a 1D/2D formula structurally cannot find).

**Detail set (each an authored §7 JSON preset):**
- **3D corners** (Raumecke / trihedral) — the showcase: where 2D catalogues fail.
- **Attika** (parapet upstand at the roof edge).
- **Sockeldetail** (base/plinth: wall → foundation → ground).
- **Deckenanschluss Beton über Hochlochziegel** (dense concrete floor slab on
  vertically-perforated clay-block masonry — classic conductive bridge).
- **Fenstersturz** (window lintel); room to grow: Fensterbank, Rollladenkasten,
  Balkonplatte cantilever, Bodenplatte–Außenwand.

**Gates:**
- **S2-G5.1 (auto):** every detail assembles, solves, symmetric where it should be
  (extends G1.4); ψ and f_Rsi finite and sign-correct.
- **S2-G5.2 (human, batched, extends G3.3):** each 2D-reducible detail's ψ within
  ~±15 % of a published catalogue figure; 3D corners flagged "no 2D reference —
  that's the point."
- **Catalogue regression:** a fixtures file pins each detail's ψ/f_Rsi (headless).

---

## The general-tool vision — "author any axis-aligned detail, get f_Rsi/ψ"

Synthesis of the Operator's 2026-06-23 question: how far from a more-or-less
general-purpose thermal-bridge tool (window + slab-over, offset basement, floor
slab into brick walls with external EPS, …)? **Key finding: the engine is already
there.** f_Rsi is fully geometry-agnostic (`worker.steadyReadouts` runs the
R_si=0.25 solve + interior-surface min for *any* preset with an `interior` Robin
region); the solver handles arbitrary axis-aligned multi-material boxes, steady +
harmonic, O(h²)-gated. The gap to "general-purpose" is **authoring + ψ-automation +
trust**, not physics or solver work. The Operator's example details are all
orthogonal → squarely inside the trusted envelope (no staircasing).

Sequenced gap (rough effort in vibe-sessions; estimates soft, UX is the uncertain
part). Order: each lands green + committed so stopping partway degrades gracefully.

1. **Authoring — the dominant cost (this is S2-M3, promoted in importance).**
   Define a construction without editing `model.mjs`. The data model already
   exists (presets *are* boxes+materials+BCs JSON), so JSON load/validate is ~1
   session; the lift is an **interactive 2D cross-section editor** (draw rects,
   extrude) + **click-a-face BC assignment** ("indoors 20 °C / outdoors / adiabatic
   / ground") — the fiddly, ~0.7-odds part. 2D-cross-section-first covers the bulk
   of ψ work for far less than a full 3D modeller. ~4–6 sessions.
2. **Auto-ψ / L2D from picked surfaces** (BACKLOG 2026-06-23; standout value).
   Pick the interior surface → Φ via `regionFlux` → L2D; semi-automatic flank
   U-values → ψ. Removes the hardcoded `psiSpec`. Reuses the face-pick machinery
   from (1). ~2–3 sessions.
3. **Material editor** — add/edit λ,ρ,c. Data model trivial; UI only. ~1 session.
4. **Trust guardrails** — authored models shift risk from solver bugs (gated) to
   *user* error: grid-convergence check, BC/flux-balance sanity readout, the
   staircasing warning surfaced on non-orthogonal geometry. This is what makes it
   *relied-upon*, not just *capable*. ~1–2 sessions.
5. **Perf (S2-M2)** — needed for interactive **3D** details (the real moat: a 3D
   corner f_Rsi that 2D catalogues structurally can't find). The basement3d strain
   is the **iteration-bound** steady ground solve (~287 CG it) → a **multigrid
   preconditioner (pure JS, buildless) is the bigger, safer 5–10× lever**;
   WebGPU/WASM matvec is the second lever, *with profiling numbers first* (ROADMAP
   S2-M2 is profile-first / pure-JS-first by design). Not needed for 2D work.

**Bottom line:** ~8–12 sessions to a usable general **2D** ψ/f_Rsi tool; +perf for
interactive 3D corners. Caveats stay: sloped/curved out (staircasing — needs the
2D-triangle v0.2 upgrade, OPERATOR_NOTES §2); 3D point bridges (χ) not modelled (2D
ψ + 3D-corner f_Rsi cover most catalogue work); going "general" is a deliberate
scope step up from "validated demo of specific details" (hence the guardrails item).
Also fold in the small polish (BACKLOG 2026-06-23): bigger flux arrows + a
steady-only / component-separated field view.

---

## Parallel track T1 — Norm-Explainer app (SEPARATE repo)

Not a PHASOR milestone — different quality model (human-reviewed content vs. gated
numerics) and release cadence. Pattern proven by the bundled Trittschall app:
citation-as-data (`references.js`: norm/clause/page + PDF deep-link) and a
calculator core verified against the standard's own annex example (`verify.js`).
Build the 13370 + 12831 equivalent. Joined to PHASOR **only** by the S2-M1.6 JSON
handoff; PHASOR never grows the citation DB. IP: a private colleague circle is the
normal grey zone; bright line is don't publish PDFs / full tables on the open web.

## Parked (still in BACKLOG, not promoted)
Acoustics fork (2026-06-19); mesh-quality corner-diagonal grading (2026-06-12);
`slab_junction` milder catalogue figure (2026-06-18); orbit-rotate watch.

## Resolved
- **Where the 13370/12831 closed forms live** (was "before M1.5"): **(a)** — a pure
  `src/standards.mjs` in PHASOR, annex calibration under `node --test`. Done
  (M1.5 part 1, `12eb0a9`). Norm PDFs stay gitignored (IP).
- **M1.5 part 2 (comparison panel + steady-baseline pinning) — PARKED** (Operator,
  2026-06-23): closed M1 after export with the comparison deferred. It's the loose,
  cross-method modelling bit (13370 ≈ 36.5 vs PHASOR ≈ 49.9 W/m, ratio 0.73); pick
  it up when wanted, ideally sitting on the reworked 3D cut + the general-tool work.
