// PHASOR derived physics (DESIGN.md §2.4–§2.5). M1: series-resistance wall
// oracle (ISO 6946 layer calculus — the G1.1 reference), f_Rsi (DIN 4108-2),
// ψ-value with the external-dimension convention fixed in CLAUDE.md (M1).
// M2: penetration depth, semi-infinite anchor, climate phasors, amplitude /
// phase-lag readouts and the visualizer's phasor reconstruction.
// Pure and DOM-free; runs under `node --test`.
//
// Time convention e^{+iωt} everywhere (CLAUDE.md / DESIGN §2.6): a field that
// lags has NEGATIVE phase, so the reported lag τ = −arg(T̂)/ω comes out ≥ 0.

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

// ====================================================================
// M2 — harmonic anchors and phasor reconstruction (DESIGN §2.3–§2.6)
// ====================================================================

/** Angular frequencies (DESIGN §2.6). */
export const OMEGA_ANNUAL = 2 * Math.PI / 31_557_600; // ≈ 1.9910e-7 rad/s
export const OMEGA_DIURNAL = 2 * Math.PI / 86_400;     // ≈ 7.2722e-5 rad/s

/** Map a model harmonic id to its angular frequency. */
export const OMEGA_BY_FREQ = { annual: OMEGA_ANNUAL, diurnal: OMEGA_DIURNAL };

/**
 * Periodic penetration depth δ = √(2a/ω), a = λ/(ρc) (DESIGN §2.3). The wave
 * amplitude decays as e^{−x/δ} and lags by x/δ radians per unit depth.
 */
export function penetrationDepth(lambda, rho, c, omega) {
  return Math.sqrt((2 * lambda) / (rho * c * omega));
}

/**
 * Semi-infinite solid driven by a surface phasor of amplitude A (DESIGN §2.4):
 * T̂(x) = A·e^{−(1+i)x/δ} → amplitude A·e^{−x/δ}, phase −x/δ (a lag).
 */
export function semiInfinite(A, x, delta) {
  return { amp: A * Math.exp(-x / delta), phase: -x / delta };
}

/**
 * Complex amplitude T̂ of a climate harmonic under e^{+iωt}, such that
 * Re[T̂·e^{iωt}] = amp·cos(ωt + φ) reaches its MINIMUM at the stated offset
 * (DESIGN §5.3: annual minimum mid-January, diurnal ~04:00). Minimum ⇒
 * ω·t_min + φ = π ⇒ φ = π − ω·t_min.
 * @param {{amp: number, phaseDays?: number, phaseHours?: number}} harmonic
 * @returns {{re: number, im: number}}
 */
export function climatePhasor(harmonic, omega) {
  const tMin = (harmonic.phaseDays ?? 0) * 86_400 + (harmonic.phaseHours ?? 0) * 3600;
  const phi = Math.PI - omega * tMin;
  return { re: harmonic.amp * Math.cos(phi), im: harmonic.amp * Math.sin(phi) };
}

/** Amplitude |T̂| of a phasor stored as separate real/imag parts. */
export function amplitude(re, im) {
  return Math.hypot(re, im);
}

/**
 * Time lag τ = −arg(T̂)/ω (DESIGN §2.6), normalized into [0, period) so a
 * lagging field always reports a non-negative lag in seconds.
 */
export function timeLag(re, im, omega) {
  const period = (2 * Math.PI) / omega;
  let tau = (-Math.atan2(im, re) / omega) % period;
  if (tau < 0) tau += period;
  return tau;
}

/**
 * Instantaneous field by superposition (DESIGN §2.5):
 *   T(t) = T̄ + Σ_k [Re(T̂_k)·cos(ω_k t) − Im(T̂_k)·sin(ω_k t)].
 * Evaluated in the visualizer only — never re-solves.
 * @param {number} mean — T̄
 * @param {{re: number, im: number, omega: number}[]} harmonics
 * @param {number} t — time in seconds
 */
export function phasorEval(mean, harmonics, t) {
  let v = mean;
  for (const h of harmonics) {
    v += h.re * Math.cos(h.omega * t) - h.im * Math.sin(h.omega * t);
  }
  return v;
}
