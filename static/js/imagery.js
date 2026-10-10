// Immagini DIMOSTRATIVE dei campi: ortofoto e mappe indice generate nel browser dai dati simulati
// (static/demo/fields.json). Stile ispirato ai prodotti reali: drone con filari visibili e NDVI rosso→verde,
// Sentinel-2 con pixel da 10 m. Nessuna immagine reale.

let fieldsPromise = null;
export function demoFields() {
  if (!fieldsPromise) fieldsPromise = fetch("/demo/fields.json").then((r) => r.json());
  return fieldsPromise;
}

// ---------------------------------------------------------------- rumore deterministico
function hash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y, s) => 0.5 * vnoise(x, y, s) + 0.3 * vnoise(x * 2.1, y * 2.1, s + 7) + 0.2 * vnoise(x * 4.3, y * 4.3, s + 13);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const sstep = (a, b, t) => { t = clamp01((t - a) / (b - a)); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- scale di colore
const NDVI_STOPS = [[0.0, [165, 0, 38]], [0.2, [215, 48, 39]], [0.33, [244, 109, 67]], [0.43, [253, 174, 97]], [0.5, [254, 224, 139]],
  [0.58, [217, 239, 139]], [0.66, [166, 217, 106]], [0.74, [102, 189, 99]], [0.82, [26, 152, 80]], [0.92, [0, 104, 55]]];
const WEED_STOPS = [[0, [250, 246, 238]], [3, [233, 213, 230]], [10, [215, 140, 196]], [20, [206, 18, 86]], [35, [130, 0, 50]], [60, [70, 0, 30]]];
function ramp(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i], t = (v - a) / (b - a);
      return [lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t)];
    }
  }
  return stops[stops.length - 1][1];
}
export const ndviColor = (v) => ramp(NDVI_STOPS, v);
export const weedColor = (v) => ramp(WEED_STOPS, v);
export const NDVI_LEGEND = NDVI_STOPS.filter((_, i) => i % 2 === 0 || i === NDVI_STOPS.length - 1);

// ---------------------------------------------------------------- dati
function b64(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

function inRing(ring, x, y) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

const cache = new Map();
export function fieldGrid(f, index, acq) {
  const key = `${f.id}|${index}|${acq ? acq.id : ""}`;
  if (cache.has(key)) return cache.get(key);
  const g = f.grid, n = g.cols * g.rows, raw = b64(f.indices[index].data), vals = new Float32Array(n);
  const [a, b] = (acq && acq.factor) || [1, 0];
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    if (index === "NDVI") vals[i] = Math.max(-0.2, Math.min(1, a * (v / 254 * 1.2 - 0.2) + b));
    else vals[i] = v === 255 ? NaN : v;
  }
  let inside = cache.get(f.id + "|in");
  if (!inside) {
    inside = new Uint8Array(n);
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      inside[r * g.cols + c] = inRing(f.boundary, g.min_lon + (c + 0.5) * g.dlon, g.min_lat + (r + 0.5) * g.dlat) ? 1 : 0;
    }
    cache.set(f.id + "|in", inside);
  }
  const out = { g, vals, inside };
  cache.set(key, out);
  return out;
}

export function stats(f, index, acq) {
  const { vals, inside } = fieldGrid(f, index, acq);
  const xs = [];
  for (let i = 0; i < vals.length; i++) if (inside[i] && !Number.isNaN(vals[i])) xs.push(vals[i]);
  xs.sort((p, q) => p - q);
  const mean = xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
  const q = (p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  const lo = index === "NDVI" ? 0 : 0, hi = index === "NDVI" ? 1 : 60, bins = new Array(20).fill(0);
  xs.forEach((v) => { bins[Math.min(19, Math.max(0, Math.floor((v - lo) / (hi - lo) * 20)))]++; });
  return { n: xs.length, mean, min: xs[0], max: xs[xs.length - 1], p10: q(0.1), p50: q(0.5), p90: q(0.9), bins, lo, hi };
}

function sample(vals, g, cx, cy) {                    // bilineare in coordinate di cella
  const x = Math.max(0, Math.min(g.cols - 1.001, cx - 0.5)), y = Math.max(0, Math.min(g.rows - 1.001, cy - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const i = y0 * g.cols + x0;
  let a = vals[i], b = vals[i + 1], c = vals[i + g.cols], d = vals[i + g.cols + 1];
  const m = [a, b, c, d].filter((v) => !Number.isNaN(v));
  const fill = m.length ? m.reduce((s, v) => s + v, 0) / m.length : 0;
  if (Number.isNaN(a)) a = fill; if (Number.isNaN(b)) b = fill; if (Number.isNaN(c)) c = fill; if (Number.isNaN(d)) d = fill;
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

// ---------------------------------------------------------------- rendering
// Restituisce { canvas, bbox, smooth } pronto per FieldMap.setImagery
export function render(f, layer, acq, opts = {}) {
  const sat = acq && acq.type === "sentinel2";
  const g = f.grid;
  const bbox = { minLon: g.min_lon, minLat: g.min_lat, maxLon: g.min_lon + g.cols * g.dlon, maxLat: g.min_lat + g.rows * g.dlat };
  if (layer === "weed") {
    const { vals, inside } = fieldGrid(f, "WEED", acq);
    const cv = document.createElement("canvas"); cv.width = g.cols; cv.height = g.rows;
    const ctx = cv.getContext("2d"), img = ctx.createImageData(g.cols, g.rows);
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c, o = ((g.rows - 1 - r) * g.cols + c) * 4;
      if (!inside[i] || Number.isNaN(vals[i])) { img.data[o + 3] = 0; continue; }
      const col = weedColor(vals[i]);
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2];
      img.data[o + 3] = Math.round(255 * (0.12 + 0.88 * sstep(1, 9, vals[i])));      // dove non ci sono infestanti si vede la coltura
    }
    ctx.putImageData(img, 0, 0);
    return { canvas: cv, bbox, smooth: true, base: render(f, "rgb", acq, { ...opts, muted: true }) };
  }
  const { vals, inside } = fieldGrid(f, "NDVI", acq);
  if (sat) return renderSat(f, layer, vals, inside, bbox, acq);
  const scale = opts.scale || 4;                      // 0,5 m/px con celle da 2 m
  const W = g.cols * scale, H = g.rows * scale, res = g.cell_m / scale;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(W, H), px = img.data;
  const rows = f.rows, ang = (rows.angle * Math.PI) / 180, ca = Math.cos(ang), sa = Math.sin(ang);
  const soil = f.soil, canopy = f.canopy, seed = f.id.length * 97;
  const fine = rows.spacing < res * 3;                // filari troppo fitti per essere risolti: texture direzionale
  for (let py = 0; py < H; py++) {
    const y = (H - 1 - py) * res;
    for (let pxx = 0; pxx < W; pxx++) {
      const x = pxx * res;
      const cx = x / g.cell_m, cy = y / g.cell_m;
      const ci = Math.min(g.rows - 1, Math.floor(cy)) * g.cols + Math.min(g.cols - 1, Math.floor(cx));
      const v = sample(vals, g, cx, cy);
      const grain = hash(pxx, py, seed), low = fbm(x / 14, y / 14, seed);
      const o = (py * W + pxx) * 4;
      let R, G, B, nd;
      if (!inside[ci]) {
        // contesto: strade, siepi e campi confinanti
        if (v < 0.1) { const k = 0.85 + 0.25 * grain; R = 196 * k; G = 186 * k; B = 166 * k; nd = 0.06; }
        else if (v > 0.74) { const t = fbm(x / 3, y / 3, seed + 5); const k = 0.55 + 0.6 * t; R = 38 * k; G = 78 * k; B = 34 * k; nd = 0.8 * (0.8 + 0.2 * t); }
        else {
          const u2 = x * 0.2 - y * 0.98, st = 0.5 + 0.5 * Math.sin(u2 * 2.2);
          const cov = sstep(0.25, 0.65, v) * (0.75 + 0.25 * st);
          R = lerp(150, 92, cov) * (0.9 + 0.2 * low); G = lerp(130, 130, cov) * (0.9 + 0.2 * low); B = lerp(100, 60, cov) * (0.9 + 0.2 * low); nd = v;
        }
      } else {
        const u = x * ca + y * sa;
        let cover;
        if (rows.kind === "tramline") {
          const m = ((u % rows.spacing) + rows.spacing) % rows.spacing;
          const track = (m < 0.45 || Math.abs(m - 1.9) < 0.45) ? 1 : 0;
          cover = sstep(0.2, 0.75, v) * (1 - 0.75 * track) * (0.88 + 0.12 * Math.sin(u * 8.4));
        } else if (fine) {
          cover = sstep(0.25, 0.8, v) * (0.82 + 0.18 * Math.sin((u / rows.spacing) * 2 * Math.PI * 0.33));
        } else {
          const ph = (((u / rows.spacing) % 1) + 1) % 1, d = Math.abs(ph - 0.5) * 2;           // 0 al centro del filare
          const half = rows.kind === "vine" ? 0.3 + 0.3 * sstep(0.3, 0.85, v) : 0.35 + 0.45 * sstep(0.3, 0.85, v);
          cover = 1 - sstep(half * 0.7, half, d);
        }
        cover = clamp01(cover * (0.9 + 0.2 * grain));
        const t = sstep(0.2, 0.75, v);
        const lc = [lerp(150, canopy[0], t), lerp(155, canopy[1], t), lerp(80, canopy[2], t)];
        const sk = 0.82 + 0.3 * low + 0.12 * (grain - 0.5);
        let ground = [soil[0] * sk, soil[1] * sk, soil[2] * sk];
        if (rows.kind === "vine") {                       // interfila inerbito
          const gr = 0.55 * (0.5 + 0.5 * low);
          ground = [lerp(ground[0], 118 * sk, gr), lerp(ground[1], 138 * sk, gr), lerp(ground[2], 72 * sk, gr)];
        }
        const leaf = 0.78 + 0.35 * fbm(x * 1.7, y * 1.7, seed + 3);
        R = lerp(ground[0], lc[0] * leaf, cover); G = lerp(ground[1], lc[1] * leaf, cover); B = lerp(ground[2], lc[2] * leaf, cover);
        nd = cover;                                       // qui: quota di chioma del pixel, per la mappa NDVI
      }
      if (layer === "ndvi") {
        // come nei software per drone: NDVI sulla chioma, suolo dell'interfila oscurato; contesto attenuato
        const col = ndviColor(v), k = 0.94 + 0.08 * grain;
        if (!inside[ci]) {
          const gray = (col[0] + col[1] + col[2]) / 3;
          px[o] = lerp(gray, col[0], 0.35) * 0.8; px[o + 1] = lerp(gray, col[1], 0.35) * 0.8; px[o + 2] = lerp(gray, col[2], 0.35) * 0.8;
        } else {
          const cv2 = fine || rows.kind === "tramline" ? 1 : nd;
          px[o] = lerp(46, col[0], cv2) * k; px[o + 1] = lerp(42, col[1], cv2) * k; px[o + 2] = lerp(40, col[2], cv2) * k;
        }
      } else {
        const m = opts.muted ? 0.55 : 1, gray = (R + G + B) / 3;
        px[o] = lerp(gray, R, m); px[o + 1] = lerp(gray, G, m); px[o + 2] = lerp(gray, B, m);
      }
      px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: cv, bbox, smooth: true };
}

function renderSat(f, layer, vals, inside, bbox, acq) {
  const g = f.grid, step = Math.max(1, Math.round((acq.res_m || 10) / g.cell_m));
  const W = Math.ceil(g.cols / step), H = Math.ceil(g.rows / step);
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(W, H);
  const soil = f.soil, canopy = f.canopy, seed = f.id.length * 31;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    let s = 0, n = 0;
    for (let rr = r * step; rr < Math.min(g.rows, (r + 1) * step); rr++) for (let cc = c * step; cc < Math.min(g.cols, (c + 1) * step); cc++) { s += vals[rr * g.cols + cc]; n++; }
    const v = s / n, o = ((H - 1 - r) * W + c) * 4, k = 0.95 + 0.1 * hash(c, r, seed);
    let col;
    if (layer === "ndvi") col = ndviColor(v);
    else {
      const t = sstep(0.18, 0.8, v);
      col = [lerp(soil[0], canopy[0] * 1.15, t) * 0.92 + 14, lerp(soil[1], canopy[1] * 1.1, t) * 0.92 + 16, lerp(soil[2], canopy[2], t) * 0.92 + 20];   // leggera foschia atmosferica
    }
    img.data[o] = col[0] * k; img.data[o + 1] = col[1] * k; img.data[o + 2] = col[2] * k; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: cv, bbox, smooth: false };
}

// istogramma SVG dell'indice dentro il campo
export function histogramSvg(st, index) {
  const max = Math.max(...st.bins, 1), w = 300, h = 70, bw = w / st.bins.length;
  const bars = st.bins.map((b, i) => {
    const v = st.lo + ((i + 0.5) / st.bins.length) * (st.hi - st.lo);
    const col = index === "NDVI" ? ndviColor(v) : weedColor(v);
    const bh = Math.max(1, Math.sqrt(b / max) * (h - 4));            // radice: si leggono anche le classi poco popolate
    return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="rgb(${col.map(Math.round).join(",")})"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" class="hist" role="img" aria-label="Distribuzione dei valori dell'indice nel campo">${bars}</svg>`;
}
