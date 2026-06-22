// PHASOR standards layer (ROADMAP S2-M1.5): the DIN EN ISO 13370 (heat transfer
// via the ground) + DIN EN 12831 (design heat load) closed forms, as a pure
// DOM-free module so the calibration gate runs under `node --test`. This is the
// "validate the standard" reference PHASOR's solved fields are compared against.
//
// IP: only the equations and the standard's published reference VALUES (Table 7
// ground properties, Table H.1 penetration depths) live here — never the PDF or
// full tables. Same citation-as-data discipline as the Trittschall app.
//
// DIN EN ISO 13370:2018-03 (EN ISO 13370:2017). Equation / table numbers cited
// inline. Heated-basement clause 7.3; periodic Annex H.

/** ISO 13370 Table 7 ground properties + Table H.1 annual penetration depth δ.
 *  λ [W/(m·K)], ρc volumetric heat capacity [J/(m³·K)], δ [m] (annual). */
export const GROUND = {
  clay_silt: { desc: 'clay or silt', lambda: 1.5, rhoC: 3.0e6, delta: 2.2 },
  sand_gravel: { desc: 'sand or gravel', lambda: 2.0, rhoC: 2.0e6, delta: 3.2 },
  rock: { desc: 'homogeneous rock', lambda: 3.5, rhoC: 2.0e6, delta: 4.2 },
};

/** Seconds in a year, the value ISO 13370 Eq (H.1) uses verbatim. */
export const YEAR_SECONDS = 3.15e7;

/**
 * Periodic penetration depth δ — ISO 13370 Eq (H.1): the depth at which the
 * annual temperature swing falls to 1/e of the surface value.
 *   δ = √( period · λ / (π · ρc) )
 * Reproduces Table H.1 (2.2 / 3.2 / 4.2 m) from the Table 7 properties.
 */
export function penetrationDepth(lambda, rhoC, period = YEAR_SECONDS) {
  return Math.sqrt((period * lambda) / (Math.PI * rhoC));
}

/**
 * Total equivalent thickness — ISO 13370 Eq (12)/(15): the slab/wall build-up
 * expressed as an equivalent depth of ground.
 *   d = w + λ_g · (R_si + R + R_se)
 * For a floor (Eq 12) `w` is the external wall thickness at ground level; for a
 * wall (Eq 15) pass w = 0.
 */
export function equivalentThickness(w, lambdaG, Rsi, R, Rse) {
  return w + lambdaG * (Rsi + R + Rse);
}

/**
 * Slab-on-ground steady U — ISO 13370 clause 7.1.
 *   d_t < B':  U = 2λ_g/(π·B' + d_t) · ln(π·B'/d_t + 1)   (uninsulated/light)
 *   d_t ≥ B':  U = λ_g/(0.457·B' + d_t)                    (well insulated)
 * B' = characteristic dimension = A / (0.5·P) (clause 6.7.1).
 */
export function slabOnGroundU(lambdaG, dt, Bp) {
  if (dt < Bp) return (2 * lambdaG) / (Math.PI * Bp + dt) * Math.log((Math.PI * Bp) / dt + 1);
  return lambdaG / (0.457 * Bp + dt);
}

/**
 * Heated-basement floor U_fg,b — ISO 13370 Eq (13)/(14): the slab formula with
 * the basement depth folded in as (d_f + 0.5·z). At z = 0 it reduces to
 * `slabOnGroundU` (7.3.1 ANMERKUNG 1).
 */
export function basementFloorU(lambdaG, df, z, Bp) {
  const m = df + 0.5 * z;
  if (m < Bp) return (2 * lambdaG) / (Math.PI * Bp + m) * Math.log((Math.PI * Bp) / m + 1);
  return lambdaG / (0.457 * Bp + m);
}

/**
 * Heated-basement wall U_wg,b — ISO 13370 Eq (16):
 *   U_wg,b = (2λ_g/(π·z)) · (1 + 0.5·d_f/(d_f + z)) · ln(z/d_w,b + 1)
 * valid for d_w,b ≥ d_f (else substitute d_f → d_w,b). z is the wall's
 * below-grade depth. Returns 0 for z = 0 (no below-grade wall).
 */
export function basementWallU(lambdaG, dwb, df, z) {
  if (z <= 0) return 0;
  const d = dwb < df ? dwb : df; // use d_f, but substitute d_w,b if it is smaller
  return (2 * lambdaG) / (Math.PI * z) * (1 + (0.5 * d) / (d + z)) * Math.log(z / dwb + 1);
}

/**
 * Whole-cellar steady ground heat-transfer coefficient H_g [W/K] — ISO 13370
 * Eq (18) core: floor area × U_fg,b + below-grade wall area (z·P) × U_wg,b.
 * (Edge/linear-thermal-bridge terms ψ are omitted — add if a detail needs them.)
 */
export function basementHg({ Afloor, perimeter, z, Ufgb, Uwgb }) {
  return Afloor * Ufgb + z * perimeter * Uwgb;
}

/**
 * DIN EN 12831 design (maximum) heat load through a transfer coefficient:
 *   Φ = H · (θ_int − θ_e,design)
 * H [W/K], temperatures [°C]. The annual-worst-case loss the standard sizes to.
 */
export function designHeatLoad(H, thetaInt, thetaExtDesign) {
  return H * (thetaInt - thetaExtDesign);
}
