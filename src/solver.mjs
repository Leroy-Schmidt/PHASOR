// PHASOR linear solvers (DESIGN.md §3.4). M1: Jacobi-preconditioned CG for
// the real SPD steady-state system. COCG / BiCGSTAB / dense-LU oracle follow
// in M2. Pure and DOM-free; runs under `node --test`.

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Preconditioned conjugate gradients for A x = b, A SPD, matrix-free.
 *
 * @param {object} opts
 * @param {(x: Float64Array, y: Float64Array) => void} opts.apply — y ← A x (overwrites y)
 * @param {Float64Array} opts.b — right-hand side (not mutated)
 * @param {Float64Array} opts.diag — Jacobi preconditioner, diag(A) > 0
 * @param {Float64Array} [opts.x0] — initial guess (not mutated; default 0)
 * @param {number} [opts.tol=1e-8] — relative residual ‖b−Ax‖/‖b‖ target
 * @param {number} [opts.maxIter=5000]
 * @param {(iter: number, relRes: number) => void} [opts.onProgress]
 * @returns {{x: Float64Array, iterations: number, relRes: number, converged: boolean}}
 */
export function cg({ apply, b, diag, x0, tol = 1e-8, maxIter = 5000, onProgress }) {
  const n = b.length;
  const x = x0 ? Float64Array.from(x0) : new Float64Array(n);
  const r = new Float64Array(n);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const Ap = new Float64Array(n);

  apply(x, Ap);
  for (let i = 0; i < n; i++) r[i] = b[i] - Ap[i];
  const bNorm = Math.sqrt(dot(b, b)) || 1;
  let relRes = Math.sqrt(dot(r, r)) / bNorm;

  for (let i = 0; i < n; i++) z[i] = r[i] / diag[i];
  let rz = dot(r, z);
  p.set(z);

  let iter = 0;
  while (relRes > tol && iter < maxIter) {
    apply(p, Ap);
    const pAp = dot(p, Ap);
    if (!(pAp > 0)) break; // SPD breakdown — report unconverged honestly
    const alpha = rz / pAp;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
    }
    for (let i = 0; i < n; i++) z[i] = r[i] / diag[i];
    const rzNext = dot(r, z);
    const beta = rzNext / rz;
    rz = rzNext;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    iter++;
    relRes = Math.sqrt(dot(r, r)) / bNorm;
    if (onProgress) onProgress(iter, relRes);
  }
  return { x, iterations: iter, relRes, converged: relRes <= tol };
}
