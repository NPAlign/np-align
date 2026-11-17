// Pan/zoom view of the scan with the aligned design and the detected
// intersections drawn on top.

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scan = null;
    this.print = null;
    this.points = null; // {ix, iy, cols, rows}
    this.highlight = null; // {col,row,w,h} design footprint
    this.showPoints = true;
    this.showDesign = true;
    this.showScan = true;
    this.rings = []; // [{x, y, r}] in image pixels, e.g. the registration dot
    this.designOpacity = 0.85;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.onPick = null;
    this.onZoom = null;
    this._bind();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._resize();
  }

  get imageWidth() { return this.scan ? this.scan.width : 0; }
  get imageHeight() { return this.scan ? this.scan.height : 0; }

  setScan(bitmap, keepView = false) {
    this.scan = bitmap;
    if (!keepView) this.fit(); else this.draw();
  }

  fit() {
    if (!this.scan) return this.draw();
    const { w, h } = this._size();
    this.scale = Math.min(w / this.scan.width, h / this.scan.height) * 0.96;
    this.tx = (w - this.scan.width * this.scale) / 2;
    this.ty = (h - this.scan.height * this.scale) / 2;
    this._zoomed();
    this.draw();
  }

  /** Zoom so one canvas hole is ~`px` screen pixels, centred on image point. */
  zoomTo(ix, iy, pitch, px = 60) {
    const { w, h } = this._size();
    this.scale = px / pitch;
    this.tx = w / 2 - ix * this.scale;
    this.ty = h / 2 - iy * this.scale;
    this._zoomed();
    this.draw();
  }

  zoomBy(f, cx, cy) {
    const { w, h } = this._size();
    if (cx === undefined) { cx = w / 2; cy = h / 2; }
    const ns = Math.min(40, Math.max(0.02, this.scale * f));
    this.tx = cx - ((cx - this.tx) * ns) / this.scale;
    this.ty = cy - ((cy - this.ty) * ns) / this.scale;
    this.scale = ns;
    this._zoomed();
    this.draw();
  }

  _zoomed() { if (this.onZoom) this.onZoom(this.scale); }

  _size() {
    const r = this.canvas.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = this._size();
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.draw();
  }

  toImage(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return [(clientX - r.left - this.tx) / this.scale, (clientY - r.top - this.ty) / this.scale];
  }

  _bind() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        this.tx = drag.tx + dx;
        this.ty = drag.ty + dy;
        this.draw();
      }
    });
    c.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved && this.onPick && this.scan) {
        const [x, y] = this.toImage(e.clientX, e.clientY);
        this.onPick(x, y);
      }
      drag = null;
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false }
    );
    c.addEventListener('keydown', (e) => {
      const step = 60;
      if (e.key === '+' || e.key === '=') this.zoomBy(1.4);
      else if (e.key === '-') this.zoomBy(1 / 1.4);
      else if (e.key === 'ArrowLeft') { this.tx += step; this.draw(); }
      else if (e.key === 'ArrowRight') { this.tx -= step; this.draw(); }
      else if (e.key === 'ArrowUp') { this.ty += step; this.draw(); }
      else if (e.key === 'ArrowDown') { this.ty -= step; this.draw(); }
      else if (e.key === '0') this.fit();
      else return;
      e.preventDefault();
    });
  }

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._draw();
    });
  }

  _draw() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.scan) return;
    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * this.tx, dpr * this.ty);
    ctx.imageSmoothingEnabled = this.scale < 2;
    if (this.showScan) {
      ctx.drawImage(this.scan, 0, 0);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.scan.width, this.scan.height);
    }
    if (this.print && this.showDesign) {
      ctx.globalAlpha = this.designOpacity;
      ctx.drawImage(this.print, 0, 0, this.scan.width, this.scan.height);
      ctx.globalAlpha = 1;
    }

    // rings (registration dot)
    if (this.rings.length) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const g of this.rings) {
        const x = g.x * this.scale + this.tx, y = g.y * this.scale + this.ty;
        const rr = Math.max(14, g.r * this.scale);
        ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 3; ctx.strokeStyle = '#e0162b';
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // intersections, only when zoomed in enough to tell them apart
    const P = this.points;
    if (P && this.showPoints) {
      const pitchScreen = P.pitch * this.scale;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const { w, h } = this._size();
      if (pitchScreen >= 7) {
        const arm = Math.min(10, pitchScreen * 0.22);
        const lw = pitchScreen > 30 ? 2 : 1.25;
        ctx.beginPath();
        for (let k = 0; k < P.ix.length; k++) {
          const x = P.ix[k] * this.scale + this.tx;
          const y = P.iy[k] * this.scale + this.ty;
          if (!(x > -10 && y > -10 && x < w + 10 && y < h + 10)) continue; // also skips NaN
          ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y);
          ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm);
        }
        // dark halo then bright pink, so marks read on light thread and dark holes
        ctx.lineCap = 'round';
        ctx.lineWidth = lw + 2;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.stroke();
        ctx.lineWidth = lw;
        ctx.strokeStyle = '#ff3fb4';
        ctx.stroke();
      }
      // design footprint outline (follows the warped grid)
      const H = this.highlight;
      if (H && P.hx) {
        const pts = footprint(P, H);
        if (pts.length) {
          ctx.strokeStyle = 'rgba(255, 210, 63, 0.95)';
          ctx.setLineDash([6, 4]);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          pts.forEach(([x, y], i) => {
            const sx = x * this.scale + this.tx, sy = y * this.scale + this.ty;
            i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
          });
          ctx.closePath();
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  }
}

// Outline of the design's footprint traced along the outer hole centres.
function footprint(P, H) {
  const { hx, hy, hcols, hrows } = P;
  const c0 = Math.max(0, H.col), r0 = Math.max(0, H.row);
  const c1 = Math.min(hcols - 1, H.col + H.w), r1 = Math.min(hrows - 1, H.row + H.h);
  if (c1 <= c0 || r1 <= r0) return [];
  const out = [];
  const push = (c, r) => {
    const k = r * hcols + c;
    if (!Number.isNaN(hx[k])) out.push([hx[k], hy[k]]);
  };
  for (let c = c0; c <= c1; c++) push(c, r0);
  for (let r = r0; r <= r1; r++) push(c1, r);
  for (let c = c1; c >= c0; c--) push(c, r1);
  for (let r = r1; r >= r0; r--) push(c0, r);
  return out;
}
