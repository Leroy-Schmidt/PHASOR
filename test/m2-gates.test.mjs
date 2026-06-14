// M2 gate tests (DESIGN.md §6, milestone M2) — written BEFORE the harmonic solver.
//   G2.1  semi-infinite: |T̂| vs A·e^{−x/δ}, lag vs x/δ within 1%, O(h²), both ω
//   G2.2  multilayer wall1d inner-surface phasor vs the ISO-13786 Python oracle, 0.5%
//   G2.3  10³-node grid: COCG vs dense complex-LU oracle, relative diff < 1e-8
//   G2.4  phase direction: time lag strictly increases with depth (anti-conjugation)
//   G2.5  performance: 48³, one frequency, COCG solve < 10 s
// (G2.4's human half and G2.2's semi-auto oracle run are Operator checklist items.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, paintBoxes, nodeIndex } from '../src/grid.mjs';
import { MATERIALS, wall1d } from '../src/model.mjs';
import { assemble, applyAComplex, assembleHarmonicLoad, regionNodes } from '../src/fem.mjs';
import { cocg, denseLUSolveComplex } from '../src/solver.mjs';
import {
  OMEGA_ANNUAL, OMEGA_DIURNAL, penetrationDepth, amplitude, timeLag,
} from '../src/physics.mjs';
import { solveHarmonic } from '../src/worker.mjs';

const DEG = Math.PI / 180;

// ------------------------------------------------------------------- G2.1
// Prescribed-surface semi-infinite slab: T̂(0)=1, far end T̂=0, lateral adiabatic.
// Exact: T̂(x) = e^{−(1+i)x/δ} → |T̂| = e^{−x/δ}, arg = −x/δ.

function slabModel(material, L, nx) {
  const lat = 0.1;
  return {
    name: 'slab',
    boxes: [{ name: 'slab', x: [0, L], y: [0, lat], z: [0, lat], material }],
    background: 'air',
    bcs: [
      { name: 'surf', select: { axis: 'x', side: 'min' }, type: 'dirichlet', value: 1 },
      { name: 'far', select: { axis: 'x', side: 'max' }, type: 'dirichlet', value: 0 },
      { name: 'cuts', select: 'rest', type: 'adiabatic' },
    ],
    gridSpec: {
      x: { mandatory: [0, L], maxH: L / nx, minCells: nx },
      y: { mandatory: [0, lat], maxH: lat / 2, minCells: 2 },
      z: { mandatory: [0, lat], maxH: lat / 2, minCells: 2 },
    },
  };
}

function slabFields(material, omega, cellsPerDelta) {
  const { lambda, rho, c } = MATERIALS[material];
  const delta = penetrationDepth(lambda, rho, c, omega);
  // 12δ deep so the far Dirichlet (T̂=0) is e^{−24} below the surface — the
  // semi-infinite closed form is then the exact finite-domain solution to far
  // beyond mesh accuracy, leaving a clean O(h²) discretization error.
  const L = 12 * delta;
  const nx = Math.round(12 * cellsPerDelta);
  const model = slabModel(material, L, nx);
  // dirichlet:'value' — here the prescribed surface temperature (Dirichlet
  // value 1) IS the harmonic forcing, not a zero far-field.
  const { grid, problem, Tre, Tim, converged, relRes } =
    solveHarmonic(model, MATERIALS, { omega, tol: 1e-12, maxIter: 50000, dirichlet: 'value' });
  assert.ok(converged, `slab ${material} did not converge (relRes ${relRes})`);
  const j = 1;
  const k = 1;
  const xs = [];
  const amp = [];
  const lag = [];
  for (let i = 0; i <= grid.nx; i++) {
    const n = nodeIndex(grid, i, j, k);
    if (!problem.active[n]) continue;
    xs.push(grid.xs[i]);
    amp.push(amplitude(Tre[n], Tim[n]));
    lag.push(-Math.atan2(Tim[n], Tre[n])); // expected x/δ (radians)
  }
  return { delta, xs, amp, lag };
}

function maxAmpErr(f) {
  let m = 0;
  for (let i = 0; i < f.xs.length; i++) {
    if (f.xs[i] > 3 * f.delta) break;
    m = Math.max(m, Math.abs(f.amp[i] - Math.exp(-f.xs[i] / f.delta)));
  }
  return m;
}

for (const [name, omega] of [['diurnal', OMEGA_DIURNAL], ['annual', OMEGA_ANNUAL]]) {
  test(`G2.1 — semi-infinite (${name}): amplitude & lag within 1%, O(h²) convergence`, () => {
    const coarse = slabFields('concrete', omega, 10);
    const fine = slabFields('concrete', omega, 20);

    // O(h²): halving h cuts the max amplitude error by ~4×
    const ratio = maxAmpErr(coarse) / maxAmpErr(fine);
    assert.ok(ratio >= 3.2 && ratio <= 4.8,
      `${name}: O(h²) ratio ${ratio} outside [3.2, 4.8]`);

    // 1% on the fine mesh, over the well-resolved band 0.5δ ≤ x ≤ 2δ
    let worstAmp = 0;
    let worstLag = 0;
    for (let i = 0; i < fine.xs.length; i++) {
      const xn = fine.xs[i] / fine.delta;
      if (xn < 0.5 || xn > 2) continue;
      worstAmp = Math.max(worstAmp, Math.abs(fine.amp[i] - Math.exp(-xn)) / Math.exp(-xn));
      worstLag = Math.max(worstLag, Math.abs(fine.lag[i] - xn) / xn);
    }
    assert.ok(worstAmp < 0.01, `${name}: amplitude error ${(worstAmp * 100).toFixed(3)}% > 1%`);
    assert.ok(worstLag < 0.01, `${name}: lag error ${(worstLag * 100).toFixed(3)}% > 1%`);
  });
}

// ------------------------------------------------------------------- G2.2
// Inner-surface phasor of the default wall1d vs tools/iso13786_oracle.py.
// Regenerate the reference with:
//   & "C:\Users\Nutzer\miniconda3\python.exe" tools/iso13786_oracle.py
// External air driven at unit amplitude (T̂_e = 1), internal air constant (0).

const ORACLE = {
  annual: { omega: OMEGA_ANNUAL, amp: 2.541521e-2, argDeg: -1.596 },
  diurnal: { omega: OMEGA_DIURNAL, amp: 2.180974e-3, argDeg: -179.651 },
};

function fineWall1d() {
  const m = wall1d();
  m.gridSpec = { ...m.gridSpec, x: { ...m.gridSpec.x, maxH: 0.0025 } };
  return m;
}

for (const [name, ref] of Object.entries(ORACLE)) {
  test(`G2.2 — wall1d inner-surface phasor (${name}) vs ISO-13786 oracle within 0.5%`, () => {
    const { problem, Tre, Tim, converged, relRes } = solveHarmonic(fineWall1d(), MATERIALS, {
      omega: ref.omega, tol: 1e-11, maxIter: 50000,
      ambient: { exterior: { re: 1, im: 0 }, interior: { re: 0, im: 0 } },
    });
    assert.ok(converged, `${name} did not converge (relRes ${relRes})`);

    const nodes = regionNodes(problem, 'interior');
    let re = 0;
    let im = 0;
    for (const n of nodes) { re += Tre[n]; im += Tim[n]; }
    re /= nodes.length;
    im /= nodes.length;

    const amp = amplitude(re, im);
    const lag = timeLag(re, im, ref.omega);
    const oracleLag = (-ref.argDeg * DEG) / ref.omega;

    const relAmp = Math.abs(amp / ref.amp - 1);
    const relLag = Math.abs(lag / oracleLag - 1);
    assert.ok(relAmp < 0.005,
      `${name}: |T̂_is| ${amp.toExponential(4)} vs oracle ${ref.amp.toExponential(4)} ` +
      `= ${(relAmp * 100).toFixed(3)}% > 0.5%`);
    assert.ok(relLag < 0.005,
      `${name}: time lag ${lag.toFixed(1)}s vs oracle ${oracleLag.toFixed(1)}s ` +
      `= ${(relLag * 100).toFixed(3)}% > 0.5%`);
  });
}

// ------------------------------------------------------------------- G2.3

function cubeProblem(nx, Lc, h) {
  const model = {
    boxes: [{ name: 'c', x: [0, Lc], y: [0, Lc], z: [0, Lc], material: 'concrete' }],
    background: 'air',
    bcs: [
      { name: 'exterior', select: { axis: 'x', side: 'min' }, type: 'robin', h, T: { mean: 0 } },
      { name: 'interior', select: 'rest', type: 'robin', h, T: { mean: 0 } },
    ],
    gridSpec: {
      x: { mandatory: [0, Lc], maxH: Lc / nx, minCells: 1 },
      y: { mandatory: [0, Lc], maxH: Lc / nx, minCells: 1 },
      z: { mandatory: [0, Lc], maxH: Lc / nx, minCells: 1 },
    },
  };
  const grid = buildGrid(model.gridSpec);
  const painted = paintBoxes(grid, model.boxes, model.background);
  return { grid, problem: assemble(grid, painted, MATERIALS, model.bcs) };
}

test('G2.3 — COCG vs dense complex-LU oracle agree to < 1e-8 on a ~10³-node grid', () => {
  const { problem } = cubeProblem(9, 0.3, 10); // 9³ cells → 10³ = 1000 nodes
  const omega = OMEGA_DIURNAL;
  const n = problem.nNodes;
  const apply = (xr, xi, yr, yi) => applyAComplex(problem, omega, xr, xi, yr, yi);
  const { bRe, bIm } = assembleHarmonicLoad(problem, omega,
    { exterior: { re: 1, im: 0 }, interior: { re: 0, im: 0 } });

  const diagIm = new Float64Array(n);
  for (let i = 0; i < n; i++) diagIm[i] = problem.free[i] ? omega * problem.diagC[i] : 0;

  const it = cocg({ apply, bRe, bIm, diagRe: problem.diag, diagIm, tol: 1e-12, maxIter: 20000 });
  assert.ok(it.converged, `COCG did not converge (relRes ${it.relRes})`);
  const lu = denseLUSolveComplex(n, apply, bRe, bIm);

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dr = it.xRe[i] - lu.xRe[i];
    const di = it.xIm[i] - lu.xIm[i];
    num += dr * dr + di * di;
    den += lu.xRe[i] * lu.xRe[i] + lu.xIm[i] * lu.xIm[i];
  }
  const rel = Math.sqrt(num / den);
  assert.ok(rel < 1e-8, `COCG vs dense-LU relative difference ${rel.toExponential(3)} > 1e-8`);
});

// ------------------------------------------------------------------- G2.4

test('G2.4 — time lag strictly increases with depth into wall1d (no anticipation)', () => {
  const omega = OMEGA_DIURNAL;
  const { grid, problem, Tre, Tim, converged } = solveHarmonic(fineWall1d(), MATERIALS, {
    omega, tol: 1e-11, maxIter: 50000,
    ambient: { exterior: { re: 1, im: 0 }, interior: { re: 0, im: 0 } },
  });
  assert.ok(converged);
  const j = 1;
  const k = 1;
  let prev = -Infinity;
  let count = 0;
  for (let i = 0; i <= grid.nx; i++) {
    const n = nodeIndex(grid, i, j, k);
    if (!problem.active[n]) continue;
    const lag = timeLag(Tre[n], Tim[n], omega);
    assert.ok(lag > prev,
      `lag not strictly increasing at x=${grid.xs[i].toFixed(4)}: ${lag} ≤ ${prev} ` +
      `(a wall that anticipates the weather has a conjugation/sign bug)`);
    prev = lag;
    count++;
  }
  assert.ok(count > 10, `expected many depth samples, got ${count}`);
});

// ------------------------------------------------------------------- G2.5

test('G2.5 — 48³, one frequency, COCG solve < 10 s', () => {
  const Lc = 1.0;
  const nx = 48;
  const model = {
    boxes: [{ name: 'c', x: [0, Lc], y: [0, Lc], z: [0, Lc], material: 'concrete' }],
    background: 'air',
    bcs: [
      { name: 'exterior', select: { axis: 'x', side: 'min' }, type: 'robin', h: 25, T: { mean: 0 } },
      { name: 'interior', select: 'rest', type: 'robin', h: 7.7, T: { mean: 0 } },
    ],
    gridSpec: {
      x: { mandatory: [0, Lc], maxH: Lc / nx, minCells: 1 },
      y: { mandatory: [0, Lc], maxH: Lc / nx, minCells: 1 },
      z: { mandatory: [0, Lc], maxH: Lc / nx, minCells: 1 },
    },
  };
  const t0 = globalThis.performance.now();
  const { grid, iterations, converged, relRes } = solveHarmonic(model, MATERIALS, {
    omega: OMEGA_DIURNAL, tol: 1e-8, maxIter: 5000,
    ambient: { exterior: { re: 1, im: 0 }, interior: { re: 0, im: 0 } },
  });
  const secs = (globalThis.performance.now() - t0) / 1000;
  assert.equal(grid.nx, 48, 'grid is 48 cells across');
  assert.ok(converged, `48³ did not converge in ${iterations} it (relRes ${relRes})`);
  assert.ok(secs < 10, `48³ one-frequency solve took ${secs.toFixed(2)} s (budget < 10 s)`);
});
