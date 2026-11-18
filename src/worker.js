// Runs the canvas analysis off the main thread so the page stays responsive.
import { analyzeCanvas } from './align.js?v=202611181620';

self.onmessage = (e) => {
  const { job, bitmap, dpi, mesh, polarity, autoDpi } = e.data;
  try {
    const w = bitmap.width, h = bitmap.height;
    const { gray, color } = toGray(bitmap);
    bitmap.close();
    const progress = (message) => self.postMessage({ type: 'progress', job, message });
    let res;
    if (autoDpi) {
      // A camera screenshot has no reliable resolution. Try a range of
      // spacings and keep the one that links the most holes.
      progress('Finding the canvas in the screenshot');
      let best = null;
      for (const d of [72, 96, 128, 160, 200, 260, 330, 420]) {
        try {
          const r = analyzeCanvas(gray, w, h, { dpi: d, mesh, polarity });
          if (!best || r.intersections.valid > best.intersections.valid) best = r;
        } catch {
          /* try the next spacing */
        }
      }
      if (!best) throw new Error('Could not find the canvas grid in the xTool screenshot. Crop it to the canvas and make sure the holes are visible.');
      res = best;
      res.warnings = res.warnings.filter((w2) => !/per inch, but you chose/.test(w2));
    } else {
      res = analyzeCanvas(gray, w, h, { dpi, mesh, polarity, onProgress: progress });
    }
    if (e.data.debugDot) globalThis.__dotDebug = [];
    res.dot = findDot(res, color, autoDpi ? mesh : res.measuredMesh);
    if (e.data.debugDot) res.dotDebug = globalThis.__dotDebug;
    self.postMessage({ type: 'done', job, result: res }, [
      res.holeMask.buffer,
      res.holes.hx.buffer,
      res.holes.hy.buffer,
      res.holes.area.buffer,
      res.intersections.ix.buffer,
      res.intersections.iy.buffer,
    ]);
  } catch (err) {
    self.postMessage({ type: 'error', job, message: err.message || String(err) });
  }
};

// Read pixels in horizontal strips to keep peak memory down on large scans.
// Also keeps a reduced colour copy, used to find the marker dot.
function toGray(bitmap) {
  const w = bitmap.width, h = bitmap.height;
  const f = Math.max(1, Math.round(Math.sqrt((w * h) / 2e6)));
  const cw = Math.ceil(w / f), ch = Math.ceil(h / f);
  const csum = new Float32Array(cw * ch * 3), ccnt = new Float32Array(cw * ch);
  const strip = Math.max(1, Math.floor(16e6 / (w * 4)));
  const oc = new OffscreenCanvas(w, Math.min(strip, h));
  const ctx = oc.getContext('2d', { willReadFrequently: true });
  const gray = new Uint8Array(w * h);
  for (let y0 = 0; y0 < h; y0 += strip) {
    const sh = Math.min(strip, h - y0);
    ctx.clearRect(0, 0, w, oc.height);
    ctx.drawImage(bitmap, 0, y0, w, sh, 0, 0, w, sh);
    const d = ctx.getImageData(0, 0, w, sh).data;
    let o = y0 * w;
    for (let yy = 0; yy < sh; yy++) {
      const crow = Math.floor((y0 + yy) / f) * cw;
      for (let x = 0; x < w; x++, o++) {
        const i = (yy * w + x) * 4;
        gray[o] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        const ci = crow + Math.floor(x / f);
        csum[ci * 3] += d[i]; csum[ci * 3 + 1] += d[i + 1]; csum[ci * 3 + 2] += d[i + 2]; ccnt[ci]++;
      }
    }
  }
  const rgb = new Uint8Array(cw * ch * 3);
  for (let i = 0; i < cw * ch; i++) for (let k = 0; k < 3; k++) rgb[i * 3 + k] = csum[i * 3 + k] / (ccnt[i] || 1);
  return { gray, color: { rgb, w: cw, h: ch, f } };
}

// The registration dot: one solid, roughly round mark (1/8–3/8 in), on the
// tape that holds the canvas, near a corner. Found as a round patch that is
// darker than its surroundings on every side (or, for a pale-coloured dot,
// clearly a different colour on every side), at a few dot sizes. Then it is
// located on the intersection grid by counting from the intersections near it.
// Returns { status: 'found'|'none'|'multiple'|'far', ... }.
function findDot(res, color, physMesh) {
  const { ix, iy, cols } = res.intersections;
  const { rgb, w, h, f } = color;
  // pixels per inch: from the hole spacing and the canvas mesh (a screenshot
  // has no real dpi of its own)
  const fullPerIn = res.pitch * physMesh;
  const pxPerIn = fullPerIn / f; // colour-image pixels per inch

  // integral images of luminance and each colour channel
  const W1 = w + 1;
  const IL = new Float64Array(W1 * (h + 1)), IR = new Float64Array(W1 * (h + 1)), IG = new Float64Array(W1 * (h + 1)), IB = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let sl = 0, sr = 0, sg = 0, sb = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3, r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      sl += 0.299 * r + 0.587 * g + 0.114 * b; sr += r; sg += g; sb += b;
      const o = (y + 1) * W1 + x + 1;
      IL[o] = IL[o - W1] + sl; IR[o] = IR[o - W1] + sr; IG[o] = IG[o - W1] + sg; IB[o] = IB[o - W1] + sb;
    }
  }
  const box = (I, x, y, r) => {
    const x0 = Math.max(0, Math.round(x - r)), x1 = Math.min(w, Math.round(x + r) + 1);
    const y0 = Math.max(0, Math.round(y - r)), y1 = Math.min(h, Math.round(y + r) + 1);
    const n = (x1 - x0) * (y1 - y0);
    return n > 0 ? (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / n : NaN;
  };
  const RING = 16;
  const cosT = [], sinT = [];
  for (let k = 0; k < RING; k++) { cosT.push(Math.cos((k / RING) * 2 * Math.PI)); sinT.push(Math.sin((k / RING) * 2 * Math.PI)); }

  // contrast of a dot of radius r at (x, y): the weakest side
  const score = (x, y, r) => {
    const rc = Math.max(1, r * 0.6), rr = Math.max(1, r * 0.35), R = r * 1.7;
    if (x - R - rr < 0 || y - R - rr < 0 || x + R + rr >= w || y + R + rr >= h) return null;
    const cl = box(IL, x, y, rc), cr = box(IR, x, y, rc), cg = box(IG, x, y, rc), cb = box(IB, x, y, rc);
    let dark = Infinity, col = Infinity;
    for (let k = 0; k < RING; k++) {
      const sx = x + R * cosT[k], sy = y + R * sinT[k];
      dark = Math.min(dark, box(IL, sx, sy, rr) - cl);
      const dr = box(IR, sx, sy, rr) - cr, dg = box(IG, sx, sy, rr) - cg, db = box(IB, sx, sy, rr) - cb;
      col = Math.min(col, Math.sqrt(dr * dr + dg * dg + db * db));
    }
    return { dark, col };
  };

  const cands = [];
  for (const dIn of [0.11, 0.15, 0.2, 0.27, 0.36]) {
    const r = (dIn / 2) * pxPerIn;
    const step = Math.max(1, Math.round(r / 3));
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const s = score(x, y, r);
        if (!s) continue;
        const ok = s.dark > 30 || (s.col > 75 && s.dark > -10);
        if (ok) cands.push({ x, y, r, dIn, s: Math.max(s.dark, s.col * 0.5) });
      }
    }
  }
  // strongest first; drop overlapping weaker ones
  cands.sort((p, q) => q.s - p.s);
  const picked = [];
  for (const c of cands) {
    if (picked.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < Math.max(p.r, c.r) * 2.2)) continue;
    picked.push(c);
  }
  if (globalThis.__dotDebug) globalThis.__dotDebug.push(...picked.slice(0, 20).map((c) => ({ x: c.x * f, y: c.y * f, dIn: c.dIn, s: Math.round(c.s) })));

  // refine each: centre of the dark pixels around it, and its real size
  const found = picked.slice(0, 10).map((c) => {
    const thr = (box(IL, c.x, c.y, c.r * 0.5) + box(IL, c.x + c.r * 1.7, c.y, c.r * 0.35)) / 2;
    let n = 0, sx = 0, sy = 0;
    const R = Math.ceil(c.r * 1.3);
    for (let y = Math.max(0, c.y - R); y <= Math.min(h - 1, c.y + R); y++) {
      for (let x = Math.max(0, c.x - R); x <= Math.min(w - 1, c.x + R); x++) {
        const i = (y * w + x) * 3;
        if (0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2] < thr) { n++; sx += x; sy += y; }
      }
    }
    const cx = n ? sx / n : c.x, cy = n ? sy / n : c.y;
    return { x: (cx + 0.5) * f, y: (cy + 0.5) * f, diameterIn: n ? (2 * Math.sqrt(n / Math.PI)) / pxPerIn : c.dIn, strength: c.s };
  }).filter((d) => d.diameterIn >= 0.11 && d.diameterIn <= 0.5);
  if (!found.length) return { status: 'none' };
  // keep clear winners only: a candidate far weaker than the best is texture
  const top = Math.max(...found.map((d) => d.strength));
  const strong = found.filter((d) => d.strength > top * 0.6);

  // place each candidate on the grid using nearby intersections
  const near = [];
  for (const d of strong) {
    const R = fullPerIn * 1.0; // count from intersections within 1 in
    const pts = [];
    let nearest = Infinity;
    for (let k = 0; k < ix.length; k++) {
      if (Number.isNaN(ix[k])) continue;
      const dist = Math.hypot(ix[k] - d.x, iy[k] - d.y);
      if (dist < nearest) nearest = dist;
      if (dist < R) pts.push(k);
    }
    const reach = nearest / fullPerIn - d.diameterIn / 2;
    if (reach > 0.75 || pts.length < 12) { near.push({ ...d, status: 'far', reachIn: reach }); continue; }
    const g = gridCoord(pts, ix, iy, cols, d.x, d.y);
    if (g) near.push({ ...d, ...g, status: 'found', reachIn: reach, aBitFar: reach > 0.5 });
  }
  const ok = near.filter((d) => d.status === 'found');
  if (ok.length > 1) return { status: 'multiple', count: ok.length, dots: ok };
  if (ok.length === 1) return ok[0];
  return near.length ? { status: 'far', ...near[0] } : { status: 'none' };
}

// Round, solid, dot-sized components of an eroded mask.
function blobs(core, w, h, e, f, pxPerIn, dark) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!core[s] || seen[s]) continue;
    stack.length = 0; stack.push(s); seen[s] = 1;
    let n = 0, sx = 0, sy = 0, x0 = w, x1 = -1, y0 = h, y1 = -1, edge = false, depth = 0;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i - x) / w;
      n++; sx += x; sy += y;
      if (dark) depth += dark.ref[i] - dark.lum[i];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      if (x > 0 && core[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && core[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && core[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && core[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    if (globalThis.__dotDebug && n * f * f > 50) {
      const dd = (Math.sqrt((4 * n) / Math.PI) + 2 * e) / pxPerIn;
      if (dd > 0.06 && dd < 0.7) globalThis.__dotDebug.push({ path: dark ? 'dark' : 'color', x: (sx / n + 0.5) * f | 0, y: (sy / n + 0.5) * f | 0, dIn: +dd.toFixed(3), depth: dark ? Math.round(depth / n) : null, fill: +(n / ((x1 - x0 + 1) * (y1 - y0 + 1))).toFixed(2), edge });
    }
    if (edge) continue;
    // a solid dot is well darker than its surroundings all through, not a faint fleck
    if (dark && depth / n < 45) continue;
    const bw = x1 - x0 + 1 + 2 * e, bh = y1 - y0 + 1 + 2 * e;
    const diam = Math.sqrt((4 * n) / Math.PI) + 2 * e; // undo the erosion
    const dIn = diam / pxPerIn;
    const asp = Math.max(bw, bh) / Math.min(bw, bh);
    const fill = n / ((x1 - x0 + 1) * (y1 - y0 + 1));
    if (dIn < 0.1 || dIn > 0.5 || asp > 1.6 || fill < 0.55) continue;
    out.push({ x: (sx / n + 0.5) * f, y: (sy / n + 0.5) * f, diameterIn: dIn });
  }
  return out;
}

// For each pixel: the 70th-percentile block mean within `k` blocks.
function typicalNearby(src, w, h, b, k) {
  const bw = Math.ceil(w / b), bh = Math.ceil(h / b);
  const bm = new Float32Array(bw * bh), bn = new Float32Array(bw * bh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = Math.floor(y / b) * bw + Math.floor(x / b);
    bm[i] += src[y * w + x]; bn[i]++;
  }
  for (let i = 0; i < bm.length; i++) bm[i] /= bn[i] || 1;
  const bref = new Float32Array(bw * bh);
  const vals = [];
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    vals.length = 0;
    for (let yy = Math.max(0, by - k); yy <= Math.min(bh - 1, by + k); yy++)
      for (let xx = Math.max(0, bx - k); xx <= Math.min(bw - 1, bx + k); xx++) vals.push(bm[yy * bw + xx]);
    vals.sort((p, q) => p - q);
    bref[by * bw + bx] = vals[Math.floor(vals.length * 0.7)];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = bref[Math.floor(y / b) * bw + Math.floor(x / b)];
  return out;
}

function maxFilter(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (src[y * w + k] > m) m = src[y * w + k];
    tmp[y * w + x] = m;
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
    out[y * w + x] = m;
  }
  return out;
}

function boxMean(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0, n = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) { acc += src[y * w + x]; n++; }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n;
      if (x + r + 1 < w) { acc += src[y * w + x + r + 1]; n++; }
      if (x - r >= 0) { acc -= src[y * w + x - r]; n--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0, n = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) { acc += tmp[y * w + x]; n++; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      if (y + r + 1 < h) { acc += tmp[(y + r + 1) * w + x]; n++; }
      if (y - r >= 0) { acc -= tmp[(y - r) * w + x]; n--; }
    }
  }
  return out;
}

// Fractional (c, r) of image point (x, y), from a local affine fit of the
// nearby intersections' grid indices to their image positions.
function gridCoord(pts, ix, iy, cols, x, y) {
  // fit c = a0 + a1 x + a2 y, r = b0 + b1 x + b2 y
  let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bc = [0, 0, 0], br = [0, 0, 0];
  for (const k of pts) {
    const v = [1, ix[k], iy[k]], c = k % cols, r = (k - c) / cols;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) S[i][j] += v[i] * v[j];
      bc[i] += v[i] * c; br[i] += v[i] * r;
    }
  }
  const solve = (b) => {
    const det = d3(S);
    if (Math.abs(det) < 1e-9) return null;
    return [0, 1, 2].map((k) => d3(S.map((row, i) => row.map((val, j) => (j === k ? b[i] : val)))) / det);
  };
  const a = solve(bc), b = solve(br);
  if (!a || !b) return null;
  return { c: a[0] + a[1] * x + a[2] * y, r: b[0] + b[1] * x + b[2] * y };
}
function d3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

function erode(mask, w, h, r) {
  // separable square erosion: a pixel survives if its whole (2r+1)² box is set
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      run = mask[y * w + x] ? run + 1 : 0;
      if (run >= 2 * r + 1) tmp[y * w + x - r] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y < h; y++) {
      run = tmp[y * w + x] ? run + 1 : 0;
      if (run >= 2 * r + 1) out[(y - r) * w + x] = 1;
    }
  }
  return out;
}
