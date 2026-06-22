// S2-G1.5 (ROADMAP S2-M1.5) — calibration gate for the DIN EN ISO 13370 closed
// forms in src/standards.mjs.
//
// DIN EN ISO 13370:2018 contains no fully-worked numeric example (its examples
// live in companion ISO/TR documents), so the calibration anchors on the
// standard's own PUBLISHED numbers and stated identities — non-circular:
//   G1.5a  periodic penetration depth δ (Eq H.1) reproduces Table H.1
//          (2.2 / 3.2 / 4.2 m) from the Table 7 ground properties, within the
//          table's 0.1 m rounding. The independent published reference.
//   G1.5b  the heated-basement floor U (Eq 13/14) reduces to the slab-on-ground
//          U (clause 7.1) at depth z = 0 — the identity the standard states in
//          7.3.1 ANMERKUNG 1. Validates the z-handling.
//   G1.5c  sanity: U drops as insulation (resistance) rises; H_g and design load
//          are finite and sign-correct.
// Written before the comparison panel it underpins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUND, YEAR_SECONDS, penetrationDepth, equivalentThickness,
  slabOnGroundU, basementFloorU, basementWallU, basementHg, designHeatLoad,
} from '../src/standards.mjs';

// ------------------------------------------------------------------ G1.5a
test('S2-G1.5a — periodic penetration depth reproduces ISO 13370 Table H.1', () => {
  // Table 7 properties → Eq (H.1) → Table H.1 published δ (rounded to 0.1 m).
  for (const [name, g] of Object.entries(GROUND)) {
    const delta = penetrationDepth(g.lambda, g.rhoC, YEAR_SECONDS);
    assert.ok(Math.abs(delta - g.delta) < 0.05,
      `${name}: δ = ${delta.toFixed(3)} m vs Table H.1 ${g.delta} m`);
    assert.equal(Math.round(delta * 10) / 10, g.delta, `${name}: rounds to ${g.delta}`);
  }
});

// ------------------------------------------------------------------ G1.5b
test('S2-G1.5b — heated-basement floor U reduces to slab-on-ground U at z = 0', () => {
  const lg = GROUND.sand_gravel.lambda;
  for (const dt of [0.4, 1.0, 3.0, 8.0]) {
    for (const Bp of [5, 8, 12]) {
      const slab = slabOnGroundU(lg, dt, Bp);
      const basementZ0 = basementFloorU(lg, dt, 0, Bp);
      assert.ok(Math.abs(slab - basementZ0) < 1e-12,
        `z=0 reduction failed at dt=${dt}, B'=${Bp}: slab ${slab} vs basement ${basementZ0}`);
    }
  }
  // both branches exercised: dt < B' (log branch) and dt ≥ B' (well-insulated)
  assert.ok(slabOnGroundU(lg, 1.0, 8) > slabOnGroundU(lg, 12.0, 8), 'U must fall as dt rises');
});

// ------------------------------------------------------------------ G1.5c
test('S2-G1.5c — equivalent thickness, wall U, H_g and design load are sane', () => {
  const lg = GROUND.sand_gravel.lambda;
  // equivalent thickness grows with added resistance (insulation)
  const dtBare = equivalentThickness(0.3, lg, 0.13, 0.0, 0.04);
  const dtIns = equivalentThickness(0.3, lg, 0.13, 2.0, 0.04);
  assert.ok(dtIns > dtBare, 'equivalent thickness must grow with R');

  // basement wall U positive and falls with more wall resistance
  const df = equivalentThickness(0.3, lg, 0.13, 0.0, 0.04);
  const uBare = basementWallU(lg, equivalentThickness(0, lg, 0.13, 0.0, 0.04), df, 2.5);
  const uIns = basementWallU(lg, equivalentThickness(0, lg, 0.13, 2.0, 0.04), df, 2.5);
  assert.ok(uBare > 0 && uIns > 0 && uBare > uIns, `wall U sane: bare ${uBare}, ins ${uIns}`);

  // whole-cellar H_g (W/K) and a 12831-style design load (W) finite, correct sign
  const Hg = basementHg({ Afloor: 50, perimeter: 30, z: 2.5, Ufgb: 0.3, Uwgb: 0.5 });
  assert.ok(Hg > 0 && Number.isFinite(Hg), `H_g sane: ${Hg}`);
  const load = designHeatLoad(Hg, 20, -10); // θ_int 20, design exterior −10
  assert.ok(load > 0 && Math.abs(load - Hg * 30) < 1e-9, `design load = H·ΔT: ${load}`);
});
