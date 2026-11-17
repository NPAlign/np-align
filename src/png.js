// Read the resolution (DPI) stored in a PNG or JPEG, and stamp a DPI into a
// PNG so it prints at the scan's real size.

export function readDpi(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  // PNG: look for a pHYs chunk
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    let p = 8;
    while (p + 8 <= b.length) {
      const len = dv.getUint32(p);
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (type === 'pHYs' && b[p + 16] === 1) return Math.round(dv.getUint32(p + 8) * 0.0254);
      if (type === 'IDAT' || type === 'IEND') break;
      p += 12 + len;
    }
    return null;
  }
  // JPEG: JFIF density, then EXIF XResolution
  if (b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 4 < b.length && b[p] === 0xff) {
      const marker = b[p + 1];
      const len = dv.getUint16(p + 2);
      if (marker === 0xe0 && String.fromCharCode(...b.slice(p + 4, p + 8)) === 'JFIF') {
        const units = b[p + 11], xd = dv.getUint16(p + 12);
        if (units === 1 && xd > 1) return xd;
        if (units === 2 && xd > 1) return Math.round(xd * 2.54);
      }
      if (marker === 0xe1 && String.fromCharCode(...b.slice(p + 4, p + 8)) === 'Exif') {
        const dpi = exifDpi(dv, p + 10);
        if (dpi) return dpi;
      }
      if (marker === 0xda) break; // start of image data
      p += 2 + len;
    }
  }
  return null;
}

function exifDpi(dv, t) {
  try {
    const le = dv.getUint16(t) === 0x4949;
    const u16 = (o) => dv.getUint16(t + o, le);
    const u32 = (o) => dv.getUint32(t + o, le);
    const ifd = u32(4);
    const n = u16(ifd);
    let res = null, unit = 2;
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      const tag = u16(e);
      if (tag === 0x011a) res = u32(u32(e + 8)) / u32(u32(e + 8) + 4);
      if (tag === 0x0128) unit = u16(e + 8);
    }
    if (!res) return null;
    return Math.round(unit === 3 ? res * 2.54 : res);
  } catch {
    return null;
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Return a copy of a PNG blob with its resolution set to `dpi`. */
export async function setPngDpi(blob, dpi) {
  const src = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(src.buffer);
  const ihdrEnd = 8 + 12 + dv.getUint32(8);
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  cv.setUint32(8, ppm);
  cv.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  cv.setUint32(17, crc32(chunk.subarray(4, 17)));

  // copy all chunks except any existing pHYs, inserting ours after IHDR
  const parts = [src.subarray(0, ihdrEnd), chunk];
  let p = ihdrEnd;
  while (p < src.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(src[p + 4], src[p + 5], src[p + 6], src[p + 7]);
    if (type !== 'pHYs') parts.push(src.subarray(p, p + 12 + len));
    p += 12 + len;
  }
  return new Blob(parts, { type: 'image/png' });
}
