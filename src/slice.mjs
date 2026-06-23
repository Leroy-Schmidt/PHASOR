// PHASOR axis-agnostic plane sampler (3D view rework). Samples a solved field
// onto an axis-normal cutting plane into a resA×resB scalar grid the in-scene
// texture is built from. Pure and DOM-free so the (bug-prone) cross-axis index
// math is unit-tested without WebGL.
//
// The cut plane's normal is `axis`; the two in-plane axes (a, b) are the other
// two in x<y<z order — z-cut → (x,y); x-cut → (y,z); y-cut → (x,z) — matching
// `fluxGlyphs`. Output is row-major: b outer (rows), a inner (columns), so it
// drops straight into a DataTexture (row 0 = b minimum).

const AXIS = { x: 0, y: 1, z: 2 };

/** In-plane axis indices [a, b] for a cut whose normal is `axis`. */
export function planeAxes(axis) {
  const n = AXIS[axis];
  return [0, 1, 2].filter((d) => d !== n);
}

/** Nearest node layer (0..n) and cell layer (0..n-1) along `axis` to world `coord`. */
export function nearestLayers(grid, axis, coord) {
  const n = AXIS[axis];
  const ticks = [grid.xs, grid.ys, grid.zs][n];
  const nCells = [grid.nx, grid.ny, grid.nz][n];
  let kNode = 0;
  for (let k = 1; k <= nCells; k++) {
    if (Math.abs(ticks[k] - coord) < Math.abs(ticks[kNode] - coord)) kNode = k;
  }
  return { kNode, kCell: Math.min(kNode, nCells - 1) };
}

/**
 * Sample a field on the axis-normal plane at world `coord` into a resA×resB
 * Float64Array (row-major: row = b, col = a). NaN where the cell is void
 * (caller paints transparent) or the value is non-finite (masked).
 *
 * @param {object} o
 * @param {'cell'|'nodal'} o.kind — per-cell value (e.g. |q|) vs bilinear nodal
 * @param {Float64Array} o.field — full-grid array (cell- or node-indexed)
 * @param {object} o.grid — buildGrid result (xs/ys/zs, nx/ny/nz)
 * @param {{cells, matIds}} o.painted — for the void test
 * @param {object} o.materials — id → material (falsy ⇒ void)
 * @param {'x'|'y'|'z'} o.axis — plane normal
 * @param {number} o.coord — world position along the normal
 * @param {number} o.resA @param {number} o.resB — texel resolution
 * @returns {Float64Array} length resA·resB
 */
export function sampleField({ kind, field, grid, painted, materials, axis, coord, resA, resB }) {
  const axisN = AXIS[axis];
  const [pa, pb] = planeAxes(axis);
  const COORD = [grid.xs, grid.ys, grid.zs];
  const NC = [grid.nx, grid.ny, grid.nz];
  const ca = COORD[pa];
  const cb = COORD[pb];
  const nA = NC[pa];
  const nB = NC[pb];
  const aMin = ca[0];
  const bMin = cb[0];
  const spanA = ca[nA] - aMin;
  const spanB = cb[nB] - bMin;
  const { kNode, kCell } = nearestLayers(grid, axis, coord);
  const { nx, ny } = grid;
  const sy = nx + 1;
  const sz = (nx + 1) * (ny + 1);

  const cellOf = (ia, ib, layer) => {
    const ijk = [0, 0, 0];
    ijk[pa] = ia; ijk[pb] = ib; ijk[axisN] = layer;
    return ijk[0] + nx * (ijk[1] + ny * ijk[2]);
  };
  const nodeOf = (ia, ib, layer) => {
    const ijk = [0, 0, 0];
    ijk[pa] = ia; ijk[pb] = ib; ijk[axisN] = layer;
    return ijk[0] + sy * ijk[1] + sz * ijk[2];
  };

  // in-plane cell column per texel along a (monotone walk)
  const colA = new Int32Array(resA);
  for (let p = 0, i = 0; p < resA; p++) {
    const a = aMin + ((p + 0.5) / resA) * spanA;
    while (i < nA - 1 && a > ca[i + 1]) i++;
    while (i > 0 && a < ca[i]) i--;
    colA[p] = i;
  }

  const out = new Float64Array(resA * resB);
  for (let q = 0; q < resB; q++) {
    const b = bMin + ((q + 0.5) / resB) * spanB;
    let j = 0;
    while (j < nB - 1 && b > cb[j + 1]) j++;
    while (j > 0 && b < cb[j]) j--;
    const tb = (b - cb[j]) / (cb[j + 1] - cb[j]);
    for (let p = 0; p < resA; p++) {
      const ia = colA[p];
      const o = q * resA + p;
      if (!materials[painted.matIds[painted.cells[cellOf(ia, j, kCell)]]]) {
        out[o] = NaN; // void → transparent
        continue;
      }
      if (kind === 'cell') {
        out[o] = field[cellOf(ia, j, kCell)];
      } else {
        const a = aMin + ((p + 0.5) / resA) * spanA;
        const ta = (a - ca[ia]) / (ca[ia + 1] - ca[ia]);
        const v00 = field[nodeOf(ia, j, kNode)];
        const v10 = field[nodeOf(ia + 1, j, kNode)];
        const v01 = field[nodeOf(ia, j + 1, kNode)];
        const v11 = field[nodeOf(ia + 1, j + 1, kNode)];
        out[o] = (1 - tb) * ((1 - ta) * v00 + ta * v10) + tb * ((1 - ta) * v01 + ta * v11);
      }
    }
  }
  return out;
}
