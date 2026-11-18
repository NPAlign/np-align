// Back up and restore everything NP Align keeps in this browser: jobs (with
// their chart, scan and screenshot files), preferences and profile. The
// backup is an ordinary .zip: backup.json plus the job files.

import { jobs, prefs, profile } from './store.js?v=202611181728';

const VERSION = 1;

/** Build the backup as a Blob (a .zip). */
export async function makeBackup() {
  const all = await jobs.all();
  const entries = [];
  const meta = { app: 'NP Align', version: VERSION, made: new Date().toISOString(), prefs: prefs.get(), profile: profile.get(), jobs: [] };
  for (const j of all) {
    const copy = { ...j, files: {} };
    for (const [kind, file] of Object.entries(j.files || {})) {
      if (!file) continue;
      const ext = ((file.name || '').match(/\.[\w]+$/) || [''])[0];
      const path = `files/${j.id}-${kind}${ext}`;
      copy.files[kind] = { path, name: file.name || `${kind}${ext}`, type: file.type || '' };
      entries.push({ path, blob: file });
    }
    meta.jobs.push(copy);
  }
  entries.unshift({ path: 'backup.json', blob: new Blob([JSON.stringify(meta)], { type: 'application/json' }) });
  return { blob: await zip(entries), jobs: all.length };
}

/** Read a backup .zip and put it back. Returns counts. */
export async function readBackup(file) {
  const files = await unzip(file);
  const metaBlob = files.get('backup.json');
  if (!metaBlob) throw new Error("This isn't an NP Align backup.");
  const meta = JSON.parse(await metaBlob.text());
  if (meta.app !== 'NP Align') throw new Error("This isn't an NP Align backup.");
  return { meta, files };
}

export async function restoreBackup({ meta, files }) {
  let restored = 0;
  for (const j of meta.jobs || []) {
    const rebuilt = { ...j, files: {} };
    for (const [kind, f] of Object.entries(j.files || {})) {
      const blob = files.get(f.path);
      if (blob) rebuilt.files[kind] = new File([blob], f.name, { type: f.type });
    }
    const updated = j.updated;
    await jobs.put(rebuilt);
    // keep the original "last changed" date, so the job list keeps its order
    if (updated) { rebuilt.updated = updated; await jobs.putRaw(rebuilt); }
    restored++;
  }
  if (meta.prefs) prefs.set(meta.prefs);
  if (meta.profile) profile.set(meta.profile);
  return { restored };
}

// ---------------------------------------------------------------- zip (stored, no compression)
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { path, blob } of entries) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const name = new TextEncoder().encode(path);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

async function unzip(file) {
  const tailLen = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("This isn't an NP Align backup.");
  const count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const out = new Map();
  let p = 0;
  for (let k = 0; k < count; k++) {
    const method = cd.getUint16(p + 10, true), size = cd.getUint32(p + 20, true), nlen = cd.getUint16(p + 28, true);
    const elen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true), local = cd.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
    const lh = new DataView(await file.slice(local, local + 30).arrayBuffer());
    const start = local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    if (method !== 0) throw new Error('This backup was changed by another program and can\'t be read. Use the original backup file.');
    out.set(name, file.slice(start, start + size));
    p += 46 + nlen + elen + clen;
  }
  return out;
}
