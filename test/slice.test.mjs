// Gate for src/slice.mjs — the axis-agnostic plane sampler behind the 3D
// cutting-plane field texture (view rework). Verifies the cross-axis index math
// without WebGL: a known linear nodal field samples exactly on all three axes; a
// per-cell field picks the right cell; void cells mask to NaN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planeAxes, nearestLayers, sampleField } from '../src/slice.mjs';

// 3×3×3 unit grid; nodeIndex = i + 4j + 16k, cellIndex = i + 3j + 9k
const lin = Float64Array.from([0, 1, 2, 3]);
const grid = { nx: 3, ny: 3, nz: 3, xs: lin, ys: lin, zs: lin };
const allSolid = {
  cells: new Uint16Array(27).fill(0),
  matIds: ['solid'],
};
const materials = { solid: { lambda: 1 } };

// linear field at the 4³ = 64 nodes
const A0 = 5; const AX = 2; const AY = -3; const AZ = 0.5;
const fNode = new Float64Array(4 * 4 * 4);
for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
  fNode[i + 4 * j + 16 * k] = A0 + AX * i + AY * j + AZ * k;
}
const f = (x, y, z) => A0 + AX * x + AY * y + AZ * z;

test('slice: planeAxes + nearestLayers pick the right in-plane axes and layer', () => {
  assert.deepEqual(planeAxes('z'), [0, 1]);
  assert.deepEqual(planeAxes('x'), [1, 2]);
  assert.deepEqual(planeAxes('y'), [0, 2]);
  assert.deepEqual(nearestLayers(grid, 'z', 2.0), { kNode: 2, kCell: 2 });
  assert.deepEqual(nearestLayers(grid, 'z', 3.0), { kNode: 3, kCell: 2 }); // node 3 → cell clamped
});

test('slice: nodal bilinear is exact for a linear field on all three axes', () => {
  const res = 3; // texel centres land at 0.5, 1.5, 2.5 along each in-plane axis
  // z-cut at z=2: in-plane (x,y), values = f(a, b, 2)
  let v = sampleField({ kind: 'nodal', field: fNode, grid, painted: allSolid, materials, axis: 'z', coord: 2, resA: res, resB: res });
  for (let q = 0; q < res; q++) for (let p = 0; p < res; p++) {
    assert.ok(Math.abs(v[q * res + p] - f(p + 0.5, q + 0.5, 2)) < 1e-12, `z-cut (${p},${q})`);
  }
  // x-cut at x=1: in-plane (y,z), values = f(1, a, b)
  v = sampleField({ kind: 'nodal', field: fNode, grid, painted: allSolid, materials, axis: 'x', coord: 1, resA: res, resB: res });
  for (let q = 0; q < res; q++) for (let p = 0; p < res; p++) {
    assert.ok(Math.abs(v[q * res + p] - f(1, p + 0.5, q + 0.5)) < 1e-12, `x-cut (${p},${q})`);
  }
  // y-cut at y=0: in-plane (x,z), values = f(a, 0, b)
  v = sampleField({ kind: 'nodal', field: fNode, grid, painted: allSolid, materials, axis: 'y', coord: 0, resA: res, resB: res });
  for (let q = 0; q < res; q++) for (let p = 0; p < res; p++) {
    assert.ok(Math.abs(v[q * res + p] - f(p + 0.5, 0, q + 0.5)) < 1e-12, `y-cut (${p},${q})`);
  }
});

test('slice: cell sampler picks the nearest cell value', () => {
  const fCell = new Float64Array(27);
  for (let c = 0; c < 27; c++) fCell[c] = c; // value == cell index
  // z-cut at z=1.5 → cell layer 1; texel (p,q) → cell (p, q, 1) = p + 3q + 9
  const v = sampleField({ kind: 'cell', field: fCell, grid, painted: allSolid, materials, axis: 'z', coord: 1.5, resA: 3, resB: 3 });
  for (let q = 0; q < 3; q++) for (let p = 0; p < 3; p++) {
    assert.equal(v[q * 3 + p], p + 3 * q + 9, `cell (${p},${q})`);
  }
});

test('slice: void cells mask to NaN', () => {
  // paint cell 0 (i=j=k=0) as background 'air' (not in materials → void)
  const cells = new Uint16Array(27).fill(1);
  cells[0] = 0;
  const painted = { cells, matIds: ['air', 'solid'] };
  const v = sampleField({ kind: 'cell', field: new Float64Array(27).fill(7), grid, painted, materials, axis: 'z', coord: 0, resA: 3, resB: 3 });
  assert.ok(Number.isNaN(v[0]), 'the void cell texel is NaN');
  assert.equal(v[1], 7, 'a solid texel keeps its value');
});
