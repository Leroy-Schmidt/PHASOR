// S2-G1.4 (ROADMAP S2-M1.4) — the annual heat-loss curve, by superposition.
//   G1.4a: the reconstructed curve (per-harmonic region-flux phasors superposed)
//          equals the direct calculation (instantaneous field → cellFlux →
//          regionFlux) to solver tol — two independent routes to Φ(t), the
//          independent-oracle discipline applied to the loss curve.
//   G1.4b: the air case solves, and its annual-mean loss exceeds the earth case
//          (soil insulates + damps) — correct sign.
// Written before the worker wiring / chart they feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATERIALS, basement, basement_air } from '../src/model.mjs';
import { solveSteady, solveHarmonic } from '../src/worker.mjs';
import { cellFlux, regionFlux } from '../src/flux.mjs';
import { regionFluxReal, regionFluxPhasor, lossCurveSamples } from '../src/losscurve.mjs';
import { OMEGA_BY_FREQ } from '../src/physics.mjs';

const SOLVE = { tol: 1e-10, maxIter: 20000 };
const HSOLVE = { tol: 1e-9, maxIter: 20000 };
const FREQS = ['annual', 'diurnal'];
const REGION = 'interior';

function solveAll(def) {
  const { problem, T: mean } = solveSteady(def, MATERIALS, SOLVE);
  const harm = FREQS.map((f) => {
    const omega = OMEGA_BY_FREQ[f];
    const { Tre, Tim } = solveHarmonic(def, MATERIALS, { omega, ...HSOLVE });
    return { f, omega, Tre, Tim };
  });
  return { problem, mean, harm };
}

// ------------------------------------------------------------------ G1.4a
test('S2-G1.4a — loss curve: phasor superposition == direct instantaneous integration', () => {
  const { problem, mean, harm } = solveAll(basement());

  // way 1: region-flux phasors, superposed
  const meanPhi = regionFluxReal(problem, mean, REGION);
  const phasors = harm.map((h) => ({ omega: h.omega, ...regionFluxPhasor(problem, h.Tre, h.Tim, REGION) }));
  const N = 24;
  const { period, t, phi: recon } = lossCurveSamples(meanPhi, phasors, N);

  // way 2: build the instantaneous nodal field at each t, then integrate the flux
  let worst = 0;
  const scale = Math.abs(meanPhi) || 1;
  for (let s = 0; s < N; s++) {
    const Tt = new Float64Array(mean.length);
    for (let n = 0; n < mean.length; n++) {
      let v = mean[n];
      for (const h of harm) v += h.Tre[n] * Math.cos(h.omega * t[s]) - h.Tim[n] * Math.sin(h.omega * t[s]);
      Tt[n] = v;
    }
    const direct = regionFlux(problem, cellFlux(problem, Tt), REGION);
    worst = Math.max(worst, Math.abs(recon[s] - direct));
  }
  assert.ok(period > 3e7 && period < 3.2e7, `period should be ~1 year, got ${period}`);
  assert.ok(worst / scale < 1e-7,
    `reconstruction vs direct: worst ${worst.toExponential(3)} W (rel ${(worst / scale).toExponential(2)})`);
});

// ------------------------------------------------------------------ G1.4b
test('S2-G1.4b — annual-mean loss: air case > earth case (soil insulates + damps)', () => {
  const earth = solveSteady(basement(), MATERIALS, SOLVE);
  const air = solveSteady(basement_air(), MATERIALS, SOLVE);
  assert.ok(earth.converged, 'earth case did not converge');
  assert.ok(air.converged, 'air case did not converge');

  const earthPhi = Math.abs(regionFluxReal(earth.problem, earth.T, REGION));
  const airPhi = Math.abs(regionFluxReal(air.problem, air.T, REGION));
  assert.ok(earthPhi > 0 && airPhi > 0, `expected non-zero losses (earth ${earthPhi}, air ${airPhi})`);
  assert.ok(airPhi > earthPhi,
    `air loss ${airPhi.toFixed(3)} W should exceed earth loss ${earthPhi.toFixed(3)} W`);
});
