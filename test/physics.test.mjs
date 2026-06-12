// M1 physics unit tests — written BEFORE src/physics.mjs.
// Series-resistance wall oracle (ISO 6946 layer calculus, the G1.1 reference),
// f_Rsi formula (DIN 4108-2), ψ external-dimension convention (M1 decision).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATERIALS } from '../src/model.mjs';
import { uValue, wallSeriesResistance, fRsi, psiExternal } from '../src/physics.mjs';

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
