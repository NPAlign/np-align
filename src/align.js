// Canvas analysis engine.
//
// A needlepoint canvas scanned on a dark backing shows its holes as dark,
// roughly square blobs between light threads. This module:
//   1. finds those holes (adaptive threshold + connected components),
//   2. links them into a lattice by walking hole-to-hole, re-measuring the
//      local spacing and direction at every step so canvas warp is followed,
//   3. places every intersection (thread crossing, the "+") at the centre of
//      its four surrounding holes,
//   4. builds a full-resolution mask of hole pixels so printing can skip them.
//
// Pure JS with no DOM use, so it runs in a Web Worker and in Node tests.

const WORK_PITCH = 24; // analyse at a scale where holes are ~24 px apart

/**
 * @param {Uint8Array} gray  luminance, row-major, width*height
 * @param {number} width
 * @param {number} height
 * @param {{dpi:number, mesh:number, polarity?:'auto'|'dark'|'light', onProgress?:(msg:string)=>void}} opts
 */
export function analyzeCanvas(gray, width, height, opts) {
  const { dpi, mesh, polarity = 'auto', onProgress = () => {} } = opts;
  const warnings = [];
  const expectedPitch = dpi / mesh; // full-res pixels between holes

  // ---- 1. working image -------------------------------------------------
  const scale = Math.min(1, WORK_PITCH / expectedPitch);
  const ww = Math.max(8, Math.round(width * scale));
  const wh = Math.max(8, Math.round(height * scale));
  const sx = ww / width;
  const sy = wh / height;
  onProgress('Preparing scan');
  const xmap = new Int32Array(width);
  for (let x = 0; x < width; x++) xmap[x] = Math.min(ww - 1, Math.floor(x * sx));
  const ymap = new Int32Array(height);
  for (let y = 0; y < height; y++) ymap[y] = Math.min(wh - 1, Math.floor(y * sy));
  const small = downsample(gray, width, height, ww, wh, xmap, ymap);

  const pGuess = expectedPitch * scale;
  const mean = boxBlur(small, ww, wh, Math.max(2, Math.round(pGuess * 1.5)));

  // ---- 2. holes -------------------------------------------------------
  onProgress('Finding holes');
  const tries = polarity === 'auto' ? ['dark', 'light'] : [polarity];
  let best = null;
  for (const pol of tries) {
    const r = findHoles(small, mean, ww, wh, pol, pGuess);
    if (!best || r.score > best.score) best = r;
  }
  if (!best || best.points.length < 16) {
    throw new Error(
      'Could not find the canvas holes. Scan with a black sheet behind the canvas, and check the mesh and DPI settings.'
    );
  }
  const { points, pitch: workPitch, pol, labels, accepted } = best;

  const measuredPitch = workPitch / scale;
  let measuredPitchFine = measuredPitch; // refined below from the whole grid
  const measuredMesh = dpi / measuredPitch;
  if (Math.abs(measuredMesh - mesh) / mesh > 0.08) {
    warnings.push(
      `The holes are ${measuredMesh.toFixed(1)} per inch, but you chose ${mesh} mesh. ` +
        `Check the mesh and the scan DPI (${dpi}). The grid below uses the measured spacing.`
    );
  }

  // ---- 3. lattice -------------------------------------------------------
  onProgress('Linking holes into a grid');
  const angle = dominantAngle(points, workPitch);
  const lattice = growLattice(points, workPitch, angle, ww, wh);
  if (lattice.assigned < 16) {
    throw new Error('Found holes but could not link them into a grid. Try a cleaner, flatter scan.');
  }
  const unassigned = points.length - lattice.assigned;
  if (unassigned > points.length * 0.1) {
    warnings.push(
      `${unassigned} holes could not be joined to the main grid (often tape, the selvage, or a fold).`
    );
  }

  // hole grid in full-res coords
  const { hc, hr } = lattice;
  const hx = new Float64Array(hc * hr);
  const hy = new Float64Array(hc * hr);
  for (let k = 0; k < hc * hr; k++) {
    const p = lattice.cellPoint[k];
    if (p < 0) {
      hx[k] = NaN;
      hy[k] = NaN;
    } else {
      hx[k] = (points[p].x + 0.5) / sx - 0.5;
      hy[k] = (points[p].y + 0.5) / sy - 0.5;
    }
  }
  // ---- 4. full-resolution hole mask -------------------------------------
  onProgress('Mapping hole edges');
  const acceptedSmall = new Uint8Array(ww * wh);
  for (let i = 0; i < ww * wh; i++) if (labels[i] && accepted[labels[i]]) acceptedSmall[i] = 1;
  const near = dilate(acceptedSmall, ww, wh, 1);
  const holeMask = new Uint8Array(width * height);
  const delta = THRESH_DELTA;
  for (let y = 0; y < height; y++) {
    const srow = ymap[y] * ww;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const si = srow + xmap[x];
      if (!near[si]) continue;
      const g = gray[row + x];
      const m = mean[si];
      if (pol === 'dark' ? g < m - delta : g > m + delta) holeMask[row + x] = 1;
    }
  }

  // Refine every hole centre on the full-resolution mask (the working image
  // is shrunk, so its centroids are only accurate to a pixel or two there).
  onProgress('Refining hole centres');
  const R = measuredPitch * 0.45;
  // hole size as a fraction of one grid cell: used as a fingerprint when
  // matching this canvas to another picture of it (NaN = not measured)
  const holeArea = new Float32Array(hc * hr).fill(NaN);
  const cellArea = measuredPitch * measuredPitch;
  for (let k = 0; k < hc * hr; k++) {
    if (Number.isNaN(hx[k])) continue;
    const x0 = Math.max(0, Math.floor(hx[k] - R)), x1 = Math.min(width - 1, Math.ceil(hx[k] + R));
    const y0 = Math.max(0, Math.floor(hy[k] - R)), y1 = Math.min(height - 1, Math.ceil(hy[k] + R));
    let n = 0, sx2 = 0, sy2 = 0;
    for (let y = y0; y <= y1; y++) {
      const row = y * width;
      for (let x = x0; x <= x1; x++) if (holeMask[row + x]) { n++; sx2 += x; sy2 += y; }
    }
    if (n > 4) { hx[k] = sx2 / n; hy[k] = sy2 / n; holeArea[k] = n / cellArea; }
  }

  // precise spacing: mean step between neighbouring measured holes
  {
    let sum = 0, n = 0;
    for (let r = 0; r < hr; r++) for (let c = 0; c < hc; c++) {
      const k = r * hc + c;
      if (Number.isNaN(hx[k])) continue;
      if (c + 1 < hc && !Number.isNaN(hx[k + 1])) { sum += Math.hypot(hx[k + 1] - hx[k], hy[k + 1] - hy[k]); n++; }
      if (r + 1 < hr && !Number.isNaN(hx[k + hc])) { sum += Math.hypot(hx[k + hc] - hx[k], hy[k + hc] - hy[k]); n++; }
    }
    if (n > 50) { measuredPitchFine = sum / n; }
  }
  const filled = fillGaps(hx, hy, hc, hr);

  // intersections: centre of four holes
  const cols = hc - 1;
  const rows = hr - 1;
  const ix = new Float64Array(Math.max(0, cols * rows));
  const iy = new Float64Array(Math.max(0, cols * rows));
  let valid = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * hc + c, b = a + 1, d = a + hc, e = d + 1;
      const x = (hx[a] + hx[b] + hx[d] + hx[e]) / 4;
      const y = (hy[a] + hy[b] + hy[d] + hy[e]) / 4;
      ix[r * cols + c] = x;
      iy[r * cols + c] = y;
      if (!Number.isNaN(x)) valid++;
    }
  }

  return {
    width,
    height,
    dpi,
    mesh,
    polarity: pol,
    expectedPitch,
    pitch: measuredPitchFine,
    measuredMesh: dpi / measuredPitchFine,
    angle: (angle * 180) / Math.PI,
    holes: { hx, hy, area: holeArea, cols: hc, rows: hr },
    intersections: { ix, iy, cols, rows, valid },
    holeMask,
    stats: { holesFound: points.length, holesLinked: lattice.assigned, holesFilled: filled },
    warnings,
  };
}

const THRESH_DELTA = 3;

// ---------------------------------------------------------------------------

function downsample(gray, w, h, ww, wh, xmap, ymap) {
  const sum = new Float32Array(ww * wh);
  const cnt = new Float32Array(ww * wh);
  for (let y = 0; y < h; y++) {
    const srow = ymap[y] * ww;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = srow + xmap[x];
      sum[i] += gray[row + x];
      cnt[i] += 1;
    }
  }
  for (let i = 0; i < sum.length; i++) sum[i] = cnt[i] ? sum[i] / cnt[i] : 0;
  return sum;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0, n = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) { acc += src[row + x]; n++; }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n;
      const add = x + r + 1, rem = x - r;
      if (add < w) { acc += src[row + add]; n++; }
      if (rem >= 0) { acc -= src[row + rem]; n--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0, n = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) { acc += tmp[y * w + x]; n++; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      const add = y + r + 1, rem = y - r;
      if (add < h) { acc += tmp[add * w + x]; n++; }
      if (rem >= 0) { acc -= tmp[rem * w + x]; n--; }
    }
  }
  return out;
}

function findHoles(small, mean, w, h, pol, pGuess) {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    bin[i] = pol === 'dark' ? small[i] < mean[i] - THRESH_DELTA : small[i] > mean[i] + THRESH_DELTA;
  }
  const { labels, blobs } = label(bin, w, h);

  // stage 1: loose filter, measure the real spacing
  const loose = filterBlobs(blobs, pGuess, 0.03, 2.5, 2.0);
  let pitch = medianNN(loose, pGuess * 2.5);
  if (!pitch) return { score: 0, points: [] };

  // stage 2: tight filter with measured spacing
  const accepted = new Uint8Array(blobs.length);
  const points = [];
  for (const b of filterBlobs(blobs, pitch, 0.06, 0.85, 1.15)) {
    accepted[b.id] = 1;
    points.push(b);
  }
  pitch = medianNN(points, pitch * 2) || pitch;

  // score: how many holes sit at a consistent spacing from a neighbour
  const nn = nearestDistances(points, pitch * 2);
  let score = 0;
  for (const d of nn) if (d > pitch * 0.75 && d < pitch * 1.25) score++;
  return { score, points, pitch, pol, labels, accepted };
}

function label(bin, w, h) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const blobs = [null]; // label 0 = background
  let next = 1;
  for (let start = 0; start < w * h; start++) {
    if (!bin[start] || labels[start]) continue;
    const id = next++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    let area = 0, sumx = 0, sumy = 0;
    let minx = w, maxx = -1, miny = h, maxy = -1, edge = false;
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      area++; sumx += x; sumy += y;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      if (x > 0 && bin[i - 1] && !labels[i - 1]) { labels[i - 1] = id; stack[sp++] = i - 1; }
      if (x < w - 1 && bin[i + 1] && !labels[i + 1]) { labels[i + 1] = id; stack[sp++] = i + 1; }
      if (y > 0 && bin[i - w] && !labels[i - w]) { labels[i - w] = id; stack[sp++] = i - w; }
      if (y < h - 1 && bin[i + w] && !labels[i + w]) { labels[i + w] = id; stack[sp++] = i + w; }
    }
    blobs.push({ id, area, x: sumx / area, y: sumy / area, bw: maxx - minx + 1, bh: maxy - miny + 1, edge });
  }
  return { labels, blobs };
}

function filterBlobs(blobs, p, minA, maxA, maxSide) {
  const out = [];
  const p2 = p * p;
  for (let k = 1; k < blobs.length; k++) {
    const b = blobs[k];
    if (b.edge) continue;
    if (b.area < Math.max(4, minA * p2) || b.area > maxA * p2) continue;
    if (b.bw > maxSide * p || b.bh > maxSide * p) continue;
    if (b.bw < 0.2 * p || b.bh < 0.2 * p) continue;
    if (b.area / (b.bw * b.bh) < 0.35) continue;
    const asp = b.bw > b.bh ? b.bw / b.bh : b.bh / b.bw;
    if (asp > 2.5) continue;
    out.push(b);
  }
  return out;
}

class PointHash {
  constructor(points, cell) {
    this.points = points;
    this.cell = cell;
    let maxx = 0, maxy = 0;
    for (const p of points) { if (p.x > maxx) maxx = p.x; if (p.y > maxy) maxy = p.y; }
    this.cols = Math.floor(maxx / cell) + 1;
    this.rows = Math.floor(maxy / cell) + 1;
    this.head = new Int32Array(this.cols * this.rows).fill(-1);
    this.next = new Int32Array(points.length).fill(-1);
    points.forEach((p, i) => {
      const c = Math.floor(p.y / cell) * this.cols + Math.floor(p.x / cell);
      this.next[i] = this.head[c];
      this.head[c] = i;
    });
  }
  nearest(x, y, maxR, skip = -1) {
    const cell = this.cell;
    const reach = Math.ceil(maxR / cell);
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    let best = -1, bd = maxR * maxR;
    for (let gy = cy - reach; gy <= cy + reach; gy++) {
      if (gy < 0 || gy >= this.rows) continue;
      for (let gx = cx - reach; gx <= cx + reach; gx++) {
        if (gx < 0 || gx >= this.cols) continue;
        for (let i = this.head[gy * this.cols + gx]; i >= 0; i = this.next[i]) {
          if (i === skip) continue;
          const dx = this.points[i].x - x, dy = this.points[i].y - y;
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = i; }
        }
      }
    }
    return best;
  }
}

function nearestDistances(points, maxR) {
  if (points.length < 2) return [];
  const hash = new PointHash(points, Math.max(2, maxR / 2));
  const out = [];
  points.forEach((p, i) => {
    const j = hash.nearest(p.x, p.y, maxR, i);
    if (j >= 0) out.push(Math.hypot(points[j].x - p.x, points[j].y - p.y));
  });
  return out;
}

function medianNN(points, maxR) {
  const d = nearestDistances(points, maxR);
  if (d.length < 8) return 0;
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
}

function dominantAngle(points, pitch) {
  const hash = new PointHash(points, pitch);
  let C = 0, S = 0;
  points.forEach((p, i) => {
    const j = hash.nearest(p.x, p.y, pitch * 1.4, i);
    if (j < 0) return;
    const a = Math.atan2(points[j].y - p.y, points[j].x - p.x);
    C += Math.cos(4 * a);
    S += Math.sin(4 * a);
  });
  return Math.atan2(S, C) / 4; // in (-45°, 45°]
}

function growLattice(points, pitch, angle, w, h) {
  const n = points.length;
  const hash = new PointHash(points, pitch);
  const ux = new Float64Array(n), uy = new Float64Array(n), vx = new Float64Array(n), vy = new Float64Array(n);
  const gi = new Int32Array(n), gj = new Int32Array(n);
  const done = new Uint8Array(n);
  const cells = new Map();
  const key = (i, j) => (i + 50000) * 131072 + (j + 50000);
  const tol = pitch * 0.3;

  const U0 = [Math.cos(angle) * pitch, Math.sin(angle) * pitch];
  const V0 = [-Math.sin(angle) * pitch, Math.cos(angle) * pitch];

  // seed: hole nearest the middle that has all four neighbours where expected
  const order = points.map((p, i) => i);
  const cx = w / 2, cy = h / 2;
  order.sort((a, b) => Math.hypot(points[a].x - cx, points[a].y - cy) - Math.hypot(points[b].x - cx, points[b].y - cy));
  let seed = order[0];
  for (const i of order.slice(0, 400)) {
    const p = points[i];
    let ok = 0;
    for (const [dx, dy] of [U0, V0, [-U0[0], -U0[1]], [-V0[0], -V0[1]]]) {
      if (hash.nearest(p.x + dx, p.y + dy, tol, i) >= 0) ok++;
    }
    if (ok === 4) { seed = i; break; }
  }

  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  done[seed] = 1;
  [ux[seed], uy[seed]] = U0;
  [vx[seed], vy[seed]] = V0;
  cells.set(key(0, 0), seed);
  queue[qt++] = seed;
  let assigned = 1;

  while (qh < qt) {
    const p = queue[qh++];
    const P = points[p];
    for (let d = 0; d < 4; d++) {
      const alongU = d < 2;
      const sign = d % 2 === 0 ? 1 : -1;
      const ni = gi[p] + (alongU ? sign : 0);
      const nj = gj[p] + (alongU ? 0 : sign);
      const k = key(ni, nj);
      if (cells.has(k)) continue;
      const ex = alongU ? ux[p] : vx[p];
      const ey = alongU ? uy[p] : vy[p];
      const q = hash.nearest(P.x + sign * ex, P.y + sign * ey, tol);
      if (q < 0 || done[q]) continue;
      const Q = points[q];
      const mx = (Q.x - P.x) * sign, my = (Q.y - P.y) * sign;
      done[q] = 1;
      gi[q] = ni;
      gj[q] = nj;
      if (alongU) {
        ux[q] = 0.5 * ux[p] + 0.5 * mx; uy[q] = 0.5 * uy[p] + 0.5 * my;
        vx[q] = vx[p]; vy[q] = vy[p];
      } else {
        vx[q] = 0.5 * vx[p] + 0.5 * mx; vy[q] = 0.5 * vy[p] + 0.5 * my;
        ux[q] = ux[p]; uy[q] = uy[p];
      }
      cells.set(k, q);
      queue[qt++] = q;
      assigned++;
    }
  }

  let imin = Infinity, imax = -Infinity, jmin = Infinity, jmax = -Infinity;
  for (let q = 0; q < n; q++) {
    if (!done[q]) continue;
    if (gi[q] < imin) imin = gi[q]; if (gi[q] > imax) imax = gi[q];
    if (gj[q] < jmin) jmin = gj[q]; if (gj[q] > jmax) jmax = gj[q];
  }
  const hc = imax - imin + 1, hr = jmax - jmin + 1;
  const cellPoint = new Int32Array(hc * hr).fill(-1);
  for (let q = 0; q < n; q++) if (done[q]) cellPoint[(gj[q] - jmin) * hc + (gi[q] - imin)] = q;
  return { hc, hr, cellPoint, assigned };
}

// Fill single missing holes (dust, a thread across a hole) from their
// neighbours on both sides. Larger gaps stay empty and get no stitches.
function fillGaps(hx, hy, c, r) {
  let filled = 0;
  for (let pass = 0; pass < 3; pass++) {
    let changed = 0;
    for (let y = 0; y < r; y++) {
      for (let x = 0; x < c; x++) {
        const k = y * c + x;
        if (!Number.isNaN(hx[k])) continue;
        let sx = 0, sy = 0, n = 0;
        if (x > 0 && x < c - 1 && !Number.isNaN(hx[k - 1]) && !Number.isNaN(hx[k + 1])) {
          sx += hx[k - 1] + hx[k + 1]; sy += hy[k - 1] + hy[k + 1]; n += 2;
        }
        if (y > 0 && y < r - 1 && !Number.isNaN(hx[k - c]) && !Number.isNaN(hx[k + c])) {
          sx += hx[k - c] + hx[k + c]; sy += hy[k - c] + hy[k + c]; n += 2;
        }
        if (n) { hx[k] = sx / n; hy[k] = sy / n; changed++; }
      }
    }
    filled += changed;
    if (!changed) break;
  }
  return filled;
}

/** Square dilation of a binary mask by radius r (separable). */
export function dilate(mask, w, h, r) {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let last = -Infinity;
    for (let x = 0; x < w + r; x++) {
      if (x < w && mask[row + x]) last = x;
      const t = x - r;
      if (t >= 0 && t < w) {
        // any set pixel within [t-r, t+r]: last set index >= t-r
        if (last >= t - r) tmp[row + t] = 1;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h + r; y++) {
      if (y < h && tmp[y * w + x]) last = y;
      const t = y - r;
      if (t >= 0 && t < h && last >= t - r) out[t * w + x] = 1;
    }
  }
  return out;
}
