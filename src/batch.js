// Several canvases on one scan (11 x 17 in glass): find each canvas and cut
// it out, with its tape and dot, as a scan of its own.
//
// Canvas has a texture nothing else on the glass has: bright threads with
// dark holes every 1/10 to 1/18 in. On a shrunken copy of the scan that shows
// up as strong local contrast; card, tape and paper are smooth. Patches of
// texture at least an inch across are canvases.

import { setPngDpi } from './png.js?v=202611181724';

/** Find canvases. Returns [{ x, y, w, h }] boxes in full-scan pixels, reading order. */
export function findCanvases(bitmap, dpi) {
  const W = bitmap.width, H = bitmap.height;
  const s = Math.min(1, 1600 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const perIn = dpi * s; // small-image pixels per inch
  // fine-scale contrast: canvas holes are 1/10 to 1/18 in apart
  const r = Math.max(1, Math.round(perIn * 0.05));
  const mean = boxMean(g, w, h, r);
  const sq = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) sq[i] = g[i] * g[i];
  const mean2 = boxMean(sq, w, h, r);
  const tex = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const sd = Math.sqrt(Math.max(0, mean2[i] - mean[i] * mean[i]));
    tex[i] = sd > 30 && mean[i] > 60 ? 1 : 0;
  }
  // close small gaps (enough texture nearby), then keep only solidly textured
  // areas, which drops dust, paper edges and other thin or blotchy shapes
  const near = boxMean(tex, w, h, Math.max(1, Math.round(perIn * 0.1)));
  for (let i = 0; i < w * h; i++) near[i] = near[i] > 0.35 ? 1 : 0;
  const core = boxMean(near, w, h, Math.max(1, Math.round(perIn * 0.2)));
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = core[i] > 0.9 ? 1 : 0;
  const comps = components(solid, w, h);
  const minArea = perIn * perIn * 1.0; // at least about 1 square inch
  const boxes = comps
    .filter((b) => b.n >= minArea && b.x1 - b.x0 > perIn * 0.8 && b.y1 - b.y0 > perIn * 0.8)
    .map((b) => ({ x: b.x0 / s, y: b.y0 / s, w: (b.x1 - b.x0 + 1) / s, h: (b.y1 - b.y0 + 1) / s }));
  // reading order: top to bottom in rows, then left to right
  boxes.sort((a, b) => (Math.abs(a.y - b.y) < dpi * 1.5 ? a.x - b.x : a.y - b.y));
  return boxes;
}

/**
 * Cut each canvas out with a margin for its tape and dot (3/4 in), without
 * reaching into a neighbouring canvas.
 */
export function cropBoxes(boxes, W, H, dpi) {
  const m = dpi * 0.75;
  const out = boxes.map((b) => ({ x0: Math.max(0, b.x - m), y0: Math.max(0, b.y - m), x1: Math.min(W, b.x + b.w + m), y1: Math.min(H, b.y + b.h + m) }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = 0; j < boxes.length; j++) {
      if (i === j) continue;
      const a = boxes[i], b = boxes[j], o = out[i];
      const overlapY = a.y < b.y + b.h + m && b.y < a.y + a.h + m;
      const overlapX = a.x < b.x + b.w + m && b.x < a.x + a.w + m;
      // neighbour to the right/left/below/above: stop halfway across the gap
      if (overlapY && b.x >= a.x + a.w) o.x1 = Math.min(o.x1, (a.x + a.w + b.x) / 2);
      if (overlapY && b.x + b.w <= a.x) o.x0 = Math.max(o.x0, (b.x + b.w + a.x) / 2);
      if (overlapX && b.y >= a.y + a.h) o.y1 = Math.min(o.y1, (a.y + a.h + b.y) / 2);
      if (overlapX && b.y + b.h <= a.y) o.y0 = Math.max(o.y0, (b.y + b.h + a.y) / 2);
    }
  }
  return out.map((o) => ({ x: Math.round(o.x0), y: Math.round(o.y0), w: Math.round(o.x1 - o.x0), h: Math.round(o.y1 - o.y0) }));
}

/** One canvas cut out of the scan, as a PNG file that keeps the scan's dpi. */
export async function cropFile(bitmap, box, dpi, name) {
  const c = document.createElement('canvas');
  c.width = box.w; c.height = box.h;
  c.getContext('2d').drawImage(bitmap, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  if (!blob) throw new Error('This canvas is too big for your browser to cut out.');
  return new File([await setPngDpi(blob, dpi)], name, { type: 'image/png' });
}

/** A small preview of one canvas. */
export function thumb(bitmap, box, size = 220) {
  const s = Math.min(1, size / Math.max(box.w, box.h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(box.w * s)); c.height = Math.max(1, Math.round(box.h * s));
  c.getContext('2d').drawImage(bitmap, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

// ---------------------------------------------------------------- helpers
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
function components(m, w, h) {
  const seen = new Uint8Array(w * h), out = [], stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || seen[s]) continue;
    stack.length = 0; stack.push(s); seen[s] = 1;
    let n = 0, x0 = w, x1 = -1, y0 = h, y1 = -1;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && m[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && m[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && m[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && m[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    out.push({ n, x0, x1, y0, y1 });
  }
  return out;
}
