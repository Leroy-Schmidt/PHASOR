// Phase-H0 probe (S2-M2.2 harmonic, investigation — not a gate): does the
// complex-symmetric COCG converge in fp32, and does it break down? COCG uses the
// UNCONJUGATED bilinear form (van der Vorst & Melissen) whose denominators can go
// near-zero, so fp32 breakdown is the real risk that decides whether harmonic-on-
// GPU is viable. Mirrors src/solver.mjs `cocg` with Float32Array storage +
// frounded complex arithmetic; the true (conjugated) residual norm is computed in
// f64 from the f32 iterate, so the floor reported is honest.
//
//   node ./tools/fp32-cocg-probe.mjs
import { buildGrid, paintBoxes } from '../src/grid.mjs';
import { MATERIALS, presets } from '../src/model.mjs';
import { assemble, applyAComplex, assembleHarmonicLoad } from '../src/fem.mjs';
import { climatePhasor, OMEGA_BY_FREQ } from '../src/physics.mjs';
import { solveHarmonic } from '../src/worker.mjs';

const fr = Math.fround;

function setup(name, params, freq) {
  const def = presets[name](params);
  const grid = buildGrid(def.gridSpec);
  const painted = paintBoxes(grid, def.boxes, def.background);
  const problem = assemble(grid, painted, MATERIALS, def.bcs);
  const omega = OMEGA_BY_FREQ[freq];
  const ambient = {};
  for (const bc of def.bcs) {
    if (bc.type !== 'robin') continue;
    const harm = (bc.T?.harmonics ?? []).find((h) => OMEGA_BY_FREQ[h.f] === omega);
    ambient[bc.name] = harm ? climatePhasor(harm, omega) : { re: 0, im: 0 };
  }
  const n = problem.nNodes;
  const { bRe, bIm } = assembleHarmonicLoad(problem, omega, ambient,
    { dirichletRe: new Float64Array(n), dirichletIm: new Float64Array(n) });
  const diagIm = new Float64Array(n);
  for (let i = 0; i < n; i++) diagIm[i] = problem.free[i] ? omega * problem.diagC[i] : 0;
  return { def, problem, omega, bRe, bIm, diagRe: problem.diag, diagIm };
}

// fp32-simulated COCG. Returns floor (min true relRes), iters to 1e-5, breakdown flag.
function cocgF32({ problem, omega, bRe, bIm, diagRe, diagIm }, maxIter = 4000) {
  const n = bRe.length;
  const xr = new Float32Array(n), xi = new Float32Array(n);
  const rr = new Float32Array(n), ri = new Float32Array(n);
  const zr = new Float32Array(n), zi = new Float32Array(n);
  const pr = new Float32Array(n), pi = new Float32Array(n);
  const qr = new Float32Array(n), qi = new Float32Array(n);
  const sr = new Float64Array(n), si = new Float64Array(n); // f64 scratch for apply
  const bnorm = Math.sqrt(b2(bRe, bIm)) || 1;

  // complex bilinear (unconjugated) Σ a*b, frounded
  const bil = (ar, ai, br, bi) => {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      re = fr(re + fr(fr(ar[i] * br[i]) - fr(ai[i] * bi[i])));
      im = fr(im + fr(fr(ar[i] * bi[i]) + fr(ai[i] * br[i])));
    }
    return { re, im };
  };
  const cdiv = (a, b) => { const d = b.re * b.re + b.im * b.im; return { re: fr((a.re * b.re + a.im * b.im) / d), im: fr((a.im * b.re - a.re * b.im) / d) }; };
  const prec = () => { for (let i = 0; i < n; i++) { const dr = diagRe[i], di = diagIm[i], den = dr * dr + di * di; zr[i] = fr((ri[i] * di + rr[i] * dr) / den); zi[i] = fr((ri[i] * dr - rr[i] * di) / den); } };
  const trueRel = () => { applyAComplex(problem, omega, xr, xi, sr, si); let s = 0; for (let i = 0; i < n; i++) { const er = bRe[i] - sr[i], ei = bIm[i] - si[i]; s += er * er + ei * ei; } return Math.sqrt(s) / bnorm; };

  applyAComplex(problem, omega, xr, xi, sr, si);
  for (let i = 0; i < n; i++) { rr[i] = bRe[i] - sr[i]; ri[i] = bIm[i] - si[i]; }
  prec();
  let rz = bil(rr, ri, zr, zi);
  pr.set(zr); pi.set(zi);

  let floor = Infinity, hit = -1, breakdown = false;
  for (let iter = 1; iter <= maxIter; iter++) {
    applyAComplex(problem, omega, pr, pi, sr, si);
    for (let i = 0; i < n; i++) { qr[i] = sr[i]; qi[i] = si[i]; }
    const pq = bil(pr, pi, qr, qi);
    if (!(pq.re * pq.re + pq.im * pq.im > 0)) { breakdown = true; break; }
    const al = cdiv(rz, pq);
    for (let i = 0; i < n; i++) {
      xr[i] = fr(xr[i] + fr(fr(al.re * pr[i]) - fr(al.im * pi[i])));
      xi[i] = fr(xi[i] + fr(fr(al.re * pi[i]) + fr(al.im * pr[i])));
      rr[i] = fr(rr[i] - fr(fr(al.re * qr[i]) - fr(al.im * qi[i])));
      ri[i] = fr(ri[i] - fr(fr(al.re * qi[i]) + fr(al.im * qr[i])));
    }
    prec();
    const rzN = bil(rr, ri, zr, zi);
    const be = cdiv(rzN, rz);
    rz = rzN;
    for (let i = 0; i < n; i++) { const a = pr[i], b = pi[i]; pr[i] = fr(zr[i] + fr(fr(be.re * a) - fr(be.im * b))); pi[i] = fr(zi[i] + fr(fr(be.re * b) + fr(be.im * a))); }
    const tr = trueRel();
    if (tr < floor) floor = tr;
    if (hit < 0 && tr <= 1e-5) hit = iter;
    if (iter > 40 && tr > floor * 4) break;
    if (!Number.isFinite(tr)) { breakdown = true; break; }
  }
  return { floor, hit, breakdown };
}

function b2(re, im) { let s = 0; for (let i = 0; i < re.length; i++) s += re[i] * re[i] + im[i] * im[i]; return s; }

console.log('preset        freq     fp64 it conv |  fp32: floor    @1e-5  breakdown');
console.log('-'.repeat(78));
for (const [name, params] of [['corner2d', {}], ['basement3d', { maxH: 0.5 }]]) {
  for (const freq of ['annual', 'diurnal']) {
    const s = setup(name, params, freq);
    const ref = solveHarmonic(presets[name](params), MATERIALS, { omega: s.omega, tol: 1e-8 });
    const f = cocgF32(s);
    const fmt = (v) => (Number.isFinite(v) ? v.toExponential(2) : '—').padStart(9);
    console.log(`${name.padEnd(12)} ${freq.padEnd(8)} ${String(ref.iterations).padStart(6)} ${ref.converged ? 'y' : 'N'}   | ${fmt(f.floor)} ${(f.hit < 0 ? 'never' : String(f.hit)).padStart(6)}  ${f.breakdown ? 'BREAKDOWN' : 'ok'}`);
  }
}
