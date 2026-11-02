// Runs the tracing pipeline off the main thread so sliders stay smooth.
import { Pipeline } from './pipeline.js';

const pipe = new Pipeline();
let input = null;

self.onmessage = (e) => {
  const d = e.data;
  if (d.type === 'image') { input = { rgba: d.rgba, w: d.w, h: d.h, id: d.id }; pipe.reset(); return; }
  if (d.type !== 'run' || !input) return;
  const t0 = performance.now();
  try {
    const r = pipe.run(input, d.settings, d.extras);
    const layers = r.layers.map((l) => ({
      key: l.key, name: l.name, color: l.color, mode: l.mode, enabled: l.enabled, swatch: l.swatch,
      share: l.share, background: l.background, centerline: l.centerline, stencil: l.stencil,
      paths: l.paths,
      mask: d.wantMasks && l.mask ? l.mask : null,
    }));
    self.postMessage({ seq: d.seq, ok: true, w: r.w, h: r.h, layers, frame: r.frame || null, info: r.info, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ seq: d.seq, ok: false, error: String(err && err.stack || err) });
  }
};
