// M1 solver unit tests — written BEFORE src/solver.mjs.
// Jacobi-preconditioned CG (DESIGN.md §3.4, ω=0 branch): correctness on a
// known SPD system, convergence reporting, x0 handling, non-convergence flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cg } from '../src/solver.mjs';

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
