// PHASOR annual heat-loss panel (ROADMAP S2-M1.4) — the DOM view over the pure
// loss-curve helpers (losscurve.mjs stays DOM-free for the worker / node --test).
// Plots the heated region's heat loss Φ(t) across the year by superposition
// (never a re-solve). For 'basement' it overlays the earth case (buried) and the
// air case (the same cellar in outdoor air) and shades the gap between them — the
// reduction the soil buys (chart-with-gap idiom, à la the Trittschall app). A
// marker tracks the scrubber.
import { lossCurveSamples, lossAt } from './losscurve.mjs';

const N = 96; // samples across the year

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** "Nice" tick step covering `range` with ~target ticks: {1,2,5}·10^m. */
function niceStep(range, target = 6) {
  const raw = range / Math.max(target, 1);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

export class LossView {
  /** @param {HTMLElement} container */
  constructor(container) {
    container.textContent = '';
    this.header = el('div', 'slice-header', 'Annual heat loss');
    this.canvas = el('canvas', 'slice-canvas');
    this.note = el('div', 'slice-note', '');
    container.append(this.header, this.canvas, this.note);

    this.earth = null; // { mean, harmonics:[{omega,re,im}], period, phi:Float64Array }
    this.air = null;
    this.period = 31557600; // one year [s]
    this.time = 0;
    this._sized = false;

    new ResizeObserver(() => this.requestRender()).observe(this.canvas);
    window.addEventListener('resize', () => this.requestRender());
  }

  requestRender(framesLeft = 120) {
    this.render();
    if (!this._sized && framesLeft > 0) {
      requestAnimationFrame(() => this.requestRender(framesLeft - 1));
    }
  }

  _curve(loss) {
    if (!loss) return null;
    const { period, t, phi } = lossCurveSamples(loss.mean, loss.harmonics, N);
    // report magnitude (heat lost from the room is signed by the outward normal;
    // the curve reads as a positive heat-loss rate)
    const mag = new Float64Array(phi.length);
    for (let i = 0; i < phi.length; i++) mag[i] = Math.abs(phi[i]);
    return { mean: loss.mean, harmonics: loss.harmonics, period, t, phi: mag };
  }

  /** @param {{earth: object|null, air: object|null}} loss — worker `loss` payload */
  setLoss(loss) {
    this.earth = this._curve(loss?.earth);
    this.air = this._curve(loss?.air);
    if (this.earth) this.period = this.earth.period;
    this.requestRender();
  }

  setTime(t) { this.time = t; this.requestRender(); }

  clear() { this.earth = null; this.air = null; this.requestRender(); }

  /** Heat-loss magnitude of a curve at the current time (for the marker/readout). */
  _lossAt(curve) {
    return curve ? Math.abs(lossAt(curve.mean, curve.harmonics, this.time)) : NaN;
  }

  render() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(this.canvas.clientWidth * dpr);
    const H = Math.round(this.canvas.clientHeight * dpr);
    if (W === 0 || H === 0) return;
    this._sized = true;
    this.canvas.width = W;
    this.canvas.height = H;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (!this.earth) {
      this.header.textContent = 'Annual heat loss — solve to populate';
      this.note.textContent = '';
      return;
    }

    const curves = [this.air, this.earth].filter(Boolean); // air behind earth
    const day = (s) => s / 86400;
    const d1 = day(this.period);

    let vMax = 0;
    for (const c of curves) for (const v of c.phi) vMax = Math.max(vMax, v);
    vMax *= 1.08;

    const m = { l: 54 * dpr, r: 12 * dpr, t: 10 * dpr, b: 26 * dpr };
    const px0 = m.l;
    const px1 = W - m.r;
    const py0 = m.t;
    const py1 = H - m.b;
    const sx = (d) => px0 + (d / (d1 || 1)) * (px1 - px0);
    const sy = (v) => py1 - (v / (vMax || 1)) * (py1 - py0);

    // grid + ticks
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    ctx.fillStyle = '#8a919a';
    ctx.strokeStyle = 'rgba(138,145,154,0.18)';
    ctx.lineWidth = dpr;
    const yStep = niceStep(vMax);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = 0; v <= vMax; v += yStep) {
      const y = sy(v);
      ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke();
      ctx.fillText(v.toFixed(0), px0 - 5 * dpr, y);
    }
    const xStep = niceStep(d1, 6);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let d = 0; d <= d1 + 1e-6; d += xStep) {
      const x = sx(d);
      ctx.beginPath(); ctx.moveTo(x, py0); ctx.lineTo(x, py1); ctx.stroke();
      ctx.fillText(d.toFixed(0), x, py1 + 5 * dpr);
    }
    ctx.fillStyle = '#6b727b';
    ctx.fillText('day of year', (px0 + px1) / 2, H - 13 * dpr);
    ctx.save();
    ctx.translate(11 * dpr, (py0 + py1) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle';
    ctx.fillText('heat loss Φ [W]', 0, 0);
    ctx.restore();

    // shade the earth↔air gap (the reduction the soil buys)
    if (this.air && this.earth) {
      ctx.fillStyle = 'rgba(232,163,61,0.13)';
      ctx.beginPath();
      for (let s = 0; s < N; s++) ctx.lineTo(sx(day(this.air.t[s])), sy(this.air.phi[s]));
      for (let s = N - 1; s >= 0; s--) ctx.lineTo(sx(day(this.earth.t[s])), sy(this.earth.phi[s]));
      ctx.closePath();
      ctx.fill();
    }

    const plot = (curve, color, width, dash) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width * dpr;
      ctx.setLineDash(dash ? dash.map((x) => x * dpr) : []);
      ctx.beginPath();
      for (let s = 0; s < N; s++) {
        const x = sx(day(curve.t[s]));
        const y = sy(curve.phi[s]);
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      // close the year visually
      ctx.lineTo(sx(d1), sy(curve.phi[0]));
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (this.air) plot(this.air, 'rgba(224,83,61,0.85)', 1.6, [5, 4]); // air = exposed (more loss)
    plot(this.earth, '#e8a33d', 2.2); // earth = buried

    // live marker at the current time-of-year
    const tFrac = ((this.time % this.period) + this.period) % this.period;
    const xm = sx(day(tFrac));
    ctx.strokeStyle = 'rgba(207,211,216,0.5)';
    ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(xm, py0); ctx.lineTo(xm, py1); ctx.stroke();

    // readout: mean losses + reduction factor
    const eMean = Math.abs(this.earth.mean);
    if (this.air) {
      const aMean = Math.abs(this.air.mean);
      const factor = aMean > 0 ? eMean / aMean : NaN;
      this.header.textContent = 'Annual heat loss — earth (buried) vs air (exposed)';
      this.note.textContent = `mean: earth ${eMean.toFixed(1)} W · air ${aMean.toFixed(1)} W · `
        + `earth/air = ${factor.toFixed(2)} (soil cuts the loss to ${(factor * 100).toFixed(0)} %)`;
    } else {
      this.header.textContent = 'Annual heat loss Φ(t)';
      this.note.textContent = `mean ${eMean.toFixed(2)} W`;
    }
  }
}
