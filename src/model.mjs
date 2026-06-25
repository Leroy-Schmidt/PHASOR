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

/**
 * `slab_junction` — exterior wall with a concrete floor slab penetrating and
 * INTERRUPTING the exterior insulation; extruded thin in z, adiabatic ends. The
 * classic *constructive* thermal bridge (DESIGN §5.1.3). x runs exterior (x=0)
 * → interior; the slab spans the full wall thickness at mid-height, so its edge
 * is flush with the exterior face — a strong heat shortcut around the eps.
 *
 * ψ uses the external-dimension convention (CLAUDE.md M1): the two flanking 1-D
 * elements are the wall above and below the junction, ψ = L_2D − U·Σl_j. The
 * UI's `layers` param is ignored — this detail carries its own fixed build-up so
 * psiSpec.layers stays consistent with the painted boxes.
 */
export function slab_junction({
  wallLayers = [
    { material: 'eps', thickness: 0.12 },
    { material: 'concrete', thickness: 0.20 },
    { material: 'plaster', thickness: 0.015 },
  ],
  height = 2.0, slabThickness = 0.20, depth = 0.2,
} = {}) {
  const faces = [0];
  for (const l of wallLayers) faces.push(faces[faces.length - 1] + l.thickness);
  const t = faces[faces.length - 1];        // total wall thickness
  const yMid = height / 2;
  const ys = yMid - slabThickness / 2;
  const yf = yMid + slabThickness / 2;

  // painter order: wall layers first, then the slab over them at mid-height
  const boxes = wallLayers.map((l, n) => ({
    name: `wall_${n}_${l.material}`,
    x: [faces[n], faces[n + 1]], y: [0, height], z: [0, depth], material: l.material,
  }));
  boxes.push({ name: 'slab', x: [0, t], y: [ys, yf], z: [0, depth], material: 'concrete' });

  return {
    name: 'slab_junction',
    boxes,
    background: 'air',
    bcs: [
      { name: 'exterior', select: { axis: 'x', side: 'min' }, type: 'robin', ...CLIMATE.external },
      { name: 'interior', select: { axis: 'x', side: 'max' }, type: 'robin', ...CLIMATE.internal },
      { name: 'cuts', select: 'rest', type: 'adiabatic' },
    ],
    gridSpec: {
      x: { mandatory: faces, maxH: 0.02 },
      y: { mandatory: [0, ys, yf, height], maxH: 0.05 },
      z: { mandatory: [0, depth], maxH: 0.1, minCells: 2 },
    },
    extent: { x: [0, t], y: [0, height], z: [0, depth] },
    // external-dimension reference lengths: wall above + below the junction.
    psiSpec: { lengths: [height - yMid, yMid], Lz: depth, layers: wallLayers },
  };
}

/**
 * `basement` — a bare concrete cellar wall + floor against a soil block
 * (DESIGN §5.1.4): the "why does the cellar peak in September" demo. Cross-
 * section in x–y, extruded thin in z; x=0 is the room-center vertical symmetry
 * plane. Built entirely below grade, so the only non-soil exterior surface is
 * the ground (top), which carries the external climate phasors. The annual wave
 * diffuses down through metres of soil and reaches the structure lagged by ~2
 * months (δ_soil ≈ 2.84 m).
 *
 * Painter order: soil fill → floor slab → wall → room void (air carves the
 * cellar). The room is the only void, so `facesInside` selects exactly the
 * heated interior surfaces (wall inner face + floor top). The deep boundary is
 * Dirichlet at T_mean; solveHarmonic's default `dirichlet:'zero'` correctly
 * vanishes its harmonic part while the steady solve holds it at T_mean.
 *
 * `soilPad` (lateral soil beyond the wall) and `soilDepth` (soil below the
 * floor) default to 9 m ≈ 3·δ_annual — verified domain-independent by G3.1.
 */
export function basement({
  soilPad = 9, soilDepth = 9, roomHalfWidth = 2.0, wallThickness = 0.3,
  roomHeight = 2.5, slabThickness = 0.2, thin = 0.2, maxH = 0.25,
} = {}) {
  const xWallOuter = roomHalfWidth + wallThickness;
  const W = xWallOuter + soilPad;
  const yFloorBottom = soilDepth;
  const yFloorTop = yFloorBottom + slabThickness;
  const H = yFloorTop + roomHeight;       // grade at y = H
  const Tmean = CLIMATE.external.T.mean;

  return {
    name: 'basement',
    boxes: [
      { name: 'soil', x: [0, W], y: [0, H], z: [0, thin], material: 'soil' },
      { name: 'floor', x: [0, xWallOuter], y: [yFloorBottom, yFloorTop], z: [0, thin], material: 'concrete' },
      { name: 'wall', x: [roomHalfWidth, xWallOuter], y: [yFloorTop, H], z: [0, thin], material: 'concrete' },
      { name: 'room', x: [0, roomHalfWidth], y: [yFloorTop, H], z: [0, thin], material: 'air' },
    ],
    background: 'air',
    bcs: [
      { name: 'interior', select: { facesInside: true }, type: 'robin', ...CLIMATE.internal },
      // 'exterior' = the ground surface exposed to external climate (named so the
      // f_Rsi / Φ readouts, which key on 'exterior'/'interior', work unchanged).
      { name: 'exterior', select: { axis: 'y', side: 'max' }, type: 'robin', ...CLIMATE.external },
      { name: 'deep', select: { axis: 'y', side: 'min' }, type: 'dirichlet', value: Tmean },
      { name: 'cuts', select: 'rest', type: 'adiabatic' },
    ],
    gridSpec: {
      x: { mandatory: [0, roomHalfWidth, xWallOuter, W], maxH },
      y: { mandatory: [0, yFloorBottom, yFloorTop, H], maxH },
      z: { mandatory: [0, thin], maxH: 0.1, minCells: 2 },
    },
    extent: { x: [0, W], y: [0, H], z: [0, thin] },
  };
}

/**
 * `basement_air` — the SAME cellar wall + floor as `basement`, but standing in
 * outdoor air instead of buried in soil (ROADMAP S2-M1.4). The soil block is
 * gone; the structure's outer faces (floor bottom/side, wall outer/top) face the
 * external climate directly through the air film (R_se = 0.04, CLIMATE.external).
 * The room inner surfaces (floor top + wall inner face) carry the interior Robin,
 * exactly as in `basement`, so the loss-region area matches and the comparison is
 * fair. x = 0 stays the room-center symmetry plane (adiabatic).
 *
 * The domain is bounded to the structure's bounding box, so the outer faces land
 * on the grid boundary and `'rest'` (after the x=0 symmetry plane) selects them
 * for the exterior-air Robin; the only interior (solid↔void) faces are the room,
 * which `facesInside` picks — same selector trick as `basement`, no new machinery.
 *
 * Pedagogy: the buried cellar loses less and lags more than this one — the soil
 * is insulation + thermal mass. The earth÷air reduction factor (S2-M1.5) is the
 * payoff, computed not looked up.
 */
export function basement_air({
  roomHalfWidth = 2.0, wallThickness = 0.3, roomHeight = 2.5,
  slabThickness = 0.2, thin = 0.2, maxH = 0.25,
} = {}) {
  const xWallOuter = roomHalfWidth + wallThickness;
  const yFloorTop = slabThickness;
  const H = yFloorTop + roomHeight; // top of the wall/room

  return {
    name: 'basement_air',
    boxes: [
      { name: 'floor', x: [0, xWallOuter], y: [0, slabThickness], z: [0, thin], material: 'concrete' },
      { name: 'wall', x: [roomHalfWidth, xWallOuter], y: [yFloorTop, H], z: [0, thin], material: 'concrete' },
      { name: 'room', x: [0, roomHalfWidth], y: [yFloorTop, H], z: [0, thin], material: 'air' },
    ],
    background: 'air',
    bcs: [
      { name: 'interior', select: { facesInside: true }, type: 'robin', ...CLIMATE.internal },
      // x=0 room-center symmetry plane — adiabatic (matched before 'rest')
      { name: 'sym', select: { axis: 'x', side: 'min' }, type: 'adiabatic' },
      // every other outer face = the structure exposed to outdoor air
      { name: 'exterior', select: 'rest', type: 'robin', ...CLIMATE.external },
    ],
    gridSpec: {
      x: { mandatory: [0, roomHalfWidth, xWallOuter], maxH },
      y: { mandatory: [0, yFloorTop, H], maxH },
      z: { mandatory: [0, thin], maxH: 0.1, minCells: 2 },
    },
    extent: { x: [0, xWallOuter], y: [0, H], z: [0, thin] },
  };
}

/**
 * `basement3d` — the genuinely VOLUMETRIC cellar (M5 showcase). The 2D
 * `basement` above is a thin z-extruded cross-section (the fast path for the
 * annual-cycle / f_Rsi physics); this is a real room with a finite footprint
 * and a true 3D corner where two below-grade walls meet — the signature
 * geometric thermal bridge that only exists in 3D.
 *
 * Modeled on QUARTER SYMMETRY: x=0 and z=0 are vertical symmetry planes through
 * the room center (adiabatic, free in FEM), so the quarter domain holds exactly
 * one vertical wall–wall corner plus the floor–wall–wall trihedral corner while
 * the grid is 4× smaller than a full cellar. The room occupies the near corner
 * (small x, small z); the L-shaped wall wraps its two outer (+x, +z) sides; the
 * floor slab sits under the whole footprint; soil fills the rest, padded
 * ≥ 3·δ_annual (~9 m) laterally (x→W, z→D) and below (y→0, deep Dirichlet T_mean).
 * The ground surface (y = H = grade) carries the external climate phasors.
 *
 * Same painter trick and BC selectors as `basement` — `facesInside` picks the
 * carved room's inner faces, the far soil faces + the two symmetry planes fall
 * into the adiabatic `cuts`. No psiSpec: ψ is a 2D/linear quantity; this preset
 * reports f_Rsi and Φ (the 2D presets remain the ψ instrument).
 *
 * `maxH` grades coarse into the deep/far soil (refinePoints cluster cells at the
 * structure) so the ≥9-m-each-way domain stays affordable; raise it for a faster
 * (coarser) solve, lower it for a finer field. The default 0.8 m (~14 k nodes,
 * ~4.7 s isolated re-solve) is the finest grid under the 5 s budget — the steady
 * ground-loss solve is long-range and dominates. A finer field (maxH 0.5 ≈ 32 k
 * nodes, ~18 s) is the motivating use case for the M5 WASM-SIMD/WebGPU matvec
 * (DESIGN §3.5 "only if a real use case exceeds the budget"); see BACKLOG.
 */
export function basement3d({
  soilPad = 9, soilDepth = 9, roomHalfWidth = 2.0, roomHalfDepth = 2.0,
  wallThickness = 0.3, roomHeight = 2.5, slabThickness = 0.2, maxH = 0.8,
} = {}) {
  const xWallOuter = roomHalfWidth + wallThickness;
  const zWallOuter = roomHalfDepth + wallThickness;
  const W = xWallOuter + soilPad;
  const D = zWallOuter + soilPad;
  const yFloorBottom = soilDepth;
  const yFloorTop = yFloorBottom + slabThickness;
  const H = yFloorTop + roomHeight;       // grade at y = H
  const Tmean = CLIMATE.external.T.mean;

  return {
    name: 'basement3d',
    boxes: [
      { name: 'soil', x: [0, W], y: [0, H], z: [0, D], material: 'soil' },
      { name: 'floor', x: [0, xWallOuter], y: [yFloorBottom, yFloorTop], z: [0, zWallOuter], material: 'concrete' },
      // L-shaped wall around the room's two outer sides (boxes overlap in the
      // corner — both concrete, harmless under the painter).
      { name: 'wallX', x: [roomHalfWidth, xWallOuter], y: [yFloorTop, H], z: [0, zWallOuter], material: 'concrete' },
      { name: 'wallZ', x: [0, xWallOuter], y: [yFloorTop, H], z: [roomHalfDepth, zWallOuter], material: 'concrete' },
      { name: 'room', x: [0, roomHalfWidth], y: [yFloorTop, H], z: [0, roomHalfDepth], material: 'air' },
    ],
    background: 'air',
    bcs: [
      { name: 'interior', select: { facesInside: true }, type: 'robin', ...CLIMATE.internal },
      { name: 'exterior', select: { axis: 'y', side: 'max' }, type: 'robin', ...CLIMATE.external },
      { name: 'deep', select: { axis: 'y', side: 'min' }, type: 'dirichlet', value: Tmean },
      // 'rest' = the two symmetry planes (x=0, z=0) + the far soil faces (x=W, z=D).
      { name: 'cuts', select: 'rest', type: 'adiabatic' },
    ],
    gridSpec: {
      x: { mandatory: [0, roomHalfWidth, xWallOuter, W], maxH, refinePoints: [roomHalfWidth, xWallOuter] },
      y: { mandatory: [0, yFloorBottom, yFloorTop, H], maxH, refinePoints: [yFloorTop, H] },
      z: { mandatory: [0, roomHalfDepth, zWallOuter, D], maxH, refinePoints: [roomHalfDepth, zWallOuter] },
    },
    extent: { x: [0, W], y: [0, H], z: [0, D] },
    // quarter-symmetry planes (x=0, z=0): both adiabatic ('cuts'), so the viewer
    // may mirror the solved quadrant out to the full cellar for DISPLAY only
    // (viz3d). The model.test gate enforces that declared planes are adiabatic.
    symmetry: ['x', 'z'],
  };
}

/**
 * `mine` — a semi-fractal branching tunnel network (S2-M2.2 capability showcase /
 * stress test). A vertical shaft from the surface bifurcates `levels` times into
 * ever-shorter perpendicular galleries (axis-aligned, alternating x/z), all carved
 * as air VOIDS in a soil block. The tunnel walls are flushed with surface air, so
 * `facesInside` selects them for a Robin BC carrying the annual climate swing — the
 * galleries act as thermal antennae conducting the surface season deep underground.
 *
 * NOT a building-physics preset: there is no f_Rsi (no heated room). Its purpose is
 * to prove the engine + WebGPU solver handle a large, irregular, multi-Robin domain
 * in acceptable time. The default `maxH` is intentionally fine (~500k nodes, ~1 min
 * full re-solve) — raise `maxH` for a quick look, lower it to push the solver. Deep
 * boundary is a mild geothermal Dirichlet (above the annual mean) so the steady
 * field shows a real gradient rather than a uniform one.
 */
export function mine({
  W = 28, H = 18, D = 28, depthY = 11, shaftW = 1.4,
  levels = 4, len0 = 7, wid0 = 1.5, shrink = 0.6, maxH = 0.5, deepT = 12,
} = {}) {
  const boxes = [{ name: 'soil', x: [0, W], y: [0, H], z: [0, D], material: 'soil' }];
  const mx = new Set([0, W]); const my = new Set([0, H]); const mz = new Set([0, D]);
  let id = 0;
  const tunnel = (x0, x1, y0, y1, z0, z1) => {
    x0 = Math.max(0, x0); x1 = Math.min(W, x1); y0 = Math.max(0, y0); y1 = Math.min(H, y1); z0 = Math.max(0, z0); z1 = Math.min(D, z1);
    if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6 || z1 - z0 < 1e-6) return;
    boxes.push({ name: `tunnel_${id++}`, x: [x0, x1], y: [y0, y1], z: [z0, z1], material: 'air' });
    mx.add(x0); mx.add(x1); my.add(y0); my.add(y1); mz.add(z0); mz.add(z1);
  };
  const cx = W / 2; const cz = D / 2;
  tunnel(cx - shaftW / 2, cx + shaftW / 2, depthY, H, cz - shaftW / 2, cz + shaftW / 2); // vertical shaft
  const branch = (x, z, len, wid, axis, depth) => {
    if (depth <= 0 || len < wid) return;
    const y0 = depthY - wid; const y1 = depthY;
    if (axis === 'x') {
      tunnel(x - len, x + len, y0, y1, z - wid / 2, z + wid / 2);
      branch(x - len, z, len * shrink, wid * shrink, 'z', depth - 1);
      branch(x + len, z, len * shrink, wid * shrink, 'z', depth - 1);
    } else {
      tunnel(x - wid / 2, x + wid / 2, y0, y1, z - len, z + len);
      branch(x, z - len, len * shrink, wid * shrink, 'x', depth - 1);
      branch(x, z + len, len * shrink, wid * shrink, 'x', depth - 1);
    }
  };
  branch(cx, cz, len0, wid0, 'x', levels);
  const sorted = (s) => [...s].sort((a, b) => a - b);
  // surface air (annual swing only — the diurnal wave barely penetrates a deep mine)
  const surfaceAir = { h: 25, T: { mean: CLIMATE.external.T.mean, harmonics: [CLIMATE.external.T.harmonics[0]] } };
  return {
    name: 'mine',
    boxes,
    background: 'air',
    bcs: [
      { name: 'interior', select: { facesInside: true }, type: 'robin', ...surfaceAir }, // tunnel walls
      { name: 'exterior', select: { axis: 'y', side: 'max' }, type: 'robin', ...surfaceAir }, // ground surface
      { name: 'deep', select: { axis: 'y', side: 'min' }, type: 'dirichlet', value: deepT },
      { name: 'cuts', select: 'rest', type: 'adiabatic' }, // far soil sides
    ],
    gridSpec: {
      x: { mandatory: sorted(mx), maxH },
      y: { mandatory: sorted(my), maxH },
      z: { mandatory: sorted(mz), maxH },
    },
    extent: { x: [0, W], y: [0, H], z: [0, D] },
  };
}

export const presets = {
  wall1d, corner2d, slab_junction, basement, basement_air, basement3d, soil_rod, mine,
};
