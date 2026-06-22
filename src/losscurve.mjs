// PHASOR annual heat-loss curve (ROADMAP S2-M1.4). The heat lost from a heated
// region is the net flux out through its surfaces; over a year it is
//   Φ(t) = Φ̄ + Σ_k Re[Φ̂_k e^{iω_k t}]
// where Φ̄ is the steady region flux and Φ̂_k the complex region-flux phasor of
// the harmonic field. Built by SUPERPOSITION from the already-solved phasor
// fields — never a re-solve (DESIGN §3.5). The annual mean loss is just Φ̄ (the
// harmonics integrate to zero over a period).
//
// Pure and DOM-free; the flux integrals reuse flux.mjs (regionFlux is gated
// against fem.boundaryFlux by G1.1d), so this is a thin, linear composition.
import { cellFlux, cellFluxComplex, regionFlux } from './flux.mjs';

/**
 * Steady (real) net heat flux out through a region: Φ̄ = ∮ q·n, q = −λ∇T̄.
 * @param {object} problem — carries grid, cellLambda, robinFaces
 * @param {Float64Array} mean — steady nodal field
 * @param {string} region — Robin region name (e.g. 'interior')
 * @returns {number} W (SI)
 */
export function regionFluxReal(problem, mean, region) {
  return regionFlux(problem, cellFlux(problem, mean), region);
}

/**
 * Complex region-flux phasor Φ̂ = ∮ q̂·n, q̂ = −λ∇T̂, for one harmonic field
 * (re/im nodal phasors). re/im decouple because λ is real.
 * @returns {{re: number, im: number}} W
 */
export function regionFluxPhasor(problem, Tre, Tim, region) {
  const q = cellFluxComplex(problem, Tre, Tim);
  return {
    re: regionFlux(problem, { qx: q.qxRe, qy: q.qyRe, qz: q.qzRe }, region),
    im: regionFlux(problem, { qx: q.qxIm, qy: q.qyIm, qz: q.qzIm }, region),
  };
}

/** Instantaneous region loss at time t by superposition (no re-solve). */
export function lossAt(meanPhi, phasors, t) {
  let phi = meanPhi;
  for (const h of phasors) phi += h.re * Math.cos(h.omega * t) - h.im * Math.sin(h.omega * t);
  return phi;
}

/**
 * Sample Φ(t) over one full period of the LOWEST frequency present (annual), so
 * the year reads as one cycle with the faster harmonics riding on it.
 * @param {number} meanPhi — Φ̄
 * @param {{omega: number, re: number, im: number}[]} phasors — region-flux phasors
 * @param {number} nSamples
 * @returns {{period: number, t: Float64Array, phi: Float64Array}}
 */
export function lossCurveSamples(meanPhi, phasors, nSamples) {
  const omegaMin = phasors.length ? Math.min(...phasors.map((h) => h.omega)) : 0;
  const period = omegaMin > 0 ? (2 * Math.PI) / omegaMin : 1;
  const t = new Float64Array(nSamples);
  const phi = new Float64Array(nSamples);
  for (let s = 0; s < nSamples; s++) {
    t[s] = (s / nSamples) * period;
    phi[s] = lossAt(meanPhi, phasors, t[s]);
  }
  return { period, t, phi };
}
