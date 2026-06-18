// PHASOR scrubber helper — pure, DOM-free, runs under `node --test`.
// The play button drives a requestAnimationFrame loop (in index.html) over the
// existing solve-free field-evaluation path (DESIGN §3.5: scrubbing never
// re-solves). This module holds only the timing arithmetic so it can be tested.

/**
 * Advance a normalized scrub position by `dt` seconds at `speed` (fraction of a
 * full sweep per second), wrapping into [0, 1) so playback loops seamlessly.
 * @param {number} frac — current position, expected in [0, 1)
 * @param {number} dt — elapsed time in seconds (≥ 0)
 * @param {number} speed — sweep fraction per second (e.g. 1/12 → 12 s per loop)
 * @returns {number} the new position in [0, 1)
 */
export function advanceFraction(frac, dt, speed) {
  const next = frac + dt * speed;
  return ((next % 1) + 1) % 1; // robust wrap, also for any tiny negative drift
}
