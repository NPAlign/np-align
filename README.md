# NP Align

**Live site: https://npalign.github.io/np-align/**

Lines a needlepoint chart up with the intersections of one specific, scanned canvas,
then exports a print file for xTool Studio.

1. **Add files** – a chart (PNG, 1 pixel per stitch) and a flatbed scan of the blank canvas
   (600 dpi, black paper laid over the canvas so the holes scan dark).
2. **Align** – finds every hole, links them into a grid that follows the canvas's own warp,
   and places each intersection at the centre of its four holes.
3. **Review** – places the chart, one pixel per intersection.
4. **Print** – paints each stitch on the threads around its intersection, keeps holes clear,
   and exports an SVG at true size in millimetres (or a PNG at the scan's dpi).

Everything runs in the browser; files never leave the computer.

## Run it

```bash
node tools/serve.mjs
```

Then open http://localhost:8765. Sample files are in `samples/`.

## Tests

```bash
node tools/test-align.mjs
```

Runs the engine on synthetic warped canvases (13 and 18 mesh, 300–1200 dpi) and checks
every detected intersection against its true position.
