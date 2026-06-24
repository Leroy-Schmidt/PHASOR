// S2-G2.B (ROADMAP S2-M2.2) — operator equivalence gate for the CSR assembly
// that the WebGPU SpMV is built on. The GPU path can't run under `node --test`,
// but the CSR *operator* is pure fp64 JS and IS node-testable: prove that
// csrSpMV(assembleCSR(problem)) reproduces the matrix-free applyA on every preset,
// for random vectors, to summation round-off. This is the G-A "operator
// equivalence vs JS applyA" gate, locked down in node before any GPU code — a
// botched CSR (wrong masking, missed Robin term, bad index) shows up here.
// Written WITH the assembly, before the GPU kernel it underpins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, paintBoxes } from '../src/grid.mjs';
import { MATERIALS, presets } from '../src/model.mjs';
import { assemble, applyA, applyAComplex, assembleCSR, assembleCSRImag } from '../src/fem.mjs';
import { csrSpMV, csrSpMVComplex } from '../src/csr.mjs';
import { OMEGA_BY_FREQ } from '../src/physics.mjs';

function buildProblem(name, params = {}) {
  const def = presets[name](params);
  const grid = buildGrid(def.gridSpec);
  const painted = paintBoxes(grid, def.boxes, def.background);
  return assemble(grid, painted, MATERIALS, def.bcs);
}

// deterministic pseudo-random vector (no test flakiness)
function randVec(n, seed) {
  const x = new Float64Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    x[i] = (s / 0xffffffff) * 2 - 1; // [-1, 1)
  }
  return x;
}

const CASES = [
  ['wall1d', {}], ['corner2d', {}], ['slab_junction', {}],
  ['basement', {}], ['basement3d', {}], ['soil_rod', {}],
];

for (const [name, params] of CASES) {
  test(`S2-G2.B — assembleCSR/csrSpMV reproduces applyA on ${name}`, () => {
    const problem = buildProblem(name, params);
    const csr = assembleCSR(problem);
    const n = problem.nNodes;
    assert.equal(csr.n, n);

    const ya = new Float64Array(n);
    const yc = new Float64Array(n);
    let worst = 0;
    let scale = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const x = randVec(n, seed * 7919);
      applyA(problem, x, ya);
      csrSpMV(csr, x, yc);
      for (let i = 0; i < n; i++) {
        worst = Math.max(worst, Math.abs(ya[i] - yc[i]));
        scale = Math.max(scale, Math.abs(ya[i]));
      }
    }
    // summation-order round-off only — far below the 1e-12 relative gate
    assert.ok(worst <= 1e-12 * Math.max(scale, 1),
      `${name}: max |applyA − csrSpMV| = ${worst.toExponential(3)} (scale ${scale.toExponential(2)})`);
  });
}

// Complex operator: assembleCSR (K+H) + assembleCSRImag (ωC) applied via
// csrSpMVComplex must reproduce the matrix-free applyAComplex — the G-A gate for
// the harmonic GPU SpMV, locked in node before the complex GPU kernels.
for (const [name, params] of CASES) {
  for (const freq of ['annual', 'diurnal']) {
    test(`S2-G2.B-im — complex CSR reproduces applyAComplex on ${name}/${freq}`, () => {
      const problem = buildProblem(name, params);
      const omega = OMEGA_BY_FREQ[freq];
      const csrRe = assembleCSR(problem);
      const csrIm = assembleCSRImag(problem, omega);
      const n = problem.nNodes;
      const yReA = new Float64Array(n), yImA = new Float64Array(n);
      const yReC = new Float64Array(n), yImC = new Float64Array(n);
      let worst = 0;
      let scale = 0;
      for (let seed = 1; seed <= 2; seed++) {
        const xRe = randVec(n, seed * 7919);
        const xIm = randVec(n, seed * 104729);
        applyAComplex(problem, omega, xRe, xIm, yReA, yImA);
        csrSpMVComplex(csrRe, csrIm, xRe, xIm, yReC, yImC);
        for (let i = 0; i < n; i++) {
          worst = Math.max(worst, Math.abs(yReA[i] - yReC[i]), Math.abs(yImA[i] - yImC[i]));
          scale = Math.max(scale, Math.abs(yReA[i]), Math.abs(yImA[i]));
        }
      }
      assert.ok(worst <= 1e-12 * Math.max(scale, 1),
        `${name}/${freq}: max |applyAComplex − csrSpMVComplex| = ${worst.toExponential(3)} (scale ${scale.toExponential(2)})`);
    });
  }
}

test('S2-G2.B — CSR is structurally sound (free rows have a diagonal, identity rows for constrained)', () => {
  const problem = buildProblem('corner2d');
  const { rowPtr, colIdx, vals, n } = assembleCSR(problem);
  const { free } = problem;
  for (let r = 0; r < n; r++) {
    let diag = 0;
    let count = 0;
    for (let p = rowPtr[r]; p < rowPtr[r + 1]; p++) { count++; if (colIdx[p] === r) diag = vals[p]; }
    if (free[r]) {
      assert.ok(diag > 0, `free row ${r} must have a positive diagonal, got ${diag}`);
    } else {
      assert.equal(count, 1, `constrained row ${r} must be a single identity entry`);
      assert.equal(diag, 1, `constrained row ${r} diagonal must be 1`);
    }
  }
});
