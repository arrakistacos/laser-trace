// Pure image processing — no DOM, so it runs in the browser and in node tests.
// Gray images are Float32Array (0 = black, 255 = white), masks are Uint8Array (1 = ink).

export function toGray(rgba, w, h) {
  const n = w * h, g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    // transparent pixels read as white paper
    const l = 0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2];
    g[i] = l * a + 255 * (1 - a);
  }
  return g;
}

// Running-sum box blur, separable, radius r (in pixels).
function boxBlurH(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    const first = src[row], last = src[row + w - 1];
    acc = first * (r + 1);
    for (let x = 0; x < r; x++) acc += src[row + Math.min(x, w - 1)];
    for (let x = 0; x < w; x++) {
      const add = x + r < w ? src[row + x + r] : last;
      const sub = x - r - 1 >= 0 ? src[row + x - r - 1] : first;
      acc += add - sub;
      dst[row + x] = acc * iarr;
    }
  }
}
function boxBlurV(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    const first = src[x], last = src[x + (h - 1) * w];
    let acc = first * (r + 1);
    for (let y = 0; y < r; y++) acc += src[x + Math.min(y, h - 1) * w];
    for (let y = 0; y < h; y++) {
      const add = y + r < h ? src[x + (y + r) * w] : last;
      const sub = y - r - 1 >= 0 ? src[x + (y - r - 1) * w] : first;
      acc += add - sub;
      dst[x + y * w] = acc * iarr;
    }
  }
}

// Approximate gaussian blur with three box passes.
export function gaussBlur(src, w, h, sigma) {
  if (sigma < 0.3) return Float32Array.from(src);
  const boxes = boxesForGauss(sigma, 3);
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  for (const bs of boxes) {
    const r = (bs - 1) >> 1;
    if (r < 1) continue;
    boxBlurH(a, b, w, h, r);
    boxBlurV(b, a, w, h, r);
  }
  return a;
}
function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

// Remove uneven lighting / shadows from a phone photo of paper.
// Estimates the paper brightness with a max-filter (which erases the ink) on a
// downsampled copy, blurs it, and divides it out. radius is in full-res pixels.
export function flattenBackground(gray, w, h, radius) {
  if (radius <= 0) return Float32Array.from(gray);
  const f = Math.max(1, Math.floor(radius / 6));
  const sw = Math.max(1, Math.ceil(w / f)), sh = Math.max(1, Math.ceil(h / f));
  // downsample by taking the max in each f×f cell (keeps paper, drops thin ink)
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const sy = (y / f) | 0;
    for (let x = 0; x < w; x++) {
      const si = sy * sw + ((x / f) | 0);
      const v = gray[y * w + x];
      if (v > small[si]) small[si] = v;
    }
  }
  const r = Math.max(1, Math.round(radius / f / 2));
  const mx = maxFilter(small, sw, sh, r);
  const bg = gaussBlur(mx, sw, sh, r);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const b = (bg[y0 * sw + x0] * (1 - tx) + bg[y0 * sw + x1] * tx) * (1 - ty) +
                (bg[y1 * sw + x0] * (1 - tx) + bg[y1 * sw + x1] * tx) * ty;
      const i = y * w + x;
      out[i] = Math.min(255, gray[i] / Math.max(b, 8) * 255);
    }
  }
  return out;
}

function maxFilter(src, w, h, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, src[y * w + k]);
    tmp[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
    out[y * w + x] = m;
  }
  return out;
}

// brightness/contrast in -100..100, gamma > 0
export function adjust(gray, { brightness = 0, contrast = 0, gamma = 1 } = {}) {
  const out = new Float32Array(gray.length);
  const c = Math.tan((contrast / 100 + 1) * Math.PI / 4); // 0 → 1, 100 → steep, -100 → flat
  const b = brightness * 1.28;
  const ig = 1 / gamma;
  for (let i = 0; i < gray.length; i++) {
    let v = (gray[i] - 128) * c + 128 + b;
    v = Math.min(255, Math.max(0, v));
    if (gamma !== 1) v = 255 * Math.pow(v / 255, ig);
    out[i] = v;
  }
  return out;
}

export function histogram(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[Math.max(0, Math.min(255, gray[i] | 0))]++;
  return hist;
}

export function otsu(gray) {
  const hist = histogram(gray), total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = i; }
  }
  return t + 0.5;
}

// Ink where gray is darker than t.
export function threshold(gray, t) {
  const m = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) m[i] = gray[i] < t ? 1 : 0;
  return m;
}

// Local (adaptive) threshold: ink where pixel is `offset` darker than its
// neighbourhood mean. Good for photos with shading. Window radius r.
export function adaptiveThreshold(gray, w, h, r, offset) {
  const mean = gaussBlur(gray, w, h, Math.max(1, r / 2));
  const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = gray[i] < mean[i] - offset ? 1 : 0;
  return m;
}

export function invert(mask) {
  const m = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) m[i] = mask[i] ? 0 : 1;
  return m;
}

// ---- Euclidean distance transform (Felzenszwalb & Huttenlocher) ----
// Returns squared distance from each pixel to the nearest pixel where mask==1.
export function edt(mask, w, h) {
  const INF = 1e20;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const out = new Float64Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] ? 0 : INF;
  const pass = (n, get, set) => {
    for (let i = 0; i < n; i++) f[i] = get(i);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      do {
        const p = v[k];
        s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s <= z[k]) k--; else break;
      } while (k >= 0);
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k];
      d[q] = (q - p) * (q - p) + f[p];
    }
    for (let i = 0; i < n; i++) set(i, d[i]);
  };
  for (let x = 0; x < w; x++) pass(h, (y) => out[y * w + x], (y, val) => { out[y * w + x] = val; });
  for (let y = 0; y < h; y++) { const row = y * w; pass(w, (x) => out[row + x], (x, val) => { out[row + x] = val; }); }
  return out;
}

// Grow ink by r pixels (round brush).
export function dilate(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask);
  const d = edt(mask, w, h), r2 = r * r, m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[i] <= r2 ? 1 : 0;
  return m;
}
// Shrink ink by r pixels.
export function erode(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask);
  const inv = invert(mask);
  const d = edt(inv, w, h), r2 = r * r, m = new Uint8Array(w * h);
  // pixels outside the image count as paper too
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const edge = Math.min(x + 1, y + 1, w - x, h - y);
    m[i] = mask[i] && d[i] > r2 && edge * edge > r2 ? 1 : 0;
  }
  return m;
}
// Thicken (positive) or thin (negative) lines.
export function morph(mask, w, h, amount) {
  if (amount > 0) return dilate(mask, w, h, amount);
  if (amount < 0) return erode(mask, w, h, -amount);
  return mask;
}
// Close small gaps (dilate then erode) — joins broken pencil lines.
export function closeGaps(mask, w, h, r) {
  if (r <= 0) return mask;
  return erode(dilate(mask, w, h, r), w, h, r);
}

// ---- connected components ----
// Labels pixels where mask[i] === value. conn = 4 or 8.
// Returns { labels (Int32Array, -1 = not labelled), count, area[], touches[] (touches image border) }
export function components(mask, w, h, value = 1, conn = 8) {
  const labels = new Int32Array(w * h).fill(-1);
  const area = [], touches = [], minX = [], minY = [], maxX = [], maxY = [];
  const stack = new Int32Array(w * h);
  let count = 0;
  for (let s = 0; s < w * h; s++) {
    if (labels[s] !== -1 || mask[s] !== value) continue;
    let sp = 0; stack[sp++] = s; labels[s] = count;
    let a = 0, t = false, x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (sp) {
      const i = stack[--sp]; a++;
      const x = i % w, y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) t = true;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (conn === 4 && dx && dy) continue;
          const nx = x + dx; if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (labels[j] === -1 && mask[j] === value) { labels[j] = count; stack[sp++] = j; }
        }
      }
    }
    area.push(a); touches.push(t); minX.push(x0); minY.push(y0); maxX.push(x1); maxY.push(y1);
    count++;
  }
  return { labels, count, area, touches, minX, minY, maxX, maxY };
}

// Remove ink specks smaller than minArea and fill paper specks (pinholes) smaller than minHole.
export function despeckle(mask, w, h, minArea, minHole = minArea) {
  const m = Uint8Array.from(mask);
  if (minArea > 0) {
    const c = components(m, w, h, 1, 8);
    for (let i = 0; i < m.length; i++) if (m[i] && c.area[c.labels[i]] < minArea) m[i] = 0;
  }
  if (minHole > 0) {
    const c = components(m, w, h, 0, 4);
    for (let i = 0; i < m.length; i++) if (!m[i] && !c.touches[c.labels[i]] && c.area[c.labels[i]] < minHole) m[i] = 1;
  }
  return m;
}

// Fill enclosed paper regions (holes) — e.g. turn an outline drawing into solid shapes.
// maxArea = Infinity fills all of them.
export function fillHoles(mask, w, h, maxArea = Infinity) {
  const m = Uint8Array.from(mask);
  const c = components(m, w, h, 0, 4);
  for (let i = 0; i < m.length; i++) {
    if (m[i]) continue;
    const l = c.labels[i];
    if (!c.touches[l] && c.area[l] <= maxArea) m[i] = 1;
  }
  return m;
}

export function union(a, b) {
  const m = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) m[i] = a[i] || b[i] ? 1 : 0;
  return m;
}

export function countInk(mask) { let n = 0; for (let i = 0; i < mask.length; i++) n += mask[i]; return n; }

export function bbox(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

// ---- stencil bridges ----
// mask = regions that will be cut out. Any piece of material completely
// surrounded by a cut (the middle of an "O") would fall out, so cut thin
// bridges of `width` px to tie it back to the surrounding sheet.
// dir: 'v' (bridges run up/down) or 'h' (left/right). The image border counts as sheet.
export function stencilBridges(mask, w, h, width, dir = 'v', both = true) {
  const m = Uint8Array.from(mask);
  const half = Math.max(0.5, width / 2);
  let bridges = 0;
  for (let iter = 0; iter < 200; iter++) {
    const c = components(m, w, h, 0, 4);
    let islands = 0;
    // centroid pixel for each island
    const sx = new Float64Array(c.count), sy = new Float64Array(c.count);
    for (let i = 0; i < m.length; i++) {
      const l = c.labels[i];
      if (l >= 0 && !c.touches[l]) { sx[l] += i % w; sy[l] += (i / w) | 0; }
    }
    for (let l = 0; l < c.count; l++) {
      if (c.touches[l]) continue;
      islands++;
      const cx = sx[l] / c.area[l], cy = sy[l] / c.area[l];
      // pick the island pixel nearest its centroid so the bridge actually starts on it
      let best = -1, bd = Infinity;
      for (let y = c.minY[l]; y <= c.maxY[l]; y++) for (let x = c.minX[l]; x <= c.maxX[l]; x++) {
        const i = y * w + x; if (c.labels[i] !== l) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2; if (d < bd) { bd = d; best = i; }
      }
      const px = best % w, py = (best / w) | 0;
      const dirs = dir === 'h' ? [[1, 0], [-1, 0]] : [[0, -1], [0, 1]];
      for (const [dx, dy] of (both ? dirs : dirs.slice(0, 1))) {
        // walk out of the island, across the cut, until we reach material again
        let x = px, y = py, state = 0, path = [];
        while (x >= 0 && y >= 0 && x < w && y < h) {
          const i = y * w + x;
          if (state === 0) { if (m[i]) state = 1; }
          if (state === 1) { if (!m[i]) break; path.push([x, y]); }
          x += dx; y += dy;
        }
        if (!path.length) continue;
        bridges++;
        for (const [bx, by] of path) {
          // clear a band `width` wide perpendicular to the bridge
          for (let o = -Math.ceil(half); o <= Math.ceil(half); o++) {
            if (Math.abs(o) > half) continue;
            const qx = dx ? bx : bx + o, qy = dx ? by + o : by;
            if (qx >= 0 && qy >= 0 && qx < w && qy < h) m[qy * w + qx] = 0;
          }
        }
      }
    }
    if (!islands) break;
  }
  return { mask: m, bridges };
}

// ---- color separation ----
function srgbToLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const LIN = new Float32Array(256); for (let i = 0; i < 256; i++) LIN[i] = srgbToLin(i);
function labF(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
export function rgbToLab(r, g, b) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const fx = labF(X), fy = labF(Y), fz = labF(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// k-means in Lab space. Returns { labels: Uint8Array per pixel, centers: [{r,g,b,count}] }
// sorted darkest first.
export function kmeansColors(rgba, w, h, k, seed = 7) {
  const n = w * h;
  const lab = new Float32Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    const r = Math.round(rgba[j] * a + 255 * (1 - a)), g = Math.round(rgba[j + 1] * a + 255 * (1 - a)), b = Math.round(rgba[j + 2] * a + 255 * (1 - a));
    const L = rgbToLab(r, g, b); lab[i * 3] = L[0]; lab[i * 3 + 1] = L[1]; lab[i * 3 + 2] = L[2];
  }
  const rand = rng(seed);
  const stride = Math.max(1, Math.floor(n / 40000));
  const sample = []; for (let i = 0; i < n; i += stride) sample.push(i);
  const S = sample.length;
  // k-means++ init
  const C = new Float32Array(k * 3);
  let first = sample[Math.floor(rand() * S)];
  C.set(lab.subarray(first * 3, first * 3 + 3), 0);
  const dist = new Float32Array(S).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let s = 0; s < S; s++) {
      const i = sample[s] * 3, p = (c - 1) * 3;
      const d = (lab[i] - C[p]) ** 2 + (lab[i + 1] - C[p + 1]) ** 2 + (lab[i + 2] - C[p + 2]) ** 2;
      if (d < dist[s]) dist[s] = d; total += dist[s];
    }
    let r = rand() * total, pick = sample[S - 1];
    for (let s = 0; s < S; s++) { r -= dist[s]; if (r <= 0) { pick = sample[s]; break; } }
    C.set(lab.subarray(pick * 3, pick * 3 + 3), c * 3);
  }
  const assign = new Uint8Array(S);
  for (let it = 0; it < 20; it++) {
    const acc = new Float64Array(k * 4);
    let moved = 0;
    for (let s = 0; s < S; s++) {
      const i = sample[s] * 3; let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const p = c * 3, d = (lab[i] - C[p]) ** 2 + (lab[i + 1] - C[p + 1]) ** 2 + (lab[i + 2] - C[p + 2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      if (assign[s] !== best) moved++;
      assign[s] = best;
      acc[best * 4] += lab[i]; acc[best * 4 + 1] += lab[i + 1]; acc[best * 4 + 2] += lab[i + 2]; acc[best * 4 + 3]++;
    }
    for (let c = 0; c < k; c++) if (acc[c * 4 + 3]) { C[c * 3] = acc[c * 4] / acc[c * 4 + 3]; C[c * 3 + 1] = acc[c * 4 + 1] / acc[c * 4 + 3]; C[c * 3 + 2] = acc[c * 4 + 2] / acc[c * 4 + 3]; }
    if (it > 2 && moved < S * 0.001) break;
  }
  // full assignment
  const labels = new Uint8Array(n);
  const sum = new Float64Array(k * 4);
  for (let i = 0; i < n; i++) {
    const q = i * 3; let best = 0, bd = Infinity;
    for (let c = 0; c < k; c++) {
      const p = c * 3, d = (lab[q] - C[p]) ** 2 + (lab[q + 1] - C[p + 1]) ** 2 + (lab[q + 2] - C[p + 2]) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    labels[i] = best;
    const j = i * 4; sum[best * 4] += rgba[j]; sum[best * 4 + 1] += rgba[j + 1]; sum[best * 4 + 2] += rgba[j + 2]; sum[best * 4 + 3]++;
  }
  let centers = [];
  for (let c = 0; c < k; c++) {
    const cnt = sum[c * 4 + 3] || 1;
    centers.push({ idx: c, r: Math.round(sum[c * 4] / cnt), g: Math.round(sum[c * 4 + 1] / cnt), b: Math.round(sum[c * 4 + 2] / cnt), count: sum[c * 4 + 3], L: C[c * 3] });
  }
  centers = centers.filter((c) => c.count > 0).sort((a, b) => a.L - b.L);
  const remap = new Uint8Array(k).fill(255);
  centers.forEach((c, i) => { remap[c.idx] = i; });
  for (let i = 0; i < n; i++) labels[i] = remap[labels[i]];
  return { labels, centers: centers.map(({ r, g, b, count, L }) => ({ r, g, b, count, L })) };
}

export function maskOfLabel(labels, l) {
  const m = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) m[i] = labels[i] === l ? 1 : 0;
  return m;
}

// Blur each channel of an RGBA image (for color mode noise reduction).
export function blurRGBA(rgba, w, h, sigma) {
  if (sigma < 0.3) return rgba;
  const out = new Uint8ClampedArray(rgba.length);
  const ch = new Float32Array(w * h);
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < w * h; i++) ch[i] = rgba[i * 4 + c];
    const b = gaussBlur(ch, w, h, sigma);
    for (let i = 0; i < w * h; i++) out[i * 4 + c] = b[i];
  }
  return out;
}

// ---- perspective ----
// Solve the homography that maps the unit square corners (0,0),(1,0),(1,1),(0,1)
// to the four given points [[x,y]×4] (TL, TR, BR, BL).
export function homographyFromUnit(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let g = 0, hh = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    hh = (dx1 * sy - sx * dy1) / den;
  }
  return [x1 - x0 + g * x1, x3 - x0 + hh * x3, x0, y1 - y0 + g * y1, y3 - y0 + hh * y3, y0, g, hh, 1];
}
export function applyH(H, u, v) {
  const d = H[6] * u + H[7] * v + H[8];
  return [(H[0] * u + H[1] * v + H[2]) / d, (H[3] * u + H[4] * v + H[5]) / d];
}
// Output size that keeps the quad's proportions.
export function quadSize(q) {
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  return { w: (len(q[0], q[1]) + len(q[3], q[2])) / 2, h: (len(q[0], q[3]) + len(q[1], q[2])) / 2 };
}
// Warp quad region of src (RGBA, sw×sh) into a straight ow×oh image. Bilinear.
export function warpQuad(src, sw, sh, q, ow, oh) {
  const H = homographyFromUnit(q);
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    const v = (y + 0.5) / oh;
    for (let x = 0; x < ow; x++) {
      const [fx, fy] = applyH(H, (x + 0.5) / ow, v);
      const px = fx - 0.5, py = fy - 0.5;
      const x0 = Math.floor(px), y0 = Math.floor(py), tx = px - x0, ty = py - y0;
      const o = (y * ow + x) * 4;
      for (let c = 0; c < 4; c++) {
        const s = (xx, yy) => src[(Math.min(sh - 1, Math.max(0, yy)) * sw + Math.min(sw - 1, Math.max(0, xx))) * 4 + c];
        out[o + c] = (s(x0, y0) * (1 - tx) + s(x0 + 1, y0) * tx) * (1 - ty) + (s(x0, y0 + 1) * (1 - tx) + s(x0 + 1, y0 + 1) * tx) * ty;
      }
    }
  }
  return out;
}
