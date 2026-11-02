// Text → vector outlines (in mm) using opentype.js and the bundled open-licence fonts.
import opentype from '../vendor/opentype.module.js';
import { traceFilled } from './pipeline.js';
import { pathsBBox } from './trace.js';

export const FONTS = [
  { id: 'archivo', name: 'Archivo Black', file: 'ArchivoBlack.ttf', kind: 'Bold sans' },
  { id: 'anton', name: 'Anton', file: 'Anton.ttf', kind: 'Condensed' },
  { id: 'bebas', name: 'Bebas Neue', file: 'BebasNeue.ttf', kind: 'Condensed caps' },
  { id: 'oswald', name: 'Oswald', file: 'Oswald.ttf', kind: 'Condensed' },
  { id: 'righteous', name: 'Righteous', file: 'Righteous.ttf', kind: 'Rounded display' },
  { id: 'bungee', name: 'Bungee', file: 'Bungee.ttf', kind: 'Signage' },
  { id: 'abril', name: 'Abril Fatface', file: 'AbrilFatface.ttf', kind: 'Heavy serif' },
  { id: 'playfair', name: 'Playfair Display', file: 'PlayfairDisplay.ttf', kind: 'Serif' },
  { id: 'cinzel', name: 'Cinzel', file: 'Cinzel.ttf', kind: 'Roman caps' },
  { id: 'elite', name: 'Special Elite', file: 'SpecialElite.ttf', kind: 'Typewriter' },
  { id: 'marker', name: 'Permanent Marker', file: 'PermanentMarker.ttf', kind: 'Marker' },
  { id: 'caveat', name: 'Caveat', file: 'Caveat.ttf', kind: 'Handwriting' },
  { id: 'pacifico', name: 'Pacifico', file: 'Pacifico.ttf', kind: 'Script' },
  { id: 'lobster', name: 'Lobster', file: 'Lobster.ttf', kind: 'Script' },
  { id: 'vibes', name: 'Great Vibes', file: 'GreatVibes.ttf', kind: 'Formal script' },
  { id: 'fraktur', name: 'UnifrakturMaguntia', file: 'UnifrakturMaguntia.ttf', kind: 'Blackletter' },
  { id: 'allerta', name: 'Allerta Stencil', file: 'AllertaStencil.ttf', kind: 'Stencil' },
  { id: 'stardos', name: 'Stardos Stencil', file: 'StardosStencil-Bold.ttf', kind: 'Stencil serif' },
];

const cache = new Map();
export async function loadFont(id) {
  if (cache.has(id)) return cache.get(id);
  const f = FONTS.find((x) => x.id === id);
  if (!f) throw new Error('Unknown font ' + id);
  const p = fetch(new URL(`../vendor/fonts/${f.file}`, import.meta.url)).then((r) => r.arrayBuffer()).then((b) => opentype.parse(b));
  cache.set(id, p);
  return p;
}
export function addFontFromBuffer(buf, fileName) {
  const font = opentype.parse(buf);
  const name = (font.names.fullName && (font.names.fullName.en || Object.values(font.names.fullName)[0])) || fileName;
  const id = 'user-' + name.replace(/\W+/g, '-').toLowerCase();
  if (!FONTS.find((f) => f.id === id)) FONTS.push({ id, name, file: null, kind: 'Your font', user: true });
  cache.set(id, Promise.resolve(font));
  return id;
}

// Glyph commands → our vector paths (quadratics become cubics).
function commandsToPaths(cmds) {
  const paths = [];
  let cur = null, x = 0, y = 0;
  for (const c of cmds) {
    if (c.type === 'M') { if (cur && cur.segs.length) paths.push(cur); cur = { closed: false, start: [c.x, c.y], segs: [] }; x = c.x; y = c.y; }
    else if (c.type === 'L') { cur.segs.push(['L', c.x, c.y]); x = c.x; y = c.y; }
    else if (c.type === 'Q') { cur.segs.push(['C', x + 2 / 3 * (c.x1 - x), y + 2 / 3 * (c.y1 - y), c.x + 2 / 3 * (c.x1 - c.x), c.y + 2 / 3 * (c.y1 - c.y), c.x, c.y]); x = c.x; y = c.y; }
    else if (c.type === 'C') { cur.segs.push(['C', c.x1, c.y1, c.x2, c.y2, c.x, c.y]); x = c.x; y = c.y; }
    else if (c.type === 'Z') {
      if (cur) {
        cur.closed = true;
        // drop a final segment that just returns to the start
        const l = cur.segs[cur.segs.length - 1];
        if (l && l[0] === 'L' && Math.abs(l[1] - cur.start[0]) < 1e-9 && Math.abs(l[2] - cur.start[1]) < 1e-9) cur.segs.pop();
        if (cur.segs.length) paths.push(cur);
        cur = null;
      }
    }
  }
  if (cur && cur.segs.length) paths.push(cur);
  return paths;
}

const mapPath = (p, f) => ({
  closed: p.closed, start: f(p.start[0], p.start[1]),
  segs: p.segs.map((s) => s[0] === 'L' ? ['L', ...f(s[1], s[2])] : ['C', ...f(s[1], s[2]), ...f(s[3], s[4]), ...f(s[5], s[6])]),
});

// item: { text, font, height (mm, capital-letter height), spacing (% of size),
//         lineHeight, align, rotate (deg), x, y (mm, centre), weld }
export function layoutText(item, font) {
  const upm = font.unitsPerEm;
  const cap = (font.tables.os2 && font.tables.os2.sCapHeight) || upm * 0.7;
  const size = item.height / (cap / upm); // font size in mm that gives this cap height
  const scale = size / upm;
  const lines = String(item.text || '').split('\n');
  const glyphPaths = [];
  const widths = [];
  const lineGlyphs = lines.map((line) => {
    const glyphs = font.stringToGlyphs(line);
    let x = 0; const placed = [];
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i];
      placed.push({ g, x });
      x += (g.advanceWidth || 0) * scale + (item.spacing || 0) / 100 * size;
      if (i < glyphs.length - 1) x += font.getKerningValue(g, glyphs[i + 1]) * scale;
    }
    widths.push(Math.max(0, x - (glyphs.length ? (item.spacing || 0) / 100 * size : 0)));
    return placed;
  });
  const maxW = Math.max(0, ...widths);
  lineGlyphs.forEach((placed, li) => {
    const off = item.align === 'left' ? 0 : item.align === 'right' ? maxW - widths[li] : (maxW - widths[li]) / 2;
    const baseline = li * (item.lineHeight || 1.2) * size;
    for (const { g, x } of placed) {
      const cmds = g.getPath(off + x, baseline, size).commands;
      glyphPaths.push(...commandsToPaths(cmds));
    }
  });
  if (!glyphPaths.length) return { paths: [], bbox: null, groups: [] };
  const bb = pathsBBox(glyphPaths);
  const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
  const a = (item.rotate || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const T = (x, y) => { const dx = x - cx, dy = y - cy; return [item.x + dx * ca - dy * sa, item.y + dx * sa + dy * ca]; };
  const paths = glyphPaths.map((p) => mapPath(p, T));
  return { paths, bbox: pathsBBox(paths), groups: [paths] };
}

// Weld: merge overlapping letters (script fonts) into clean single outlines by
// rendering at high resolution and re-tracing.
export function weldPaths(paths, toPath2D, tp) {
  const bb = pathsBBox(paths); if (!bb) return [];
  const span = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0);
  const k = Math.min(40, 2000 / Math.max(span, 1)); // px per mm
  const pad = 4;
  const w = Math.ceil((bb.x1 - bb.x0) * k) + pad * 2, h = Math.ceil((bb.y1 - bb.y0) * k) + pad * 2;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(k, 0, 0, k, pad - bb.x0 * k, pad - bb.y0 * k);
  ctx.fill(toPath2D(paths), 'nonzero');
  const d = ctx.getImageData(0, 0, w, h).data, m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  const groups = traceFilled(m, w, h, { ...tp, curves: true, smooth: 1, cornerDeg: 55, fitErr: 0.6 });
  const back = (x, y) => [(x - pad) / k + bb.x0, (y - pad) / k + bb.y0];
  return groups.map((g) => g.map((p) => mapPath(p, back)));
}

// Rasterise text outlines into a working-image mask (for stencils and contour borders).
export function rasterizeTexts(list, w, h, mmPerPx, toPath2D) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1 / mmPerPx, 0, 0, 1 / mmPerPx, 0, 0);
  for (const paths of list) ctx.fill(toPath2D(paths), 'nonzero');
  const d = ctx.getImageData(0, 0, w, h).data, m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  return m;
}
