// Chiamate al server. Gli errori diventano eccezioni con un messaggio leggibile.
// Online (Vercel e simili) il server può ripartire e perdere la sessione: in quel caso risponde 409 «no_file»,
// qui si ricarica la sorgente (esempio, campo dimostrativo o file) e si ripete la richiesta una volta.

async function parse(res) {
  const ct = res.headers.get("Content-Type") || "";
  if (ct.includes("application/json")) {
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || `Errore ${res.status}`);
    return data;
  }
  if (res.status === 413) throw new Error("File troppo grande per la versione online (massimo circa 4 MB): usa l'app in locale.");
  if (!res.ok) throw new Error(`Errore ${res.status}`);
  return res;
}

async function send(url, opts = {}) {
  try {
    return await fetch(url, { credentials: "same-origin", ...opts });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new Error("Non riesco a raggiungere il server. È ancora acceso?");
  }
}

const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const fileOpts = (file, params) => ({
  method: "POST",
  headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name),
    ...(params ? { "X-Params": encodeURIComponent(JSON.stringify(params)) } : {}) },
  body: file,
});

// ---- sorgente della sessione: esempi e campi dimostrativi si ricordano anche dopo un ricaricamento della pagina
const SRC_KEY = "um_src", SRC_TTL = 6 * 3600 * 1000;
let source = null;
try {
  const s = JSON.parse(localStorage.getItem(SRC_KEY) || "null");
  if (s && Date.now() - (s.t || 0) < SRC_TTL) source = s;
} catch { /* archivio non disponibile */ }
function setSource(s) {
  source = s ? { ...s, t: Date.now() } : null;
  try {
    if (source && (source.k === "example" || source.k === "demo")) localStorage.setItem(SRC_KEY, JSON.stringify(source));
    else localStorage.removeItem(SRC_KEY);
  } catch { /* archivio non disponibile */ }
}
const SRC_CALL = {
  example: (s) => ["/api/example", json({ id: s.id })],
  demo: (s) => ["/api/demo/load", json(s.body)],
  upload: (s) => ["/api/import", fileOpts(s.file)],
  geojson: (s) => ["/api/geojson/load", fileOpts(s.file, s.params)],
};
let reloading = null;
async function reloadSource() {
  if (!source || !SRC_CALL[source.k]) return false;
  const res = await send(...SRC_CALL[source.k](source));
  return res.ok;
}
async function fetchR(url, opts = {}) {
  let res = await send(url, opts);
  if (res.status === 409 && source) {
    reloading = reloading || reloadSource().catch(() => false).finally(() => { reloading = null; });   // richieste parallele: una sola ricarica
    if (await reloading) res = await send(url, opts);
  }
  return res;
}
const request = async (url, opts) => parse(await fetchR(url, opts));
const remember = (s) => (r) => { setSource(s); return r; };

export const api = {
  session: () => request("/api/session"),
  examples: () => request("/api/examples"),
  network: () => request("/api/network"),
  example: (id) => request("/api/example", json({ id })).then(remember({ k: "example", id })),
  reset: () => request("/api/reset", json({})).then(remember(null)),
  upload: (file) => request("/api/import", fileOpts(file)).then((r) => (r.vector ? r : remember({ k: "upload", file })(r))),
  // dopo un riavvio del server online: ricarica l'ultimo esempio o campo dimostrativo (null se non c'è)
  restore: () => (source && (source.k === "example" || source.k === "demo") ? send(...SRC_CALL[source.k](source)).then(parse) : Promise.resolve(null)),
  evaluate: (body, signal) => request("/api/evaluate", { ...json(body), signal }),
  async exportFile(body) {
    const res = await request("/api/export", json(body));
    const blob = await res.blob();
    let name = "ISOXML_NORDSON.zip";
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename="?([^";]+)"?/.exec(cd);
    if (m) name = m[1];
    let summary = null;
    try { summary = JSON.parse(decodeURIComponent(res.headers.get("X-UM-Summary") || "")); } catch { /* facoltativo */ }
    return { blob, name, summary };
  },
  async report(body) {
    const res = await request("/api/report", json(body));
    return res.text();
  },
  // catalogo reale + estensione dimostrativa (sensori, valvole di sezione: codici DEMO-…)
  async catalog() {
    const real = await (await fetch("/data/arag_catalog.json")).json();
    let extra = { products: [], capability_overrides: {} };
    try { extra = await (await fetch("/data/demo_catalog.json")).json(); } catch { /* estensione facoltativa */ }
    const codes = new Set(real.products.map((p) => p.code));
    real.products = real.products.map((p) => {
      const ov = (extra.capability_overrides || {})[p.code];
      if (!ov) return p;
      const caps = { ...(p.capabilities || {}) };
      Object.entries(ov).forEach(([k, v]) => { if (caps[k] === null || caps[k] === undefined) caps[k] = v; });
      return { ...p, capabilities: caps };
    });
    (extra.products || []).forEach((p) => { if (!codes.has(p.code)) real.products.push({ ...p, demo: true }); });
    return real;
  },
  labelsDb: async () => (await fetch("/data/demo_etichette.json")).json(),
  demoFields: () => request("/api/demo/fields"),
  demoSearch: (field) => request(`/api/satellite/search?field=${encodeURIComponent(field)}`),
  demoLoad: (body) => request("/api/demo/load", json(body)).then(remember({ k: "demo", body })),
  // ---- pipeline: zone → ricettari → hardware → ARAG → documenti ----
  satellite: () => request("/api/satellite"),
  geojsonInspect: (file) => request("/api/geojson/inspect", fileOpts(file)),
  geojsonLoad: (file, params) => request("/api/geojson/load", fileOpts(file, params)).then(remember({ k: "geojson", file, params })),
  zoning: (body) => request("/api/zoning", json(body)),
  recipes: (body, signal) => request("/api/recipes", { ...json(body), signal }),
  match: (body, signal) => request("/api/match", { ...json(body), signal }),
  recommend: (body, signal) => request("/api/recommend", { ...json(body), signal }),
  dossier: (body, signal) => request("/api/dossier", { ...json(body), signal }),
  async dossierFile(body) {
    // il file può essere JSON: non passa da parse(), che tratterebbe il JSON come risposta dell'API
    const res = await fetchR("/api/dossier/file", json(body));
    if (!res.ok) {
      let msg = `Errore ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* risposta non JSON */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const m = /filename="?([^";]+)"?/.exec(res.headers.get("Content-Disposition") || "");
    return { blob, name: m ? m[1] : "scheda_trattamento" };
  },
};
