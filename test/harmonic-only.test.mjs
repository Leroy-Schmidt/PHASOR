// S2-G1.3 (ROADMAP S2-M1.3) — the harmonic-only / DC-subtracted view rests on the
// harmonic field being purely AC: no steady/DC must leak into the ω>0 drive.
//
// "It goes flat", as a number: a heavy wall kills the daily (diurnal) swing, so
// the interior surface |T̂| is a tiny fraction of the outdoor drive. The classic
// failure this guards is a steady/mean DC term leaking into the harmonic load —
// that would floor the interior |T̂| to order-1 (≈ the mean ΔT) and fail here.
// Written before the view it underpins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATERIALS, wall1d, corner2d } from '../src/model.mjs';
import { solveHarmonic } from '../src/worker.mjs';
import { regionNodes } from '../src/fem.mjs';
import { amplitude, OMEGA_BY_FREQ } from '../src/physics.mjs';

const SOLVE = { tol: 1e-9, maxIter: 20000 };

// measured interior/peak ratios: wall1d 2.2e-3, corner2d 4.1e-3 — both ≪ 1%.
// A DC leak would push the interior to ~order-1, so the 1% bar separates the two
// regimes by ~100×.
for (const make of [wall1d, corner2d]) {
  const def = make();
  test(`S2-G1.3 — ${def.name}: the diurnal swing dies in the wall (interior |T̂| < 1% of peak, no DC leak)`, () => {
    const { problem, Tre, Tim, converged } = solveHarmonic(
      def, MATERIALS, { omega: OMEGA_BY_FREQ.diurnal, ...SOLVE });
    assert.ok(converged, `${def.name} diurnal did not converge`);

    let peak = 0;
    for (let n = 0; n < Tre.length; n++) peak = Math.max(peak, amplitude(Tre[n], Tim[n]));
    assert.ok(peak > 1, `expected a real outdoor drive (peak |T̂| = ${peak})`);

    let interior = 0;
    for (const n of regionNodes(problem, 'interior')) {
      interior = Math.max(interior, amplitude(Tre[n], Tim[n]));
    }
    const ratio = interior / peak;
    assert.ok(ratio < 0.01,
      `${def.name}: interior/peak |T̂| = ${ratio.toExponential(2)} (≥ 1% — DC leaking into the AC drive?)`);
  });
}
