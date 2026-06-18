// M1 physics unit tests — written BEFORE src/physics.mjs.
// Series-resistance wall oracle (ISO 6946 layer calculus, the G1.1 reference),
// f_Rsi formula (DIN 4108-2), ψ external-dimension convention (M1 decision).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATERIALS } from '../src/model.mjs';
import {
  uValue, wallSeriesResistance, fRsi, psiExternal,
  OMEGA_ANNUAL, OMEGA_DIURNAL, penetrationDepth, semiInfinite,
  climatePhasor, amplitude, timeLag, timeLagRelative, phasorEval,
} from '../src/physics.mjs';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('uValue: single layer against longhand resistance sum', () => {
  const layers = [{ material: 'ins', thickness: 0.1 }];
  const mats = { ins: { lambda: 0.05 } };
  const R = 0.13 + 0.1 / 0.05 + 0.04; // R_si + d/λ + R_se = 2.17
  close(uValue(layers, mats, 0.13, 0.04), 1 / R, 1e-12, 'U');
});

test('wallSeriesResistance: surface temperatures consistent from both ends', () => {
  const layers = [{ material: 'ins', thickness: 0.1 }];
  const mats = { ins: { lambda: 0.05 } };
  const { U, q, interfaces } = wallSeriesResistance(layers, mats,
    { Rsi: 0.13, Rse: 0.04, Ti: 20, Te: 9 });
  close(q, U * 11, 1e-12, 'flux');
  assert.equal(interfaces.length, 2);
  close(interfaces[0].x, 0, 0, 'exterior surface position');
  close(interfaces[0].T, 9 + q * 0.04, 1e-12, 'exterior surface T');
  close(interfaces[1].x, 0.1, 0, 'interior surface position');
  close(interfaces[1].T, 20 - q * 0.13, 1e-12, 'interior surface T');
});

test('wallSeriesResistance: default wall has equal flux through every layer', () => {
  const layers = [
    { material: 'eps', thickness: 0.16 },
    { material: 'brick', thickness: 0.24 },
    { material: 'plaster', thickness: 0.015 },
  ];
  const { q, interfaces } = wallSeriesResistance(layers, MATERIALS,
    { Rsi: 0.13, Rse: 0.04, Ti: 20, Te: 9 });
  assert.equal(interfaces.length, layers.length + 1);
  for (let n = 0; n < layers.length; n++) {
    const lam = MATERIALS[layers[n].material].lambda;
    const qSeg = (interfaces[n + 1].T - interfaces[n].T) * lam / layers[n].thickness;
    close(qSeg, q, 1e-9 * Math.abs(q), `layer ${n} flux`);
  }
  // temperatures rise monotonically toward the interior (Ti > Te)
  for (let n = 1; n < interfaces.length; n++) {
    assert.ok(interfaces[n].T > interfaces[n - 1].T, `non-monotonic at interface ${n}`);
  }
});

test('fRsi: anchor cases including the 0.70 mold criterion', () => {
  close(fRsi(20, 20, 9), 1, 1e-12, 'surface at interior temperature');
  close(fRsi(9, 20, 9), 0, 1e-12, 'surface at exterior temperature');
  close(fRsi(16.7, 20, 9), 0.7, 1e-12, 'mold threshold case');
});

test('psiExternal: external-dimension convention, zero for an unbridged wall', () => {
  const U = 0.1956;
  const lengths = [1.415, 1.415];
  const noBridge = psiExternal({ L2D: U * (lengths[0] + lengths[1]), U, lengths });
  close(noBridge.psi, 0, 1e-12, 'no bridge → ψ = 0');
  assert.equal(noBridge.convention, 'external');
  const corner = psiExternal({ L2D: 0.45, U, lengths });
  close(corner.psi, 0.45 - U * 2.83, 1e-12, 'ψ formula');
  assert.ok(corner.psi < 0, 'corner with external dimensions is typically negative');
});

// ====================================================================
// M2 primitives (DESIGN §2.3–§2.6) — written BEFORE the harmonic code.
// ====================================================================

test('OMEGA constants match DESIGN §2.6', () => {
  close(OMEGA_ANNUAL, 2 * Math.PI / 31_557_600, 1e-18, 'ω_annual');
  close(OMEGA_DIURNAL, 2 * Math.PI / 86_400, 1e-15, 'ω_diurnal');
  // δ ratio sqrt(365.25) follows from the frequency ratio alone
  close(Math.sqrt(OMEGA_DIURNAL / OMEGA_ANNUAL), Math.sqrt(365.25), 1e-9, 'ω ratio');
});

test('penetrationDepth: concrete matches the DESIGN §2.3 table', () => {
  const { lambda, rho, c } = MATERIALS.concrete;
  const dd = penetrationDepth(lambda, rho, c, OMEGA_DIURNAL);
  const da = penetrationDepth(lambda, rho, c, OMEGA_ANNUAL);
  close(dd, 0.1551, 5e-4, 'concrete diurnal δ');
  close(da, 2.965, 5e-3, 'concrete annual δ');
  close(da / dd, Math.sqrt(365.25), 1e-9, 'δ_annual / δ_diurnal');
});

test('semiInfinite: amplitude e^{−x/δ} decay, phase −x/δ lag', () => {
  const delta = 0.2;
  const { amp, phase } = semiInfinite(3, delta, delta); // x = δ
  close(amp, 3 * Math.exp(-1), 1e-12, 'amplitude at x=δ is A·e^{−1}');
  close(phase, -1, 1e-12, 'phase at x=δ is −1 rad (a lag)');
  assert.ok(semiInfinite(1, 2 * delta, delta).phase < semiInfinite(1, delta, delta).phase,
    'phase decreases (lag grows) with depth');
});

test('amplitude / timeLag: a lagging phasor reports a positive lag', () => {
  close(amplitude(3, 4), 5, 1e-12, '|3+4i|');
  // pure-real positive phasor: no lag
  close(timeLag(1, 0, OMEGA_DIURNAL), 0, 1e-12, 'real positive → zero lag');
  // phasor at angle −1 rad lags by 1/ω seconds (DESIGN §2.6: τ = −arg/ω ≥ 0)
  const re = Math.cos(-1);
  const im = Math.sin(-1);
  close(timeLag(re, im, OMEGA_DIURNAL), 1 / OMEGA_DIURNAL, 1e-6, 'lag = 1 rad / ω');
  // lag is normalized into [0, period): a near-+π phase wraps to a long lag
  const lag = timeLag(Math.cos(3), Math.sin(3), OMEGA_DIURNAL);
  assert.ok(lag >= 0 && lag < 2 * Math.PI / OMEGA_DIURNAL, `lag ${lag} in [0,period)`);
});

test('timeLagRelative: a phasor in sync with its reference reports ≈ 0 lag', () => {
  // refPhase = 0 recovers the absolute lag
  close(timeLagRelative(1, 0, OMEGA_ANNUAL, 0), timeLag(1, 0, OMEGA_ANNUAL), 1e-9, 'φ_ref=0 ≡ absolute');
  // a phasor whose arg EQUALS the reference is in sync → zero relative lag, even
  // though its absolute lag is large (the corner2d surface = the forcing case)
  const refPhase = Math.PI - OMEGA_ANNUAL * 15 * 86400; // annual climate (min day 15)
  const re = Math.cos(refPhase);
  const im = Math.sin(refPhase);
  close(timeLagRelative(re, im, OMEGA_ANNUAL, refPhase), 0, 1e-6, 'surface in sync → 0 d');
  assert.ok(timeLag(re, im, OMEGA_ANNUAL) > 150 * 86400, 'but its absolute lag is ~½ year');
  // an extra −1 rad beyond the reference is a genuine inward lag of 1/ω seconds
  const re2 = Math.cos(refPhase - 1);
  const im2 = Math.sin(refPhase - 1);
  close(timeLagRelative(re2, im2, OMEGA_ANNUAL, refPhase), 1 / OMEGA_ANNUAL, 1e-6, 'extra 1 rad lag');
});

test('phasorEval: reconstructs T̄ + Re[T̂ e^{iωt}] (DESIGN §2.5 sign)', () => {
  // T̂ = 2 − 3i, single frequency; check against the explicit cos/sin form
  const h = { re: 2, im: -3, omega: OMEGA_DIURNAL };
  for (const t of [0, 1000, 43200, 80000]) {
    const want = 5 + (h.re * Math.cos(h.omega * t) - h.im * Math.sin(h.omega * t));
    close(phasorEval(5, [h], t), want, 1e-12, `phasorEval at t=${t}`);
  }
  // superposition of two harmonics adds
  const a = { re: 1, im: 0, omega: OMEGA_ANNUAL };
  const b = { re: 0, im: 1, omega: OMEGA_DIURNAL };
  close(phasorEval(0, [a, b], 0), 1, 1e-12, 'two-harmonic superposition at t=0');
});

test('climatePhasor: minimum falls at the stated offset under e^{+iωt}', () => {
  // annual: amplitude 10, minimum 15 days after t=0 (mid-January, DESIGN §5.3)
  const ph = climatePhasor({ amp: 10, phaseDays: 15 }, OMEGA_ANNUAL);
  close(amplitude(ph.re, ph.im), 10, 1e-9, 'phasor magnitude equals the amplitude');
  const tMin = 15 * 86_400;
  const harm = { ...ph, omega: OMEGA_ANNUAL };
  const valAtMin = phasorEval(9, [harm], tMin);
  close(valAtMin, 9 - 10, 1e-6, 'value at the stated offset is mean − amplitude (the minimum)');
  // neighbours are warmer → it really is the minimum
  const dt = 86_400;
  assert.ok(phasorEval(9, [harm], tMin - dt) > valAtMin, 'before the min is warmer');
  assert.ok(phasorEval(9, [harm], tMin + dt) > valAtMin, 'after the min is warmer');

  // diurnal: minimum ~04:00 (4 h after midnight)
  const pd = climatePhasor({ amp: 5, phaseHours: 4 }, OMEGA_DIURNAL);
  const hd = { ...pd, omega: OMEGA_DIURNAL };
  const tMinD = 4 * 3600;
  close(phasorEval(20, [hd], tMinD), 20 - 5, 1e-6, 'diurnal minimum at 04:00');
});
