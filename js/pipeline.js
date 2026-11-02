// Settings → masks → vector layers. Pure (no DOM); each stage is memoised so
// dragging one slider only redoes the stages after it.
import * as I from './imageops.js';
import { traceOutlines, skeletonize, traceSkeleton, vectorize, rectPath, ellipsePath } from './trace.js';

const lerp = (a, b, t) => a + (b - a) * t;

// Derived tracing parameters from the friendly 0–100 sliders.
export function traceParams(s, M) {
  const d = s.detail / 100, sm = s.smooth / 100;
  return {
    speck: Math.round((1 - d) ** 2 * M * M * 0.0004 + 2),          // px²
    eps: lerp(3, 0.35, d),                                           // px
    spur: Math.round(lerp(M * 0.012, 2, d)),                         // px
    curves: sm > 0.02,
    cornerDeg: lerp(30, 120, sm),
    smooth: Math.round(lerp(0, 4, sm)),
    fitErr: lerp(0.45, 2.2, sm) * lerp(1.4, 0.8, d),
  };
}

export const DEFAULTS = {
  mode: 'bw',              // 'bw' | 'color'
  flatten: 50,             // even out lighting, 0 = off
  brightness: 0, contrast: 0, blur: 1,
  threshMode: 'auto',      // 'auto' | 'manual' | 'adaptive'
  threshold: 128, adaptiveOffset: 12,
  invert: false,
  closeGaps: 0, thicken: 0, fillHoles: false,
  traceMode: 'outline',    // 'outline' | 'centerline'
  detail: 60, smooth: 50,
  colors: 3, colorBlur: 1.5,
  stencil: false, bridgeMm: 1.5, bridgeDir: 'v', stencilMarginMm: 8,
  border: 'none', borderMm: 3, borderRadiusMm: 6, borderColor: 2, borderJoin: true,
};

// LightBurn's palette (kept here too so the pipeline has no DOM/svg dependency).
const LB = ['000000', '0000FF', 'FF0000', '00E000', 'D0D000', 'FF8000', '00E0E0', 'FF00FF', 'B4B4B4', '0000A0',
  'A00000', '00A000', 'A0A000', 'C08000', '00A0FF', 'A000A0', '808080', '7D87B9', 'BB7784', '4A6FE3',
  'D33F6A', '8CD78C', 'F0B98D', 'F6C4E1', 'FA9ED4', '500A78', 'B45A00', '004754', '86FA88', 'FFDB66']
  .map((h) => I.rgbToLab(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4), 16)));

// Give each colour cluster the closest LightBurn colour, never reusing one and
// never taking the cut colour (so cuts stay on their own layer).
function clusterColors(sources, cutColor) {
  const used = new Set([cutColor]);
  const out = [];
  for (const src of sources) {
    const L = I.rgbToLab(...src.swatch);
    let best = -1, bd = Infinity;
    LB.forEach((c, i) => {
      if (used.has(i)) return;
      const d = (c[0] - L[0]) ** 2 + (c[1] - L[1]) ** 2 + (c[2] - L[2]) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    used.add(best); out.push(best);
  }
  return out;
}
export function layerDefaults(src, sources, s) {
  if (src.key === 'ink') return { color: 0, mode: 'fill', enabled: true };
  // the lightest colour covering a big share of the picture is the paper
  const isBg = (x) => sources.indexOf(x) === sources.length - 1 && (x.share || 0) > 0.2;
  const background = isBg(src);
  // colour the visible clusters first so the paper doesn't take a good match
  const visible = sources.filter((x) => !isBg(x));
  const color = background ? clusterColors([...visible, src], s.borderColor)[visible.length]
    : clusterColors(visible, s.borderColor)[visible.indexOf(src)];
  return { color, mode: 'fill', enabled: !background, background };
}

const keyOf = (o, keys) => keys.map((k) => JSON.stringify(o[k])).join('|');

export class Pipeline {
  constructor() { this.memo = {}; }
  stage(name, key, fn) {
    const m = this.memo[name];
    if (m && m.key === key) return m.val;
    const val = fn();
    this.memo[name] = { key, val };
    return val;
  }
  reset() { this.memo = {}; }

  // input: { rgba, w, h, id }   (id changes whenever the working image changes)
  // extras: { edits: {erase, ink, version}, textMask, textVersion, mmPerPx, layerCfg }
  run(input, s, extras = {}) {
    const { rgba, w, h, id } = input;
    const M = Math.max(w, h);
    const tp = traceParams(s, M);
    const mmPerPx = extras.mmPerPx || 0.1;
    const edits = extras.edits || null;
    const ev = edits ? edits.version : 0;
    const out = { w, h, layers: [], info: {} };

    // ---------- masks ----------
    let sources; // [{key, name, mask, swatch}]
    if (s.mode === 'bw') {
      const gray = this.stage('gray', keyOf(s, ['flatten', 'brightness', 'contrast', 'blur']) + id, () => {
        let g = I.toGray(rgba, w, h);
        if (s.flatten > 0) g = I.flattenBackground(g, w, h, Math.round(lerp(M * 0.02, M * 0.12, s.flatten / 100)));
        if (s.blur > 0) g = I.gaussBlur(g, w, h, s.blur * M / 1600);
        if (s.brightness || s.contrast) g = I.adjust(g, s);
        return g;
      });
      out.gray = gray;
      const raw = this.stage('thresh', keyOf(s, ['flatten', 'brightness', 'contrast', 'blur', 'threshMode', 'threshold', 'adaptiveOffset', 'invert']) + id, () => {
        let t = s.threshold, m;
        if (s.threshMode === 'auto') { t = I.otsu(gray); m = I.threshold(gray, t); }
        else if (s.threshMode === 'adaptive') m = I.adaptiveThreshold(gray, w, h, Math.max(4, Math.round(M * 0.02)), s.adaptiveOffset);
        else m = I.threshold(gray, t);
        if (s.invert) m = I.invert(m);
        return { m, t };
      });
      out.info.threshold = raw.t;
      const mask = this.stage('clean', keyOf(s, ['flatten', 'brightness', 'contrast', 'blur', 'threshMode', 'threshold', 'adaptiveOffset', 'invert', 'closeGaps', 'thicken', 'fillHoles', 'detail']) + id + '|' + ev, () => {
        let m = raw.m;
        const px = (v) => v * M / 1600; // slider units are px at 1600 px working size
        if (s.closeGaps > 0) m = I.closeGaps(m, w, h, px(s.closeGaps));
        if (s.thicken) m = I.morph(m, w, h, px(s.thicken));
        m = I.despeckle(m, w, h, tp.speck, tp.speck);
        if (s.fillHoles) m = I.fillHoles(m, w, h);
        if (edits) for (let i = 0; i < m.length; i++) { if (edits.erase[i]) m[i] = 0; else if (edits.ink[i]) m[i] = 1; }
        return m;
      });
      sources = [{ key: 'ink', name: 'Ink', mask, swatch: [20, 20, 20] }];
    } else {
      const km = this.stage('kmeans', keyOf(s, ['colors', 'colorBlur']) + id, () => {
        const blurred = I.blurRGBA(rgba, w, h, s.colorBlur * M / 1600);
        return I.kmeansColors(blurred, w, h, s.colors);
      });
      out.clusters = km;
      sources = this.stage('cmasks', keyOf(s, ['colors', 'colorBlur', 'detail', 'closeGaps', 'thicken', 'fillHoles']) + id + '|' + ev + '|' + (extras.paintTarget ?? ''), () => km.centers.map((c, l) => {
        let m = I.maskOfLabel(km.labels, l);
        const px = (v) => v * M / 1600;
        if (s.closeGaps > 0) m = I.closeGaps(m, w, h, px(s.closeGaps));
        if (s.thicken) m = I.morph(m, w, h, px(s.thicken));
        m = I.despeckle(m, w, h, tp.speck, tp.speck);
        if (s.fillHoles) m = I.fillHoles(m, w, h);
        if (edits) {
          const target = extras.paintTarget ?? -1;
          for (let i = 0; i < m.length; i++) { if (edits.erase[i]) m[i] = 0; else if (edits.ink[i]) m[i] = l === target ? 1 : 0; }
        }
        return { key: 'c' + l, name: `Colour ${l + 1}`, mask: m, swatch: [c.r, c.g, c.b], share: c.count / (w * h) };
      }));
    }
    out.sources = sources;

    // ---------- stencil ----------
    let stencilInfo = null;
    if (s.mode === 'bw' && s.stencil) {
      const tm = extras.textMask;
      const st = this.stage('stencil', keyOf(s, ['bridgeMm', 'bridgeDir', 'stencilMarginMm']) + (extras.textVersion || '') + mmPerPx + '|' + this.memo.clean.key, () => {
        // the sheet covers the photo plus any text placed beside it
        const rx0 = Math.min(0, tm ? tm.ox : 0), ry0 = Math.min(0, tm ? tm.oy : 0);
        const rx1 = Math.max(w, tm ? tm.ox + tm.w : 0), ry1 = Math.max(h, tm ? tm.oy + tm.h : 0);
        const RW = rx1 - rx0, RH = ry1 - ry0, ox = -rx0, oy = -ry0;
        const m = new Uint8Array(RW * RH);
        const src = sources[0].mask;
        for (let y = 0; y < h; y++) m.set(src.subarray(y * w, y * w + w), (y + oy) * RW + ox);
        if (tm) for (let y = 0; y < tm.h; y++) for (let x = 0; x < tm.w; x++) if (tm.m[y * tm.w + x]) m[(y + tm.oy + oy) * RW + x + tm.ox + ox] = 1;
        const b = I.stencilBridges(m, RW, RH, Math.max(1, s.bridgeMm / mmPerPx), s.bridgeDir, true);
        // image-sized copy for the mask preview
        const view = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) view.set(b.mask.subarray((y + oy) * RW + ox, (y + oy) * RW + ox + w), y * w);
        return { mask: view, region: { m: b.mask, w: RW, h: RH, ox, oy }, bridges: b.bridges };
      });
      sources = [{ ...sources[0], mask: st.mask, region: st.region, stencil: true }];
      stencilInfo = st;
      out.info.bridges = st.bridges;
    }

    // ---------- tracing ----------
    const cfg = extras.layerCfg || {};
    const traceKey = keyOf(s, ['traceMode', 'detail', 'smooth']);
    for (const src of sources) {
      const c = { ...layerDefaults(src, sources, s), ...(cfg[src.key] || {}) };
      if (c.enabled === false) { out.layers.push({ ...src, enabled: false, paths: [], color: c.color, mode: c.mode, background: c.background }); continue; }
      const centerline = s.traceMode === 'centerline' && !src.stencil;
      const paths = this.stage('trace-' + src.key, traceKey + '|' + (centerline ? 'c' : 'o') + '|' + this.memoKeyFor(src), () => {
        if (src.region) {
          const R = src.region;
          return traceFilled(R.m, R.w, R.h, tp).map((g) => g.map((p) => shiftPath(p, -R.ox, -R.oy)));
        }
        return centerline ? traceCenter(src.mask, w, h, tp) : traceFilled(src.mask, w, h, tp);
      });
      let mode = c.mode, color = c.color;
      if (centerline) mode = 'line';
      if (src.stencil) { mode = 'line'; color = s.borderColor; }
      out.layers.push({ ...src, enabled: true, paths, mode, color, centerline, background: c.background });
    }

    // ---------- stencil frame / border ----------
    if (stencilInfo) {
      const m = s.stencilMarginMm / mmPerPx, R = stencilInfo.region;
      const f = { x0: -R.ox - m, y0: -R.oy - m, x1: R.w - R.ox + m, y1: R.h - R.oy + m };
      out.frame = f;
      out.layers.push({ key: 'frame', name: 'Stencil frame', enabled: true, mode: 'line', color: s.borderColor,
        paths: [[rectPath(f.x0, f.y0, f.x1, f.y1, 0)]] });
    } else if (s.border !== 'none') {
      const enabledMasks = out.layers.filter((l) => l.enabled && l.mask).map((l) => l.mask);
      const off = s.borderMm / mmPerPx;
      const bkey = keyOf(s, ['border', 'borderMm', 'borderRadiusMm', 'borderJoin', 'detail', 'smooth']) + mmPerPx + '|' + out.layers.map((l) => l.enabled ? this.memoKeyFor(l) : '-').join(',') + (extras.textVersion || '');
      const border = this.stage('border', bkey, () => makeBorder(enabledMasks, extras.textMask, w, h, s, off, s.borderRadiusMm / mmPerPx, tp));
      if (border) {
        out.frame = border.box;
        out.layers.push({ key: 'border', name: 'Cut border', enabled: true, mode: 'line', color: s.borderColor, paths: border.paths });
      }
    }
    return out;
  }
  memoKeyFor(src) {
    // identity of a mask = the memo stage that produced it
    if (src.key === 'ink') return (this.memo.stencil && src.stencil ? this.memo.stencil.key : this.memo.clean?.key) || '';
    return (this.memo.cmasks?.key || '') + src.key;
  }
}

// Group outlines into [outer, ...holes] per 4-connected ink component.
export function traceFilled(mask, w, h, tp) {
  const loops = traceOutlines(mask, w, h);
  const comp = I.components(mask, w, h, 1, 4);
  const groups = new Map();
  for (const lp of loops) {
    const [x, y] = lp.pts[0], [x2, y2] = lp.pts[1] || lp.pts[0];
    const d = x2 > x ? 0 : y2 > y ? 1 : x2 < x ? 2 : 3;
    const px = d === 0 ? x : d === 1 ? x - 1 : d === 2 ? x - 1 : x;
    const py = d === 0 ? y : d === 1 ? y : d === 2 ? y - 1 : y - 1;
    const label = comp.labels[py * w + px];
    if (!groups.has(label)) groups.set(label, { outer: null, holes: [] });
    const g = groups.get(label);
    const v = vectorize(lp, tp);
    if (lp.hole) g.holes.push(v); else g.outer = v;
  }
  const out = [];
  for (const g of groups.values()) {
    // holes first so LightBurn cuts the inside before the part drops out
    if (g.outer) out.push([...g.holes, g.outer]);
  }
  return out;
}

export function traceCenter(mask, w, h, tp) {
  const skel = skeletonize(mask, w, h);
  const strokes = traceSkeleton(skel, w, h, { spur: tp.spur, minLen: Math.max(3, tp.spur / 2) });
  return strokes.map((s) => [vectorize(s, { ...tp, cornerDeg: Math.max(tp.cornerDeg, 50) })]);
}

const shiftPath = (p, dx, dy) => ({ closed: p.closed, start: [p.start[0] + dx, p.start[1] + dy],
  segs: p.segs.map((q) => q[0] === 'L' ? ['L', q[1] + dx, q[2] + dy] : ['C', q[1] + dx, q[2] + dy, q[3] + dx, q[4] + dy, q[5] + dx, q[6] + dy]) });

// Text masks come as { m, ox, oy, w, h } in working-image pixels (ox/oy may be
// negative: text can sit outside the photo).
function makeBorder(masks, tm, w, h, s, off, radius, tp) {
  if (!masks.length && !tm) return null;
  // work in a region covering the photo and any text, padded so the grown shape fits
  const pad = Math.ceil(off) + 2;
  const rx0 = Math.min(0, tm ? tm.ox : 0), ry0 = Math.min(0, tm ? tm.oy : 0);
  const rx1 = Math.max(w, tm ? tm.ox + tm.w : 0), ry1 = Math.max(h, tm ? tm.oy + tm.h : 0);
  const ox = pad - rx0, oy = pad - ry0; // region pixel = image pixel + (ox, oy)
  const W = rx1 - rx0 + pad * 2, H = ry1 - ry0 + pad * 2;
  const m = new Uint8Array(W * H);
  for (const src of masks) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (src[y * w + x]) m[(y + oy) * W + x + ox] = 1;
  if (tm) for (let y = 0; y < tm.h; y++) for (let x = 0; x < tm.w; x++) if (tm.m[y * tm.w + x]) m[(y + tm.oy + oy) * W + x + tm.ox + ox] = 1;
  const bb = I.bbox(m, W, H);
  if (!bb) return null;
  const box = { x0: bb.x0 - ox - off, y0: bb.y0 - oy - off, x1: bb.x1 - ox + off, y1: bb.y1 - oy + off };
  if (s.border === 'rect' || s.border === 'round') {
    return { box, paths: [[rectPath(box.x0, box.y0, box.x1, box.y1, s.border === 'round' ? radius : 0)]] };
  }
  if (s.border === 'circle') {
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    // circle that encloses every ink pixel + offset
    let r = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) {
      const dx = Math.max(Math.abs(x - ox - cx), Math.abs(x + 1 - ox - cx)), dy = Math.max(Math.abs(y - oy - cy), Math.abs(y + 1 - oy - cy));
      r = Math.max(r, Math.hypot(dx, dy));
    }
    r += off;
    return { box: { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r }, paths: [[ellipsePath(cx, cy, r, r)]] };
  }
  // contour: grow the design, fill it in, trace only the outside
  let g = I.dilate(m, W, H, off);
  g = I.fillHoles(g, W, H);
  if (s.borderJoin) {
    // bridge separate pieces into one shape: close with a growing radius until it's one piece
    let r = Math.max(4, off * 2);
    for (let it = 0; it < 12 && I.components(g, W, H, 1, 4).count > 1; it++) {
      g = I.fillHoles(I.closeGaps(g, W, H, r), W, H);
      r *= 1.5;
    }
  }
  const loops = traceOutlines(g, W, H).filter((l) => !l.hole);
  const paths = loops.map((l) => {
    const v = vectorize(l, { ...tp, curves: true, cornerDeg: 150, smooth: Math.max(tp.smooth, 3), fitErr: Math.max(tp.fitErr, 1.2) });
    return [{ closed: v.closed, start: [v.start[0] - ox, v.start[1] - oy], segs: v.segs.map((q) => q[0] === 'L' ? ['L', q[1] - ox, q[2] - oy] : ['C', q[1] - ox, q[2] - oy, q[3] - ox, q[4] - oy, q[5] - ox, q[6] - oy]) }];
  });
  const gb = I.bbox(g, W, H);
  return { box: { x0: gb.x0 - ox, y0: gb.y0 - oy, x1: gb.x1 - ox, y1: gb.y1 - oy }, paths };
}
