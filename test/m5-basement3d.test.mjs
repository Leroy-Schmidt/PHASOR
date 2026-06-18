// M5 gate tests — volumetric 3D basement (`basement3d`), the showcase preset.
// M5 is a menu, not a milestone with formal DESIGN §6 gates; these reuse the
// established basement gate patterns (G3.1 / G3.2) to certify the new preset:
//   1. Domain independence — doubling the LATERAL soil pad (the new 3D
//      dimension) leaves the δ-governed periodic quantities and the steady
//      lateral flux < 1% (depth direction is inherited from the 2D G3.1).
//   2. 3D corner cold-spot — on an inner wall face, the wall–wall corner end is
//      colder than the symmetry-plane end: the genuine 3D geometric bridge that
//      the 2D extruded basement cannot show.
//   3. September story persists — a pure-soil column lags ~2 months at ~3 m
//      (same physics as G3.2, now in a true 3D domain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeIndex } from '../src/grid.mjs';
import { MATERIALS, presets } from '../src/model.mjs';
import { boundaryFlux, regionNodes } from '../src/fem.mjs';
import { solveSteady, solveHarmonic } from '../src/worker.mjs';
import { OMEGA_ANNUAL, penetrationDepth, amplitude, timeLag } from '../src/physics.mjs';

const DAY = 86_400;

// ------------------------------------------------------------------- domain independence
// "Domain ≥ 3·δ_annual" is a PERIODIC statement (δ_soil ≈ 2.84 m): the annual
// wave must die before the lateral truncation. Doubling the lateral soil pad
// (in BOTH x and z — the dimension the 2D basement doesn't have) must leave the
// δ-governed quantities (annual inner-surface amplitude & flux) and the steady
// lateral far-field flux unmoved (< 1%). Coarse grid on purpose: this is about
// boundary distance, not resolution (cf. G3.1).

const DOMAIN_MAXH = 1.0;

function metrics(opts) {
  const def = presets.basement3d({ ...opts, maxH: DOMAIN_MAXH });
  const s = solveSteady(def, MATERIALS, { tol: 1e-10, maxIter: 60000 });
  assert.ok(s.converged, `basement3d steady did not converge (relRes ${s.relRes})`);
  const steadyPhi = Math.abs(boundaryFlux(s.problem, s.T).byRegion.interior ?? NaN);

  const h = solveHarmonic(def, MATERIALS, { omega: OMEGA_ANNUAL, tol: 1e-9, maxIter: 60000 });
  assert.ok(h.converged, `basement3d annual did not converge (relRes ${h.relRes})`);
  const inner = regionNodes(h.problem, 'interior');
  let sumA = 0;
  let fre = 0;
  let fim = 0;
  for (const f of h.problem.robinFaces) {
    if (f.region !== 'interior') continue;
    let mr = 0;
    let mi = 0;
    for (const n of f.nodes) { mr += h.Tre[n]; mi += h.Tim[n]; }
    fre += f.h * f.area * (mr / 4); // interior harmonic ambient = 0
    fim += f.h * f.area * (mi / 4);
  }
  for (const n of inner) sumA += amplitude(h.Tre[n], h.Tim[n]);
  return { steadyPhi, annualAmp: sumA / inner.length, annualFlux: Math.hypot(fre, fim) };
}

test('basement3d — lateral domain independence: annual amplitude/flux & steady flux < 1% on pad doubling', () => {
  const base = metrics({ soilPad: 9 });
  const big = metrics({ soilPad: 18 }); // double the lateral pad in x AND z

  const rel = (a, b) => Math.abs(b - a) / Math.abs(a);
  const dAmp = rel(base.annualAmp, big.annualAmp);
  const dFlux = rel(base.annualFlux, big.annualFlux);
  const dPhi = rel(base.steadyPhi, big.steadyPhi);

  assert.ok(dAmp < 0.01,
    `annual inner-surface amplitude moved ${(dAmp * 100).toFixed(3)}% on lateral doubling > 1%`);
  assert.ok(dFlux < 0.01,
    `annual inner-surface flux moved ${(dFlux * 100).toFixed(3)}% on lateral doubling > 1%`);
  assert.ok(dPhi < 0.01,
    `steady inner-surface Φ moved ${(dPhi * 100).toFixed(3)}% on lateral doubling ` +
    `(${base.steadyPhi.toFixed(4)} → ${big.steadyPhi.toFixed(4)} W) > 1% — lateral far-field too small`);
});

// ------------------------------------------------------------------- 3D corner cold-spot
// The signature 3D bridge: on the inner face of the +x wall (x = roomHalfWidth),
// the column near the wall–wall corner (z → roomHalfDepth) is colder than the
// column near the symmetry plane (z → 0, which is the 2D-extruded limit). Two
// walls meeting concentrate heat loss the way the 2D edge cannot.

test('basement3d — inner wall surface is colder toward the 3D wall–wall corner', () => {
  const roomHalfWidth = 2.0;
  const roomHalfDepth = 2.0;
  const def = presets.basement3d({ roomHalfWidth, roomHalfDepth, maxH: 0.6 });
  const s = solveSteady(def, MATERIALS, { tol: 1e-10, maxIter: 60000 });
  assert.ok(s.converged, `basement3d steady did not converge (relRes ${s.relRes})`);
  const { grid } = s;

  const interior = new Set(regionNodes(s.problem, 'interior'));
  // inner +x wall face: the grid line exactly at x = roomHalfWidth (a mandatory tick)
  let iWall = -1;
  for (let i = 0; i <= grid.nx; i++) if (Math.abs(grid.xs[i] - roomHalfWidth) < 1e-9) iWall = i;
  assert.ok(iWall >= 0, 'could not locate the inner wall grid line at x = roomHalfWidth');

  // collect interior-surface nodes on that face, split by z into corner vs symmetry side
  let cornerSum = 0; let cornerN = 0;
  let symSum = 0; let symN = 0;
  for (let k = 0; k <= grid.nz; k++) {
    const z = grid.zs[k];
    for (let j = 0; j <= grid.ny; j++) {
      const n = nodeIndex(grid, iWall, j, k);
      if (!interior.has(n)) continue;
      if (z > 0.7 * roomHalfDepth && z <= roomHalfDepth + 1e-9) { cornerSum += s.T[n]; cornerN++; }
      else if (z < 0.3 * roomHalfDepth) { symSum += s.T[n]; symN++; }
    }
  }
  assert.ok(cornerN > 0 && symN > 0, `empty corner/symmetry sample (corner ${cornerN}, sym ${symN})`);
  const cornerT = cornerSum / cornerN;
  const symT = symSum / symN;
  assert.ok(cornerT < symT - 0.05,
    `wall–wall corner not colder than the symmetry-plane (2D-limit) end: ` +
    `corner ${cornerT.toFixed(3)} °C vs symmetry ${symT.toFixed(3)} °C (expected ≥ 0.05 K colder)`);
});

// ------------------------------------------------------------------- September story
// Same as G3.2, now in the volumetric domain: a pure-soil vertical column away
// from the structure shows the annual wave decaying e^{−y/δ} and lagging y/δ —
// ~2 months over ~3 m — and the lag grows monotonically downward (no
// anticipation; the conjugation/sign bug would break this).

test('basement3d — annual phase lag at depth ≈ 2 months at 3 m (pure-soil column)', () => {
  const def = presets.basement3d({ soilPad: 9, maxH: 0.6 });
  const h = solveHarmonic(def, MATERIALS, { omega: OMEGA_ANNUAL, tol: 1e-9, maxIter: 60000 });
  assert.ok(h.converged, `basement3d annual did not converge (relRes ${h.relRes})`);
  const { grid } = h;

  // pick a column well into the lateral soil pad (x > xWallOuter), near the z
  // symmetry plane — pure soil top to bottom.
  const xWallOuter = 2.3;
  let iCol = -1;
  for (let i = 0; i <= grid.nx; i++) if (grid.xs[i] > xWallOuter + 1) { iCol = i; break; }
  assert.ok(iCol >= 0, 'could not find a pure-soil column beyond the wall');
  const kCol = 1;

  const samples = [];
  for (let j = 0; j <= grid.ny; j++) {
    const n = nodeIndex(grid, iCol, j, kCol);
    if (!h.problem.active[n]) continue;
    samples.push({ y: grid.ys[j], amp: amplitude(h.Tre[n], h.Tim[n]), lag: timeLag(h.Tre[n], h.Tim[n], OMEGA_ANNUAL) });
  }
  const grade = grid.ys[grid.ny];
  const delta = penetrationDepth(MATERIALS.soil.lambda, MATERIALS.soil.rho, MATERIALS.soil.c, OMEGA_ANNUAL);
  const at = (yt) => samples.reduce((b, s) => (Math.abs(s.y - yt) < Math.abs(b.y - yt) ? s : b), samples[0]);
  const ref = at(grade - 1); // 1 m below grade
  const tgt = at(grade - 4); // 4 m below grade
  const dy = ref.y - tgt.y;  // ≈ 3 m

  const lagDays = (tgt.lag - ref.lag) / DAY;
  const lagPredDays = (dy / delta) / OMEGA_ANNUAL / DAY;
  assert.ok(Math.abs(lagDays / lagPredDays - 1) < 0.15,
    `lag(${dy.toFixed(2)} m) = ${lagDays.toFixed(1)} d vs x/δ prediction ${lagPredDays.toFixed(1)} d ` +
    `= ${((lagDays / lagPredDays - 1) * 100).toFixed(1)}% off (> 15%)`);
  assert.ok(lagDays > 45 && lagDays < 70,
    `lag over ${dy.toFixed(2)} m = ${lagDays.toFixed(1)} d is outside the ~2-month window [45, 70]`);

  // monotone lag / decaying amplitude toward the surface (no anticipation)
  const band = samples.filter((s) => s.amp > 0.05 * samples[samples.length - 1].amp);
  for (let s = 1; s < band.length; s++) {
    assert.ok(band[s].lag <= band[s - 1].lag + 1e-6,
      `non-monotone lag near y=${band[s].y.toFixed(2)} (suspect a sign/conjugation bug)`);
    assert.ok(band[s].amp >= band[s - 1].amp - 1e-9,
      `amplitude not growing toward the surface near y=${band[s].y.toFixed(2)}`);
  }
});
