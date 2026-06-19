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

/**
 * 8×8 element capacity ("mass") matrix ∫ ρc N_a N_b dV for an hx×hy×hz box,
 * consistent (not lumped), row-major in `out[a*8+b]`. Kronecker product of the
 * 1D mass matrices (h/6)[[2,1],[1,2]] — the same `m*` used inside elementK.
 */
export function elementC(hx, hy, hz, rhoc, out = new Float64Array(64)) {
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
      out[a * 8 + b] = rhoc * mx[x] * my[y] * mz[z];
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
  // ρc per material for the harmonic capacity term (0 where ρ or c is absent —
  // e.g. unit-λ test materials and void); harmless for the real steady path.
  const rhocByMat = painted.matIds.map((id) => {
    const m = materials[id];
    return m && m.rho != null && m.c != null ? m.rho * m.c : 0;
  });

  // --- solid cells and active nodes
  const cellLambda = new Float64Array(nCells);
  const cellRhoC = new Float64Array(nCells);
  const active = new Uint8Array(nNodes);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      let c = nx * (j + ny * k);
      let n0 = sy * j + sz * k;
      for (let i = 0; i < nx; i++, c++, n0++) {
        const lam = lambdaByMat[painted.cells[c]];
        if (lam === 0) continue;
        cellLambda[c] = lam;
        cellRhoC[c] = rhocByMat[painted.cells[c]];
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
          const face = { axis, dir, coord, boundary: outside, area: hu * hv, nodes: nid, cell: i + nx * (j + ny * k) };

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
  let allFree = true;
  for (let n = 0; n < nNodes; n++) {
    free[n] = active[n] && !isDirichlet[n] ? 1 : 0;
    if (!free[n]) allFree = false;
  }
  let allSolid = true;
  for (let c = 0; c < nCells; c++) if (cellLambda[c] === 0) { allSolid = false; break; }

  const problem = {
    grid, painted, nNodes, cellLambda, cellRhoC,
    active, isDirichlet, dirichletValue, free, anyDirichlet, allFree, allSolid,
    robinFaces, regionAreas,
    diag: new Float64Array(nNodes),
    diagC: new Float64Array(nNodes), // raw diag of C (no identity); masked by callers
    b: new Float64Array(nNodes),
    x0: new Float64Array(nNodes),
  };

  // --- Jacobi diagonals: diag(K + H) (identity on constrained rows) and the
  // raw capacity diagonal diag(C) (used to form the complex preconditioner)
  const { diag, diagC } = problem;
  const Ke = new Float64Array(64);
  const Ce = new Float64Array(64);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      let c = nx * (j + ny * k);
      let n0 = sy * j + sz * k;
      for (let i = 0; i < nx; i++, c++, n0++) {
        const lam = cellLambda[c];
        if (lam === 0) continue;
        elementK(dx[i], dy[j], dz[k], lam, Ke);
        elementC(dx[i], dy[j], dz[k], cellRhoC[c], Ce);
        for (let a = 0; a < 8; a++) {
          const n = n0 + (a & 1) + sy * ((a >> 1) & 1) + sz * ((a >> 2) & 1);
          diag[n] += Ke[a * 8 + a];
          diagC[n] += Ce[a * 8 + a];
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

// ====================================================================
// M2 — complex operator (K + iωC + H) for the harmonic solve.
// Fields are stored as separate re/im arrays (CLAUDE.md M2 decision). The
// operator is complex SYMMETRIC (not Hermitian) → COCG. (DESIGN §3.3–§3.4)
// ====================================================================

/**
 * Group an axis's spacings into a few representatives (within a relative
 * tolerance), returning a per-tick small-int index and the representative
 * values. A uniform axis collapses to one group; graded axes (adjacent ratio
 * ≥ ~1.1, far above tol) stay distinct. The few-bits spread between nominally
 * equal cell sizes (accumulated tick subtraction) is what we coalesce here.
 */
function groupSpacings(d, rtol = 1e-9) {
  const reps = [];
  const idx = new Int32Array(d.length);
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    let g = -1;
    for (let u = 0; u < reps.length; u++) {
      if (Math.abs(v - reps[u]) <= rtol * Math.max(Math.abs(v), Math.abs(reps[u]))) { g = u; break; }
    }
    if (g < 0) { g = reps.length; reps.push(v); }
    idx[i] = g;
  }
  return { idx, reps };
}

/**
 * Deduplicated per-cell element matrices (Ke, Ce), built once and reused across
 * every COCG matvec. On a uniform single-material box this collapses to a
 * single (Ke, Ce) pair (built from each axis's representative spacing), so the
 * matvec stays matrix-free without rebuilding — or storing — millions of 8×8
 * matrices. Keying is by integer (spacing-group × material), no string churn.
 */
function ensureElemTables(problem) {
  if (problem._elem) return problem._elem;
  const { grid, cellLambda, cellRhoC, painted } = problem;
  const { nx, ny, nz, dx, dy, dz } = grid;
  const gx = groupSpacings(dx);
  const gy = groupSpacings(dy);
  const gz = groupSpacings(dz);
  const nMat = painted.matIds.length;

  const map = new Map(); // integer key → element-type index
  const cellElem = new Int32Array(nx * ny * nz).fill(-1);
  const KeList = [];
  const CeList = [];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      let c = nx * (j + ny * k);
      for (let i = 0; i < nx; i++, c++) {
        const lam = cellLambda[c];
        if (lam === 0) continue;
        const key = ((gx.idx[i] * gy.reps.length + gy.idx[j]) * gz.reps.length + gz.idx[k]) * nMat
          + painted.cells[c];
        let idx = map.get(key);
        if (idx === undefined) {
          idx = KeList.length;
          KeList.push(elementK(gx.reps[gx.idx[i]], gy.reps[gy.idx[j]], gz.reps[gz.idx[k]], lam));
          CeList.push(elementC(gx.reps[gx.idx[i]], gy.reps[gy.idx[j]], gz.reps[gz.idx[k]], cellRhoC[c]));
          map.set(key, idx);
        }
        cellElem[c] = idx;
      }
    }
  }
  problem._elem = { KeList, CeList, cellElem };
  return problem._elem;
}

/**
 * Element tables with the capacity pre-scaled by ω (E_im = ωC), cached for the
 * current ω so the matvec inner loop carries no ω multiply. The harmonic
 * element matrix is K + iE_im; both K and E_im are symmetric.
 */
function ensureOmegaTables(problem, omega) {
  const t = ensureElemTables(problem);
  if (t._omega !== omega) {
    t.EimList = t.CeList.map((Ce) => {
      const E = new Float64Array(64);
      for (let i = 0; i < 64; i++) E[i] = omega * Ce[i];
      return E;
    });
    t._omega = omega;
  }
  return t;
}

/**
 * y += (K + iωC + H)·x on the UNMASKED operator (no identity rows). Caller
 * must pre-zero y. Shared by applyAComplex (on masked inputs) and the complex
 * Dirichlet elimination. (K + iωC)x: re = K·xRe − ωC·xIm, im = K·xIm + ωC·xRe.
 *
 * A uniform all-solid box hoists its single element matrix out of the loop; ωC
 * is pre-scaled (EimList) so the inner reduction carries no ω multiply.
 */
function scatterKHC(problem, omega, xRe, xIm, yRe, yIm) {
  const { grid, robinFaces, allSolid } = problem;
  const { nx, ny, nz } = grid;
  const sy = nx + 1;
  const sz = (nx + 1) * (ny + 1);
  const { KeList, EimList, cellElem } = ensureOmegaTables(problem, omega);
  const hoist = allSolid && KeList.length === 1; // uniform single-material box
  const Ke0 = KeList[0];
  const Ei0 = EimList[0];
  const idx = new Int32Array(8);
  const gxRe = new Float64Array(8);
  const gxIm = new Float64Array(8);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      let c = nx * (j + ny * k);
      let n0 = sy * j + sz * k;
      for (let i = 0; i < nx; i++, c++, n0++) {
        let Ke;
        let Ei;
        if (hoist) {
          Ke = Ke0; Ei = Ei0;
        } else {
          const e = cellElem[c];
          if (e < 0) continue;
          Ke = KeList[e]; Ei = EimList[e];
        }
        idx[0] = n0; idx[1] = n0 + 1;
        idx[2] = n0 + sy; idx[3] = n0 + sy + 1;
        idx[4] = n0 + sz; idx[5] = n0 + sz + 1;
        idx[6] = n0 + sz + sy; idx[7] = n0 + sz + sy + 1;
        for (let a = 0; a < 8; a++) { gxRe[a] = xRe[idx[a]]; gxIm[a] = xIm[idx[a]]; }
        for (let a = 0; a < 8; a++) {
          const ra = a * 8;
          let khRe = 0;
          let khIm = 0;
          let eRe = 0;
          let eIm = 0;
          for (let b = 0; b < 8; b++) {
            const kab = Ke[ra + b];
            const eab = Ei[ra + b];
            khRe += kab * gxRe[b];
            khIm += kab * gxIm[b];
            eRe += eab * gxRe[b];
            eIm += eab * gxIm[b];
          }
          yRe[idx[a]] += khRe - eIm; // (K + iωC)x, ω already folded into Ei
          yIm[idx[a]] += khIm + eRe;
        }
      }
    }
  }
  for (const f of robinFaces) {
    const s = (f.h * f.area) / 36;
    const n = f.nodes;
    for (let a = 0; a < 4; a++) {
      const ra = a * 4;
      let accRe = 0;
      let accIm = 0;
      for (let b = 0; b < 4; b++) {
        accRe += FACE_P[ra + b] * xRe[n[b]];
        accIm += FACE_P[ra + b] * xIm[n[b]];
      }
      yRe[n[a]] += s * accRe;
      yIm[n[a]] += s * accIm;
    }
  }
}

/**
 * (yRe, yIm) ← A (xRe, xIm) with A = (K + iωC + H) on free nodes, identity on
 * void and Dirichlet nodes (rows AND columns masked → keeps A complex
 * symmetric, which COCG requires). At ω = 0 the two components decouple and
 * each reproduces the M1 real operator exactly.
 */
export function applyAComplex(problem, omega, xRe, xIm, yRe, yIm) {
  const { nNodes, free, allFree } = problem;
  // Fast path: nothing constrained (e.g. a fully-solid all-Robin box) → no
  // masking or identity rows needed, apply straight to x.
  if (allFree) {
    yRe.fill(0);
    yIm.fill(0);
    scatterKHC(problem, omega, xRe, xIm, yRe, yIm);
    return;
  }
  const xmRe = problem._xmRe ?? (problem._xmRe = new Float64Array(nNodes));
  const xmIm = problem._xmIm ?? (problem._xmIm = new Float64Array(nNodes));
  for (let n = 0; n < nNodes; n++) {
    if (free[n]) { xmRe[n] = xRe[n]; xmIm[n] = xIm[n]; }
    else { xmRe[n] = 0; xmIm[n] = 0; }
  }
  yRe.fill(0);
  yIm.fill(0);
  scatterKHC(problem, omega, xmRe, xmIm, yRe, yIm);
  for (let n = 0; n < nNodes; n++) {
    if (!free[n]) { yRe[n] = xRe[n]; yIm[n] = xIm[n]; }
  }
}

/**
 * Complex Robin load b̂ = ∮ h·T̂_amb·N_a dA, then Dirichlet elimination of the
 * complex operator (mirrors the steady b in assemble). Returns {bRe, bIm}.
 *
 * @param {object} problem — from assemble
 * @param {number} omega
 * @param {Record<string, {re: number, im?: number}>} ambientByRegion — complex
 *   ambient phasor per Robin region (missing region ⇒ zero ambient)
 * @param {{dirichletRe?: Float64Array, dirichletIm?: Float64Array}} [opts] —
 *   complex Dirichlet phasors; default uses the real dirichletValue (im = 0),
 *   which for harmonic far-field is conventionally 0 (DESIGN §2.2).
 */
export function assembleHarmonicLoad(problem, omega, ambientByRegion = {}, opts = {}) {
  const { nNodes, robinFaces, free, isDirichlet, active, dirichletValue, anyDirichlet } = problem;
  const { dirichletRe, dirichletIm } = opts;
  const bRe = new Float64Array(nNodes);
  const bIm = new Float64Array(nNodes);

  for (const f of robinFaces) {
    const amb = ambientByRegion[f.region];
    if (!amb) continue;
    const sRe = (f.h * (amb.re ?? 0) * f.area) / 4; // h·T̂_amb·∮N_a dA
    const sIm = (f.h * (amb.im ?? 0) * f.area) / 4;
    for (let a = 0; a < 4; a++) { bRe[f.nodes[a]] += sRe; bIm[f.nodes[a]] += sIm; }
  }

  if (anyDirichlet) {
    const gRe = new Float64Array(nNodes);
    const gIm = new Float64Array(nNodes);
    for (let n = 0; n < nNodes; n++) {
      if (!isDirichlet[n]) continue;
      gRe[n] = dirichletRe ? dirichletRe[n] : dirichletValue[n];
      gIm[n] = dirichletIm ? dirichletIm[n] : 0;
    }
    const wRe = new Float64Array(nNodes);
    const wIm = new Float64Array(nNodes);
    scatterKHC(problem, omega, gRe, gIm, wRe, wIm); // w = A·g, read on free rows
    for (let n = 0; n < nNodes; n++) {
      if (free[n]) { bRe[n] -= wRe[n]; bIm[n] -= wIm[n]; }
      else if (isDirichlet[n]) { bRe[n] = gRe[n]; bIm[n] = gIm[n]; }
      else { bRe[n] = 0; bIm[n] = 0; }
    }
  } else {
    for (let n = 0; n < nNodes; n++) if (!active[n]) { bRe[n] = 0; bIm[n] = 0; }
  }
  return { bRe, bIm };
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
