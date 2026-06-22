// S2-M1.1 flux gates (ROADMAP) — written BEFORE src/flux.mjs.
// Heat-flux density q = −λ∇T recovered at cell centres, plus the envelope
// integral. Gates:
//   G1.1a  linear field → q exact (trilinear represents linears exactly)
//   G1.1b  wall1d → flux uniform along x, transverse components ≈ 0
//          (uniform = divergence-free, the source-free steady condition)
//   G1.1d  regionFlux == boundaryFlux per Robin region on wall1d (exact
//          solution): two independent flux computations agree — the
//          independent-oracle cross-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATERIALS, wall1d, corner2d } from '../src/model.mjs';
import { cellIndex, nodeIndex } from '../src/grid.mjs';
import { boundaryFlux } from '../src/fem.mjs';
import { solveSteady } from '../src/worker.mjs';
import { cellFlux, cellFluxComplex, regionFlux, fluxGlyphs } from '../src/flux.mjs';

const SOLVE = { tol: 1e-12, maxIter: 20000 };

// ------------------------------------------------------------------ G1.1a
test('G1.1a — q is exact for a linear temperature field (graded multi-material)', () => {
  // corner2d: graded grid, two materials → per-cell λ varies; q = −λ_cell·∇T.
  const { grid, problem } = solveSteady(corner2d(), MATERIALS, SOLVE);
  const { nx, ny, nz, xs, ys, zs } = grid;

  const [a, bx, by, bz] = [3.0, 2.0, -1.0, 0.5];
  const T = new Float64Array(problem.nNodes);
  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        T[nodeIndex(grid, i, j, k)] = a + bx * xs[i] + by * ys[j] + bz * zs[k];
      }
    }
  }

  const q = cellFlux(problem, T);
  let checked = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = cellIndex(grid, i, j, k);
        const lam = problem.cellLambda[c];
        if (lam === 0) continue; // void
        const tol = 1e-8 * (1 + lam);
        assert.ok(Math.abs(q.qx[c] - -lam * bx) <= tol, `qx cell ${c}`);
        assert.ok(Math.abs(q.qy[c] - -lam * by) <= tol, `qy cell ${c}`);
        assert.ok(Math.abs(q.qz[c] - -lam * bz) <= tol, `qz cell ${c}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 0, 'no solid cells checked');
});

// ------------------------------------------------------------------ G1.1b
test('G1.1b — wall1d flux is uniform along x, transverse components ≈ 0', () => {
  const { grid, problem, T, converged } = solveSteady(wall1d(), MATERIALS, SOLVE);
  assert.ok(converged, 'wall1d did not converge');
  const { nx, ny, nz } = grid;
  const q = cellFlux(problem, T);

  let qxMin = Infinity;
  let qxMax = -Infinity;
  let transMax = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = cellIndex(grid, i, j, k);
        if (problem.cellLambda[c] === 0) continue;
        qxMin = Math.min(qxMin, q.qx[c]);
        qxMax = Math.max(qxMax, q.qx[c]);
        transMax = Math.max(transMax, Math.abs(q.qy[c]), Math.abs(q.qz[c]));
      }
    }
  }
  const qxMean = (qxMin + qxMax) / 2;
  assert.ok(Math.abs(qxMean) > 0, 'expected non-zero through-flux');
  // uniform (divergence-free) to solver tolerance
  assert.ok((qxMax - qxMin) / Math.abs(qxMean) < 1e-6, `qx not uniform: [${qxMin}, ${qxMax}]`);
  // purely 1D: no transverse flux
  assert.ok(transMax / Math.abs(qxMean) < 1e-9, `transverse flux too large: ${transMax}`);
});

// ------------------------------------------------------------------ G1.1d
test('G1.1d — regionFlux equals boundaryFlux per Robin region on wall1d (independent oracle)', () => {
  const { problem, T, converged } = solveSteady(wall1d(), MATERIALS, SOLVE);
  assert.ok(converged, 'wall1d did not converge');
  const q = cellFlux(problem, T);
  const { byRegion } = boundaryFlux(problem, T);

  for (const region of Object.keys(byRegion)) {
    const fromGradient = regionFlux(problem, q, region);
    const fromBC = byRegion[region];
    const rel = Math.abs(fromGradient - fromBC) / (Math.abs(fromBC) || 1);
    assert.ok(rel < 1e-7,
      `region ${region}: gradient flux ${fromGradient} vs BC flux ${fromBC} (rel ${rel})`);
  }
});

// ------------------------------------------------------------------ G1.2b
test('G1.2b — fluxGlyphs: count == stride sampling, direction == −∇T, length ∝ clamped |q|', () => {
  // synthetic 4×4×1 cell grid; cell centres at 0.5,1.5,2.5,3.5
  const nx = 4;
  const ny = 4;
  const nz = 1;
  const xs = Float64Array.from([0, 1, 2, 3, 4]);
  const ys = Float64Array.from([0, 1, 2, 3, 4]);
  const grid = { nx, ny, nz, xs, ys };
  const nCells = nx * ny * nz;
  const qx = new Float64Array(nCells);
  const qy = new Float64Array(nCells);
  const qz = new Float64Array(nCells);
  // every cell non-void: qx = c+1 (so cell 3 = the in-plane max), qy = −(c+1)
  for (let c = 0; c < nCells; c++) { qx[c] = c + 1; qy[c] = -(c + 1); }
  const q = { qx, qy, qz, nx, ny, nz };

  // stride 2 → sample i∈{0,2}, j∈{0,2} → 4 cells, all non-void → 4 glyphs
  const { glyphs, scale } = fluxGlyphs(q, grid, 0, { stride: 2 });
  assert.equal(glyphs.length, 4, 'count must equal the stride sampling of solid cells');

  // auto scale == max in-plane |q| over the SAMPLED cells (not the whole grid):
  // sampled cells are (i,j)∈{0,2}². biggest c among them is i=2,j=2 → c=10 → mag √2·11
  const cMax = 2 + nx * 2; // cellIndex(2,2,0)
  const expScale = Math.hypot(qx[cMax], qy[cMax]);
  assert.ok(Math.abs(scale - expScale) < 1e-12, `scale ${scale} vs ${expScale}`);

  for (const gph of glyphs) {
    // cell-centre position lands on a half-integer (xs/ys spacing 1)
    assert.ok(Number.isInteger(gph.x - 0.5) && Number.isInteger(gph.y - 0.5), 'centre coords');
    // direction is the normalized in-plane (qx,qy) = −∇T direction
    const mag = Math.hypot(gph.ux, gph.uy);
    assert.ok(Math.abs(mag - 1) < 1e-12, 'direction must be unit length');
    assert.ok(Math.abs(gph.ux - 1 / Math.SQRT2) < 1e-12, 'ux'); // qx>0, qy=−qx
    assert.ok(Math.abs(gph.uy + 1 / Math.SQRT2) < 1e-12, 'uy');
    // length is clamped |q|/scale ∈ [0,1]
    assert.ok(gph.len > 0 && gph.len <= 1 + 1e-12, `len in (0,1]: ${gph.len}`);
    assert.ok(Math.abs(gph.len - Math.min(1, gph.mag / scale)) < 1e-12, 'len ∝ clamped |q|/scale');
  }
  // the max-magnitude sampled glyph saturates to len == 1
  assert.ok(glyphs.some((g) => Math.abs(g.len - 1) < 1e-12), 'max glyph saturates');
});

test('G1.2b — fluxGlyphs: void / zero-flux cells produce no glyph; explicit scale clamps', () => {
  const nx = 2;
  const ny = 2;
  const nz = 1;
  const grid = { nx, ny, nz, xs: Float64Array.from([0, 1, 2]), ys: Float64Array.from([0, 1, 2]) };
  const qx = Float64Array.from([0, 4, 0, 2]); // cell 0 and cell 2 are zero (void)
  const qy = Float64Array.from([0, 0, 0, 0]);
  const q = { qx, qy, qz: new Float64Array(4), nx, ny, nz };

  // stride 1 → 4 candidate cells, but two are zero → 2 glyphs
  const { glyphs } = fluxGlyphs(q, grid, 0, { stride: 1, scale: 2 });
  assert.equal(glyphs.length, 2, 'zero-flux (void) cells must be skipped');
  // explicit scale 2: cell 1 mag 4 → clamped to len 1; cell 3 mag 2 → len 1 as well
  for (const g of glyphs) assert.ok(g.len <= 1 + 1e-12, 'explicit scale clamps len to 1');
  const byMag = glyphs.slice().sort((a, b) => b.mag - a.mag);
  assert.ok(Math.abs(byMag[0].mag - 4) < 1e-12 && Math.abs(byMag[0].len - 1) < 1e-12, 'over-scale clamps');
});

// ------------------------------------------------------------------ G1.1e
test('G1.1e — cellFluxComplex: zero-im reproduces cellFlux; linear phasor exact', () => {
  const { grid, problem } = solveSteady(corner2d(), MATERIALS, SOLVE);
  const { nx, ny, nz, xs, ys, zs } = grid;

  // real linear field + an independent imaginary linear field
  const Tre = new Float64Array(problem.nNodes);
  const Tim = new Float64Array(problem.nNodes);
  const [a, bx, by, bz] = [3.0, 2.0, -1.0, 0.5]; // real coeffs
  const [p, cx, cy, cz] = [-1.0, 0.7, 1.3, -0.4]; // imag coeffs
  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const n = nodeIndex(grid, i, j, k);
        Tre[n] = a + bx * xs[i] + by * ys[j] + bz * zs[k];
        Tim[n] = p + cx * xs[i] + cy * ys[j] + cz * zs[k];
      }
    }
  }

  // zero-im consistency: Re part must match the real cellFlux, Im part zero
  const zero = new Float64Array(problem.nNodes);
  const real = cellFlux(problem, Tre);
  const cz0 = cellFluxComplex(problem, Tre, zero);
  // linear phasor exactness on both parts
  const cplx = cellFluxComplex(problem, Tre, Tim);

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = cellIndex(grid, i, j, k);
        const lam = problem.cellLambda[c];
        if (lam === 0) continue;
        const tol = 1e-8 * (1 + lam);
        // consistency with real path
        assert.ok(Math.abs(cz0.qxRe[c] - real.qx[c]) <= tol, `Re≠real qx cell ${c}`);
        assert.ok(Math.abs(cz0.qxIm[c]) <= tol, `Im≠0 qx cell ${c}`);
        // exact linear phasor: q̂ = −λ∇T̂
        assert.ok(Math.abs(cplx.qxRe[c] - -lam * bx) <= tol, `qxRe cell ${c}`);
        assert.ok(Math.abs(cplx.qyIm[c] - -lam * cy) <= tol, `qyIm cell ${c}`);
        assert.ok(Math.abs(cplx.qzIm[c] - -lam * cz) <= tol, `qzIm cell ${c}`);
      }
    }
  }
});
