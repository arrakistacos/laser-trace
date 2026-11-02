// LightBurn-ready SVG writer. LightBurn puts every distinct colour from an SVG
// onto the layer with that palette colour, so each output layer here is one
// palette colour.
import { pathData } from './trace.js';

// LightBurn's 30 layer colours (C00–C29).
export const PALETTE = [
  '#000000', '#0000FF', '#FF0000', '#00E000', '#D0D000', '#FF8000', '#00E0E0', '#FF00FF', '#B4B4B4', '#0000A0',
  '#A00000', '#00A000', '#A0A000', '#C08000', '#00A0FF', '#A000A0', '#808080', '#7D87B9', '#BB7784', '#4A6FE3',
  '#D33F6A', '#8CD78C', '#F0B98D', '#F6C4E1', '#FA9ED4', '#500A78', '#B45A00', '#004754', '#86FA88', '#FFDB66',
];
export const paletteName = (i) => 'C' + String(i).padStart(2, '0');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// layers: [{ name, color: paletteIndex, mode: 'fill'|'line', paths:[vector paths in mm] }]
// Paths are written in millimetres; the viewBox is the page in mm.
export function buildSVG({ width, height, layers, title = 'Laser Trace' }) {
  const W = +width.toFixed(3), H = +height.toFixed(3);
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  out += `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">\n`;
  out += `<title>${esc(title)}</title>\n`;
  for (const L of layers) {
    if (!L.paths.length) continue;
    const col = PALETTE[L.color];
    const id = `${paletteName(L.color)}-${L.name}`.replace(/[^A-Za-z0-9_-]+/g, '_');
    // style goes on every path (not just the group) — importers differ on inheritance.
    // Fills also carry a stroke in the same colour so the layer is picked up either way.
    const style = L.mode === 'fill'
      ? `fill="${col}" fill-rule="evenodd" stroke="${col}" stroke-width="0.05"`
      : `fill="none" stroke="${col}" stroke-width="0.1" stroke-linejoin="round" stroke-linecap="round"`;
    out += `<g id="${esc(id)}">\n`;
    // one <path> per shape (outline + its holes) keeps LightBurn's node editing manageable
    for (const group of groupForOutput(L.paths, L.mode)) out += `<path ${style} d="${pathData(group)}"/>\n`;
    out += `</g>\n`;
  }
  out += `</svg>\n`;
  return out;
}

// For fills, holes must stay in the same <path> as their outer shape for
// even-odd filling. Paths arrive already grouped (outer followed by its holes)
// as arrays; plain paths are written one per element.
function groupForOutput(paths, mode) {
  const groups = [];
  for (const p of paths) groups.push(Array.isArray(p) ? p : [p]);
  if (mode === 'line') return groups.flat().map((p) => [p]);
  return groups;
}
