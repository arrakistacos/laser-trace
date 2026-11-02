// Laser Trace — UI, view, text, export.
import { DEFAULTS, traceParams } from './pipeline.js';
import { pathData, pathsBBox, transformPath, pathLength } from './trace.js';
import { PALETTE, paletteName, buildSVG } from './svg.js';
import { FONTS, loadFont, layoutText, weldPaths, rasterizeTexts, addFontFromBuffer } from './text.js';
import { makeSketch, makeColour } from './samples.js';
import * as I from './imageops.js';

const $ = (id) => document.getElementById(id);
const STORE = 'laser-trace-v1';
const BED = { w: 400, h: 430, name: 'Ortur LM2' };

// ---------------- state ----------------
const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } })();
const state = {
  s: { ...DEFAULTS, ...(saved.s || {}) },
  widthMm: saved.widthMm || 100,
  res: saved.res || 1600,
  src: null,            // { canvas, name }  (orientation already applied, ≤3000 px)
  rot: 0, flip: false,
  quad: null,           // crop/perspective corners, normalised to the rotated source
  work: null,           // { canvas, rgba, w, h, id }
  edits: { strokes: [], version: 0, erase: null, ink: null },
  layerCfg: {},         // per output layer: { color, mode, enabled }
  paintTarget: 0,       // colour mode: which cluster the Draw brush paints into
  texts: [], selText: null, textVersion: 0,
  result: null,
  view: 'vector', tool: 'pan',
  brush: 1.5,           // % of image size
  crop: null,           // while cropping: { quad }
};
let workSeq = 0;

function persist() {
  try { localStorage.setItem(STORE, JSON.stringify({ s: state.s, widthMm: state.widthMm, res: state.res })); } catch { /* private mode */ }
}

// ---------------- worker ----------------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let runSeq = 0, running = false, queued = false, lastMs = 0;
worker.onmessage = (e) => {
  const d = e.data;
  running = false;
  if (d.seq === runSeq) {
    $('busy').hidden = true;
    if (!d.ok) { console.error(d.error); toast('Tracing failed — see console'); }
    else { state.result = d; lastMs = d.ms; onResult(); }
  }
  if (queued) { queued = false; run(); }
};
function mmPerPx() { return state.work ? state.widthMm / state.work.w : 0.1; }
function run() {
  if (!state.work) return;
  if (running) { queued = true; return; }
  running = true;
  $('busy').hidden = false;
  runSeq++;
  const textMask = needTextMask() ? buildTextMask() : null;
  worker.postMessage({
    type: 'run', seq: runSeq, settings: state.s, wantMasks: state.view === 'mask',
    extras: {
      mmPerPx: mmPerPx(),
      edits: state.edits.strokes.length ? { erase: state.edits.erase, ink: state.edits.ink, version: state.edits.version } : null,
      layerCfg: state.layerCfg,
      paintTarget: state.paintTarget,
      textMask, textVersion: textMask ? state.textVersion + ':' + mmPerPx() : '',
    },
  });
}
let runTimer = 0;
function schedule(delay = 60) { clearTimeout(runTimer); runTimer = setTimeout(run, delay); }

// ---------------- image loading ----------------
async function loadFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|gif|bmp|heic|heif|avif|svg)$/i.test(file.name)) { toast('That doesn’t look like an image'); return; }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('decode')); i.src = url; });
    setSource(img, img.naturalWidth, img.naturalHeight, file.name || 'pasted image');
  } catch {
    toast(/heic|heif/i.test(file.name) ? 'This browser can’t open HEIC — set your camera to “Most compatible” or share as JPEG' : 'Couldn’t read that image');
  } finally { URL.revokeObjectURL(url); }
}
function setSource(drawable, w, h, name) {
  const max = 3000, k = Math.min(1, max / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.round(w * k); cv.height = Math.round(h * k);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); // transparent PNGs → white paper
  ctx.drawImage(drawable, 0, 0, cv.width, cv.height);
  state.src = { canvas: cv, name };
  state.rot = 0; state.flip = false; state.quad = null;
  state.texts = []; state.selText = null;
  state.layerCfg = {};
  clearEdits(false);
  renderTextList(); syncTextEditor();
  $('fileName').textContent = name;
  $('empty').hidden = true;
  rebuildWork(true);
}

// source with rotation/mirror applied
function orientedSource() {
  const s = state.src.canvas;
  const swap = state.rot % 2 !== 0;
  const cv = document.createElement('canvas');
  cv.width = swap ? s.height : s.width; cv.height = swap ? s.width : s.height;
  const ctx = cv.getContext('2d');
  ctx.translate(cv.width / 2, cv.height / 2);
  ctx.rotate(state.rot * Math.PI / 2);
  if (state.flip) ctx.scale(-1, 1);
  ctx.drawImage(s, -s.width / 2, -s.height / 2);
  return cv;
}
let orientedCache = null;
function getOriented() {
  const key = state.rot + '|' + state.flip + '|' + (state.src && state.src.name) + '|' + (state.src && state.src.canvas.width);
  if (!orientedCache || orientedCache.key !== key || orientedCache.src !== state.src) orientedCache = { key, src: state.src, canvas: orientedSource() };
  return orientedCache.canvas;
}

function rebuildWork(fit) {
  if (!state.src) return;
  const o = getOriented();
  let w, h, rgba;
  const res = state.res;
  if (state.quad) {
    const q = state.quad.map(([u, v]) => [u * o.width, v * o.height]);
    const sz = I.quadSize(q), k = res / Math.max(sz.w, sz.h);
    w = Math.max(8, Math.round(sz.w * k)); h = Math.max(8, Math.round(sz.h * k));
    const src = o.getContext('2d').getImageData(0, 0, o.width, o.height).data;
    rgba = I.warpQuad(src, o.width, o.height, q, w, h);
  } else {
    const k = Math.min(res / Math.max(o.width, o.height), 4);
    w = Math.max(8, Math.round(o.width * k)); h = Math.max(8, Math.round(o.height * k));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(o, 0, 0, w, h);
    rgba = ctx.getImageData(0, 0, w, h).data;
  }
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  state.work = { canvas, rgba, w, h, id: 'w' + (++workSeq) };
  worker.postMessage({ type: 'image', rgba: new Uint8ClampedArray(rgba), w, h, id: state.work.id });
  rasterEdits();
  state.result = null;
  syncSize();
  if (fit) needFit = true;
  run();
}

// ---------------- result → view ----------------
let layerPaths = []; // [{ layer, path2d, dash }]
let maskCanvas = null;
let needFit = false;
function toPath2D(paths) { return new Path2D(pathData(Array.isArray(paths[0]) ? paths.flat() : paths)); }

function onResult() {
  const r = state.result;
  layerPaths = r.layers.filter((l) => l.enabled && l.paths.length).map((l) => ({ layer: l, path2d: toPath2D(l.paths) }));
  maskCanvas = null;
  if (needFit || !designVisible()) { fitView(); needFit = false; }
  renderLayers(); renderStats(); renderLegend(); draw();
}

function buildMaskCanvas() {
  const r = state.result; if (!r) return null;
  const { w, h } = r;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const id = ctx.createImageData(w, h), d = id.data;
  for (let i = 0; i < w * h; i++) { d[i * 4] = 250; d[i * 4 + 1] = 248; d[i * 4 + 2] = 242; d[i * 4 + 3] = 255; }
  for (const l of r.layers) {
    if (!l.mask) continue;
    const c = state.s.mode === 'bw' ? [15, 15, 15] : l.swatch;
    const a = l.enabled ? 1 : 0.18;
    for (let i = 0; i < w * h; i++) if (l.mask[i]) {
      d[i * 4] = d[i * 4] * (1 - a) + c[0] * a; d[i * 4 + 1] = d[i * 4 + 1] * (1 - a) + c[1] * a; d[i * 4 + 2] = d[i * 4 + 2] * (1 - a) + c[2] * a;
    }
  }
  ctx.putImageData(id, 0, 0);
  return cv;
}

// ---------------- view transform ----------------
const canvas = $('view');
const ctx = canvas.getContext('2d');
const view = { scale: 4, ox: 0, oy: 0 }; // screen px = mm * scale + o
let dpr = 1;
function resize() {
  const r = canvas.getBoundingClientRect();
  dpr = Math.min(2.5, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr));
  draw();
}
new ResizeObserver(resize).observe(canvas);

function designBox() {
  if (!state.work) return null;
  const k = mmPerPx();
  let x0 = 0, y0 = 0, x1 = state.work.w * k, y1 = state.work.h * k;
  const r = state.result;
  if (r && r.frame) { x0 = Math.min(x0, r.frame.x0 * k); y0 = Math.min(y0, r.frame.y0 * k); x1 = Math.max(x1, r.frame.x1 * k); y1 = Math.max(y1, r.frame.y1 * k); }
  for (const t of state.texts) if (t._bbox) { x0 = Math.min(x0, t._bbox.x0); y0 = Math.min(y0, t._bbox.y0); x1 = Math.max(x1, t._bbox.x1); y1 = Math.max(y1, t._bbox.y1); }
  return { x0, y0, x1, y1 };
}
function fitView() {
  const r = canvas.getBoundingClientRect();
  let b;
  if (state.crop) { const o = getOriented(); b = { x0: 0, y0: 0, x1: o.width, y1: o.height }; }
  else b = designBox();
  if (!b || !r.width) return;
  const top = 56, bottom = 70, pad = 24;
  const sw = r.width - pad * 2, sh = r.height - top - bottom;
  view.scale = Math.max(0.01, Math.min(sw / (b.x1 - b.x0), sh / (b.y1 - b.y0)));
  view.ox = pad + (sw - (b.x1 - b.x0) * view.scale) / 2 - b.x0 * view.scale;
  view.oy = top + (sh - (b.y1 - b.y0) * view.scale) / 2 - b.y0 * view.scale;
  draw();
}
// is the whole design on screen? (stencil margins and borders can grow it)
function designVisible() {
  const b = designBox(), r = canvas.getBoundingClientRect();
  if (!b || !r.width) return true;
  const sx0 = b.x0 * view.scale + view.ox, sy0 = b.y0 * view.scale + view.oy;
  const sx1 = b.x1 * view.scale + view.ox, sy1 = b.y1 * view.scale + view.oy;
  return sx0 >= -2 && sy0 >= -2 && sx1 <= r.width + 2 && sy1 <= r.height + 2;
}
const toWorld = (sx, sy) => [(sx - view.ox) / view.scale, (sy - view.oy) / view.scale];

// ---------------- drawing ----------------
let drawQueued = false;
function draw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(() => { drawQueued = false; paint(); }); } }

function woodPattern() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#d8b07a'; g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 2) {
    const v = Math.sin(y * 0.09) * 0.5 + Math.sin(y * 0.023 + 1) * 0.5;
    g.fillStyle = `rgba(150,95,40,${0.08 + 0.08 * v})`; g.fillRect(0, y, 256, 2);
  }
  return ctx.createPattern(c, 'repeat');
}
let wood = null;

function paint() {
  const W = canvas.width, H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#f3efe6'; ctx.fillRect(0, 0, W, H);
  if (state.crop) return paintCrop();
  if (!state.work) return;
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy);
  const k = mmPerPx(), iw = state.work.w * k, ih = state.work.h * k;
  const px = 1 / view.scale; // one screen px in mm
  const v = state.view;
  const r = state.result;

  if (v === 'burn') {
    const b = designBox();
    wood = wood || woodPattern();
    ctx.save(); ctx.fillStyle = wood; ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); ctx.restore();
  } else {
    // page shadow
    ctx.fillStyle = 'rgba(0,0,0,.06)'; ctx.fillRect(px * 3, px * 3, iw, ih);
  }
  if (v === 'photo') ctx.drawImage(state.work.canvas, 0, 0, iw, ih);
  else if (v === 'mask') {
    if (!maskCanvas) maskCanvas = buildMaskCanvas();
    if (maskCanvas) { ctx.imageSmoothingEnabled = false; ctx.drawImage(maskCanvas, 0, 0, iw, ih); ctx.imageSmoothingEnabled = true; }
  } else if (v === 'vector') {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, iw, ih);
    ctx.globalAlpha = 0.22; ctx.drawImage(state.work.canvas, 0, 0, iw, ih); ctx.globalAlpha = 1;
  }
  if (v === 'vector' || v === 'burn') {
    ctx.save(); ctx.scale(k, k);
    for (const { layer, path2d } of layerPaths) strokeOrFill(layer.color, layer.mode, path2d, v, px / k);
    ctx.restore();
  } else if (r) {
    // thin outline preview on top of photo/mask
    ctx.save(); ctx.scale(k, k);
    for (const { layer, path2d } of layerPaths) { ctx.strokeStyle = layerColor(layer.color, 0.9); ctx.lineWidth = 1.2 * px / k; ctx.stroke(path2d); }
    ctx.restore();
  }
  // text
  for (const t of state.texts) {
    if (!t._paths || (state.s.stencil && state.s.mode === 'bw')) continue;
    const p2 = t._p2d || (t._p2d = toPath2D(t._paths));
    if (v === 'vector' || v === 'burn') strokeOrFill(t.color, t.mode, p2, v, px);
    else { ctx.strokeStyle = layerColor(t.color, 0.9); ctx.lineWidth = 1.2 * px; ctx.stroke(p2); }
  }
  // selected text box
  const sel = state.texts.find((t) => t.id === state.selText);
  if (sel && sel._bbox) {
    const b = sel._bbox;
    ctx.setLineDash([4 * px, 3 * px]); ctx.strokeStyle = '#1b8f84'; ctx.lineWidth = 1.2 * px;
    ctx.strokeRect(b.x0 - 2 * px, b.y0 - 2 * px, b.x1 - b.x0 + 4 * px, b.y1 - b.y0 + 4 * px); ctx.setLineDash([]);
  }
  // brush cursor
  if (hover && (state.tool === 'erase' || state.tool === 'draw')) {
    const rr = brushRadiusMm();
    ctx.beginPath(); ctx.arc(hover[0], hover[1], rr, 0, Math.PI * 2);
    ctx.strokeStyle = state.tool === 'erase' ? '#d0402b' : '#1b8f84'; ctx.lineWidth = 1.5 * px; ctx.stroke();
  }
}
function layerColor(i, a = 1) {
  const c = PALETTE[i] || '#000';
  const n = parseInt(c.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
function strokeOrFill(color, mode, p2d, v, px) {
  if (v === 'burn') {
    const cut = color === state.s.borderColor && mode === 'line';
    if (mode === 'fill') { ctx.fillStyle = 'rgba(52,30,14,.92)'; ctx.fill(p2d, 'evenodd'); }
    else { ctx.strokeStyle = cut ? 'rgba(25,14,6,.95)' : 'rgba(70,40,18,.9)'; ctx.lineWidth = Math.max(px * 1.4, cut ? 0.25 : 0.18); ctx.stroke(p2d); }
    return;
  }
  if (mode === 'fill') { ctx.fillStyle = layerColor(color, 0.88); ctx.fill(p2d, 'evenodd'); }
  else { ctx.strokeStyle = layerColor(color, 1); ctx.lineWidth = 1.5 * px; ctx.lineJoin = 'round'; ctx.stroke(p2d); }
}

// ---------------- crop / perspective ----------------
function paintCrop() {
  const o = getOriented();
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy);
  ctx.drawImage(o, 0, 0);
  const q = state.crop.quad.map(([u, v]) => [u * o.width, v * o.height]);
  const px = 1 / view.scale;
  ctx.fillStyle = 'rgba(20,19,17,.55)';
  ctx.beginPath(); ctx.rect(0, 0, o.width, o.height);
  ctx.moveTo(q[0][0], q[0][1]); for (let i = 3; i >= 1; i--) ctx.lineTo(q[i][0], q[i][1]); ctx.closePath();
  ctx.fill('evenodd');
  ctx.strokeStyle = '#d9a35b'; ctx.lineWidth = 2 * px;
  ctx.beginPath(); q.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.stroke();
  for (const p of q) { ctx.beginPath(); ctx.arc(p[0], p[1], 11 * px, 0, Math.PI * 2); ctx.fillStyle = 'rgba(217,163,91,.35)'; ctx.fill(); ctx.stroke(); }
}
function startCrop() {
  if (!state.src) return;
  state.crop = { quad: (state.quad || [[0, 0], [1, 0], [1, 1], [0, 1]]).map((p) => p.slice()) };
  $('cropBar').hidden = false; $('brushBar').hidden = true; updateStageBar();
  fitView();
}
function endCrop(apply) {
  if (apply) {
    const q = state.crop.quad;
    const full = q.every((p, i) => Math.abs(p[0] - [0, 1, 1, 0][i]) < 1e-3 && Math.abs(p[1] - [0, 0, 1, 1][i]) < 1e-3);
    state.quad = full ? null : q;
    clearEdits(false);
  }
  state.crop = null; $('cropBar').hidden = true; updateStageBar();
  if (apply) rebuildWork(true); else fitView();
}

// ---------------- pointer handling ----------------
const pointers = new Map();
let drag = null, hover = null;
function evPos(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = evPos(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 2) { drag = { type: 'pinch', ...pinchState() }; return; }
  const [wx, wy] = toWorld(...p);
  if (state.crop) {
    const o = getOriented();
    const q = state.crop.quad;
    let best = -1, bd = Infinity;
    q.forEach(([u, v], i) => { const d = Math.hypot(u * o.width - wx, v * o.height - wy) * view.scale; if (d < bd) { bd = d; best = i; } });
    drag = bd < 40 ? { type: 'corner', i: best } : { type: 'pan', p, ox: view.ox, oy: view.oy };
    return;
  }
  if (state.tool === 'erase' || state.tool === 'draw') {
    if (!state.work) return;
    const k = mmPerPx();
    const stroke = { mode: state.tool === 'erase' ? 'erase' : 'ink', size: state.brush / 100, pts: [[wx / k / state.work.w, wy / k / state.work.h]] };
    state.edits.strokes.push(stroke);
    drag = { type: 'brush', stroke };
    rasterEdits(); schedule(30);
    return;
  }
  const hit = hitText(wx, wy);
  if (hit) {
    selectText(hit.id);
    drag = { type: 'text', t: hit, start: [wx, wy], x: hit.x, y: hit.y, paths0: hit._paths, bbox0: hit._bbox };
    return;
  }
  drag = { type: 'pan', p, ox: view.ox, oy: view.oy };
});
canvas.addEventListener('pointermove', (e) => {
  const p = evPos(e);
  hover = toWorld(...p);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
  if (!drag) { if (state.tool !== 'pan') draw(); return; }
  if (drag.type === 'pinch' && pointers.size >= 2) {
    const now = pinchState();
    const s = drag.scale * now.dist / drag.dist;
    view.scale = s;
    view.ox = now.cx - (drag.cx - drag.ox) * (s / drag.scale);
    view.oy = now.cy - (drag.cy - drag.oy) * (s / drag.scale);
    draw(); return;
  }
  const [wx, wy] = hover;
  if (drag.type === 'pan') { view.ox = drag.ox + p[0] - drag.p[0]; view.oy = drag.oy + p[1] - drag.p[1]; draw(); }
  else if (drag.type === 'corner') {
    const o = getOriented();
    state.crop.quad[drag.i] = [Math.min(1, Math.max(0, wx / o.width)), Math.min(1, Math.max(0, wy / o.height))];
    draw();
  } else if (drag.type === 'brush') {
    const k = mmPerPx();
    drag.stroke.pts.push([wx / k / state.work.w, wy / k / state.work.h]);
    rasterEdits(); draw(); schedule(80);
  } else if (drag.type === 'text') {
    const dx = wx - drag.start[0], dy = wy - drag.start[1], t = drag.t;
    t.x = drag.x + dx; t.y = drag.y + dy;
    // just slide the existing outlines while dragging (re-layout can be slow for welded text)
    t._paths = drag.paths0.map((q) => transformPath(q, 1, 1, dx, dy)); t._p2d = null;
    t._bbox = { x0: drag.bbox0.x0 + dx, y0: drag.bbox0.y0 + dy, x1: drag.bbox0.x1 + dx, y1: drag.bbox0.y1 + dy };
    draw();
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (drag && drag.type === 'pinch') { drag = pointers.size === 1 ? { type: 'pan', p: [...pointers.values()][0], ox: view.ox, oy: view.oy } : null; return; }
  if (drag && drag.type === 'text') { syncTextEditor(); textChanged(); }
  if (drag && drag.type === 'brush') schedule(10);
  drag = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { hover = null; draw(); });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [sx, sy] = evPos(e);
  const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
  view.ox = sx - (sx - view.ox) * f; view.oy = sy - (sy - view.oy) * f; view.scale *= f;
  draw();
}, { passive: false });
function pinchState() {
  const [a, b] = [...pointers.values()];
  return { dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, scale: view.scale, ox: view.ox, oy: view.oy };
}

// ---------------- cleanup brush ----------------
function brushRadiusMm() { return state.work ? state.brush / 100 * Math.max(state.work.w, state.work.h) * mmPerPx() / 2 : 1; }
function rasterEdits() {
  const W = state.work; if (!W) return;
  const { w, h } = W;
  const draw1 = (mode) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = c.fillStyle = '#000';
    for (const s of state.edits.strokes) {
      // a later erase wipes earlier ink and vice versa, so paint in order on both
      const on = s.mode === mode;
      c.globalCompositeOperation = on ? 'source-over' : 'destination-out';
      const lw = s.size * Math.max(w, h);
      c.lineWidth = lw;
      c.beginPath();
      s.pts.forEach(([u, v], i) => (i ? c.lineTo(u * w, v * h) : c.moveTo(u * w, v * h)));
      if (s.pts.length === 1) { c.arc(s.pts[0][0] * w, s.pts[0][1] * h, lw / 2, 0, Math.PI * 2); c.fill(); } else c.stroke();
    }
    const d = c.getImageData(0, 0, w, h).data, m = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
    return m;
  };
  if (!state.edits.strokes.length) { state.edits.erase = state.edits.ink = null; }
  else { state.edits.erase = draw1('erase'); state.edits.ink = draw1('ink'); }
  state.edits.version++;
}
function clearEdits(rerun = true) {
  state.edits.strokes = []; state.edits.erase = state.edits.ink = null; state.edits.version++;
  if (rerun) schedule(10);
}

// ---------------- text ----------------
let textId = 0;
function hitText(x, y) {
  for (let i = state.texts.length - 1; i >= 0; i--) {
    const t = state.texts[i], b = t._bbox;
    const m = 2 / view.scale * 6;
    if (b && x >= b.x0 - m && x <= b.x1 + m && y >= b.y0 - m && y <= b.y1 + m) return t;
  }
  return null;
}
async function addText() {
  if (!state.work) { toast('Load an image first'); return; }
  const b = designBox();
  const t = { id: ++textId, text: 'Your text', font: 'archivo', height: Math.max(4, Math.round((b.x1 - b.x0) / 12)), spacing: 0, lineHeight: 1.2, align: 'center', rotate: 0,
    color: 1, mode: 'fill', weld: true, x: (b.x0 + b.x1) / 2, y: b.y1 + 4 + Math.max(4, Math.round((b.x1 - b.x0) / 12)) };
  state.texts.push(t);
  selectText(t.id);
  await relayoutText(t);
  textChanged(); fitView();
  $('tText').focus(); $('tText').select();
}
const fontReady = new Map();
async function relayoutText(t) {
  let font = fontReady.get(t.font);
  if (!font) {
    try { font = await loadFont(t.font); fontReady.set(t.font, font); }
    catch (err) { console.error(err); toast('Couldn’t load that font'); return; }
  }
  const lay = layoutText(t, font);
  let paths = lay.paths;
  if (t.weld && paths.length) paths = weldPaths(paths, toPath2D, traceParams({ detail: 90, smooth: 40 }, 2000)).flat();
  t._paths = paths; t._p2d = null;
  t._bbox = pathsBBox(paths);
  draw();
}
let textTimer = 0;
function textChanged() {
  state.textVersion++;
  renderTextList();
  if (needTextMask()) { clearTimeout(textTimer); textTimer = setTimeout(run, 120); }
  else renderStats();
  draw();
}
function needTextMask() { return state.texts.some((t) => t._paths && t._paths.length) && ((state.s.stencil && state.s.mode === 'bw') || state.s.border !== 'none'); }
function buildTextMask() {
  const k = mmPerPx(), W = state.work;
  const list = state.texts.filter((t) => t._paths && t._paths.length);
  let bb = null;
  for (const t of list) { const b = t._bbox; bb = bb ? { x0: Math.min(bb.x0, b.x0), y0: Math.min(bb.y0, b.y0), x1: Math.max(bb.x1, b.x1), y1: Math.max(bb.y1, b.y1) } : { ...b }; }
  if (!bb) return null;
  const ox = Math.floor(bb.x0 / k) - 2, oy = Math.floor(bb.y0 / k) - 2;
  const w = Math.min(8000, Math.ceil(bb.x1 / k) + 2 - ox), h = Math.min(8000, Math.ceil(bb.y1 / k) + 2 - oy);
  const shifted = list.map((t) => t._paths.map((p) => transformPath(p, 1, 1, -ox * k, -oy * k)));
  const m = rasterizeTexts(shifted, w, h, k, toPath2D);
  return { m, ox, oy, w, h, workW: W.w };
}
function selectText(id) { state.selText = id; syncTextEditor(); renderTextList(); draw(); }
function selected() { return state.texts.find((t) => t.id === state.selText); }
function renderTextList() {
  const el = $('textList'); el.innerHTML = '';
  for (const t of state.texts) {
    const b = document.createElement('button');
    b.textContent = (t.text || '(empty)').replace(/\n/g, ' ⏎ ') + ' · ' + (FONTS.find((f) => f.id === t.font) || {}).name;
    b.className = t.id === state.selText ? 'on' : '';
    b.onclick = () => selectText(t.id);
    el.appendChild(b);
  }
}
function fillFontSelect() {
  const sel = $('tFont'); const cur = sel.value; sel.innerHTML = '';
  for (const f of FONTS) { const o = document.createElement('option'); o.value = f.id; o.textContent = `${f.name} — ${f.kind}`; sel.appendChild(o); }
  if (cur) sel.value = cur;
}
function syncTextEditor() {
  const t = selected();
  $('textEditor').hidden = !t;
  if (!t) return;
  if (document.activeElement !== $('tText')) $('tText').value = t.text;
  $('tFont').value = t.font; $('tHeight').value = t.height; $('tSpacing').value = t.spacing;
  $('tRotate').value = t.rotate; $('tLine').value = t.lineHeight; $('tWeld').checked = t.weld;
  setSeg('alignSeg', 'align', t.align); setSeg('tModeSeg', 'tmode', t.mode);
  swatchButton($('tColor'), t.color, (c) => { t.color = c; textChanged(); syncTextEditor(); });
}
function bindText() {
  const upd = (fn) => async () => { const t = selected(); if (!t) return; fn(t); await relayoutText(t); textChanged(); };
  $('tText').addEventListener('input', upd((t) => { t.text = $('tText').value; }));
  $('tFont').addEventListener('change', upd((t) => { t.font = $('tFont').value; const f = FONTS.find((x) => x.id === t.font); if (f && /Script/.test(f.kind)) t.weld = true; $('tWeld').checked = t.weld; }));
  $('tHeight').addEventListener('input', upd((t) => { t.height = Math.max(0.5, +$('tHeight').value || t.height); }));
  $('tSpacing').addEventListener('input', upd((t) => { t.spacing = +$('tSpacing').value || 0; }));
  $('tRotate').addEventListener('input', upd((t) => { t.rotate = +$('tRotate').value || 0; }));
  $('tLine').addEventListener('input', upd((t) => { t.lineHeight = Math.max(0.5, +$('tLine').value || 1.2); }));
  $('tWeld').addEventListener('change', upd((t) => { t.weld = $('tWeld').checked; }));
  segClick('alignSeg', 'align', (v) => upd((t) => { t.align = v; })());
  segClick('tModeSeg', 'tmode', (v) => { const t = selected(); if (t) { t.mode = v; textChanged(); syncTextEditor(); } });
  $('btnAddText').onclick = addText;
  $('btnTextDelete').onclick = () => { state.texts = state.texts.filter((t) => t.id !== state.selText); state.selText = null; syncTextEditor(); textChanged(); };
  $('btnTextCenter').onclick = upd((t) => { const k = mmPerPx(); t.x = state.work.w * k / 2; t.y = state.work.h * k / 2; });
  $('fontInput').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const id = addFontFromBuffer(await f.arrayBuffer(), f.name.replace(/\.\w+$/, ''));
      fontReady.delete(id); fillFontSelect();
      const t = selected(); if (t) { t.font = id; await relayoutText(t); textChanged(); syncTextEditor(); }
    } catch (err) { console.error(err); toast('Couldn’t read that font (TTF, OTF or WOFF only)'); }
  });
}

// ---------------- layers panel ----------------
function renderLayers() {
  const el = $('layerList'); el.innerHTML = '';
  const r = state.result; if (!r) return;
  for (const l of r.layers) {
    if (l.key === 'frame' || l.key === 'border') continue;
    const row = document.createElement('div');
    row.className = 'layer' + (l.enabled ? '' : ' off') + (state.s.mode === 'color' && state.paintTarget === r.layers.indexOf(l) && state.tool === 'draw' ? ' target' : '');
    const en = document.createElement('input'); en.type = 'checkbox'; en.checked = l.enabled; en.title = 'Include this layer';
    en.onchange = () => setCfg(l.key, { enabled: en.checked });
    const src = document.createElement('i'); src.className = 'src';
    src.style.background = state.s.mode === 'bw' ? '#111' : `rgb(${l.swatch.join(',')})`;
    const name = document.createElement('div'); name.className = 'name';
    const n = l.paths.reduce((a, g) => a + g.length, 0);
    const extra = l.stencil ? 'stencil cut' : l.centerline ? 'single line' : l.background ? 'paper (off)' : '';
    name.innerHTML = `${l.name}<small>${l.enabled ? n + ' paths' : 'off'}${extra ? ' · ' + extra : ''}${l.share != null ? ' · ' + Math.round(l.share * 100) + '%' : ''}</small>`;
    if (state.s.mode === 'color') { row.title = 'Click to choose this colour for the Draw brush'; row.onclick = (e) => { if (e.target === row || e.target === name || name.contains(e.target)) { state.paintTarget = r.layers.indexOf(l); renderLayers(); if (state.edits.strokes.length) schedule(10); } }; }
    const sw = document.createElement('span');
    swatchButton(sw, l.color, (c) => setCfg(l.key, { color: c }));
    const mode = document.createElement('div'); mode.className = 'seg';
    const fixedLine = l.centerline || l.stencil;
    for (const m of ['fill', 'line']) {
      const b = document.createElement('button'); b.textContent = m === 'fill' ? 'Fill' : 'Line';
      b.className = l.mode === m ? 'on' : ''; b.disabled = fixedLine && m === 'fill';
      b.title = m === 'fill' ? 'Solid engraved shapes' : 'Outline only (hollow / cut)';
      b.onclick = () => setCfg(l.key, { mode: m });
      mode.appendChild(b);
    }
    row.append(en, src, name, sw, mode);
    el.appendChild(row);
  }
}
function setCfg(key, patch) { state.layerCfg[key] = { ...(state.layerCfg[key] || {}), ...patch }; schedule(10); }

// palette popover
const pop = $('palettePop');
let popCb = null;
function swatchButton(host, color, cb) {
  host.innerHTML = '';
  const b = document.createElement('button'); b.type = 'button'; b.className = 'swatch-btn';
  b.innerHTML = `<i style="background:${PALETTE[color]}"></i>${paletteName(color)}`;
  b.title = 'LightBurn layer colour';
  b.onclick = (e) => { e.stopPropagation(); openPalette(b, color, cb); };
  host.appendChild(b);
}
function openPalette(anchor, cur, cb) {
  popCb = cb; pop.innerHTML = '';
  PALETTE.forEach((c, i) => {
    const b = document.createElement('button'); b.style.background = c; b.textContent = String(i).padStart(2, '0');
    b.title = paletteName(i); if (i === cur) b.className = 'on';
    b.onclick = () => { pop.hidden = true; popCb && popCb(i); };
    pop.appendChild(b);
  });
  pop.hidden = false;
  const r = anchor.getBoundingClientRect(), pr = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, r.right - pr.width)) + 'px';
  const top = r.bottom + 6 + pr.height > window.innerHeight ? r.top - pr.height - 6 : r.bottom + 6;
  pop.style.top = Math.max(8, top) + 'px';
}
document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true; });

// ---------------- stats / legend ----------------
function exportLayers() {
  const r = state.result; if (!r) return [];
  const k = mmPerPx();
  const layers = r.layers.filter((l) => l.enabled && l.paths.length).map((l) => ({
    name: l.name, color: l.color, mode: l.mode,
    paths: l.paths.map((g) => g.map((p) => transformPath(p, k, k, 0, 0))),
  }));
  if (!(state.s.stencil && state.s.mode === 'bw')) {
    for (const t of state.texts) if (t._paths && t._paths.length) layers.push({ name: 'Text', color: t.color, mode: t.mode, paths: [t._paths] });
  }
  return layers;
}
function renderStats() {
  const layers = exportLayers();
  const all = layers.flatMap((l) => l.paths.flat());
  const bb = pathsBBox(all);
  let nodes = 0, cut = 0;
  for (const l of layers) for (const p of l.paths.flat()) { nodes += p.segs.length + 1; if (l.mode === 'line') cut += pathLength(p); }
  const size = bb ? `${(bb.x1 - bb.x0).toFixed(1)} × ${(bb.y1 - bb.y0).toFixed(1)} mm` : '—';
  const big = bb && ((bb.x1 - bb.x0) > BED.w || (bb.y1 - bb.y0) > BED.h);
  const html = `<span>design <b class="${big ? 'warn' : ''}">${size}</b></span><span>paths <b>${all.length}</b></span><span>nodes <b>${nodes.toLocaleString()}</b></span>` +
    (cut ? `<span>line length <b>${(cut / 1000).toFixed(2)} m</b></span>` : '') + `<span>${Math.round(lastMs)} ms</span>`;
  $('stats').innerHTML = html;
  mobileStats.innerHTML = html.replace(/<\/span><span>/g, ' · ').replace(/<\/?span>/g, '');
  $('sizeReadout').innerHTML = `${state.work ? state.work.w + '×' + state.work.h + ' px · ' + (1 / mmPerPx()).toFixed(1) + ' px/mm' : '—'}${big ? ` · <span style="color:var(--accent)">larger than the ${BED.name} bed (${BED.w}×${BED.h})</span>` : ''}`;
}
function renderLegend() {
  const seen = new Map();
  for (const l of exportLayers()) { const key = l.color + l.mode; if (!seen.has(key)) seen.set(key, l); }
  $('legend').innerHTML = [...seen.values()].map((l) => `<span><i style="background:${PALETTE[l.color]}"></i>${paletteName(l.color)} ${l.mode}</span>`).join('');
}
const mobileStats = document.createElement('div'); mobileStats.className = 'mobile-stats';
$('panel').prepend(mobileStats);

// ---------------- export ----------------
function exportSVG() {
  if (!state.result) { toast('Load an image first'); return; }
  const layers = exportLayers();
  const bb = pathsBBox(layers.flatMap((l) => l.paths.flat()));
  if (!bb) { toast('Nothing to export — every layer is off or empty'); return; }
  const shifted = layers.map((l) => ({ ...l, paths: l.paths.map((g) => g.map((p) => transformPath(p, 1, 1, -bb.x0, -bb.y0))) }));
  const base = (state.src.name || 'drawing').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 40) || 'drawing';
  const svg = buildSVG({ width: bb.x1 - bb.x0, height: bb.y1 - bb.y0, layers: shifted, title: base });
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${base}-laser.svg`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Saved ${a.download}`);
}

// ---------------- controls ----------------
function setSeg(id, attr, val) { for (const b of $(id).querySelectorAll(`[data-${attr}]`)) b.classList.toggle('on', b.dataset[attr] === String(val)); }
function segClick(id, attr, fn) { $(id).addEventListener('click', (e) => { const b = e.target.closest(`[data-${attr}]`); if (b) fn(b.dataset[attr]); }); }

const SLIDERS = ['flatten', 'brightness', 'contrast', 'blur', 'threshold', 'adaptiveOffset', 'colors', 'colorBlur', 'detail', 'smooth', 'closeGaps', 'thicken'];
const NUMBERS = ['bridgeMm', 'stencilMarginMm', 'borderMm', 'borderRadiusMm'];
function syncControls() {
  const s = state.s;
  for (const k of SLIDERS) { const el = $(k); el.value = s[k]; el.nextElementSibling.textContent = fmt(k, s[k]); }
  for (const k of NUMBERS) $(k).value = s[k];
  $('invert').checked = s.invert; $('fillHoles').checked = s.fillHoles; $('stencil').checked = s.stencil; $('borderJoin').checked = s.borderJoin;
  $('joinRow').hidden = s.border !== 'contour';
  setSeg('modeSeg', 'mode', s.mode); setSeg('threshSeg', 'thresh', s.threshMode); setSeg('traceSeg', 'trace', s.traceMode);
  setSeg('bridgeSeg', 'bdir', s.bridgeDir); setSeg('borderSeg', 'border', s.border);
  $('threshRow').hidden = s.threshMode !== 'manual'; $('adaptRow').hidden = s.threshMode !== 'adaptive';
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = el.dataset.for !== s.mode;
  $('stencilFields').hidden = !s.stencil;
  $('borderFields').hidden = s.border === 'none' || (s.stencil && s.mode === 'bw');
  $('radiusRow').hidden = s.border !== 'round';
  $('res').value = String(state.res);
  $('widthMm').value = +state.widthMm.toFixed(2);
  $('traceHint').textContent = s.traceMode === 'outline'
    ? 'Traces around every mark. Use Fill to engrave solid, or Line for a hollow double-line look.'
    : 'Follows the middle of each pen stroke — one clean line per stroke, ideal for fast scoring.';
  swatchButton($('cutColor'), s.borderColor, (c) => { s.borderColor = c; changed(); syncControls(); });
  syncSize();
}
function fmt(k, v) {
  if (k === 'blur' || k === 'colorBlur') return (+v).toFixed(1);
  if (k === 'closeGaps' || k === 'thicken') return (v > 0 && k === 'thicken' ? '+' : '') + (+v).toFixed(1);
  if (k === 'threshold' && state.s.threshMode === 'auto' && state.result) return Math.round(state.result.info.threshold || v);
  return String(v);
}
function syncSize() {
  if (!state.work) { $('heightMm').value = ''; return; }
  $('heightMm').value = +(state.widthMm * state.work.h / state.work.w).toFixed(2);
}
function changed(delay) {
  persist(); schedule(delay);
}

function bindControls() {
  for (const k of SLIDERS) {
    const el = $(k);
    el.addEventListener('input', () => {
      state.s[k] = +el.value; el.nextElementSibling.textContent = fmt(k, state.s[k]);
      if (k === 'colors' || k === 'colorBlur') for (const key of Object.keys(state.layerCfg)) if (key[0] === 'c') delete state.layerCfg[key];
      changed(k === 'colors' ? 150 : 40);
    });
  }
  for (const k of NUMBERS) $(k).addEventListener('input', () => { const v = parseFloat($(k).value); if (isFinite(v) && v >= 0) { state.s[k] = v; changed(150); } });
  for (const k of ['invert', 'fillHoles', 'stencil', 'borderJoin']) $(k).addEventListener('change', () => { state.s[k] = $(k).checked; syncControls(); changed(10); });
  segClick('modeSeg', 'mode', (v) => { state.s.mode = v; syncControls(); changed(10); });
  segClick('threshSeg', 'thresh', (v) => {
    if (v === 'manual' && state.s.threshMode === 'auto' && state.result) state.s.threshold = Math.round(state.result.info.threshold || 128);
    state.s.threshMode = v; syncControls(); changed(10);
  });
  segClick('traceSeg', 'trace', (v) => { state.s.traceMode = v; syncControls(); changed(10); });
  segClick('bridgeSeg', 'bdir', (v) => { state.s.bridgeDir = v; syncControls(); changed(10); });
  segClick('borderSeg', 'border', (v) => { state.s.border = v; syncControls(); changed(10); });
  segClick('viewSeg', 'view', (v) => {
    state.view = v; setSeg('viewSeg', 'view', v);
    if (v === 'mask' && state.result && !state.result.layers.some((l) => l.mask)) run();
    draw();
  });
  segClick('toolSeg', 'tool', (v) => {
    state.tool = v; setSeg('toolSeg', 'tool', v);
    $('brushBar').hidden = v === 'pan' || !!state.crop; updateStageBar();
    canvas.style.cursor = v === 'pan' ? 'grab' : 'crosshair';
    renderLayers(); draw();
  });
  $('brushSize').value = state.brush;
  $('brushSize').addEventListener('input', () => { state.brush = +$('brushSize').value; draw(); });
  $('btnUndoStroke').onclick = () => { state.edits.strokes.pop(); rasterEdits(); schedule(10); };
  $('btnClearEdits').onclick = () => clearEdits(true);
  $('btnFit').onclick = fitView;
  $('btnExport').onclick = exportSVG;
  $('btnCrop').onclick = startCrop;
  $('cropApply').onclick = () => endCrop(true);
  $('cropCancel').onclick = () => endCrop(false);
  $('cropReset').onclick = () => { state.crop.quad = [[0, 0], [1, 0], [1, 1], [0, 1]]; draw(); };
  for (const b of document.querySelectorAll('[data-rot]')) b.onclick = () => { if (!state.src) return; state.rot = (state.rot + +b.dataset.rot + 4) % 4; state.quad = null; clearEdits(false); rebuildWork(true); };
  $('btnFlip').onclick = () => { if (!state.src) return; state.flip = !state.flip; state.quad = null; clearEdits(false); rebuildWork(true); };
  $('res').addEventListener('change', () => { state.res = +$('res').value; persist(); rebuildWork(false); });
  $('widthMm').addEventListener('input', () => { const v = parseFloat($('widthMm').value); if (v > 0) { state.widthMm = v; syncSize(); afterSize(); } });
  $('heightMm').addEventListener('input', () => { const v = parseFloat($('heightMm').value); if (v > 0 && state.work) { state.widthMm = v * state.work.w / state.work.h; $('widthMm').value = +state.widthMm.toFixed(2); afterSize(); } });
  for (const id of ['fileInput', 'fileInput2', 'fileInputTop', 'cameraInput']) $(id).addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  for (const b of document.querySelectorAll('[data-sample]')) b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); loadSample(b.dataset.sample); };
  for (const b of document.querySelectorAll('[data-preset]')) b.onclick = () => applyPreset(b.dataset.preset);
  $('btnResetAll').onclick = () => { state.s = { ...DEFAULTS }; state.layerCfg = {}; syncControls(); changed(10); };
  // drag & drop / paste
  const stage = $('stage');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
  stage.addEventListener('drop', (e) => { e.preventDefault(); stage.classList.remove('dragover'); loadFile(e.dataTransfer.files[0]); });
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input,textarea,select')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selText) { $('btnTextDelete').click(); e.preventDefault(); }
    if (e.key === 'Escape') { if (state.crop) endCrop(false); pop.hidden = true; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && state.edits.strokes.length) { $('btnUndoStroke').click(); e.preventDefault(); }
  });
}
let sizeTimer = 0;
function afterSize() {
  persist();
  // only size-dependent features (stencil bridges, borders, text masks) need a re-trace
  if ((state.s.stencil && state.s.mode === 'bw') || state.s.border !== 'none') { clearTimeout(sizeTimer); sizeTimer = setTimeout(run, 200); }
  else { renderStats(); renderLegend(); }
  draw();
}
function updateStageBar() { $('stage').classList.toggle('has-bar', !$('brushBar').hidden || !$('cropBar').hidden); $('stage').classList.toggle('cropping', !!state.crop); }

const PRESETS = {
  pen: { mode: 'bw', traceMode: 'outline', flatten: 50, threshMode: 'auto', blur: 1, detail: 60, smooth: 50, closeGaps: 0, thicken: 0, fillHoles: false, stencil: false },
  pencil: { mode: 'bw', traceMode: 'outline', flatten: 70, threshMode: 'adaptive', adaptiveOffset: 10, blur: 1.5, detail: 50, smooth: 60, closeGaps: 2, thicken: 1, fillHoles: false, stencil: false },
  single: { mode: 'bw', traceMode: 'centerline', flatten: 50, threshMode: 'auto', blur: 1.5, detail: 55, smooth: 60, closeGaps: 1.5, thicken: 0, fillHoles: false, stencil: false },
  solid: { mode: 'bw', traceMode: 'outline', flatten: 50, threshMode: 'auto', blur: 1, detail: 50, smooth: 60, closeGaps: 2, thicken: 0, fillHoles: true, stencil: false },
  stencil: { mode: 'bw', traceMode: 'outline', flatten: 50, threshMode: 'auto', blur: 1.5, detail: 40, smooth: 45, closeGaps: 0, thicken: 1, fillHoles: false, stencil: true },
  colour: { mode: 'color', traceMode: 'outline', colors: 4, colorBlur: 1.5, detail: 50, smooth: 55, closeGaps: 0, thicken: 0, fillHoles: false, stencil: false },
};
function applyPreset(name) {
  Object.assign(state.s, PRESETS[name]);
  state.layerCfg = {};
  syncControls(); changed(10);
  toast('Preset: ' + document.querySelector(`[data-preset="${name}"]`).textContent);
}
function loadSample(which) {
  const cv = which === 'colour' ? makeColour() : makeSketch();
  if (which === 'colour') Object.assign(state.s, PRESETS.colour, { colors: 5 });
  else if (state.s.mode === 'color') Object.assign(state.s, PRESETS.pen);
  syncControls(); persist();
  setSource(cv, cv.width, cv.height, which === 'colour' ? 'sample-colour.png' : 'sample-sketch.jpg');
}

// ---------------- toast ----------------
let toastEl = null, toastTimer = 0;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#26231f;color:#ece6dc;border:1px solid #36322c;border-radius:8px;padding:8px 14px;font:13px var(--sans);z-index:99;box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:90vw;text-align:center'; document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

// ---------------- boot ----------------
fillFontSelect();
bindControls();
bindText();
syncControls();
resize();
// handy for debugging / tests
window.laserTrace = { state, loadSample, exportSVG, buildSVGString: () => { const layers = exportLayers(); const bb = pathsBBox(layers.flatMap((l) => l.paths.flat())); return bb && buildSVG({ width: bb.x1 - bb.x0, height: bb.y1 - bb.y0, layers: layers.map((l) => ({ ...l, paths: l.paths.map((g) => g.map((p) => transformPath(p, 1, 1, -bb.x0, -bb.y0))) })) }); }, addText, applyPreset, run };
