// PHASOR 1-D line-probe plot (DESIGN §4.3 "instrument, not dashboard"; the
// data side of M4's line probes, pulled forward). Plots temperature vs distance
// along the geometry's primary axis with numbered axes, the static mean profile
// T̄(x), the selected-frequency envelope T̄(x) ± |T̂(x)|, and the live
// single-frequency wave T̄ + Re[T̂ e^{iωt}] sweeping with the time scrubber.
// This is the view that matches the physicist's "exponentially-damped wobbling
// sine" intuition — and the instrument for the M3 basement phase-lag gate.
// Pure-canvas; the sampling helpers are DOM-free and unit-tested.

/** Primary probe axis = the one with the largest physical extent. 0=x,1=y,2=z. */
export function probeAxis(grid) {
  const sx = grid.xs[grid.nx] - grid.xs[0];
  const sy = grid.ys[grid.ny] - grid.ys[0];
  const sz = grid.zs[grid.nz] - grid.zs[0];
  if (sx >= sy && sx >= sz) return 0;
  return sy >= sz ? 1 : 2;
}

/**
 * Node indices and coordinates of the centerline along `axis` (other two axes
 * fixed at their middle index). Pure — unit-tested.
 * @returns {{idx: Int32Array, dist: Float64Array}}
 */
export function lineIndices(grid, axis) {
  const { nx, ny, nz, xs, ys, zs } = grid;
  const sy = nx + 1;
  const sz = (nx + 1) * (ny + 1);
  const mid = (n) => Math.floor(n / 2);
  let len;
  let idx;
  let dist;
  if (axis === 0) {
    const j = mid(ny);
    const k = mid(nz);
    len = nx + 1;
    idx = new Int32Array(len);
    dist = new Float64Array(len);
    for (let i = 0; i < len; i++) { idx[i] = i + sy * j + sz * k; dist[i] = xs[i]; }
  } else if (axis === 1) {
    const i = mid(nx);
    const k = mid(nz);
    len = ny + 1;
    idx = new Int32Array(len);
    dist = new Float64Array(len);
    for (let j = 0; j < len; j++) { idx[j] = i + sy * j + sz * k; dist[j] = ys[j]; }
  } else {
    const i = mid(nx);
    const j = mid(ny);
    len = nz + 1;
    idx = new Int32Array(len);
    dist = new Float64Array(len);
    for (let k = 0; k < len; k++) { idx[k] = i + sy * j + sz * k; dist[k] = zs[k]; }
  }
  return { idx, dist };
}

const AXIS_NAME = ['x', 'y (depth)', 'z'];

/**
 * Serialize a line-probe profile to CSV (M4 export). Pure — DOM-free, unit-tested.
 * Columns: distance [m], mean T̄ [°C], then per harmonic Re, Im, |T̂| [K]. The
 * caller passes the same line-sampled arrays the plot draws, so the file matches
 * the picture exactly (mean profile + the phasor that the scrubber animates).
 * @param {string} axisName label for the distance column (e.g. 'y (depth)')
 * @param {ArrayLike<number>} dist distances along the line [m]
 * @param {ArrayLike<number>} meanV T̄ along the line
 * @param {{f: string, re: ArrayLike<number>, im: ArrayLike<number>}[]} harmonics
 * @returns {string} CSV text (header row + one row per sample, '\n'-joined)
 */
export function lineProbeCSV(axisName, dist, meanV, harmonics = []) {
  const header = [`${axisName} [m]`, 'T_mean [C]'];
  for (const h of harmonics) {
    header.push(`${h.f}_Re [K]`, `${h.f}_Im [K]`, `${h.f}_amp [K]`);
  }
  const fmt = (v) => (Number.isFinite(v) ? String(v) : '');
  const rows = [header.join(',')];
  for (let s = 0; s < dist.length; s++) {
    const row = [fmt(dist[s]), fmt(meanV[s])];
    for (const h of harmonics) {
      const re = h.re[s];
      const im = h.im[s];
      row.push(fmt(re), fmt(im), fmt(Math.hypot(re, im)));
    }
    rows.push(row.join(','));
  }
  return rows.join('\n');
}

/** "Nice" tick step covering `range` with ~target ticks: {1,2,5}·10^m. */
function niceStep(range, target = 6) {
  const raw = range / Math.max(target, 1);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class LineProbe {
  /** @param {HTMLElement} container */
  constructor(container) {
    container.textContent = '';
    this.header = el('div', 'slice-header', 'Line probe');
    this.canvas = el('canvas', 'slice-canvas');
    container.append(this.header, this.canvas);

    this.model = null;
    this.axis = 1;
    this.dist = null;     // distances along the line [m]
    this.meanV = null;    // T̄ along the line
    this.lineHarm = [];   // [{ omega, re, im }] sampled along the line
    this.sel = null;      // selected-frequency samples for envelope + wave
    this.envAmp = null;   // |T̂_sel| along the line
    this.freqOmega = null;
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

  setModel(model) {
    this.model = model;
    this.axis = probeAxis(model.grid);
    this.dist = null;
    this.meanV = null;
    this.lineHarm = [];
    this.sel = null;
    this.envAmp = null;
    this.requestRender();
  }

  /** @param {{mean: Float64Array, harmonics: {f,omega,re,im}[]}} sol */
  setSolution({ mean, harmonics }) {
    const { idx, dist } = lineIndices(this.model.grid, this.axis);
    this.dist = dist;
    this.meanV = new Float64Array(idx.length);
    for (let s = 0; s < idx.length; s++) this.meanV[s] = mean[idx[s]];
    this.lineHarm = (harmonics ?? []).map((h) => {
      const re = new Float64Array(idx.length);
      const im = new Float64Array(idx.length);
      for (let s = 0; s < idx.length; s++) { re[s] = h.re[idx[s]]; im[s] = h.im[idx[s]]; }
      return { f: h.f, omega: h.omega, re, im };
    });
    if (this.freqOmega == null && this.lineHarm.length) this.freqOmega = this.lineHarm[0].omega;
    this._selectFreq();
    this.requestRender();
  }

  /** CSV of the current profile (mean + all sampled harmonics), or null if empty. */
  toCSV() {
    if (!this.meanV) return null;
    return lineProbeCSV(AXIS_NAME[this.axis], this.dist, this.meanV, this.lineHarm);
  }

  setFreq(omega) { this.freqOmega = omega; this._selectFreq(); this.requestRender(); }

  setTime(t) { this.time = t; this.requestRender(); }

  clear() {
    this.dist = null;
    this.meanV = null;
    this.lineHarm = [];
    this.sel = null;
    this.requestRender();
  }

  _selectFreq() {
    if (!this.lineHarm.length) { this.sel = null; this.envAmp = null; return; }
    this.sel = this.lineHarm.find((h) => h.omega === this.freqOmega) ?? this.lineHarm[0];
    const n = this.sel.re.length;
    this.envAmp = new Float64Array(n);
    for (let s = 0; s < n; s++) this.envAmp[s] = Math.hypot(this.sel.re[s], this.sel.im[s]);
  }

  render() {
    if (!this.model) return;
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

    const freqName = this.sel ? this.sel.f : '—';
    this.header.textContent = this.meanV
      ? `Profile along ${AXIS_NAME[this.axis]} — ${freqName} wave (scrub to animate)`
      : 'Line probe — solve to populate';
    if (!this.meanV) return;

    const m = { l: 52 * dpr, r: 12 * dpr, t: 10 * dpr, b: 26 * dpr };
    const px0 = m.l;
    const px1 = W - m.r;
    const py0 = m.t;
    const py1 = H - m.b;

    // data ranges
    const d0 = this.dist[0];
    const d1 = this.dist[this.dist.length - 1];
    let vMin = Infinity;
    let vMax = -Infinity;
    for (let s = 0; s < this.meanV.length; s++) {
      const a = this.envAmp ? this.envAmp[s] : 0;
      vMin = Math.min(vMin, this.meanV[s] - a);
      vMax = Math.max(vMax, this.meanV[s] + a);
    }
    if (!(vMax > vMin)) { vMax = vMin + 1; vMin -= 1; }
    const pad = (vMax - vMin) * 0.08;
    vMin -= pad;
    vMax += pad;

    const sx = (d) => px0 + ((d - d0) / (d1 - d0 || 1)) * (px1 - px0);
    const sy = (v) => py1 - ((v - vMin) / (vMax - vMin)) * (py1 - py0);

    // grid + ticks
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    ctx.fillStyle = '#8a919a';
    ctx.strokeStyle = 'rgba(138,145,154,0.18)';
    ctx.lineWidth = dpr;
    const yStep = niceStep(vMax - vMin);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(vMin / yStep) * yStep; v <= vMax; v += yStep) {
      const y = sy(v);
      ctx.beginPath();
      ctx.moveTo(px0, y);
      ctx.lineTo(px1, y);
      ctx.stroke();
      ctx.fillText(v.toFixed(1), px0 - 5 * dpr, y);
    }
    const xStep = niceStep(d1 - d0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let d = Math.ceil(d0 / xStep) * xStep; d <= d1 + 1e-9; d += xStep) {
      const x = sx(d);
      ctx.beginPath();
      ctx.moveTo(x, py0);
      ctx.lineTo(x, py1);
      ctx.stroke();
      ctx.fillText(d.toFixed(d1 - d0 < 1 ? 2 : 1), x, py1 + 5 * dpr);
    }
    // axis titles
    ctx.fillStyle = '#6b727b';
    ctx.fillText(`${AXIS_NAME[this.axis]} [m]`, (px0 + px1) / 2, H - 13 * dpr);
    ctx.save();
    ctx.translate(11 * dpr, (py0 + py1) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle';
    ctx.fillText('T [°C]', 0, 0);
    ctx.restore();

    const plotLine = (fn, color, width, dash) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width * dpr;
      ctx.setLineDash(dash ? dash.map((x) => x * dpr) : []);
      ctx.beginPath();
      for (let s = 0; s < this.dist.length; s++) {
        const x = sx(this.dist[s]);
        const y = sy(fn(s));
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };

    // envelope T̄ ± |T̂|, mean T̄, then the live wave
    if (this.envAmp) {
      plotLine((s) => this.meanV[s] + this.envAmp[s], 'rgba(232,163,61,0.45)', 1, [5, 4]);
      plotLine((s) => this.meanV[s] - this.envAmp[s], 'rgba(232,163,61,0.45)', 1, [5, 4]);
    }
    plotLine((s) => this.meanV[s], 'rgba(138,145,154,0.7)', 1, [2, 3]);
    if (this.sel) {
      const c = Math.cos(this.sel.omega * this.time);
      const sn = Math.sin(this.sel.omega * this.time);
      plotLine((s) => this.meanV[s] + this.sel.re[s] * c - this.sel.im[s] * sn, '#e8a33d', 2.2);
    }
  }
}
