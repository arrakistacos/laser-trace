// Bitmap → vector. Outline tracing (filled shapes), centerline tracing
// (single strokes), corner detection and Bézier curve fitting.
//
// A traced path is { closed, pts:[[x,y]...] } (dense, in pixel units) and a
// vector path is { closed, start:[x,y], segs:[['L',x,y] | ['C',x1,y1,x2,y2,x,y]] }.

// ---------- outline tracing ----------
// Follows the pixel-edge boundary between ink and paper. Outer boundaries run
// clockwise on screen, holes counter-clockwise. Diagonal-only contacts are
// split (ink is 4-connected) so outlines never touch themselves.
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
export function traceOutlines(mask, w, h) {
  const W = w + 1;
  const bits = new Uint8Array(W * (h + 1));
  const ink = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    if (!ink(x, y - 1)) bits[y * W + x] |= 1;            // top, → +x
    if (!ink(x + 1, y)) bits[y * W + x + 1] |= 2;        // right, ↓ +y
    if (!ink(x, y + 1)) bits[(y + 1) * W + x + 1] |= 4;  // bottom, ← -x
    if (!ink(x - 1, y)) bits[(y + 1) * W + x] |= 8;      // left, ↑ -y
  }
  const used = new Uint8Array(bits.length);
  const loops = [];
  for (let v0 = 0; v0 < bits.length; v0++) {
    let free = bits[v0] & ~used[v0];
    while (free) {
      let d = 0; while (!(free & (1 << d))) d++;
      const startV = v0, startD = d;
      const pts = [];
      let v = v0, area2 = 0;
      for (let guard = 0; guard < 1e8; guard++) {
        used[v] |= 1 << d;
        const x = v % W, y = (v - x) / W;
        pts.push([x, y]);
        const nx = x + DX[d], ny = y + DY[d];
        area2 += x * ny - nx * y;
        v = ny * W + nx;
        // turn right first (hug the ink), then straight, then left
        const b = bits[v];
        let nd = -1;
        for (const t of [1, 0, 3]) { const c = (d + t) & 3; if (b & (1 << c)) { nd = c; break; } }
        if (nd < 0) break;
        d = nd;
        if (v === startV && d === startD) break;
      }
      loops.push({ closed: true, pts, area: area2 / 2, hole: area2 < 0 });
      free = bits[v0] & ~used[v0];
    }
  }
  return loops;
}

// ---------- centerline (skeleton) tracing ----------
// Zhang–Suen thinning.
export function skeletonize(mask, w, h) {
  const m = Uint8Array.from(mask);
  // clear the border so neighbour lookups stay in range
  for (let x = 0; x < w; x++) { m[x] = 0; m[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { m[y * w] = 0; m[y * w + w - 1] = 0; }
  let active = [];
  for (let i = 0; i < m.length; i++) if (m[i]) active.push(i);
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (const i of active) {
        if (!m[i]) continue;
        const p2 = m[i - w], p3 = m[i - w + 1], p4 = m[i + 1], p5 = m[i + w + 1],
              p6 = m[i + w], p7 = m[i + w - 1], p8 = m[i - 1], p9 = m[i - w - 1];
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
        if (A !== 1) continue;
        if (step === 0) { if (p2 * p4 * p6 || p4 * p6 * p8) continue; }
        else { if (p2 * p4 * p8 || p2 * p6 * p8) continue; }
        del.push(i);
      }
      if (del.length) changed = true;
      for (const i of del) m[i] = 0;
    }
    active = active.filter((i) => m[i]);
  }
  return m;
}

const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

// Turn a 1-px skeleton into polylines. Spurs shorter than `spur` px that hang
// off a junction are pruned; strokes shorter than `minLen` px are dropped.
export function traceSkeleton(skel, w, h, { spur = 6, minLen = 4 } = {}) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && skel[y * w + x] === 1;
  // adjacency as 8-bit masks, dropping diagonal links that are shortcuts
  // across a 4-connected corner (staircase artefacts)
  const adj = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!skel[y * w + x]) continue;
    let b = 0;
    for (let k = 0; k < 8; k++) {
      const [dx, dy] = N8[k];
      if (!at(x + dx, y + dy)) continue;
      if (dx && dy && (at(x + dx, y) || at(x, y + dy))) continue;
      b |= 1 << k;
    }
    adj[y * w + x] = b;
  }
  const deg = (i) => { let b = adj[i], n = 0; while (b) { n += b & 1; b >>= 1; } return n; };
  const visited = new Uint8Array(w * h); // per-direction edge visited bits
  const opp = (k) => (k + 4) & 7;
  const strokes = [];
  const walk = (i0, k0) => {
    const pts = [[i0 % w + 0.5, ((i0 / w) | 0) + 0.5]];
    let i = i0, k = k0;
    for (;;) {
      visited[i] |= 1 << k;
      const x = i % w, y = (i / w) | 0;
      const j = (y + N8[k][1]) * w + x + N8[k][0];
      visited[j] |= 1 << opp(k);
      pts.push([j % w + 0.5, ((j / w) | 0) + 0.5]);
      if (j === i0 || deg(j) !== 2) return { pts, a: i0, b: j, closed: j === i0 };
      // continue along the other link
      let nk = -1;
      for (let q = 0; q < 8; q++) if ((adj[j] & (1 << q)) && q !== opp(k)) { nk = q; break; }
      if (nk < 0 || (visited[j] & (1 << nk))) return { pts, a: i0, b: j, closed: false };
      i = j; k = nk;
    }
  };
  for (let i = 0; i < w * h; i++) {
    if (!adj[i] || deg(i) === 2) continue;
    for (let k = 0; k < 8; k++) if ((adj[i] & (1 << k)) && !(visited[i] & (1 << k))) strokes.push(walk(i, k));
  }
  // remaining pure loops
  for (let i = 0; i < w * h; i++) {
    if (!adj[i] || deg(i) !== 2) continue;
    for (let k = 0; k < 8; k++) if ((adj[i] & (1 << k)) && !(visited[i] & (1 << k))) {
      const s = walk(i, k); s.closed = s.b === i; strokes.push(s);
    }
  }
  // isolated single pixels
  for (let i = 0; i < w * h; i++) if (skel[i] && !adj[i]) strokes.push({ pts: [[i % w + 0.5, ((i / w) | 0) + 0.5]], a: i, b: i, closed: false });

  // prune spurs: a stroke from an end point (degree 1) to a junction (degree ≥3)
  const plen = (p) => { let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return L; };
  let list = strokes.map((s) => ({ ...s, len: plen(s.pts) }));
  if (spur > 0) {
    for (let pass = 0; pass < 3; pass++) {
      const count = new Map();
      const bump = (n) => count.set(n, (count.get(n) || 0) + 1);
      for (const s of list) if (!s.closed) { bump(s.a); bump(s.b); }
      const before = list.length;
      list = list.filter((s) => {
        if (s.closed) return true;
        const ea = count.get(s.a) === 1, eb = count.get(s.b) === 1;
        const ja = count.get(s.a) >= 3, jb = count.get(s.b) >= 3;
        return !(s.len < spur && ((ea && jb) || (eb && ja)));
      });
      // join strokes that now meet two-at-a-time at a former junction
      list = joinAtNodes(list);
      if (list.length === before) break;
    }
  }
  return list.filter((s) => s.closed ? s.len >= minLen : s.len >= minLen).map((s) => ({ closed: s.closed, pts: s.pts }));
}

function joinAtNodes(list) {
  for (let guard = 0; guard < 10000; guard++) {
    const at = new Map();
    list.forEach((s, idx) => { if (s.closed) return; for (const e of [s.a, s.b]) { if (!at.has(e)) at.set(e, []); at.get(e).push(idx); } });
    let merged = false;
    for (const [node, idxs] of at) {
      if (idxs.length !== 2 || idxs[0] === idxs[1]) continue;
      const [i, j] = idxs, s = list[i], t = list[j];
      const sp = s.b === node ? s.pts : s.pts.slice().reverse();
      const tp = t.a === node ? t.pts : t.pts.slice().reverse();
      const na = s.b === node ? s.a : s.b, nb = t.a === node ? t.b : t.a;
      const pts = sp.concat(tp.slice(1));
      const ns = { pts, a: na, b: nb, closed: na === nb && pts.length > 3, len: s.len + t.len };
      list = list.filter((_, q) => q !== i && q !== j); list.push(ns);
      merged = true; break;
    }
    if (!merged) break;
  }
  return list;
}

// ---------- smoothing / curve fitting ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };

// Remove consecutive duplicates.
function dedupe(pts, closed) {
  const out = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p); }
  if (closed && out.length > 1) { const a = out[0], b = out[out.length - 1]; if (a[0] === b[0] && a[1] === b[1]) out.pop(); }
  return out;
}

// Resample so points are no more than `step` apart (skeleton/outline points are already ≤1.5 apart).
function turning(pts, i, s, closed) {
  const n = pts.length;
  const ia = closed ? (i - s + n * 4) % n : Math.max(0, i - s);
  const ib = closed ? (i + s) % n : Math.min(n - 1, i + s);
  if (ia === i || ib === i) return 0;
  const u = sub(pts[i], pts[ia]), v = sub(pts[ib], pts[i]);
  const lu = len(u), lv = len(v); if (!lu || !lv) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (lu * lv))));
}

// Find corners: points where the path turns more than `angle` (radians)
// measured over ±s points, keeping only the local maxima.
export function findCorners(pts, closed, angle, s) {
  const n = pts.length; if (n < 3) return [];
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = turning(pts, i, s, closed);
  const corners = [];
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    if (t[i] < angle) continue;
    let isMax = true;
    for (let k = -s; k <= s && isMax; k++) {
      if (!k) continue;
      let j = i + k;
      if (closed) j = (j + n) % n; else if (j < 0 || j >= n) continue;
      if (t[j] > t[i] || (t[j] === t[i] && k < 0)) isMax = false;
    }
    if (isMax) corners.push(i);
  }
  return corners;
}

// Average each point with its neighbours (window ±k) without crossing a corner.
function smoothRun(run, k) {
  if (k < 1 || run.length < 3) return run;
  const out = [run[0]];
  for (let i = 1; i < run.length - 1; i++) {
    const r = Math.min(k, i, run.length - 1 - i);
    let x = 0, y = 0;
    for (let j = i - r; j <= i + r; j++) { x += run[j][0]; y += run[j][1]; }
    out.push([x / (2 * r + 1), y / (2 * r + 1)]);
  }
  out.push(run[run.length - 1]);
  return out;
}

// Ramer–Douglas–Peucker
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a], B = pts[b], d = sub(B, A), L = len(d);
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const p = sub(pts[i], A);
      const dist = L ? Math.abs(d[0] * p[1] - d[1] * p[0]) / L : len(p);
      if (dist > md) { md = dist; mi = i; }
    }
    if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// --- Schneider's "An Algorithm for Automatically Fitting Digitized Curves" ---
function bez(p, t) {
  const u = 1 - t;
  return [
    u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0],
    u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1],
  ];
}
function bezD1(p, t) {
  const u = 1 - t;
  return [3 * (u * u * (p[1][0] - p[0][0]) + 2 * u * t * (p[2][0] - p[1][0]) + t * t * (p[3][0] - p[2][0])),
          3 * (u * u * (p[1][1] - p[0][1]) + 2 * u * t * (p[2][1] - p[1][1]) + t * t * (p[3][1] - p[2][1]))];
}
function bezD2(p, t) {
  const u = 1 - t;
  return [6 * (u * (p[2][0] - 2 * p[1][0] + p[0][0]) + t * (p[3][0] - 2 * p[2][0] + p[1][0])),
          6 * (u * (p[2][1] - 2 * p[1][1] + p[0][1]) + t * (p[3][1] - 2 * p[2][1] + p[1][1]))];
}
function chordParams(pts, a, b) {
  const u = [0];
  for (let i = a + 1; i <= b; i++) u.push(u[u.length - 1] + len(sub(pts[i], pts[i - 1])));
  const L = u[u.length - 1] || 1;
  return u.map((x) => x / L);
}
function generateBezier(pts, a, b, u, t1, t2) {
  const P0 = pts[a], P3 = pts[b];
  let C00 = 0, C01 = 0, C11 = 0, X0 = 0, X1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i], s = 1 - t;
    const A1 = mul(t1, 3 * s * s * t), A2 = mul(t2, 3 * s * t * t);
    C00 += dot(A1, A1); C01 += dot(A1, A2); C11 += dot(A2, A2);
    const tmp = sub(pts[a + i], add(mul(P0, s * s * s + 3 * s * s * t), mul(P3, 3 * s * t * t + t * t * t)));
    X0 += dot(A1, tmp); X1 += dot(A2, tmp);
  }
  const det = C00 * C11 - C01 * C01;
  let al = det ? (X0 * C11 - X1 * C01) / det : 0;
  let ar = det ? (C00 * X1 - C01 * X0) / det : 0;
  const segLen = len(sub(P3, P0)), eps = 1e-6 * segLen;
  if (al < eps || ar < eps || al > segLen * 2 || ar > segLen * 2) { al = ar = segLen / 3; }
  return [P0, add(P0, mul(t1, al)), add(P3, mul(t2, ar)), P3];
}
function maxError(pts, a, b, bz, u) {
  let md = 0, split = (a + b) >> 1;
  for (let i = a + 1; i < b; i++) {
    const d = sub(bez(bz, u[i - a]), pts[i]), e = dot(d, d);
    if (e > md) { md = e; split = i; }
  }
  return [md, split];
}
function reparam(pts, a, b, u, bz) {
  return u.map((t, i) => {
    const d = sub(bez(bz, t), pts[a + i]), d1 = bezD1(bz, t), d2 = bezD2(bz, t);
    const den = dot(d1, d1) + dot(d, d2);
    if (!den) return t;
    return Math.min(1, Math.max(0, t - dot(d, d1) / den));
  });
}
function fitCubic(pts, a, b, t1, t2, err2, out, depth = 0) {
  const n = b - a + 1;
  if (n === 2) {
    const d = len(sub(pts[b], pts[a])) / 3;
    out.push([pts[a], add(pts[a], mul(t1, d)), add(pts[b], mul(t2, d)), pts[b]]);
    return;
  }
  let u = chordParams(pts, a, b);
  let bz = generateBezier(pts, a, b, u, t1, t2);
  let [e, split] = maxError(pts, a, b, bz, u);
  if (e < err2) { out.push(bz); return; }
  if (e < err2 * 4) {
    for (let it = 0; it < 6; it++) {
      u = reparam(pts, a, b, u, bz);
      bz = generateBezier(pts, a, b, u, t1, t2);
      [e, split] = maxError(pts, a, b, bz, u);
      if (e < err2) { out.push(bz); return; }
    }
  }
  if (depth > 40) { out.push(bz); return; }
  split = Math.max(a + 1, Math.min(b - 1, split));
  const tc = norm(sub(pts[split - 1], pts[split + 1]));
  fitCubic(pts, a, split, t1, tc, err2, out, depth + 1);
  fitCubic(pts, split, b, mul(tc, -1), t2, err2, out, depth + 1);
}

function endTangent(run, fromStart) {
  const k = Math.min(run.length - 1, 3);
  return fromStart ? norm(sub(run[k], run[0])) : norm(sub(run[run.length - 1 - k], run[run.length - 1]));
}

// opts: { cornerDeg, smooth (window, px), eps (px), fitErr (px), curves }
// Returns a vector path { closed, start, segs }.
export function vectorize(path, opts) {
  const { cornerDeg = 60, smooth = 2, eps = 1, fitErr = 1, curves = true } = opts;
  let pts = dedupe(path.pts, path.closed);
  const closed = path.closed && pts.length >= 3;
  if (pts.length === 1) return { closed: false, start: pts[0], segs: [['L', pts[0][0] + 0.01, pts[0][1]]] };
  if (pts.length === 2) return { closed: false, start: pts[0], segs: [['L', pts[1][0], pts[1][1]]] };
  const s = Math.max(2, Math.round(smooth) + 1);
  let corners = curves ? findCorners(pts, closed, cornerDeg * Math.PI / 180, s) : findCorners(pts, closed, 25 * Math.PI / 180, 2);
  // split into runs between corners
  let runs = [];
  if (closed) {
    if (!corners.length) {
      // no corners — start anywhere and close smoothly
      const run = pts.concat([pts[0]]);
      runs.push({ pts: run, smoothLoop: true });
    } else {
      const n = pts.length;
      for (let c = 0; c < corners.length; c++) {
        const a = corners[c], b = corners[(c + 1) % corners.length];
        const run = [];
        for (let i = a; ; i = (i + 1) % n) { run.push(pts[i]); if (i === b && run.length > 1) break; if (run.length > n + 1) break; }
        runs.push({ pts: run });
      }
    }
  } else {
    const cuts = [0, ...corners, pts.length - 1];
    for (let c = 0; c < cuts.length - 1; c++) runs.push({ pts: pts.slice(cuts[c], cuts[c + 1] + 1) });
  }
  const segs = [];
  let start = null;
  for (const r of runs) {
    let run = r.pts;
    if (r.smoothLoop) {
      // smooth cyclically
      const k = Math.round(smooth);
      if (k >= 1) {
        const n = run.length - 1, base = run.slice(0, n);
        const sm = base.map((_, i) => { let x = 0, y = 0; for (let j = -k; j <= k; j++) { const q = base[(i + j + n) % n]; x += q[0]; y += q[1]; } return [x / (2 * k + 1), y / (2 * k + 1)]; });
        run = sm.concat([sm[0]]);
      }
    } else run = smoothRun(run, Math.round(smooth));
    if (!start) start = run[0];
    if (!curves) {
      const simp = rdp(run, eps);
      for (let i = 1; i < simp.length; i++) segs.push(['L', simp[i][0], simp[i][1]]);
      continue;
    }
    // light RDP first keeps the fit fast on long runs while staying well inside the error
    const dense = run.length > 12 ? rdp(run, Math.min(eps, fitErr) * 0.35) : run;
    if (dense.length < 3) { segs.push(['L', dense[dense.length - 1][0], dense[dense.length - 1][1]]); continue; }
    let t1, t2;
    if (r.smoothLoop) { const tt = norm(sub(dense[1], dense[dense.length - 2])); t1 = tt; t2 = mul(tt, -1); }
    else { t1 = endTangent(dense, true); t2 = endTangent(dense, false); }
    const out = [];
    fitCubic(dense, 0, dense.length - 1, t1, t2, fitErr * fitErr, out);
    for (const bz of out) {
      // straight-ish segments become lines (smaller files, cleaner nodes)
      const chord = sub(bz[3], bz[0]), L = len(chord);
      const off = (p) => L ? Math.abs(chord[0] * (p[1] - bz[0][1]) - chord[1] * (p[0] - bz[0][0])) / L : 0;
      if (L && off(bz[1]) < 0.05 * L + 0.05 && off(bz[2]) < 0.05 * L + 0.05 && dot(sub(bz[1], bz[0]), chord) >= 0 && dot(sub(bz[2], bz[3]), chord) <= 0) segs.push(['L', bz[3][0], bz[3][1]]);
      else segs.push(['C', bz[1][0], bz[1][1], bz[2][0], bz[2][1], bz[3][0], bz[3][1]]);
    }
  }
  return { closed, start, segs };
}

// ---------- helpers for vector paths ----------
export function pathLength(p) {
  let L = 0, [x, y] = p.start;
  for (const s of p.segs) {
    if (s[0] === 'L') { L += Math.hypot(s[1] - x, s[2] - y); x = s[1]; y = s[2]; }
    else {
      const bz = [[x, y], [s[1], s[2]], [s[3], s[4]], [s[5], s[6]]];
      let prev = bz[0];
      for (let i = 1; i <= 8; i++) { const q = bez(bz, i / 8); L += len(sub(q, prev)); prev = q; }
      x = s[5]; y = s[6];
    }
  }
  if (p.closed) L += Math.hypot(p.start[0] - x, p.start[1] - y);
  return L;
}
export function nodeCount(p) { return p.segs.length + 1; }

export function transformPath(p, sx, sy, tx, ty) {
  const f = (x, y) => [x * sx + tx, y * sy + ty];
  return {
    closed: p.closed,
    start: f(p.start[0], p.start[1]),
    segs: p.segs.map((s) => s[0] === 'L' ? ['L', ...f(s[1], s[2])] : ['C', ...f(s[1], s[2]), ...f(s[3], s[4]), ...f(s[5], s[6])]),
  };
}

export function pathData(paths, dp = 3) {
  const r = (v) => { const s = v.toFixed(dp); return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s; };
  let d = '';
  for (const p of paths) {
    d += `M${r(p.start[0])} ${r(p.start[1])}`;
    for (const s of p.segs) d += s[0] === 'L' ? `L${r(s[1])} ${r(s[2])}` : `C${r(s[1])} ${r(s[2])} ${r(s[3])} ${r(s[4])} ${r(s[5])} ${r(s[6])}`;
    if (p.closed) d += 'Z';
  }
  return d;
}

// Bounding box of vector paths (uses control points — good enough for layout).
export function pathsBBox(paths) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (x, y) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
  for (const p of paths) { take(p.start[0], p.start[1]); for (const s of p.segs) for (let i = 1; i < s.length; i += 2) take(s[i], s[i + 1]); }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

// Rectangle / rounded rectangle / ellipse as vector paths.
export function rectPath(x0, y0, x1, y1, r = 0) {
  r = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  if (!r) return { closed: true, start: [x0, y0], segs: [['L', x1, y0], ['L', x1, y1], ['L', x0, y1]] };
  const k = r * 0.5523;
  return { closed: true, start: [x0 + r, y0], segs: [
    ['L', x1 - r, y0], ['C', x1 - r + k, y0, x1, y0 + r - k, x1, y0 + r],
    ['L', x1, y1 - r], ['C', x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1],
    ['L', x0 + r, y1], ['C', x0 + r - k, y1, x0, y1 - r + k, x0, y1 - r],
    ['L', x0, y0 + r], ['C', x0, y0 + r - k, x0 + r - k, y0, x0 + r, y0],
  ] };
}
export function ellipsePath(cx, cy, rx, ry) {
  const kx = rx * 0.5523, ky = ry * 0.5523;
  return { closed: true, start: [cx + rx, cy], segs: [
    ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
  ] };
}
