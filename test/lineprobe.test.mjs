// LineProbe pure sampling helpers (the DOM-free core of src/lineprobe.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, nodeIndex } from '../src/grid.mjs';
import { wall1d, soil_rod } from '../src/model.mjs';
import { probeAxis, lineIndices } from '../src/lineprobe.mjs';

test('probeAxis picks the longest geometric axis', () => {
  assert.equal(probeAxis(buildGrid(soil_rod().gridSpec)), 1, 'soil_rod: depth is y');
  assert.equal(probeAxis(buildGrid(wall1d().gridSpec)), 0, 'wall1d: through-wall is x');
});

test('lineIndices walks the centerline with monotone distances and valid nodes', () => {
  const grid = buildGrid(soil_rod({ depth: 10 }).gridSpec);
  const { idx, dist } = lineIndices(grid, 1);
  assert.equal(idx.length, grid.ny + 1, 'one sample per tick along the axis');
  assert.equal(dist.length, idx.length);
  // distances span 0 → depth, strictly increasing
  assert.ok(Math.abs(dist[0] - 0) < 1e-12);
  assert.ok(Math.abs(dist[dist.length - 1] - grid.ys[grid.ny]) < 1e-12);
  for (let s = 1; s < dist.length; s++) assert.ok(dist[s] > dist[s - 1], 'monotone depth');
  // node indices match the centerline (mid x, mid z)
  const i = Math.floor(grid.nx / 2);
  const k = Math.floor(grid.nz / 2);
  for (let j = 0; j <= grid.ny; j++) {
    assert.equal(idx[j], nodeIndex(grid, i, j, k), `node at j=${j}`);
  }
});
