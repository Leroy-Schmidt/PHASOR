// PHASOR CSR sparse matvec (S2-M2.2). The steady operator assembled by
// `assembleCSR` (src/fem.mjs) as a compressed-sparse-row matrix, applied here in
// plain fp64 as the reference SpMV. The WebGPU kernel (src/gpu/) mirrors this row
// loop exactly — one row per GPU invocation, columns summed in stored (ascending)
// order — so the GPU result is deterministic and gated against this function.
// Pure and DOM-free; runs under `node --test`.

/**
 * y ← A x for a CSR matrix. Each row sums its entries in stored order.
 * @param {{rowPtr: Int32Array, colIdx: Int32Array, vals: Float64Array, n: number}} csr
 * @param {Float64Array} x
 * @param {Float64Array} y — overwritten
 */
export function csrSpMV(csr, x, y) {
  const { rowPtr, colIdx, vals, n } = csr;
  for (let r = 0; r < n; r++) {
    let s = 0;
    const end = rowPtr[r + 1];
    for (let p = rowPtr[r]; p < end; p++) s += vals[p] * x[colIdx[p]];
    y[r] = s;
  }
}

/**
 * Complex CSR matvec (yRe, yIm) ← (Are + i·Aim)(xRe + i·xIm), the fp64 reference
 * for the harmonic GPU solve. `csrRe = assembleCSR(p)` (K+H, identity rows),
 * `csrIm = assembleCSRImag(p, ω)` (ωC, empty non-free rows). Reproduces
 * `applyAComplex(p, ω)` (gate S2-G2.B-im).
 *   yRe = Are·xRe − Aim·xIm,  yIm = Are·xIm + Aim·xRe.
 */
export function csrSpMVComplex(csrRe, csrIm, xRe, xIm, yRe, yIm) {
  const n = csrRe.n;
  const t1 = new Float64Array(n);
  const t2 = new Float64Array(n);
  csrSpMV(csrRe, xRe, t1); csrSpMV(csrIm, xIm, t2);
  for (let i = 0; i < n; i++) yRe[i] = t1[i] - t2[i];
  csrSpMV(csrRe, xIm, t1); csrSpMV(csrIm, xRe, t2);
  for (let i = 0; i < n; i++) yIm[i] = t1[i] + t2[i];
}
