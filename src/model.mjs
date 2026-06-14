// PHASOR model: material table (DESIGN.md §5.2) and parametric presets (§5.1).
// Pure and DOM-free. Presets return { boxes, bcs, gridSpec, background } —
// BC data is carried from M0 on but consumed only from M1.

/** Default materials: λ [W/mK], ρ [kg/m³], c [J/kgK], display color. */
export const MATERIALS = {
  concrete:     { lambda: 2.1,   rho: 2400, c: 1000, color: 0x9e9e9e },
  brick:        { lambda: 0.70,  rho: 1800, c: 1000, color: 0xb5563c },
  eps:          { lambda: 0.035, rho: 20,   c: 1450, color: 0xe8e4d8 },
  mineral_wool: { lambda: 0.035, rho: 50,   c: 1030, color: 0xf2e6a0 },
  plaster:      { lambda: 0.51,  rho: 1300, c: 1000, color: 0xcdbfa6 },
  wood:         { lambda: 0.13,  rho: 500,  c: 1600, color: 0xa87c4f },
  soil:         { lambda: 2.0,   rho: 2000, c: 1250, color: 0x6b5138 },
};

/** Default climate (§5.3): phasor triples (mean, amplitude, phase) per frequency. */
export const CLIMATE = {
  external: {
    h: 25.0, // 1/R_se, R_se = 0.04 m²K/W
    T: {
      mean: 9,
      harmonics: [
        { f: 'annual', amp: 10, phaseDays: 15 },  // minimum mid-January
        { f: 'diurnal', amp: 5, phaseHours: 4 },  // minimum ~04:00
      ],
    },
  },
  internal: {
    h: 1 / 0.13, // 1/R_si, R_si = 0.13 m²K/W exactly — G1.1 compares at 1e-6 K
    T: { mean: 20, harmonics: [] },
  },
};

/** Default wall build-up, exterior → interior. */
export const DEFAULT_LAYERS = [
  { material: 'eps', thickness: 0.16 },
  { material: 'brick', thickness: 0.24 },
  { material: 'plaster', thickness: 0.015 },
];

/** Default layers with the insulation (eps) thickness replaced — UI slider. */
export function layersWithInsulation(thickness) {
  return DEFAULT_LAYERS.map((l) => (l.material === 'eps' ? { ...l, thickness } : l));
}

/**
 * `wall1d` — multilayer wall as a thin 3D slab; adiabatic lateral faces make
 * it exactly 1D. x runs exterior (x=0) → interior. Validation workhorse.
 */
export function wall1d({ layers = DEFAULT_LAYERS, lateral = 0.1 } = {}) {
  const faces = [0];
  for (const l of layers) faces.push(faces[faces.length - 1] + l.thickness);
  const xEnd = faces[faces.length - 1];

  const boxes = layers.map((l, n) => ({
    name: `layer_${n}_${l.material}`,
    x: [faces[n], faces[n + 1]],
    y: [0, lateral],
    z: [0, lateral],
    material: l.material,
  }));

  return {
    name: 'wall1d',
    boxes,
    background: 'air',
    bcs: [
      { name: 'exterior', select: { axis: 'x', side: 'min' }, type: 'robin', ...CLIMATE.external },
      { name: 'interior', select: { axis: 'x', side: 'max' }, type: 'robin', ...CLIMATE.internal },
      { name: 'cuts', select: 'rest', type: 'adiabatic' },
    ],
    gridSpec: {
      x: { mandatory: faces, maxH: 0.025 },
      y: { mandatory: [0, lateral], maxH: 0.05, minCells: 2 },
      z: { mandatory: [0, lateral], maxH: 0.05, minCells: 2 },
    },
    extent: { x: [0, xEnd], y: [0, lateral], z: [0, lateral] },
  };
}

/**
 * `corner2d` — two exterior walls meeting at 90°, extruded 1 m in z,
 * adiabatic ends. Same build-up on both legs; insulation wraps the outer
 * corner. Painter order: structure first, insulation over it, finish inside.
 * Exterior corner at (0,0); interior corner at (t,t) with t = wall thickness.
 */
export function corner2d({ layers = DEFAULT_LAYERS, flank = 1.0, depth = 1.0 } = {}) {
  const faces = [0];
  for (const l of layers) faces.push(faces[faces.length - 1] + l.thickness);
  const t = faces[faces.length - 1]; // total wall thickness
  const len = t + flank;             // leg length from the exterior corner

  // Painter order: innermost layer first, exterior-most last, so the outer
  // layers (insulation) wrap the outer corner over everything beneath.
  const boxes = [];
  for (let n = layers.length - 1; n >= 0; n--) {
    const m = layers[n].material;
    const lo = faces[n];
    const hi = faces[n + 1];
    boxes.push(
      { name: `legA_${m}`, x: [lo, len], y: [lo, hi], z: [0, depth], material: m },
      { name: `legB_${m}`, x: [lo, hi], y: [lo, len], z: [0, depth], material: m },
    );
  }

  return {
    name: 'corner2d',
    boxes,
    background: 'air',
    bcs: [
      { name: 'exterior', select: { faces: ['x=min', 'y=min'] }, type: 'robin', ...CLIMATE.external },
      { name: 'interior', select: { facesInside: true }, type: 'robin', ...CLIMATE.internal },
      { name: 'cuts', select: 'rest', type: 'adiabatic' },
    ],
    gridSpec: {
      x: { mandatory: [...faces, len], maxH: 0.06, refinePoints: [t] },
      y: { mandatory: [...faces, len], maxH: 0.06, refinePoints: [t] },
      z: { mandatory: [0, depth], maxH: 0.15 },
    },
    extent: { x: [0, len], y: [0, len], z: [0, depth] },
    // ψ-value inputs (external-dimension convention, CLAUDE.md M1):
    // leg lengths over the outside faces, extrusion length, wall build-up for U
    psiSpec: { lengths: [len, len], Lz: depth, layers },
  };
}

/**
 * `soil_rod` — a tall column of soil with the exterior climate forcing on the
 * top face, a deep far-field Dirichlet at the mean annual temperature, and
 * adiabatic sides. Single material, 1-D by construction: the textbook
 * semi-infinite solid for *seeing* the periodic penetration depth — amplitude
 * decays e^{−y/δ}, phase lags y/δ, the annual wave reaches metres down while
 * the diurnal wave dies in the top ~15 cm. Depth y runs upward: surface at
 * y = depth (top of the 2-D panel), deep end (Dirichlet) at y = 0.
 *
 * Off-script teaching/validation preset (not in DESIGN §5.1) — Operator
 * decision 2026-06-14; the 1-D sanity sibling of the M3 `basement`.
 * `maxH` 0.04 m resolves both the annual (~70 cells/δ) and diurnal (~3.7
 * cells/δ) waves; the deep Dirichlet harmonic part is T̂=0 (DESIGN §2.2),
 * which solveHarmonic imposes by default.
 */
export function soil_rod({ depth = 10, width = 3, maxH = 0.04 } = {}) {
  const thin = 0.1;
  return {
    name: 'soil_rod',
    boxes: [{ name: 'soil', x: [0, width], y: [0, depth], z: [0, thin], material: 'soil' }],
    background: 'air',
    bcs: [
      { name: 'exterior', select: { axis: 'y', side: 'max' }, type: 'robin', ...CLIMATE.external },
      { name: 'deep', select: { axis: 'y', side: 'min' }, type: 'dirichlet', value: CLIMATE.external.T.mean },
      { name: 'cuts', select: 'rest', type: 'adiabatic' },
    ],
    gridSpec: {
      x: { mandatory: [0, width], maxH: width / 3, minCells: 3 },
      y: { mandatory: [0, depth], maxH, minCells: 4 },
      z: { mandatory: [0, thin], maxH: thin / 2, minCells: 2 },
    },
    extent: { x: [0, width], y: [0, depth], z: [0, thin] },
  };
}

export const presets = { wall1d, corner2d, soil_rod };
