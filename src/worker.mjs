// PHASOR solve worker (DESIGN.md §4.1 decision 4): assembles and solves a
// preset off the UI thread, streaming CG progress. The orchestration functions
// are pure and DOM-free so `node --test` exercises the exact code the worker
// runs; the onmessage wiring activates only inside a real Worker.

import { buildGrid, paintBoxes } from './grid.mjs';
import { MATERIALS, presets } from './model.mjs';
import { assemble, applyA, boundaryFlux, regionNodes } from './fem.mjs';
import { cg } from './solver.mjs';
import { fRsi, uValue, psiExternal } from './physics.mjs';

/**
 * Build grid + paint + assemble + CG-solve one steady (ω = 0) problem.
 * @param {object} presetDef — a preset return value (boxes, bcs, gridSpec, …)
 * @param {object} materials — material table
 * @param {{tol?: number, maxIter?: number, onProgress?: Function, bcs?: object[]}} [opts]
 *   `bcs` overrides the preset's BC list (used for the R_si = 0.25 f_Rsi solve).
 */
export function solveSteady(presetDef, materials, { tol = 1e-10, maxIter = 20000, onProgress, bcs } = {}) {
  const grid = buildGrid(presetDef.gridSpec);
  const painted = paintBoxes(grid, presetDef.boxes, presetDef.background);
  const problem = assemble(grid, painted, materials, bcs ?? presetDef.bcs);
  const { x: T, iterations, relRes, converged } = cg({
    apply: (v, out) => applyA(problem, v, out),
    b: problem.b,
    diag: problem.diag,
    x0: problem.x0,
    tol, maxIter, onProgress,
  });
  return { grid, painted, problem, T, iterations, relRes, converged };
}

function surfaceMin(problem, T, region) {
  let min = Infinity;
  for (const n of regionNodes(problem, region)) min = Math.min(min, T[n]);
  return min;
}

function bcMean(bcs, name) {
  const bc = bcs.find((b) => b.name === name);
  return bc ? bc.T.mean : undefined;
}

/**
 * The full M1 readout bundle: display solve (preset BCs as-is) plus a second
 * solve with R_si = 0.25 for f_Rsi (DIN 4108-2 — convention fixed in
 * CLAUDE.md M1). ψ only for presets that declare psiSpec (extruded junctions).
 */
export function steadyReadouts(presetDef, materials, { tol = 1e-10, maxIter = 20000, onProgress } = {}) {
  const main = solveSteady(presetDef, materials, { tol, maxIter, onProgress });
  const flux = boundaryFlux(main.problem, main.T);

  const RsiFixed = 0.25;
  const bcs25 = presetDef.bcs.map((bc) =>
    bc.name === 'interior' ? { ...bc, h: 1 / RsiFixed } : bc);
  const sol25 = solveSteady(presetDef, materials, { tol, maxIter, bcs: bcs25 });

  const Ti = bcMean(presetDef.bcs, 'interior');
  const Te = bcMean(presetDef.bcs, 'exterior');
  const thetaSiMin25 = surfaceMin(sol25.problem, sol25.T, 'interior');

  let psi = null;
  let L2D = null;
  let U = null;
  if (presetDef.psiSpec) {
    const { lengths, Lz, layers } = presetDef.psiSpec;
    U = uValue(layers, materials); // R_si = 0.13, R_se = 0.04 like the solve
    const phi = Math.abs(flux.byRegion.exterior ?? 0);
    L2D = phi / ((Ti - Te) * Lz);
    psi = psiExternal({ L2D, U, lengths });
  }

  return {
    T: main.T,
    grid: main.grid,
    painted: main.painted,
    problem: main.problem,
    readouts: {
      Ti, Te,
      thetaSiMin25,
      fRsi: fRsi(thetaSiMin25, Ti, Te),
      RsiUsed: RsiFixed,
      thetaSiMinDisplay: surfaceMin(main.problem, main.T, 'interior'),
      phi: flux.byRegion,
      imbalance: flux.imbalance,
      psi, L2D, U,
    },
    stats: {
      nodes: main.problem.nNodes,
      cells: main.grid.nx * main.grid.ny * main.grid.nz,
      iterations: main.iterations,
      relRes: main.relRes,
      converged: main.converged && sol25.converged,
    },
  };
}

// --------------------------------------------------------- worker wiring
// `self` exists in a Worker scope but not under plain node (`node --test`).
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.onmessage = (e) => {
    const { id, presetName, params, tol } = e.data;
    try {
      const presetDef = presets[presetName](params ?? {});
      const onProgress = (iter, relRes) => {
        if (iter % 25 === 0) self.postMessage({ id, type: 'progress', iter, relRes });
      };
      const out = steadyReadouts(presetDef, MATERIALS, { tol, onProgress });
      self.postMessage(
        { id, type: 'result', T: out.T.buffer, readouts: out.readouts, stats: out.stats },
        [out.T.buffer],
      );
    } catch (err) {
      self.postMessage({ id, type: 'error', message: err.message });
    }
  };
}
