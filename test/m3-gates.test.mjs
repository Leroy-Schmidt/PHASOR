// M3 gate tests (DESIGN.md §6, milestone M3) — written BEFORE the presets.
//   G3.1  basement domain independence: double the soil box → inner-surface T
//         and Φ change < 1% (confirms domain ≥ 3·δ_annual)
//   G3.2  basement annual cycle: amplitude decay e^{−y/δ} and phase lag y/δ
//         down the soil column; ≈2 months at 3 m (the "cellar peaks in
//         September" story, out of the model not the doc). Auto half of a
//         human gate — the line probe is the Operator's visual.
//   G3.3  slab_junction ψ: sane finite value, external-dimension convention
//         (the ±15% catalogue comparison is the Operator's human sign-off)
//   G3.4  ω=0 collapse: harmonic path at ω=0 reproduces the steady solve
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeIndex } from '../src/grid.mjs';
import { MATERIALS, presets } from '../src/model.mjs';
import { boundaryFlux, regionNodes } from '../src/fem.mjs';
import { solveSteady, solveHarmonic, steadyReadouts } from '../src/worker.mjs';
import { OMEGA_ANNUAL, penetrationDepth, amplitude, timeLag } from '../src/physics.mjs';

const DAY = 86_400;

// ------------------------------------------------------------------- G3.1
// "Domain ≥ 3·δ_annual" is a PERIODIC statement: the annual wave (δ ≈ 2.84 m)
// must die before the truncation. So the δ-governed quantities — the steady
// inner-surface temperature and the *annual* inner-surface amplitude and flux —
// must be domain-independent (< 1%) when the soil box is doubled. (The steady
// TOTAL flux to the deep T_mean Dirichlet is genuinely long-range — a fixed-
// temperature sink, not a far field — and converges slowly with depth; its
// lateral far-field IS adequate, checked separately below. See VALIDATION /
// OPERATOR note: the deep-flux long-range behaviour is physics, not under-sizing.)

const G31_MAXH = 0.4; // domain independence is about boundary distance, not resolution

function basementMetrics(opts) {
  const def = presets.basement({ ...opts, maxH: G31_MAXH });
  const s = solveSteady(def, MATERIALS, { tol: 1e-10, maxIter: 60000 });
  assert.ok(s.converged, `basement steady did not converge (relRes ${s.relRes})`);
  const inner = regionNodes(s.problem, 'interior');
  let sumT = 0;
  for (const n of inner) sumT += s.T[n];
  const innerMeanT = sumT / inner.length;
  const steadyPhi = Math.abs(boundaryFlux(s.problem, s.T).byRegion.interior ?? NaN);

  const h = solveHarmonic(def, MATERIALS, { omega: OMEGA_ANNUAL, tol: 1e-9, maxIter: 60000 });
  assert.ok(h.converged, `basement annual did not converge (relRes ${h.relRes})`);
  let sumA = 0;
  let fre = 0;
  let fim = 0;
  for (const f of h.problem.robinFaces) {
    if (f.region !== 'interior') continue;
    let mr = 0;
    let mi = 0;
    for (const n of f.nodes) { mr += h.Tre[n]; mi += h.Tim[n]; }
    fre += f.h * f.area * (mr / 4); // interior harmonic ambient = 0
    fim += f.h * f.area * (mi / 4);
  }
  for (const n of inner) sumA += amplitude(h.Tre[n], h.Tim[n]);
  return { innerMeanT, steadyPhi, annualAmp: sumA / inner.length, annualFlux: Math.hypot(fre, fim) };
}

test('G3.1 — basement inner-surface T, annual amplitude & flux are domain-independent (< 1%)', () => {
  const base = basementMetrics({ soilPad: 9, soilDepth: 9 });
  const big = basementMetrics({ soilPad: 18, soilDepth: 18 });
  const lat = basementMetrics({ soilPad: 18, soilDepth: 9 }); // lateral-only doubling

  const rel = (a, b) => Math.abs(b - a) / Math.abs(a);
  const dT = rel(base.innerMeanT, big.innerMeanT);
  const dAmp = rel(base.annualAmp, big.annualAmp);
  const dFlux = rel(base.annualFlux, big.annualFlux);
  const dLatPhi = rel(base.steadyPhi, lat.steadyPhi); // steady lateral far-field

  assert.ok(dT < 0.01,
    `steady inner-surface T moved ${(dT * 100).toFixed(3)}% on doubling ` +
    `(${base.innerMeanT.toFixed(3)} → ${big.innerMeanT.toFixed(3)} °C) > 1%`);
  assert.ok(dAmp < 0.01,
    `annual inner-surface amplitude moved ${(dAmp * 100).toFixed(3)}% on doubling > 1%`);
  assert.ok(dFlux < 0.01,
    `annual inner-surface flux moved ${(dFlux * 100).toFixed(3)}% on doubling > 1%`);
  assert.ok(dLatPhi < 0.01,
    `steady Φ moved ${(dLatPhi * 100).toFixed(3)}% on lateral doubling ` +
    `(${base.steadyPhi.toFixed(4)} → ${lat.steadyPhi.toFixed(4)} W) > 1% — lateral far-field too small`);
});

// ------------------------------------------------------------------- G3.2
// Vertical soil column at mid-x (pure soil, away from the basement). The annual
// wave entering at grade decays e^{−y/δ} and lags y/δ radians going down. From
// 1 m to 4 m below grade (Δ = 3 m): amplitude ratio e^{−3/δ} ≈ 0.347 and lag
// difference 3/(δω) ≈ 61.5 days ≈ 2 months — the September story.

function soilColumn(def, Tre, Tim, grid, problem) {
  const i = Math.floor(grid.nx / 2);
  const k = Math.floor(grid.nz / 2);
  const x = grid.xs[i];
  const samples = [];
  for (let j = 0; j <= grid.ny; j++) {
    const n = nodeIndex(grid, i, j, k);
    if (!problem.active[n]) continue;
    samples.push({ y: grid.ys[j], amp: amplitude(Tre[n], Tim[n]), lag: timeLag(Tre[n], Tim[n], OMEGA_ANNUAL) });
  }
  return { x, samples };
}

function atDepth(samples, yTarget) {
  let best = samples[0];
  for (const s of samples) if (Math.abs(s.y - yTarget) < Math.abs(best.y - yTarget)) best = s;
  return best;
}

test('G3.2 — basement annual phase lag at depth: ≈2 months at 3 m (out of the model)', () => {
  const def = presets.basement({ soilPad: 9, soilDepth: 9 });
  const h = solveHarmonic(def, MATERIALS, { omega: OMEGA_ANNUAL, tol: 1e-9, maxIter: 40000 });
  assert.ok(h.converged, `basement annual did not converge (relRes ${h.relRes})`);

  const { x, samples } = soilColumn(def, h.Tre, h.Tim, h.grid, h.problem);
  const xWall = 2.3; // room + wall (see preset); mid-x must be pure soil
  assert.ok(x > xWall, `mid-x column at x=${x.toFixed(2)} is not in the soil (expected > ${xWall})`);

  const grade = h.grid.ys[h.grid.ny];
  const delta = penetrationDepth(MATERIALS.soil.lambda, MATERIALS.soil.rho, MATERIALS.soil.c, OMEGA_ANNUAL);
  const ref = atDepth(samples, grade - 1); // 1 m below grade
  const tgt = atDepth(samples, grade - 4); // 4 m below grade
  const dy = ref.y - tgt.y;                // ≈ 3 m

  // The September story is the PHASE LAG (DESIGN §6 G3.2: "read the phase lag,
  // compare with x/δ"): a ~3 m descent lags the surface wave by ~2 months, so
  // the cellar's annual maximum slips from July toward September. Compare the
  // model's lag to the soil-property prediction Δy/(δω).
  const lagDays = (tgt.lag - ref.lag) / DAY;
  const lagPredDays = (dy / delta) / OMEGA_ANNUAL / DAY;
  assert.ok(Math.abs(lagDays / lagPredDays - 1) < 0.15,
    `lag(${dy.toFixed(2)} m) = ${lagDays.toFixed(1)} d vs x/δ prediction ${lagPredDays.toFixed(1)} d ` +
    `= ${((lagDays / lagPredDays - 1) * 100).toFixed(1)}% off (> 15%)`);
  assert.ok(lagDays > 45 && lagDays < 70,
    `lag over ${dy.toFixed(2)} m = ${lagDays.toFixed(1)} d is outside the ~2-month window [45, 70]`);

  // Amplitude decays and lag grows monotonically going DOWN — no anticipation
  // (the conjugation/sign bug from G2.4 would break this). Restrict to the band
  // where |T̂| is well above the deep-Dirichlet zero (atan2 is noisy near 0).
  const band = samples.filter((s) => s.amp > 0.05 * samples[samples.length - 1].amp);
  for (let s = 1; s < band.length; s++) {
    // band runs y from deep (0) up to grade; going UP, lag must DECREASE and amp INCREASE
    assert.ok(band[s].lag <= band[s - 1].lag + 1e-6,
      `non-monotone lag near y=${band[s].y.toFixed(2)} (suspect a sign/conjugation bug)`);
    assert.ok(band[s].amp >= band[s - 1].amp - 1e-9,
      `amplitude not growing toward the surface near y=${band[s].y.toFixed(2)}`);
  }
});

// ------------------------------------------------------------------- G3.3
// slab_junction ψ readout (steady): finite, external-dimension convention, sane
// magnitude. The interrupted-insulation concrete slab is a real thermal bridge.

test('G3.3 — slab_junction reports a sane ψ in the external-dimension convention', () => {
  const def = presets.slab_junction();
  const { readouts } = steadyReadouts(def, MATERIALS, { tol: 1e-10, maxIter: 40000 });
  assert.ok(readouts.psi, 'slab_junction must report a ψ (it carries a psiSpec)');
  assert.equal(readouts.psi.convention, 'external');
  assert.ok(Number.isFinite(readouts.psi.psi), `ψ not finite: ${readouts.psi.psi}`);
  assert.ok(Number.isFinite(readouts.U) && readouts.U > 0, `U not sane: ${readouts.U}`);
  assert.ok(Math.abs(readouts.psi.psi) < 1.5,
    `ψ = ${readouts.psi.psi.toFixed(4)} W/(m·K) is implausibly large (|ψ| < 1.5 expected)`);
  // a slab that breaks the insulation conducts more than the plain wall stretch:
  // L_2D should exceed U·Σl by a positive margin (ψ > 0) for this detail.
  assert.ok(readouts.psi.psi > 0,
    `interrupted-insulation slab should give ψ > 0; got ${readouts.psi.psi.toFixed(4)}`);
});

// ------------------------------------------------------------------- G3.4
// With every harmonic amplitude zero, the harmonic operator at ω=0 is the M1
// real operator: solveHarmonic(ω=0) must reproduce solveSteady bit-for-bit
// (decoupled re/im; bIm=0 ⇒ Tim=0). Run on a Robin-only and a Robin+Dirichlet
// preset so both elimination paths are covered.

function assertCollapse(def, label) {
  const steady = solveSteady(def, MATERIALS, { tol: 1e-12, maxIter: 40000 });
  assert.ok(steady.converged, `${label}: steady did not converge`);
  // dirichlet:'value' so the ω=0 Dirichlet holds the steady value (T_mean),
  // matching solveSteady (default 'zero' would null a far-field harmonic).
  const harm = solveHarmonic(def, MATERIALS, { omega: 0, tol: 1e-12, maxIter: 40000, dirichlet: 'value' });
  assert.ok(harm.converged, `${label}: ω=0 harmonic did not converge`);

  let range = 0;
  for (let n = 0; n < steady.T.length; n++) range = Math.max(range, Math.abs(steady.T[n]));
  let maxReErr = 0;
  let maxIm = 0;
  for (let n = 0; n < steady.T.length; n++) {
    maxReErr = Math.max(maxReErr, Math.abs(harm.Tre[n] - steady.T[n]));
    maxIm = Math.max(maxIm, Math.abs(harm.Tim[n]));
  }
  assert.ok(maxReErr / range < 1e-8,
    `${label}: ω=0 Re field differs from steady by ${(maxReErr / range).toExponential(2)} (rel) > 1e-8`);
  assert.ok(maxIm / range < 1e-8,
    `${label}: ω=0 Im field nonzero, ${(maxIm / range).toExponential(2)} (rel) > 1e-8`);
}

test('G3.4 — ω=0 harmonic reproduces the steady solve (wall1d, Robin-only)', () => {
  assertCollapse(presets.wall1d(), 'wall1d');
});

test('G3.4 — ω=0 harmonic reproduces the steady solve (basement, Robin+Dirichlet)', () => {
  assertCollapse(presets.basement({ soilPad: 2, soilDepth: 2 }), 'basement');
});
