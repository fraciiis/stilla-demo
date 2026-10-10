// Stato condiviso della pipeline: un solo flusso di dati dalle zone alla documentazione.
// Qui vivono le scelte del tecnico (prodotti, ricettario, dati del documento) e il registro delle decisioni;
// i calcoli li fa il server. Ogni modifica a monte invalida ciò che dipende da lei.

export const PHASES = [
  { n: 1, id: "zones", label: "Mappa e zone", short: "Mappa" },
  { n: 2, id: "recipes", label: "Ricettari", short: "Ricettari" },
  { n: 3, id: "select", label: "Scelta", short: "Scelta" },
  { n: 4, id: "hardware", label: "Hardware", short: "Hardware" },
  { n: 5, id: "arag", label: "Componenti ARAG", short: "ARAG" },
  { n: 6, id: "docs", label: "Documenti", short: "Documenti" },
];

const blank = () => ({
  v: 1, key: "", phase: 1,
  zoning: null,
  products: [], options: { objective: "", tank_l: "" },
  recipes: null, recipeId: "", selection: null,
  match: null, recs: null, aragSeen: false,
  doc: { mode: "pianificato", operator: {}, actual: { mixture_l: "", products: {} }, declarations: {}, validation: {} },
  dossier: null,
  log: [],
});

const subs = new Set();
export const P = { state: blank() };

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* memoria non disponibile: lo stato resta in pagina */ } }

function persist() {
  if (!P.state.key) return;
  const { zoning, recipes, match, recs, dossier, ...keep } = P.state;      // i risultati calcolati si rigenerano
  lsSet("um_pipe_" + P.state.key, JSON.stringify(keep));
}

export function open(key) {
  const saved = lsGet("um_pipe_" + key);
  let s = blank();
  if (saved) { try { s = { ...s, ...JSON.parse(saved), zoning: null, recipes: null, match: null, recs: null, dossier: null }; } catch { /* stato illeggibile: riparto */ } }
  s.key = key;
  P.state = s;
  emit("open");
}

export function on(fn) { subs.add(fn); return () => subs.delete(fn); }
function emit(reason) { persist(); subs.forEach((f) => f(reason)); }

export function set(patch, reason = "set") { Object.assign(P.state, patch); emit(reason); }

const stamp = () => new Date().toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
export function log(what, detail = "") {
  P.state.log = [...P.state.log, { t: stamp(), what, detail }].slice(-200);
  persist();
}

// ---- invalidazioni: chi dipende da cosa ----
// prodotti/opzioni → ricettari → (scelta) → compatibilità → proposte ARAG → validazione del documento
export function invalidateValidation(why) {
  if (P.state.doc.validation && P.state.doc.validation.confirm) {
    P.state.doc = { ...P.state.doc, validation: {} };
    log("Validazione annullata", why);
  }
}
export function invalidateFrom(stage, why) {
  const s = P.state;
  if (stage === "recipes") { s.recipes = null; }
  if (stage === "recipes" || stage === "select") { s.match = null; s.recs = null; s.aragSeen = false; }
  if (stage === "hardware") { s.match = null; s.recs = null; s.aragSeen = false; }
  s.dossier = null;
  invalidateValidation(why);
  emit("invalidate:" + stage);
}

export function selectedRecipe() {
  const s = P.state;
  return s.recipes && s.recipes.recipes ? s.recipes.recipes.find((r) => r.id === s.recipeId) || null : null;
}

export function recipeRates() {
  const r = selectedRecipe();
  if (!r) return null;
  const out = {};
  r.zones.forEach((z) => { if (z.volume > 0) out[z.i] = z.volume; });
  return out;
}

// ---- stato delle fasi: done / current / todo / warn / blocked / skip ----
export function phaseStatus() {
  const s = P.state, rec = selectedRecipe();
  const st = {};
  st[1] = s.zoning ? "done" : "todo";
  st[2] = s.recipes ? (s.recipes.recipes.every((r) => r.complete) ? "done" : "warn") : "todo";
  st[3] = rec ? "done" : "todo";
  st[4] = !rec ? "todo" : !s.match ? "todo" : s.match.level === "insufficiente" ? "blocked" : s.match.level === "parziale" ? "warn" : "done";
  const needArag = s.match && (s.match.level !== "adeguata" || (s.recs && s.recs.recommendations.length));
  st[5] = !s.match ? "todo" : needArag ? (s.aragSeen ? "done" : "warn") : "skip";
  const ds = s.dossier && s.dossier.status;
  st[6] = !ds ? "todo" : ds === "validato" ? "done" : ds === "da_verificare" ? "warn" : "todo";
  return st;
}

// fase raggiungibile se le precedenti obbligatorie sono pronte
export function reachable(n) {
  const s = P.state;
  if (n <= 1) return true;
  if (!s.zoning) return false;
  if (n === 2) return true;
  if (n === 3) return !!s.recipes;
  if (n === 4 || n === 5) return !!selectedRecipe();
  if (n === 6) return !!selectedRecipe();
  return false;
}

// stato complessivo del trattamento, per il riepilogo sempre visibile
export function overall() {
  const s = P.state;
  if (!selectedRecipe()) return { key: "draft", label: "In preparazione", tone: "info" };
  if (s.match && s.match.level === "insufficiente") return { key: "blocked", label: "Non eseguibile con l'attrezzatura attuale", tone: "error" };
  const ds = s.dossier && s.dossier.status;
  if (ds === "validato") return { key: "validated", label: "Validato dal tecnico", tone: "success" };
  if (ds === "da_verificare") return { key: "verify", label: "Da verificare e validare", tone: "warning" };
  if (s.match) return { key: "docs", label: "Documentazione da completare", tone: "warning" };
  return { key: "hw", label: "Verifica dell'hardware da fare", tone: "info" };
}
