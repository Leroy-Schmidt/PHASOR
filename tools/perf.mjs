// PHASOR solve-performance harness (kept; DESIGN §3.5 perf budget).
//
// Measures the ISOLATED re-solve so the M5 acceleration work has a trustworthy,
// attributable baseline. Run it directly — NEVER inside `node --test`, whose
// file-level parallelism inflates wall-clock (saved memory + HANDOFF).
//
//   node ./tools/perf.mjs [preset] [maxH]
//   node ./tools/perf.mjs basement3d 0.5   # the fine-grid use case (~18 s, OVER)
//   node ./tools/perf.mjs basement3d 0.8   # the shipped default (~4.7 s)
//   node ./tools/perf.mjs corner2d         # small-preset regression guard
//
// Reports per stage: wall-time, iteration count, and ms-per-iteration
// (≈ ms-per-matvec — one operator apply dominates each CG/COCG iteration). The
// acceleration session attacks whichever stage/lever this attribution exposes:
// fewer iterations (preconditioner) vs faster matvec (WASM/WebGPU/JS micro-opt).

import { MATERIALS, presets } from '../src/model.mjs';
import { solveSteady, solveHarmonic } from '../src/worker.mjs';
import { buildGrid } from '../src/grid.mjs';
import { boundaryFlux, regionNodes } from '../src/fem.mjs';
import { OMEGA_ANNUAL, OMEGA_DIURNAL, fRsi } from '../src/physics.mjs';

const presetName = process.argv[2] ?? 'basement3d';
const maxH = process.argv[3] !== undefined ? Number(process.argv[3])
  : (presetName === 'basement3d' ? 0.5 : undefined);
const make = presets[presetName];
if (!make) { console.error(`unknown preset '${presetName}'`); process.exit(1); }
const def = make(maxH !== undefined ? { maxH } : {});

const { nx, ny, nz } = buildGrid(def.gridSpec);
const cells = nx * ny * nz;

/** Time a thunk; return { ms, ...result }. */
function timed(fn) {
  const t0 = performance.now();
  const out = fn();
  return { ms: performance.now() - t0, out };
}

const rows = [];
function stage(name, fn) {
  const { ms, out } = timed(fn);
  const it = out.iterations ?? 0;
  rows.push({ name, ms, it, perIt: it ? ms / it : NaN, converged: out.converged });
  return out;
}

// The worker's full re-solve bundle (see worker.steadyReadouts + the harmonic
// loop): the display steady solve, the dedicated R_si=0.25 f_Rsi solve, then the
// two harmonics. Timed separately for cost attribution.
const steady = stage('steady (display)', () =>
  solveSteady(def, MATERIALS, { tol: 1e-10 }));

const bcs25 = def.bcs.map((bc) => (bc.name === 'interior' ? { ...bc, h: 1 / 0.25 } : bc));
const steady25 = stage('steady (R_si=0.25)', () =>
  solveSteady(def, MATERIALS, { tol: 1e-10, bcs: bcs25 }));

const annual = stage('annual (COCG)', () =>
  solveHarmonic(def, MATERIALS, { omega: OMEGA_ANNUAL, tol: 1e-8 }));
const diurnal = stage('diurnal (COCG)', () =>
  solveHarmonic(def, MATERIALS, { omega: OMEGA_DIURNAL, tol: 1e-8 }));

const total = rows.reduce((s, r) => s + r.ms, 0);

// sanity readouts so a "faster but wrong" result is obvious at a glance
const flux = boundaryFlux(steady.problem, steady.T);
const inner = def.bcs.some((b) => b.name === 'interior' && b.type === 'robin')
  ? regionNodes(steady25.problem, 'interior') : [];
let thetaMin = Infinity;
for (const n of inner) thetaMin = Math.min(thetaMin, steady25.T[n]);
const Ti = def.bcs.find((b) => b.name === 'interior')?.T?.mean;
const Te = def.bcs.find((b) => b.name === 'exterior')?.T?.mean;
const f = inner.length ? fRsi(thetaMin, Ti, Te) : NaN;

const pad = (s, w) => String(s).padEnd(w);
const num = (v, w, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—').padStart(w);
console.log(`\n${presetName}  maxH=${maxH ?? 'default'}  ${nx}×${ny}×${nz} = ${cells} cells, ${steady.problem.nNodes} nodes\n`);
console.log(`  ${pad('stage', 20)}${pad('ms', 9)}${pad('iters', 8)}${pad('ms/iter', 9)}conv`);
for (const r of rows) {
  console.log(`  ${pad(r.name, 20)}${num(r.ms, 8)} ${num(r.it, 7)} ${num(r.perIt, 8, 2)}  ${r.converged ? 'y' : 'N'}`);
}
console.log(`  ${pad('TOTAL', 20)}${num(total, 8)}`);
console.log(`\n  budget: ${total < 5000 ? 'PASS' : 'OVER'} (5 s)   `
  + `f_Rsi ${num(f, 5, 3)}   Φ_ext ${num(Math.abs(flux.byRegion.exterior ?? NaN), 7, 2)} W\n`);
