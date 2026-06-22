// PHASOR 2D slice panel (DESIGN.md §4.1 decision 5): plain-canvas rendering of
// the nodal field — the primary instrument through M3. M1: steady temperature.
// M2 adds harmonic field modes (instantaneous T(t), amplitude |T̂|, phase-lag τ)
// and the time scrubber, all evaluated client-side by superposition — never a
// re-solve (DESIGN §3.5). Shows the material map until a field arrives.
import { cellIndex, nodeIndex } from './grid.mjs';
import { amplitude, timeLagRelative } from './physics.mjs';
import { diverging, sequential, flux as fluxCm } from './colormap.mjs';
import { cellFlux, cellFluxComplex, fluxGlyphs } from './flux.mjs';

// Heat-flow glyphs: aim for ~this many arrows across the wider grid axis; the
// sampling stride is derived from it so dense and coarse grids both read as a
// legible vector field rather than a uniform texture of tiny marks.
const GLYPH_TARGET = 14;

// Phase-lag map: nodes whose amplitude is below this fraction of the peak amp
// carry no meaningful phase (|T̂|→0 ⇒ arg is numerical noise). Mask them so the
// deep, near-zero interior doesn't blow out the color scale (e.g. >½ of the
// diurnal corner2d domain is dead) and hide the real near-surface gradient.
const PHASE_AMP_FLOOR = 0.02;

// marching-squares segment table; edges E0 bottom, E1 right, E2 top, E3 left,
// corner bits c0 bl, c1 br, c2 tr, c3 tl (ambiguous 5/10 → two segments)
const SEGS = [
  [], [[3, 0]], [[0, 1]], [[3, 1]],
  [[1, 2]], [[3, 0], [1, 2]], [[0, 2]], [[3, 2]],
  [[2, 3]], [[0, 2]], [[0, 1], [2, 3]], [[1, 2]],
  [[1, 3]], [[0, 1]], [[3, 0]], [],
];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** "Nice" isoline step covering `range` with ~target lines: {1,2,5}·10^m. */
function niceStep(range, target = 10) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

export class SlicePanel {
  /** @param {HTMLElement} container */
  constructor(container) {
    container.textContent = '';
    this.header = el('div', 'slice-header', 'XY slice');
    this.note = el('div', 'slice-note', '');
    this.canvas = el('canvas', 'slice-canvas');
    this.barCanvas = el('canvas', 'slice-bar');
    this.barMin = el('span', 'slice-bar-label', '');
    this.barMax = el('span', 'slice-bar-label', '');
    const barRow = el('div', 'slice-bar-row');
    barRow.append(this.barMin, this.barCanvas, this.barMax);
    container.append(this.header, this.canvas, barRow, this.note);

    this.model = null; // { grid, painted, materials }
    this.T = null;     // nodal Float64Array currently displayed
    this.range = null; // [min, max] over solid-cell nodes
    // Heat-flow (|q|) mode state (S2-M1.2). `cellField` is a per-cell scalar
    // (|q_xy|) rendered cell-wise instead of the nodal path; `_cellLambda` lets
    // us recover q = −λ∇T client-side from the model alone (no worker change);
    // `_fluxRange` is the FIXED time-invariant |q| scale (envelope bound), so
    // scrubbing breathes the arrows/colours without moving the colour scale.
    this.cellField = null;
    this._cellLambda = null;
    this._fluxRange = null;
    this._fluxQ = null;  // last recovered flux (for the glyph overlay)
    this.glyphs = false; // flow-arrow overlay on/off
    // 3D field plane mirrors a NODAL field; in |q| mode it shows the
    // instantaneous T(t) (the 3D channel stays temperature) — kept here so the
    // 2D panel can paint |q| while the 3D model keeps a meaningful field.
    this._emitOverride = null;
    this._xform = null; // last render transform, for the proof harness pixelOf
    // T(t) mode: a FIXED color range over the field's full temporal envelope
    // (T̄ ± Σ|T̂|), so a node keeps its colour as the scrubber sweeps — only the
    // pattern moves, not the scale. Recomputed on solve / freq-toggle, never on
    // a scrub tick. Amplitude / phase modes are already time-invariant.
    this._instantRange = null;
    this.frac = 0.5;   // slice position along z, fraction of extent
    this._sized = false; // has the canvas ever rendered at a real size?

    // Harmonic solution + display state (M2). `mean` is the steady field T̄;
    // `harmonics` is [{ f, omega, re, im }]. The displayed field is derived
    // from these by superposition — changing mode/time never re-solves.
    this.mean = null;
    this.harmonics = [];
    this.mode = 'instant';   // 'instant' (T(t)) | 'amplitude' | 'phase'
    this.enabled = new Set(['annual', 'diurnal']); // freqs summed into T(t)
    this.freqOmega = null;   // selected frequency for amplitude / phase modes
    this.time = 0;           // scrubber time, seconds
    this.unit = '°C';
    this._cm = diverging;    // active colormap
    this._field = 'materials'; // header label for the current field

    // M4: mirror the displayed field onto the in-scene 3D plane. Fired whenever
    // the field (or slice position) changes — including every scrub tick — with
    // { T, range, cm, frac }. index.html forwards it to Viz3D.setFieldSlice.
    this.onFieldUpdate = null;

    // Rendering triggers. ResizeObserver alone is not enough: if the panel is
    // first laid out at 0×0 (tab restored, DevTools open then closed, tiling
    // WM, a collapsed flex item) its callback can be missed, leaving the canvas
    // at its default size and blank. Back it with a window-resize listener and
    // a short rAF kick that retries until the canvas first gets a real size.
    new ResizeObserver(() => this.requestRender()).observe(this.canvas);
    window.addEventListener('resize', () => this.requestRender());
  }

  /** Render now; if the canvas has no size yet, keep retrying on frames. */
  requestRender(framesLeft = 120) {
    this.render();
    if (!this._sized && framesLeft > 0) {
      requestAnimationFrame(() => this.requestRender(framesLeft - 1));
    }
  }

  /** Notify the 3D field plane of the current displayed field / slice position. */
  _emitField() {
    if (!this.onFieldUpdate) return;
    // |q| mode paints a cell field the 3D plane can't take, so it overrides the
    // emit with the nodal T(t); other modes mirror the display directly.
    const e = this._emitOverride;
    if (e) this.onFieldUpdate({ T: e.T, range: e.range, cm: e.cm, frac: this.frac });
    else this.onFieldUpdate({ T: this.T, range: this.range, cm: this._cm, frac: this.frac });
  }

  /** Per-cell λ from the model (materials[id].lambda), void → 0. For client-side
   *  flux recovery q = −λ∇T without a worker round-trip. */
  _buildCellLambda() {
    const { grid, painted, materials } = this.model;
    const n = grid.nx * grid.ny * grid.nz;
    const cl = new Float64Array(n);
    for (let c = 0; c < n; c++) {
      const m = materials[painted.matIds[painted.cells[c]]];
      cl[c] = m ? (m.lambda || 0) : 0;
    }
    this._cellLambda = cl;
  }

  setModel(model) {
    this.model = model;
    this.T = null;
    this.range = null;
    this._instantRange = null;
    this.cellField = null;
    this._fluxRange = null;
    this._emitOverride = null;
    this.mean = null;
    this.harmonics = [];
    this._field = 'materials';
    this._buildCellLambda();
    this.requestRender();
    this._emitField();
  }

  /** [min, max] of `values` over nodes touching a solid cell. */
  rangeOverSolid(values) {
    const { grid, painted, materials } = this.model;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < grid.nz; k++) {
      for (let j = 0; j < grid.ny; j++) {
        for (let i = 0; i < grid.nx; i++) {
          if (!materials[painted.matIds[painted.cells[cellIndex(grid, i, j, k)]]]) continue;
          for (let a = 0; a < 8; a++) {
            const v = values[nodeIndex(grid, i + (a & 1), j + ((a >> 1) & 1), k + ((a >> 2) & 1))];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
    }
    return hi > lo ? [lo, hi] : [lo - 0.5, lo + 0.5];
  }

  /**
   * Fixed T(t) color range over the temporal envelope T̄ ± Σ_enabled|T̂_k| at
   * every solid node (physics.instantRange per node). Time-invariant by
   * construction; recompute only when the solution or the enabled-harmonic set
   * changes, so scrubbing never moves the scale.
   */
  _computeInstantRange() {
    if (!this.mean) { this._instantRange = null; return; }
    const n = this.mean.length;
    const hs = this.harmonics.filter((h) => this.enabled.has(h.f));
    const eMin = new Float64Array(n);
    const eMax = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const h of hs) sum += Math.hypot(h.re[i], h.im[i]);
      eMin[i] = this.mean[i] - sum;
      eMax[i] = this.mean[i] + sum;
    }
    this._instantRange = [this.rangeOverSolid(eMin)[0], this.rangeOverSolid(eMax)[1]];
  }

  /**
   * Fixed |q| colour scale for the heat-flow mode — time-invariant so scrubbing
   * brightens/dims the field without moving the scale (the D1 principle, applied
   * to flux). The scale is the STEADY in-plane flux magnitude max over solid
   * cells: the heat-flow story is the steady thermal bridge, and pinning to it
   * lets that pattern fill the ramp while the harmonic breathing reads as
   * brightening around it (peaks clamp to the hot end). For presets with no
   * steady flux (e.g. a soil column at T_mean, |q̄|≈0) fall back to the harmonic
   * oscillation-amplitude bound so the panel isn't black. Recompute only on
   * solve / enabled-harmonic change.
   */
  _computeFluxRange() {
    if (!this.mean || !this._cellLambda) { this._fluxRange = null; return; }
    const probe = { grid: this.model.grid, cellLambda: this._cellLambda };
    const qm = cellFlux(probe, this.mean);
    const hs = this.harmonics.filter((h) => this.enabled.has(h.f))
      .map((h) => cellFluxComplex(probe, h.re, h.im));
    const steady = [];
    const harm = [];
    for (let c = 0; c < this._cellLambda.length; c++) {
      if (this._cellLambda[c] === 0) continue;
      steady.push(Math.hypot(qm.qx[c], qm.qy[c]));
      let ex = 0;
      let ey = 0;
      for (const qh of hs) {
        ex += Math.hypot(qh.qxRe[c], qh.qxIm[c]);
        ey += Math.hypot(qh.qyRe[c], qh.qyIm[c]);
      }
      harm.push(Math.hypot(ex, ey));
    }
    // Robust 99th-percentile rather than the raw max: a re-entrant corner is a
    // flux-concentration singularity whose single hottest cell is mesh-dependent
    // and would compress the whole field into the dark end. Clipping it lets the
    // bulk field fill the ramp; the bridge then saturates to the hot colour —
    // which is exactly the "heat concentrates here" reading we want.
    const pct = (arr, p) => {
      if (!arr.length) return 0;
      const s = arr.slice().sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
    };
    const steadyP = pct(steady, 0.99);
    const harmP = pct(harm, 0.99);
    const max = steadyP > 1e-6 * harmP ? steadyP : harmP;
    this._fluxRange = [0, max > 0 ? max : 1];
  }

  /**
   * M1 / steady path: display a plain nodal temperature field directly.
   * @param {Float64Array} T nodal field for the CURRENT model's grid
   */
  setField(T) {
    this.mean = T;
    this.harmonics = [];
    this.mode = 'instant';
    this.time = 0;
    this._field = 'T [°C]';
    this.unit = '°C';
    this._cm = diverging;
    this.T = T;
    this.range = this.rangeOverSolid(T);
    this._instantRange = this.range; // no harmonics → envelope is just the field
    this.cellField = null;
    this._emitOverride = null;
    this._computeFluxRange();
    this.note.textContent = '';
    this.requestRender();
    this._emitField();
  }

  /**
   * M2 path: store the mean field + harmonic phasors, then derive the displayed
   * field from the current mode/time. `harmonics`: [{ f, omega, re, im }].
   */
  setSolution({ mean, harmonics }) {
    this.mean = mean;
    this.harmonics = harmonics ?? [];
    if (this.freqOmega == null && this.harmonics.length) {
      this.freqOmega = this.harmonics[0].omega;
    }
    this.note.textContent = '';
    this._computeInstantRange();
    this._computeFluxRange();
    this._recompute();
  }

  setMode(mode) { this.mode = mode; this._recompute(); }

  /** Toggle the heat-flow vector-glyph overlay (|q| mode only). */
  setGlyphs(on) { this.glyphs = !!on; this.requestRender(); }

  /** Toggle whether a frequency (by id, e.g. 'annual') is summed into T(t). */
  setEnabled(freq, on) {
    if (on) this.enabled.add(freq); else this.enabled.delete(freq);
    this._computeInstantRange(); // the envelope depends on which harmonics sum in
    this._computeFluxRange();    // …and so does the |q| scale
    this._recompute();
  }

  setFreq(omega) { this.freqOmega = omega; this._recompute(); }

  setTime(t) { this.time = t; this._recompute(); }

  /** Instantaneous nodal field T(t) = T̄ + Σ_k [Re(T̂_k)cos(ω_k t) −
   *  Im(T̂_k)sin(ω_k t)] (DESIGN §2.5), summing only the enabled harmonics.
   *  Shared by the T(t) display and the heat-flow (|q|) recovery. */
  _instantField() {
    const n = this.mean.length;
    const vals = new Float64Array(n);
    const cs = this.harmonics
      .filter((h) => this.enabled.has(h.f))
      .map((h) => ({
        re: h.re, im: h.im, c: Math.cos(h.omega * this.time), s: Math.sin(h.omega * this.time),
      }));
    for (let i = 0; i < n; i++) {
      let v = this.mean[i];
      for (const h of cs) v += h.re[i] * h.c - h.im[i] * h.s;
      vals[i] = v;
    }
    return vals;
  }

  /** Derive the displayed field (values, unit, colormap, header) from state. */
  _recompute() {
    if (!this.mean) {
      this.T = null; this.range = null; this.cellField = null;
      this._emitOverride = null; this.requestRender(); this._emitField(); return;
    }

    // Heat-flow |q| mode (S2-M1.2): recover q = −λ∇T(t) at cell centres from the
    // instantaneous field — purely on the scrub path, never a re-solve. The 2D
    // panel paints the per-cell magnitude with the heat ramp; the 3D plane keeps
    // the nodal T(t) (emit override). Stable colour scale = the fixed envelope.
    if (this.mode === 'flux') {
      const vals = this._instantField();
      const q = cellFlux({ grid: this.model.grid, cellLambda: this._cellLambda }, vals);
      const mag = new Float64Array(q.qx.length);
      for (let c = 0; c < mag.length; c++) {
        mag[c] = this._cellLambda[c] === 0 ? NaN : Math.hypot(q.qx[c], q.qy[c]);
      }
      this.cellField = mag;
      this._fluxQ = q;
      this.T = vals; // retained for the 3D emit override
      if (!this._fluxRange) this._computeFluxRange();
      this.range = this._fluxRange;
      this._cm = fluxCm;
      this.unit = 'W/m²';
      this._field = 'Heat flow |q| [W/m²]';
      this._emitOverride = {
        T: vals, cm: diverging,
        range: this._instantRange ?? this.rangeOverSolid(vals),
      };
      this.requestRender();
      this._emitField();
      return;
    }

    // nodal modes (T(t), amplitude, phase) — no cell field, no emit override
    this.cellField = null;
    this._emitOverride = null;
    const n = this.mean.length;
    const vals = new Float64Array(n);
    if (this.mode === 'instant') {
      const inst = this._instantField();
      vals.set(inst);
      this.unit = '°C';
      this._cm = diverging;
      this._field = 'T(t) [°C]';
    } else {
      const h = this.harmonics.find((x) => x.omega === this.freqOmega) ?? this.harmonics[0];
      this._cm = sequential;
      if (!h) {
        for (let i = 0; i < n; i++) vals[i] = 0;
        this.unit = '';
        this._field = `${this.mode} (no harmonic)`;
      } else if (this.mode === 'amplitude') {
        for (let i = 0; i < n; i++) vals[i] = amplitude(h.re[i], h.im[i]);
        this.unit = 'K';
        this._field = `amplitude |T̂| [K] — ${h.f}`;
      } else { // phase lag, referenced to the outdoor forcing (surface ≈ 0)
        const period = (2 * Math.PI) / h.omega;
        const toUnit = period > 2 * 86400 ? 86400 : 3600; // days for annual, hours for diurnal
        const ul = toUnit === 86400 ? 'days' : 'hours';
        const refPhase = Math.atan2(h.refIm ?? 0, h.refRe ?? 1);
        // mask low-amplitude nodes (NaN) — their phase is meaningless noise
        const amp = new Float64Array(n);
        for (let i = 0; i < n; i++) amp[i] = amplitude(h.re[i], h.im[i]);
        const floor = PHASE_AMP_FLOOR * this.rangeOverSolid(amp)[1];
        for (let i = 0; i < n; i++) {
          vals[i] = amp[i] < floor
            ? NaN
            : timeLagRelative(h.re[i], h.im[i], h.omega, refPhase) / toUnit;
        }
        this.unit = ul;
        this._field = `phase lag τ [${ul}] vs outdoor — ${h.f}`;
      }
    }
    this.T = vals;
    if (this.mode === 'instant') {
      // fixed envelope range — stable across scrub time (computed on solve)
      if (!this._instantRange) this._computeInstantRange();
      this.range = this._instantRange;
    } else {
      // amplitude / phase: time-invariant already, scale to the field itself
      this.range = this.rangeOverSolid(vals);
    }
    this.requestRender();
    this._emitField();
  }

  clearField(message = '') {
    this.T = null;
    this.range = null;
    this._instantRange = null;
    this.cellField = null;
    this._fluxRange = null;
    this._fluxQ = null;
    this._emitOverride = null;
    this.mean = null;
    this.harmonics = [];
    this._field = 'materials';
    this.note.textContent = message;
    this.requestRender();
    this._emitField();
  }

  setSlice(frac) {
    this.frac = Math.min(1, Math.max(0, frac));
    this.requestRender();
    this._emitField();
  }

  render() {
    if (!this.model) return;
    const { grid, painted, materials } = this.model;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(this.canvas.clientWidth * dpr);
    const H = Math.round(this.canvas.clientHeight * dpr);
    if (W === 0 || H === 0) return;
    this._sized = true; // a real size reached — the rAF kick can stand down
    this.canvas.width = W;
    this.canvas.height = H;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const { xs, ys, zs, nx, ny, nz } = grid;
    const xmin = xs[0];
    const ymin = ys[0];
    const spanX = xs[nx] - xmin;
    const spanY = ys[ny] - ymin;
    const scale = Math.min(W / spanX, H / spanY);
    const ox = (W - scale * spanX) / 2;
    const oy = (H - scale * spanY) / 2;
    const pxOf = (x) => ox + (x - xmin) * scale;
    const pyOf = (y) => H - oy - (y - ymin) * scale;
    // publish the transform so the proof harness can map physical → device px
    this._xform = { scale, ox, oy, xmin, ymin, H };

    // slice planes: nearest node plane for the field, adjacent cell layer for materials
    const zCoord = zs[0] + this.frac * (zs[nz] - zs[0]);
    let kNode = 0;
    for (let k = 1; k <= nz; k++) {
      if (Math.abs(zs[k] - zCoord) < Math.abs(zs[kNode] - zCoord)) kNode = k;
    }
    const kCell = Math.min(kNode, nz - 1);
    this.header.textContent =
      `XY slice — z = ${zs[kNode].toFixed(3)} m — ${this.T ? this._field : 'materials'}`;

    // pixel → cell column/row lookup
    const colCell = new Int32Array(W).fill(-1);
    for (let p = 0, i = 0; p < W; p++) {
      const x = xmin + (p + 0.5 - ox) / scale;
      if (x < xmin || x > xs[nx]) continue;
      while (i < nx - 1 && x > xs[i + 1]) i++;
      while (i > 0 && x < xs[i]) i--;
      colCell[p] = i;
    }
    const rowCell = new Int32Array(H).fill(-1);
    for (let p = 0, j = 0; p < H; p++) {
      const y = ymin + (H - p - 0.5 - oy) / scale;
      if (y < ymin || y > ys[ny]) continue;
      while (j < ny - 1 && y > ys[j + 1]) j++;
      while (j > 0 && y < ys[j]) j--;
      rowCell[p] = j;
    }

    const img = ctx.createImageData(W, H);
    const data = img.data;
    const [lo, hi] = this.range ?? [0, 1];
    const inv = 1 / (hi - lo);

    for (let p = 0; p < H; p++) {
      const j = rowCell[p];
      if (j < 0) continue;
      const y = ymin + (H - p - 0.5 - oy) / scale;
      const ty = (y - ys[j]) / (ys[j + 1] - ys[j]);
      for (let q = 0; q < W; q++) {
        const i = colCell[q];
        if (i < 0) continue;
        const mat = materials[painted.matIds[painted.cells[cellIndex(grid, i, j, kCell)]]];
        if (!mat) continue; // void — panel background
        let r;
        let g;
        let b;
        let v;
        if (this.cellField) {
          // heat-flow |q|: a per-cell scalar, painted cell-wise (no interpolation)
          v = this.cellField[cellIndex(grid, i, j, kCell)];
        } else if (this.T) {
          const x = xmin + (q + 0.5 - ox) / scale;
          const tx = (x - xs[i]) / (xs[i + 1] - xs[i]);
          const v00 = this.T[nodeIndex(grid, i, j, kNode)];
          const v10 = this.T[nodeIndex(grid, i + 1, j, kNode)];
          const v01 = this.T[nodeIndex(grid, i, j + 1, kNode)];
          const v11 = this.T[nodeIndex(grid, i + 1, j + 1, kNode)];
          v = (1 - ty) * ((1 - tx) * v00 + tx * v10) + ty * ((1 - tx) * v01 + tx * v11);
        }
        if ((this.cellField || this.T) && Number.isFinite(v)) {
          [r, g, b] = this._cm((v - lo) * inv);
        } else {
          // no field, or a masked (phase-undefined) node: show the material color
          const c = mat.color ?? 0x808080;
          r = (c >> 16) & 255;
          g = (c >> 8) & 255;
          b = c & 255;
        }
        const o = 4 * (p * W + q);
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // nodal modes get isolines; heat-flow mode gets direction glyphs instead
    if (this.cellField) {
      if (this.glyphs) this.drawGlyphs(ctx, kCell, pxOf, pyOf, scale);
    } else if (this.T) {
      this.drawIsolines(ctx, kNode, kCell, pxOf, pyOf);
    }
    this.drawColorbar();
  }

  /** Map a physical (x, y) on the slice plane to device-pixel canvas coords.
   *  Used by the proof harness (slices.pixelOf) to place sample boxes. */
  pixelOf(x, y) {
    const t = this._xform;
    if (!t) return { x: 0, y: 0 };
    return {
      x: Math.round(t.ox + (x - t.xmin) * t.scale),
      y: Math.round(t.H - t.oy - (y - t.ymin) * t.scale),
    };
  }

  /** Heat-flow vector glyphs: arrows along the in-plane flux direction (−∇T),
   *  length ∝ clamped |q|, scaled by the fixed |q| envelope so they breathe with
   *  the scrubber without rescaling. Drawn with a dark halo + light core so they
   *  read on both the dark (low-|q|) and pale (high-|q|) ends of the ramp. */
  drawGlyphs(ctx, kCell, pxOf, pyOf, scale) {
    if (!this._fluxQ) return;
    const { grid } = this.model;
    const stride = Math.max(1, Math.round(Math.max(grid.nx, grid.ny) / GLYPH_TARGET));
    const sc = this.range ? this.range[1] : undefined; // envelope max → temporal stability
    const { glyphs } = fluxGlyphs(this._fluxQ, grid, kCell, { stride, scale: sc });
    if (!glyphs.length) return;

    const dpr = window.devicePixelRatio || 1;
    const meanCell = Math.min((grid.xs[grid.nx] - grid.xs[0]) / grid.nx,
      (grid.ys[grid.ny] - grid.ys[0]) / grid.ny);
    const boxPx = stride * scale * meanCell; // spacing between glyph centres, px
    const maxLen = Math.max(8 * dpr, 0.45 * boxPx); // longest arrow in px

    const drawPass = (style, width) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const gph of glyphs) {
        const cx = pxOf(gph.x);
        const cy = pyOf(gph.y);
        const L = gph.len * maxLen;
        if (L < 1) continue;
        const dx = gph.ux * L;
        const dy = -gph.uy * L; // screen y is flipped relative to physical y
        const hx = cx + dx / 2;
        const hy = cy + dy / 2;
        const tx = cx - dx / 2;
        const ty = cy - dy / 2;
        ctx.moveTo(tx, ty);
        ctx.lineTo(hx, hy);
        // arrowhead: two short barbs at ±150° from the shaft direction
        const a = Math.atan2(dy, dx);
        const hl = Math.min(6 * dpr, 0.4 * L);
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - hl * Math.cos(a - 0.5), hy - hl * Math.sin(a - 0.5));
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - hl * Math.cos(a + 0.5), hy - hl * Math.sin(a + 0.5));
      }
      ctx.stroke();
    };
    drawPass('rgba(14, 16, 19, 0.85)', 3 * dpr); // dark halo
    drawPass('rgba(244, 246, 250, 0.95)', 1.4 * dpr); // light core
  }

  drawIsolines(ctx, kNode, kCell, pxOf, pyOf) {
    const { grid, painted, materials } = this.model;
    const { xs, ys, nx, ny } = grid;
    const [lo, hi] = this.range;
    const step = niceStep(hi - lo);
    const first = Math.ceil(lo / step) * step;

    ctx.strokeStyle = 'rgba(14, 16, 19, 0.55)';
    ctx.lineWidth = Math.max(1, (window.devicePixelRatio || 1));
    for (let L = first; L <= hi; L += step) {
      ctx.beginPath();
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          if (!materials[painted.matIds[painted.cells[cellIndex(grid, i, j, kCell)]]]) continue;
          const v = [
            this.T[nodeIndex(grid, i, j, kNode)],      // c0 bl
            this.T[nodeIndex(grid, i + 1, j, kNode)],  // c1 br
            this.T[nodeIndex(grid, i + 1, j + 1, kNode)], // c2 tr
            this.T[nodeIndex(grid, i, j + 1, kNode)],  // c3 tl
          ];
          // skip cells touching a masked (phase-undefined) node — no real contour
          if (!(Number.isFinite(v[0]) && Number.isFinite(v[1])
                && Number.isFinite(v[2]) && Number.isFinite(v[3]))) continue;
          const idx = (v[0] >= L ? 1 : 0) | (v[1] >= L ? 2 : 0) |
                      (v[2] >= L ? 4 : 0) | (v[3] >= L ? 8 : 0);
          const segs = SEGS[idx];
          if (segs.length === 0) continue;
          const x0 = xs[i];
          const x1 = xs[i + 1];
          const y0 = ys[j];
          const y1 = ys[j + 1];
          // edge → point: E0 bottom c0→c1, E1 right c1→c2, E2 top c3→c2, E3 left c0→c3
          const pt = (e) => {
            let va;
            let vb;
            switch (e) {
              case 0: va = v[0]; vb = v[1]; break;
              case 1: va = v[1]; vb = v[2]; break;
              case 2: va = v[3]; vb = v[2]; break;
              default: va = v[0]; vb = v[3];
            }
            const d = vb - va;
            const t = d !== 0 ? (L - va) / d : 0.5;
            switch (e) {
              case 0: return [pxOf(x0 + t * (x1 - x0)), pyOf(y0)];
              case 1: return [pxOf(x1), pyOf(y0 + t * (y1 - y0))];
              case 2: return [pxOf(x0 + t * (x1 - x0)), pyOf(y1)];
              default: return [pxOf(x0), pyOf(y0 + t * (y1 - y0))];
            }
          };
          for (const [ea, eb] of segs) {
            const [ax, ay] = pt(ea);
            const [bx, by] = pt(eb);
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
          }
        }
      }
      ctx.stroke();
    }
  }

  drawColorbar() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(this.barCanvas.clientWidth * dpr));
    const H = Math.max(1, Math.round(this.barCanvas.clientHeight * dpr));
    this.barCanvas.width = W;
    this.barCanvas.height = H;
    const ctx = this.barCanvas.getContext('2d');
    if (!this.range) {
      this.barMin.textContent = '';
      this.barMax.textContent = '';
      return;
    }
    const img = ctx.createImageData(W, H);
    for (let q = 0; q < W; q++) {
      const [r, g, b] = this._cm(q / (W - 1));
      for (let p = 0; p < H; p++) {
        const o = 4 * (p * W + q);
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const u = this.unit ? ` ${this.unit}` : '';
    this.barMin.textContent = `${this.range[0].toFixed(2)}${u}`;
    this.barMax.textContent = `${this.range[1].toFixed(2)}${u}`;
  }
}
