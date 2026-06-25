// PHASOR solve worker (DESIGN.md §4.1 decision 4): assembles and solves a
// preset off the UI thread, streaming CG progress. The orchestration functions
// are pure and DOM-free so `node --test` exercises the exact code the worker
// runs; the onmessage wiring activates only inside a real Worker.

import { buildGrid, paintBoxes } from './grid.mjs';
import { MATERIALS, presets } from './model.mjs';
import {
  assemble, applyA, applyAComplex, assembleHarmonicLoad, boundaryFlux, regionNodes,
} from './fem.mjs';
import { cg, cocg } from './solver.mjs';
import {
  fRsi, uValue, psiExternal, climatePhasor, amplitude, timeLag, OMEGA_BY_FREQ,
} from './physics.mjs';
import { regionFluxReal, regionFluxPhasor } from './losscurve.mjs';

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

/**
 * Build the complex ambient phasor per Robin region for one frequency.
 * ω = 0 reproduces the steady drive (mean temperatures, imaginary part 0), so
 * a harmonic solve at ω = 0 equals the M1 steady solve.
 */
function climateAmbient(bcs, omega) {
  const out = {};
  for (const bc of bcs) {
    if (bc.type !== 'robin') continue;
    if (omega === 0) { out[bc.name] = { re: bc.T?.mean ?? 0, im: 0 }; continue; }
    const harm = (bc.T?.harmonics ?? []).find((h) => OMEGA_BY_FREQ[h.f] === omega);
    out[bc.name] = harm ? climatePhasor(harm, omega) : { re: 0, im: 0 };
  }
  return out;
}

/**
 * Build grid + paint + assemble + COCG-solve one harmonic (frequency ω) problem.
 * Complex field returned as separate Tre/Tim Float64Arrays (CLAUDE.md M2).
 *
 * @param {object} presetDef — a preset return value
 * @param {object} materials — material table (must carry ρ and c)
 * @param {{omega: number, tol?, maxIter?, onProgress?, ambient?}} opts
 *   `ambient` overrides the per-region complex phasor map (else derived from the
 *   preset's climate via climateAmbient).
 *   `dirichlet`: 'zero' (default) imposes the far-field harmonic convention
 *   T̂_k = 0 (DESIGN §2.2) — correct for a deep-soil / basement Dirichlet whose
 *   *steady* value is T_mean but whose harmonic part vanishes. 'value' drives
 *   the harmonic from the steady dirichletValue (used by the G2.1 semi-infinite
 *   test, where the surface Dirichlet IS the harmonic forcing).
 */
export function solveHarmonic(presetDef, materials,
  { omega, tol = 1e-8, maxIter = 20000, onProgress, ambient, dirichlet = 'zero' } = {}) {
  const grid = buildGrid(presetDef.gridSpec);
  const painted = paintBoxes(grid, presetDef.boxes, presetDef.background);
  const problem = assemble(grid, painted, materials, presetDef.bcs);

  const ambientByRegion = ambient ?? climateAmbient(presetDef.bcs, omega);
  const dOpts = dirichlet === 'value'
    ? {} // assembleHarmonicLoad defaults to the real dirichletValue
    : { dirichletRe: new Float64Array(problem.nNodes), dirichletIm: new Float64Array(problem.nNodes) };
  const { bRe, bIm } = assembleHarmonicLoad(problem, omega, ambientByRegion, dOpts);

  // complex Jacobi preconditioner: diag(K+H) + iω·diag(C) on free nodes
  const diagIm = new Float64Array(problem.nNodes);
  for (let n = 0; n < problem.nNodes; n++) {
    diagIm[n] = problem.free[n] ? omega * problem.diagC[n] : 0;
  }

  const { xRe: Tre, xIm: Tim, iterations, relRes, converged } = cocg({
    apply: (xr, xi, yr, yi) => applyAComplex(problem, omega, xr, xi, yr, yi),
    bRe, bIm, diagRe: problem.diag, diagIm, tol, maxIter, onProgress,
  });
  return { grid, painted, problem, omega, Tre, Tim, iterations, relRes, converged };
}

/** Amplitude |T̂| and time-lag τ fields (seconds) from a harmonic solution. */
export function harmonicFields(Tre, Tim, omega) {
  const n = Tre.length;
  const amp = new Float64Array(n);
  const lag = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    amp[i] = amplitude(Tre[i], Tim[i]);
    lag[i] = timeLag(Tre[i], Tim[i], omega);
  }
  return { amp, lag };
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
export function steadyReadouts(presetDef, materials, { tol = 1e-10, maxIter = 20000, onProgress, mainSolve, sol25Solve } = {}) {
  const main = mainSolve ?? solveSteady(presetDef, materials, { tol, maxIter, onProgress });
  const flux = boundaryFlux(main.problem, main.T);

  const RsiFixed = 0.25;
  const bcs25 = presetDef.bcs.map((bc) =>
    bc.name === 'interior' ? { ...bc, h: 1 / RsiFixed } : bc);
  const sol25 = sol25Solve ?? solveSteady(presetDef, materials, { tol, maxIter, bcs: bcs25 });

  const Ti = bcMean(presetDef.bcs, 'interior');
  const Te = bcMean(presetDef.bcs, 'exterior');
  // f_Rsi needs a heated interior surface; presets without an 'interior' Robin
  // region (e.g. soil_rod — a soil column, no room behind it) report it as n/a.
  const hasInterior = presetDef.bcs.some((b) => b.name === 'interior' && b.type === 'robin');
  const thetaSiMin25 = hasInterior ? surfaceMin(sol25.problem, sol25.T, 'interior') : null;

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
      fRsi: hasInterior ? fRsi(thetaSiMin25, Ti, Te) : null,
      RsiUsed: RsiFixed,
      thetaSiMinDisplay: hasInterior ? surfaceMin(main.problem, main.T, 'interior') : null,
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

/**
 * Annual heat-loss phasors for a region (S2-M1.4): a steady solve + one harmonic
 * solve per frequency, reduced to region-flux phasors { mean, harmonics } by
 * superposition. Used for the air-case comparison (a fresh, independent solve);
 * the main preset reuses its already-computed fields in the worker loop instead.
 * Returns null if the preset has no such Robin region.
 */
export function computeLoss(presetDef, materials, region, { tol = 1e-10 } = {}) {
  const steady = solveSteady(presetDef, materials, { tol });
  if (!steady.problem.robinFaces.some((f) => f.region === region)) return null;
  const mean = regionFluxReal(steady.problem, steady.T, region);
  const harmonics = [];
  for (const f of ['annual', 'diurnal']) {
    const omega = OMEGA_BY_FREQ[f];
    const h = solveHarmonic(presetDef, materials, { omega, tol });
    harmonics.push({ f, omega, ...regionFluxPhasor(steady.problem, h.Tre, h.Tim, region) });
  }
  return { mean, harmonics };
}

// --------------------------------------------------------- GPU display solve
/** Min free-node count below which the GPU's fixed setup cost isn't worth it
 *  (small presets like corner2d already solve far under budget on the CPU). */
const GPU_MIN_NODES = 20000;

/**
 * The display steady solve, GPU-accelerated when worthwhile. Assembles once;
 * if WebGPU is present AND the problem is large enough, runs the fp32 GPU-resident
 * CG (tol 1e-5 — ~5 sig figs, past what's physically meaningful). On WebGPU
 * absence, error, or non-convergence it falls back to the certified fp64 CPU `cg`.
 * Returns the same shape as `solveSteady` (+ `backend`). Browser/Worker-only path —
 * node never imports the GPU module (dynamic import, guarded by `navigator.gpu`),
 * so `webgpu.mjs`'s top-level `GPUBufferUsage` reference never trips `node --test`.
 */
async function solveDisplaySteady(presetDef, materials, { tol = 1e-10, maxIter = 20000, onProgress, bcs } = {}) {
  const grid = buildGrid(presetDef.gridSpec);
  const painted = paintBoxes(grid, presetDef.boxes, presetDef.background);
  const problem = assemble(grid, painted, materials, bcs ?? presetDef.bcs);
  if (typeof navigator !== 'undefined' && navigator.gpu && problem.nNodes >= GPU_MIN_NODES) {
    try {
      const { gpuSolveSteady } = await import('./gpu/webgpu.mjs');
      const r = await gpuSolveSteady(problem, { tol: 1e-5 });
      if (r.converged) {
        return { grid, painted, problem, T: r.x, iterations: r.iterations, relRes: r.relRes, converged: true, backend: 'gpu' };
      }
    } catch { /* WebGPU unavailable or failed → CPU fallback below */ }
  }
  const { x: T, iterations, relRes, converged } = cg({
    apply: (v, out) => applyA(problem, v, out),
    b: problem.b, diag: problem.diag, x0: problem.x0, tol, maxIter, onProgress,
  });
  return { grid, painted, problem, T, iterations, relRes, converged, backend: 'cpu' };
}

/**
 * The display harmonic solve for one frequency, GPU-accelerated when worthwhile.
 * Mirrors `solveHarmonic` (dirichlet='zero' convention) but routes the COCG to the
 * fp32 GPU-resident solver (tol 1e-4 — amplitude/phase to ~1e-3, past what's
 * physically meaningful; fp32 COCG has no breakdown per the H0 probe) when WebGPU
 * is present and the problem is large enough, with CPU `cocg` fallback. Returns
 * the same shape as `solveHarmonic`. Browser/Worker-only (dynamic GPU import).
 */
async function solveDisplayHarmonic(presetDef, materials, omega, { tol = 1e-8 } = {}) {
  const grid = buildGrid(presetDef.gridSpec);
  const painted = paintBoxes(grid, presetDef.boxes, presetDef.background);
  const problem = assemble(grid, painted, materials, presetDef.bcs);
  const n = problem.nNodes;
  const ambientByRegion = climateAmbient(presetDef.bcs, omega);
  const { bRe, bIm } = assembleHarmonicLoad(problem, omega, ambientByRegion,
    { dirichletRe: new Float64Array(n), dirichletIm: new Float64Array(n) });
  const diagIm = new Float64Array(n);
  for (let i = 0; i < n; i++) diagIm[i] = problem.free[i] ? omega * problem.diagC[i] : 0;
  if (typeof navigator !== 'undefined' && navigator.gpu && n >= GPU_MIN_NODES) {
    try {
      const { gpuSolveHarmonic } = await import('./gpu/webgpu.mjs');
      const r = await gpuSolveHarmonic(problem, omega, { bRe, bIm, diagRe: problem.diag, diagIm, tol: 1e-4 });
      if (r.converged) {
        return { grid, painted, problem, omega, Tre: r.xRe, Tim: r.xIm, iterations: r.iterations, relRes: r.relRes, converged: true, backend: 'gpu' };
      }
    } catch { /* WebGPU absent/failed/limited → CPU fallback */ }
  }
  const { xRe: Tre, xIm: Tim, iterations, relRes, converged } = cocg({
    apply: (xr, xi, yr, yi) => applyAComplex(problem, omega, xr, xi, yr, yi),
    bRe, bIm, diagRe: problem.diag, diagIm, tol, maxIter: 20000,
  });
  return { grid, painted, problem, omega, Tre, Tim, iterations, relRes, converged, backend: 'cpu' };
}

// --------------------------------------------------------- worker wiring
// `self` exists in a Worker scope but not under plain node (`node --test`).
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.onmessage = async (e) => {
    const { id, presetName, params, tol } = e.data;
    try {
      const presetDef = presets[presetName](params ?? {});
      const onProgress = (iter, relRes) => {
        if (iter % 25 === 0) self.postMessage({ id, type: 'progress', iter, relRes });
      };
      // both steady solves on GPU (display R_si=0.13 + the R_si=0.25 f_Rsi solve,
      // each ~a third of the pipeline) — injected so steadyReadouts re-solves neither.
      const bcs25 = presetDef.bcs.map((bc) => (bc.name === 'interior' ? { ...bc, h: 1 / 0.25 } : bc));
      const main = await solveDisplaySteady(presetDef, MATERIALS, { tol, onProgress });
      const sol25 = await solveDisplaySteady(presetDef, MATERIALS, { tol, bcs: bcs25 });
      const out = steadyReadouts(presetDef, MATERIALS, { tol, mainSolve: main, sol25Solve: sol25 });

      // harmonic solves per frequency (annual, diurnal). Tre/Tim ship as
      // transferable buffers; the UI superposes them for T(t) / amplitude /
      // phase-lag without ever re-solving (DESIGN §2.5, §3.5).
      // exterior Robin region — its complex phasor per frequency is the outdoor
      // forcing whose phase the phase-lag map references (so the surface reads ≈0).
      const extBc = presetDef.bcs.find((b) => b.name === 'exterior' && b.type === 'robin');

      // annual heat-loss curve (S2-M1.4): region-flux phasors for the heated
      // interior, accumulated from the same harmonic fields (computed BEFORE the
      // Tre/Tim buffers are transferred away). For 'basement', also solve the
      // air-case sibling so the panel can show the earth-vs-air gap.
      const hasInterior = presetDef.bcs.some((b) => b.name === 'interior' && b.type === 'robin');
      const lossHarm = [];

      const harmonics = [];
      const transfer = [out.T.buffer];
      for (const f of ['annual', 'diurnal']) {
        const omega = OMEGA_BY_FREQ[f];
        self.postMessage({ id, type: 'progress', iter: 0, relRes: NaN, phase: f });
        const h = await solveDisplayHarmonic(presetDef, MATERIALS, omega, { tol });
        const extHarm = (extBc?.T?.harmonics ?? []).find((hh) => hh.f === f);
        const ref = extHarm ? climatePhasor(extHarm, omega) : { re: 1, im: 0 };
        if (hasInterior) {
          lossHarm.push({ f, omega, ...regionFluxPhasor(out.problem, h.Tre, h.Tim, 'interior') });
        }
        harmonics.push({
          f, omega, re: h.Tre.buffer, im: h.Tim.buffer,
          refRe: ref.re, refIm: ref.im,
          iterations: h.iterations, relRes: h.relRes, converged: h.converged,
        });
        transfer.push(h.Tre.buffer, h.Tim.buffer);
      }

      let loss = null;
      if (hasInterior) {
        loss = { earth: { mean: regionFluxReal(out.problem, out.T, 'interior'), harmonics: lossHarm } };
        if (presetName === 'basement') {
          loss.air = computeLoss(presets.basement_air({}), MATERIALS, 'interior', { tol });
        }
      }

      self.postMessage(
        { id, type: 'result', T: out.T.buffer, readouts: out.readouts, stats: out.stats, harmonics, loss },
        transfer,
      );
    } catch (err) {
      self.postMessage({ id, type: 'error', message: err.message });
    }
  };
}
