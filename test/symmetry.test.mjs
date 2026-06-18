// Symmetry-mirror unit tests (full-cellar display feature). The pure reflection
// math is gated here; the three.js rendering + seam continuity is the Operator's
// human gate. The "planes must be adiabatic" consistency gate lives in
// model.test.mjs (don't let the picture mirror a non-symmetric domain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symmetryTransforms, mirroredExtent } from '../src/symmetry.mjs';

// apply a transform to a [lo,hi] box on one axis → new sorted [lo,hi]
function mapInterval([lo, hi], scale, offset) {
  const a = scale * lo + offset;
  const b = scale * hi + offset;
  return a <= b ? [a, b] : [b, a];
}

test('symmetryTransforms: 2^n copies, |det|=1, tiles the full extent exactly', () => {
  const extent = { x: [0, 3], y: [0, 2], z: [0, 5] };
  const axes = ['x', 'z'];
  const ts = symmetryTransforms(axes, extent);

  // 2 axes → 4 copies; first is the identity (the solved quadrant)
  assert.equal(ts.length, 4, 'expected 2^2 = 4 copies');
  assert.deepEqual(ts[0], { scale: [1, 1, 1], offset: [0, 0, 0] }, 'first copy is identity');

  // each reflection preserves volume (|det| = product of scales = 1)
  for (const t of ts) {
    assert.equal(Math.abs(t.scale[0] * t.scale[1] * t.scale[2]), 1, 'reflection |det| must be 1');
  }

  // the four copies of the quadrant box must tile the full mirrored extent with
  // no gap and no overlap: union bbox == mirrored extent AND Σ volumes == total
  const quad = { x: extent.x, y: extent.y, z: extent.z };
  const boxes = ts.map((t) => ({
    x: mapInterval(quad.x, t.scale[0], t.offset[0]),
    y: mapInterval(quad.y, t.scale[1], t.offset[1]),
    z: mapInterval(quad.z, t.scale[2], t.offset[2]),
  }));

  const full = mirroredExtent(axes, extent);
  assert.deepEqual(full, { x: [-3, 3], y: [0, 2], z: [-5, 5] }, 'mirrored extent');

  const vol = (b) => (b.x[1] - b.x[0]) * (b.y[1] - b.y[0]) * (b.z[1] - b.z[0]);
  const quadVol = vol(quad);
  const sumVol = boxes.reduce((s, b) => s + vol(b), 0);
  assert.equal(sumVol, 4 * quadVol, 'volumes sum to 4 quadrants (no overlap, no gap)');

  // union bounding box equals the full mirrored extent
  const uni = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
  for (const b of boxes) for (const a of ['x', 'y', 'z']) {
    uni[a][0] = Math.min(uni[a][0], b[a][0]);
    uni[a][1] = Math.max(uni[a][1], b[a][1]);
  }
  assert.deepEqual(uni, full, 'union of copies fills the mirrored extent exactly');

  // each copy must land in a distinct quadrant (pairwise disjoint interiors):
  // their center points are all different
  const centers = boxes.map((b) => `${(b.x[0] + b.x[1]) / 2},${(b.z[0] + b.z[1]) / 2}`);
  assert.equal(new Set(centers).size, 4, 'four distinct quadrant centers');
});

test('symmetryTransforms: one axis → mirror pair; zero axes → identity only', () => {
  const extent = { x: [0, 4], y: [0, 1], z: [0, 1] };
  assert.equal(symmetryTransforms(['x'], extent).length, 2, 'one plane → 2 copies');
  assert.equal(symmetryTransforms([], extent).length, 1, 'no planes → identity only');
  // reflect about x = 0: the mirror sends [0,4] → [-4,0]
  const [, mirror] = symmetryTransforms(['x'], extent);
  assert.deepEqual(mirror, { scale: [-1, 1, 1], offset: [0, 0, 0] });
});
