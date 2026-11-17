// Print file for xTool Studio: a vector SVG in real millimetres, laid out on
// the xTool screenshot's frame (the camera's view from above, which is how
// the canvas will print). Every stitch is a "+" running along the threads
// around its intersection with the four holes left empty. One layer per
// colour; a magenta guide frame follows the outer intersections.

import { inverseMap } from './match.js';

const LIGHT = 232; // luminance above which a colour counts as very light

/**
 * Geometry shared by preview and export: for every screenshot hole that is
 * also in the scan, its refined position (screenshot px) and size.
 * Positions come from the scan's precise hole centres carried into the
 * camera picture by a local fit over nearby holes, which smooths out camera
 * noise and seams in xTool's stitched preview.
 */
export function buildGeometry(scan, shot, match) {
  const A = scan.holes, B = shot.holes;
  const inv = inverseMap(match, A);
  const n = B.cols * B.rows;
  const px = new Float64Array(n).fill(NaN), py = new Float64Array(n).fill(NaN), size = new Float32Array(n).fill(NaN);
  const src = new Int32Array(n).fill(-1); // scan hole index for each screenshot hole
  for (let br = 0; br < B.rows; br++) {
    for (let bc = 0; bc < B.cols; bc++) {
      const [c, r] = inv(bc, br);
      if (c < 0 || r < 0 || c >= A.cols || r >= A.rows) continue;
      const ai = r * A.cols + c, bi = br * B.cols + bc;
      if (Number.isNaN(A.hx[ai]) || Number.isNaN(B.hx[bi])) continue;
      src[bi] = ai;
    }
  }
  const R = 3; // neighbourhood: 7 x 7 holes
  for (let br = 0; br < B.rows; br++) {
    for (let bc = 0; bc < B.cols; bc++) {
      const bi = br * B.cols + bc;
      if (src[bi] < 0) continue;
      const P = [], Q = [];
      for (let y = Math.max(0, br - R); y <= Math.min(B.rows - 1, br + R); y++) {
        for (let x = Math.max(0, bc - R); x <= Math.min(B.cols - 1, bc + R); x++) {
          const k = y * B.cols + x;
          if (src[k] < 0) continue;
          P.push([A.hx[src[k]], A.hy[src[k]]]);
          Q.push([B.hx[k], B.hy[k]]);
        }
      }
      const ai = src[bi];
      if (P.length >= 6) {
        const m = fitAffine(P, Q);
        if (m) {
          px[bi] = m[0] * A.hx[ai] + m[2] * A.hy[ai] + m[4];
          py[bi] = m[1] * A.hx[ai] + m[3] * A.hy[ai] + m[5];
        }
      }
      if (Number.isNaN(px[bi])) { px[bi] = B.hx[bi]; py[bi] = B.hy[bi]; }
      const area = A.area[ai];
      size[bi] = Number.isNaN(area) ? 0.3 : area;
    }
  }
  // A hole missed inside the canvas (a photo seam, a fleck of dust) is a
  // detection miss, not missing canvas: fill short runs of them, along rows
  // then columns, from the holes on either side.
  const fillRuns = (along) => {
    const n1 = along === 'row' ? B.rows : B.cols, n2 = along === 'row' ? B.cols : B.rows;
    const idx = (i, j) => (along === 'row' ? i * B.cols + j : j * B.cols + i);
    for (let i = 0; i < n1; i++) {
      let j = 0;
      while (j < n2) {
        if (!Number.isNaN(px[idx(i, j)])) { j++; continue; }
        const start = j;
        while (j < n2 && Number.isNaN(px[idx(i, j)])) j++;
        const a = start - 1, b = j; // valid neighbours either side
        if (a < 0 || b >= n2 || b - a - 1 > 6) continue;
        const ka = idx(i, a), kb = idx(i, b);
        for (let q = start; q < b; q++) {
          const t = (q - a) / (b - a), k = idx(i, q);
          px[k] = px[ka] + (px[kb] - px[ka]) * t;
          py[k] = py[ka] + (py[kb] - py[ka]) * t;
          size[k] = (size[ka] + size[kb]) / 2;
        }
      }
    }
  };
  fillRuns('row');
  fillRuns('col');

  // intersections present in both pictures (or filled in between them)
  const cols = B.cols - 1, rows = B.rows - 1;
  const shared = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * B.cols + c;
      shared[r * cols + c] = !Number.isNaN(px[a]) && !Number.isNaN(px[a + 1]) && !Number.isNaN(px[a + B.cols]) && !Number.isNaN(px[a + B.cols + 1]) ? 1 : 0;
    }
  }
  // Scale: the same physical hole-to-hole steps measured in both pictures,
  // summed over every matched neighbouring pair. The scan's dpi is trusted,
  // so this gives the screenshot's millimetres per pixel precisely.
  let sumScan = 0, sumShot = 0;
  for (let br = 0; br < B.rows; br++) {
    for (let bc = 0; bc < B.cols; bc++) {
      const bi = br * B.cols + bc;
      if (src[bi] < 0) continue;
      for (const nb of [bc + 1 < B.cols ? bi + 1 : -1, br + 1 < B.rows ? bi + B.cols : -1]) {
        if (nb < 0 || src[nb] < 0) continue;
        sumShot += Math.hypot(B.hx[nb] - B.hx[bi], B.hy[nb] - B.hy[bi]);
        sumScan += Math.hypot(A.hx[src[nb]] - A.hx[src[bi]], A.hy[src[nb]] - A.hy[src[bi]]);
      }
    }
  }
  const mmPerPx = sumShot ? (sumScan / scan.dpi) * 25.4 / sumShot : 25.4 / scan.measuredMesh / shot.pitch;
  return { px, py, size, cols, rows, hcols: B.cols, shared, mmPerPx };
}

/** Each stitch as a "+" polygon in screenshot pixels. */
export function stitchShapes(geo, grid, outline, clearance = 0.04) {
  const shapes = [];
  const { px, py, size, hcols } = geo;
  for (let r = 0; r < grid.height; r++) {
    for (let c = 0; c < grid.width; c++) {
      const i = (r * grid.width + c) * 4;
      if (grid.data[i + 3] < 128 || !geo.shared[r * geo.cols + c]) continue;
      if (isBareCanvas(grid.data[i], grid.data[i + 1], grid.data[i + 2])) continue;
      const k = [r * hcols + c, r * hcols + c + 1, (r + 1) * hcols + c + 1, (r + 1) * hcols + c];
      const Q = k.map((h) => [px[h], py[h]]);
      const S = k.map((h) => Math.min(0.42, 0.5 * Math.sqrt(size[h]) + clearance));
      const pts = plus(S).map(([u, v]) => bilerp(Q, u, v));
      const hex = '#' + [grid.data[i], grid.data[i + 1], grid.data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      shapes.push({ hex, pts, light: outline && luminance(hex) > LIGHT, part: grid.part ? grid.part[r * grid.width + c] || 1 : 1 });
    }
  }
  return shapes;
}

/** Outline (screenshot px) through the outermost shared intersections. */
export function guideFrame(geo) {
  const { cols, rows, shared, px, py, hcols } = geo;
  let c0 = 0, c1 = cols - 1, r0 = 0, r1 = rows - 1;
  const okCol = (c) => { let n = 0; for (let r = r0; r <= r1; r++) n += shared[r * cols + c]; return n > (r1 - r0 + 1) * 0.9; };
  const okRow = (r) => { let n = 0; for (let c = c0; c <= c1; c++) n += shared[r * cols + c]; return n > (c1 - c0 + 1) * 0.9; };
  for (let g = 0; g < 500; g++) {
    let moved = false;
    if (c0 < c1 && !okCol(c0)) { c0++; moved = true; }
    if (c1 > c0 && !okCol(c1)) { c1--; moved = true; }
    if (r0 < r1 && !okRow(r0)) { r0++; moved = true; }
    if (r1 > r0 && !okRow(r1)) { r1--; moved = true; }
    if (!moved) break;
  }
  // intersection position = centre of its four holes
  const at = (c, r) => {
    const a = r * hcols + c, b = a + 1, d = a + hcols, e = d + 1;
    const x = (px[a] + px[b] + px[d] + px[e]) / 4, y = (py[a] + py[b] + py[d] + py[e]) / 4;
    return Number.isNaN(x) ? null : [x, y];
  };
  const out = [];
  for (let c = c0; c <= c1; c++) out.push(at(c, r0));
  for (let r = r0; r <= r1; r++) out.push(at(c1, r));
  for (let c = c1; c >= c0; c--) out.push(at(c, r1));
  for (let r = r1; r >= r0; r--) out.push(at(c0, r));
  return { pts: out.filter(Boolean), area: { c0, r0, c1, r1 } };
}

/**
 * The SVG text for xTool Studio. Coordinates are screenshot pixels; the
 * width and height carry the real size in millimetres, so it imports at
 * true scale. Groups: color-key, color-key-guides, logo, design,
 * design-guides (grey edges on very light colours) and alignment-frame (a
 * magenta rectangle around the whole screenshot, to line up and delete).
 */
export function buildSvg(shot, geo, shapes, frame, mesh) {
  const k = geo.mmPerPx;
  const W = shot.width, H = shot.height;
  const mmW = W * k, mmH = H * k;
  const p2 = (v) => v.toFixed(2);
  const shapeD = (pts) => 'M' + pts.map(([x, y]) => `${p2(x)} ${p2(y)}`).join('L') + 'Z';
  const guideW = (shot.pitch * 0.2).toFixed(2);
  const out = [];
  const colors = new Set();
  const part = (id, partNo) => {
    const groups = new Map();
    const guides = [];
    for (const s of shapes) {
      if (s.part !== partNo) continue;
      if (!groups.has(s.hex)) groups.set(s.hex, []);
      groups.get(s.hex).push(shapeD(s.pts));
      if (s.light) guides.push(shapeD(s.pts));
      colors.add(s.hex);
    }
    if (!groups.size) return;
    out.push(`<g id="${id}">`);
    for (const [hex, ds] of groups) out.push(`<path fill="${hex}" stroke="${hex}" stroke-width="0.15" d="${ds.join('')}"/>`);
    out.push('</g>');
    if (guides.length) {
      out.push(`<g id="${id}-guides">`);
      out.push(`<path fill="none" stroke="#7e7f81" stroke-width="${guideW}" stroke-linecap="round" stroke-linejoin="round" d="${guides.join('')}"/>`);
      out.push('</g>');
    }
  };
  part('color-key', 2);
  part('logo', 3);
  part('design', 1);
  void frame; void mesh;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mmW.toFixed(3)}mm" height="${mmH.toFixed(3)}mm" preserveAspectRatio="none" viewBox="0 0 ${W} ${H}">\n` +
    `<g id="canvas">\n` + out.join('\n') + '\n' +
    `<g id="alignment-frame"><rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="#ff00ff" stroke-width="1"/></g>\n` +
    `</g>\n</svg>\n`;
  return { svg, mmW, mmH, colors: colors.size };
}

/** Draw the preview at `scale` canvas pixels per screenshot pixel. */
export function drawPreview(canvas, shot, shapes, frame, scale) {
  canvas.width = Math.round(shot.width * scale);
  canvas.height = Math.round(shot.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.lineJoin = 'round';
  for (const { hex, pts, light } of shapes) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = hex;
    ctx.fill();
    if (light) { ctx.strokeStyle = '#969696'; ctx.lineWidth = shot.pitch * 0.06; ctx.stroke(); }
  }
  void frame;
  ctx.strokeStyle = '#ff00ff';
  ctx.lineWidth = Math.max(2 / scale, 1);
  ctx.strokeRect(0.5, 0.5, shot.width - 1, shot.height - 1);
  return canvas;
}

// "+" outline in the unit square whose corners are the four hole centres;
// s[k] is how far hole k reaches into the square.
function plus([a, b, c, d]) {
  return [
    [a, 0], [1 - b, 0], [1 - b, b], [1, b],
    [1, 1 - c], [1 - c, 1 - c], [1 - c, 1], [d, 1],
    [d, 1 - d], [0, 1 - d], [0, a], [a, a],
  ];
}
function bilerp(Q, u, v) {
  return [
    (1 - u) * (1 - v) * Q[0][0] + u * (1 - v) * Q[1][0] + u * v * Q[2][0] + (1 - u) * v * Q[3][0],
    (1 - u) * (1 - v) * Q[0][1] + u * (1 - v) * Q[1][1] + u * v * Q[2][1] + (1 - u) * v * Q[3][1],
  ];
}
/** Near-white is the canvas's own colour: an inkjet doesn't print white, so these stay bare. */
export function isBareCanvas(r, g, b) {
  return r >= 245 && g >= 245 && b >= 245;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}
function fitAffine(P, Q) {
  let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
  for (let i = 0; i < P.length; i++) {
    const v = [P[i][0], P[i][1], 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) S[a][b] += v[a] * v[b];
      bx[a] += v[a] * Q[i][0]; by[a] += v[a] * Q[i][1];
    }
  }
  const det = d3(S);
  if (Math.abs(det) < 1e-9) return null;
  const sol = (b) => [0, 1, 2].map((k) => d3(S.map((row, i) => row.map((val, j) => (j === k ? b[i] : val)))) / det);
  const X = sol(bx), Y = sol(by);
  return [X[0], Y[0], X[1], Y[1], X[2], Y[2]];
}
function d3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}
