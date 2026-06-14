// soil_rod — off-script teaching/validation preset (Operator decision 2026-06-14).
// A 1-D soil column: exterior climate forcing on top, deep far-field Dirichlet
// at T_mean, adiabatic sides. The textbook semi-infinite solid, made visible.
// These tests also lock in the harmonic far-field convention T̂_k = 0 (DESIGN
// §2.2) that solveHarmonic now imposes by default — the fix the M3 basement needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeIndex } from '../src/grid.mjs';
import { MATERIALS, soil_rod } from '../src/model.mjs';
import { solveHarmonic } from '../src/worker.mjs';
import { OMEGA_ANNUAL, penetrationDepth, amplitude, timeLag } from '../src/physics.mjs';

test('solveHarmonic default imposes the far-field harmonic convention T̂=0 at Dirichlet nodes', () => {
  const preset = soil_rod({ depth: 6, maxH: 0.15 });
  const { problem, Tre, Tim, converged } = solveHarmonic(preset, MATERIALS,
    { omega: OMEGA_ANNUAL, tol: 1e-10, maxIter: 50000 });
  assert.ok(converged);
  let nDir = 0;
  let worst = 0;
  for (let n = 0; n < problem.nNodes; n++) {
    if (!problem.isDirichlet[n]) continue;
    nDir++;
    worst = Math.max(worst, Math.abs(Tre[n]), Math.abs(Tim[n]));
  }
  assert.ok(nDir > 0, 'soil_rod has a deep Dirichlet face');
  assert.ok(worst < 1e-12, `harmonic field at far-field Dirichlet should be 0, got ${worst}`);
});

test('soil_rod annual amplitude decays as e^{−d/δ} into the soil, lag grows with depth', () => {
  const preset = soil_rod({ depth: 10, maxH: 0.1 });
  const { grid, Tre, Tim, converged } = solveHarmonic(preset, MATERIALS,
    { omega: OMEGA_ANNUAL, tol: 1e-11, maxIter: 50000 });
  assert.ok(converged);

  const { lambda, rho, c } = MATERIALS.soil;
  const delta = penetrationDepth(lambda, rho, c, OMEGA_ANNUAL); // ≈ 2.84 m

  // sample along the column at mid-x / mid-z; y = depth is the surface, y = 0 deep
  const surfaceY = grid.ys[grid.ny];
  const jOf = (yTarget) => {
    let best = 0;
    for (let j = 0; j <= grid.ny; j++) {
      if (Math.abs(grid.ys[j] - yTarget) < Math.abs(grid.ys[best] - yTarget)) best = j;
    }
    return best;
  };
  const i = Math.round(grid.nx / 2);
  const k = Math.round(grid.nz / 2);
  const sample = (d) => {
    const j = jOf(surfaceY - d); // d = depth below the surface
    const n = nodeIndex(grid, i, j, k);
    return { amp: amplitude(Tre[n], Tim[n]), lag: timeLag(Tre[n], Tim[n], OMEGA_ANNUAL) };
  };

  // decay rate over the well-resolved interior (away from surface BC and far end)
  for (const d of [1, 2, 3]) {
    const here = sample(d);
    const next = sample(d + 1);
    const ratio = next.amp / here.amp;
    const expected = Math.exp(-1 / delta); // ≈ 0.703 per metre
    assert.ok(Math.abs(ratio / expected - 1) < 0.05,
      `amplitude decay ${ratio.toFixed(4)} vs e^{−1/δ} ${expected.toFixed(4)} at d=${d} m`);
    assert.ok(next.lag > here.lag, `lag must grow with depth (d=${d}→${d + 1} m)`);
  }

  // the annual wave genuinely penetrates metres: still ~1/e of surface at one δ
  const near = sample(0.3);   // just below the surface film
  const oneDelta = sample(delta);
  const rel = oneDelta.amp / near.amp;
  assert.ok(rel > 0.28 && rel < 0.45,
    `amplitude at one δ should be ~37 % of near-surface, got ${(rel * 100).toFixed(1)} %`);
});
