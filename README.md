# Laser Trace

Turn a phone photo of a drawing into a **LightBurn-ready SVG** — cleaned up, traced, coloured by layer, with optional text, stencil bridges and cut borders.

**Run it:** https://arrakistacos.github.io/laser-trace/ — nothing to install, works on phone and desktop, and your photos never leave your device (all processing runs in the browser).

## Toolbox

| | |
|---|---|
| **Input** | Take a photo (phone camera), choose a file, drag & drop, or paste. Rotate, mirror, and **Crop & straighten** — drag four corners onto the paper's corners to fix a photo taken at an angle. |
| **Clean up** | *Even out lighting* removes shadows and uneven phone lighting. Brightness, contrast, noise softening. Threshold: **Auto** (Otsu), **Manual**, or **Local** (adaptive — best for pencil and shaded photos). Invert for light-on-dark drawings. |
| **Detail** | One slider: low drops specks and small wiggles, high keeps every mark. |
| **Smoothness** | 0 = straight line segments, higher = flowing Bézier curves with fewer nodes. Real corners are detected and kept sharp. |
| **Trace type** | **Outline shapes** traces around every mark. **Single line (centerline)** follows the middle of each pen stroke — one clean line per stroke, perfect for fast scoring. |
| **Fill / hollow** | Per layer: **Fill** engraves solid shapes, **Line** gives the traced outline (hollow look, or a cut). *Fill enclosed areas* turns outline drawings into solid silhouettes. *Close gaps* joins broken pencil lines; *Thicken/thin* makes strokes bolder or finer. |
| **Colours → layers** | Splits a colour drawing into 2–8 colours; each becomes its own LightBurn layer. Colours are matched to the nearest LightBurn palette colour and the paper is switched off automatically. Re-assign any layer to any of LightBurn's 30 colours (C00–C29). |
| **Stencil** | Cuts the drawing out of a sheet and adds **bridges** so islands (the middle of an O, an eye…) don't fall out. Bridge width, direction and sheet margin are adjustable. Text is included in the stencil. |
| **Cut border** | Contour (sticker/keychain shape, optionally joined into one piece), rectangle, rounded rectangle or circle, at an offset you choose. |
| **Text** | 18 bundled fonts (bold sans, condensed, serif, script, handwriting, typewriter, blackletter, stencil) or load your own TTF/OTF/WOFF. Letter height in mm, spacing, line height, rotation, alignment, multi-line. **Weld** merges overlapping script letters into clean outlines. Drag text on the canvas. |
| **Cleanup brush** | **Erase** smudges and stray marks or **Draw** in missing bits, right on the canvas. Undo / clear. |
| **Views** | Photo, Mask (what the threshold sees), Vector (in LightBurn colours) and Burn (preview on wood). |
| **Export** | One SVG in millimetres, sized to the design. Stats show design size, path and node count, line length, and warn if it's bigger than the Ortur LM2 bed. |

Presets get you started: *Pen drawing*, *Pencil sketch*, *Single line*, *Solid shapes*, *Stencil*, *Colours*.

## LightBurn

File → Import the SVG. It's in real millimetres and every colour lands on its own layer:

| Default colour | Used for | Set the layer to |
|---|---|---|
| ⚫ C00 black | Traced drawing | **Fill** (engrave) — or **Line** if you chose Line / single line |
| 🔴 C02 red | Stencil cuts, cut borders | **Line**, your cut settings |
| 🔵 C01 blue | Text | **Fill** or **Line** to match |
| others | Colour mode layers | whatever each colour should do |

Tips: run engrave layers before the cut layer, and turn on *Optimization → Cut inner shapes first*. Holes are written before their outer shape for the same reason.

## Notes

- Better photos trace better: light the page evenly, fill the frame, and shoot straight down (or use Crop & straighten).
- Working resolution trades speed for detail: *Fast* 1000 px, *Normal* 1600 px, *Fine* 2400 px on the long side.
- iPhone HEIC photos open in Safari; if a browser can't read one, set the camera to *Most Compatible* or share as JPEG.
- Settings are remembered in the browser between visits.

## Development

Plain ES modules, no build step. opentype.js and the fonts are vendored in `vendor/`.

```bash
python3 -m http.server 8000   # then open http://localhost:8000
node test/run.mjs             # tracing / cleanup / stencil / SVG tests
```

- `js/imageops.js` – greyscale, background flattening, thresholds, morphology, despeckle, fill holes, colour k-means, perspective warp, stencil bridges
- `js/trace.js` – outline tracing, Zhang–Suen centerline + stroke graph, corner detection, Bézier fitting
- `js/pipeline.js` – settings → masks → vector layers (memoised stages), borders and stencil frame
- `js/worker.js` – runs the pipeline off the main thread
- `js/text.js` – font loading, text layout, welding
- `js/svg.js` – LightBurn SVG writer and palette
- `js/app.js` – UI, canvas view, brush, crop, export

Fonts are from Google Fonts under the SIL Open Font License (Permanent Marker and Special Elite under Apache 2.0) — see `vendor/fonts/`. opentype.js is MIT.
