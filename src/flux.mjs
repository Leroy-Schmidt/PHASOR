// PHASOR heat-flux post-processing (ROADMAP S2-M1.1): the volumetric heat-flux
// density q(x) = −λ∇T recovered from a solved temperature field. Single source
// of truth for the heat-flow visualization (vectors / |q| colormap, S2-M1.2) and
// the envelope heat-loss integral (annual loss curve, S2-M1.4).
// Pure and DOM-free; runs under `node --test`.
//
// Recovery: per cell, the trilinear field's gradient evaluated at the CELL CENTRE.
// For local node ordering a = di + 2·dj + 4·dk (CLAUDE.md M0), the centred
// derivative collapses to a clean face-mean difference, e.g.
//   ∂T/∂x|centre = ( mean of the four +x-face nodes − mean of the four −x-face
//                     nodes ) / hx
// which is EXACT whenever T is linear (trilinear elements represent linears
// exactly — the same property G1.1 leans on), giving machine-precision gates.

/**
 * Fill cell-centre flux arrays q = −λ∇T from one nodal scalar field. The flux
 * operator is linear in T, so the complex path reuses this on re/im separately.
 * Void cells (λ = 0) are left untouched (callers zero-initialise).
 */
function fillFlux(problem, T, qx, qy, qz) {
  const { grid, cellLambda } = problem;
  const { nx, ny, nz, dx, dy, dz } = grid;
  const sy = nx + 1;
  const sz = (nx + 1) * (ny + 1);

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      let c = nx * (j + ny * k);
      let n0 = sy * j + sz * k;
      for (let i = 0; i < nx; i++, c++, n0++) {
        const lam = cellLambda[c];
        if (lam === 0) continue; // void: leave q at 0

        // eight corner values, a = di + 2·dj + 4·dk
        const t000 = T[n0];
        const t100 = T[n0 + 1];
        const t010 = T[n0 + sy];
        const t110 = T[n0 + sy + 1];
        const t001 = T[n0 + sz];
        const t101 = T[n0 + sz + 1];
        const t011 = T[n0 + sz + sy];
        const t111 = T[n0 + sz + sy + 1];

        // centred gradient = (mean of +face − mean of −face) / h, per axis
        const gx = ((t100 + t110 + t101 + t111) - (t000 + t010 + t001 + t011)) / (4 * dx[i]);
        const gy = ((t010 + t110 + t011 + t111) - (t000 + t100 + t001 + t101)) / (4 * dy[j]);
        const gz = ((t001 + t101 + t011 + t111) - (t000 + t100 + t010 + t110)) / (4 * dz[k]);

        qx[c] = -lam * gx;
        qy[c] = -lam * gy;
        qz[c] = -lam * gz;
      }
    }
  }
}

/**
 * Cell-centre heat-flux density q = −λ∇T for every cell of a solved problem.
 * Void cells (λ = 0) carry zero flux. Components are SI W/m².
 *
 * @param {object} problem — from `assemble` (grid, cellLambda, nNodes)
 * @param {Float64Array} T — nodal temperature field (length nNodes)
 * @returns {{qx, qy, qz: Float64Array, nx, ny, nz: number}} cell-indexed flux
 *   (idx = i + nx·(j + ny·k), the M0 cell convention)
 */
export function cellFlux(problem, T) {
  const { nx, ny, nz } = problem.grid;
  const nCells = nx * ny * nz;
  const qx = new Float64Array(nCells);
  const qy = new Float64Array(nCells);
  const qz = new Float64Array(nCells);
  fillFlux(problem, T, qx, qy, qz);
  return { qx, qy, qz, nx, ny, nz };
}

/**
 * Complex heat-flux phasor q̂ = −λ∇T̂ for a harmonic field, re/im stored as
 * separate Float64Arrays (CLAUDE.md M2). Drives the harmonic heat-flow viz
 * (S2-M1.2/.3). λ is real, so re and im decouple — `cellFluxComplex` with a
 * zero imaginary field reproduces `cellFlux` exactly.
 *
 * @param {object} problem
 * @param {Float64Array} Tre @param {Float64Array} Tim — nodal phasor field
 * @returns {{qxRe,qyRe,qzRe,qxIm,qyIm,qzIm: Float64Array, nx,ny,nz: number}}
 */
export function cellFluxComplex(problem, Tre, Tim) {
  const { nx, ny, nz } = problem.grid;
  const nCells = nx * ny * nz;
  const qxRe = new Float64Array(nCells);
  const qyRe = new Float64Array(nCells);
  const qzRe = new Float64Array(nCells);
  const qxIm = new Float64Array(nCells);
  const qyIm = new Float64Array(nCells);
  const qzIm = new Float64Array(nCells);
  fillFlux(problem, Tre, qxRe, qyRe, qzRe);
  fillFlux(problem, Tim, qxIm, qyIm, qzIm);
  return { qxRe, qyRe, qzRe, qxIm, qyIm, qzIm, nx, ny, nz };
}

/**
 * Net heat flux OUT through a Robin region's boundary faces, integrating the
 * cell-centre flux: Σ_faces (q·n) · area, with n the outward face normal. The
 * sign convention matches `boundaryFlux` (fem.mjs) — on the exact-solution
 * `wall1d` preset the two agree to solver tolerance, which is the independent-
 * oracle cross-check S2-G1.1d. (W, SI.)
 *
 * @param {object} problem — must carry `robinFaces` with per-face `cell`
 * @param {{qx, qy, qz: Float64Array}} q — from `cellFlux`
 * @param {string} region — Robin BC name
 * @returns {number} net outward flux through the region
 */
export function regionFlux(problem, q, region) {
  let sum = 0;
  for (const f of problem.robinFaces) {
    if (f.region !== region) continue;
    const comp = f.axis === 0 ? q.qx[f.cell]
      : f.axis === 1 ? q.qy[f.cell]
      : q.qz[f.cell];
    sum += f.dir * comp * f.area; // q·n = dir·q[axis]
  }
  return sum;
}

/**
 * Vector-glyph LAYOUT for the heat-flow viz (S2-M1.2). Pure and DOM-free so the
 * arrow placement is unit-tested independently of the canvas that draws it.
 *
 * One glyph per solid cell sampled on a stride, at the XY slice layer `k`. The
 * direction is the normalized in-plane flux (qx, qy) — i.e. the −∇T direction,
 * since q = −λ∇T with λ > 0 — and the length is the clamped magnitude
 * |q_xy| / scale ∈ [0, 1] (the renderer multiplies by a pixel length). Void /
 * zero-flux cells (q = 0 there) yield no glyph.
 *
 * @param {{qx,qy: Float64Array, nx,ny,nz: number}} q — from `cellFlux`
 * @param {{nx,ny,nz: number, xs,ys: ArrayLike<number>}} grid — for cell centres
 * @param {number} k — slice cell layer
 * @param {{stride?: number, scale?: number}} [opts] — sampling stride (≥1) and
 *   the magnitude mapping to len = 1; if omitted, scale = max |q_xy| over the
 *   sampled solid cells (so the strongest sampled arrow saturates to 1).
 * @returns {{glyphs: Array<{x,y,ux,uy,mag,len: number}>, scale: number}}
 *   x,y are cell-centre coordinates (metres).
 */
export function fluxGlyphs(q, grid, k, { stride = 1, scale } = {}) {
  const { qx, qy, nx, ny } = q;
  const { xs, ys } = grid;
  const s = Math.max(1, Math.floor(stride));

  // pass 1: collect sampled solid (non-zero-flux) cells + in-plane magnitudes
  const picks = [];
  let maxMag = 0;
  for (let j = 0; j < ny; j += s) {
    for (let i = 0; i < nx; i += s) {
      const c = i + nx * (j + ny * k);
      const mag = Math.hypot(qx[c], qy[c]);
      if (mag === 0) continue; // void / zero flux → no arrow
      picks.push({ i, j, c, mag });
      if (mag > maxMag) maxMag = mag;
    }
  }

  const sc = scale != null ? scale : maxMag;
  const glyphs = [];
  if (sc > 0) {
    for (const { i, j, c, mag } of picks) {
      glyphs.push({
        x: (xs[i] + xs[i + 1]) / 2,
        y: (ys[j] + ys[j + 1]) / 2,
        ux: qx[c] / mag,
        uy: qy[c] / mag,
        mag,
        len: Math.min(1, mag / sc),
      });
    }
  }
  return { glyphs, scale: sc };
}
