// Reading the file types browsers can't open on their own:
//  - TIFF scans and charts
//  - Stitchly charts (.stitchly: an Apple archive holding DMC thread codes)
//  - OXS charts (the open cross-stitch format; MacStitch and others export it)
//  - PDF charts (first page drawn as a picture, then read like a PNG)
// A chart pattern comes back as one pixel per stitch, bare canvas transparent.

import { DMC } from './dmc.js?v=202611181724';

/** What kind of file this is, from its first bytes and name. */
export async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const s = String.fromCharCode(...head.slice(0, 32));
  const name = (file.name || '').toLowerCase();
  if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 42) || (head[0] === 0x4d && head[1] === 0x4d && head[3] === 42)) return 'tiff';
  if (s.startsWith('%PDF')) return 'pdf';
  if (head[0] === 0x89 && s.slice(1, 4) === 'PNG') return 'png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpeg';
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return 'webp';
  if (s.startsWith('Ursa Version')) return 'macstitch';
  if (name.endsWith('.stitchly')) return 'stitchly';
  if (name.endsWith('.oxs')) return 'oxs';
  if (/\.(sal|stitchalot)$/.test(name)) return 'stitchalot';
  if (s.includes('<?xml') || s.includes('<chart')) {
    const text = await file.slice(0, 4096).text();
    if (/<chart[\s>]/i.test(text)) return 'oxs';
    if (/PatternData|plist/i.test(text)) return 'stitchly';
  }
  return 'unknown';
}

// ======================================================================= TIFF

/**
 * Decode a baseline TIFF (8 or 16 bits per sample; grey, RGB, RGBA or
 * palette; strips or tiles; uncompressed, LZW, PackBits or Deflate).
 * Returns { width, height, data: Uint8ClampedArray RGBA, dpi }.
 */
export async function readTiff(buf) {
  const dv = new DataView(buf);
  const le = dv.getUint16(0) === 0x4949;
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const ifd = u32(4);
  const n = u16(ifd);
  const tags = {};
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    const size = (SZ[type] || 1) * count;
    const at = size <= 4 ? e + 8 : u32(e + 8);
    const vals = [];
    for (let i = 0; i < count && i < 1 << 20; i++) {
      if (type === 3) vals.push(u16(at + i * 2));
      else if (type === 4 || type === 16) vals.push(u32(at + i * (type === 16 ? 8 : 4)));
      else if (type === 5) vals.push(u32(at + i * 8) / (u32(at + i * 8 + 4) || 1));
      else vals.push(dv.getUint8(at + i));
    }
    tags[tag] = vals;
  }
  const W = tags[256][0], H = tags[257][0];
  const bps = (tags[258] || [1])[0];
  const comp = (tags[259] || [1])[0];
  const photo = (tags[262] || [2])[0];
  const spp = (tags[277] || [1])[0];
  const planar = (tags[284] || [1])[0];
  const predictor = (tags[317] || [1])[0];
  if (planar !== 1) throw new Error('This TIFF stores its colours in separate planes, which isn\'t supported. Save the scan as PNG, or as TIFF with "interleaved" pixels.');
  if (comp === 7 || comp === 6) throw new Error('This TIFF uses JPEG compression inside it. Save the scan as PNG, or as TIFF with LZW or no compression.');
  if (![1, 5, 8, 32946, 32773].includes(comp)) throw new Error(`This TIFF uses a compression NP Align can't read (type ${comp}). Save it as PNG, or TIFF with LZW or no compression.`);
  if (![8, 16].includes(bps) && !(bps === 1 && spp === 1)) throw new Error(`This TIFF has ${bps} bits per sample. Save the scan as 8-bit (24-bit colour) PNG or TIFF.`);
  const bytesPP = bps === 1 ? 1 / 8 : (bps / 8) * spp;

  // pieces: strips or tiles
  const tiled = !!tags[322];
  const tw = tiled ? tags[322][0] : W, th = tiled ? tags[323][0] : (tags[278] || [H])[0];
  const offs = tiled ? tags[324] : tags[273], counts = tiled ? tags[325] : tags[279];
  const out = new Uint8ClampedArray(W * H * 4);
  const palette = tags[320];
  const across = Math.ceil(W / tw);
  for (let p = 0; p < offs.length; p++) {
    let raw = new Uint8Array(buf, offs[p], counts[p]);
    if (comp === 5) raw = lzw(raw);
    else if (comp === 8 || comp === 32946) raw = await inflate(raw);
    else if (comp === 32773) raw = packbits(raw);
    const rowBytes = Math.ceil(tw * bytesPP);
    if (predictor === 2 && bps === 8) {
      for (let y = 0; y * rowBytes < raw.length; y++) for (let i = spp; i < rowBytes; i++) raw[y * rowBytes + i] = (raw[y * rowBytes + i] + raw[y * rowBytes + i - spp]) & 255;
    }
    const x0 = tiled ? (p % across) * tw : 0, y0 = tiled ? Math.floor(p / across) * th : p * th;
    for (let y = 0; y < th && y0 + y < H; y++) {
      for (let x = 0; x < tw && x0 + x < W; x++) {
        const o = ((y0 + y) * W + x0 + x) * 4;
        let r, g, b, a = 255;
        if (bps === 1) {
          const bit = (raw[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          r = g = b = (photo === 0 ? 1 - bit : bit) * 255;
        } else {
          const s = (k) => (bps === 16 ? raw[y * rowBytes + (x * spp + k) * 2 + (le ? 1 : 0)] : raw[y * rowBytes + x * spp + k]);
          if (photo === 3 && palette) {
            const i = s(0), m = palette.length / 3;
            r = palette[i] >> 8; g = palette[m + i] >> 8; b = palette[2 * m + i] >> 8;
          } else if (spp >= 3) { r = s(0); g = s(1); b = s(2); if (spp >= 4) a = s(3); }
          else { r = g = b = photo === 0 ? 255 - s(0) : s(0); if (spp === 2) a = s(1); }
        }
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
      }
    }
  }
  let dpi = tags[282] ? tags[282][0] : null;
  if (dpi && (tags[296] || [2])[0] === 3) dpi *= 2.54;
  return { width: W, height: H, data: out, dpi: dpi ? Math.round(dpi) : null };
}

// TIFF LZW (MSB-first codes, 9 to 12 bits, 256 = clear, 257 = end).
function lzw(src) {
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), length = new Int32Array(4096);
  let out = new Uint8Array(Math.max(1024, src.length * 4)), op = 0;
  const grow = (need) => { if (op + need > out.length) { const n = new Uint8Array(Math.max(out.length * 2, op + need)); n.set(out); out = n; } };
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; length[i] = 1; }
  let next = 258, bits = 9, pos = 0, prev = -1;
  const total = src.length * 8;
  const emit = (code) => {
    const n = length[code];
    grow(n);
    let c = code;
    for (let i = n - 1; i >= 0; i--) { out[op + i] = suffix[c]; c = prefix[c]; }
    op += n;
  };
  while (pos + bits <= total) {
    let code = 0;
    for (let i = 0; i < bits; i++) code = (code << 1) | ((src[(pos + i) >> 3] >> (7 - ((pos + i) & 7))) & 1);
    pos += bits;
    if (code === 257) break;
    if (code === 256) { next = 258; bits = 9; prev = -1; continue; }
    if (prev === -1) { emit(code); prev = code; continue; }
    if (code < next) {
      emit(code);
      if (next < 4096) { prefix[next] = prev; suffix[next] = first[code]; first[next] = first[prev]; length[next] = length[prev] + 1; next++; }
    } else {
      // the code being defined right now: prev + first(prev)
      if (next < 4096) { prefix[next] = prev; suffix[next] = first[prev]; first[next] = first[prev]; length[next] = length[prev] + 1; next++; }
      emit(next - 1);
    }
    prev = code;
    if (next + 1 >= 1 << bits && bits < 12) bits++;
  }
  return out.subarray(0, op);
}
function packbits(src) {
  const out = [];
  for (let i = 0; i < src.length;) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) { for (let k = 0; k <= n; k++) out.push(src[i++]); }
    else if (n !== -128) { const v = src[i++]; for (let k = 0; k < 1 - n; k++) out.push(v); }
  }
  return Uint8Array.from(out);
}
async function inflate(src) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([src]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decode a TIFF into an ImageBitmap (for the scan and chart paths). */
export async function tiffBitmap(file) {
  const t = await readTiff(await file.arrayBuffer());
  return { bitmap: await createImageBitmap(new ImageData(t.data, t.width, t.height)), dpi: t.dpi };
}

// =================================================================== charts

/** A chart from a pattern file: { width, height, data (RGBA, 1 px per stitch), threads, unknown, mesh } */
function blankChart(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
function hexRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

// Thread code -> colour. Stitchly codes look like "D310", "DBLANC", "DP310"
// (pearl cotton, same colours), sometimes with a layer prefix ("<id>-2 D310").
export function threadColour(code, custom = {}) {
  const c = String(code).replace(/^.*\s/, '').trim();
  if (custom[c]) return { code: c, hex: custom[c], name: DMC[normalise(c)]?.[0] || c, known: true };
  const k = normalise(c);
  if (k && DMC[k]) {
    const label = `DMC ${k === 'BLANC' ? 'Blanc' : k}`, nm = DMC[k][0];
    return { code: c, hex: DMC[k][1], name: nm.startsWith('DMC') ? label : `${label} ${nm}`, known: true };
  }
  return { code: c, hex: '#9a9a9a', name: c.replace(/^D/, 'DMC '), known: false };
}
function normalise(c) {
  let m = /^D(P|C)?(\w+)$/.exec(c);
  if (!m) return null;
  let k = m[2].toUpperCase();
  if (/^0\d$/.test(k)) k = String(+k); // "01" -> "1"
  if (k === 'WHITE') k = 'BLANC';
  return k;
}

export async function readStitchly(file, custom) {
  const text = await file.text();
  const m = /<key>PatternData<\/key>\s*<data>([\s\S]*?)<\/data>/.exec(text);
  if (!m) throw new Error("This Stitchly file couldn't be read. Export the chart from Stitchly as a PNG instead.");
  const bin = Uint8Array.from(atob(m[1].replace(/\s+/g, '')), (ch) => ch.charCodeAt(0));
  const arch = bplist(bin);
  const objs = arch.$objects;
  const R = (v) => (v && v.UID !== undefined ? objs[v.UID] : v);
  const root = R(arch.$top.root);
  const w = R(root.width), h = R(root.height);
  const codes = R(root.layerCodes)['NS.objects'].map((u) => R(u));
  const out = blankChart(w, h);
  const threads = new Map();
  codes.forEach((code, i) => {
    if (!code || /empty$/.test(code)) return;
    const t = threadColour(code, custom);
    if (!threads.has(t.code)) threads.set(t.code, { ...t, count: 0 });
    threads.get(t.code).count++;
    const [r, g, b] = hexRgb(t.hex);
    out.data[i * 4] = r; out.data[i * 4 + 1] = g; out.data[i * 4 + 2] = b; out.data[i * 4 + 3] = 255;
  });
  return { ...out, threads: [...threads.values()], mesh: R(root.fabricCount) || null, name: R(root.patternName)?.['NS.string'] };
}

/** The thread code in every cell of a Stitchly chart (null = bare canvas). */
export async function stitchlyCodes(file) {
  const text = await file.text();
  const m = /<key>PatternData<\/key>\s*<data>([\s\S]*?)<\/data>/.exec(text);
  if (!m) throw new Error(`${file.name} isn't a Stitchly chart NP Align can read.`);
  const arch = bplist(Uint8Array.from(atob(m[1].replace(/\s+/g, '')), (ch) => ch.charCodeAt(0)));
  const objs = arch.$objects;
  const R = (v) => (v && v.UID !== undefined ? objs[v.UID] : v);
  const root = R(arch.$top.root);
  const codes = R(root.layerCodes)['NS.objects'].map((u) => {
    const c = R(u);
    return !c || /empty$/.test(c) ? null : String(c).replace(/^.*\s/, '').trim();
  });
  return { width: R(root.width), height: R(root.height), codes };
}

/**
 * Learn each thread's exact colour by laying a Stitchly chart over the PNG
 * Stitchly exported from it. The PNG may cover the whole grid or just the
 * stitched part; whichever lines up so that every thread is one colour wins.
 * Returns { colours: {code: '#rrggbb'}, agreement, threads }.
 */
export function learnColours(chart, img) {
  const { width: gw, height: gh, codes } = chart;
  const { width: W, height: H, data } = img;
  // stitched area in the grid
  let cx0 = gw, cx1 = -1, cy0 = gh, cy1 = -1;
  codes.forEach((c, i) => { if (!c) return; const x = i % gw, y = (i - x) / gw; if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y; });
  if (cx1 < 0) throw new Error('That Stitchly chart has no stitches in it.');
  // drawn area in the picture: not transparent, and not the corner colour
  const corner = 0, isBg = (i) => data[i + 3] < 128 || (data[corner + 3] >= 128 && Math.abs(data[i] - data[corner]) + Math.abs(data[i + 1] - data[corner + 1]) + Math.abs(data[i + 2] - data[corner + 2]) < 12);
  let px0 = W, px1 = -1, py0 = H, py1 = -1;
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (!isBg((y * W + x) * 4)) { if (x < px0) px0 = x; if (x > px1) px1 = x; if (y < py0) py0 = y; if (y > py1) py1 = y; }
  const tries = [
    { gx: 0, gy: 0, gw, gh, x: 0, y: 0, w: W, h: H }, // picture = whole grid
    { gx: cx0, gy: cy0, gw: cx1 - cx0 + 1, gh: cy1 - cy0 + 1, x: 0, y: 0, w: W, h: H }, // picture = stitched part
  ];
  if (px1 >= 0) tries.push({ gx: cx0, gy: cy0, gw: cx1 - cx0 + 1, gh: cy1 - cy0 + 1, x: px0, y: py0, w: px1 - px0 + 1, h: py1 - py0 + 1 }); // drawn part = stitched part
  let best = null;
  for (const t of tries) {
    const kx = t.w / t.gw, ky = t.h / t.gh;
    if (kx < 1 || ky < 1 || Math.abs(kx - ky) > 0.05 * kx) continue;
    const seen = new Map(); // code -> Map(colour -> count)
    let total = 0;
    for (let gy = 0; gy < t.gh; gy++) for (let gx = 0; gx < t.gw; gx++) {
      const code = codes[(t.gy + gy) * gw + t.gx + gx];
      if (!code) continue;
      const sx = Math.min(W - 1, Math.floor(t.x + (gx + 0.5) * kx)), sy = Math.min(H - 1, Math.floor(t.y + (gy + 0.5) * ky));
      const i = (sy * W + sx) * 4;
      if (data[i + 3] < 128) continue;
      const hex = '#' + [data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      if (!seen.has(code)) seen.set(code, new Map());
      const m = seen.get(code);
      m.set(hex, (m.get(hex) || 0) + 1);
      total++;
    }
    let agree = 0;
    const colours = {};
    for (const [code, m] of seen) {
      const [hex, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      colours[code] = hex; agree += n;
    }
    const agreement = total ? agree / total : 0;
    if (!best || agreement > best.agreement) best = { colours, agreement, threads: seen.size };
  }
  if (!best || best.agreement < 0.95) throw new Error("The chart and the picture don't line up. Export the PNG from that same Stitchly chart with no gridlines, symbols or border.");
  return best;
}

// OXS: <chart><properties chartwidth chartheight/><palette><palette_item
// index number name color/>...</palette><fullstitches><stitch x y palindex/>
export async function readOxs(file) {
  const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error("This OXS file couldn't be read.");
  const props = doc.querySelector('properties');
  const w = +props?.getAttribute('chartwidth'), h = +props?.getAttribute('chartheight');
  if (!(w > 0 && h > 0)) throw new Error("This OXS file doesn't say its stitch count.");
  const pal = new Map();
  for (const p of doc.querySelectorAll('palette > palette_item')) {
    pal.set(p.getAttribute('index'), { code: p.getAttribute('number') || '', name: p.getAttribute('name') || '', hex: '#' + (p.getAttribute('color') || '999999').replace(/^#/, '').slice(0, 6) });
  }
  const out = blankChart(w, h);
  const threads = new Map();
  for (const s of doc.querySelectorAll('fullstitches > stitch')) {
    const x = +s.getAttribute('x'), y = +s.getAttribute('y'), pi = s.getAttribute('palindex');
    if (pi === '0' || x < 0 || y < 0 || x >= w || y >= h) continue; // 0 is the cloth
    const t = pal.get(pi);
    if (!t) continue;
    const key = t.code || t.name || pi;
    if (!threads.has(key)) threads.set(key, { code: key, name: [t.code, t.name].filter(Boolean).join(' '), hex: t.hex, known: true, count: 0 });
    threads.get(key).count++;
    const [r, g, b] = hexRgb(t.hex), i = (y * w + x) * 4;
    out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = 255;
  }
  return { ...out, threads: [...threads.values()] };
}

/** First page of a PDF, drawn at a good size, as an ImageBitmap. */
export async function pdfBitmap(file) {
  const lib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const page = await pdf.getPage(1);
  const v1 = page.getViewport({ scale: 1 });
  const scale = Math.min(8, 3000 / Math.max(v1.width, v1.height));
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  return { bitmap: await createImageBitmap(c), pages: pdf.numPages };
}

// ================================================================ bplist
// Apple binary property list (what NSKeyedArchiver writes).
function bplist(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (String.fromCharCode(...b.slice(0, 6)) !== 'bplist') throw new Error('not a binary plist');
  const t = b.length - 32;
  const offSize = b[t + 6], refSize = b[t + 7];
  const num = Number(dv.getBigUint64(t + 8)), top = Number(dv.getBigUint64(t + 16)), table = Number(dv.getBigUint64(t + 24));
  const uint = (o, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[o + i]; return v; };
  const offsets = Array.from({ length: num }, (_, i) => uint(table + i * offSize, offSize));
  const cache = new Map();
  const len = (o, low) => {
    if (low !== 15) return [low, o + 1];
    const m = b[o + 1], n = 1 << (m & 15);
    return [uint(o + 2, n), o + 2 + n];
  };
  const read = (ref) => {
    if (cache.has(ref)) return cache.get(ref);
    const o = offsets[ref], marker = b[o], hi = marker >> 4, low = marker & 15;
    let v;
    if (marker === 0x00) v = null;
    else if (marker === 0x08) v = false;
    else if (marker === 0x09) v = true;
    else if (hi === 1) { const n = 1 << low; v = n === 8 ? Number(dv.getBigInt64(o + 1)) : uint(o + 1, n); }
    else if (hi === 2) v = low === 2 ? dv.getFloat32(o + 1) : dv.getFloat64(o + 1);
    else if (hi === 3) v = dv.getFloat64(o + 1);
    else if (hi === 4) { const [n, s] = len(o, low); v = b.slice(s, s + n); }
    else if (hi === 5) { const [n, s] = len(o, low); v = String.fromCharCode(...b.slice(s, s + n)); }
    else if (hi === 6) { const [n, s] = len(o, low); let str = ''; for (let i = 0; i < n; i++) str += String.fromCharCode(dv.getUint16(s + i * 2)); v = str; }
    else if (hi === 8) v = { UID: uint(o + 1, low + 1) };
    else if (hi === 10) { const [n, s] = len(o, low); v = []; cache.set(ref, v); for (let i = 0; i < n; i++) v.push(read(uint(s + i * refSize, refSize))); return v; }
    else if (hi === 13) { const [n, s] = len(o, low); v = {}; cache.set(ref, v); for (let i = 0; i < n; i++) v[read(uint(s + i * refSize, refSize))] = read(uint(s + (n + i) * refSize, refSize)); return v; }
    else v = null;
    cache.set(ref, v);
    return v;
  };
  return read(top);
}
