// PHASOR 2D slice panel (DESIGN.md §4.1 decision 5): plain-canvas rendering of
// the nodal temperature field — the primary instrument through M3. M1 scope:
// one XY panel with a z-position slider, filled colormap, isolines, colorbar.
// Shows the material map until a field arrives ("look before you solve").
import { cellIndex, nodeIndex } from './grid.mjs';

// compact coolwarm-style diverging map: cold blue → neutral → warm red
const STOPS = [
  [59, 76, 192],
  [221, 221, 221],
  [180, 4, 38],
];

function colormap(t) {
  const s = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const seg = s < 0.5 ? 0 : 1;
  const f = (s - seg * 0.5) * 2;
  const a = STOPS[seg];
  const b = STOPS[seg + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

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
    this.T = null;     // nodal Float64Array
    this.range = null; // [min, max] over solid-cell nodes
    this.frac = 0.5;   // slice position along z, fraction of extent
    this._sized = false; // has the canvas ever rendered at a real size?

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

  setModel(model) {
    this.model = model;
    this.T = null;
    this.range = null;
    this.requestRender();
  }

  /** @param {Float64Array} T nodal field for the CURRENT model's grid */
  setField(T) {
    this.T = T;
    const { grid, painted, materials } = this.model;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < grid.nz; k++) {
      for (let j = 0; j < grid.ny; j++) {
        for (let i = 0; i < grid.nx; i++) {
          if (!materials[painted.matIds[painted.cells[cellIndex(grid, i, j, k)]]]) continue;
          for (let a = 0; a < 8; a++) {
            const v = T[nodeIndex(grid, i + (a & 1), j + ((a >> 1) & 1), k + ((a >> 2) & 1))];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
    }
    this.range = hi > lo ? [lo, hi] : [lo - 0.5, lo + 0.5];
    this.note.textContent = '';
    this.requestRender();
  }

  clearField(message = '') {
    this.T = null;
    this.range = null;
    this.note.textContent = message;
    this.requestRender();
  }

  setSlice(frac) {
    this.frac = Math.min(1, Math.max(0, frac));
    this.requestRender();
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

    // slice planes: nearest node plane for the field, adjacent cell layer for materials
    const zCoord = zs[0] + this.frac * (zs[nz] - zs[0]);
    let kNode = 0;
    for (let k = 1; k <= nz; k++) {
      if (Math.abs(zs[k] - zCoord) < Math.abs(zs[kNode] - zCoord)) kNode = k;
    }
    const kCell = Math.min(kNode, nz - 1);
    this.header.textContent =
      `XY slice — z = ${zs[kNode].toFixed(3)} m — ${this.T ? 'T [°C]' : 'materials'}`;

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
        if (this.T) {
          const x = xmin + (q + 0.5 - ox) / scale;
          const tx = (x - xs[i]) / (xs[i + 1] - xs[i]);
          const v00 = this.T[nodeIndex(grid, i, j, kNode)];
          const v10 = this.T[nodeIndex(grid, i + 1, j, kNode)];
          const v01 = this.T[nodeIndex(grid, i, j + 1, kNode)];
          const v11 = this.T[nodeIndex(grid, i + 1, j + 1, kNode)];
          const v = (1 - ty) * ((1 - tx) * v00 + tx * v10) + ty * ((1 - tx) * v01 + tx * v11);
          [r, g, b] = colormap((v - lo) * inv);
        } else {
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

    if (this.T) this.drawIsolines(ctx, kNode, kCell, pxOf, pyOf);
    this.drawColorbar();
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
      const [r, g, b] = colormap(q / (W - 1));
      for (let p = 0; p < H; p++) {
        const o = 4 * (p * W + q);
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.barMin.textContent = `${this.range[0].toFixed(1)} °C`;
    this.barMax.textContent = `${this.range[1].toFixed(1)} °C`;
  }
}
