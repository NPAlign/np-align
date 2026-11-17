// Matches the hole grid found in the canvas scan to the hole grid found in
// the xTool camera screenshot of the same canvas, stitch for stitch.
//
// Every canvas has small, permanent irregularities: some threads are a
// little thicker or thinner than others, so the holes beside them are a
// little smaller or larger all the way along that thread. Averaging hole
// size along each column and each row gives two "fingerprint" profiles that
// both pictures share. Sliding one set of profiles over the other finds the
// column/row offset (and turn or mirror) at which they agree.

/** Inverse of a match: screenshot hole (x, y) -> scan hole (c, r). */
export function inverseMap(m, a) {
  const [transpose, flipX, flipY] = m.t;
  const W = transpose ? a.rows : a.cols, H = transpose ? a.cols : a.rows;
  return (x, y) => {
    x -= m.dx; y -= m.dy;
    if (flipX) x = W - 1 - x;
    if (flipY) y = H - 1 - y;
    return transpose ? [y, x] : [x, y];
  };
}

const TRANSFORMS = [
  // [transpose, flipX, flipY, label]
  [false, false, false, 'as scanned'],
  [false, true, false, 'mirrored left–right'],
  [false, false, true, 'mirrored top–bottom'],
  [false, true, true, 'turned 180°'],
  [true, false, false, 'turned and mirrored'],
  [true, true, false, 'turned a quarter turn'],
  [true, false, true, 'turned a quarter turn the other way'],
  [true, true, true, 'turned and mirrored the other way'],
];

/**
 * @param {{area:Float32Array, cols:number, rows:number}} a  scan holes
 * @param {{area:Float32Array, cols:number, rows:number}} b  screenshot holes
 * @param {{allowTurns?: boolean}} opts
 * @returns {{map:(c:number,r:number)=>[number,number], confidence:number, label:string, dx:number, dy:number, t:number[]}}
 */
export function matchGrids(a, b, { allowTurns = true, dots = null } = {}) {
  if (dots && dots.a && dots.b) return matchWithDot(a, b, dots, allowTurns);
  const aCol = profile(a, 'col'), aRow = profile(a, 'row');
  const bCol = profile(b, 'col'), bRow = profile(b, 'row');

  const candidates = [];
  const list = allowTurns ? TRANSFORMS : TRANSFORMS.slice(0, 1);
  for (const t of list) {
    const [transpose, flipX, flipY] = t;
    // after transforming the scan grid, its x-axis profile is:
    let px = transpose ? aRow : aCol;
    let py = transpose ? aCol : aRow;
    if (flipX) px = px.slice().reverse();
    if (flipY) py = py.slice().reverse();
    const mx = slide(px, bCol);
    const my = slide(py, bRow);
    if (!mx || !my) continue;
    candidates.push({ t, mx, my, score: mx.best + my.best });
  }
  if (!candidates.length) throw new Error('The scan and the screenshot have too little canvas in common to match.');
  candidates.sort((p, q) => q.score - p.score);
  const best = candidates[0];

  // 2-D check: compare individual hole sizes at the chosen offset and its
  // neighbours; the true offset should stand out clearly.
  const [transpose, flipX, flipY, label] = best.t;
  const W = transpose ? a.rows : a.cols, H = transpose ? a.cols : a.rows;
  const toT = (c, r) => {
    let x = transpose ? r : c, y = transpose ? c : r;
    if (flipX) x = W - 1 - x;
    if (flipY) y = H - 1 - y;
    return [x, y];
  };
  const aHP = highpass2d(a), bHP = highpass2d(b);
  const score2d = (dx, dy) => {
    let sxy = 0, sxx = 0, syy = 0, n = 0;
    for (let r = 0; r < a.rows; r++) {
      for (let c = 0; c < a.cols; c++) {
        const va = aHP[r * a.cols + c];
        if (Number.isNaN(va)) continue;
        const [x, y] = toT(c, r);
        const bx = x + dx, by = y + dy;
        if (bx < 0 || by < 0 || bx >= b.cols || by >= b.rows) continue;
        const vb = bHP[by * b.cols + bx];
        if (Number.isNaN(vb)) continue;
        sxy += va * vb; sxx += va * va; syy += vb * vb; n++;
      }
    }
    return n > 200 ? sxy / Math.sqrt(sxx * syy) : -1;
  };
  let bestDx = best.mx.offset, bestDy = best.my.offset, top = -Infinity;
  const scores = [];
  for (let ddy = -3; ddy <= 3; ddy++) {
    for (let ddx = -3; ddx <= 3; ddx++) {
      const s = score2d(best.mx.offset + ddx, best.my.offset + ddy);
      scores.push(s);
      if (s > top) { top = s; bestDx = best.mx.offset + ddx; bestDy = best.my.offset + ddy; }
    }
  }
  scores.sort((p, q) => q - p);
  const runnerUp = scores[1];
  // confidence: how clearly the winning offset beats its nearest rival
  const confidence = Math.max(0, Math.min(1, (top - runnerUp) / Math.max(0.05, top)));

  return {
    label,
    t: [transpose, flipX, flipY],
    dx: bestDx,
    dy: bestDy,
    correlation: top,
    confidence,
    map: (c, r) => {
      const [x, y] = toT(c, r);
      return [x + bestDx, y + bestDy];
    },
  };
}

// With the registration dot in both pictures. The dot is the anchor: for
// each way round the canvas could be, counting out from the intersections
// next to the dot in both pictures fixes the stitch offset. The right way
// round is the one that lays the rest of the canvas back over itself (the
// dot sits near a corner, so a wrong turn swings the canvas off itself).
// The hole pattern is only used as a cross-check when both pictures are
// sharp enough to show it; a camera preview usually is not.
function matchWithDot(a, b, dots, allowTurns) {
  const aHP = highpass2d(a), bHP = highpass2d(b);
  const ad = [dots.a.c + 0.5, dots.a.r + 0.5], bd = [dots.b.c + 0.5, dots.b.r + 0.5];
  const results = [];
  for (const t of allowTurns ? TRANSFORMS : TRANSFORMS.slice(0, 1)) {
    const [transpose, flipX, flipY, label] = t;
    const W = transpose ? a.rows : a.cols, H = transpose ? a.cols : a.rows;
    const toT = (c, r) => {
      let x = transpose ? r : c, y = transpose ? c : r;
      if (flipX) x = W - 1 - x;
      if (flipY) y = H - 1 - y;
      return [x, y];
    };
    const [tx, ty] = toT(ad[0], ad[1]);
    const dx = Math.round(bd[0] - tx), dy = Math.round(bd[1] - ty);
    const residual = Math.max(Math.abs(bd[0] - tx - dx), Math.abs(bd[1] - ty - dy));
    let inside = 0, total = 0;
    for (let r = 0; r < a.rows; r += 2) for (let c = 0; c < a.cols; c += 2) {
      if (Number.isNaN(a.area[r * a.cols + c])) continue;
      total++;
      const [x, y] = toT(c, r);
      if (x + dx >= 0 && y + dy >= 0 && x + dx < b.cols && y + dy < b.rows) inside++;
    }
    const overlap = total ? inside / total : 0;
    // a mirror image can't happen (both pictures show the front of the canvas),
    // so mirrored candidates only win if they fit clearly better
    const fit = overlap - (isMirror(transpose, flipX, flipY) ? 0.15 : 0);
    results.push({ t, label, toT, dx, dy, residual, overlap, fit });
  }
  results.sort((p, q) => q.fit - p.fit);
  const best = results[0], second = results[1];
  // pattern cross-check at the chosen offset and its neighbours
  const score = (ox, oy) => corr2d(a, b, aHP, bHP, best.toT, ox, oy);
  const s0 = score(best.dx, best.dy);
  let alt = -Infinity;
  for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) alt = Math.max(alt, score(best.dx + ox, best.dy + oy));
  const patternStrong = Math.max(s0, alt) > 0.4;
  const confidence = Math.max(0, Math.min(1, (best.fit - (second ? second.fit : 0)) / 0.3)) * (best.residual < 0.35 ? 1 : 0.5) * (best.overlap > 0.6 ? 1 : 0);
  return {
    label: best.label,
    t: best.t.slice(0, 3),
    dx: best.dx,
    dy: best.dy,
    correlation: s0,
    confidence,
    usedDot: true,
    overlap: best.overlap,
    dotResidual: best.residual,
    // the canvas pattern prefers a neighbouring stitch (only when it's clear)
    dotDisagrees: patternStrong && alt > s0 + 0.15,
    candidates: results.map((q) => ({ label: q.label, dx: q.dx, dy: q.dy, overlap: +q.overlap.toFixed(2), residual: +q.residual.toFixed(2) })),
    map: (c, r) => {
      const [x, y] = best.toT(c, r);
      return [x + best.dx, y + best.dy];
    },
  };
}

// a reflection (rather than a turn) when exactly one of the three steps reflects
function isMirror(transpose, flipX, flipY) {
  return ((transpose ? 1 : 0) + (flipX ? 1 : 0) + (flipY ? 1 : 0)) % 2 === 1;
}

function corr2d(a, b, aHP, bHP, toT, dx, dy) {
  let sxy = 0, sxx = 0, syy = 0, n = 0;
  for (let r = 0; r < a.rows; r++) {
    for (let c = 0; c < a.cols; c++) {
      const va = aHP[r * a.cols + c];
      if (Number.isNaN(va)) continue;
      const [x, y] = toT(c, r);
      const bx = x + dx, by = y + dy;
      if (bx < 0 || by < 0 || bx >= b.cols || by >= b.rows) continue;
      const vb = bHP[by * b.cols + bx];
      if (Number.isNaN(vb)) continue;
      sxy += va * vb; sxx += va * va; syy += vb * vb; n++;
    }
  }
  return n > 200 ? sxy / Math.sqrt(sxx * syy) : -1;
}

// Mean hole size along each column (or row), with slow trends (lighting,
// focus) removed so only thread-to-thread differences remain.
function profile(g, axis) {
  const n = axis === 'col' ? g.cols : g.rows;
  const m = axis === 'col' ? g.rows : g.cols;
  const raw = new Float64Array(n).fill(NaN);
  const vals = [];
  for (let i = 0; i < n; i++) {
    vals.length = 0;
    for (let j = 0; j < m; j++) {
      const k = axis === 'col' ? j * g.cols + i : i * g.cols + j;
      const v = g.area[k];
      if (!Number.isNaN(v)) vals.push(v);
    }
    if (vals.length >= Math.max(8, m * 0.25)) {
      vals.sort((p, q) => p - q);
      // trimmed mean: ignore the odd dusty or torn hole
      const lo = Math.floor(vals.length * 0.15), hi = Math.ceil(vals.length * 0.85);
      let s = 0;
      for (let q = lo; q < hi; q++) s += vals[q];
      raw[i] = s / (hi - lo);
    }
  }
  return highpass1d(raw, 7);
}

function highpass1d(p, half) {
  const out = new Float64Array(p.length).fill(NaN);
  for (let i = 0; i < p.length; i++) {
    if (Number.isNaN(p[i])) continue;
    let s = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(p.length - 1, i + half); j++) {
      if (!Number.isNaN(p[j])) { s += p[j]; n++; }
    }
    out[i] = p[i] - s / n;
  }
  return out;
}

function highpass2d(g) {
  const { cols, rows, area } = g;
  const out = new Float64Array(cols * rows).fill(NaN);
  const h = 3;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = area[r * cols + c];
      if (Number.isNaN(v)) continue;
      let s = 0, n = 0;
      for (let y = Math.max(0, r - h); y <= Math.min(rows - 1, r + h); y++) {
        for (let x = Math.max(0, c - h); x <= Math.min(cols - 1, c + h); x++) {
          const w = area[y * cols + x];
          if (!Number.isNaN(w)) { s += w; n++; }
        }
      }
      out[r * cols + c] = v - s / n;
    }
  }
  return out;
}

// Normalised cross-correlation of profile `a` slid across profile `b`.
// offset = index in b where a[0] lands.
function slide(a, b) {
  const minOverlap = Math.max(20, Math.floor(Math.min(a.length, b.length) * 0.5));
  let best = -Infinity, offset = 0;
  for (let off = -(a.length - minOverlap); off <= b.length - minOverlap; off++) {
    let sxy = 0, sxx = 0, syy = 0, n = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i + off;
      if (j < 0 || j >= b.length) continue;
      const x = a[i], y = b[j];
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      sxy += x * y; sxx += x * x; syy += y * y; n++;
    }
    if (n < minOverlap * 0.8 || !sxx || !syy) continue;
    const s = sxy / Math.sqrt(sxx * syy);
    if (s > best) { best = s; offset = off; }
  }
  return best === -Infinity ? null : { best, offset };
}
