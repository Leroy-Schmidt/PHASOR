// Preset smoke tests (part of M0, supporting gate G0.2's geometry claims).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, paintBoxes } from '../src/grid.mjs';
import { MATERIALS, presets } from '../src/model.mjs';

function paintPreset(preset) {
  const grid = buildGrid(preset.gridSpec);
  return { grid, painted: paintBoxes(grid, preset.boxes, preset.background) };
}

function countByMaterial(painted) {
  const counts = {};
  for (const id of painted.matIds) counts[id] = 0;
  for (let c = 0; c < painted.cells.length; c++) {
    counts[painted.matIds[painted.cells[c]]]++;
  }
  return counts;
}

test('all preset materials exist in the material table', () => {
  for (const make of Object.values(presets)) {
    const preset = make();
    for (const box of preset.boxes) {
      // a box may paint the background id to carve a void (e.g. basement's room)
      if (box.material === preset.background) continue;
      assert.ok(MATERIALS[box.material], `unknown material '${box.material}'`);
    }
  }
});

// A preset may declare `symmetry: [axis,...]` so the viewer mirrors the solved
// quadrant out to the full model (viz3d). That is only physically honest if each
// declared plane (the axis MIN face) is ADIABATIC — otherwise the mirror would
// fabricate a boundary condition that wasn't solved. Gate it: no Robin/Dirichlet
// BC may select an axis-min symmetry face, and an adiabatic 'rest' catch-all must
// exist to carry those faces.
function selectsAxisMin(select, axis) {
  if (select === 'rest' || select == null) return false;
  if (select.facesInside) return false; // interior voids, not a domain face
  if (select.axis === axis && select.side === 'min') return true;
  if (select.faces && select.faces.includes(`${axis}=min`)) return true;
  return false;
}

test('symmetry presets declare only adiabatic mirror planes', () => {
  for (const make of Object.values(presets)) {
    const preset = make();
    if (!preset.symmetry) continue;
    const hasAdiabaticRest = preset.bcs.some((b) => b.select === 'rest' && b.type === 'adiabatic');
    assert.ok(hasAdiabaticRest,
      `${preset.name}: declares symmetry but has no adiabatic 'rest' catch-all`);
    for (const axis of preset.symmetry) {
      for (const bc of preset.bcs) {
        if (bc.type === 'adiabatic') continue;
        assert.ok(!selectsAxisMin(bc.select, axis),
          `${preset.name}: symmetry plane ${axis}=min is bound by non-adiabatic BC '${bc.name}' ` +
          `(type ${bc.type}) — mirroring it would fabricate physics`);
      }
    }
  }
});

test('wall1d: layer faces are grid lines, layer cell counts exact', () => {
  const preset = presets.wall1d();
  const { grid, painted } = paintPreset(preset);
  const xs = Array.from(grid.xs);
  // default build-up eps 160 / brick 240 / plaster 15 (exterior → interior)
  for (const face of [0, 0.16, 0.4, 0.415]) {
    assert.ok(xs.some((x) => Math.abs(x - face) < 1e-12), `face ${face} not a grid line`);
  }
  const counts = countByMaterial(painted);
  const perSlab = grid.ny * grid.nz;
  const xCells = (lo, hi) =>
    xs.filter((x) => x > lo + 1e-12 && x < hi - 1e-12).length + 1;
  assert.equal(counts.eps, xCells(0, 0.16) * perSlab);
  assert.equal(counts.brick, xCells(0.16, 0.4) * perSlab);
  assert.equal(counts.plaster, xCells(0.4, 0.415) * perSlab);
  assert.equal(counts.air ?? 0, 0, 'wall1d domain must be fully solid');
});

test('corner2d: both legs painted, insulation wraps the outer corner', () => {
  const preset = presets.corner2d();
  const { grid, painted } = paintPreset(preset);
  const counts = countByMaterial(painted);
  for (const m of ['eps', 'brick', 'plaster']) {
    assert.ok(counts[m] > 0, `material ${m} painted no cells`);
  }
  assert.ok(counts.air > 0, 'room interior must remain background air');
  // outer-corner cell (0,0,0) is insulation (eps wraps the corner)
  assert.equal(painted.matIds[painted.cells[0]], 'eps');
});

test('mine: branching tunnels carve air voids in soil; walls are facesInside Robin', () => {
  // tiny/coarse build — exercises the generator + painter, not a solve
  const preset = presets.mine({ W: 12, H: 10, D: 12, depthY: 6, levels: 2, len0: 3, wid0: 1.2, shaftW: 1.2, maxH: 0.8 });
  const { painted } = paintPreset(preset);
  const counts = countByMaterial(painted);
  assert.ok(counts.soil > 0, 'soil must be painted');
  assert.ok(counts.air > 0, 'tunnels must carve air voids');
  assert.ok(preset.boxes.filter((b) => b.material === 'air').length >= 3,
    'branching should produce a shaft plus multiple galleries');
  const interior = preset.bcs.find((b) => b.name === 'interior');
  assert.equal(interior.type, 'robin');
  assert.deepEqual(interior.select, { facesInside: true });
});

test('corner2d: grading refines toward the interior corner', () => {
  const preset = presets.corner2d();
  const grid = buildGrid(preset.gridSpec);
  const t = 0.415; // interior corner coordinate (default build-up)
  const xs = Array.from(grid.xs);
  const i = xs.findIndex((x) => Math.abs(x - t) < 1e-12);
  assert.ok(i > 0, 'interior corner is not a grid line');
  const hAtCorner = xs[i + 1] - xs[i];
  const hFarField = Math.max(...Array.from(grid.dx));
  assert.ok(hAtCorner < 0.5 * hFarField,
    `no visible refinement at corner: h=${hAtCorner} vs max ${hFarField}`);
});
