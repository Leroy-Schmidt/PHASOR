// PHASOR symmetry helper — pure, DOM-free, three-free; runs under `node --test`.
//
// A quarter-symmetry preset (e.g. `basement3d`) solves one quadrant; the full
// model is recovered for DISPLAY ONLY by reflecting that quadrant across its
// symmetry planes (the min face of each declared axis, which must be adiabatic —
// see the model.test gate). This module produces the reflection transforms;
// viz3d applies them to clones of the voxel group and the field plane. No
// re-solve, no new physics path (the mirror only mirrors what was solved).

const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/**
 * Reflection transforms tiling the full symmetric model from one quadrant.
 * For `n` symmetry axes there are `2^n` copies (the power set of the planes),
 * the first being the identity (the solved quadrant itself). Each reflection is
 * about the min face of its axis: a coordinate c maps to 2·min − c.
 *
 * @param {('x'|'y'|'z')[]} axes — symmetry axes; plane at extent[axis][0]
 * @param {{x:number[], y:number[], z:number[]}} extent — model bounds
 * @returns {{scale:[number,number,number], offset:[number,number,number]}[]}
 *   each transform maps a point p → (scale·p + offset) component-wise
 */
export function symmetryTransforms(axes, extent) {
  const planes = axes.map((a) => ({ i: AXIS_INDEX[a], p: extent[a][0] }));
  const n = planes.length;
  const out = [];
  for (let mask = 0; mask < (1 << n); mask++) {
    const scale = [1, 1, 1];
    const offset = [0, 0, 0];
    for (let b = 0; b < n; b++) {
      if (mask & (1 << b)) {
        const { i, p } = planes[b];
        scale[i] = -1;       // reflect: c → −c + 2p
        offset[i] = 2 * p;
      }
    }
    out.push({ scale, offset });
  }
  return out;
}

/**
 * The full mirrored extent (bounding box of all copies) for camera framing.
 * Reflecting [lo, hi] about lo extends it to [2·lo − hi, hi].
 */
export function mirroredExtent(axes, extent) {
  const set = new Set(axes);
  const ext = {};
  for (const a of ['x', 'y', 'z']) {
    const [lo, hi] = extent[a];
    ext[a] = set.has(a) ? [2 * lo - hi, hi] : [lo, hi];
  }
  return ext;
}
