// Builds the print image: every design pixel is painted onto the patch of
// canvas around its own intersection (bounded by the centres of the four
// surrounding holes), then every hole pixel is cleared so no ink is put
// where there is no thread.
import { dilate } from './align.js?v=202611181623';

const maskCache = new WeakMap();

function holeMaskWithMargin(result, margin) {
  let byMargin = maskCache.get(result);
  if (!byMargin) maskCache.set(result, (byMargin = new Map()));
  if (!byMargin.has(margin)) {
    byMargin.clear(); // keep one at a time; these are large
    byMargin.set(margin, dilate(result.holeMask, result.width, result.height, margin));
  }
  return byMargin.get(margin);
}

/**
 * @param {object} p
 * @param {object} p.result       output of analyzeCanvas
 * @param {{width:number,height:number,data:Uint8ClampedArray}} p.design  one pixel per stitch
 * @param {{col:number,row:number}} p.offset  intersection under the design's top-left pixel
 * @param {number} p.margin       extra pixels kept clear around each hole
 * @param {'transparent'|'white'} p.background
 * @param {HTMLCanvasElement} [p.target]  canvas to reuse
 */
export function renderPrint({ result, design, offset, margin, background, outlineLight = false, target }) {
  const { width, height } = result;
  const { hx, hy, cols: hc } = result.holes;
  const { cols, rows } = result.intersections;

  const canvas = target || document.createElement('canvas');
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, width, height);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.5; // closes anti-aliasing seams between neighbouring patches

  const outlineWidth = Math.max(1.5, result.pitch * 0.06);
  let placed = 0, offGrid = 0;
  const d = design.data;
  for (let y = 0; y < design.height; y++) {
    for (let x = 0; x < design.width; x++) {
      const i = (y * design.width + x) * 4;
      if (d[i + 3] < 128) continue; // transparent pixel = no stitch
      const c = offset.col + x, r = offset.row + y;
      if (c < 0 || r < 0 || c >= cols || r >= rows) { offGrid++; continue; }
      const a = r * hc + c, b = a + 1, e = a + hc + 1, f = a + hc;
      if (Number.isNaN(hx[a]) || Number.isNaN(hx[b]) || Number.isNaN(hx[e]) || Number.isNaN(hx[f])) { offGrid++; continue; }
      const col = `rgb(${d[i]},${d[i + 1]},${d[i + 2]})`;
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(hx[a], hy[a]);
      ctx.lineTo(hx[b], hy[b]);
      ctx.lineTo(hx[e], hy[e]);
      ctx.lineTo(hx[f], hy[f]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (outlineLight && d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 > 232) {
        // near-white stitch: edge it in grey so it is visible on white canvas
        ctx.strokeStyle = 'rgb(150,150,150)';
        ctx.lineWidth = outlineWidth;
        ctx.stroke();
        ctx.lineWidth = 1.5;
      }
      placed++;
    }
  }

  const mask = holeMaskWithMargin(result, margin);
  const img = ctx.getImageData(0, 0, width, height);
  const px = img.data;
  const white = background === 'white';
  for (let i = 0, j = 3; i < mask.length; i++, j += 4) {
    if (mask[i]) px[j] = 0;
    if (white && px[j] < 255) {
      // composite over white
      const a = px[j] / 255;
      px[j - 3] = px[j - 3] * a + 255 * (1 - a);
      px[j - 2] = px[j - 2] * a + 255 * (1 - a);
      px[j - 1] = px[j - 1] * a + 255 * (1 - a);
      px[j] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, placed, offGrid };
}

/**
 * Move the finished print from the scan onto the xTool screenshot's frame.
 * Each stitch's patch is carried over separately, from its four holes in the
 * scan to the same four holes as the camera sees them, so the print follows
 * the canvas exactly as it now lies on the machine bed.
 *
 * @param {object} p
 * @param {object} p.scan      analyzeCanvas result for the scan
 * @param {object} p.shot      analyzeCanvas result for the screenshot
 * @param {{map:(c:number,r:number)=>[number,number]}} p.match  scan hole -> screenshot hole
 * @param {HTMLCanvasElement} p.scanPrint  output of renderPrint (scan frame)
 * @param {{width:number,height:number,data:Uint8ClampedArray}} p.design
 * @param {{col:number,row:number}} p.offset
 * @param {number} p.scale     output pixels per screenshot pixel
 * @param {'transparent'|'white'} p.background
 */
export function warpToShot({ scan, shot, match, scanPrint, design, offset, scale, background, target }) {
  const W = Math.round(shot.width * scale), H = Math.round(shot.height * scale);
  const canvas = target || document.createElement('canvas');
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (background === 'white') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const A = scan.holes, B = shot.holes;
  const { cols, rows } = scan.intersections;
  let placed = 0, offShot = 0;
  const P = [[0, 0], [0, 0], [0, 0], [0, 0]], Q = [[0, 0], [0, 0], [0, 0], [0, 0]];
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (let y = 0; y < design.height; y++) {
    for (let x = 0; x < design.width; x++) {
      if (design.data[(y * design.width + x) * 4 + 3] < 128) continue;
      const c = offset.col + x, r = offset.row + y;
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      let ok = true;
      for (let k = 0; k < 4 && ok; k++) {
        const hc = c + corners[k][0], hr = r + corners[k][1];
        const ai = hr * A.cols + hc;
        const [bc, br] = match.map(hc, hr);
        if (bc < 0 || br < 0 || bc >= B.cols || br >= B.rows) { ok = false; break; }
        const bi = br * B.cols + bc;
        if (Number.isNaN(A.hx[ai]) || Number.isNaN(B.hx[bi])) { ok = false; break; }
        P[k][0] = A.hx[ai]; P[k][1] = A.hy[ai];
        Q[k][0] = B.hx[bi] * scale; Q[k][1] = B.hy[bi] * scale;
      }
      if (!ok) { offShot++; continue; }
      const m = fitAffine(P, Q);
      if (!m) { offShot++; continue; }
      // clip to the patch (grown slightly so neighbouring patches meet without seams)
      const qx = (Q[0][0] + Q[1][0] + Q[2][0] + Q[3][0]) / 4, qy = (Q[0][1] + Q[1][1] + Q[2][1] + Q[3][1]) / 4;
      ctx.save();
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const dx = Q[k][0] - qx, dy = Q[k][1] - qy, len = Math.hypot(dx, dy) || 1;
        const gx = Q[k][0] + (dx / len) * 0.75, gy = Q[k][1] + (dy / len) * 0.75;
        k ? ctx.lineTo(gx, gy) : ctx.moveTo(gx, gy);
      }
      ctx.closePath();
      ctx.clip();
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      const sx = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0], P[3][0]) - 3));
      const sy = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1], P[3][1]) - 3));
      const ex = Math.min(scanPrint.width, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0], P[3][0]) + 3));
      const ey = Math.min(scanPrint.height, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1], P[3][1]) + 3));
      ctx.drawImage(scanPrint, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy);
      ctx.restore();
      placed++;
    }
  }
  return { canvas, placed, offShot };
}

// Least-squares affine map taking points P to points Q, as canvas
// setTransform arguments [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.
function fitAffine(P, Q) {
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, n = P.length;
  let bx0 = 0, bx1 = 0, bx2 = 0, by0 = 0, by1 = 0, by2 = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = P[i], [X, Y] = Q[i];
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y;
    bx0 += x * X; bx1 += y * X; bx2 += X;
    by0 += x * Y; by1 += y * Y; by2 += Y;
  }
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const sol = (b) => {
    const det = det3(M);
    if (Math.abs(det) < 1e-9) return null;
    const r = [];
    for (let k = 0; k < 3; k++) {
      const Mk = M.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
      r.push(det3(Mk) / det);
    }
    return r;
  };
  const ax = sol([bx0, bx1, bx2]), ay = sol([by0, by1, by2]);
  if (!ax || !ay) return null;
  return [ax[0], ay[0], ax[1], ay[1], ax[2], ay[2]];
}

function det3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

/** Scale a design to `stitchesWide` stitches, keeping its proportions. */
export function designPixels(bitmap, stitchesWide) {
  const w = Math.max(1, Math.round(stitchesWide));
  const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const shrinking = w < bitmap.width;
  ctx.imageSmoothingEnabled = shrinking; // keep hard pixel edges when enlarging
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

/** Rotate a design a quarter turn clockwise `turns` times. */
export function rotateDesign(design, turns) {
  let cur = design;
  for (let t = 0; t < ((turns % 4) + 4) % 4; t++) {
    const { width: w, height: h, data } = cur;
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // (x, y) -> (h-1-y, x) in a h-wide image
        const s = (y * w + x) * 4, d = (x * h + (h - 1 - y)) * 4;
        out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
      }
    }
    cur = { width: h, height: w, data: out };
  }
  return cur;
}
