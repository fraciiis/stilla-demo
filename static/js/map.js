// Mappa del campo su canvas: contorno vero, griglia a celle o poligoni di zona, colori per vista.

import { tok } from "./util.js";

const M_PER_DEG = 111320;
const OUTSIDE = 0xffff;

function b64ToU16(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Uint16Array(buf.buffer, 0, buf.length >> 1);   // little-endian come sul server
}

function inRings(x, y, rings) {            // regola pari-dispari: i buchi restano buchi
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export class FieldMap {
  constructor(canvas, handlers = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.h = handlers;
    this.fields = [];
    this.task = null;
    this.colors = [];
    this.selected = null;
    this.hover = null;
    this.proj = null;
    this._grid = null;
    this._off = null;
    this._dirty = true;
    this.labels = [];
    this.smooth = false;
    this.imagery = null;          // { canvas, bbox, smooth, base? } ortofoto o mappa indice sotto le zone
    this.overlay = 1;             // opacità delle zone sopra l'immagine
    this._fadeFrom = null;
    this._colorKey = undefined;
    this._reduced = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener("mousemove", (e) => this._move(e));
    canvas.addEventListener("mouseleave", () => this._leave());
    canvas.addEventListener("click", (e) => this._click(e));
    canvas.addEventListener("touchstart", (e) => { if (e.touches[0]) this._click(e.touches[0], true); }, { passive: true });
  }

  setData(geometry, taskIndex) {
    this.fields = geometry.fields || [];
    this.task = (geometry.tasks || []).find((t) => t.index === taskIndex) || null;
    this._grid = null;
    if (this.task && this.task.grid) {
      const g = this.task.grid;
      this._grid = { ...g, cls: b64ToU16(g.cells) };
    }
    this._gridPos = null;
    this._colorKey = undefined;
    this._fadeFrom = null;
    this._bounds();
    this._dirty = true;
    this.draw();
  }

  // colors: un colore per classe; può portare con sé hatch, labels e smooth (solo aspetto)
  setColors(colors) {
    colors = colors || [];
    const labels = colors.labels || [];
    const key = colors.join("|") + "#" + labels.map((l) => (l ? l.t + l.s : "")).join("|") + (colors.smooth ? "~" : "");
    const fade = this._colorKey !== undefined && key !== this._colorKey && this.proj && !this._reduced.matches;
    const prev = fade ? this._snapshot() : null;
    this._colorKey = key;
    this.colors = colors;
    this.hatch = colors.hatch || [];
    this.labels = labels;
    this.smooth = !!colors.smooth;
    this._dirty = true;
    if (prev) this._startFade(prev); else this.draw();
  }

  // ---- transizione morbida fra due stati della mappa ----
  _snapshot() {
    const c = document.createElement("canvas");
    c.width = this.cv.width; c.height = this.cv.height;
    c.getContext("2d").drawImage(this.cv, 0, 0);
    return c;
  }

  _startFade(prev) {
    this._fadeFrom = prev;
    this._fadeT0 = performance.now();
    const D = 260;
    const step = () => {
      if (this._fadeFrom !== prev) return;
      const t = (performance.now() - this._fadeT0) / D;
      if (t >= 1) { this._fadeFrom = null; this.draw(); return; }
      this.draw();
      requestAnimationFrame(step);
    };
    step();
  }
  setSelected(i) { this.selected = i; this._dirty = true; this.draw(); }

  // immagine di sfondo georiferita (ortofoto, NDVI…) e opacità delle zone sopra di essa
  setImagery(img, overlay = this.overlay) { this.imagery = img; this.overlay = overlay; this._bounds(); this.draw(); }
  setOverlay(a) { this.overlay = a; this.draw(); }

  hasGeometry() { return !!this.proj; }
  hasCells() { return !!(this._grid || (this.task && this.task.polygons && this.task.polygons.length)); }

  // ---- geometria ----
  _bounds() {
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    const add = (x, y) => { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; };
    for (const f of this.fields) for (const r of f.rings) for (const [x, y] of r) add(x, y);
    if (this._grid) {
      const g = this._grid;
      add(g.min_lon, g.min_lat); add(g.min_lon + g.cols * g.dlon, g.min_lat + g.rows * g.dlat);
    }
    if (this.task) for (const p of this.task.polygons || []) for (const r of p.rings) for (const [x, y] of r) add(x, y);
    if (this.imagery) { const b = this.imagery.bbox; add(b.minLon, b.minLat); add(b.maxLon, b.maxLat); }
    this.bb = isFinite(minx) ? { minx, maxx, miny, maxy } : null;
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(10, Math.round(r.width * this.dpr)), h = Math.max(10, Math.round(r.height * this.dpr));
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
    this.draw();
  }

  _project() {
    const bb = this.bb;
    if (!bb) { this.proj = null; return; }
    const W = this.cv.width, H = this.cv.height, pad = (this.h.pad ?? 26) * this.dpr;
    const lat0 = (bb.miny + bb.maxy) / 2, kx = Math.cos((lat0 * Math.PI) / 180);
    const wm = Math.max(1e-9, (bb.maxx - bb.minx) * kx), hm = Math.max(1e-9, bb.maxy - bb.miny);
    const s = Math.min((W - 2 * pad) / wm, (H - 2 * pad) / hm);
    const ox = (W - wm * s) / 2, oy = (H - hm * s) / 2;
    this.proj = {
      s, kx,
      x: (lon) => ox + (lon - bb.minx) * kx * s,
      y: (lat) => H - oy - (lat - bb.miny) * s,
      lon: (px) => (px - ox) / (kx * s) + bb.minx,
      lat: (py) => (H - oy - py) / s + bb.miny,
    };
  }

  // ---- disegno ----
  draw() {
    const ctx = this.ctx, W = this.cv.width, H = this.cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this._project();
    const P = this.proj;
    if (!P) return;
    const sel = this.selected;
    const dim = sel !== null && sel !== undefined;
    const d = this.dpr;
    const fieldPath = (f) => { ctx.beginPath(); for (const ring of f.rings) { ring.forEach(([x, y], i) => (i ? ctx.lineTo(P.x(x), P.y(y)) : ctx.moveTo(P.x(x), P.y(y)))); ctx.closePath(); } };

    if (this.imagery) {
      // immagine georiferita: ortofoto o indice, con il suo contesto attorno al campo
      const drawImg = (im) => {
        const b = im.bbox, x0 = P.x(b.minLon), x1 = P.x(b.maxLon), y0 = P.y(b.maxLat), y1 = P.y(b.minLat);
        ctx.imageSmoothingEnabled = !!im.smooth; ctx.imageSmoothingQuality = "high";
        ctx.drawImage(im.canvas, x0, y0, x1 - x0, y1 - y0);
      };
      if (this.imagery.base) drawImg(this.imagery.base);
      drawImg(this.imagery);
      ctx.imageSmoothingEnabled = false;
    } else {
      // il campo come una "tessera" in rilievo sullo sfondo
      ctx.save();
      ctx.shadowColor = tok("--map-shadow"); ctx.shadowBlur = 22 * d; ctx.shadowOffsetY = 8 * d;
      ctx.fillStyle = tok("--map-field");
      for (const f of this.fields) if (f.rings.length) { fieldPath(f); ctx.fill("evenodd"); }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    const zoneAlpha = this.imagery ? this.overlay : 1;

    // celle di griglia
    if (this._grid && zoneAlpha > 0) { ctx.globalAlpha = zoneAlpha; this._drawGrid(ctx, P, dim); ctx.globalAlpha = 1; }

    // poligoni di zona
    if (this.task && this.task.polygons && this.task.polygons.length) {
      for (const p of this.task.polygons) {
        const c = this.colors[p.class];
        if (!c) continue;
        ctx.beginPath();
        for (const ring of p.rings) ring.forEach(([x, y], i) => (i ? ctx.lineTo(P.x(x), P.y(y)) : ctx.moveTo(P.x(x), P.y(y))));
        ctx.closePath();
        ctx.globalAlpha = (dim && p.class !== sel ? 0.28 : 1) * zoneAlpha;
        ctx.fillStyle = c;
        ctx.fill("evenodd");
        const hp = this._hatchFor(p.class);
        if (hp) { ctx.fillStyle = hp; ctx.fill("evenodd"); }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = tok("--map-zone-line");
        ctx.lineWidth = 1.2 * this.dpr;
        ctx.stroke();
        if (p.class === sel) { ctx.strokeStyle = tok("--map-select"); ctx.lineWidth = 2.6 * this.dpr; ctx.stroke(); }
      }
      // zona sotto il puntatore: bordo chiaro e netto
      if (this.hover !== null && this.hover !== sel) {
        for (const p of this.task.polygons) {
          if (p.class !== this.hover || !this.colors[p.class]) continue;
          ctx.beginPath();
          for (const ring of p.rings) ring.forEach(([x, y], i) => (i ? ctx.lineTo(P.x(x), P.y(y)) : ctx.moveTo(P.x(x), P.y(y))));
          ctx.closePath();
          ctx.lineJoin = "round";
          ctx.strokeStyle = tok("--map-halo"); ctx.lineWidth = 4 * d; ctx.stroke();
          ctx.strokeStyle = tok("--map-select"); ctx.lineWidth = 1.6 * d; ctx.stroke();
        }
      }
    } else if (!this._grid && this.task && this.colors.length === 1 && this.colors[0]) {
      // rateo unico senza geometria: tutto il campo dello stesso colore
      for (const f of this.fields) {
        ctx.beginPath();
        for (const ring of f.rings) ring.forEach(([x, y], i) => (i ? ctx.lineTo(P.x(x), P.y(y)) : ctx.moveTo(P.x(x), P.y(y))));
        ctx.closePath();
        ctx.fillStyle = this.colors[0];
        ctx.fill("evenodd");
        const hp = this._hatchFor(0);
        if (hp) { ctx.fillStyle = hp; ctx.fill("evenodd"); }
      }
    }

    // contorno del campo: alone bianco + linea blu
    ctx.lineJoin = "round";
    for (const f of this.fields) {
      fieldPath(f);
      ctx.strokeStyle = tok("--map-halo"); ctx.lineWidth = 5.5 * d; ctx.stroke();
      ctx.strokeStyle = tok("--map-outline"); ctx.lineWidth = 2.2 * d; ctx.stroke();
    }
    if (zoneAlpha > 0.15) this._drawLabels(ctx, P, dim);
    if (this.h.furniture !== false) this._furniture(ctx, P);

    // dissolvenza dallo stato precedente
    if (this._fadeFrom) {
      const t = Math.min(1, (performance.now() - this._fadeT0) / 260);
      ctx.globalAlpha = 1 - t * t * (3 - 2 * t);
      ctx.drawImage(this._fadeFrom, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  // ---- etichette dei ratei sulle zone ----
  _labelSpots(P) {
    const spots = [];
    const minW = 70 * this.dpr, minH = 30 * this.dpr;
    if (this.task && this.task.polygons && this.task.polygons.length) {
      for (const p of this.task.polygons) {
        const outer = p.rings[0];
        if (!outer || !this.labels[p.class]) continue;
        let a = 0, cx = 0, cy = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
          const xi = P.x(outer[i][0]), yi = P.y(outer[i][1]), xj = P.x(outer[j][0]), yj = P.y(outer[j][1]);
          const f = xj * yi - xi * yj;
          a += f; cx += (xi + xj) * f; cy += (yi + yj) * f;
          x0 = Math.min(x0, xi); x1 = Math.max(x1, xi); y0 = Math.min(y0, yi); y1 = Math.max(y1, yi);
        }
        if (Math.abs(a) < 1e-6 || x1 - x0 < minW || y1 - y0 < minH) continue;
        cx /= 3 * a; cy /= 3 * a;
        if (!inRings(P.lon(cx), P.lat(cy), p.rings)) continue;
        spots.push([p.class, cx, cy, Math.abs(a)]);
      }
    } else if (this._grid) {
      const g = this._grid;
      if (!this._gridPos) this._gridPos = this._gridCentres(g);
      const cellPx = Math.abs(P.x(g.min_lon + g.dlon) - P.x(g.min_lon)) * Math.abs(P.y(g.min_lat) - P.y(g.min_lat + g.dlat));
      for (const [k, c] of this._gridPos) {
        if (!this.labels[k] || c.n * cellPx < minW * minH * 2) continue;
        spots.push([k, P.x(g.min_lon + (c.col + 0.5) * g.dlon), P.y(g.min_lat + (c.row + 0.5) * g.dlat), c.n]);
      }
    } else if (this.colors.length === 1 && this.labels[0] && this.fields.length) {
      let sx = 0, sy = 0, n = 0;
      for (const f of this.fields) for (const [x, y] of f.rings[0] || []) { sx += P.x(x); sy += P.y(y); n++; }
      if (n) spots.push([0, sx / n, sy / n, 1]);
    }
    return spots.sort((a, b) => b[3] - a[3]);          // prima le zone grandi: vincono loro se le etichette si toccano
  }

  // per ogni classe di una griglia a zone: la cella della classe più vicina al suo baricentro
  _gridCentres(g) {
    const acc = new Map();
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      const k = g.cls[r * g.cols + c];
      if (k === OUTSIDE) continue;
      const a = acc.get(k) || { sr: 0, sc: 0, n: 0 };
      a.sr += r; a.sc += c; a.n++; acc.set(k, a);
    }
    const out = new Map();
    if (acc.size > 12) return out;                    // mappe continue: troppe classi per etichettarle
    for (const [k, a] of acc) {
      const mr = a.sr / a.n, mc = a.sc / a.n;
      let best = null, bd = Infinity;
      for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
        if (g.cls[r * g.cols + c] !== k) continue;
        const dd = (r - mr) ** 2 + (c - mc) ** 2;
        if (dd < bd) { bd = dd; best = { row: r, col: c }; }
      }
      if (best) out.set(k, { ...best, n: a.n });
    }
    return out;
  }

  _drawLabels(ctx, P, dim) {
    if (!this.labels.length) return;
    const d = this.dpr, font = getComputedStyle(document.body).fontFamily;
    const fv = `500 ${13 * d}px ${font}`, fu = `400 ${11 * d}px ${font}`;
    const placed = [], gap = 4 * d;
    for (const [k, x, y] of this._labelSpots(P)) {
      const l = this.labels[k];
      const txt = (l.s ? l.s + " " : "") + l.t;
      ctx.font = fv; const wv = ctx.measureText(txt).width;
      ctx.font = fu; const wu = l.u ? ctx.measureText(" " + l.u).width : 0;
      const dot = 8 * d, padX = 8 * d, h = 24 * d;
      const w = padX + dot + 6 * d + wv + wu + padX;
      const bx = x - w / 2, by = y - h / 2;
      if (placed.some(([px, py, pw, ph]) => bx < px + pw + gap && px < bx + w + gap && by < py + ph + gap && py < by + h + gap)) continue;
      placed.push([bx, by, w, h]);
      ctx.globalAlpha = dim && k !== this.selected ? 0.35 : 1;
      ctx.save();
      ctx.shadowColor = "rgba(0,30,50,.25)"; ctx.shadowBlur = 8 * d; ctx.shadowOffsetY = 2 * d;
      ctx.fillStyle = tok("--map-label-bg");
      this._round(ctx, bx, by, w, h, h / 2); ctx.fill();
      ctx.restore();
      ctx.fillStyle = this.colors[k] || tok("--map-nodata");
      ctx.beginPath(); ctx.arc(bx + padX + dot / 2, y, dot / 2, 0, 7); ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,.2)"; ctx.lineWidth = 1 * d; ctx.stroke();
      ctx.textBaseline = "middle";
      ctx.fillStyle = tok("--map-ink"); ctx.font = fv;
      ctx.fillText(txt, bx + padX + dot + 6 * d, y + 0.5 * d);
      if (l.u) { ctx.fillStyle = tok("--text-2"); ctx.font = fu; ctx.fillText(" " + l.u, bx + padX + dot + 6 * d + wv, y + 0.5 * d); }
      ctx.globalAlpha = 1;
    }
  }

  _round(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  _drawGrid(ctx, P, dim) {
    const g = this._grid;
    if (!this._off || this._dirty) {
      const off = this._off || document.createElement("canvas");
      off.width = g.cols; off.height = g.rows;
      const octx = off.getContext("2d");
      const img = octx.createImageData(g.cols, g.rows);
      const rgba = this._rgba();
      const sel = this.selected;
      for (let r = 0; r < g.rows; r++) {
        const yy = g.rows - 1 - r;                    // la riga 0 del file è a SUD: in alto va il nord
        for (let c = 0; c < g.cols; c++) {
          const k = g.cls[r * g.cols + c];
          const o = (yy * g.cols + c) * 4;
          if (k === OUTSIDE || !rgba[k]) { img.data[o + 3] = 0; continue; }
          const q = rgba[k];
          img.data[o] = q[0]; img.data[o + 1] = q[1]; img.data[o + 2] = q[2];
          img.data[o + 3] = dim && k !== sel ? 70 : 255;
        }
      }
      if (this.smooth && this.fields.some((f) => !f.from_grid && f.rings.length)) this._bleed(img.data, g.cols, g.rows);
      octx.putImageData(img, 0, 0);
      this._off = off;
      this._masks = this._hatchMasks(img, g);
      this._dirty = false;
    }
    const x0 = P.x(g.min_lon), x1 = P.x(g.min_lon + g.cols * g.dlon);
    const y0 = P.y(g.min_lat + g.rows * g.dlat), y1 = P.y(g.min_lat);
    ctx.imageSmoothingEnabled = this.smooth;            // mappe continue: passaggi sfumati fra celle
    ctx.imageSmoothingQuality = "high";
    ctx.save();
    const clipped = this.fields.some((f) => !f.from_grid && f.rings.length);
    if (clipped) {                       // le celle non escono dal contorno del campo
      ctx.beginPath();
      for (const f of this.fields) if (!f.from_grid) for (const ring of f.rings) { ring.forEach(([x, y], i) => (i ? ctx.lineTo(P.x(x), P.y(y)) : ctx.moveTo(P.x(x), P.y(y)))); ctx.closePath(); }
      ctx.clip("evenodd");
    }
    ctx.drawImage(this._off, x0, y0, x1 - x0, y1 - y0);
    for (const [kind, mask] of this._masks || []) this._drawHatchMask(ctx, mask, kind, x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }

  // ---- tratteggio: gli stati critici restano leggibili anche senza distinguere i colori ----
  _pattern(kind) {
    const d = this.dpr, key = `${kind}@${d}`;
    this._pats = this._pats || new Map();
    if (!this._pats.has(key)) {
      const s = Math.round(8 * d), c = document.createElement("canvas");
      c.width = c.height = s;
      const x = c.getContext("2d");
      x.strokeStyle = tok("--map-hatch"); x.lineWidth = 1.8 * d; x.lineCap = "square";
      const line = (a, b, e, f) => { x.beginPath(); x.moveTo(a, b); x.lineTo(e, f); x.stroke(); };
      line(0, s, s, 0); line(-s / 2, s / 2, s / 2, -s / 2); line(s / 2, s * 1.5, s * 1.5, s / 2);      // diagonale /
      if (kind === "v") { line(0, 0, s, s); line(-s / 2, s / 2, s / 2, s * 1.5); line(s / 2, -s / 2, s * 1.5, s / 2); }  // incrociato
      this._pats.set(key, this.ctx.createPattern(c, "repeat"));
    }
    return this._pats.get(key);
  }

  _hatchFor(k) { const h = this.hatch && this.hatch[k]; return h ? this._pattern(h) : null; }

  _hatchMasks(img, g) {
    const kinds = new Map();
    (this.hatch || []).forEach((h, k) => { if (h) { if (!kinds.has(h)) kinds.set(h, new Set()); kinds.get(h).add(k); } });
    const out = [];
    for (const [kind, set] of kinds) {
      const m = document.createElement("canvas");
      m.width = g.cols; m.height = g.rows;
      const mctx = m.getContext("2d"), md = mctx.createImageData(g.cols, g.rows);
      let any = false;
      for (let r = 0; r < g.rows; r++) {
        const yy = g.rows - 1 - r;
        for (let c = 0; c < g.cols; c++) {
          const k = g.cls[r * g.cols + c];
          if (k === OUTSIDE || !set.has(k)) continue;
          const o = (yy * g.cols + c) * 4;
          md.data[o + 3] = img.data[o + 3]; any = true;
        }
      }
      if (any) { mctx.putImageData(md, 0, 0); out.push([kind, m]); }
    }
    return out;
  }

  _drawHatchMask(ctx, mask, kind, x, y, w, h) {
    const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
    const t = this._tmp || (this._tmp = document.createElement("canvas"));
    t.width = W; t.height = H;
    const tctx = t.getContext("2d");
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(mask, 0, 0, W, H);
    tctx.globalCompositeOperation = "source-in";
    tctx.fillStyle = this._pattern(kind);
    tctx.fillRect(0, 0, W, H);
    ctx.drawImage(t, x, y, w, h);
  }

  // con la sfumatura le celle esterne trasparenti creerebbero un alone chiaro sul bordo:
  // le riempio col colore della cella vicina (il contorno del campo ritaglia comunque il disegno)
  _bleed(px, cols, rows) {
    for (let pass = 0; pass < 2; pass++) {
      const src = px.slice();
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const o = (y * cols + x) * 4;
        if (src[o + 3]) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const q = (ny * cols + nx) * 4;
          if (!src[q + 3]) continue;
          px[o] = src[q]; px[o + 1] = src[q + 1]; px[o + 2] = src[q + 2]; px[o + 3] = src[q + 3];
          break;
        }
      }
    }
  }

  _rgba() {
    const cvs = document.createElement("canvas");
    cvs.width = cvs.height = 1;
    const c = cvs.getContext("2d", { willReadFrequently: true });
    return this.colors.map((col) => {
      if (!col) return null;
      c.clearRect(0, 0, 1, 1); c.fillStyle = col; c.fillRect(0, 0, 1, 1);
      const d = c.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    });
  }

  _furniture(ctx, P) {
    const d = this.dpr;
    const ink = tok("--map-ink"), font = getComputedStyle(document.body).fontFamily;
    const chip = (x, y, w, h) => {
      ctx.save();
      ctx.shadowColor = "rgba(0,30,50,.18)"; ctx.shadowBlur = 10 * d; ctx.shadowOffsetY = 2 * d;
      ctx.fillStyle = tok("--map-chrome"); this._round(ctx, x, y, w, h, 8 * d); ctx.fill();
      ctx.restore();
    };
    // barra della scala
    const metersPerPx = M_PER_DEG / P.s;              // metri per pixel del canvas
    const want = metersPerPx * 110 * d;
    const nice = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000].reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
    const len = nice / metersPerPx;
    const x = 22 * d, y = this.cv.height - 20 * d;
    chip(x - 10 * d, y - 26 * d, len + 20 * d, 36 * d);
    ctx.strokeStyle = ink; ctx.lineWidth = 2 * d; ctx.lineCap = "butt";
    ctx.beginPath(); ctx.moveTo(x, y - 5 * d); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 5 * d); ctx.stroke();
    ctx.fillStyle = ink; ctx.font = `500 ${12 * d}px ${font}`; ctx.textBaseline = "bottom";
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, x + 3 * d, y - 6 * d);
    // nord
    const nx = this.cv.width - 30 * d, ny = 30 * d;
    chip(nx - 17 * d, ny - 17 * d, 34 * d, 40 * d);
    ctx.fillStyle = ink; ctx.beginPath(); ctx.moveTo(nx, ny - 10 * d); ctx.lineTo(nx - 6 * d, ny + 4 * d); ctx.lineTo(nx, ny + 1 * d); ctx.lineTo(nx + 6 * d, ny + 4 * d); ctx.closePath(); ctx.fill();
    ctx.textAlign = "center"; ctx.font = `500 ${11 * d}px ${font}`;
    ctx.fillText("N", nx, ny + 19 * d); ctx.textAlign = "start";
  }

  // ---- interazione ----
  _hit(e) {
    const P = this.proj;
    if (!P) return null;
    const r = this.cv.getBoundingClientRect();
    const px = (e.clientX - r.left) * this.dpr, py = (e.clientY - r.top) * this.dpr;
    const lon = P.lon(px), lat = P.lat(py);
    if (this._grid) {
      const g = this._grid;
      const c = Math.floor((lon - g.min_lon) / g.dlon), rr = Math.floor((lat - g.min_lat) / g.dlat);
      if (c >= 0 && rr >= 0 && c < g.cols && rr < g.rows) {
        const k = g.cls[rr * g.cols + c];
        if (k !== OUTSIDE && this.colors[k]) return k;
      }
      return null;
    }
    if (this.task && this.task.polygons && this.task.polygons.length) {
      const ps = this.task.polygons;
      for (let i = ps.length - 1; i >= 0; i--) if (inRings(lon, lat, ps[i].rings)) return ps[i].class;
      return null;
    }
    if (this.colors.length === 1 && this.fields.some((f) => inRings(lon, lat, f.rings))) return 0;
    return null;
  }

  _move(e) {
    const k = this._hit(e);
    this.cv.style.cursor = k === null ? "default" : "pointer";
    if (k !== this.hover) { this.hover = k; if (this.task && this.task.polygons && this.task.polygons.length) this.draw(); }
    this.h.hover && this.h.hover(k, e);
  }
  _leave() { const had = this.hover !== null; this.hover = null; if (had) this.draw(); this.h.hover && this.h.hover(null, null); }
  _click(e, touch = false) {
    const k = this._hit(e);
    this.h.click && this.h.click(k, touch ? e : e);
  }
}
