// M1 FEM unit tests (DESIGN.md §3.2–§3.3) — written BEFORE src/fem.mjs.
// Element stiffness vs direct Gauss quadrature (the "derive/verify once"
// step, done numerically instead of sympy: 2×2×2 Gauss is exact for the
// trilinear integrands), Robin face mass matrix, BC face classification,
// active/void masking, Dirichlet elimination, operator symmetry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, paintBoxes, nodeIndex } from '../src/grid.mjs';
import { MATERIALS, wall1d, corner2d } from '../src/model.mjs';
import {
  elementK,
  elementC,
  faceMass,
  assemble,
  applyA,
  applyAComplex,
  assembleHarmonicLoad,
  boundaryFlux,
  regionNodes,
} from '../src/fem.mjs';
import { cg } from '../src/solver.mjs';
import { OMEGA_DIURNAL } from '../src/physics.mjs';

// ---------------------------------------------------------------- helpers

function maxAbs(arr) {
  let m = 0;
  for (const v of arr) m = Math.max(m, Math.abs(v));
  return m;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** ∫ λ ∇N_a·∇N_b dV on an hx×hy×hz box via 2×2×2 Gauss (exact for trilinear).
 *  Local node order a = di + 2*dj + 4*dk, same convention the module fixes. */
function quadratureElementK(hx, hy, hz, lambda) {
  const g = 1 / Math.sqrt(3);
  const K = new Float64Array(64);
  const J = (hx * hy * hz) / 8;
  const sign = (a, bit) => (((a >> bit) & 1) ? 1 : -1);
  for (const xi of [-g, g]) {
    for (const eta of [-g, g]) {
      for (const zeta of [-g, g]) {
        const grads = [];
        for (let a = 0; a < 8; a++) {
          const sx = sign(a, 0);
          const sy = sign(a, 1);
          const sz = sign(a, 2);
          grads.push([
            (sx * (1 + sy * eta) * (1 + sz * zeta)) / 8 * (2 / hx),
            ((1 + sx * xi) * sy * (1 + sz * zeta)) / 8 * (2 / hy),
            ((1 + sx * xi) * (1 + sy * eta) * sz) / 8 * (2 / hz),
          ]);
        }
        for (let a = 0; a < 8; a++) {
          for (let b = 0; b < 8; b++) {
            K[a * 8 + b] += lambda * J *
              (grads[a][0] * grads[b][0] + grads[a][1] * grads[b][1] + grads[a][2] * grads[b][2]);
          }
        }
      }
    }
  }
  return K;
}

/** ∫ N_a N_b dA on an hu×hv rectangle via 2×2 Gauss; a = du + 2*dv. */
function quadratureFaceMass(hu, hv) {
  const g = 1 / Math.sqrt(3);
  const M = new Float64Array(16);
  const J = (hu * hv) / 4;
  const sign = (a, bit) => (((a >> bit) & 1) ? 1 : -1);
  for (const u of [-g, g]) {
    for (const v of [-g, g]) {
      const N = [];
      for (let a = 0; a < 4; a++) {
        N.push(((1 + sign(a, 0) * u) * (1 + sign(a, 1) * v)) / 4);
      }
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 4; b++) M[a * 4 + b] += J * N[a] * N[b];
      }
    }
  }
  return M;
}

// --------------------------------------------------------- element matrices

test('elementK matches direct Gauss quadrature for anisotropic cells', () => {
  const cases = [
    [1, 1, 1, 1],
    [0.025, 0.05, 0.1, 0.035],
    [0.003, 0.2, 0.01, 2.1],
  ];
  for (const [hx, hy, hz, lam] of cases) {
    const K = elementK(hx, hy, hz, lam);
    const Q = quadratureElementK(hx, hy, hz, lam);
    const scale = maxAbs(Q);
    for (let i = 0; i < 64; i++) {
      assert.ok(Math.abs(K[i] - Q[i]) <= 1e-12 * scale,
        `K[${i}] = ${K[i]} vs quadrature ${Q[i]} (h=${hx},${hy},${hz})`);
    }
  }
});

test('elementK is symmetric with zero row sums (constant null space)', () => {
  const K = elementK(0.02, 0.31, 0.007, 0.7);
  const scale = maxAbs(K);
  for (let a = 0; a < 8; a++) {
    let row = 0;
    for (let b = 0; b < 8; b++) {
      row += K[a * 8 + b];
      assert.equal(K[a * 8 + b], K[b * 8 + a], `K not symmetric at (${a},${b})`);
    }
    assert.ok(Math.abs(row) <= 1e-12 * scale, `row ${a} sum ${row} not ~0`);
  }
  // unit cube, λ=1: trilinear stiffness diagonal is exactly 1/3
  const U = elementK(1, 1, 1, 1);
  for (let a = 0; a < 8; a++) {
    assert.ok(Math.abs(U[a * 8 + a] - 1 / 3) < 1e-14, `unit diag ${U[a * 8 + a]}`);
  }
});

test('faceMass matches quadrature; row sums are area/4', () => {
  for (const [hu, hv] of [[1, 1], [0.04, 0.13]]) {
    const M = faceMass(hu, hv);
    const Q = quadratureFaceMass(hu, hv);
    const scale = maxAbs(Q);
    for (let i = 0; i < 16; i++) {
      assert.ok(Math.abs(M[i] - Q[i]) <= 1e-12 * scale, `M[${i}] vs quadrature`);
    }
    for (let a = 0; a < 4; a++) {
      let row = 0;
      for (let b = 0; b < 4; b++) row += M[a * 4 + b];
      assert.ok(Math.abs(row - (hu * hv) / 4) <= 1e-12 * hu * hv, `row sum ${row}`);
    }
  }
});

// ------------------------------------------------------ BC classification

function assembled(preset) {
  const grid = buildGrid(preset.gridSpec);
  const painted = paintBoxes(grid, preset.boxes, preset.background);
  return { grid, painted, problem: assemble(grid, painted, MATERIALS, preset.bcs) };
}

test('wall1d: exterior faces only at x=min, interior only at x=max, rest adiabatic', () => {
  const preset = wall1d();
  const { grid, problem } = assembled(preset);
  const lateralFaces = grid.ny * grid.nz;
  assert.equal(problem.robinFaces.length, 2 * lateralFaces, 'face count');
  for (const f of problem.robinFaces) {
    assert.equal(f.axis, 0, 'all Robin faces are x faces');
    assert.ok(f.boundary, 'all Robin faces lie on the domain boundary');
    if (f.region === 'exterior') assert.equal(f.coord, grid.xs[0]);
    else if (f.region === 'interior') assert.equal(f.coord, grid.xs[grid.nx]);
    else assert.fail(`unexpected region ${f.region}`);
  }
  const A = 0.1 * 0.1; // lateral²
  assert.ok(Math.abs(problem.regionAreas.exterior - A) < 1e-12, 'exterior area');
  assert.ok(Math.abs(problem.regionAreas.interior - A) < 1e-12, 'interior area');
});

test('corner2d: interior = solid↔air interface on the t-planes, exterior = x/y=0 planes', () => {
  const preset = corner2d(); // flank 1.0, depth 1.0
  const { grid, problem } = assembled(preset);
  // mirror model.mjs face accumulation for the wall thickness t
  let t = 0;
  for (const th of [0.16, 0.24, 0.015]) t += th;
  const len = t + 1.0;

  assert.ok(Math.abs(problem.regionAreas.exterior - 2 * len * 1.0) < 1e-9 * 2 * len,
    `exterior area ${problem.regionAreas.exterior} vs ${2 * len}`);
  assert.ok(Math.abs(problem.regionAreas.interior - 2 * 1.0 * 1.0) < 1e-9 * 2,
    `interior area ${problem.regionAreas.interior} vs 2`);

  for (const f of problem.robinFaces) {
    assert.ok(f.axis === 0 || f.axis === 1, `Robin face on z plane: region ${f.region}`);
    if (f.region === 'exterior') {
      assert.ok(f.boundary, 'exterior face must be on the domain boundary');
      assert.equal(f.coord, 0, 'exterior faces on the x=0 / y=0 planes');
    } else if (f.region === 'interior') {
      assert.ok(!f.boundary, 'interior face must be a solid↔void interface');
      assert.ok(Math.abs(f.coord - t) < 1e-12, `interior face at ${f.coord}, expected ${t}`);
    } else {
      assert.fail(`unexpected region ${f.region}`);
    }
  }
});

test('corner2d: air nodes inactive, solid nodes active', () => {
  const preset = corner2d();
  const { grid, problem } = assembled(preset);
  assert.equal(problem.active[nodeIndex(grid, 0, 0, 0)], 1, 'outer corner node active');
  assert.equal(problem.active[nodeIndex(grid, grid.nx, grid.ny, 0)], 0,
    'far air-quadrant corner node inactive');
});

test('regionNodes returns the unique surface nodes of a region', () => {
  const preset = wall1d();
  const { grid, problem } = assembled(preset);
  const nodes = regionNodes(problem, 'interior');
  assert.equal(nodes.length, (grid.ny + 1) * (grid.nz + 1));
  for (const n of nodes) assert.equal(problem.active[n], 1);
});

// ------------------------------------------------- Dirichlet + operator

const unitMaterials = { unit: { lambda: 1, rho: 1, c: 1 } };

function rodModel() {
  return {
    boxes: [{ name: 'rod', x: [0, 1], y: [0, 1], z: [0, 1], material: 'unit' }],
    background: 'void',
    bcs: [
      { name: 'cold', select: { axis: 'x', side: 'min' }, type: 'dirichlet', value: 0 },
      { name: 'hot', select: { axis: 'x', side: 'max' }, type: 'dirichlet', value: 1 },
      { name: 'cuts', select: 'rest', type: 'adiabatic' },
    ],
    gridSpec: {
      x: { mandatory: [0, 1], maxH: 0.25 },
      y: { mandatory: [0, 1], maxH: 1, minCells: 1 },
      z: { mandatory: [0, 1], maxH: 1, minCells: 1 },
    },
  };
}

test('Dirichlet faces mark nodes with evaluated values; identity rows in diag/b/applyA', () => {
  const model = {
    ...rodModel(),
    bcs: [
      { name: 'fixed', select: { axis: 'x', side: 'min' }, type: 'dirichlet',
        value: (x, y, z) => y + z },
      { name: 'robin', select: { axis: 'x', side: 'max' }, type: 'robin',
        h: 10, T: { mean: 5 } },
      { name: 'cuts', select: 'rest', type: 'adiabatic' },
    ],
  };
  const grid = buildGrid(model.gridSpec);
  const painted = paintBoxes(grid, model.boxes, model.background);
  const problem = assemble(grid, painted, unitMaterials, model.bcs);

  let nDirichlet = 0;
  for (let k = 0; k <= grid.nz; k++) {
    for (let j = 0; j <= grid.ny; j++) {
      for (let i = 0; i <= grid.nx; i++) {
        const n = nodeIndex(grid, i, j, k);
        if (i === 0) {
          nDirichlet++;
          assert.equal(problem.isDirichlet[n], 1, `node x=min (${j},${k}) marked`);
          const want = grid.ys[j] + grid.zs[k];
          assert.ok(Math.abs(problem.dirichletValue[n] - want) < 1e-14, 'evaluated value');
          assert.equal(problem.diag[n], 1, 'identity diagonal');
          assert.ok(Math.abs(problem.b[n] - want) < 1e-14, 'b carries the value');
          assert.ok(Math.abs(problem.x0[n] - want) < 1e-14, 'x0 carries the value');
        } else {
          assert.equal(problem.isDirichlet[n], 0);
        }
      }
    }
  }
  assert.equal(nDirichlet, (grid.ny + 1) * (grid.nz + 1));

  // applyA acts as identity on constrained rows
  const x = new Float64Array(problem.nNodes);
  for (let n = 0; n < problem.nNodes; n++) x[n] = 0.1 * n - 3;
  const y = new Float64Array(problem.nNodes).fill(123); // must be overwritten
  applyA(problem, x, y);
  for (let n = 0; n < problem.nNodes; n++) {
    if (problem.isDirichlet[n]) assert.equal(y[n], x[n], `identity row at ${n}`);
  }
});

test('Dirichlet elimination solves the 1D rod exactly: T(x) = x', () => {
  const model = rodModel();
  const grid = buildGrid(model.gridSpec);
  const painted = paintBoxes(grid, model.boxes, model.background);
  const problem = assemble(grid, painted, unitMaterials, model.bcs);
  const { x: T, converged } = cg({
    apply: (v, out) => applyA(problem, v, out),
    b: problem.b, diag: problem.diag, x0: problem.x0, tol: 1e-13, maxIter: 1000,
  });
  assert.ok(converged);
  for (let k = 0; k <= grid.nz; k++) {
    for (let j = 0; j <= grid.ny; j++) {
      for (let i = 0; i <= grid.nx; i++) {
        const err = Math.abs(T[nodeIndex(grid, i, j, k)] - grid.xs[i]);
        assert.ok(err < 1e-10, `T at x=${grid.xs[i]} off by ${err}`);
      }
    }
  }
});

test('masked operator (K + H with identity rows) is symmetric: ⟨Ax,y⟩ = ⟨x,Ay⟩', () => {
  const { problem } = assembled(corner2d());
  const n = problem.nNodes;
  // deterministic LCG fill
  let s = 42;
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = rand(); y[i] = rand(); }
  const Ax = new Float64Array(n);
  const Ay = new Float64Array(n);
  applyA(problem, x, Ax);
  applyA(problem, y, Ay);
  const a = dot(Ax, y);
  const b = dot(x, Ay);
  assert.ok(Math.abs(a - b) <= 1e-10 * Math.max(Math.abs(a), 1),
    `asymmetry ⟨Ax,y⟩=${a} vs ⟨x,Ay⟩=${b}`);
});

test('boundaryFlux exposes per-region flux with signs (out of the solid positive)', () => {
  const preset = wall1d();
  const { problem } = assembled(preset);
  // synthetic linear field warmer inside: T = 9 at x=0 … 20 at x=end
  const grid = problem.grid;
  const T = new Float64Array(problem.nNodes);
  const xEnd = grid.xs[grid.nx];
  for (let k = 0; k <= grid.nz; k++) {
    for (let j = 0; j <= grid.ny; j++) {
      for (let i = 0; i <= grid.nx; i++) {
        T[nodeIndex(grid, i, j, k)] = 9 + 11 * (grid.xs[i] / xEnd);
      }
    }
  }
  const { byRegion } = boundaryFlux(problem, T);
  // exterior surface at T=9 equals ambient 9 → zero; interior at 20 equals ambient → zero
  assert.ok(Math.abs(byRegion.exterior) < 1e-12, 'exterior flux zero when T=ambient');
  assert.ok(Math.abs(byRegion.interior) < 1e-12, 'interior flux zero when T=ambient');
});

// ====================================================================
// M2 primitives (DESIGN §3.2–§3.3) — written BEFORE the harmonic code.
// ====================================================================

/** ∫ ρc N_a N_b dV on an hx×hy×hz box via 2×2×2 Gauss (exact for trilinear). */
function quadratureElementC(hx, hy, hz, rhoc) {
  const g = 1 / Math.sqrt(3);
  const C = new Float64Array(64);
  const J = (hx * hy * hz) / 8;
  const sign = (a, bit) => (((a >> bit) & 1) ? 1 : -1);
  for (const xi of [-g, g]) {
    for (const eta of [-g, g]) {
      for (const zeta of [-g, g]) {
        const N = [];
        for (let a = 0; a < 8; a++) {
          N.push(((1 + sign(a, 0) * xi) * (1 + sign(a, 1) * eta) * (1 + sign(a, 2) * zeta)) / 8);
        }
        for (let a = 0; a < 8; a++) {
          for (let b = 0; b < 8; b++) C[a * 8 + b] += rhoc * J * N[a] * N[b];
        }
      }
    }
  }
  return C;
}

test('elementC (consistent mass) matches direct Gauss quadrature', () => {
  const cases = [
    [1, 1, 1, 1],
    [0.025, 0.05, 0.1, 2.4e6],
    [0.003, 0.2, 0.01, 2.9e4],
  ];
  for (const [hx, hy, hz, rhoc] of cases) {
    const C = elementC(hx, hy, hz, rhoc);
    const Q = quadratureElementC(hx, hy, hz, rhoc);
    const scale = maxAbs(Q);
    for (let i = 0; i < 64; i++) {
      assert.ok(Math.abs(C[i] - Q[i]) <= 1e-12 * scale,
        `C[${i}] = ${C[i]} vs quadrature ${Q[i]} (h=${hx},${hy},${hz})`);
    }
    // total mass conserved: Σ_ab C = ρc·V; each row sums to ρc·V/8
    let total = 0;
    for (let a = 0; a < 8; a++) {
      let row = 0;
      for (let b = 0; b < 8; b++) { row += C[a * 8 + b]; total += C[a * 8 + b]; }
      assert.ok(Math.abs(row - (rhoc * hx * hy * hz) / 8) <= 1e-9 * scale, `row ${a} mass`);
    }
    assert.ok(Math.abs(total - rhoc * hx * hy * hz) <= 1e-9 * Math.max(scale, 1), 'total mass');
  }
});

const harmMaterials = { concrete: { lambda: 2.1, rho: 2400, c: 1000 } };

function harmBox() {
  return {
    boxes: [{ name: 'b', x: [0, 0.2], y: [0, 0.2], z: [0, 0.2], material: 'concrete' }],
    background: 'air',
    bcs: [
      { name: 'exterior', select: { axis: 'x', side: 'min' }, type: 'robin', h: 25, T: { mean: 0 } },
      { name: 'interior', select: 'rest', type: 'robin', h: 7.7, T: { mean: 0 } },
    ],
    gridSpec: {
      x: { mandatory: [0, 0.2], maxH: 0.05, minCells: 2 },
      y: { mandatory: [0, 0.2], maxH: 0.05, minCells: 2 },
      z: { mandatory: [0, 0.2], maxH: 0.05, minCells: 2 },
    },
  };
}

test('assemble stashes ρc per solid cell (zero for void)', () => {
  const grid = buildGrid(harmBox().gridSpec);
  const painted = paintBoxes(grid, harmBox().boxes, 'air');
  const problem = assemble(grid, painted, harmMaterials, harmBox().bcs);
  assert.ok(problem.cellRhoC, 'cellRhoC present');
  let solid = 0;
  for (let c = 0; c < problem.cellRhoC.length; c++) {
    if (problem.cellLambda[c] > 0) {
      solid++;
      assert.equal(problem.cellRhoC[c], 2400 * 1000, 'ρc = ρ·c on solid cells');
    } else {
      assert.equal(problem.cellRhoC[c], 0, 'void cells carry no capacity');
    }
  }
  assert.ok(solid > 0, 'box has solid cells');
});

test('applyAComplex is complex-symmetric in the unconjugated form ⟨Ax,y⟩ = ⟨x,Ay⟩', () => {
  const grid = buildGrid(harmBox().gridSpec);
  const painted = paintBoxes(grid, harmBox().boxes, 'air');
  const problem = assemble(grid, painted, harmMaterials, harmBox().bcs);
  const n = problem.nNodes;
  const omega = OMEGA_DIURNAL;

  let s = 7;
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  const xRe = new Float64Array(n);
  const xIm = new Float64Array(n);
  const yRe = new Float64Array(n);
  const yIm = new Float64Array(n);
  for (let i = 0; i < n; i++) { xRe[i] = rand(); xIm[i] = rand(); yRe[i] = rand(); yIm[i] = rand(); }

  const AxRe = new Float64Array(n);
  const AxIm = new Float64Array(n);
  const AyRe = new Float64Array(n);
  const AyIm = new Float64Array(n);
  applyAComplex(problem, omega, xRe, xIm, AxRe, AxIm);
  applyAComplex(problem, omega, yRe, yIm, AyRe, AyIm);

  // unconjugated complex bilinear form ⟨u,v⟩ = Σ u_i v_i
  const cdot = (uRe, uIm, vRe, vIm) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      re += uRe[i] * vRe[i] - uIm[i] * vIm[i];
      im += uRe[i] * vIm[i] + uIm[i] * vRe[i];
    }
    return [re, im];
  };
  const [lRe, lIm] = cdot(AxRe, AxIm, yRe, yIm);
  const [rRe, rIm] = cdot(xRe, xIm, AyRe, AyIm);
  const scale = Math.max(Math.abs(lRe), Math.abs(lIm), 1);
  assert.ok(Math.abs(lRe - rRe) <= 1e-9 * scale, `re asymmetry ${lRe} vs ${rRe}`);
  assert.ok(Math.abs(lIm - rIm) <= 1e-9 * scale, `im asymmetry ${lIm} vs ${rIm}`);
});

test('applyAComplex reduces to the real steady operator at ω = 0', () => {
  const grid = buildGrid(harmBox().gridSpec);
  const painted = paintBoxes(grid, harmBox().boxes, 'air');
  const problem = assemble(grid, painted, harmMaterials, harmBox().bcs);
  const n = problem.nNodes;
  let s = 3;
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = rand();

  const ySteady = new Float64Array(n);
  applyA(problem, x, ySteady);
  const yRe = new Float64Array(n);
  const yIm = new Float64Array(n);
  const zeroIm = new Float64Array(n);
  applyAComplex(problem, 0, x, zeroIm, yRe, yIm);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(yRe[i] - ySteady[i]) <= 1e-12 * (Math.abs(ySteady[i]) + 1),
      `ω=0 real part differs at ${i}`);
    assert.equal(yIm[i], 0, `ω=0 imaginary part nonzero at ${i}`);
  }
});

test('assembleHarmonicLoad: complex Robin load and zeroed constrained rows', () => {
  const grid = buildGrid(harmBox().gridSpec);
  const painted = paintBoxes(grid, harmBox().boxes, 'air');
  const problem = assemble(grid, painted, harmMaterials, harmBox().bcs);
  const { bRe, bIm } = assembleHarmonicLoad(problem, OMEGA_DIURNAL,
    { exterior: { re: 1, im: 0 }, interior: { re: 0, im: 0 } });
  assert.equal(bRe.length, problem.nNodes);
  // void nodes carry no load
  for (let nn = 0; nn < problem.nNodes; nn++) {
    if (!problem.active[nn]) { assert.equal(bRe[nn], 0); assert.equal(bIm[nn], 0); }
  }
  // exterior surface nodes get a real load h·T̂·∮N dA > 0; nowhere imaginary here
  let anyExt = 0;
  for (const nn of regionNodes(problem, 'exterior')) if (bRe[nn] > 0) anyExt++;
  assert.ok(anyExt > 0, 'exterior Robin load applied');
  for (let nn = 0; nn < problem.nNodes; nn++) assert.equal(bIm[nn], 0, 'real ambient → real load');
});
