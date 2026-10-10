// Chiamate al server. Gli errori diventano eccezioni con un messaggio leggibile.

async function parse(res) {
  const ct = res.headers.get("Content-Type") || "";
  if (ct.includes("application/json")) {
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || `Errore ${res.status}`);
    return data;
  }
  if (!res.ok) throw new Error(`Errore ${res.status}`);
  return res;
}

async function request(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { credentials: "same-origin", ...opts });
  } catch (e) {
    throw new Error("Non riesco a raggiungere il server. È ancora acceso?");
  }
  return parse(res);
}

const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  session: () => request("/api/session"),
  examples: () => request("/api/examples"),
  network: () => request("/api/network"),
  example: (id) => request("/api/example", json({ id })),
  reset: () => request("/api/reset", json({})),
  upload: (file) => request("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
    body: file,
  }),
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
  demoLoad: (body) => request("/api/demo/load", json(body)),
  // ---- pipeline: zone → ricettari → hardware → ARAG → documenti ----
  satellite: () => request("/api/satellite"),
  geojsonInspect: (file) => request("/api/geojson/inspect", {
    method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) }, body: file,
  }),
  geojsonLoad: (file, params) => request("/api/geojson/load", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name), "X-Params": encodeURIComponent(JSON.stringify(params)) },
    body: file,
  }),
  zoning: (body) => request("/api/zoning", json(body)),
  recipes: (body, signal) => request("/api/recipes", { ...json(body), signal }),
  match: (body, signal) => request("/api/match", { ...json(body), signal }),
  recommend: (body, signal) => request("/api/recommend", { ...json(body), signal }),
  dossier: (body, signal) => request("/api/dossier", { ...json(body), signal }),
  async dossierFile(body) {
    // il file può essere JSON: non passa da parse(), che tratterebbe il JSON come risposta dell'API
    let res;
    try { res = await fetch("/api/dossier/file", { credentials: "same-origin", ...json(body) }); }
    catch { throw new Error("Non riesco a raggiungere il server. È ancora acceso?"); }
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
