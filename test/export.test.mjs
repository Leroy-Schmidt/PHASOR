// S2-G1.6 (ROADMAP S2-M1.6) — the export seam to the Norm-Explainer app.
//   schema validates; round-trip lossless; the exported numbers match the
//   in-app readouts (including NaN/∞ → null so JSON survives a round-trip).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPORT_VERSION, buildExport, validateExport, readoutsCSV } from '../src/export.mjs';

// a representative solved result (corner2d-ish), with a NaN to exercise sanitising
const readouts = {
  fRsi: 0.897, RsiUsed: 0.25, thetaSiMin25: 18.87, thetaSiMinDisplay: 19.1,
  Ti: 20, Te: 9, U: 0.196, L2D: 0.4888,
  psi: { psi: -0.0646 }, phi: { interior: 5.3768, exterior: -5.3768, bad: NaN },
  imbalance: 1.1e-14,
};
const loss = {
  earth: { mean: -9.98, harmonics: [{ f: 'annual', omega: 1.99e-7, re: 2.1, im: -1.3 }] },
  air: { mean: -40.85, harmonics: [{ f: 'annual', omega: 1.99e-7, re: 9.0, im: -5.0 }] },
};
const stats = { cells: 6727, nodes: 7000, iterations: 24, converged: true };
const climate = {
  interior: { mean: 20, harmonics: [] },
  exterior: { mean: 9, harmonics: [{ f: 'annual', amp: 10, phaseDays: 15 }] },
};
const exp = buildExport({ preset: 'corner2d', params: { depth: 1 }, climate, readouts, loss, stats, generatedAt: '2026-06-23T00:00:00Z' });

test('S2-G1.6 — export schema validates and is versioned', () => {
  assert.equal(exp.version, EXPORT_VERSION);
  assert.equal(exp.tool, 'PHASOR');
  assert.equal(exp.preset.name, 'corner2d');
  const v = validateExport(exp);
  assert.ok(v.ok, `validate failed: ${v.errors.join('; ')}`);
  // a broken object fails validation
  assert.equal(validateExport({ version: 99, tool: 'X' }).ok, false);
});

test('S2-G1.6 — round-trip is lossless (NaN → null, no exceptions)', () => {
  const round = JSON.parse(JSON.stringify(exp));
  assert.deepEqual(round, exp, 'JSON round-trip must be identity');
  // the NaN Φ became null (JSON-safe) rather than vanishing or throwing
  assert.equal(exp.readouts.phi.bad, null);
  assert.ok(Number.isFinite(round.readouts.phi.interior));
});

test('S2-G1.6 — exported numbers match the in-app readouts', () => {
  assert.equal(exp.readouts.fRsi, readouts.fRsi);
  assert.equal(exp.readouts.thetaSiMin, readouts.thetaSiMin25);
  assert.equal(exp.readouts.U, readouts.U);
  assert.equal(exp.readouts.psi.value, readouts.psi.psi);
  assert.equal(exp.readouts.psi.convention, 'external dimensions');
  assert.equal(exp.readouts.phi.interior, readouts.phi.interior);
  assert.equal(exp.loss.air.mean, loss.air.mean);
  assert.equal(exp.loss.earth.harmonics[0].re, 2.1);
});

test('S2-G1.6 — psi-less preset exports psi: null; CSV carries the headline numbers', () => {
  const noPsi = buildExport({ preset: 'wall1d', readouts: { ...readouts, psi: null }, generatedAt: 'x' });
  assert.equal(noPsi.readouts.psi, null);
  assert.ok(validateExport(noPsi).ok);

  const csv = readoutsCSV(exp);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'quantity,value,unit');
  assert.ok(csv.includes('f_Rsi,0.897'));
  assert.ok(csv.includes('psi,-0.0646'));
  assert.ok(csv.includes('Phi_interior,5.3768'));
});
