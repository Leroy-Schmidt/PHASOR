// M1 gate tests (DESIGN.md §6, milestone M1) — written BEFORE the solver.
//   G1.1  wall1d vs series-resistance oracle, < 1e-6 K on the coarse mesh
//   G1.2  2D Laplace benchmark, max-norm error ratio ∈ [3.2, 4.8] (O(h²))
//   G1.3  global flux balance < 1e-6 of throughput
//   G1.4  mirror-symmetric preset → field symmetric < 1e-9 relative
// (G1.5 is the human gate — Operator checklist, not automatable.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeIndex } from '../src/grid.mjs';
import { MATERIALS, wall1d, corner2d } from '../src/model.mjs';
import { boundaryFlux } from '../src/fem.mjs';
import { wallSeriesResistance } from '../src/physics.mjs';
import { solveSteady, steadyReadouts } from '../src/worker.mjs';

const SOLVE = { tol: 1e-12, maxIter: 30000 };

function layersOf(preset) {
  // wall1d boxes are the layers, exterior → interior
  return preset.boxes.map((b) => ({ material: b.material, thickness: b.x[1] - b.x[0] }));
}

// ------------------------------------------------------------------- G1.1

test('G1.1 — wall1d interface temperatures match the series-resistance oracle to < 1e-6 K', () => {
  const preset = wall1d();
  const { grid, T, converged, relRes } = solveSteady(preset, MATERIALS, SOLVE);
  assert.ok(converged, `solver did not converge (relRes ${relRes})`);

  const oracle = wallSeriesResistance(layersOf(preset), MATERIALS,
    { Rsi: 0.13, Rse: 0.04, Ti: 20, Te: 9 });

  let worst = 0;
  for (const { x, T: Texact } of oracle.interfaces) {
    let i = -1;
    for (let m = 0; m <= grid.nx; m++) {
      if (Math.abs(grid.xs[m] - x) <= 1e-12) { i = m; break; }
    }
    assert.ok(i >= 0, `interface x=${x} is not a grid line`);
    for (let k = 0; k <= grid.nz; k++) {
      for (let j = 0; j <= grid.ny; j++) {
        const err = Math.abs(T[nodeIndex(grid, i, j, k)] - Texact);
        if (err > worst) worst = err;
      }
    }
  }
  assert.ok(worst < 1e-6, `max interface-temperature error ${worst} K (gate: < 1e-6 K)`);
});

// ------------------------------------------------------------------- G1.2

function laplaceModel(n) {
  return {
    name: `laplace${n}`,
    boxes: [{ name: 'plate', x: [0, 1], y: [0, 1], z: [0, 0.1], material: 'unit' }],
    background: 'void',
    bcs: [
      { name: 'top', select: { axis: 'y', side: 'max' }, type: 'dirichlet',
        value: (x) => Math.sin(Math.PI * x) },
      { name: 'bottom', select: { axis: 'y', side: 'min' }, type: 'dirichlet', value: 0 },
      { name: 'left', select: { axis: 'x', side: 'min' }, type: 'dirichlet', value: 0 },
      { name: 'right', select: { axis: 'x', side: 'max' }, type: 'dirichlet', value: 0 },
      { name: 'cuts', select: 'rest', type: 'adiabatic' },
    ],
    gridSpec: {
      x: { mandatory: [0, 1], maxH: 1 / n },
      y: { mandatory: [0, 1], maxH: 1 / n },
      z: { mandatory: [0, 0.1], maxH: 1, minCells: 1 },
    },
  };
}

function laplaceMaxError(n) {
  const preset = laplaceModel(n);
  const { grid, T, converged } = solveSteady(preset, { unit: { lambda: 1 } }, SOLVE);
  assert.ok(converged, `laplace ${n}×${n} did not converge`);
  const sinhPi = Math.sinh(Math.PI);
  let worst = 0;
  for (let k = 0; k <= grid.nz; k++) {
    for (let j = 0; j <= grid.ny; j++) {
      for (let i = 0; i <= grid.nx; i++) {
        const exact = Math.sin(Math.PI * grid.xs[i]) * Math.sinh(Math.PI * grid.ys[j]) / sinhPi;
        const err = Math.abs(T[nodeIndex(grid, i, j, k)] - exact);
        if (err > worst) worst = err;
      }
    }
  }
  return worst;
}

test('G1.2 — 2D Laplace benchmark converges at O(h²): error ratio ∈ [3.2, 4.8]', () => {
  const e8 = laplaceMaxError(8);
  const e16 = laplaceMaxError(16);
  const e32 = laplaceMaxError(32);
  for (const [coarse, fine, label] of [[e8, e16, '8→16'], [e16, e32, '16→32']]) {
    const ratio = coarse / fine;
    assert.ok(ratio >= 3.2 && ratio <= 4.8,
      `${label}: error ratio ${ratio} outside [3.2, 4.8] (errors ${coarse} → ${fine})`);
  }
});

// ------------------------------------------------------------------- G1.3

test('G1.3 — global flux balance: |ΣΦ_r| < 1e-6 · throughput on wall1d and corner2d', () => {
  for (const preset of [wall1d(), corner2d()]) {
    const { problem, T, converged } = solveSteady(preset, MATERIALS, SOLVE);
    assert.ok(converged, `${preset.name} did not converge`);
    const { byRegion, imbalance, throughput } = boundaryFlux(problem, T);
    assert.ok(throughput > 0, `${preset.name}: no boundary throughput`);
    assert.ok(imbalance < 1e-6 * throughput,
      `${preset.name}: imbalance ${imbalance} W vs throughput ${throughput} W ` +
      `(regions: ${JSON.stringify(byRegion)})`);
  }
});

test('G1.3 cross-check — wall1d exterior flux equals U·ΔT·A from the oracle', () => {
  const preset = wall1d();
  const { problem, T } = solveSteady(preset, MATERIALS, SOLVE);
  const { U } = wallSeriesResistance(layersOf(preset), MATERIALS,
    { Rsi: 0.13, Rse: 0.04, Ti: 20, Te: 9 });
  const expected = U * 11 * 0.1 * 0.1; // heat leaving through the exterior face
  const phiExt = boundaryFlux(problem, T).byRegion.exterior;
  assert.ok(phiExt > 0, 'heat flows out through the exterior in winter');
  assert.ok(Math.abs(phiExt - expected) < 1e-6 * expected,
    `Φ_ext ${phiExt} W vs U·ΔT·A ${expected} W`);
});

// ------------------------------------------------------------------- G1.4

test('G1.4 — corner2d field is x↔y mirror symmetric to < 1e-9 relative', () => {
  const preset = corner2d();
  const { grid, problem, T, converged } = solveSteady(preset, MATERIALS, SOLVE);
  assert.ok(converged);
  assert.equal(grid.nx, grid.ny, 'symmetric preset must produce a symmetric grid');
  for (let i = 0; i <= grid.nx; i++) {
    assert.equal(grid.xs[i], grid.ys[i], `tick ${i}: xs ${grid.xs[i]} vs ys ${grid.ys[i]}`);
  }
  let tMin = Infinity;
  let tMax = -Infinity;
  let worst = 0;
  for (let k = 0; k <= grid.nz; k++) {
    for (let j = 0; j <= grid.ny; j++) {
      for (let i = 0; i <= grid.nx; i++) {
        const a = nodeIndex(grid, i, j, k);
        const b = nodeIndex(grid, j, i, k);
        assert.equal(problem.active[a], problem.active[b], 'active mask symmetric');
        if (!problem.active[a]) continue;
        const d = Math.abs(T[a] - T[b]);
        if (d > worst) worst = d;
        if (T[a] < tMin) tMin = T[a];
        if (T[a] > tMax) tMax = T[a];
      }
    }
  }
  const range = tMax - tMin;
  assert.ok(range > 1, `suspicious temperature range ${range} K`);
  assert.ok(worst < 1e-9 * range,
    `asymmetry ${worst} K vs 1e-9 · range ${range} K = ${1e-9 * range}`);
});

// ------------------------------------------- readouts (worker logic, no DOM)

test('readouts: corner2d f_Rsi ∈ (0,1), below the flat wall, ψ labelled external', () => {
  const wall = steadyReadouts(wall1d(), MATERIALS, SOLVE);
  const corner = steadyReadouts(corner2d(), MATERIALS, SOLVE);
  assert.equal(wall.readouts.RsiUsed, 0.25, 'f_Rsi solve must use R_si = 0.25');
  assert.ok(corner.readouts.fRsi > 0 && corner.readouts.fRsi < 1,
    `corner f_Rsi ${corner.readouts.fRsi}`);
  assert.ok(corner.readouts.fRsi < wall.readouts.fRsi,
    `corner (${corner.readouts.fRsi}) must be colder than the flat wall (${wall.readouts.fRsi})`);
  assert.equal(wall.readouts.psi, null, 'wall1d has no ψ (not an extruded junction)');
  assert.equal(corner.readouts.psi.convention, 'external');
  assert.ok(Number.isFinite(corner.readouts.psi.psi));
});
