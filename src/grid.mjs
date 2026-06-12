// PHASOR rectilinear grid + box painter (DESIGN.md §3.1, Appendix A.1).
// Pure and DOM-free; runs under `node --test`.
//
// Conventions (CLAUDE.md): i ↔ x, j ↔ y, k ↔ z, i fastest.
// Cell index  = i + nx*(j + ny*k); node index = i + (nx+1)*(j + (ny+1)*k).
// All lengths in metres. Every box face coordinate becomes a grid line, so
// material interfaces are resolved exactly — no stair-stepping.

const TOL = 1e-12;

/**
 * Build the tick (grid-line) coordinates for one axis.
 *
 * Mandatory coordinates (box faces, domain bounds) appear in the result
 * exactly (===). Refinement points are forced to be ticks too; each interval
 * between consecutive ticks is filled with cells graded geometrically toward
 * its refined end(s), adjacent-cell ratio ≤ `ratio`, size ≤ `maxH`,
 * at least `minCells` cells per interval (§3.1: ≥ 4 across a material layer).
 *
 * @param {number[]} mandatory
 * @param {{maxH: number, refinePoints?: number[], ratio?: number, minCells?: number}} opts
 * @returns {Float64Array} strictly increasing tick coordinates
 */
export function buildAxisTicks(mandatory, opts) {
  const { maxH, refinePoints = [], ratio = 1.3, minCells = 4 } = opts;
  if (!(maxH > 0)) throw new Error('buildAxisTicks: maxH must be > 0');

  // collect mandatory lines + refinement points, sort, dedupe within TOL
  const raw = [...mandatory, ...refinePoints].sort((a, b) => a - b);
  const lines = [];
  for (const v of raw) {
    if (lines.length === 0 || v - lines[lines.length - 1] > TOL) lines.push(v);
  }
  if (lines.length < 2) throw new Error('buildAxisTicks: need at least two distinct coordinates');

  const isRefined = (v) => refinePoints.some((r) => Math.abs(r - v) <= TOL);

  const ticks = [lines[0]];
  for (let m = 1; m < lines.length; m++) {
    const a = lines[m - 1];
    const b = lines[m];
    const sizes = intervalSizes(b - a, maxH, ratio, minCells, isRefined(a), isRefined(b));
    let t = a;
    for (let i = 0; i < sizes.length - 1; i++) {
      t += sizes[i];
      ticks.push(t);
    }
    ticks.push(b); // exact, no float drift
  }
  return Float64Array.from(ticks);
}

/**
 * Cell sizes filling an interval of length L, graded toward refined end(s).
 * Sizes are ≤ maxH, adjacent ratio ≤ ratio, count ≥ minCells, sum === L
 * (up to float rounding; the caller pins the interval ends exactly).
 */
function intervalSizes(L, maxH, ratio, minCells, refineLeft, refineRight) {
  if (refineLeft && refineRight) {
    const half = gradedSizes(L / 2, maxH, ratio, Math.ceil(minCells / 2));
    return [...half, ...half.slice().reverse()];
  }
  if (refineLeft) return gradedSizes(L, maxH, ratio, minCells);
  if (refineRight) return gradedSizes(L, maxH, ratio, minCells).reverse();
  // uniform
  const n = Math.max(minCells, Math.ceil(L / maxH - TOL));
  return new Array(n).fill(L / n);
}

/** Geometric growth from a small first cell, capped at maxH, rescaled to sum L. */
function gradedSizes(L, maxH, ratio, minCells) {
  const h0 = Math.min(maxH / ratio ** 4, L / Math.max(minCells, 1));
  const sizes = [];
  let h = h0;
  let sum = 0;
  while (sum < L - TOL) {
    sizes.push(h);
    sum += h;
    h = Math.min(h * ratio, maxH);
  }
  while (sizes.length < minCells) {
    sizes.push(sizes[sizes.length - 1]);
    sum += sizes[sizes.length - 1];
  }
  const scale = L / sum; // ≤ 1, so maxH and adjacent ratios stay respected
  return sizes.map((s) => s * scale);
}

/**
 * Build the full rectilinear grid from per-axis specs.
 * @param {{x: object, y: object, z: object}} spec — each axis: args of buildAxisTicks
 * @returns {{xs, ys, zs: Float64Array, dx, dy, dz: Float64Array, nx, ny, nz: number}}
 */
export function buildGrid(spec) {
  const xs = buildAxisTicks(spec.x.mandatory, spec.x);
  const ys = buildAxisTicks(spec.y.mandatory, spec.y);
  const zs = buildAxisTicks(spec.z.mandatory, spec.z);
  return {
    xs, ys, zs,
    dx: spacings(xs), dy: spacings(ys), dz: spacings(zs),
    nx: xs.length - 1, ny: ys.length - 1, nz: zs.length - 1,
  };
}

function spacings(ticks) {
  const d = new Float64Array(ticks.length - 1);
  for (let i = 0; i < d.length; i++) d[i] = ticks[i + 1] - ticks[i];
  return d;
}

export function cellIndex(grid, i, j, k) {
  return i + grid.nx * (j + grid.ny * k);
}

export function nodeIndex(grid, i, j, k) {
  return i + (grid.nx + 1) * (j + (grid.ny + 1) * k);
}

/**
 * Painter's algorithm: paint ordered boxes into the cell array; later boxes
 * overwrite earlier ones. Cells covered by no box get `backgroundId`.
 *
 * A cell belongs to a box iff its center lies inside — since every box face
 * is a grid line, this is exact (no partial cells exist).
 *
 * @param {object} grid — from buildGrid
 * @param {Array<{x: number[], y: number[], z: number[], material: string}>} boxes
 * @param {string} backgroundId
 * @returns {{cells: Uint16Array, matIds: string[]}} matIds maps index → id
 */
export function paintBoxes(grid, boxes, backgroundId) {
  const cells = new Uint16Array(grid.nx * grid.ny * grid.nz); // 0 = background
  const matIds = [backgroundId];

  for (const box of boxes) {
    let mat = matIds.indexOf(box.material);
    if (mat === -1) mat = matIds.push(box.material) - 1;
    const [i0, i1] = coveredRange(grid.xs, box.x);
    const [j0, j1] = coveredRange(grid.ys, box.y);
    const [k0, k1] = coveredRange(grid.zs, box.z);
    for (let k = k0; k < k1; k++) {
      for (let j = j0; j < j1; j++) {
        for (let i = i0; i < i1; i++) {
          cells[cellIndex(grid, i, j, k)] = mat;
        }
      }
    }
  }
  return { cells, matIds };
}

/** Half-open cell index range [lo, hi) whose centers lie inside [min, max]. */
function coveredRange(ticks, [min, max]) {
  let lo = ticks.length - 1;
  let hi = 0;
  for (let i = 0; i < ticks.length - 1; i++) {
    const c = (ticks[i] + ticks[i + 1]) / 2;
    if (c > min && c < max) {
      if (i < lo) lo = i;
      hi = i + 1;
    }
  }
  return lo < hi ? [lo, hi] : [0, 0];
}
