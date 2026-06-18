// LineProbe pure sampling helpers (the DOM-free core of src/lineprobe.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, nodeIndex } from '../src/grid.mjs';
import { wall1d, soil_rod } from '../src/model.mjs';
import { probeAxis, lineIndices, lineProbeCSV } from '../src/lineprobe.mjs';

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

test('lineProbeCSV: header + one row per sample, values and |T̂| correct', () => {
  const dist = [0, 0.5, 1.0];
  const meanV = [9, 14, 19];
  const harmonics = [
    { f: 'annual', re: [3, 0, -4], im: [4, 1, 3] },
    { f: 'diurnal', re: [1, 0, 0], im: [0, 0, 0] },
  ];
  const csv = lineProbeCSV('y (depth)', dist, meanV, harmonics);
  const lines = csv.split('\n');
  assert.equal(lines.length, 1 + dist.length, 'header + one row per sample');
  assert.equal(
    lines[0],
    'y (depth) [m],T_mean [C],annual_Re [K],annual_Im [K],annual_amp [K],'
      + 'diurnal_Re [K],diurnal_Im [K],diurnal_amp [K]',
  );
  // first sample: annual amp = hypot(3,4) = 5
  assert.equal(lines[1], '0,9,3,4,5,1,0,1');
  // last sample: annual amp = hypot(-4,3) = 5
  assert.equal(lines[3], '1,19,-4,3,5,0,0,0');
});

test('lineProbeCSV: no harmonics → just distance + mean columns', () => {
  const csv = lineProbeCSV('x', [0, 1], [20, 18], []);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'x [m],T_mean [C]');
  assert.equal(lines[1], '0,20');
  assert.equal(lines[2], '1,18');
});
