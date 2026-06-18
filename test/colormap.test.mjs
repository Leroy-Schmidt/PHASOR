// M4: shared colormaps (src/colormap.mjs) — the 2D panel and the 3D field plane
// paint the same field with the same colors, so the mapping is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diverging, sequential } from '../src/colormap.mjs';

test('diverging: endpoints and neutral midpoint are the declared stops', () => {
  assert.deepEqual(diverging(0), [59, 76, 192]);   // cold blue
  assert.deepEqual(diverging(0.5), [221, 221, 221]); // neutral grey
  assert.deepEqual(diverging(1), [180, 4, 38]);    // warm red
});

test('diverging: clamps outside [0,1] to the endpoints', () => {
  assert.deepEqual(diverging(-3), diverging(0));
  assert.deepEqual(diverging(5), diverging(1));
});

test('diverging: quarter point interpolates linearly within the cold segment', () => {
  // t=0.25 is halfway from stop0 to stop1
  assert.deepEqual(diverging(0.25), [
    Math.round((59 + 221) / 2),
    Math.round((76 + 221) / 2),
    Math.round((192 + 221) / 2),
  ]);
});

test('sequential: endpoints are the dark/pale stops', () => {
  assert.deepEqual(sequential(0), [13, 24, 59]);
  assert.deepEqual(sequential(1), [247, 240, 180]);
});

test('sequential: clamps and hits interior stops exactly', () => {
  assert.deepEqual(sequential(-1), sequential(0));
  assert.deepEqual(sequential(2), sequential(1));
  // 4 segments → interior stops land at 0.25, 0.5, 0.75
  assert.deepEqual(sequential(0.5), [62, 156, 161]);
});

test('colormaps return integer RGB in 0..255', () => {
  for (const cm of [diverging, sequential]) {
    for (let i = 0; i <= 10; i++) {
      const rgb = cm(i / 10);
      assert.equal(rgb.length, 3);
      for (const c of rgb) {
        assert.ok(Number.isInteger(c), `${c} should be an integer`);
        assert.ok(c >= 0 && c <= 255, `${c} in range`);
      }
    }
  }
});
