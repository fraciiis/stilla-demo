// Utilità comuni: selettori, formattazione italiana, toast, debounce, stato dei piani.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const nf = new Map();
export function fmt(v, d = 0) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (!nf.has(d)) nf.set(d, new Intl.NumberFormat("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d }));
  return nf.get(d).format(v);
}

export function debounce(fn, ms) {
  let t = null;
  const f = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  f.cancel = () => clearTimeout(t);
  return f;
}

let toastTimer = null;
export function toast(msg, isErr = false, ms = 4200) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// Colori dai token CSS (static/css/style.css, :root): un solo posto dove cambiarli
const tokCache = new Map();
export function tok(name) {
  if (!tokCache.has(name)) tokCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#999");
  return tokCache.get(name);
}
const st = (key, name, cls, t) => ({ key, name, cls, get color() { return tok(t); } });

// Stato di una classe sul tuo hardware (codici di una lettera inviati dal server)
export const STATUS = {
  o: st("ok", "Perfetto", "ok", "--map-ok"),
  a: st("adapt", "Con adattamento", "adapt", "--map-adapt"),
  u: st("under", "Sotto-dosato", "under", "--map-under"),
  v: st("over", "Sovra-dosato", "over", "--map-over"),
  f: st("off", "Non trattare", "off", "--map-off"),
  n: st("nodata", "Dato mancante", "off", "--map-nodata"),
  x: st("novra", "Rateo variabile non eseguibile", "novra", "--map-novra"),
};
export const STATUS_BY_KEY = Object.fromEntries(Object.values(STATUS).map((s) => [s.key, s]));
export const DIFF = {
  b: { name: "Va meglio", get color() { return tok("--map-better"); } },
  w: { name: "Va peggio", get color() { return tok("--map-worse"); } },
  s: { name: "Invariato", get color() { return tok("--map-same"); } },
};
// Stati che sulla mappa ricevono anche un tratteggio (leggibili senza distinguere i colori)
export const HATCH = { u: "u", v: "v" };
export const DIFF_HATCH = { w: "w" };

export function badge(code) {
  const s = STATUS[code] || STATUS.n;
  return `<span class="badge ${s.cls}">${esc(s.name)}</span>`;
}

// Rampa blu per i ratei (chiaro = poco, scuro = tanto), estremi dai token
const hexRgb = (h) => { const v = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)); };
export function rampColor(t) {
  t = Math.max(0, Math.min(1, t));
  const a = hexRgb(tok("--ramp-lo")), b = hexRgb(tok("--ramp-hi"));
  const mid = hexRgb(tok("--ramp-mid"));
  let c;
  if (t < 0.5) c = a.map((x, i) => x + (mid[i] - x) * (t / 0.5));
  else c = mid.map((x, i) => x + (b[i] - x) * ((t - 0.5) / 0.5));
  return `rgb(${c.map(Math.round).join(",")})`;
}
