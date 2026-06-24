// M1 solver unit tests — written BEFORE src/solver.mjs.
// Jacobi-preconditioned CG (DESIGN.md §3.4, ω=0 branch): correctness on a
// known SPD system, convergence reporting, x0 handling, non-convergence flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cg, cocg, denseLUSolveComplex } from '../src/solver.mjs';

// SPD tridiagonal A = tridiag(-1, 3, -1), strictly diagonally dominant.
const N = 64;

function applyTridiag(x, y) {
  for (let i = 0; i < N; i++) {
    y[i] = 3 * x[i] - (i > 0 ? x[i - 1] : 0) - (i < N - 1 ? x[i + 1] : 0);
  }
}

function makeSystem() {
  const xTrue = new Float64Array(N);
  for (let i = 0; i < N; i++) xTrue[i] = Math.sin(0.37 * i) + 0.5;
  const b = new Float64Array(N);
  applyTridiag(xTrue, b);
  const diag = new Float64Array(N).fill(3);
  return { xTrue, b, diag };
}

test('CG solves an SPD tridiagonal system to the requested tolerance', () => {
  const { xTrue, b, diag } = makeSystem();
  const { x, iterations, relRes, converged } = cg({
    apply: applyTridiag, b, diag, tol: 1e-13, maxIter: 1000,
  });
  assert.ok(converged, `not converged, relRes ${relRes}`);
  assert.ok(relRes <= 1e-13);
  assert.ok(iterations <= N, `CG needed ${iterations} > n iterations`);
  let worst = 0;
  for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(x[i] - xTrue[i]));
  assert.ok(worst < 1e-9, `solution error ${worst}`);
});

test('CG reports progress every iteration', () => {
  const { b, diag } = makeSystem();
  const seen = [];
  const { iterations } = cg({
    apply: applyTridiag, b, diag, tol: 1e-12, maxIter: 1000,
    onProgress: (iter, relRes) => seen.push([iter, relRes]),
  });
  assert.equal(seen.length, iterations);
  assert.ok(seen.length > 0);
  // residuals reported are finite and positive
  for (const [, r] of seen) assert.ok(Number.isFinite(r) && r >= 0);
});

test('CG flags non-convergence at maxIter without throwing', () => {
  const { b, diag } = makeSystem();
  const { converged, iterations } = cg({ apply: applyTridiag, b, diag, tol: 1e-30, maxIter: 2 });
  assert.equal(converged, false);
  assert.equal(iterations, 2);
});

test('CG honours x0: exact start converges in zero iterations', () => {
  const { xTrue, b, diag } = makeSystem();
  const { iterations, converged } = cg({
    apply: applyTridiag, b, diag, x0: xTrue, tol: 1e-12, maxIter: 100,
  });
  assert.ok(converged);
  assert.equal(iterations, 0);
});

test('CG does not mutate b or x0', () => {
  const { xTrue, b, diag } = makeSystem();
  const bCopy = Float64Array.from(b);
  const x0 = Float64Array.from(xTrue);
  cg({ apply: applyTridiag, b, diag, x0, tol: 1e-12, maxIter: 100 });
  assert.deepEqual(Array.from(b), Array.from(bCopy));
  assert.deepEqual(Array.from(x0), Array.from(xTrue));
});

// ====================================================================
// S2-M2 — precond(r,z) seam (ROADMAP S2-M2). The cg preconditioner is now a
// hook (z ← M⁻¹ r) so the multigrid V-cycle can drop in without touching cg.
// Gates G-A/G-C flavor: the default must be a behavioral no-op vs the old inline
// Jacobi, and a custom M must be genuinely wired (changes iterations, still
// correct). Written WITH the seam, before the V-cycle it underpins.
// ====================================================================

// SPD tridiagonal with a STRONGLY VARYING diagonal (3..12), so Jacobi and
// identity preconditioning give measurably different iteration counts.
const NV = 64;
function makeVarSystem() {
  const diag = new Float64Array(NV);
  for (let i = 0; i < NV; i++) diag[i] = 3 + (i % 10); // strictly diagonally dominant
  const apply = (x, y) => {
    for (let i = 0; i < NV; i++) {
      y[i] = diag[i] * x[i] - (i > 0 ? x[i - 1] : 0) - (i < NV - 1 ? x[i + 1] : 0);
    }
  };
  const xTrue = new Float64Array(NV);
  for (let i = 0; i < NV; i++) xTrue[i] = Math.sin(0.37 * i) + 0.5;
  const b = new Float64Array(NV);
  apply(xTrue, b);
  return { apply, b, diag, xTrue };
}

test('S2-G2.A — default precond is bit-identical to explicit Jacobi (no-op seam)', () => {
  const { apply, b, diag } = makeVarSystem();
  const def = cg({ apply, b, diag, tol: 1e-12, maxIter: 1000 });
  const exp = cg({
    apply, b, diag, tol: 1e-12, maxIter: 1000,
    precond: (r, z) => { for (let i = 0; i < NV; i++) z[i] = r[i] / diag[i]; },
  });
  assert.equal(def.iterations, exp.iterations, 'iteration count must match exactly');
  assert.deepEqual(Array.from(def.x), Array.from(exp.x), 'solution must be bit-identical');
});

test('S2-G2.A — a custom preconditioner is actually invoked', () => {
  const { apply, b, diag, xTrue } = makeVarSystem();
  let calls = 0;
  const { x, converged } = cg({
    apply, b, diag, tol: 1e-12, maxIter: 1000,
    precond: (r, z) => { calls++; for (let i = 0; i < NV; i++) z[i] = r[i] / diag[i]; },
  });
  assert.ok(calls > 0, 'precond hook was never called');
  assert.ok(converged);
  let worst = 0;
  for (let i = 0; i < NV; i++) worst = Math.max(worst, Math.abs(x[i] - xTrue[i]));
  assert.ok(worst < 1e-9, `solution error ${worst}`);
});

test('S2-G2.A — identity preconditioner is wired: different iterations, same solution', () => {
  const { apply, b, diag, xTrue } = makeVarSystem();
  const jac = cg({ apply, b, diag, tol: 1e-12, maxIter: 1000 });
  const idn = cg({ apply, b, diag, tol: 1e-12, maxIter: 1000, precond: (r, z) => z.set(r) });
  assert.ok(idn.converged && jac.converged);
  assert.notEqual(idn.iterations, jac.iterations, 'identity M must change the iteration count (hook live)');
  let worst = 0;
  for (let i = 0; i < NV; i++) worst = Math.max(worst, Math.abs(idn.x[i] - xTrue[i]));
  assert.ok(worst < 1e-9, `identity-preconditioned solution error ${worst}`);
});

// ====================================================================
// M2 — COCG (complex-symmetric) and the dense complex-LU oracle.
// Written BEFORE the harmonic solver. (DESIGN §3.4)
// ====================================================================

// A complex-symmetric, diagonally dominant test system A = Are + i·Aim,
// both Are and Aim symmetric tridiagonal → A is complex symmetric (NOT Hermitian).
const M = 24;
function applyCSym(xRe, xIm, yRe, yIm) {
  // (Are + i Aim)(xRe + i xIm): yRe = Are·xRe − Aim·xIm, yIm = Are·xIm + Aim·xRe
  const arePart = (x, i) => 4 * x[i] - (i > 0 ? x[i - 1] : 0) - (i < M - 1 ? x[i + 1] : 0);
  const aimPart = (x, i) => 0.6 * x[i] - 0.1 * (i > 0 ? x[i - 1] : 0) - 0.1 * (i < M - 1 ? x[i + 1] : 0);
  for (let i = 0; i < M; i++) {
    yRe[i] = arePart(xRe, i) - aimPart(xIm, i);
    yIm[i] = arePart(xIm, i) + aimPart(xRe, i);
  }
}

function makeComplexSystem() {
  const xReTrue = new Float64Array(M);
  const xImTrue = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    xReTrue[i] = Math.sin(0.3 * i) + 0.5;
    xImTrue[i] = Math.cos(0.2 * i) - 0.3;
  }
  const bRe = new Float64Array(M);
  const bIm = new Float64Array(M);
  applyCSym(xReTrue, xImTrue, bRe, bIm);
  const diagRe = new Float64Array(M).fill(4);
  const diagIm = new Float64Array(M).fill(0.6);
  return { xReTrue, xImTrue, bRe, bIm, diagRe, diagIm };
}

test('COCG solves a complex-symmetric system to the requested tolerance', () => {
  const { xReTrue, xImTrue, bRe, bIm, diagRe, diagIm } = makeComplexSystem();
  const { xRe, xIm, relRes, converged } = cocg({
    apply: applyCSym, bRe, bIm, diagRe, diagIm, tol: 1e-12, maxIter: 1000,
  });
  assert.ok(converged, `COCG not converged, relRes ${relRes}`);
  let worst = 0;
  for (let i = 0; i < M; i++) {
    worst = Math.max(worst, Math.abs(xRe[i] - xReTrue[i]), Math.abs(xIm[i] - xImTrue[i]));
  }
  assert.ok(worst < 1e-9, `solution error ${worst}`);
});

test('COCG without an imaginary preconditioner still converges', () => {
  const { xReTrue, xImTrue, bRe, bIm, diagRe } = makeComplexSystem();
  const { xRe, xIm, converged } = cocg({
    apply: applyCSym, bRe, bIm, diagRe, tol: 1e-12, maxIter: 1000,
  });
  assert.ok(converged);
  let worst = 0;
  for (let i = 0; i < M; i++) {
    worst = Math.max(worst, Math.abs(xRe[i] - xReTrue[i]), Math.abs(xIm[i] - xImTrue[i]));
  }
  assert.ok(worst < 1e-9, `solution error ${worst}`);
});

test('COCG flags non-convergence at maxIter without throwing', () => {
  const { bRe, bIm, diagRe, diagIm } = makeComplexSystem();
  const { converged } = cocg({ apply: applyCSym, bRe, bIm, diagRe, diagIm, tol: 1e-30, maxIter: 2 });
  assert.equal(converged, false);
});

test('dense complex-LU oracle solves the same system by direct elimination', () => {
  const { xReTrue, xImTrue, bRe, bIm } = makeComplexSystem();
  const { xRe, xIm } = denseLUSolveComplex(M, applyCSym, bRe, bIm);
  let worst = 0;
  for (let i = 0; i < M; i++) {
    worst = Math.max(worst, Math.abs(xRe[i] - xReTrue[i]), Math.abs(xIm[i] - xImTrue[i]));
  }
  assert.ok(worst < 1e-10, `dense-LU solution error ${worst}`);
});

test('COCG and dense-LU agree to < 1e-10 (oracle cross-check)', () => {
  const { bRe, bIm, diagRe, diagIm } = makeComplexSystem();
  const it = cocg({ apply: applyCSym, bRe, bIm, diagRe, diagIm, tol: 1e-13, maxIter: 1000 });
  const lu = denseLUSolveComplex(M, applyCSym, bRe, bIm);
  let worst = 0;
  for (let i = 0; i < M; i++) {
    worst = Math.max(worst, Math.abs(it.xRe[i] - lu.xRe[i]), Math.abs(it.xIm[i] - lu.xIm[i]));
  }
  assert.ok(worst < 1e-10, `COCG vs dense-LU ${worst}`);
});
