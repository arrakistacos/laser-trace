// Built-in sample "photos" drawn on a canvas so the app can be tried without
// uploading anything. The sketch mimics a phone photo of a pen drawing:
// off-white paper, uneven lighting, a shadow, wobbly lines and some noise.

function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

export function makeSketch() {
  const W = 1500, H = 1100;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const r = rng(42);
  // paper with lighting falloff and a phone shadow
  const g = ctx.createRadialGradient(W * 0.35, H * 0.3, 100, W * 0.5, H * 0.5, W * 0.85);
  g.addColorStop(0, '#f4f0e6'); g.addColorStop(1, '#a9a395');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const sh = ctx.createLinearGradient(W, H, W * 0.6, H * 0.55);
  sh.addColorStop(0, 'rgba(40,35,30,.45)'); sh.addColorStop(1, 'rgba(40,35,30,0)');
  ctx.fillStyle = sh; ctx.fillRect(0, 0, W, H);

  const wobble = (pts, width, color = 'rgba(25,25,35,.92)') => {
    ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      ctx.lineWidth = width * (pass ? 0.6 : 1);
      ctx.beginPath();
      pts.forEach(([x, y], i) => { const jx = x + (r() - 0.5) * 2.2, jy = y + (r() - 0.5) * 2.2; i ? ctx.lineTo(jx, jy) : ctx.moveTo(jx, jy); });
      ctx.stroke();
    }
  };
  const arc = (cx, cy, rx, ry, a0, a1, n = 60) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / n; return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]; });
  const line = (x0, y0, x1, y1, n = 20) => Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]);

  // sun with rays
  wobble(arc(1130, 260, 95, 95, 0, Math.PI * 2.02), 9);
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; wobble(line(1130 + Math.cos(a) * 125, 260 + Math.sin(a) * 125, 1130 + Math.cos(a) * 175, 260 + Math.sin(a) * 175, 6), 8); }
  // mountains
  wobble([[140, 860], [380, 470], [520, 650], [700, 380], [980, 860]].flatMap((p, i, a) => i ? line(a[i - 1][0], a[i - 1][1], p[0], p[1], 20).slice(1) : [p]), 10);
  // snow caps (filled)
  ctx.fillStyle = 'rgba(25,25,35,.9)';
  ctx.beginPath(); ctx.moveTo(700, 380); ctx.lineTo(760, 460); ctx.lineTo(725, 445); ctx.lineTo(700, 475); ctx.lineTo(672, 440); ctx.lineTo(640, 462); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(380, 470); ctx.lineTo(425, 530); ctx.lineTo(395, 520); ctx.lineTo(372, 545); ctx.lineTo(345, 518); ctx.closePath(); ctx.fill();
  // pine tree
  for (let k = 0; k < 3; k++) wobble([[1150 - 60 - k * 18, 700 + k * 70], [1150, 600 + k * 70], [1150 + 60 + k * 18, 700 + k * 70]].flatMap((p, i, a) => i ? line(a[i - 1][0], a[i - 1][1], p[0], p[1], 10).slice(1) : [p]), 9);
  wobble(line(1150, 840, 1150, 900, 6), 12);
  // ground + birds
  wobble(Array.from({ length: 60 }, (_, i) => [100 + i * 22, 905 + Math.sin(i / 3) * 8]), 7);
  for (const [bx, by] of [[300, 230], [380, 190], [460, 245]]) { wobble(arc(bx - 22, by, 22, 14, Math.PI * 1.1, Math.PI * 1.95, 12), 6); wobble(arc(bx + 22, by, 22, 14, Math.PI * 1.05, Math.PI * 1.9, 12), 6); }
  // pencil smudge + dust specks the cleanup should remove
  ctx.fillStyle = 'rgba(80,80,80,.12)'; ctx.beginPath(); ctx.ellipse(560, 980, 120, 30, -0.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(30,30,30,.8)';
  for (let i = 0; i < 70; i++) { ctx.beginPath(); ctx.arc(r() * W, r() * H, r() * 2 + 0.6, 0, Math.PI * 2); ctx.fill(); }
  // grain
  const id = ctx.getImageData(0, 0, W, H), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 14; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  ctx.putImageData(id, 0, 0);
  return cv;
}

export function makeColour() {
  const W = 1200, H = 900;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const r = rng(9);
  ctx.fillStyle = '#f7f5ef'; ctx.fillRect(0, 0, W, H);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // heart
  const heart = new Path2D('M300 330 C300 250 190 220 160 300 C130 380 230 450 300 520 C370 450 470 380 440 300 C410 220 300 250 300 330 Z');
  ctx.fillStyle = '#d8342b'; ctx.fill(heart); ctx.lineWidth = 14; ctx.strokeStyle = '#1d1d22'; ctx.stroke(heart);
  // star
  const star = new Path2D(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? 80 : 190; star[i ? 'lineTo' : 'moveTo'](820 + Math.cos(a) * rr, 330 + Math.sin(a) * rr); } star.closePath();
  ctx.fillStyle = '#f2c230'; ctx.fill(star); ctx.stroke(star);
  // blue wave banner
  const wave = new Path2D('M120 640 C260 580 380 700 520 640 C660 580 780 700 920 640 C990 610 1050 620 1090 640 L1090 760 C1050 740 990 730 920 760 C780 820 660 700 520 760 C380 820 260 700 120 760 Z');
  ctx.fillStyle = '#2f62c8'; ctx.fill(wave); ctx.stroke(wave);
  // jpeg-ish noise
  const id = ctx.getImageData(0, 0, W, H), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 16; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  ctx.putImageData(id, 0, 0);
  return cv;
}
