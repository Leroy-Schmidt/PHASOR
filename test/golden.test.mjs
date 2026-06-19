// Golden-number regression (operator robustness check #5). A behavioral no-op
// — a perf optimization, a refactor, an "equivalent" rewrite — must NOT move a
// physics readout. These values are pinned from the green state at the commit
// that introduced this file. If a change you BELIEVE is a no-op trips this gate,
// the change is wrong, not the golden (CLAUDE.md: tolerances/goldens are law).
// A *deliberate* physics change updates the golden in the SAME commit, so the
// drift is visible in the diff and reviewable — never a silent move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATERIALS, wall1d, corner2d, slab_junction, basement } from '../src/model.mjs';
import { steadyReadouts } from '../src/worker.mjs';

const SOLVE = { tol: 1e-10, maxIter: 20000 };
const RTOL = 1e-6; // catches drift to the 6th sig-fig; far below any real bug

// pinned from the green suite at S2-M1.1 (commit 7c6a766)
const GOLDEN = {
  wall1d:        { fRsi: 0.9522326231107372, phiExt: 0.021510854025273644 },
  corner2d:      { fRsi: 0.8969703332563519, phiExt: 5.376815292054649, psi: -0.06461421791799093 },
  slab_junction: { fRsi: 0.6824264385891173, phiExt: 3.3895825547968266, psi: 1.0035500896343548 },
  basement:      { fRsi: 0.2185259105350566, phiExt: 8.756662913022508 },
};
const PRESETS = { wall1d, corner2d, slab_junction, basement };

function near(got, exp, what) {
  const rel = Math.abs(got - exp) / (Math.abs(exp) || 1);
  assert.ok(rel <= RTOL,
    `${what}: got ${got}, golden ${exp} (rel ${rel.toExponential(2)} > ${RTOL})`);
}

for (const [name, golden] of Object.entries(GOLDEN)) {
  test(`golden — ${name} steady readouts unchanged (no-op guard)`, () => {
    const { readouts } = steadyReadouts(PRESETS[name](), MATERIALS, SOLVE);
    near(readouts.fRsi, golden.fRsi, `${name} f_Rsi`);
    near(Math.abs(readouts.phi.exterior), Math.abs(golden.phiExt), `${name} Φ_ext`);
    if (golden.psi !== undefined) near(readouts.psi.psi, golden.psi, `${name} ψ`);
  });
}
