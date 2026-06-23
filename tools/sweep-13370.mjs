// Investigation (not a gate): characterize the 13370-vs-PHASOR steady ground-loss
// gap. Two experiments on the `basement` preset (half-model, ΔT=11 K, per metre
// of strip run; interior loss = |Σ interior-Robin face flux| / thin):
//
//   A. DOMAIN CONVERGENCE — grow soil pad+depth (and the deep-Dirichlet sink).
//      Flat tail ⇒ gap is NOT a finite-domain artifact.
//   B. DEPTH SWEEP + FLOOR/WALL DECOMPOSITION — vary basement depth z=roomHeight
//      on a converged domain; split PHASOR loss into floor (horizontal, axis-y)
//      vs wall (vertical, axis-x) faces and compare each to its 13370 term.
//      z→small ⇒ slab-on-ground limit (13370's firmest footing, G1.5b identity).
//      Ratio grows with z ⇒ gap is basement-specific (the 0.5z fold-in + wall
//      fit); ratio flat in z ⇒ gap is in the slab/floor U formula itself.
import { MATERIALS, basement, CLIMATE } from '../src/model.mjs';
import { boundaryFlux } from '../src/fem.mjs';
import { solveSteady } from '../src/worker.mjs';
import { equivalentThickness, basementFloorU, basementWallU } from '../src/standards.mjs';

const SOLVE = { tol: 1e-10, maxIter: 80000 };
const thin = 0.2;                                  // z-extrusion [m]
const dT = CLIMATE.internal.T.mean - CLIMATE.external.T.mean;   // 11 K

// fixed geometry params (basement defaults)
const roomHalfWidth = 2.0, wallThickness = 0.3, slabThickness = 0.2;
const lambdaG = MATERIALS.soil.lambda;             // 2.0
const lambdaC = MATERIALS.concrete.lambda;         // 2.1
const Rsi = 0.13, Rse = 0.04;
const Bp = 2 * roomHalfWidth;                      // 4.0 m — infinite-strip B'
const df = equivalentThickness(wallThickness, lambdaG, Rsi, slabThickness / lambdaC, Rse);
const dwb = equivalentThickness(0, lambdaG, Rsi, wallThickness / lambdaC, Rse);

// Sum interior-Robin face flux, split by face orientation (replicates boundaryFlux
// per-face, then buckets: axis 1 = horizontal floor top, axis 0 = vertical wall inner).
function interiorSplit(problem, T) {
  let floor = 0, wall = 0;
  for (const f of problem.robinFaces) {
    if (f.region !== 'interior') continue;
    const n = f.nodes;
    const Tmean = (T[n[0]] + T[n[1]] + T[n[2]] + T[n[3]]) / 4;
    const phi = f.h * f.area * (Tmean - f.Tamb);
    if (f.axis === 1) floor += phi; else if (f.axis === 0) wall += phi;
  }
  return { floor: Math.abs(floor) / thin, wall: Math.abs(wall) / thin };
}

// -------------------------------------------------- A. domain convergence (z=2.5)
console.log('A. DOMAIN CONVERGENCE  (z=2.5 m default)');
console.log('pad=depth [m] | cells      | CG it | loss [W/m] | /ISO');
const isoFixed = (() => {
  const z = 2.5;
  const Hg = roomHalfWidth * basementFloorU(lambdaG, df, z, Bp) + z * basementWallU(lambdaG, dwb, df, z);
  return Hg * dT;
})();
for (const d of [3, 6, 9, 12, 18, 24]) {
  const { grid, problem, T, iterations } = solveSteady(basement({ soilPad: d, soilDepth: d }), MATERIALS, SOLVE);
  const loss = Math.abs(boundaryFlux(problem, T).byRegion.interior) / thin;
  console.log(`${String(d).padStart(11)} | ${`${grid.nx}x${grid.ny}x${grid.nz}`.padEnd(10)} | ${String(iterations).padStart(5)} | ${loss.toFixed(2).padStart(10)} | ${(loss / isoFixed).toFixed(3)}`);
}
console.log(`(ISO 13370 half-model at z=2.5: ${isoFixed.toFixed(2)} W/m)\n`);

// -------------------------------------------------- B. depth sweep + decomposition
console.log('B. DEPTH SWEEP + FLOOR/WALL DECOMPOSITION  (converged domain, pad=depth=15 m)');
console.log('  z [m] |   PHASOR floor / ISO floor   |   PHASOR wall / ISO wall    |  total P/ISO');
for (const z of [0.25, 0.5, 1.0, 2.5, 4.0]) {
  const { problem, T } = solveSteady(basement({ roomHeight: z, soilPad: 15, soilDepth: 15 }), MATERIALS, SOLVE);
  const { floor: pFloor, wall: pWall } = interiorSplit(problem, T);
  const Ufg = basementFloorU(lambdaG, df, z, Bp);
  const Uwg = basementWallU(lambdaG, dwb, df, z);
  const isoFloor = roomHalfWidth * Ufg * dT;       // half-floor
  const isoWall = z * Uwg * dT;                    // one wall, per m run
  const pTot = pFloor + pWall, isoTot = isoFloor + isoWall;
  const cell = (p, i) => `${p.toFixed(2)}/${i.toFixed(2)} (${(p / i).toFixed(2)})`;
  console.log(`  ${z.toFixed(2)} | ${cell(pFloor, isoFloor).padStart(27)} | ${cell(pWall, isoWall).padStart(27)} | ${(pTot / isoTot).toFixed(3)}`);
}
