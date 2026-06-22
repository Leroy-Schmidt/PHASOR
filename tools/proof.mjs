// PHASOR proof harness (ROADMAP S2 "shrink the human to a signature").
//
// The data/pixel split: every NUMBER is gated under `node --test`; this harness
// gates the PIXELS of the 2D <canvas> panel — the one visual channel the agent
// can read (plain canvas → getImageData/toBlob). The 3D view is WebGL and cannot
// be screenshotted here, so it stays the human channel (a glance at the sheet).
//
// Dependency-free by construction (no puppeteer, no build step — OPERATOR_NOTES
// §1.9). It is driven by the agent through the preview MCP tools:
//   1. `buildCaptureSnippet(state)` returns a string of JS. The agent runs it via
//      preview_eval; in the page it drives `window.__phasor` to a fixed state,
//      waits for the worker solve to settle, then returns a small JSON capture
//      (region colour means + solid-pixel stats + scraped readouts + a PNG
//      dataURL). Region means travel instead of full RGBA, so the payload is tiny
//      and node never has to decode a PNG.
//   2. The `assert*` functions here run in node over those captures.
//   3. `writeProofSheet` saves the PNGs (dataURL bytes, no decode) and a one-page
//      index.html the Operator signs.
//
// State list is data-driven so later milestones add capture states cheaply.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Perceptual luminance of an sRGB triple (Rec. 601), used by the brightness
// assertions — the heat ramp is monotone in luminance, so "brighter" ≡ "higher |q|".
export function luminance([r, g, b]) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Build the in-page capture snippet. Returns a string to hand to preview_eval.
 * The snippet is an async IIFE resolving to the capture object.
 *
 * @param {object} state
 * @param {string}  state.preset      — preset name (e.g. 'corner2d')
 * @param {string} [state.mode]       — SlicePanel mode ('flux'|'instant'|…)
 * @param {boolean}[state.glyphs]     — flow-arrow overlay on/off
 * @param {number} [state.scrubFrac]  — scrub position in [0,1] (default 0.5)
 * @param {'day'|'year'}[state.scrubUnit] — scrub period (default 'year')
 * @param {Array<{name,rect:[x,y,w,h],space?:'fraction'|'physical'}>} [state.samples]
 *        named sample boxes whose mean colour is returned. `fraction` boxes are
 *        in canvas-fraction coords [0,1]; `physical` boxes use the panel's stored
 *        render transform (metres) via slices.pixelOf — falls back to skipped if
 *        the transform isn't published.
 * @param {number} [state.timeoutMs]  — solve-settle timeout (default 15000)
 */
export function buildCaptureSnippet(state) {
  // Serialise state into the snippet literally; it executes in the page context.
  return `(async () => {
  const S = ${JSON.stringify(state)};
  const P = window.__phasor;
  if (!P) throw new Error('window.__phasor not present — open index.html');
  const statusEl = document.getElementById('status');
  const settled = () => P.slices.mean != null &&
    /^solved/.test(statusEl ? statusEl.textContent : '');

  // drive to the state: (re)load the preset and solve, then wait for the worker
  P.loadPreset(S.preset);
  P.solve();
  const t0 = Date.now();
  await new Promise((res, rej) => {
    (function poll() {
      if (settled()) return res();
      if (Date.now() - t0 > (S.timeoutMs ?? 15000)) return rej(new Error('solve timeout'));
      setTimeout(poll, 50);
    })();
  });

  // set display state (all solve-free — never re-solves; DESIGN §3.5)
  if (S.mode) P.slices.setMode(S.mode);
  if (P.slices.setGlyphs) P.slices.setGlyphs(!!S.glyphs);
  const period = S.scrubUnit === 'day' ? 86400 : 31557600;
  P.slices.setTime((S.scrubFrac ?? 0.5) * period);

  // read pixels off the plain 2D canvas
  const cv = P.slices.canvas;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const img = ctx.getImageData(0, 0, W, H).data;

  // background (void) pixels are fully transparent in the field render? No — the
  // panel paints alpha 255 everywhere it draws and leaves untouched pixels at 0.
  // Treat alpha>0 AND not the panel background as "solid". The panel clears to
  // transparent, so any drawn pixel (material or field) has alpha 255.
  const lum = (o) => 0.299 * img[o] + 0.587 * img[o + 1] + 0.114 * img[o + 2];

  // solid-pixel luminance stats (alpha 255 == drawn)
  let maxLum = 0, sumLum = 0, nSolid = 0, brightO = -1;
  for (let o = 0; o < img.length; o += 4) {
    if (img[o + 3] < 255) continue;
    const L = lum(o);
    sumLum += L; nSolid++;
    if (L > maxLum) { maxLum = L; brightO = o; }
  }
  const meanLum = nSolid ? sumLum / nSolid : 0;
  const brightPx = brightO >= 0
    ? { x: (brightO / 4) % W, y: Math.floor((brightO / 4) / W) } : null;

  // named sample boxes → mean colour + luminance
  const samples = {};
  for (const s of (S.samples ?? [])) {
    let px, py, pw, ph;
    if (s.space === 'physical' && P.slices.pixelOf) {
      const a = P.slices.pixelOf(s.rect[0], s.rect[1]);
      const b = P.slices.pixelOf(s.rect[0] + s.rect[2], s.rect[1] + s.rect[3]);
      px = Math.min(a.x, b.x); py = Math.min(a.y, b.y);
      pw = Math.abs(b.x - a.x); ph = Math.abs(b.y - a.y);
    } else {
      px = Math.round(s.rect[0] * W); py = Math.round(s.rect[1] * H);
      pw = Math.round(s.rect[2] * W); ph = Math.round(s.rect[3] * H);
    }
    let r = 0, g = 0, bl = 0, n = 0;
    for (let y = py; y < py + ph; y++) {
      for (let x = px; x < px + pw; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const o = 4 * (y * W + x);
        if (img[o + 3] < 255) continue;
        r += img[o]; g += img[o + 1]; bl += img[o + 2]; n++;
      }
    }
    samples[s.name] = n
      ? { r: r / n, g: g / n, b: bl / n, lum: (0.299 * r + 0.587 * g + 0.114 * bl) / n, n }
      : { r: 0, g: 0, b: 0, lum: 0, n: 0 };
  }

  // scrape the readouts panel text into a flat object (display strings)
  const readEl = document.getElementById('readouts');
  const readouts = readEl ? readEl.textContent.replace(/\\s+/g, ' ').trim() : '';

  return {
    state: S, width: W, height: H,
    maxLum, meanLum, nSolid, brightPx, samples, readouts,
    dataURL: cv.toDataURL('image/png'),
  };
})()`;
}

/** A bright band exists: the hottest solid pixel clearly exceeds the mean. */
export function assertConcentration(cap, { minDelta = 30 } = {}) {
  const delta = cap.maxLum - cap.meanLum;
  const pass = delta >= minDelta && cap.nSolid > 0;
  return {
    pass, name: 'concentration',
    detail: `maxLum ${cap.maxLum.toFixed(1)} − meanLum ${cap.meanLum.toFixed(1)} = ` +
      `${delta.toFixed(1)} (≥ ${minDelta}) over ${cap.nSolid} solid px`,
  };
}

/** Sample `hot` is brighter (higher |q|) than sample `cool` by a margin. */
export function assertBrighter(cap, hot, cool, { minDelta = 15 } = {}) {
  const a = cap.samples[hot];
  const b = cap.samples[cool];
  const ok = a && b && a.n > 0 && b.n > 0;
  const delta = ok ? a.lum - b.lum : 0;
  return {
    pass: ok && delta >= minDelta, name: `brighter(${hot}>${cool})`,
    detail: ok
      ? `${hot} lum ${a.lum.toFixed(1)} − ${cool} lum ${b.lum.toFixed(1)} = ${delta.toFixed(1)} (≥ ${minDelta})`
      : `missing/empty sample (${hot}:${a?.n ?? 0}, ${cool}:${b?.n ?? 0})`,
  };
}

/**
 * The glyph layer draws something: the arrows change a non-trivial fraction of
 * the solid pixels between glyphs-off and glyphs-on. `changedFrac` is computed
 * in-page (per-pixel luminance diff over the solid region) and is robust to
 * glyph density — unlike a global mean shift, which sparse arrows barely move.
 */
export function assertGlyphLayer(cap, { minFrac = 0.01 } = {}) {
  const f = cap.glyphChangedFrac ?? 0;
  return {
    pass: f >= minFrac, name: 'glyph-layer-nonempty',
    detail: `arrows changed ${(f * 100).toFixed(2)}% of solid pixels (≥ ${(minFrac * 100).toFixed(1)}%)`,
  };
}

/**
 * A signed (diverging) field flips sign with the scrubber: capture A is
 * cool-dominant and capture B is warm-dominant (or vice versa). Confirms the
 * harmonic-swing view shows the AC deviation about the mean (not a one-sided
 * magnitude) and that it breathes with time. Captures carry warm/cool pixel
 * counts (r−b and b−r over a margin) computed in-page.
 */
export function assertSignFlip(a, b, { minPct = 10 } = {}) {
  const pct = (c) => (c.n ? { warm: (c.warm / c.n) * 100, cool: (c.cool / c.n) * 100 } : { warm: 0, cool: 0 });
  const pa = pct(a);
  const pb = pct(b);
  const aCool = pa.cool - pa.warm; // >0 ⇒ A leans cool
  const bWarm = pb.warm - pb.cool; // >0 ⇒ B leans warm
  const pass = (aCool >= minPct && bWarm >= minPct) || (-aCool >= minPct && -bWarm >= minPct);
  return {
    pass, name: 'sign-flip-breathes',
    detail: `A cool ${pa.cool.toFixed(1)}%/warm ${pa.warm.toFixed(1)}% ↔ `
      + `B cool ${pb.cool.toFixed(1)}%/warm ${pb.warm.toFixed(1)}% (lean ≥ ${minPct}%)`,
  };
}

/** data URL → raw PNG bytes (no decode, just strip the base64 header). */
function dataURLToBuffer(dataURL) {
  const i = dataURL.indexOf(',');
  return Buffer.from(dataURL.slice(i + 1), 'base64');
}

/**
 * Write the proof sheet: one PNG per capture + a one-page index.html with
 * thumbnails, scraped readouts, and each assertion's pass/fail.
 *
 * @param {string} dir — output dir (e.g. 'proofs/s2-m1.2')
 * @param {{title, captures:Array<{name,cap,checks?:Array<{pass,name,detail}>}>}} sheet
 */
export async function writeProofSheet(dir, { title, captures }) {
  await mkdir(dir, { recursive: true });
  const cards = [];
  for (const { name, cap, checks = [] } of captures) {
    const png = `${name}.png`;
    // a capture may carry an inline dataURL or point at an already-written PNG
    // (some environments save the large eval result to a file instead of
    // returning it inline; the driver decodes it separately).
    if (cap.dataURL) await writeFile(join(dir, png), dataURLToBuffer(cap.dataURL));
    const checkRows = checks.map((c) =>
      `<li class="${c.pass ? 'ok' : 'bad'}">${c.pass ? '✓' : '✗'} <b>${c.name}</b> — ${c.detail}</li>`).join('');
    cards.push(`<section class="card">
      <h2>${name}</h2>
      <img src="${png}" alt="${name}">
      <div class="meta">${JSON.stringify(cap.state)}</div>
      <div class="readouts">${cap.readouts || '<i>no readouts</i>'}</div>
      <ul class="checks">${checkRows || '<li><i>no pixel checks</i></li>'}</ul>
    </section>`);
  }
  const allPass = captures.every((c) => (c.checks ?? []).every((k) => k.pass));
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
  body{background:#0e1013;color:#cfd3d8;font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}
  h1{font-size:18px;color:#e8a33d} .verdict{font-weight:700;padding:4px 10px;border-radius:4px}
  .verdict.ok{background:#1d3a16;color:#9be07d} .verdict.bad{background:#3a1616;color:#e0533d}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;margin-top:16px}
  .card{background:#14161a;border-radius:8px;padding:12px} .card h2{font-size:14px;margin:0 0 8px}
  .card img{width:100%;border-radius:4px;background:#000;image-rendering:pixelated}
  .meta{font:11px ui-monospace,monospace;color:#8a919a;margin:8px 0;word-break:break-all}
  .readouts{font-size:12px;color:#cfd3d8;margin:6px 0}
  .checks{list-style:none;padding:0;margin:8px 0 0;font-size:12px}
  .checks .ok{color:#9be07d} .checks .bad{color:#e0533d}
</style>
<h1>${title} &nbsp; <span class="verdict ${allPass ? 'ok' : 'bad'}">${allPass ? 'ALL PIXEL CHECKS PASS' : 'CHECK FAILED'}</span></h1>
<p>2D-canvas proof sheet (the agent-verifiable channel). Glance + sign; then look at the live 3D view.</p>
<div class="grid">${cards.join('\n')}</div>`;
  await writeFile(join(dir, 'index.html'), html);
  return { dir, allPass };
}
