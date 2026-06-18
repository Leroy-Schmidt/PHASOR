// Scrubber timing unit test (play/pause feature). The rAF loop itself is a
// human gate (G4.1-style smoothness); the wrap arithmetic is gated here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceFraction } from '../src/scrub.mjs';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-12, `${msg}: ${a} vs ${b}`);

test('advanceFraction: advances, wraps into [0,1), and loops seamlessly', () => {
  // plain advance, no wrap
  close(advanceFraction(0.20, 1, 0.1), 0.30, 'advance by dt·speed');
  // dt = 0 is a no-op (paused frame)
  close(advanceFraction(0.42, 0, 0.5), 0.42, 'dt=0 holds position');
  // crossing 1.0 wraps back near 0 (seamless loop, no clamp-and-stick at 1)
  close(advanceFraction(0.95, 1, 0.1), 0.05, 'wrap past 1');
  // exactly landing on 1 wraps to 0
  close(advanceFraction(0.5, 1, 0.5), 0.0, 'landing on 1 → 0');
  // a big jump wraps correctly (several sweeps in one dt)
  close(advanceFraction(0.0, 25, 0.1), 0.5, '2.5 sweeps → 0.5');
  // result is always in [0,1)
  for (let i = 0; i < 200; i++) {
    const v = advanceFraction(Math.random(), Math.random() * 5, Math.random());
    assert.ok(v >= 0 && v < 1, `out of [0,1): ${v}`);
  }
});
