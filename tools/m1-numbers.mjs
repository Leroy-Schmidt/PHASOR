// One-shot: print the M1 gate numbers for the VALIDATION.md log entry.
// Mirrors test/m1-gates.test.mjs without asserting. Not part of the app.
import { nodeIndex } from '../src/grid.mjs';
import { MATERIALS, wall1d, corner2d } from '../src/model.mjs';
import { boundaryFlux } from '../src/fem.mjs';
import { wallSeriesResistance } from '../src/physics.mjs';
import { solveSteady, steadyReadouts } from '../src/worker.mjs';

const SOLVE = { tol: 1e-12, maxIter: 30000 };

// G1.1
{
  const preset = wall1d();
  const { grid, T, iterations } = solveSteady(preset, MATERIALS, SOLVE);
  const layers = preset.boxes.map((b) => ({ material: b.material, thickness: b.x[1] - b.x[0] }));
  const oracle = wallSeriesResistance(layers, MATERIALS, { Rsi: 0.13, Rse: 0.04, Ti: 20, Te: 9 });
  let worst = 0;
  for (const { x, T: Tex } of oracle.interfaces) {
    const i = Array.from(grid.xs).findIndex((v) => Math.abs(v - x) <= 1e-12);
    for (let k = 0; k <= grid.nz; k++) {
      for (let j = 0; j <= grid.ny; j++) {
        worst = Math.max(worst, Math.abs(T[nodeIndex(grid, i, j, k)] - Tex));
      }
    }
  }
  console.log(`G1.1 wall1d ${grid.nx}x${grid.ny}x${grid.nz} cells, CG ${iterations} it: max interface error ${worst.toExponential(2)} K (gate < 1e-6)`);
  console.log(`     oracle U = ${oracle.U.toFixed(6)} W/m²K, interfaces ${oracle.interfaces.map((f) => f.T.toFixed(4)).join(' / ')} °C`);
}

// G1.2
{
  const errs = [];
  for (const n of [8, 16, 32]) {
    const preset = {
      boxes: [{ name: 'plate', x: [0, 1], y: [0, 1], z: [0, 0.1], material: 'unit' }],
      background: 'void',
      bcs: [
        { name: 'top', select: { axis: 'y', side: 'max' }, type: 'dirichlet', value: (x) => Math.sin(Math.PI * x) },
        { name: 'bottom', select: { axis: 'y', side: 'min' }, type: 'dirichlet', value: 0 },
        { name: 'left', select: { axis: 'x', side: 'min' }, type: 'dirichlet', value: 0 },
        { name: 'right', select: { axis: 'x', side: 'max' }, type: 'dirichlet', value: 0 },
        { name: 'cuts', select: 'rest', type: 'adiabatic' },
      ],
      gridSpec: {
        x: { mandatory: [0, 1], maxH: 1 / n },
        y: { mandatory: [0, 1], maxH: 1 / n },
        z: { mandatory: [0, 0.1], maxH: 1, minCells: 1 },
      },
    };
    const { grid, T } = solveSteady(preset, { unit: { lambda: 1 } }, SOLVE);
    const sp = Math.sinh(Math.PI);
    let worst = 0;
    for (let k = 0; k <= grid.nz; k++) {
      for (let j = 0; j <= grid.ny; j++) {
        for (let i = 0; i <= grid.nx; i++) {
          const ex = Math.sin(Math.PI * grid.xs[i]) * Math.sinh(Math.PI * grid.ys[j]) / sp;
          worst = Math.max(worst, Math.abs(T[nodeIndex(grid, i, j, k)] - ex));
        }
      }
    }
    errs.push(worst);
  }
  console.log(`G1.2 Laplace max-norm errors h=1/8,1/16,1/32: ${errs.map((e) => e.toExponential(3)).join(', ')}`);
  console.log(`     ratios ${(errs[0] / errs[1]).toFixed(3)}, ${(errs[1] / errs[2]).toFixed(3)} (gate [3.2, 4.8])`);
}

// G1.3
for (const preset of [wall1d(), corner2d()]) {
  const { problem, T } = solveSteady(preset, MATERIALS, SOLVE);
  const { byRegion, imbalance, throughput } = boundaryFlux(problem, T);
  const parts = Object.entries(byRegion).map(([r, p]) => `${r} ${p.toExponential(4)} W`).join(', ');
  console.log(`G1.3 ${preset.name}: ${parts}; imbalance ${imbalance.toExponential(2)} = ${(imbalance / throughput).toExponential(2)}·throughput (gate < 1e-6)`);
}

// G1.4
{
  const { grid, problem, T } = solveSteady(corner2d(), MATERIALS, SOLVE);
  let worst = 0;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let k = 0; k <= grid.nz; k++) {
    for (let j = 0; j <= grid.ny; j++) {
      for (let i = 0; i <= grid.nx; i++) {
        const a = nodeIndex(grid, i, j, k);
        if (!problem.active[a]) continue;
        worst = Math.max(worst, Math.abs(T[a] - T[nodeIndex(grid, j, i, k)]));
        tMin = Math.min(tMin, T[a]);
        tMax = Math.max(tMax, T[a]);
      }
    }
  }
  console.log(`G1.4 corner2d ${grid.nx}x${grid.ny}x${grid.nz}: asymmetry ${worst.toExponential(2)} K on range ${(tMax - tMin).toFixed(3)} K = ${(worst / (tMax - tMin)).toExponential(2)} relative (gate < 1e-9)`);
}

// readouts
{
  const w = steadyReadouts(wall1d(), MATERIALS, SOLVE);
  const c = steadyReadouts(corner2d(), MATERIALS, SOLVE);
  console.log(`readouts wall1d:  f_Rsi(0.25) = ${w.readouts.fRsi.toFixed(4)}, θ_si,min = ${w.readouts.thetaSiMin25.toFixed(4)} °C`);
  console.log(`readouts corner2d: f_Rsi(0.25) = ${c.readouts.fRsi.toFixed(4)}, θ_si,min = ${c.readouts.thetaSiMin25.toFixed(4)} °C, ` +
    `ψ_e = ${c.readouts.psi.psi.toFixed(4)} W/mK (external dims), L2D = ${c.readouts.L2D.toFixed(4)}, U = ${c.readouts.U.toFixed(4)}`);
}
