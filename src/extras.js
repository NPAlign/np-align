// Color key and logo, built as stitches, and the corner-placement drawing.

const SW = 3; // swatch size in stitches

function blank(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
function put(img, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
}
/** Distinct colors in a design, most-used first. */
export function designColors(design, max = 40) {
  const counts = new Map();
  const d = design.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    if (d[i] >= 245 && d[i + 1] >= 245 && d[i + 2] >= 245) continue; // bare canvas, not printed
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => [(k >> 16) & 255, (k >> 8) & 255, k & 255]);
  return { colors: list.slice(0, max), total: list.length };
}

/** The key as a stitch image: a 3 × 3 square of each colour, one stitch apart, running down or across. */
export function buildKey(colors, dir) {
  const n = colors.length;
  if (!n) return blank(1, 1);
  const across = dir === 'across';
  const img = across ? blank(n * 4 - 1, SW) : blank(SW, n * 4 - 1);
  colors.forEach((c, i) => {
    const o = i * 4;
    for (let y = 0; y < SW; y++) for (let x = 0; x < SW; x++) put(img, across ? o + x : x, across ? y : o + y, c);
  });
  return img;
}

/** The logo scaled to `stitchesWide` stitches. */
export function buildLogo(bitmap, stitchesWide) {
  const w = Math.max(2, Math.round(stitchesWide));
  const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

// ---------------------------------------------------------------- layout on the grid

/** Rectangle of the grid (in intersections) that is reliably present. */
export function usableArea(I) {
  const { ix, cols, rows } = I;
  const colOk = (c) => { let n = 0; for (let r = 0; r < rows; r++) if (!Number.isNaN(ix[r * cols + c])) n++; return n / rows > 0.85; };
  const rowOk = (r) => { let n = 0; for (let c = 0; c < cols; c++) if (!Number.isNaN(ix[r * cols + c])) n++; return n / cols > 0.85; };
  let c0 = 0, c1 = cols - 1, r0 = 0, r1 = rows - 1;
  while (c0 < c1 && !colOk(c0)) c0++;
  while (c1 > c0 && !colOk(c1)) c1--;
  while (r0 < r1 && !rowOk(r0)) r0++;
  while (r1 > r0 && !rowOk(r1)) r1--;
  return { c0, r0, c1, r1 };
}

const EDGE = 2; // stitches kept clear from the canvas edge
const GAP = 2; // stitches between the design and the key/logo

/** Where an item of size w×h goes in `corner`, or null if it has no room. */
export function placeInCorner(area, design, corner, w, h) {
  const left = corner[1] === 'l', top = corner[0] === 't';
  const col = left ? area.c0 + EDGE : area.c1 - EDGE - w + 1;
  const row = top ? area.r0 + EDGE : area.r1 - EDGE - h + 1;
  const rect = { col, row, w, h };
  if (col < area.c0 || row < area.r0 || col + w - 1 > area.c1 || row + h - 1 > area.r1) return null;
  if (design && overlaps(rect, { col: design.col - GAP, row: design.row - GAP, w: design.w + 2 * GAP, h: design.h + 2 * GAP })) return null;
  return rect;
}
function overlaps(a, b) {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
}

/** Paste stitch images onto a grid-sized image (one pixel per intersection). */
export function composite(cols, rows, layers) {
  const out = blank(cols, rows);
  out.part = new Uint8Array(cols * rows); // 1 design, 2 color key, 3 logo
  for (const { img, col, row, part = 1 } of layers) {
    if (!img) continue;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const s = (y * img.width + x) * 4;
        if (img.data[s + 3] < 128) continue;
        const c = col + x, r = row + y;
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        const d = (r * cols + c) * 4;
        out.data[d] = img.data[s]; out.data[d + 1] = img.data[s + 1]; out.data[d + 2] = img.data[s + 2]; out.data[d + 3] = 255;
        out.part[r * cols + c] = part;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- corner picker

const CORNERS = [['tl', 'top left'], ['tr', 'top right'], ['bl', 'bottom left'], ['br', 'bottom right']];

/**
 * A small drawing of the canvas: click a + to add the color key or logo in
 * that corner, click the key to turn it, hover an item to remove it.
 * @param {HTMLElement} el
 * @param {{ get:()=>{key:any,logo:any}, set:(p:any)=>void, hasLogo:()=>boolean,
 *           roomFor?:(corner:string, what:'key'|'logo', dir?:string)=>boolean, aspect?:()=>number,
 *           designBox?:()=>({x:number,y:number,w:number,h:number}|null) }} api
 */
export function cornerPicker(el, api) {
  el.classList.add('picker');
  const render = () => {
    const p = api.get();
    const aspect = api.aspect ? api.aspect() : 1.25;
    el.style.setProperty('--aspect', String(aspect));
    const box = api.designBox ? api.designBox() : { x: 0.3, y: 0.28, w: 0.4, h: 0.44 };
    el.innerHTML = `
      <div class="picker-canvas" role="group" aria-label="Where the color key and logo print">
        ${box ? `<div class="picker-design" style="left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%"><span>Design</span></div>` : ''}
        ${CORNERS.map(([c, name]) => corner(c, name, p)).join('')}
      </div>`;
  };
  const corner = (c, name, p) => {
    const item = p.key?.corner === c ? 'key' : p.logo?.corner === c ? 'logo' : null;
    if (item === 'key') {
      const dir = p.key.dir || 'down';
      return `<div class="pc pc-${c}">
        <button type="button" class="pc-item pc-key ${dir}${p.key.missing ? ' missing' : ''}" data-turn="${c}" aria-label="Color key, ${name}, runs ${dir === 'down' ? 'up and down' : 'across'}. Click to turn it.">
          <i></i><i></i><i></i><i></i></button>
        <button type="button" class="pc-remove" data-remove="key" aria-label="Remove color key">×</button></div>`;
    }
    if (item === 'logo') {
      return `<div class="pc pc-${c}">
        <span class="pc-item pc-logo${p.logo.missing ? ' missing' : ''}" role="img" aria-label="Logo, ${name}${p.logo.missing ? ', no room' : ''}">${api.logoUrl?.() ? `<img src="${api.logoUrl()}" alt="" />` : 'Logo'}</span>
        <button type="button" class="pc-remove" data-remove="logo" aria-label="Remove logo">×</button></div>`;
    }
    // every empty corner can take the color key (placing it, or moving it
    // here) or a logo (placing the one you have, or uploading one now)
    const keyRoom = !api.roomFor || api.roomFor(c, 'key', p.key?.dir || 'down') || api.roomFor(c, 'key', p.key?.dir === 'down' ? 'across' : 'down');
    const haveLogo = api.hasLogo();
    const logoRoom = !api.roomFor || !haveLogo || api.roomFor(c, 'logo');
    const opts = [
      `<button type="button" data-put="key" data-corner="${c}" ${keyRoom ? '' : 'disabled'}>${p.key ? 'Move color key here' : 'Color key'}${keyRoom ? '' : ' (no room here)'}</button>`,
      haveLogo ? `<button type="button" data-put="logo" data-corner="${c}" ${logoRoom ? '' : 'disabled'}>${p.logo ? 'Move logo here' : 'Logo'}${logoRoom ? '' : ' (no room here)'}</button>` : '',
      api.uploadLogo ? `<button type="button" data-upload="${c}">${haveLogo ? 'Change logo (PNG or JPEG)…' : 'Upload a logo (PNG or JPEG)…'}</button>` : '',
    ].filter(Boolean);
    return `<div class="pc pc-${c}">
      <button type="button" class="pc-add" data-add="${c}" aria-haspopup="menu" aria-label="Add the color key or a logo to the ${name} corner">+</button>
      <div class="pc-menu" role="menu" hidden>${opts.join('')}</div></div>`;
  };
  el.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    const p = structuredClone(api.get());
    if (t.dataset.add) {
      const menu = t.nextElementSibling;
      el.querySelectorAll('.pc-menu').forEach((m) => m !== menu && (m.hidden = true));
      menu.hidden = !menu.hidden;
      return;
    }
    if (t.dataset.upload) {
      const c = t.dataset.upload;
      t.closest('.pc-menu').hidden = true;
      Promise.resolve(api.uploadLogo()).then((ok) => {
        if (!ok) return;
        const q = structuredClone(api.get());
        q.logo = { corner: c };
        if (q.key?.corner === c) q.key = null; // the two never share a corner
        api.set(q);
        render();
      });
      return;
    }
    if (t.dataset.put === 'key') {
      const want = p.key?.dir || 'down';
      const dir = !api.roomFor || api.roomFor(t.dataset.corner, 'key', want) ? want : want === 'down' ? 'across' : 'down';
      p.key = { corner: t.dataset.corner, dir };
    }
    if (t.dataset.put === 'logo') p.logo = { corner: t.dataset.corner };
    if (t.dataset.turn) {
      const next = p.key.dir === 'down' ? 'across' : 'down';
      if (!api.roomFor || api.roomFor(p.key.corner, 'key', next)) p.key.dir = next;
    }
    if (t.dataset.remove) p[t.dataset.remove] = null;
    api.set(p);
    render();
  });
  document.addEventListener('click', (e) => {
    if (!el.contains(e.target)) el.querySelectorAll('.pc-menu').forEach((m) => (m.hidden = true));
  });
  render();
  return { render };
}
