// node test/run.mjs — core image/trace/svg tests (no browser needed)
import * as I from '../js/imageops.js';
import { traceOutlines, skeletonize, traceSkeleton, vectorize, pathLength, pathsBBox, pathData } from '../js/trace.js';
import { Pipeline, DEFAULTS, traceFilled } from '../js/pipeline.js';
import { buildSVG } from '../js/svg.js';
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };
const section = (s) => console.log('• ' + s);

// --- helpers to draw into masks / rgba ---
const blank = (w, h) => new Uint8Array(w * h);
const disk = (m, w, cx, cy, r, v = 1) => { for (let y = 0; y < m.length / w; y++) for (let x = 0; x < w; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) m[y * w + x] = v; };
const rect = (m, w, x0, y0, x1, y1, v = 1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = v; };
const thickLine = (m, w, ax, ay, bx, by, r) => { const n = Math.ceil(Math.hypot(bx - ax, by - ay)); for (let i = 0; i <= n; i++) disk(m, w, ax + (bx - ax) * i / n, ay + (by - ay) * i / n, r); };
const maskToRGBA = (m, w, h, ink = [30, 30, 30], paper = [235, 230, 220]) => { const a = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { const c = m[i] ? ink : paper; a.set([...c, 255], i * 4); } return a; };
const tp = { cornerDeg: 60, smooth: 2, eps: 1, fitErr: 1, curves: true, speck: 4, spur: 6 };

section('outline tracing');
{
  const w = 40, h = 40, m = blank(w, h);
  rect(m, w, 10, 10, 30, 30);
  const loops = traceOutlines(m, w, h);
  ok(loops.length === 1, 'square → 1 loop');
  ok(!loops[0].hole && loops[0].area === 400, 'square loop is outer with area 400 (got ' + loops[0].area + ')');
  const v = vectorize(loops[0], { ...tp, curves: false });
  ok(v.segs.length === 3 || v.segs.length === 4, 'square simplifies to 4 corners (got ' + (v.segs.length + 1) + ' nodes)');
  const bb = pathsBBox([v]);
  ok(bb.x0 === 10 && bb.y0 === 10 && bb.x1 === 30 && bb.y1 === 30, 'square bbox exact');
  const vc = vectorize(loops[0], tp);
  const bbc = pathsBBox([vc]);
  ok(Math.abs(bbc.x0 - 10) < 0.6 && Math.abs(bbc.x1 - 30) < 0.6, 'curve mode keeps square corners');
}
{
  const w = 60, h = 60, m = blank(w, h);
  disk(m, w, 30, 30, 20); disk(m, w, 30, 30, 10, 0);
  const loops = traceOutlines(m, w, h);
  ok(loops.length === 2 && loops.filter((l) => l.hole).length === 1, 'ring → outer + hole');
  const groups = traceFilled(m, w, h, tp);
  ok(groups.length === 1 && groups[0].length === 2, 'ring grouped as one shape with its hole');
  const outer = groups[0][1];
  const L = pathLength(outer);
  ok(Math.abs(L - 2 * Math.PI * 20) < 4, `ring outer length ≈ 2π·20 (got ${L.toFixed(1)})`);
  ok(outer.segs.length < 16, `circle fits with few curves (got ${outer.segs.length})`);
}
{
  // diagonal-touching pixels are separate shapes (no zero-width pinch)
  const w = 6, h = 6, m = blank(w, h);
  m[2 * w + 2] = 1; m[3 * w + 3] = 1;
  ok(traceOutlines(m, w, h).length === 2, 'diagonal pixels → 2 separate loops');
  rect(m, w, 0, 0, 6, 6); m[2 * w + 2] = 0; m[3 * w + 3] = 0;
  const L = traceOutlines(m, w, h);
  ok(L.filter((l) => l.hole).length === 1, 'diagonal holes join as one hole when ink is 4-connected (got ' + L.filter((l) => l.hole).length + ')');
}

section('centerline');
{
  const w = 120, h = 60, m = blank(w, h);
  thickLine(m, w, 10, 30, 110, 30, 4);
  const sk = skeletonize(m, w, h);
  const strokes = traceSkeleton(sk, w, h, { spur: 6, minLen: 3 });
  ok(strokes.length === 1, 'thick line → 1 stroke (got ' + strokes.length + ')');
  const v = vectorize(strokes[0], tp);
  const L = pathLength(v);
  ok(L > 85 && L < 105, `stroke length ≈ 100 (got ${L.toFixed(1)})`);
  ok(v.segs.length <= 3, `straight stroke has few segments (got ${v.segs.length})`);
}
{
  const w = 100, h = 100, m = blank(w, h);
  thickLine(m, w, 10, 50, 90, 50, 3); thickLine(m, w, 50, 10, 50, 90, 3);
  const strokes = traceSkeleton(skeletonize(m, w, h), w, h, { spur: 6, minLen: 3 });
  ok(strokes.length === 4, 'plus sign → 4 arms (got ' + strokes.length + ')');
}
{
  const w = 80, h = 80, m = blank(w, h);
  disk(m, w, 40, 40, 30); disk(m, w, 40, 40, 25, 0);
  const strokes = traceSkeleton(skeletonize(m, w, h), w, h, { spur: 6, minLen: 3 });
  ok(strokes.length === 1 && strokes[0].closed, 'circle outline → 1 closed stroke');
}

section('cleanup');
{
  const w = 50, h = 50, m = blank(w, h);
  rect(m, w, 10, 10, 40, 40); m[2 * w + 2] = 1; m[20 * w + 20] = 0;
  const d = I.despeckle(m, w, h, 4, 4);
  ok(!d[2 * w + 2] && d[20 * w + 20], 'despeckle removes dot and fills pinhole');
  const r = blank(w, h); rect(r, w, 10, 10, 40, 40); rect(r, w, 15, 15, 35, 35, 0);
  const f = I.fillHoles(r, w, h);
  ok(I.countInk(f) === 900, 'fillHoles fills the frame centre');
  const dl = I.dilate(m, w, h, 2), er = I.erode(dl, w, h, 2);
  ok(I.countInk(dl) > I.countInk(m) && Math.abs(I.countInk(er) - I.countInk(I.despeckle(m, w, h, 4, 4))) < 30, 'dilate/erode roughly invert');
}

section('stencil bridges');
{
  const w = 80, h = 80, m = blank(w, h);
  disk(m, w, 40, 40, 30); disk(m, w, 40, 40, 15, 0); // an "O": material island in the middle
  const before = I.components(m, w, h, 0, 4);
  ok(before.touches.filter((t) => !t).length === 1, 'O has one floating island');
  const { mask, bridges } = I.stencilBridges(m, w, h, 3, 'v');
  const after = I.components(mask, w, h, 0, 4);
  ok(after.touches.every((t) => t), 'bridges tie every island to the sheet');
  ok(bridges === 2, 'two bridges for one island (got ' + bridges + ')');
}

section('threshold / colour');
{
  const w = 64, h = 64, g = new Float32Array(w * h).fill(220);
  for (let i = 0; i < 800; i++) g[i] = 40;
  const t = I.otsu(g);
  ok(t > 40 && t < 220, 'otsu between ink and paper (' + t + ')');
  // uneven lighting: dark corner should not become ink after flattening
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = Math.min(g[y * w + x], 220 - x * 2);
  const flat = I.flattenBackground(g, w, h, 16);
  ok(flat[h * w - 1] > 180 && flat[5 * w + 5] < 100, 'flattenBackground lifts the shaded paper, keeps ink dark');
}
{
  const w = 60, h = 30, rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = x < 20 ? [240, 240, 235] : x < 40 ? [200, 30, 30] : [20, 40, 160];
    rgba.set([...c, 255], (y * w + x) * 4);
  }
  const km = I.kmeansColors(rgba, w, h, 3);
  ok(km.centers.length === 3, 'three colour clusters');
  ok(km.centers[2].r > 220, 'clusters sorted dark → light (paper last)');
  const counts = km.centers.map((c) => c.count).sort();
  ok(counts.every((c) => c === 600), 'each colour region is one cluster');
}

section('perspective');
{
  const q = [[10, 20], [110, 10], [120, 90], [5, 100]];
  const H = I.homographyFromUnit(q);
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => I.applyH(H, u, v));
  ok(corners.every((c, i) => Math.hypot(c[0] - q[i][0], c[1] - q[i][1]) < 1e-6), 'homography maps unit square to the quad');
}

section('pipeline + svg');
{
  const w = 200, h = 120, m = blank(w, h);
  thickLine(m, w, 20, 60, 180, 60, 5); disk(m, w, 60, 40, 15); disk(m, w, 60, 40, 7, 0);
  const rgba = maskToRGBA(m, w, h);
  const p = new Pipeline();
  const s = { ...DEFAULTS };
  const r = p.run({ rgba, w, h, id: 'a' }, s, { mmPerPx: 0.5 });
  ok(r.layers.length === 1 && r.layers[0].paths.length >= 1, 'b/w pipeline produces an ink layer');
  const r2 = p.run({ rgba, w, h, id: 'a' }, { ...s, traceMode: 'centerline' }, { mmPerPx: 0.5 });
  ok(r2.layers[0].mode === 'line' && r2.layers[0].paths.length >= 2, 'centerline mode gives line strokes');
  const r3 = p.run({ rgba, w, h, id: 'a' }, { ...s, stencil: true }, { mmPerPx: 0.5 });
  ok(r3.layers.some((l) => l.key === 'frame') && r3.info.bridges >= 2, 'stencil adds frame and bridges');
  const r4 = p.run({ rgba, w, h, id: 'a' }, { ...s, border: 'contour', borderMm: 3 }, { mmPerPx: 0.5 });
  const border = r4.layers.find((l) => l.key === 'border');
  ok(border && border.paths.length === 1, 'contour border is one outline around the design');
  const scale = 0.5;
  const layers = r4.layers.map((l) => ({ name: l.name, color: l.color, mode: l.mode, paths: l.paths.map((g) => g.map((q) => ({ closed: q.closed, start: [q.start[0] * scale, q.start[1] * scale], segs: q.segs.map((sg) => [sg[0], ...sg.slice(1).map((v) => v * scale)]) }))) }));
  const svg = buildSVG({ width: w * scale, height: h * scale, layers });
  ok(svg.includes('width="100mm"') && svg.includes('viewBox="0 0 100 60"'), 'svg is in millimetres');
  ok(svg.includes('fill="#000000"') && svg.includes('stroke="#FF0000"'), 'svg uses LightBurn colours (black fill, red cut)');
  ok(!/NaN|undefined/.test(svg), 'svg has no NaN/undefined');
  fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL('./out/pipeline.svg', import.meta.url), svg);
  const rc = p.run({ rgba, w, h, id: 'a' }, { ...s, mode: 'color', colors: 2 }, { mmPerPx: 0.5 });
  ok(rc.layers.length === 2, 'colour mode gives one layer per colour');
}

section('speed');
{
  const w = 1600, h = 1200, m = blank(w, h);
  for (let i = 0; i < 40; i++) thickLine(m, w, 100 + i * 35, 100, 300 + i * 30, 1100, 3 + (i % 4));
  for (let i = 0; i < 20; i++) { disk(m, w, 200 + i * 60, 600, 25); disk(m, w, 200 + i * 60, 600, 15, 0); }
  const rgba = maskToRGBA(m, w, h);
  let t = performance.now();
  const p = new Pipeline();
  const r = p.run({ rgba, w, h, id: 'big' }, { ...DEFAULTS }, { mmPerPx: 0.1 });
  const tOut = performance.now() - t;
  t = performance.now();
  p.run({ rgba, w, h, id: 'big' }, { ...DEFAULTS, traceMode: 'centerline' }, { mmPerPx: 0.1 });
  const tCen = performance.now() - t;
  console.log(`  1600×1200: outline ${tOut.toFixed(0)} ms (${r.layers[0].paths.length} shapes), centerline ${tCen.toFixed(0)} ms`);
  ok(tOut < 6000 && tCen < 6000, 'full pipeline runs in a few seconds');
  ok(!/NaN/.test(pathData(r.layers[0].paths.flat())), 'no NaN in big trace');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
