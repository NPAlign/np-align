// Accuracy test: run the engine on synthetic warped canvases and compare every
// detected intersection with its true position.
//   node tools/test-align.mjs
import { analyzeCanvas } from '../src/align.js';
import { makeCanvas } from './synth.mjs';

const cases = [
  { name: '13 mesh, 600 dpi, warped', width: 1800, height: 1500, dpi: 600, mesh: 13, warp: 1.2 },
  { name: '18 mesh, 600 dpi, warped', width: 1800, height: 1500, dpi: 600, mesh: 18, warp: 1.5, rotationDeg: -2.5 },
  { name: '18 mesh, 300 dpi', width: 1200, height: 1000, dpi: 300, mesh: 18, warp: 1.0 },
  { name: '13 mesh, 1200 dpi', width: 2400, height: 2000, dpi: 1200, mesh: 13, warp: 1.0, rotationDeg: 4 },
  { name: '13 mesh, light holes (white lid)', width: 1500, height: 1200, dpi: 600, mesh: 13, dark: false },
];

let failed = 0;
for (const c of cases) {
  const t0 = Date.now();
  const syn = makeCanvas(c);
  const res = analyzeCanvas(syn.gray, c.width, c.height, { dpi: c.dpi, mesh: c.mesh });
  const { ix, iy, cols, rows, valid } = res.intersections;

  // Match each detected intersection to the nearest true one.
  // Find the true (u,v) of detected intersection (0,0) by brute search, then
  // the rest follow by index — this also checks the grid has no index slips.
  let errMax = 0, errSum = 0, n = 0, slips = 0;
  let anchor = null;
  for (let r = 0; r < rows && !anchor; r++) for (let q = 0; q < cols && !anchor; q++) {
    const k = r * cols + q;
    if (Number.isNaN(ix[k])) continue;
    let best = null;
    for (let u = -80; u < 80; u++) for (let v = -80; v < 80; v++) {
      const [tx, ty] = syn.truth(u + 0.5, v + 0.5);
      const d = Math.hypot(tx - ix[k], ty - iy[k]);
      if (!best || d < best.d) best = { d, u: u - q, v: v - r };
      if (d < syn.pitch * 0.3) break;
    }
    anchor = best;
  }
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    const k = r * cols + q;
    if (Number.isNaN(ix[k])) continue;
    const [tx, ty] = syn.truth(q + anchor.u + 0.5, r + anchor.v + 0.5);
    const e = Math.hypot(tx - ix[k], ty - iy[k]);
    if (e > syn.pitch * 0.25) slips++;
    errMax = Math.max(errMax, e); errSum += e; n++;
  }
  const ok = slips === 0 && errMax < syn.pitch * 0.12;
  if (!ok) failed++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${c.name}: ${valid} intersections (${cols}x${rows}), ` +
      `measured ${res.measuredMesh.toFixed(2)} mesh, holes=${res.polarity}, ` +
      `mean err ${(errSum / n).toFixed(2)}px, max ${errMax.toFixed(2)}px (spacing ${syn.pitch.toFixed(1)}px), ` +
      `slips ${slips}, filled ${res.stats.holesFilled}, ${Date.now() - t0}ms` +
      (res.warnings.length ? `\n      warnings: ${res.warnings.join(' | ')}` : '')
  );
}
process.exit(failed ? 1 : 0);
