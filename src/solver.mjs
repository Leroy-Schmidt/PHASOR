// PHASOR linear solvers (DESIGN.md §3.4). M1: Jacobi-preconditioned CG for
// the real SPD steady-state system. M2: COCG for the complex-symmetric
// harmonic system, plus a dense complex-LU oracle for tests. (BiCGSTAB is the
// documented fallback if COCG ever stalls — not built until that happens.)
// Pure and DOM-free; runs under `node --test`.

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
 * @param {Float64Array} opts.diag — Jacobi diagonal, diag(A) > 0; the default
 *   preconditioner and the certified fallback (required unless `precond` is given)
 * @param {(r: Float64Array, z: Float64Array) => void} [opts.precond] — apply the
 *   preconditioner z ← M⁻¹ r (writes into z). Default: Jacobi, z = r / diag,
 *   which is bit-identical to the un-hooked solver. A stronger M (e.g. the S2-M2
 *   multigrid V-cycle) overrides it; the operator `apply` is unchanged, so the
 *   converged solution is identical up to tolerance.
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

  // Optional preconditioner hook z ← M⁻¹ r (S2-M2 multigrid V-cycle drops in
  // here). Read off the opts object so the default Jacobi path — z = r / diag —
  // stays bit-identical to the un-hooked solver.
  const precond = arguments[0].precond;
  const applyPrecond = precond || ((rIn, zOut) => { for (let i = 0; i < n; i++) zOut[i] = rIn[i] / diag[i]; });

  apply(x, Ap);
  for (let i = 0; i < n; i++) r[i] = b[i] - Ap[i];
  const bNorm = Math.sqrt(dot(b, b)) || 1;
  let relRes = Math.sqrt(dot(r, r)) / bNorm;

  applyPrecond(r, z);
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
    applyPrecond(r, z);
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

// ====================================================================
// M2 — complex-symmetric solvers (DESIGN §3.4). Fields are separate re/im
// Float64Arrays (CLAUDE.md M2). The harmonic operator (K + iωC + H) is
// complex SYMMETRIC, not Hermitian, so COCG uses the UNCONJUGATED bilinear
// form ⟨x,y⟩ = Σ xᵢyᵢ (no complex conjugate). The convergence test still uses
// the true (conjugated) 2-norm of the residual.
// ====================================================================

/** Unconjugated complex bilinear form Σ uᵢvᵢ → {re, im}. */
function cBilinear(uRe, uIm, vRe, vIm) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < uRe.length; i++) {
    re += uRe[i] * vRe[i] - uIm[i] * vIm[i];
    im += uRe[i] * vIm[i] + uIm[i] * vRe[i];
  }
  return { re, im };
}

/** Squared true (conjugated) 2-norm Σ |vᵢ|². */
function cNormSq(vRe, vIm) {
  let s = 0;
  for (let i = 0; i < vRe.length; i++) s += vRe[i] * vRe[i] + vIm[i] * vIm[i];
  return s;
}

/** Complex divide a / b → {re, im}. */
function cdiv(a, b) {
  const den = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / den, im: (a.im * b.re - a.re * b.im) / den };
}

/**
 * Conjugate-orthogonal CG for the complex-symmetric system A x = b, matrix-free,
 * Jacobi-preconditioned (van der Vorst & Melissen). About the same shape as cg.
 *
 * @param {object} opts
 * @param {(xRe, xIm, yRe, yIm) => void} opts.apply — (yRe,yIm) ← A (xRe,xIm)
 * @param {Float64Array} opts.bRe
 * @param {Float64Array} opts.bIm
 * @param {Float64Array} opts.diagRe — real part of the Jacobi diagonal, > 0
 * @param {Float64Array} [opts.diagIm] — imaginary part (default 0 → real Jacobi)
 * @param {Float64Array} [opts.x0Re] @param {Float64Array} [opts.x0Im]
 * @param {number} [opts.tol=1e-8] — relative residual ‖b−Ax‖/‖b‖ target
 * @param {number} [opts.maxIter=5000]
 * @param {(iter: number, relRes: number) => void} [opts.onProgress]
 * @returns {{xRe, xIm: Float64Array, iterations: number, relRes: number, converged: boolean}}
 */
export function cocg({ apply, bRe, bIm, diagRe, diagIm, x0Re, x0Im, tol = 1e-8, maxIter = 5000, onProgress }) {
  const n = bRe.length;
  const xRe = x0Re ? Float64Array.from(x0Re) : new Float64Array(n);
  const xIm = x0Im ? Float64Array.from(x0Im) : new Float64Array(n);
  const rRe = new Float64Array(n);
  const rIm = new Float64Array(n);
  const zRe = new Float64Array(n);
  const zIm = new Float64Array(n);
  const pRe = new Float64Array(n);
  const pIm = new Float64Array(n);
  const qRe = new Float64Array(n);
  const qIm = new Float64Array(n);

  // z = M⁻¹ r, M = diag (complex). With diagIm absent this is a real divide.
  const precond = () => {
    for (let i = 0; i < n; i++) {
      const dr = diagRe[i];
      const di = diagIm ? diagIm[i] : 0;
      const den = dr * dr + di * di;
      zRe[i] = (rRe[i] * dr + rIm[i] * di) / den;
      zIm[i] = (rIm[i] * dr - rRe[i] * di) / den;
    }
  };

  apply(xRe, xIm, qRe, qIm); // q = A x
  for (let i = 0; i < n; i++) { rRe[i] = bRe[i] - qRe[i]; rIm[i] = bIm[i] - qIm[i]; }
  const bNorm = Math.sqrt(cNormSq(bRe, bIm)) || 1;
  let relRes = Math.sqrt(cNormSq(rRe, rIm)) / bNorm;

  precond();
  let rz = cBilinear(rRe, rIm, zRe, zIm);
  pRe.set(zRe);
  pIm.set(zIm);

  let iter = 0;
  while (relRes > tol && iter < maxIter) {
    apply(pRe, pIm, qRe, qIm); // q = A p
    const pq = cBilinear(pRe, pIm, qRe, qIm);
    if (!(pq.re * pq.re + pq.im * pq.im > 0)) break; // breakdown — report honestly
    const alpha = cdiv(rz, pq);
    for (let i = 0; i < n; i++) {
      xRe[i] += alpha.re * pRe[i] - alpha.im * pIm[i];
      xIm[i] += alpha.re * pIm[i] + alpha.im * pRe[i];
      rRe[i] -= alpha.re * qRe[i] - alpha.im * qIm[i];
      rIm[i] -= alpha.re * qIm[i] + alpha.im * qRe[i];
    }
    precond();
    const rzNext = cBilinear(rRe, rIm, zRe, zIm);
    const beta = cdiv(rzNext, rz);
    rz = rzNext;
    for (let i = 0; i < n; i++) {
      const prRe = pRe[i];
      const prIm = pIm[i];
      pRe[i] = zRe[i] + beta.re * prRe - beta.im * prIm;
      pIm[i] = zIm[i] + beta.re * prIm + beta.im * prRe;
    }
    iter++;
    relRes = Math.sqrt(cNormSq(rRe, rIm)) / bNorm;
    if (onProgress) onProgress(iter, relRes);
  }
  return { xRe, xIm, iterations: iter, relRes, converged: relRes <= tol };
}

/**
 * Dense complex-LU oracle (DESIGN §3.4) — TESTS ONLY, grids ≤ ~12³. Builds the
 * dense matrix by probing the matrix-free operator with unit vectors, then
 * solves by Gaussian elimination with partial pivoting. A completely different
 * numerical path than COCG, so it certifies the iterative solver (gate G2.3).
 *
 * @param {number} n — system size
 * @param {(xRe, xIm, yRe, yIm) => void} apply — (yRe,yIm) ← A (xRe,xIm)
 * @param {Float64Array} bRe @param {Float64Array} bIm
 * @returns {{xRe, xIm: Float64Array}}
 */
export function denseLUSolveComplex(n, apply, bRe, bIm) {
  const Are = new Float64Array(n * n);
  const Aim = new Float64Array(n * n);
  const eRe = new Float64Array(n);
  const eIm = new Float64Array(n);
  const yRe = new Float64Array(n);
  const yIm = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    eRe[j] = 1;
    apply(eRe, eIm, yRe, yIm); // column j = A·e_j
    for (let i = 0; i < n; i++) { Are[i * n + j] = yRe[i]; Aim[i * n + j] = yIm[i]; }
    eRe[j] = 0;
  }

  const xRe = Float64Array.from(bRe);
  const xIm = Float64Array.from(bIm);
  for (let col = 0; col < n; col++) {
    // partial pivot on |A[r][col]|²
    let piv = col;
    let best = Are[col * n + col] ** 2 + Aim[col * n + col] ** 2;
    for (let r = col + 1; r < n; r++) {
      const m = Are[r * n + col] ** 2 + Aim[r * n + col] ** 2;
      if (m > best) { best = m; piv = r; }
    }
    if (piv !== col) {
      for (let cc = 0; cc < n; cc++) {
        const tr = Are[col * n + cc]; Are[col * n + cc] = Are[piv * n + cc]; Are[piv * n + cc] = tr;
        const ti = Aim[col * n + cc]; Aim[col * n + cc] = Aim[piv * n + cc]; Aim[piv * n + cc] = ti;
      }
      const xr = xRe[col]; xRe[col] = xRe[piv]; xRe[piv] = xr;
      const xi = xIm[col]; xIm[col] = xIm[piv]; xIm[piv] = xi;
    }
    const drr = Are[col * n + col];
    const dii = Aim[col * n + col];
    const den = drr * drr + dii * dii;
    for (let r = col + 1; r < n; r++) {
      const arr = Are[r * n + col];
      const ari = Aim[r * n + col];
      const fRe = (arr * drr + ari * dii) / den; // A[r][col]/A[col][col]
      const fIm = (ari * drr - arr * dii) / den;
      if (fRe === 0 && fIm === 0) continue;
      for (let cc = col; cc < n; cc++) {
        const brr = Are[col * n + cc];
        const bri = Aim[col * n + cc];
        Are[r * n + cc] -= fRe * brr - fIm * bri;
        Aim[r * n + cc] -= fRe * bri + fIm * brr;
      }
      xRe[r] -= fRe * xRe[col] - fIm * xIm[col];
      xIm[r] -= fRe * xIm[col] + fIm * xRe[col];
    }
  }

  for (let row = n - 1; row >= 0; row--) {
    let sRe = xRe[row];
    let sIm = xIm[row];
    for (let cc = row + 1; cc < n; cc++) {
      const arr = Are[row * n + cc];
      const ari = Aim[row * n + cc];
      sRe -= arr * xRe[cc] - ari * xIm[cc];
      sIm -= arr * xIm[cc] + ari * xRe[cc];
    }
    const drr = Are[row * n + row];
    const dii = Aim[row * n + row];
    const den = drr * drr + dii * dii;
    xRe[row] = (sRe * drr + sIm * dii) / den;
    xIm[row] = (sIm * drr - sRe * dii) / den;
  }
  return { xRe, xIm };
}
