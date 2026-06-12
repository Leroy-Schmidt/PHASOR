// PHASOR FEM core (DESIGN.md §3.2–§3.3): trilinear hexahedral elements on the
// rectilinear grid, matrix-free operator application, Robin / Dirichlet /
// adiabatic boundary handling, consistent boundary fluxes.
// Pure and DOM-free; runs under `node --test`.
//
// Discrete steady system (ω = 0):  (K + H) T = b  — real, symmetric positive
// definite once void ("air") and Dirichlet nodes are reduced to identity rows
// with matching right-hand sides (decision logged in CLAUDE.md, M1).
//
// Local node ordering inside a cell: a = di + 2*dj + 4*dk, di ↔ x fastest —
// the same convention as the global node indexing (CLAUDE.md, M0).
// Element matrices come from Kronecker products of the 1D matrices
//   stiffness (1/h)[[1,−1],[−1,1]],  mass (h/6)[[2,1],[1,2]]
// verified against direct Gauss quadrature in test/fem.test.mjs.

const AXIS = { x: 0, y: 1, z: 2 };

// [axis, dir] of the six cell faces
const FACE_DIRS = [
  [0, -1], [0, 1],
  [1, -1], [1, 1],
  [2, -1], [2, 1],
];

// 4-node face mass pattern: M_f = (area/36) · FACE_P, nodes ordered a = du + 2*dv
const FACE_P = Float64Array.from([
  4, 2, 2, 1,
  2, 4, 1, 2,
  2, 1, 4, 2,
  1, 2, 2, 4,
]);

/**
 * 8×8 element conductivity matrix ∫ λ ∇N_a·∇N_b dV for an hx×hy×hz box,
 * row-major in `out[a*8+b]`.
 */
export function elementK(hx, hy, hz, lambda, out = new Float64Array(64)) {
  // 1D matrices as [row*2+col]
  const kx = [1 / hx, -1 / hx, -1 / hx, 1 / hx];
  const ky = [1 / hy, -1 / hy, -1 / hy, 1 / hy];
  const kz = [1 / hz, -1 / hz, -1 / hz, 1 / hz];
  const mx = [hx / 3, hx / 6, hx / 6, hx / 3];
  const my = [hy / 3, hy / 6, hy / 6, hy / 3];
  const mz = [hz / 3, hz / 6, hz / 6, hz / 3];
  for (let a = 0; a < 8; a++) {
    const ia = a & 1;
    const ja = (a >> 1) & 1;
    const ka = (a >> 2) & 1;
    for (let b = 0; b < 8; b++) {
      const x = ia * 2 + (b & 1);
      const y = ja * 2 + ((b >> 1) & 1);
      const z = ka * 2 + ((b >> 2) & 1);
      out[a * 8 + b] = lambda *
        (kx[x] * my[y] * mz[z] + mx[x] * ky[y] * mz[z] + mx[x] * my[y] * kz[z]);
    }
  }
  return out;
}

/** 4×4 face mass matrix ∫ N_a N_b dA on an hu×hv rectangle, a = du + 2*dv. */
export function faceMass(hu, hv, out = new Float64Array(16)) {
  const s = (hu * hv) / 36;
  for (let i = 0; i < 16; i++) out[i] = s * FACE_P[i];
  return out;
}

function selectorMatches(select, face) {
  if (select === 'rest') return true;
  if (select.axis !== undefined) {
    return face.boundary && face.axis === AXIS[select.axis] &&
      (select.side === 'min' ? face.dir < 0 : face.dir > 0);
  }
  if (select.faces) {
    return face.boundary && select.faces.some((s) => {
      const [ax, side] = s.split('=');
      return face.axis === AXIS[ax] && (side === 'min' ? face.dir < 0 : face.dir > 0);
    });
  }
  if (select.facesInside) return !face.boundary;
  return false;
}

/**
 * Assemble the steady-state problem: active/void masks, classified Robin
 * faces, Dirichlet constraints (eliminated), Jacobi diagonal, load vector.
 *
 * @param {object} grid — from buildGrid
 * @param {{cells: Uint16Array, matIds: string[]}} painted — from paintBoxes
 * @param {Record<string, {lambda: number}>} materials — ids absent here are void
 * @param {object[]} bcs — preset BC list; first matching selector wins per face
 */
export function assemble(grid, painted, materials, bcs) {
  const { nx, ny, nz, dx, dy, dz, xs, ys, zs } = grid;
  const sy = nx + 1;
  const sz = (nx + 1) * (ny + 1);
  const nNodes = sz * (nz + 1);
  const nCells = nx * ny * nz;

  const lambdaByMat = painted.matIds.map((id) => (materials[id] ? materials[id].lambda : 0));

  // --- solid cells and active nodes
  const cellLambda = new Float64Array(nCells);
  const active = new Uint8Array(nNodes);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      let c = nx * (j + ny * k);
      let n0 = sy * j + sz * k;
      for (let i = 0; i < nx; i++, c++, n0++) {
        const lam = lambdaByMat[painted.cells[c]];
        if (lam === 0) continue;
        cellLambda[c] = lam;
        active[n0] = 1; active[n0 + 1] = 1;
        active[n0 + sy] = 1; active[n0 + sy + 1] = 1;
        active[n0 + sz] = 1; active[n0 + sz + 1] = 1;
        active[n0 + sz + sy] = 1; active[n0 + sz + sy + 1] = 1;
      }
    }
  }

  // --- boundary faces of the solid domain: on the domain boundary, or facing void
  const robinFaces = [];
  const isDirichlet = new Uint8Array(nNodes);
  const dirichletValue = new Float64Array(nNodes);
  const regionAreas = {};
  let anyDirichlet = false;

  const solid = (i, j, k) =>
    i >= 0 && i < nx && j >= 0 && j < ny && k >= 0 && k < nz &&
    cellLambda[i + nx * (j + ny * k)] > 0;

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (cellLambda[i + nx * (j + ny * k)] === 0) continue;
        for (const [axis, dir] of FACE_DIRS) {
          const inGrid = axis === 0 ? solid(i + dir, j, k)
            : axis === 1 ? solid(i, j + dir, k)
            : solid(i, j, k + dir);
          if (inGrid) continue; // internal solid↔solid face
          const outside =
            (axis === 0 && (dir < 0 ? i === 0 : i === nx - 1)) ||
            (axis === 1 && (dir < 0 ? j === 0 : j === ny - 1)) ||
            (axis === 2 && (dir < 0 ? k === 0 : k === nz - 1));

          // plane index and the four nodes, a = du + 2*dv
          let coord;
          let hu;
          let hv;
          const nid = new Int32Array(4);
          const nijk = [];
          if (axis === 0) {
            const ip = dir > 0 ? i + 1 : i;
            coord = xs[ip];
            hu = dy[j]; hv = dz[k]; // u ↔ y, v ↔ z
            for (let a = 0; a < 4; a++) {
              const ja = j + (a & 1);
              const ka = k + ((a >> 1) & 1);
              nid[a] = ip + sy * ja + sz * ka;
              nijk.push([ip, ja, ka]);
            }
          } else if (axis === 1) {
            const jp = dir > 0 ? j + 1 : j;
            coord = ys[jp];
            hu = dx[i]; hv = dz[k]; // u ↔ x, v ↔ z
            for (let a = 0; a < 4; a++) {
              const ia = i + (a & 1);
              const ka = k + ((a >> 1) & 1);
              nid[a] = ia + sy * jp + sz * ka;
              nijk.push([ia, jp, ka]);
            }
          } else {
            const kp = dir > 0 ? k + 1 : k;
            coord = zs[kp];
            hu = dx[i]; hv = dy[j]; // u ↔ x, v ↔ y
            for (let a = 0; a < 4; a++) {
              const ia = i + (a & 1);
              const ja = j + ((a >> 1) & 1);
              nid[a] = ia + sy * ja + sz * kp;
              nijk.push([ia, ja, kp]);
            }
          }
          const face = { axis, dir, coord, boundary: outside, area: hu * hv, nodes: nid };

          for (const bc of bcs) {
            if (!selectorMatches(bc.select, face)) continue;
            if (bc.type === 'robin') {
              face.region = bc.name;
              face.h = bc.h;
              face.Tamb = bc.T.mean;
              robinFaces.push(face);
              regionAreas[bc.name] = (regionAreas[bc.name] ?? 0) + face.area;
            } else if (bc.type === 'dirichlet') {
              anyDirichlet = true;
              for (let a = 0; a < 4; a++) {
                const n = nid[a];
                if (isDirichlet[n]) continue; // first claim wins
                const [ia, ja, ka] = nijk[a];
                isDirichlet[n] = 1;
                dirichletValue[n] = typeof bc.value === 'function'
                  ? bc.value(xs[ia], ys[ja], zs[ka])
                  : bc.value;
              }
            } // adiabatic: natural BC, do nothing
            break; // first matching bc wins
          }
        }
      }
    }
  }

  const free = new Uint8Array(nNodes);
  for (let n = 0; n < nNodes; n++) free[n] = active[n] && !isDirichlet[n] ? 1 : 0;

  const problem = {
    grid, painted, nNodes, cellLambda,
    active, isDirichlet, dirichletValue, free,
    robinFaces, regionAreas,
    diag: new Float64Array(nNodes),
    b: new Float64Array(nNodes),
    x0: new Float64Array(nNodes),
  };

  // --- Jacobi diagonal of K + H, identity on constrained rows
  const { diag } = problem;
  const Ke = new Float64Array(64);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      let c = nx * (j + ny * k);
      let n0 = sy * j + sz * k;
      for (let i = 0; i < nx; i++, c++, n0++) {
        const lam = cellLambda[c];
        if (lam === 0) continue;
        elementK(dx[i], dy[j], dz[k], lam, Ke);
        for (let a = 0; a < 8; a++) {
          const n = n0 + (a & 1) + sy * ((a >> 1) & 1) + sz * ((a >> 2) & 1);
          diag[n] += Ke[a * 8 + a];
        }
      }
    }
  }
  for (const f of robinFaces) {
    const add = (f.h * f.area) / 9; // diagonal of (area/36)·FACE_P
    for (let a = 0; a < 4; a++) diag[f.nodes[a]] += add;
  }
  for (let n = 0; n < nNodes; n++) if (!free[n]) diag[n] = 1;

  // --- load vector: Robin ambient loads, then Dirichlet elimination
  const { b, x0 } = problem;
  for (const f of robinFaces) {
    const load = (f.h * f.Tamb * f.area) / 4; // h·T_amb·∮N_a dA
    for (let a = 0; a < 4; a++) b[f.nodes[a]] += load;
  }
  if (anyDirichlet) {
    const g = new Float64Array(nNodes);
    for (let n = 0; n < nNodes; n++) {
      if (isDirichlet[n]) {
        g[n] = dirichletValue[n];
        x0[n] = dirichletValue[n];
      }
    }
    const w = new Float64Array(nNodes);
    scatterKH(problem, g, w); // w = (K+H)·g, read on free rows only
    for (let n = 0; n < nNodes; n++) {
      if (free[n]) b[n] -= w[n];
      else b[n] = isDirichlet[n] ? dirichletValue[n] : 0;
    }
  } else {
    for (let n = 0; n < nNodes; n++) if (!active[n]) b[n] = 0;
  }
  return problem;
}

/** y += (K + H)·x, no masking — shared by applyA and Dirichlet elimination. */
function scatterKH(problem, x, y) {
  const { grid, cellLambda, robinFaces } = problem;
  const { nx, ny, nz, dx, dy, dz } = grid;
  const sy = nx + 1;
  const sz = (nx + 1) * (ny + 1);
  const Ke = new Float64Array(64);
  const idx = new Int32Array(8);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      let c = nx * (j + ny * k);
      let n0 = sy * j + sz * k;
      for (let i = 0; i < nx; i++, c++, n0++) {
        const lam = cellLambda[c];
        if (lam === 0) continue;
        elementK(dx[i], dy[j], dz[k], lam, Ke);
        idx[0] = n0; idx[1] = n0 + 1;
        idx[2] = n0 + sy; idx[3] = n0 + sy + 1;
        idx[4] = n0 + sz; idx[5] = n0 + sz + 1;
        idx[6] = n0 + sz + sy; idx[7] = n0 + sz + sy + 1;
        for (let a = 0; a < 8; a++) {
          const ra = a * 8;
          let acc = 0;
          for (let bb = 0; bb < 8; bb++) acc += Ke[ra + bb] * x[idx[bb]];
          y[idx[a]] += acc;
        }
      }
    }
  }
  for (const f of robinFaces) {
    const s = (f.h * f.area) / 36;
    const n = f.nodes;
    for (let a = 0; a < 4; a++) {
      const ra = a * 4;
      let acc = 0;
      for (let bb = 0; bb < 4; bb++) acc += FACE_P[ra + bb] * x[n[bb]];
      y[n[a]] += s * acc;
    }
  }
}

/**
 * y ← A x with A = (K + H) on free nodes, identity on void and Dirichlet
 * nodes (rows AND columns masked — keeps A symmetric positive definite).
 */
export function applyA(problem, x, y) {
  const { nNodes, free } = problem;
  const xm = problem._xm ?? (problem._xm = new Float64Array(nNodes));
  for (let n = 0; n < nNodes; n++) xm[n] = free[n] ? x[n] : 0;
  y.fill(0);
  scatterKH(problem, xm, y);
  for (let n = 0; n < nNodes; n++) if (!free[n]) y[n] = x[n];
}

/**
 * Consistent boundary fluxes per Robin region: Φ_r = Σ h (∮T dA − T_amb·A),
 * positive = heat leaving the solid. Σ_r Φ_r vanishes for an all-Robin
 * problem up to the solver residual (gate G1.3).
 */
export function boundaryFlux(problem, T) {
  const byRegion = {};
  for (const f of problem.robinFaces) {
    const n = f.nodes;
    const Tmean = (T[n[0]] + T[n[1]] + T[n[2]] + T[n[3]]) / 4;
    const phi = f.h * f.area * (Tmean - f.Tamb);
    byRegion[f.region] = (byRegion[f.region] ?? 0) + phi;
  }
  const phis = Object.values(byRegion);
  const imbalance = Math.abs(phis.reduce((s, v) => s + v, 0));
  const throughput = phis.length ? Math.max(...phis.map(Math.abs)) : 0;
  return { byRegion, imbalance, throughput };
}

/** Unique node ids touched by a Robin region's faces (e.g. for f_Rsi minima). */
export function regionNodes(problem, region) {
  const set = new Set();
  for (const f of problem.robinFaces) {
    if (f.region !== region) continue;
    for (const n of f.nodes) set.add(n);
  }
  return Int32Array.from(set);
}
