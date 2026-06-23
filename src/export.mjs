// PHASOR export (ROADMAP S2-M1.6) — a versioned, JSON-safe snapshot of the
// computed numbers: the seam to the Norm-Explainer app (and any downstream
// consumer). Pure and DOM-free so the schema + round-trip are gated under
// `node --test`. The UI just serializes the result and downloads it.
//
// Versioned so the Explainer can pin the schema; lossless under JSON round-trip
// (NaN/Infinity → null, since JSON has no representation for them).

export const EXPORT_VERSION = 1;

/** Finite number or null — keeps the export JSON-round-trippable (no NaN/∞). */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Shallow-map a {key: number} record through `num` (e.g. Φ by region). */
function numMap(obj) {
  const out = {};
  for (const k of Object.keys(obj ?? {})) out[k] = num(obj[k]);
  return out;
}

function exportHarmonics(harmonics) {
  return (harmonics ?? []).map((h) => ({
    f: h.f, omega: num(h.omega), re: num(h.re), im: num(h.im),
  }));
}

/**
 * Build the versioned export object from a solved result.
 * @param {object} o
 * @param {string} o.preset @param {object} [o.params]
 * @param {object} o.climate — { interior:{mean,harmonics}, exterior:{mean,harmonics} }
 * @param {object} o.readouts — worker `steadyReadouts().readouts`
 * @param {object|null} [o.loss] — worker `loss` ({ earth, air? } region-flux phasors)
 * @param {object} [o.stats] — worker `stats` (cells, nodes, iterations, …)
 * @param {string} [o.generatedAt] — ISO timestamp (injectable for deterministic tests)
 */
export function buildExport({ preset, params, climate, readouts, loss, stats, generatedAt }) {
  const r = readouts ?? {};
  const psi = r.psi
    ? { value: num(r.psi.psi), convention: 'external dimensions', L2D: num(r.L2D ?? r.psi.L2D), U: num(r.U ?? r.psi.U) }
    : null;
  const climateBlock = (side) => (side
    ? { mean: num(side.mean), harmonics: (side.harmonics ?? []).map((h) => ({ f: h.f, amp: num(h.amp), phaseDays: num(h.phaseDays), phaseHours: num(h.phaseHours) })) }
    : null);

  return {
    version: EXPORT_VERSION,
    tool: 'PHASOR',
    generatedAt: generatedAt ?? new Date().toISOString(),
    preset: { name: preset, params: params ?? {} },
    climate: {
      interior: climateBlock(climate?.interior),
      exterior: climateBlock(climate?.exterior),
    },
    readouts: {
      fRsi: num(r.fRsi),
      RsiUsed: num(r.RsiUsed),
      thetaSiMin: num(r.thetaSiMin25), // at R_si = 0.25 (the f_Rsi convention)
      thetaSiMinDisplay: num(r.thetaSiMinDisplay),
      Ti: num(r.Ti),
      Te: num(r.Te),
      U: num(r.U),
      L2D: num(r.L2D),
      psi,
      phi: numMap(r.phi),
      fluxImbalance: num(r.imbalance),
    },
    loss: loss ? {
      earth: loss.earth ? { mean: num(loss.earth.mean), harmonics: exportHarmonics(loss.earth.harmonics) } : null,
      air: loss.air ? { mean: num(loss.air.mean), harmonics: exportHarmonics(loss.air.harmonics) } : null,
    } : null,
    stats: stats ? {
      cells: num(stats.cells), nodes: num(stats.nodes),
      iterations: num(stats.iterations), converged: !!stats.converged,
    } : null,
  };
}

/** Schema check: required keys + types present. Returns { ok, errors }. */
export function validateExport(obj) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(obj && typeof obj === 'object', 'not an object');
  if (obj) {
    need(obj.version === EXPORT_VERSION, `version must be ${EXPORT_VERSION}`);
    need(obj.tool === 'PHASOR', 'tool must be PHASOR');
    need(obj.preset && typeof obj.preset.name === 'string', 'preset.name required');
    need(obj.readouts && typeof obj.readouts === 'object', 'readouts required');
    need('fRsi' in (obj.readouts ?? {}), 'readouts.fRsi required');
  }
  return { ok: errors.length === 0, errors };
}

/** Flat CSV of the headline readouts (the "numbers" half of JSON/CSV export). */
export function readoutsCSV(exp) {
  const r = exp.readouts;
  const rows = [['quantity', 'value', 'unit']];
  rows.push(['f_Rsi', r.fRsi, '-']);
  rows.push(['theta_si_min', r.thetaSiMin, 'C']);
  rows.push(['U', r.U, 'W/m2K']);
  rows.push(['L2D', r.L2D, 'W/mK']);
  if (r.psi) rows.push(['psi', r.psi.value, 'W/mK (external dims)']);
  for (const k of Object.keys(r.phi)) rows.push([`Phi_${k}`, r.phi[k], 'W']);
  return rows.map((row) => row.map((c) => (c == null ? '' : String(c))).join(',')).join('\n');
}
