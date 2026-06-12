// PHASOR derived physics (DESIGN.md §2.4–§2.5). M1: series-resistance wall
// oracle (ISO 6946 layer calculus — the G1.1 reference), f_Rsi (DIN 4108-2),
// ψ-value with the external-dimension convention fixed in CLAUDE.md (M1).
// Penetration depths and harmonic anchors join in M2.
// Pure and DOM-free; runs under `node --test`.

/**
 * U-value of a plane layered wall: U = 1 / (R_si + Σ d/λ + R_se).
 * @param {{material: string, thickness: number}[]} layers — exterior → interior
 * @param {Record<string, {lambda: number}>} materials
 */
export function uValue(layers, materials, Rsi = 0.13, Rse = 0.04) {
  let R = Rsi + Rse;
  for (const l of layers) {
    const mat = materials[l.material];
    if (!mat) throw new Error(`uValue: unknown material '${l.material}'`);
    R += l.thickness / mat.lambda;
  }
  return 1 / R;
}

/**
 * Exact 1D steady solution of the layered wall with Robin surfaces:
 * interface temperatures by series resistance. x = 0 is the exterior surface,
 * x grows inward; q > 0 flows interior → exterior (heating season).
 *
 * @returns {{U: number, R: number, q: number, interfaces: {x: number, T: number}[]}}
 */
export function wallSeriesResistance(layers, materials,
  { Rsi = 0.13, Rse = 0.04, Ti = 20, Te = 9 } = {}) {
  const U = uValue(layers, materials, Rsi, Rse);
  const q = U * (Ti - Te);
  const interfaces = [];
  let x = 0;
  let T = Te + q * Rse; // exterior surface
  interfaces.push({ x, T });
  for (const l of layers) {
    x += l.thickness;
    T += q * (l.thickness / materials[l.material].lambda);
    interfaces.push({ x, T });
  }
  return { U, R: 1 / U, q, interfaces };
}

/**
 * Temperature factor f_Rsi = (θ_si − θ_e)/(θ_i − θ_e) (DIN 4108-2 mold
 * criterion: flag < 0.70). θ_si must come from a solve with R_si = 0.25.
 */
export function fRsi(thetaSi, thetaI, thetaE) {
  return (thetaSi - thetaE) / (thetaI - thetaE);
}

/**
 * Linear thermal transmittance, external-dimension convention (CLAUDE.md M1):
 * ψ = L_2D − U · Σ l_j with l_j measured over the outside faces.
 * @param {{L2D: number, U: number, lengths: number[]}} args
 * @returns {{psi: number, convention: 'external'}}
 */
export function psiExternal({ L2D, U, lengths }) {
  const lSum = lengths.reduce((s, l) => s + l, 0);
  return { psi: L2D - U * lSum, convention: 'external' };
}
