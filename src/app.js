import { Viewer } from './viewer.js';
import { renderPrint, rotateDesign } from './render.js';
import { readDpi } from './png.js';
import { matchGrids } from './match.js';
import { buildGeometry, stitchShapes, guideFrame, buildSvg, drawPreview } from './svg.js';
import { designColors, buildKey, buildLogo, placeInCorner, composite, cornerPicker } from './extras.js';
import { jobs, prefs, profile, relativeDay, STATUS } from './store.js';
import { GUIDE_HTML, TROUBLE_HTML } from './guide.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ===================================================================== shell
const pages = [...document.querySelectorAll('.page')];
function show(name) {
  pages.forEach((p) => (p.hidden = p.dataset.page !== name));
  $('stepper').hidden = !['files', 'work'].includes(name);
  window.scrollTo(0, 0);
}

const avatar = $('avatar'), menu = $('accountMenu');
function refreshAvatar() {
  const p = profile.get();
  avatar.textContent = (p.name.trim()[0] || '·').toUpperCase();
}
avatar.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = menu.hidden;
  menu.hidden = !open;
  avatar.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', () => { menu.hidden = true; avatar.setAttribute('aria-expanded', 'false'); });

async function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [, a, b] = h.split('/');
  if (!a) return showHome();
  if (a === 'jobs') return showJobs();
  if (a === 'preferences') return showPrefs();
  if (a === 'profile') return showProfile();
  if (a === 'guide') { $('guideBody').innerHTML = GUIDE_HTML + TROUBLE_HTML; return show('guide'); }
  if (a === 'new') {
    const j = await newJob();
    location.replace(`#/job/${j.id}`);
    return;
  }
  if (a === 'job' && b) return openJob(b);
  showHome();
}
window.addEventListener('hashchange', route);

// ===================================================================== home
function jobRow(j) {
  const st = STATUS[j.status] || STATUS.draft;
  const meta = [j.mesh && j.stW ? `${j.mesh} mesh, ${j.stW} × ${j.stH} stitches` : '', relativeDay(j.updated)].filter(Boolean).join(' · ');
  return `<li><a class="job" href="#/job/${j.id}">
    <span class="job-thumb">${j.thumb ? `<img class="pixelated" src="${j.thumb}" alt="" />` : ''}</span>
    <span class="job-text"><b>${esc(j.name || 'Untitled job')}</b><span>${esc(meta)}</span></span>
    <span class="tag ${st.cls}">${st.label}</span></a></li>`;
}

async function showHome() {
  show('home');
  const p = profile.get();
  $('welcome').textContent = p.name ? `Welcome back, ${p.name.split(' ')[0]}` : 'Welcome';
  const all = await jobs.all();
  const resume = all.find((j) => j.status === 'draft' || j.status === 'ready');
  $('resume').innerHTML = resume
    ? `<div class="resume"><span class="job-thumb big">${resume.thumb ? `<img class="pixelated" src="${resume.thumb}" alt="" />` : ''}</span>
        <span class="job-text"><b>${esc(resume.name || 'Untitled job')}</b><span>${relativeDay(resume.updated)}</span></span>
        <span class="tag">${(STATUS[resume.status] || STATUS.draft).label}</span></div>
       <a class="btn btn-dark" href="#/job/${resume.id}">Open this job</a>`
    : '<p class="lead">Nothing in progress. Start a new job when you have your files ready.</p>';
  $('recentJobs').innerHTML = all.slice(0, 4).map(jobRow).join('') || '<li class="empty">Your jobs will show up here.</li>';
  const printed = all.filter((j) => j.status === 'lined-up' || j.status === 'off');
  const now = new Date();
  const month = printed.filter((j) => { const d = new Date(j.printedAt || j.updated); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
  $('stats').innerHTML = [
    [printed.length, 'Canvases printed'],
    [printed.filter((j) => j.status === 'lined-up').length, 'Lined up'],
    [month.length, 'This month'],
  ].map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');
}

// ===================================================================== my jobs
let allJobsCache = [];
async function showJobs() {
  show('jobs');
  allJobsCache = await jobs.all();
  renderJobs();
}
function renderJobs() {
  const q = $('jobSearch').value.trim().toLowerCase();
  const list = allJobsCache.filter((j) => !q || (j.name || '').toLowerCase().includes(q));
  $('allJobs').innerHTML = list.map((j) => jobRow(j).replace('</a></li>', `</a><button type="button" class="row-delete" data-del="${j.id}" aria-label="Delete ${esc(j.name || 'job')}">Delete</button></li>`)).join('')
    || `<li class="empty">${q ? 'No jobs match that search.' : 'No jobs yet.'}</li>`;
}
$('jobSearch').addEventListener('input', renderJobs);
$('allJobs').addEventListener('click', async (e) => {
  const id = e.target.dataset?.del;
  if (!id) return;
  const j = allJobsCache.find((x) => x.id === id);
  if (!confirm(`Delete "${j?.name || 'this job'}"? Its files are removed from this computer. This can't be undone.`)) return;
  await jobs.remove(id);
  allJobsCache = allJobsCache.filter((x) => x.id !== id);
  renderJobs();
});

// ===================================================================== preferences
let prefPicker = null;
function showPrefs() {
  show('preferences');
  const p = prefs.get();
  setSwitch($('pOutline'), p.outline);
  document.querySelectorAll('[data-porient]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.porient === p.orient)));
  $('logoWidth').value = p.logoWidth;
  renderLogoPreview(p.logo);
  const api = {
    get: () => prefs.get().placements,
    set: (pl) => { const q = prefs.get(); q.placements = pl; prefs.set(q); },
    hasLogo: () => !!prefs.get().logo,
  };
  if (!prefPicker) prefPicker = cornerPicker($('prefPicker'), api); else prefPicker.render();
}
function renderLogoPreview(url) {
  $('logoPreview').innerHTML = url ? `<img src="${url}" alt="Your logo" />` : '<span>No logo yet</span>';
  $('logoRemove').disabled = !url;
}
$('pOutline').addEventListener('click', () => {
  const p = prefs.get(); p.outline = !p.outline; prefs.set(p); setSwitch($('pOutline'), p.outline);
});
document.querySelectorAll('[data-porient]').forEach((b) => b.addEventListener('click', () => {
  const p = prefs.get(); p.orient = b.dataset.porient; prefs.set(p);
  document.querySelectorAll('[data-porient]').forEach((o) => o.setAttribute('aria-checked', String(o === b)));
}));
$('logoFile').addEventListener('change', async () => {
  const f = $('logoFile').files[0];
  if (!f) return;
  const bmp = await createImageBitmap(f);
  const c = document.createElement('canvas');
  const s = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const p = prefs.get(); p.logo = c.toDataURL('image/png');
  if (!prefs.set(p)) return toast('That logo is too large to save. Try a smaller image.');
  renderLogoPreview(p.logo);
  prefPicker?.render();
});
$('logoRemove').addEventListener('click', () => {
  const p = prefs.get(); p.logo = null;
  if (p.placements.logo) p.placements.logo = null;
  prefs.set(p); renderLogoPreview(null); prefPicker?.render();
});
$('logoWidth').addEventListener('change', () => {
  const p = prefs.get(); p.logoWidth = Math.max(4, Math.min(80, +$('logoWidth').value || 16)); prefs.set(p);
});

// ===================================================================== profile
function showProfile() {
  show('profile');
  const p = profile.get();
  $('pfName').value = p.name; $('pfShop').value = p.shop;
}
for (const id of ['pfName', 'pfShop']) {
  $(id).addEventListener('input', () => {
    profile.set({ name: $('pfName').value, shop: $('pfShop').value });
    refreshAvatar();
  });
}

// ===================================================================== job
let J = null; // persisted job
let R = null; // runtime: bitmaps, analysis results
const viewer = new Viewer($('view'));
viewer.onZoom = (s) => ($('zoomPct').textContent = `${Math.round(s * 100)}%`);

async function newJob() {
  const p = prefs.get();
  const j = {
    id: jobs.newId(), created: Date.now(), status: 'draft', step: 1, reached: 1, name: '',
    mesh: 18, stW: null, stH: null,
    outline: p.outline, orient: p.orient, placements: structuredClone(p.placements),
    logo: p.logo, logoWidth: p.logoWidth, customized: false,
    manualTurn: 0, nudge: [0, 0],
    files: {}, thumb: null, dpi: null,
  };
  await jobs.put(j);
  return j;
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => J && jobs.put(J), 300);
}

async function openJob(id) {
  const j = await jobs.get(id);
  if (!j) { toast('That job could not be found.'); location.replace('#/'); return; }
  if (J?.id !== id) {
    J = j;
    R = { chart: null, scanBmp: null, shotBmp: null, scan: null, shot: null, match: null };
    resetTiles();
    fillConfig();
    show('files');
    const loads = [];
    if (J.files.chart) loads.push(loadChart(J.files.chart, true));
    if (J.files.scan) loads.push(loadScan(J.files.scan, true));
    if (J.files.shot) loads.push(loadShot(J.files.shot, true));
    await Promise.all(loads);
  }
  go(1);
}

function go(step) {
  J.step = step;
  J.reached = Math.max(J.reached || 1, step);
  save();
  show(step === 1 ? 'files' : 'work');
  for (const n of [2, 3, 4]) $(`panel${n}`).hidden = step !== n;
  document.querySelectorAll('.step').forEach((b) => {
    const n = +b.dataset.step;
    b.classList.toggle('current', n === step);
    b.classList.toggle('reached', n <= J.reached);
    b.disabled = n > J.reached || (n > 2 && !R.match);
    n === step ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current');
  });
  if (step === 3) enterReview();
  if (step === 4) enterPrint();
  requestAnimationFrame(() => viewer._resize());
}
document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => { if (!b.disabled) go(+b.dataset.step); }));

// ---------------------------------------------------------------- tiles
function resetTiles() {
  for (const id of ['chartDrop', 'scanDrop', 'shotDrop']) {
    const d = $(id);
    d.classList.remove('filled', 'bad');
    d.querySelector('.drop-check').innerHTML = '';
    const img = d.querySelector('.drop-thumb'); img.hidden = true; img.removeAttribute('src');
    d.querySelector('.drop-cta').innerHTML = 'Drop it here, or <u>choose a file</u>';
  }
  refreshStatus();
}
function tile(id, { ok, lines, thumb, name, extra = '' }) {
  const d = $(id);
  d.classList.toggle('filled', ok !== false);
  d.classList.toggle('bad', ok === false);
  d.querySelector('.drop-cta').innerHTML = `${esc(name)} · <u>replace</u>`;
  d.querySelector('.drop-check').innerHTML = lines.map(([kind, text]) => `<span class="chk ${kind}">${esc(text)}</span>`).join('') + extra;
  const img = d.querySelector('.drop-thumb');
  if (thumb) { img.src = thumb; img.hidden = false; }
}
function setupDrop(dropId, inputId, onFile) {
  const drop = $(dropId), input = $(inputId);
  input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('dragging'); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
}
setupDrop('chartDrop', 'chartFile', (f) => loadChart(f));
setupDrop('scanDrop', 'scanFile', (f) => loadScan(f));
setupDrop('shotDrop', 'shotFile', (f) => loadShot(f));

async function decode(file) {
  try { return await createImageBitmap(file); } catch {
    throw new Error(/tiff?$/i.test(file.name || '') ? 'This browser cannot open TIFF files yet. Save the scan as PNG and upload that.' : 'This file could not be opened. Use PNG or JPG.');
  }
}

// ---------------------------------------------------------------- chart
async function loadChart(file, restoring = false) {
  try {
    if (!/png$/i.test(file.type) && !/\.png$/i.test(file.name || '')) throw new Error('This chart could not be added: charts must be PNG. PDF and JPG charts are not taken.');
    const bmp = await decode(file);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const block = blockSize(data, bmp.width, bmp.height);
    if (bmp.width / block > 400 || bmp.height / block > 400) throw new Error(`This chart could not be added: it counts as ${bmp.width / block} × ${bmp.height / block} stitches, and the most is 400 a side. If it has gridlines, smoothing or a border, export it again without them.`);
    R.chart = { bmp, data, w: bmp.width, h: bmp.height, block };
    if (!restoring) {
      J.files.chart = file;
      J.name = (file.name || 'chart').replace(/\.[^.]+$/, '');
      J.stW = bmp.width / block; J.stH = bmp.height / block;
      const t = document.createElement('canvas');
      const s = Math.min(1, 96 / Math.max(J.stW, J.stH));
      t.width = Math.max(1, Math.round(J.stW * s)); t.height = Math.max(1, Math.round(J.stH * s));
      const tc = t.getContext('2d'); tc.imageSmoothingEnabled = false; tc.drawImage(bmp, 0, 0, t.width, t.height);
      J.thumb = t.toDataURL();
      J.whiteChoice = null;
      $('stW').value = J.stW; $('stH').value = J.stH;
      sizeNote();
      save();
    }
    chartTile();
  } catch (e) {
    tile('chartDrop', { ok: false, name: file.name || 'chart', lines: [['bad', e.message]] });
    R.chart = null;
  }
  refreshStatus();
}
function chartTile() {
  if (!R?.chart) return;
  const err = chartError();
  const lines = err ? [['bad', err]] : [['ok', `${J.stW} × ${J.stH} stitches${R.chart.block > 1 ? ` (${R.chart.w / J.stW} px per stitch)` : ''}`]];
  let extra = '';
  if (!err) {
    const raw = chartStitches(true);
    const white = whiteOutside(raw);
    if (white.count) {
      if (!J.whiteChoice) lines.push(['warn', `This chart has solid white outside its outline (${white.count.toLocaleString()} stitches). That would print as a square around your design.`]);
      extra = `<span class="white-choice">
        <span class="ba"><img class="pixelated" src="${stitchesUrl(raw)}" alt="" /><small>As is</small></span>
        <span class="ba"><img class="pixelated" src="${stitchesUrl(applyWhite(raw, white.mask))}" alt="" /><small>White removed</small></span>
        <span class="btn-row">
          <button type="button" class="btn btn-sm ${J.whiteChoice === 'remove' ? 'btn-primary' : 'btn-outline'}" data-white="remove" aria-pressed="${J.whiteChoice === 'remove'}">Remove white outside</button>
          <button type="button" class="btn btn-sm ${J.whiteChoice === 'keep' ? 'btn-primary' : 'btn-outline'}" data-white="keep" aria-pressed="${J.whiteChoice === 'keep'}">Keep as is</button>
        </span></span>`;
    }
    const { total } = designColors(chartStitches(), 1000);
    lines.push(['ok', `${total} color${total === 1 ? '' : 's'}`]);
    if (total > 40) lines.push(['warn', 'Over 40 colors: is this a photo rather than a flat chart? The key shows the 40 most used.']);
  }
  tile('chartDrop', { ok: !err, name: J.files.chart?.name || 'chart', thumb: J.thumb, lines, extra });
}
$('chartDrop').addEventListener('click', (e) => {
  const b = e.target.closest('[data-white]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  J.whiteChoice = b.dataset.white; save(); chartTile(); refreshStatus();
});
// near-white stitches connected to the chart's edge
function whiteOutside(st) {
  const { width: w, height: h, data } = st;
  const isW = (i) => data[i * 4 + 3] >= 128 && data[i * 4] > 240 && data[i * 4 + 1] > 240 && data[i * 4 + 2] > 240;
  const mask = new Uint8Array(w * h), stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  let count = 0;
  while (stack.length) {
    const i = stack.pop();
    if (mask[i] || !isW(i)) continue;
    mask[i] = 1; count++;
    const x = i % w, y = (i - x) / w;
    if (x > 0) stack.push(i - 1); if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w); if (y < h - 1) stack.push(i + w);
  }
  let opaque = 0;
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] >= 128) opaque++;
  if (count < Math.max(4, w * h * 0.02) || count > opaque * 0.9) return { count: 0, mask };
  return { count, mask };
}
function applyWhite(st, mask) {
  const out = { width: st.width, height: st.height, data: new Uint8ClampedArray(st.data) };
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.data[i * 4 + 3] = 0;
  return out;
}
function stitchesUrl(st) {
  const c = document.createElement('canvas');
  c.width = st.width; c.height = st.height;
  c.getContext('2d').putImageData(new ImageData(st.data, st.width, st.height), 0, 0);
  return c.toDataURL();
}
// Largest block size that every run of identical pixels is a multiple of.
function blockSize(d, w, h) {
  const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
  let g = 0;
  const same = (i, j) => d[i] === d[j] && d[i + 1] === d[j + 1] && d[i + 2] === d[j + 2] && d[i + 3] === d[j + 3];
  for (let y = 0; y < h && g !== 1; y++) {
    let run = 1;
    for (let x = 1; x <= w; x++) {
      if (x < w && same((y * w + x) * 4, (y * w + x - 1) * 4)) run++;
      else { g = gcd(g, run); run = 1; if (g === 1) break; }
    }
  }
  for (let x = 0; x < w && g !== 1; x++) {
    let run = 1;
    for (let y = 1; y <= h; y++) {
      if (y < h && same((y * w + x) * 4, ((y - 1) * w + x) * 4)) run++;
      else { g = gcd(g, run); run = 1; if (g === 1) break; }
    }
  }
  return Math.max(1, g);
}
function chartError() {
  if (!R?.chart) return 'No chart';
  const { w, h } = R.chart;
  if (!(J.stW > 0 && J.stH > 0)) return 'Enter the stitch count, width × height.';
  if (w % J.stW || h % J.stH) return `This chart could not be added: ${w} × ${h} px doesn't split evenly into ${J.stW} × ${J.stH} stitches. Export it at one pixel per stitch, or a whole number of pixels per stitch.`;
  if (w / J.stW !== h / J.stH) return 'The pixels per stitch must be the same across and down. Check the stitch count.';
  return null;
}
/** One pixel per stitch, sampled from the centre of each block. */
function chartStitches(raw = false) {
  const { data, w } = R.chart;
  const k = R.chart.w / J.stW;
  const out = { width: J.stW, height: J.stH, data: new Uint8ClampedArray(J.stW * J.stH * 4) };
  for (let y = 0; y < J.stH; y++) for (let x = 0; x < J.stW; x++) {
    const sx = Math.floor(x * k + k / 2), sy = Math.floor(y * k + k / 2);
    const s = (sy * w + sx) * 4, o = (y * J.stW + x) * 4;
    out.data[o] = data[s]; out.data[o + 1] = data[s + 1]; out.data[o + 2] = data[s + 2]; out.data[o + 3] = data[s + 3];
  }
  if (!raw && J.whiteChoice === 'remove') return applyWhite(out, whiteOutside(out).mask);
  return out;
}

// ---------------------------------------------------------------- scan & screenshot
function analyze(file, opts) {
  return new Promise(async (resolve, reject) => {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    let bitmap;
    try { bitmap = await decode(file); } catch (e) { w.terminate(); return reject(e); }
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') return;
      w.terminate();
      m.type === 'done' ? resolve(m.result) : reject(new Error(m.message));
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'The picture could not be read.')); };
    w.postMessage({ bitmap, ...opts }, [bitmap]);
  });
}

async function loadScan(file, restoring = false) {
  const name = file.name || 'scan';
  tile('scanDrop', { ok: true, name, lines: [['info', 'Checking your scan…']] });
  if (!restoring) { J.files.scan = file; save(); }
  R.scan = null; R.match = null;
  refreshStatus();
  try {
    const head = await file.slice(0, 256 * 1024).arrayBuffer();
    const dpi = readDpi(head) || 600;
    if (dpi < 300) throw new Error(`This scan is ${dpi} dpi. Scan again at 600 dpi (300 dpi is the lowest that works).`);
    R.scanBmp = await decode(file);
    J.dpi = dpi;
    const look = quickLook(R.scanBmp);
    if (R.scanBmp.width < 2000 && R.scanBmp.height < 2000 && !readDpi(head)) throw new Error('This looks like an xTool screenshot. Drop it in the xTool Screenshot box, and put your 600 dpi scan here.');
    if (look.gray) throw new Error('This is a black and white scan. Scan again in Color (24-bit).');
    R.scanLook = look;
    R.scan = await analyze(file, { dpi, mesh: J.mesh, polarity: 'auto' });
    if (!restoring) delete (J.manualDots ||= {}).scan;
    applyManualDot('scan');
    // the scan picks the mesh once its intersections are found
    const m = Math.round(R.scan.measuredMesh);
    if (m >= 10 && m <= 18 && m !== J.mesh && Math.abs(R.scan.measuredMesh - m) < 0.6) {
      J.mesh = m; $('mesh').value = String(m); sizeNote(); save();
    }
    scanTile(file, dpi);
  } catch (e) {
    R.scan = null;
    let msg = e.message;
    if (/could not find the canvas holes/i.test(msg)) msg = R.scanLook?.washed ? 'Scan is washed out: it came out nearly all white. Put dark card behind the canvas and turn every scanner enhancement off.' : 'No intersections found. Scan again in Color on dark card, with every scanner enhancement off.';
    tile('scanDrop', { ok: false, name, lines: [['bad', msg]] });
  }
  refreshStatus();
}
function scanTile(file, dpi) {
  const r = R.scan;
  const lines = [];
  const { c0, c1, r0, r1 } = sharedBoxOf(r.intersections);
  lines.push(['ok', `${r.measuredMesh.toFixed(1)} mesh measured · canvas about ${((c1 - c0 + 1) / r.measuredMesh).toFixed(1)} × ${((r1 - r0 + 1) / r.measuredMesh).toFixed(1)} in`]);
  lines.push([dpi >= 600 ? 'ok' : 'warn', `${dpi} dpi${dpi < 600 ? ' (600 is recommended)' : ''}`]);
  if (Math.abs(r.measuredMesh - J.mesh) / J.mesh > 0.06) lines.push(['warn', `You picked ${J.mesh} mesh but this canvas measures ${r.measuredMesh.toFixed(1)}. Check the mesh, and that the scan is at its true dpi.`]);
  if (R.scanLook?.washed) lines.push(['warn', 'The scan looks washed out. Dark card behind the canvas and enhancements off give the clearest intersections.']);
  lines.push(...dotLines(r.dot, 'scan'));
  tile('scanDrop', { ok: !lines.some((l) => l[0] === 'bad'), name: file.name || 'scan', lines, thumb: URL.createObjectURL(file) });
}
// small look at a picture: black-and-white? washed out?
function quickLook(bmp) {
  const c = document.createElement('canvas');
  const s = Math.min(1, 240 / Math.max(bmp.width, bmp.height));
  c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let spread = 0, light = 0, n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    spread = Math.max(spread, Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]));
    if (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 > 225) light++;
  }
  return { gray: spread < 6, washed: light / n > 0.85 };
}
function dotLines(dot, where) {
  if (!dot || dot.status === 'none') return [['warn', `No dot found in the ${where}. A dot that can be found is one solid mark, pea-sized (⅛ to ⅜ in), darker than the tape it's on, on the tape where it lies over the canvas, near a corner and outside the design.`]];
  if (dot.status === 'multiple') return [['bad', `Found ${dot.count} dots in the ${where}. Use one dot only, with any writing well away from it.`]];
  if (dot.status === 'far') return [['bad', `Your dot is too far from the intersections to count from (${dot.reachIn ? dot.reachIn.toFixed(1) + ' in' : 'over ¾ in'}). Put a new dot on the tape where it lies on top of the canvas, near a corner, within about ½ in of intersections you can see.`]];
  if (dot.aBitFar) return [['warn', `Dot found, ${dot.reachIn.toFixed(2)} in from the nearest intersections. It works, but next time put it a little closer, within about ½ in.`]];
  return [['ok', dot.manual ? 'Dot set by hand' : 'Dot found']];
}

async function loadShot(file, restoring = false) {
  const name = file.name || 'screenshot';
  tile('shotDrop', { ok: true, name, lines: [['info', 'Checking your screenshot…']] });
  if (!restoring) { J.files.shot = file; save(); }
  R.shot = null; R.match = null;
  refreshStatus();
  try {
    R.shotBmp = await decode(file);
    const res = await analyze(file, { mesh: J.mesh, polarity: 'auto', autoDpi: true });
    if (res.pitch < 4) throw new Error('The intersections are too close together to read. Zoom in further in xTool Studio so the canvas fills more of the screen, and take it again.');
    R.shot = res;
    if (!restoring) delete (J.manualDots ||= {}).shot;
    applyManualDot('shot');
    const lines = [['ok', `${res.intersections.valid.toLocaleString()} intersections found`]];
    if (res.pitch < 6) lines.push(['warn', `The canvas came out small (${res.pitch.toFixed(1)} px between holes). It will work, but zoom in more next time.`]);
    lines.push(...dotLines(res.dot, 'screenshot'));
    tile('shotDrop', { ok: !lines.some((l) => l[0] === 'bad'), name, lines, thumb: URL.createObjectURL(file) });
  } catch (e) {
    R.shot = null;
    tile('shotDrop', { ok: false, name, lines: [['bad', e.message]] });
  }
  refreshStatus();
}

function sharedBoxOf(I) {
  const { ix, cols, rows } = I;
  const colN = new Int32Array(cols), rowN = new Int32Array(rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (!Number.isNaN(ix[r * cols + c])) { colN[c]++; rowN[r]++; }
  let c0 = 0, c1 = cols - 1, r0 = 0, r1 = rows - 1;
  while (c0 < c1 && colN[c0] < rows * 0.5) c0++;
  while (c1 > c0 && colN[c1] < rows * 0.5) c1--;
  while (r0 < r1 && rowN[r0] < cols * 0.5) r0++;
  while (r1 > r0 && rowN[r1] < cols * 0.5) r1--;
  return { c0, c1, r0, r1 };
}

// ---------------------------------------------------------------- configure
function fillConfig() {
  $('mesh').value = String(J.mesh);
  $('stW').value = J.stW ?? ''; $('stH').value = J.stH ?? '';
  setSwitch($('outline'), J.outline);
  document.querySelectorAll('[data-orient]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.orient === J.orient)));
  $('jobOnly').hidden = !J.customized;
  jobPicker.render();
  sizeNote();
}
function customized() { J.customized = true; $('jobOnly').hidden = false; save(); }

$('mesh').addEventListener('change', () => {
  J.mesh = +$('mesh').value; customized(); sizeNote();
  if (J.files.scan) loadScan(J.files.scan, true);
  if (J.files.shot) loadShot(J.files.shot, true);
});
for (const id of ['stW', 'stH']) {
  // the stitch counts stay exactly as typed
  $(id).addEventListener('input', () => {
    J[id] = Math.max(0, Math.round(+$(id).value)) || null;
    save(); sizeNote(); chartTile(); refreshStatus();
  });
}
function sizeNote() {
  $('sizeNote').textContent = J?.stW && J?.stH ? `${(J.stW / J.mesh).toFixed(2)} × ${(J.stH / J.mesh).toFixed(2)} in on ${J.mesh} mesh` : 'Enter the stitch count, width × height.';
}
$('outline').addEventListener('click', () => { J.outline = !J.outline; setSwitch($('outline'), J.outline); customized(); });
document.querySelectorAll('[data-orient]').forEach((b) => b.addEventListener('click', () => {
  J.orient = b.dataset.orient;
  document.querySelectorAll('[data-orient]').forEach((o) => o.setAttribute('aria-checked', String(o === b)));
  if (R) R.autoTurn = null;
  customized();
}));
const jobPicker = cornerPicker($('jobPicker'), {
  get: () => J?.placements || { key: null, logo: null },
  logoUrl: () => J?.logo,
  set: (pl) => { J.placements = pl; customized(); },
  hasLogo: () => !!J?.logo,
});
$('usePrefs').addEventListener('click', () => {
  const p = prefs.get();
  Object.assign(J, { outline: p.outline, orient: p.orient, placements: structuredClone(p.placements), logo: p.logo, logoWidth: p.logoWidth, customized: false });
  save(); fillConfig();
});

function refreshStatus() {
  const chartOk = !!(R?.chart && !chartError() && (J.whiteChoice || !whiteOutside(chartStitches(true)).count));
  const scanOk = !!R?.scan && !$('scanDrop').classList.contains('bad');
  const shotOk = !!R?.shot && !$('shotDrop').classList.contains('bad');
  $('chkChart').classList.toggle('done', chartOk);
  $('chkScan').classList.toggle('done', scanOk);
  $('chkShot').classList.toggle('done', shotOk);
  $('startAlign').disabled = !(chartOk && scanOk && shotOk);
}

// ===================================================================== align
$('startAlign').addEventListener('click', async () => {
  go(2);
  const prog = (k, state) => ($('alignProgress').querySelector(`[data-k="${k}"]`).className = state);
  $('alignAlerts').innerHTML = '';
  prog('scan', 'done'); prog('shot', 'done'); prog('match', 'active');
  viewer.setScan(R.shotBmp); viewer.print = null; viewer.rings = []; viewer.points = null;
  busy('Matching the two pictures');
  await new Promise((r) => setTimeout(r, 30));
  try {
    const dots = R.scan.dot?.status === 'found' && R.shot.dot?.status === 'found' ? { a: R.scan.dot, b: R.shot.dot } : null;
    R.match = matchGrids(R.scan.holes, R.shot.holes, { dots });
    R.geo = buildGeometry(R.scan, R.shot, R.match);
    R.autoTurn = null;
    prog('match', 'done');
    busy(null);
    go(3);
  } catch (e) {
    busy(null);
    prog('match', 'failed');
    alertBox('alignAlerts', e.message, 'bad');
  }
});
$('backToFiles').addEventListener('click', () => go(1));

// ===================================================================== review
function buildLayout() {
  const geo = R.geo;
  let design = chartStitches();
  const box = sharedBox(geo);
  // turn once, automatically, so the design matches the canvas shape
  if (R.autoTurn == null) {
    R.autoTurn = 0;
    if (J.orient === 'match') {
      const cw = box.c1 - box.c0 + 1, ch = box.r1 - box.r0 + 1;
      if ((cw > ch * 1.1 && design.height > design.width * 1.1) || (ch > cw * 1.1 && design.width > design.height * 1.1)) R.autoTurn = 1;
    }
  }
  design = rotateDesign(design, R.autoTurn + (J.manualTurn || 0) + 4);
  // centred on the intersections both pictures share
  const col = Math.floor((box.c0 + box.c1 + 1 - design.width) / 2) + (J.nudge?.[0] || 0);
  const row = Math.floor((box.r0 + box.r1 + 1 - design.height) / 2) + (J.nudge?.[1] || 0);
  const dRect = { col, row, w: design.width, h: design.height };
  const layers = [{ img: design, col, row, part: 1 }];
  const missing = {};
  const notes = [];
  const { colors, total } = designColors(design);
  if (J.placements.key) {
    const key = buildKey(colors, J.placements.key.dir);
    const at = placeInCorner(box, dRect, J.placements.key.corner, key.width, key.height);
    if (at) layers.push({ img: key, col: at.col, row: at.row, part: 2 });
    else { missing.key = true; notes.push(['key', `The color key has no room in that corner, so the print file leaves it off. It needs ${key.width} × ${key.height} stitches (${(key.width / J.mesh).toFixed(1)} × ${(key.height / J.mesh).toFixed(1)} in) of spare canvas past the design and the tape. Move it to a corner with room, or remove it in the placement drawing.`]); }
    if (total > colors.length) notes.push(['info', `The key shows the ${colors.length} most-used of ${total} colors.`]);
  }
  if (J.placements.logo && J.logo && R.logoBmp) {
    const logo = buildLogo(R.logoBmp, J.logoWidth);
    const at = placeInCorner(box, dRect, J.placements.logo.corner, logo.width, logo.height);
    if (at) layers.push({ img: logo, col: at.col, row: at.row, part: 3 });
    else { missing.logo = true; notes.push(['logo', `Your logo has no room in that corner, so the print file leaves it off. It needs ${logo.width} × ${logo.height} stitches (${(logo.width / J.mesh).toFixed(1)} × ${(logo.height / J.mesh).toFixed(1)} in) of spare canvas. Move it to a corner with room, or remove it in the placement drawing.`]); }
  }
  const grid = composite(geo.cols, geo.rows, layers);
  let off = 0;
  for (let y = 0; y < design.height; y++) for (let x = 0; x < design.width; x++) {
    if (design.data[(y * design.width + x) * 4 + 3] < 128) continue;
    const c = col + x, r = row + y;
    if (c < 0 || r < 0 || c >= geo.cols || r >= geo.rows || !geo.shared[r * geo.cols + c]) off++;
  }
  return { grid, design, dRect, box, notes, off, missing };
}
function sharedBox(geo) {
  const ix = new Float64Array(geo.cols * geo.rows);
  for (let i = 0; i < ix.length; i++) ix[i] = geo.shared[i] ? 0 : NaN;
  const b = sharedBoxOf({ ix, cols: geo.cols, rows: geo.rows });
  return { c0: b.c0 + 1, c1: b.c1 - 1, r0: b.r0 + 1, r1: b.r1 - 1 };
}

let reviewPicker = null;
async function enterReview() {
  if (J.logo && !R.logoBmp) R.logoBmp = await createImageBitmap(await (await fetch(J.logo)).blob());
  if (!reviewPicker) {
    reviewPicker = cornerPicker($('reviewPicker'), {
      get: () => {
        const p = structuredClone(J.placements), m = R.layout?.missing || {};
        if (p.key && m.key) p.key.missing = true;
        if (p.logo && m.logo) p.logo.missing = true;
        return p;
      },
      logoUrl: () => J.logo,
      set: (pl) => { for (const k of ['key', 'logo']) if (pl[k]) delete pl[k].missing; J.placements = pl; customized(); refreshReview(); },
      hasLogo: () => !!J.logo,
      aspect: () => { const b = sharedBox(R.geo); return (b.c1 - b.c0 + 1) / (b.r1 - b.r0 + 1); },
      designBox: () => {
        const b = sharedBox(R.geo), L = R.layout;
        if (!L) return null;
        const W = b.c1 - b.c0 + 1, H = b.r1 - b.r0 + 1;
        return { x: (L.dRect.col - b.c0) / W, y: (L.dRect.row - b.r0) / H, w: L.dRect.w / W, h: L.dRect.h / H };
      },
      roomFor: (corner, what, dir) => {
        const L = R.layout; if (!L) return true;
        if (what === 'logo' && !R.logoBmp) return false;
        const img = what === 'key' ? buildKey(designColors(L.design).colors, dir) : buildLogo(R.logoBmp, J.logoWidth);
        return !!placeInCorner(L.box, L.dRect, corner, img.width, img.height);
      },
    });
  }
  $('nudgeX').value = J.nudge?.[0] || 0; $('nudgeY').value = J.nudge?.[1] || 0;
  setPic(R.pic || 'shot', true);
  refreshReview(true);
}

function refreshReview(fit = false) {
  R.layout = buildLayout();
  reviewPicker.render();
  document.querySelectorAll('[data-turn]').forEach((b) => b.setAttribute('aria-pressed', String(J.manualTurn !== 0 && +b.dataset.turn === J.manualTurn)));
  R.shapes = stitchShapes(R.geo, R.layout.grid, J.outline);
  R.frame = guideFrame(R.geo);
  const scale = Math.min(4, Math.max(1, 30 / R.shot.pitch));
  R.preview = drawPreview(R.preview || document.createElement('canvas'), R.shot, R.shapes, R.frame, scale);
  R.scanPreview = null;
  renderChecks();
  updateViewer(fit);
}

function renderChecks() {
  const rows = [];
  const s = R.scan, t = R.shot, m = R.match, L = R.layout;
  rows.push([Math.abs(s.measuredMesh - J.mesh) / J.mesh > 0.06 ? 'warn' : 'ok', `Canvas measures ${s.measuredMesh.toFixed(1)} mesh (you picked ${J.mesh}).`]);
  if (s.dot?.status === 'found' && t.dot?.status === 'found') {
    rows.push(m.dotDisagrees ? ['warn', 'The dot and the canvas pattern disagree by one stitch. Zoom in on both ends and check before printing.'] : ['ok', 'Your dot was found in both pictures. Check the red ring sits on it in each.']);
  } else if (s.dot?.status === 'far' || t.dot?.status === 'far') {
    rows.push(['bad', 'Your dot is too far from the intersections to count from. Put a new dot on the tape where it lies over the canvas, within about ½ in of intersections, then scan again and take a new screenshot.']);
  } else if (s.dot?.status === 'multiple' || t.dot?.status === 'multiple') {
    rows.push(['bad', 'More than one dot was found. Use one dot only.']);
  } else {
    const missing = s.dot?.status === 'found' ? 'the xTool screenshot' : t.dot?.status === 'found' ? 'the scan' : 'either picture';
    rows.push(['bad', `No dot was found in ${missing}, and the dot is what lines the two pictures up. Use Set the dot yourself, or add one solid dot on the tape over the canvas and take the pictures again.`]);
  }
  if (m.usedDot) {
    rows.push(m.confidence > 0.3 ? ['ok', `Counting from your dot lines the two pictures up (${Math.round(m.overlap * 100)}% of the canvas in both).`] : m.overlap > 0.6 ? ['warn', 'The dot lines the pictures up, but less clearly than usual. Zoom in on both ends and check before printing.'] : ['bad', "Counting from the dot doesn't lay the canvas over itself. Make sure the scan and the screenshot are the same canvas."]);
    if (m.dotResidual > 0.35) rows.push(['warn', 'Your dot lands between two stitches when counted in the two pictures. Check both end zooms; a dot closer to visible intersections counts more surely.']);
  }
  if (m.label !== 'as scanned') rows.push(['ok', `The scan is ${m.label} compared with the camera view. That's handled.`]);
  rows.push(L.off ? ['bad', `${L.off.toLocaleString()} stitches fall off the intersections both pictures share. Use a bigger canvas, a smaller chart, or move the design.`] : ['ok', `All ${countStitches(L.design).toLocaleString()} stitches land on intersections.`]);
  if (t.pitch < 6) rows.push(['warn', 'The screenshot is small. Zoom in further in xTool Studio next time.']);
  $('checks').innerHTML = rows.map(([k, text]) => `<li class="chk ${k}">${esc(text)}</li>`).join('');
  $('fitAlerts').innerHTML = '';
  for (const [what, text] of L.notes) {
    const div = document.createElement('div');
    div.className = 'alert';
    div.textContent = text + ' ';
    if (what === 'key' || what === 'logo') {
      const b = document.createElement('button');
      const label = what === 'key' ? 'color key' : 'logo';
      b.type = 'button'; b.className = 'btn btn-outline btn-sm'; b.textContent = `Continue without the ${label}`;
      b.onclick = () => {
        const before = structuredClone(J.placements);
        J.placements[what] = null; customized(); refreshReview();
        toast(`The ${label} is left off this job.`, () => { J.placements = before; customized(); refreshReview(); });
      };
      const big = document.createElement('button');
      big.type = 'button'; big.className = 'btn btn-outline btn-sm'; big.textContent = 'Re-run with bigger canvas';
      big.onclick = () => { go(1); toast('Replace the scan and the xTool screenshot with a bigger blank. Your chart stays.'); };
      const row = document.createElement('div'); row.className = 'btn-row'; row.append(b, big);
      div.append(row);
    }
    $('fitAlerts').append(div);
  }
  $('toPrint').disabled = rows.some((r) => r[0] === 'bad') || !!(L.missing.key || L.missing.logo) || !$('rerunBanner').hidden;
}
// ---------------------------------------------------------------- hand-set dot
function applyManualDot(which) {
  const res = which === 'scan' ? R.scan : R.shot;
  const m = J.manualDots?.[which];
  if (!res || !m) return;
  const g = gridAt(res, m.x, m.y);
  if (g) res.dot = { status: 'found', x: m.x, y: m.y, c: g.c, r: g.r, diameterIn: 0.2, manual: true };
}
function gridAt(res, x, y) {
  const { ix, iy, cols } = res.intersections;
  const R2 = (res.pitch * 4) ** 2, pts = [];
  for (let k = 0; k < ix.length; k++) if (!Number.isNaN(ix[k]) && (ix[k] - x) ** 2 + (iy[k] - y) ** 2 < R2) pts.push(k);
  if (pts.length < 6) return null;
  let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bc = [0, 0, 0], br = [0, 0, 0];
  for (const k of pts) {
    const v = [1, ix[k], iy[k]], c = k % cols, r = (k - c) / cols;
    for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) S[i][j] += v[i] * v[j]; bc[i] += v[i] * c; br[i] += v[i] * r; }
  }
  const d3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const det = d3(S); if (Math.abs(det) < 1e-9) return null;
  const sol = (b) => [0, 1, 2].map((k) => d3(S.map((row, i) => row.map((val, j) => (j === k ? b[i] : val)))) / det);
  const a = sol(bc), b = sol(br);
  return { c: a[0] + a[1] * x + a[2] * y, r: b[0] + b[1] * x + b[2] * y };
}
let settingDot = false;
$('setDot').addEventListener('click', () => {
  settingDot = !settingDot;
  $('setDot').setAttribute('aria-pressed', String(settingDot));
  $('setDotNote').hidden = !settingDot;
  viewer.onPick = settingDot ? pickDot : null;
});
function pickDot(x, y) {
  const which = R.pic === 'scan' ? 'scan' : 'shot';
  (J.manualDots ||= {})[which] = { x, y };
  save();
  applyManualDot(which);
  updateViewer(false);
  $('rerunBanner').hidden = false;
  $('toPrint').disabled = true;
  toast(`Dot set on the ${which === 'scan' ? 'scan' : 'xTool camera picture'}.`);
}
$('rerunNow').addEventListener('click', () => {
  const dots = R.scan.dot?.status === 'found' && R.shot.dot?.status === 'found' ? { a: R.scan.dot, b: R.shot.dot } : null;
  R.match = matchGrids(R.scan.holes, R.shot.holes, { dots });
  R.geo = buildGeometry(R.scan, R.shot, R.match);
  $('rerunBanner').hidden = true;
  settingDot = false; $('setDot').setAttribute('aria-pressed', 'false'); $('setDotNote').hidden = true; viewer.onPick = null;
  refreshReview(true);
  toast('Re-run done.');
});

function countStitches(d) { let n = 0; for (let i = 0; i < d.data.length; i += 4) if (d.data[i + 3] >= 128 && !(d.data[i] >= 245 && d.data[i + 1] >= 245 && d.data[i + 2] >= 245)) n++; return n; }

document.querySelectorAll('[data-turn]').forEach((b) => b.addEventListener('click', () => {
  const v = +b.dataset.turn;
  J.manualTurn = J.manualTurn === v ? 0 : v; // the same button again undoes it
  customized(); refreshReview();
}));
for (const [id, k] of [['nudgeX', 0], ['nudgeY', 1]]) {
  $(id).addEventListener('change', () => { J.nudge = J.nudge || [0, 0]; J.nudge[k] = Math.round(+$(id).value || 0); save(); refreshReview(); });
}
$('recenter').addEventListener('click', () => { J.nudge = [0, 0]; $('nudgeX').value = 0; $('nudgeY').value = 0; save(); refreshReview(); });
$('opacity').addEventListener('input', () => { viewer.designOpacity = $('opacity').value / 100; viewer.draw(); });
$('showPts').addEventListener('click', () => { const on = $('showPts').getAttribute('aria-checked') !== 'true'; setSwitch($('showPts'), on); viewer.showPoints = on; viewer.draw(); });
$('backToAlign').addEventListener('click', () => go(1));
$('toPrint').addEventListener('click', () => go(4));

// picture tabs: xTool camera / scan
document.querySelectorAll('[data-pic]').forEach((b) => b.addEventListener('click', () => setPic(b.dataset.pic)));
function setPic(pic, keep = false) {
  R.pic = pic;
  document.querySelectorAll('[data-pic]').forEach((o) => o.setAttribute('aria-checked', String(o.dataset.pic === pic)));
  if (!keep) updateViewer(true);
}
// scan intersection -> camera intersection (top-left of its mapped holes)
function scanToShot(c, r) {
  const p = R.match.map(c, r), q = R.match.map(c + 1, r + 1);
  return [Math.min(p[0], q[0]), Math.min(p[1], q[1])];
}
function scanPreview() {
  if (R.scanPreview) return R.scanPreview;
  const A = R.scan.intersections, geo = R.geo, grid = R.layout.grid;
  const out = { width: A.cols, height: A.rows, data: new Uint8ClampedArray(A.cols * A.rows * 4) };
  for (let r = 0; r < A.rows; r++) for (let c = 0; c < A.cols; c++) {
    const [bc, br] = scanToShot(c, r);
    if (bc < 0 || br < 0 || bc >= geo.cols || br >= geo.rows) continue;
    const s = (br * geo.cols + bc) * 4, o = (r * A.cols + c) * 4;
    for (let k = 0; k < 4; k++) out.data[o + k] = grid.data[s + k];
  }
  R.scanPreview = renderPrint({ result: R.scan, design: out, offset: { col: 0, row: 0 }, margin: 1, background: 'transparent', outlineLight: J.outline }).canvas;
  return R.scanPreview;
}
function updateViewer(fit) {
  const shot = R.pic !== 'scan';
  const res = shot ? R.shot : R.scan;
  const base = shot ? R.shotBmp : R.scanBmp;
  viewer.setScan(base, !fit && viewer.scan === base);
  viewer.print = J.step === 2 ? null : shot ? R.preview : scanPreview();
  viewer.showDesign = true;
  viewer.designOpacity = J.step === 4 ? 1 : $('opacity').value / 100;
  const I = res.intersections;
  viewer.points = { ix: I.ix, iy: I.iy, pitch: res.pitch };
  viewer.showPoints = $('showPts').getAttribute('aria-checked') === 'true';
  const d = res.dot;
  viewer.rings = d && d.status === 'found' ? [{ x: d.x, y: d.y, r: (d.diameterIn * res.pitch * res.measuredMesh) / 2 + res.pitch * 0.6 }] : [];
  viewer.draw();
}

// end zooms: first and last design column, middle row
function zoomEnd(which) {
  const L = R.layout; if (!L) return;
  const c = which === 'left' ? L.dRect.col : L.dRect.col + L.dRect.w - 1;
  const r = L.dRect.row + Math.floor(L.dRect.h / 2);
  let x = NaN, y = NaN, res;
  if (R.pic === 'scan') {
    res = R.scan;
    const A = R.scan.intersections;
    outer: for (let rr = 0; rr < A.rows; rr++) for (let cc = 0; cc < A.cols; cc++) {
      const [bc, br] = scanToShot(cc, rr);
      if (bc === c && br === r) { const k = rr * A.cols + cc; x = A.ix[k]; y = A.iy[k]; break outer; }
    }
  } else {
    res = R.shot;
    const k = r * res.intersections.cols + c; x = res.intersections.ix[k]; y = res.intersections.iy[k];
  }
  if (!Number.isNaN(x)) viewer.zoomTo(x, y, res.pitch, 56);
}
$('zoomLeft').addEventListener('click', () => zoomEnd('left'));
$('zoomRight').addEventListener('click', () => zoomEnd('right'));
$('zoomDot').addEventListener('click', () => {
  const res = R.pic === 'scan' ? R.scan : R.shot;
  if (res?.dot?.status === 'found') viewer.zoomTo(res.dot.x, res.dot.y, res.pitch, 24);
  else toast('No dot was found in this picture.');
});
$('zoomIn').addEventListener('click', () => viewer.zoomBy(1.5));
$('zoomOut').addEventListener('click', () => viewer.zoomBy(1 / 1.5));
$('zoomFit').addEventListener('click', () => viewer.fit());

// ===================================================================== print
function enterPrint() {
  if (!R.layout) R.layout = buildLayout();
  R.shapes = R.shapes || stitchShapes(R.geo, R.layout.grid, J.outline);
  R.frame = R.frame || guideFrame(R.geo);
  const built = buildSvg(R.shot, R.geo, R.shapes, R.frame, R.scan.measuredMesh);
  R.svg = built;
  $('printFacts').innerHTML = [
    ['Size', `${built.mmW.toFixed(1)} × ${built.mmH.toFixed(1)} mm`],
    ['Stitches', R.shapes.length.toLocaleString()],
    ['Color layers', built.colors],
    ['Canvas', `${R.scan.measuredMesh.toFixed(1)} mesh`],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  setPic('shot', true);
  updateViewer(true);
  document.querySelectorAll('[data-outcome]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.outcome === J.status)));
}
$('downloadSvg').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([R.svg.svg], { type: 'image/svg+xml' }));
  a.download = `${(J.name || 'print').replace(/[^\w-]+/g, '-')}-print.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  if (J.status === 'draft') { J.status = 'ready'; save(); }
  toast('Print file downloaded');
});
document.querySelectorAll('[data-outcome]').forEach((b) => b.addEventListener('click', () => {
  J.status = b.dataset.outcome; J.printedAt = Date.now(); save();
  document.querySelectorAll('[data-outcome]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
  const off = J.status === 'off';
  $('apTitle').textContent = off ? 'Sorry it was off' : 'Lined up. Nice work.';
  $('apText').innerHTML = off
    ? 'Check <a href="#/guide">When a print comes out off</a> in the setup guide. If the canvas or camera moved, take a new xTool screenshot and run this job again: your scan and chart stay.'
    : 'Saved to your print counts.';
  $('apAgain').hidden = !off;
  $('afterPrint').showModal();
}));
$('backToReview').addEventListener('click', () => go(3));
$('apAgain').addEventListener('click', () => { $('afterPrint').close(); J.status = 'draft'; save(); go(1); toast('Drop in a new xTool screenshot, then start alignment again.'); });
for (const id of ['apNew', 'apHome']) $(id).addEventListener('click', () => $('afterPrint').close());

// ===================================================================== misc
function setSwitch(btn, on) { btn.setAttribute('aria-checked', String(!!on)); }
function busy(msg) { $('busy').hidden = !msg; if (msg) $('busyMsg').textContent = msg; }
function alertBox(id, msg, kind = '') {
  const div = document.createElement('div');
  div.className = `alert ${kind === 'bad' ? 'error' : ''}`;
  div.textContent = msg;
  $(id).append(div);
}
let toastTimer = 0;
function toast(msg, undo) {
  const t = $('toast');
  t.innerHTML = '';
  t.append(document.createTextNode(msg));
  if (undo) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-undo'; b.textContent = 'Undo';
    b.onclick = () => { undo(); t.hidden = true; };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), undo ? 8000 : 4000);
}

refreshAvatar();
route();
