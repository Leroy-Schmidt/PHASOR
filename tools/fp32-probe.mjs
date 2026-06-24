// Phase-0 probe (S2-M2.2, investigation — not a gate): does the steady CG
// converge in fp32, and to what residual floor? WebGPU is fp32-only (WGSL has no
// f64), so before writing any GPU code we measure, per preset, the achievable
// relative-residual floor and the iterations to reach 1e-5 — with NAIVE fp32 dot
// reductions vs KAHAN-compensated ones (to learn whether the GPU dot kernel needs
// compensation). The "true" residual is always computed in f64 from the f32
// iterate, so the floor we report is honest, not the solver's self-reported value.
//
//   node ./tools/fp32-probe.mjs
import { MATERIALS, presets } from '../src/model.mjs';
import { applyA } from '../src/fem.mjs';
import { solveSteady } from '../src/worker.mjs';

const fr = Math.fround;

/** f64 dot (reference). */
function dot64(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

/** Naive fp32 dot: every product and partial sum rounded to f32. */
function dotF32(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s = fr(s + fr(a[i] * b[i])); return s; }

/** Kahan-compensated fp32 dot. */
function dotF32K(a, b) {
  let s = 0, c = 0;
  for (let i = 0; i < a.length; i++) {
    const y = fr(fr(a[i] * b[i]) - c);
    const t = fr(s + y);
    c = fr(fr(t - s) - y);
    s = t;
  }
  return s;
}

/** True f64 relative residual ‖b − A x‖/‖b‖ for an f32 iterate x. */
function trueRelRes(problem, x, b, bNorm, scratch) {
  applyA(problem, x, scratch);
  let s = 0;
  for (let i = 0; i < b.length; i++) { const r = b[i] - scratch[i]; s += r * r; }
  return Math.sqrt(s) / bNorm;
}

/** fp32-simulated Jacobi-CG. Vectors are Float32Array (storage rounds to f32);
 *  scalars and dot accumulation are frounded. Returns the floor (min true relRes)
 *  and the iteration at which true relRes first reaches 1e-5. */
function cgF32(problem, { dotFn, maxIter = 4000 }) {
  const b = problem.b, diag = problem.diag, n = b.length;
  const x = new Float32Array(n);
  if (problem.x0) x.set(problem.x0);
  const r = new Float32Array(n), z = new Float32Array(n), p = new Float32Array(n), Ap = new Float32Array(n);
  const scratch = new Float64Array(n);
  const bNorm = Math.sqrt(dot64(b, b)) || 1;

  applyA(problem, x, scratch);
  for (let i = 0; i < n; i++) r[i] = b[i] - scratch[i];
  for (let i = 0; i < n; i++) z[i] = fr(r[i] / diag[i]);
  let rz = dotFn(r, z);
  p.set(z);

  let floor = Infinity, hit1e5 = -1;
  for (let iter = 1; iter <= maxIter; iter++) {
    applyA(problem, p, scratch);
    for (let i = 0; i < n; i++) Ap[i] = scratch[i]; // round to f32
    const pAp = dotFn(p, Ap);
    if (!(pAp > 0)) break;
    const alpha = fr(rz / pAp);
    for (let i = 0; i < n; i++) { x[i] = fr(x[i] + fr(alpha * p[i])); r[i] = fr(r[i] - fr(alpha * Ap[i])); }
    for (let i = 0; i < n; i++) z[i] = fr(r[i] / diag[i]);
    const rzNext = dotFn(r, z);
    const beta = fr(rzNext / rz);
    rz = rzNext;
    for (let i = 0; i < n; i++) p[i] = fr(z[i] + fr(beta * p[i]));

    const tr = trueRelRes(problem, x, b, bNorm, scratch);
    if (tr < floor) floor = tr;
    if (hit1e5 < 0 && tr <= 1e-5) hit1e5 = iter;
    // stop once we're clearly past the floor (no improvement for a while)
    if (iter > 50 && tr > floor * 4) break;
  }
  return { floor, hit1e5 };
}

const cases = [
  ['wall1d', {}], ['corner2d', {}], ['slab_junction', {}], ['basement', {}], ['basement3d', { maxH: 0.5 }],
];

console.log('preset            nodes   fp64 it |  naive: floor    @1e-5 |  kahan: floor    @1e-5');
console.log('-'.repeat(92));
for (const [name, params] of cases) {
  const def = presets[name](params);
  const ref = solveSteady(def, MATERIALS, { tol: 1e-10 });
  const naive = cgF32(ref.problem, { dotFn: dotF32 });
  const kahan = cgF32(ref.problem, { dotFn: dotF32K });
  const fmt = (v) => (Number.isFinite(v) ? v.toExponential(2) : '—').padStart(9);
  const hit = (v) => (v < 0 ? 'never' : String(v)).padStart(6);
  console.log(
    `${name.padEnd(13)} ${String(ref.problem.nNodes).padStart(7)} ${String(ref.iterations).padStart(7)} | `
    + `${fmt(naive.floor)} ${hit(naive.hit1e5)} | ${fmt(kahan.floor)} ${hit(kahan.hit1e5)}`,
  );
}
