// G0.1 gate tests (DESIGN.md §6 M0) — written BEFORE src/grid.mjs.
// Painter unit tests: overlapping boxes, painter order, exact cell counts per
// material. Plus grid-line exactness and grading sanity (Appendix A.1, §3.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAxisTicks,
  buildGrid,
  paintBoxes,
  cellIndex,
  nodeIndex,
} from '../src/grid.mjs';

const RATIO = 1.3; // default grading ratio fixed in CLAUDE.md

function diffs(ticks) {
  const d = [];
  for (let i = 1; i < ticks.length; i++) d.push(ticks[i] - ticks[i - 1]);
  return d;
}

function countByMaterial(painted) {
  const counts = {};
  for (const id of painted.matIds) counts[id] = 0;
  for (let c = 0; c < painted.cells.length; c++) {
    counts[painted.matIds[painted.cells[c]]]++;
  }
  return counts;
}

// ---------------------------------------------------------------- axis ticks

test('ticks contain every mandatory coordinate exactly (===)', () => {
  const mandatory = [0, 0.015, 0.255, 0.415]; // plaster/brick/eps wall faces
  const ticks = buildAxisTicks(mandatory, { maxH: 0.05 });
  for (const m of mandatory) {
    assert.ok(Array.from(ticks).includes(m), `mandatory ${m} missing from ticks`);
  }
});

test('ticks strictly increasing, no near-duplicate lines', () => {
  const ticks = buildAxisTicks([0, 0.1, 0.1 + 1e-15, 1], { maxH: 0.2 });
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i] - ticks[i - 1] > 1e-12,
      `ticks not strictly increasing at i=${i}: ${ticks[i - 1]} -> ${ticks[i]}`);
  }
});

test('cell sizes respect maxH and >= 4 cells per material interval', () => {
  const mandatory = [0, 0.015, 0.255, 0.415];
  const ticks = buildAxisTicks(mandatory, { maxH: 0.05 });
  for (const h of diffs(ticks)) {
    assert.ok(h > 0, 'non-positive cell size');
    assert.ok(h <= 0.05 + 1e-9, `cell size ${h} exceeds maxH`);
  }
  // every interval between mandatory lines hosts >= 4 cells (§3.1 rule)
  const arr = Array.from(ticks);
  for (let m = 1; m < mandatory.length; m++) {
    const lo = arr.indexOf(mandatory[m - 1]);
    const hi = arr.indexOf(mandatory[m]);
    assert.ok(hi - lo >= 4,
      `interval [${mandatory[m - 1]}, ${mandatory[m]}] has ${hi - lo} cells (< 4)`);
  }
});

test('interval with no refinement point is uniform', () => {
  const ticks = buildAxisTicks([0, 1], { maxH: 0.13 });
  const d = diffs(ticks);
  for (const h of d) assert.ok(Math.abs(h - d[0]) < 1e-12, 'non-uniform spacing');
});

test('grading refines toward refinement point, ratio bounded', () => {
  const ticks = buildAxisTicks([0, 1], { maxH: 0.1, refinePoints: [0] });
  const d = diffs(ticks);
  // smallest cell sits at the refined end
  assert.ok(d[0] === Math.min(...d), 'smallest cell not at refinement point');
  // sizes non-decreasing away from the refined end, adjacent ratio bounded
  for (let i = 1; i < d.length; i++) {
    assert.ok(d[i] >= d[i - 1] - 1e-12, `sizes shrink away from refine point at ${i}`);
    assert.ok(d[i] / d[i - 1] <= RATIO * (1 + 1e-9),
      `adjacent ratio ${d[i] / d[i - 1]} exceeds ${RATIO}`);
  }
  // visibly refined: first cell meaningfully smaller than the cap
  assert.ok(d[0] < 0.5 * 0.1, 'refinement not visible (first cell too coarse)');
});

test('grading toward both interval ends is symmetric-ish with big cells mid-span', () => {
  const ticks = buildAxisTicks([0, 1], { maxH: 0.1, refinePoints: [0, 1] });
  const d = diffs(ticks);
  const mid = Math.floor(d.length / 2);
  assert.ok(d[0] < d[mid], 'left end not refined');
  assert.ok(d[d.length - 1] < d[mid], 'right end not refined');
});

// ----------------------------------------------------------------- buildGrid

test('buildGrid produces consistent ticks, spacings, counts', () => {
  const grid = buildGrid({
    x: { mandatory: [0, 1], maxH: 0.25 },
    y: { mandatory: [0, 1], maxH: 0.25 },
    z: { mandatory: [0, 0.5], maxH: 0.25 },
  });
  assert.equal(grid.nx, grid.xs.length - 1);
  assert.equal(grid.ny, grid.ys.length - 1);
  assert.equal(grid.nz, grid.zs.length - 1);
  for (let i = 0; i < grid.nx; i++) {
    assert.ok(Math.abs(grid.dx[i] - (grid.xs[i + 1] - grid.xs[i])) < 1e-15);
  }
  const sum = Array.from(grid.dx).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, 'dx does not sum to domain length');
});

test('index conventions: fastest index is i (x), then j, then k', () => {
  const grid = buildGrid({
    x: { mandatory: [0, 1], maxH: 0.25 }, // nx = 4
    y: { mandatory: [0, 1], maxH: 0.25 }, // ny = 4
    z: { mandatory: [0, 1], maxH: 0.25 }, // nz = 4
  });
  assert.equal(cellIndex(grid, 0, 0, 0), 0);
  assert.equal(cellIndex(grid, 1, 0, 0), 1);
  assert.equal(cellIndex(grid, 0, 1, 0), grid.nx);
  assert.equal(cellIndex(grid, 0, 0, 1), grid.nx * grid.ny);
  assert.equal(nodeIndex(grid, 0, 1, 0), grid.nx + 1);
  assert.equal(nodeIndex(grid, 0, 0, 1), (grid.nx + 1) * (grid.ny + 1));
});

// -------------------------------------------------------------- box painter

function unitGrid4() {
  // 4x4x4 uniform unit cube, ticks at multiples of 0.25
  return buildGrid({
    x: { mandatory: [0, 0.5, 1], maxH: 0.25, minCells: 1 },
    y: { mandatory: [0, 1], maxH: 0.25, minCells: 1 },
    z: { mandatory: [0, 1], maxH: 0.25, minCells: 1 },
  });
}

test('single box covering the domain paints every cell', () => {
  const grid = unitGrid4();
  const painted = paintBoxes(grid, [
    { name: 'all', x: [0, 1], y: [0, 1], z: [0, 1], material: 'brick' },
  ], 'background');
  const counts = countByMaterial(painted);
  assert.equal(counts.brick, 64);
  assert.equal(counts.background ?? 0, 0);
});

test('painter order: later box overwrites earlier in the overlap only', () => {
  const grid = unitGrid4();
  const boxes = [
    { name: 'a', x: [0, 1], y: [0, 1], z: [0, 1], material: 'brick' },
    { name: 'b', x: [0.5, 1], y: [0, 1], z: [0, 1], material: 'eps' },
  ];
  const counts = countByMaterial(paintBoxes(grid, boxes, 'background'));
  assert.equal(counts.eps, 32, 'overlap region (x >= 0.5) must be eps');
  assert.equal(counts.brick, 32, 'earlier material must survive outside overlap');

  // reversed order: brick painted last covers everything
  const rev = countByMaterial(paintBoxes(grid, [boxes[1], boxes[0]], 'background'));
  assert.equal(rev.brick, 64);
  assert.equal(rev.eps ?? 0, 0);
});

test('boxes sharing a face split cells exactly — no off-by-one at interfaces', () => {
  const grid = unitGrid4();
  const counts = countByMaterial(paintBoxes(grid, [
    { name: 'left', x: [0, 0.5], y: [0, 1], z: [0, 1], material: 'concrete' },
    { name: 'right', x: [0.5, 1], y: [0, 1], z: [0, 1], material: 'eps' },
  ], 'background'));
  assert.equal(counts.concrete, 32);
  assert.equal(counts.eps, 32);
  assert.equal(counts.background ?? 0, 0);
});

test('cells covered by no box get the background material', () => {
  const grid = unitGrid4();
  const counts = countByMaterial(paintBoxes(grid, [
    { name: 'half', x: [0, 0.5], y: [0, 1], z: [0, 1], material: 'wood' },
  ], 'soil'));
  assert.equal(counts.wood, 32);
  assert.equal(counts.soil, 32);
});

test('three-box sandwich (structure, insulation over, opening punched)', () => {
  // Appendix A.1 semantics on a grid whose ticks include all box faces.
  const grid = buildGrid({
    x: { mandatory: [-0.16, 0, 0.4], maxH: 0.08, minCells: 1 },
    y: { mandatory: [0, 0.3, 0.9, 1.2], maxH: 0.3, minCells: 1 },
    z: { mandatory: [0, 0.3, 1.2, 1.5], maxH: 0.3, minCells: 1 },
  });
  const boxes = [
    { name: 'wall', x: [0, 0.4], y: [0, 1.2], z: [0, 1.5], material: 'brick' },
    { name: 'eps', x: [-0.16, 0], y: [0, 1.2], z: [0, 1.5], material: 'eps' },
    { name: 'open', x: [0, 0.4], y: [0.3, 0.9], z: [0.3, 1.2], material: 'air' },
  ];
  const painted = paintBoxes(grid, boxes, 'background');
  const counts = countByMaterial(painted);

  // brute-force reference: paint by cell-center membership in painter order
  const ref = {};
  for (let k = 0; k < grid.nz; k++) {
    for (let j = 0; j < grid.ny; j++) {
      for (let i = 0; i < grid.nx; i++) {
        const cx = (grid.xs[i] + grid.xs[i + 1]) / 2;
        const cy = (grid.ys[j] + grid.ys[j + 1]) / 2;
        const cz = (grid.zs[k] + grid.zs[k + 1]) / 2;
        let mat = 'background';
        for (const b of boxes) {
          if (cx > b.x[0] && cx < b.x[1] && cy > b.y[0] && cy < b.y[1] &&
              cz > b.z[0] && cz < b.z[1]) mat = b.material;
        }
        ref[mat] = (ref[mat] ?? 0) + 1;
      }
    }
  }
  for (const id of Object.keys(ref)) {
    assert.equal(counts[id] ?? 0, ref[id],
      `cell count mismatch for material '${id}'`);
  }
  // and the punched opening must contain at least one cell, eps none removed
  assert.ok((counts.air ?? 0) > 0, 'opening painted no cells');
  assert.equal(counts.eps, ref.eps);
  assert.equal(counts.background ?? 0, 0);
});

test('material index map round-trips ids and indices', () => {
  const grid = unitGrid4();
  const painted = paintBoxes(grid, [
    { name: 'a', x: [0, 0.5], y: [0, 1], z: [0, 1], material: 'brick' },
  ], 'background');
  assert.ok(painted.matIds.includes('brick'));
  assert.ok(painted.matIds.includes('background'));
  const idx = painted.matIds.indexOf('brick');
  assert.equal(painted.cells[cellIndex(grid, 0, 0, 0)], idx);
});
