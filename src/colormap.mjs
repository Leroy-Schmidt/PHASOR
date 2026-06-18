// PHASOR colormaps (DESIGN §4.3 "one accent color, quiet"). DOM-free so the 2D
// slice panel (viz2d) and the in-scene 3D field plane (viz3d, M4) paint the same
// field with the exact same colors — single source of truth, unit-testable.
// Each maps a normalized t (clamped to [0,1]) → [r, g, b] in 0..255.

// compact coolwarm-style diverging map: cold blue → neutral → warm red.
// For signed/temperature fields where a neutral midpoint reads correctly.
const DIVERGING_STOPS = [
  [59, 76, 192],
  [221, 221, 221],
  [180, 4, 38],
];

export function diverging(t) {
  const s = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const seg = s < 0.5 ? 0 : 1;
  const f = (s - seg * 0.5) * 2;
  const a = DIVERGING_STOPS[seg];
  const b = DIVERGING_STOPS[seg + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

// sequential map (dark → accent → pale) for magnitude-like fields (amplitude,
// phase lag) where zero is meaningful and a diverging midpoint would mislead.
const SEQ_STOPS = [
  [13, 24, 59],
  [38, 86, 140],
  [62, 156, 161],
  [158, 211, 142],
  [247, 240, 180],
];

export function sequential(t) {
  const s = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const x = s * (SEQ_STOPS.length - 1);
  const seg = Math.min(SEQ_STOPS.length - 2, Math.floor(x));
  const f = x - seg;
  const a = SEQ_STOPS[seg];
  const b = SEQ_STOPS[seg + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}
