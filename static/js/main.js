// Stilla · coordinamento della pipeline:
// mappa e zone → tre ricettari → scelta → hardware → componenti ARAG → documentazione.

import { $, $$, esc, fmt, debounce, toast, STATUS, STATUS_BY_KEY } from "./util.js";
import { api } from "./api.js";
import { FieldMap } from "./map.js";
import { HwPanel, PRESETS, presetConfig } from "./hw.js";
import { colorsFor, legendHtml, renderVerdict, renderKpis, renderChangebar, describeChange, renderDetail, renderZones, renderNozzles, renderHow } from "./ui.js";
import { renderWeather, openShare } from "./extras.js";
import { P, PHASES, open as openPipeline, on as onPipeline, log, invalidateValidation, selectedRecipe, recipeRates, reachable, phaseStatus } from "./pipeline.js";
import { renderStepper, renderProcess, renderBar } from "./process.js";
import { renderFieldPhase, loadZoning } from "./zones.js";
import { initProducts, generate as generateRecipes, renderRecipes, paintRecipes, renderSelect, recipeTask } from "./recipes.js";
import { refreshMatch, refreshRecs, renderMatch, renderArag } from "./arag.js";
import { renderDocs, refreshDossier, paintStatus } from "./docs.js";
import { renderGallery } from "./demo.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const state = {
  summary: null, geometry: null, origin: null, taskIndex: 0,
  cfg: null, applied: null, burst: null, ref: null, refLocked: false,
  result: null, view: "hw", selected: null, detail: null, tab: "zones",
  seq: 0, ctl: null, hw: null, map: null, catalog: null, exported: false,
};

// operazione del file; dalla fase 4 in poi i «ratei richiesti» sono i volumi del ricettario scelto
const fileTask = () => state.summary.tasks[state.taskIndex];
const task = () => { const r = selectedRecipe(); return r ? recipeTask(fileTask(), r) : fileTask(); };

// contesto passato ai moduli delle fasi: niente variabili globali condivise
const ctx = {
  task: fileTask, taskIndex: () => state.taskIndex, summary: () => state.summary, geometry: () => state.geometry,
  origin: () => state.origin, cfg: () => state.cfg, go: (n) => goPhase(n),
  applyConfig: (cfg) => { state.hw.write(cfg); onHwChange(state.hw.get()); },
};

// ------------------------------------------------------------------ memoria locale (comodità, facoltativa)
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* non disponibile */ } }

// ------------------------------------------------------------------ fasi
function goPhase(n) {
  if (!state.summary || !reachable(n)) return;
  P.state.phase = n;
  PHASES.forEach((p) => { $(`#phase-${p.n}`).hidden = p.n !== n; });
  if (n === 1) renderFieldPhase(ctx);
  if (n === 2) renderRecipes(ctx);
  if (n === 3) renderSelect(ctx);
  if (n === 4) { setupTask(); evaluate(); renderMatch(ctx); if (!P.state.match) refreshMatch(ctx); }
  if (n === 5) renderArag(ctx);
  if (n === 6) { paintExportBar(); renderDocs(ctx); }
  renderStepper(goPhase);
  renderProcess();
  updateBar();
  window.scrollTo(0, 0);
  const head = $(`#phase-${n} .phase-head h2`);
  if (head) { head.setAttribute("tabindex", "-1"); head.focus({ preventScroll: true }); }
}

function updateBar() {
  const n = P.state.phase, s = P.state, rec = selectedRecipe(), st = phaseStatus();
  if (!state.summary) return;
  const z = s.zoning;
  if (n === 1) renderBar({ title: z ? `${z.groups.filter((g) => g.cls !== "esclusa").length} classi di intervento · variabilità ${z.stats.level || "—"}` : "Analizzo il campo…",
    sub: z && z.stats.treated ? `Ratei ${fmt(z.stats.rate_min, 0)}–${fmt(z.stats.rate_max, 0)} L/ha · CV ${fmt(z.stats.cv_pct, 0)} %` : "",
    next: { label: "Avanti: ricettari", disabled: !z || !z.stats.treated, onClick: () => goPhase(2) } });
  if (n === 2) renderBar({ title: s.recipes ? (rec ? `Scelto: ${rec.letter} · ${rec.title}` : "Confronta e scegli un ricettario") : "Calcolo i ricettari…",
    sub: s.recipes && !s.recipes.recipes.every((r) => r.complete) ? "Completa i dati di etichetta per calcolare dosi e quantità." : "",
    back: { label: "Mappa", onClick: () => goPhase(1) },
    next: { label: rec ? "Rivedi la scelta" : "Scegli un ricettario", disabled: !rec, onClick: () => goPhase(3) } });
  if (n === 3) renderBar({ title: rec ? `Ricettario ${rec.letter} · ${rec.title}` : "Nessun ricettario scelto", sub: "La scelta non autorizza l'esecuzione: segue la verifica dell'hardware.",
    back: { label: "Cambia ricettario", onClick: () => goPhase(2) },
    next: { label: "Conferma e verifica l'hardware", disabled: !rec, onClick: () => { log("Ricettario confermato", rec ? `${rec.letter} · ${rec.title}` : ""); goPhase(4); } } });
  if (n === 4) {
    const m = s.match, needArag = st[5] !== "skip";
    renderBar({ title: m ? `Compatibilità ${m.level}` : "Confronto il ricettario con l'hardware…", sub: m ? m.text : "",
      back: { label: "Ricettario", onClick: () => goPhase(3) },
      next: { label: needArag ? "Avanti: componenti ARAG" : "Avanti: documenti", disabled: !m, onClick: () => goPhase(needArag ? 5 : 6) } });
  }
  if (n === 5) renderBar({ title: "Componentistica ARAG", sub: s.recs ? `${s.recs.recommendations.length} proposte calcolate` : "",
    back: { label: "Hardware", onClick: () => goPhase(4) }, next: { label: "Avanti: documenti", onClick: () => goPhase(6) } });
  if (n === 6) {
    const d = s.dossier;
    renderBar({ title: d ? `Documento: ${d.status_label}` : "Compilo il documento…", sub: d && d.missing.length ? `${d.missing.length} dati obbligatori mancanti` : (d ? "Dati obbligatori completi" : ""),
      back: { label: st[5] === "skip" ? "Hardware" : "Componenti ARAG", onClick: () => goPhase(st[5] === "skip" ? 4 : 5) } });
  }
}

// ogni aggiornamento dello stato condiviso ridisegna solo ciò che dipende da lui
onPipeline((reason) => {
  if (!state.summary) return;
  const n = P.state.phase;
  renderStepper(goPhase);
  renderProcess();
  updateBar();
  if (reason === "recipes") { if (n === 2) paintRecipes(ctx); if (n === 3) renderSelect(ctx); }
  if (reason === "invalidate:select" || reason === "invalidate:recipes") { if (n === 4) { setupTask(); evaluate(); } refreshMatch(ctx); }
  if (reason === "match" || reason === "recs") { if (n === 4) renderMatch(ctx); if (n === 5 && reason === "recs") renderArag(ctx); if (n === 6 && reason === "match") refreshDossier(ctx); }
  if (reason === "dossier" && n === 6) paintStatus();
});

async function openTask() {
  const t = fileTask();
  state.pipeCfg = clone(state.cfg);
  openPipeline(`${state.summary.filename}#${state.taskIndex}`);
  initProducts(t, state.summary);
  try { await loadZoning(ctx); } catch { /* la fase 1 mostra l'errore */ }
  const want = P.state.phase || 1;
  if (P.state.recipeId || want >= 2) await generateRecipes(ctx);
  if (P.state.recipeId && !selectedRecipe()) { P.state.recipeId = ""; P.state.selection = null; }
  goPhase(reachable(want) ? want : 1);
  if (selectedRecipe()) refreshMatch(ctx);
}

// ------------------------------------------------------------------ avvio
async function init() {
  try {
    state.catalog = await api.catalog();
  } catch {
    $("#landing").hidden = false;
    $("#landing-err").hidden = false;
    $("#landing-err").textContent = "Non riesco a leggere il catalogo hardware. Ricarica la pagina.";
    return;
  }
  state.map = new FieldMap($("#map"), { hover: onMapHover, click: onMapClick });
  state.hw = new HwPanel(state.catalog, onHwChange);

  const saved = lsGet("um_cfg");
  let cfg = presetConfig("full1");
  if (saved) { try { cfg = { ...cfg, ...JSON.parse(saved) }; } catch { /* uso il preset */ } }
  state.cfg = cfg;
  state.hw.write(cfg);
  fillPresets();
  wire();
  renderHow();
  let restored = false;
  try {
    const s = await api.session();
    if (s.loaded) { enter(s); restored = true; }
    else {
      const r = await api.restore();                 // server ripartito (online): ricarico l'ultimo esempio o campo dimostrativo
      if (r) { enter(r); restored = true; }
    }
  } catch { /* nessuna sessione precedente */ }
  if (!restored) $("#landing").hidden = false;
  document.body.dataset.ready = "1";
  try {
    const ex = await api.examples();
    $("#examples").innerHTML = ex.examples.map((e) => `<button class="ex" type="button" data-id="${esc(e.id)}"><b>${esc(e.title)}</b><span>${esc(e.description)}</span></button>`).join("");
    $$(".ex").forEach((b) => b.addEventListener("click", () => loadExample(b.dataset.id)));
  } catch { /* gli esempi sono facoltativi */ }
  renderGallery((r) => enter(r));
  renderStepper(goPhase);
}

const CHAIN_KEYS = ["terminal", "rate_control", "ecu", "actuator", "flowmeter", "valve", "pump"];
function matchPreset(cfg) {
  const p = PRESETS.find((x) => CHAIN_KEYS.every((k) => (x.cfg[k] || "") === (cfg[k] || "")) && same(x.cfg.nozzles, cfg.nozzles));
  return p ? p.id : "__custom";
}

function fillPresets() {
  const sel = $("#preset");
  sel.innerHTML = '<option value="__custom">Personalizzata (come l\'hai impostata)</option>' +
    PRESETS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("");
  sel.value = matchPreset(state.cfg);
  sel.addEventListener("change", () => {
    if (sel.value === "__custom") return;
    const cfg = { ...state.cfg, ...presetConfig(sel.value) };
    state.hw.write(cfg);
    onHwChange(state.hw.get());
  });
}

function wire() {
  const file = $("#file"), drop = $("#drop");
  file.addEventListener("change", () => { if (file.files[0]) uploadFile(file.files[0]); file.value = ""; });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) uploadFile(f); });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  $("#btn-newfile").addEventListener("click", () => { $("#workspace").hidden = true; $("#landing").hidden = false; renderStepper(goPhase); window.scrollTo(0, 0); });
  $("#btn-share").addEventListener("click", openShare);
  $("#btn-jump").addEventListener("click", () => $("#hw").scrollIntoView({ behavior: "smooth", block: "start" }));
  $("#share-close").addEventListener("click", () => $("#share-dlg").close());
  $("#task-sel").addEventListener("change", (e) => { state.taskIndex = Number(e.target.value); state.selected = null; state.detail = null; state.ref = null; state.refLocked = false; state.applied = null; openTask(); });

  $$("#views button").forEach((b) => b.addEventListener("click", () => { if (!b.disabled) setView(b.dataset.v); }));
  $$("#tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.t)));
  $("#btn-export").addEventListener("click", doExport);
  $("#btn-report").addEventListener("click", doReport);
  $("#changebar").addEventListener("click", (e) => {
    if (e.target.id === "cb-diff") setView("diff");
    if (e.target.id === "cb-lock") { state.refLocked = !state.refLocked; if (!state.refLocked && state.applied && state.ref) { /* il riferimento torna a scorrere */ } evaluate(); }
  });
  $("#tab-zones").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-i]");
    if (tr) select(Number(tr.dataset.i));
  });
}

// ------------------------------------------------------------------ caricamento file
async function uploadFile(f) {
  const err = $("#landing-err");
  err.hidden = true;
  if (/\.(geo)?json$/i.test(f.name)) return geoSetup(f);
  if (/\.zip$/i.test(f.name)) {                      // può essere ISOXML o uno shapefile: decide il server
    try { const r = await api.upload(f); if (r.vector) return geoSetup(f, r.vector); enter(r); }
    catch (e) { err.hidden = false; err.innerHTML = `<b>Non riesco a leggere questo file</b>${esc(e.message)}`; }
    return;
  }
  $("#drop").classList.add("busy");
  try {
    const r = await api.upload(f);
    enter(r);
  } catch (e) {
    err.hidden = false;
    err.innerHTML = `<b>Non riesco a leggere questo file</b>${esc(e.message)}`;
  } finally {
    $("#drop").classList.remove("busy");
  }
}

// mappa indice GeoJSON: il tecnico sceglie proprietà, classi e regola dei volumi, poi diventa una prescrizione ISOXML
async function geoSetup(f, pre = null) {
  const box = $("#geo-setup"), err = $("#landing-err");
  box.hidden = false;
  box.innerHTML = '<p class="mut"><span class="spin"></span> Leggo la mappa indice…</p>';
  let info = pre;
  try { if (!info) info = await api.geojsonInspect(f); } catch (e) { box.hidden = true; err.hidden = false; err.innerHTML = `<b>Non riesco a leggere questa mappa</b>${esc(e.message)}`; return; }
  if (!info.properties.length) { box.hidden = true; err.hidden = false; err.innerHTML = "<b>Nessun valore numerico</b>Il GeoJSON non ha una proprietà numerica (es. NDVI) da usare per le zone."; return; }
  box.innerHTML = `<header><h2>Dalla mappa indice alla prescrizione</h2><span class="badge blue">${info.features} poligoni</span></header>
    <p class="mut">«${esc(f.name)}»${info.boundary ? " · confine del campo presente" : " · nessun confine: verrà stimato con l'inviluppo dei poligoni"}. I volumi li decidi tu: l'app non li ricava da un modello agronomico.</p>
    <div class="row3"><div><label class="f" for="g-prop">Indice da usare</label><select id="g-prop">${info.properties.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} (${fmt(p.min, 2)}–${fmt(p.max, 2)})</option>`).join("")}</select></div>
      <div><label class="f" for="g-k">Numero di zone</label><select id="g-k">${[2, 3, 4, 5, 6].map((k) => `<option ${k === 3 ? "selected" : ""}>${k}</option>`).join("")}</select></div>
      <div><label class="f" for="g-dir">Indice alto significa</label><select id="g-dir"><option value="up">più volume</option><option value="down">meno volume</option></select></div></div>
    <div class="row3"><div><label class="f" for="g-lo">Volume per l'indice più basso (L/ha)</label><input id="g-lo" type="number" min="1" step="1" placeholder="es. 150"></div>
      <div><label class="f" for="g-hi">Volume per l'indice più alto (L/ha)</label><input id="g-hi" type="number" min="1" step="1" placeholder="es. 300"></div>
      <div><label class="f" for="g-crop">Coltura</label><input id="g-crop" type="text" placeholder="facoltativa"></div></div>
    <div class="actions gap-top"><button class="btn primary" type="button" id="g-go">Crea la mappa operativa</button><button class="btn ghost" type="button" id="g-cancel">Annulla</button></div>`;
  $("#g-cancel").addEventListener("click", () => { box.hidden = true; });
  $("#g-go").addEventListener("click", async () => {
    const params = { property: $("#g-prop").value, classes: Number($("#g-k").value), direction: $("#g-dir").value,
      vol_low: $("#g-lo").value, vol_high: $("#g-hi").value, crop: $("#g-crop").value, field_name: f.name.replace(/\.[^.]+$/, "") };
    err.hidden = true;
    try { const r = await api.geojsonLoad(f, params); box.hidden = true; enter(r); }
    catch (e) { err.hidden = false; err.innerHTML = `<b>Conversione non riuscita</b>${esc(e.message)}`; }
  });
}

async function loadExample(id) {
  try {
    const r = await api.example(id);
    enter(r);
  } catch (e) {
    toast(e.message, true);
  }
}

function enter(payload) {
  state.summary = payload.summary;
  state.geometry = payload.geometry;
  state.origin = payload.origin || null;
  $("#demo-flag").hidden = !(state.origin && state.origin.demo);
  state.taskIndex = 0;
  state.selected = null; state.detail = null; state.result = null;
  state.ref = null; state.refLocked = false; state.applied = null; state.burst = null; state.exported = false;
  const s = state.summary;
  $("#fb-name").textContent = s.filename;
  const meta = [s.manufacturer, s.software_version].filter(Boolean).join(" ");
  $("#fb-meta").textContent = `${meta ? meta + " · " : ""}ISO 11783-10${s.version ? " v" + s.version : ""} · ${s.tasks.length} ${s.tasks.length === 1 ? "operazione" : "operazioni"}${s.total_area_ha ? " · " + fmt(s.total_area_ha, 1) + " ha" : ""}`;
  const sel = $("#task-sel");
  sel.hidden = s.tasks.length < 2;
  sel.innerHTML = s.tasks.map((t, i) => `<option value="${i}">${esc(t.name)}${t.field_name ? " · " + esc(t.field_name) : ""}</option>`).join("");
  const warns = [...(s.warnings || [])];
  $("#landing").hidden = true;
  $("#workspace").hidden = false;
  $("#fb-warn").innerHTML = "";
  if (payload.example && payload.example.suggested_config) {
    state.cfg = { ...state.cfg, ...payload.example.suggested_config };
    state.hw.write(state.cfg);
  }
  state.warns = warns;
  setupTask(warns);
  openTask();
}

function setupTask(extraWarns = state.warns || []) {
  const t = task();
  const notes = [...extraWarns, ...(t.notes || [])];
  if (t.extra_rate_vars) notes.push(`Il file contiene ${t.extra_rate_vars} altre variabili di rateo oltre alla principale: le leggo e le riscrivo senza toccarle.`);
  $("#fb-warn").innerHTML = notes.length ? `<div class="alert amber" style="margin-top:12px"><b>Cosa ho notato nel file</b><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : "";
  state.map.setData(state.geometry, t.index);
  const hasGeo = state.map.hasGeometry();
  const msg = $("#mapmsg");
  if (!hasGeo) { msg.hidden = false; msg.textContent = "Il file non contiene la geometria del campo: la mappa non si può disegnare, ma i calcoli per zona valgono lo stesso."; }
  else if (!state.map.hasCells() && t.classes.length > 1) { msg.hidden = false; msg.textContent = "Il file non dice dove si applicano le zone: guarda la tabella qui sotto."; msg.style.alignItems = "end"; }
  else msg.hidden = true;
  state.map.setColors(colorsFor(state.view === "diff" ? "hw" : state.view, state.result, t));
  $("#legend").innerHTML = legendHtml("rx", t, null);
  renderDetail(null, null, t, null);
}

// ------------------------------------------------------------------ hardware → valutazione
const commit = debounce(() => {
  if (!state.refLocked && state.burst && !same(state.burst, state.cfg)) state.ref = state.burst;
  state.burst = null;
  evaluate();
  pipelineHw();
}, 220);

// a valle: compatibilità, proposte ARAG e validazione dipendono dall'hardware.
// Confronto con l'ultima configurazione usata dalla pipeline (non con l'ultima valutata: le due corrono in parallelo).
function pipelineHw() {
  const prev = state.pipeCfg;
  if (!prev || same(prev, state.cfg)) return;
  state.pipeCfg = clone(state.cfg);
  const ch = describeChange(prev, state.cfg, state.hw.byCode);
  if (ch.length) log("Hardware modificato", ch.join(" · "));
  invalidateValidation("l'hardware è cambiato");
  if (selectedRecipe()) refreshMatch(ctx);
  if (P.state.recipes) generateRecipes(ctx);
}

function onHwChange(cfg) {
  state.cfg = cfg;
  lsSet("um_cfg", JSON.stringify(cfg));
  $("#preset").value = matchPreset(cfg);
  if (!state.summary) return;
  if (!state.burst && state.applied) state.burst = clone(state.applied);
  $("#kpis").classList.add("busy");
  commit();
}

async function evaluate() {
  if (!state.summary) return;
  const seq = ++state.seq;
  if (state.ctl) state.ctl.abort();
  const ctl = (state.ctl = new AbortController());
  const cfg = clone(state.cfg);
  const body = { task: state.taskIndex, config: cfg, suggest: state.tab === "nozzles", detail: state.selected, rates: recipeRates() };
  if (state.ref) body.reference = state.ref;
  $("#kpis").classList.add("busy");
  try {
    const r = await api.evaluate(body, ctl.signal);
    if (seq !== state.seq) return;
    r.tolerance = cfg.tolerance_pct;
    state.result = r;
    state.applied = cfg;
    if (r.detail) state.detail = r.detail;
    paint();
  } catch (e) {
    if (e.name === "AbortError" || seq !== state.seq) return;
    $("#verdict").className = "verdict bad";
    $("#verdict").innerHTML = `<div><h2>Non riesco a calcolare</h2><p>${esc(e.message)}</p></div>`;
    $("#kpis").classList.remove("busy");
  }
}

function paint() {
  const r = state.result, t = task();
  $("#kpis").classList.remove("busy");
  state.hw.showAlerts(r.chain);
  const diffBtn = $('#views button[data-v="diff"]');
  diffBtn.disabled = !r.reference;
  if (!r.reference && state.view === "diff") state.view = "hw";
  renderVerdict(r, t);
  renderKpis(r, t);
  renderChangebar(r, t, state.ref ? describeChange(state.ref, state.cfg, state.hw.byCode) : [], state.refLocked);
  paintMap();
  renderZones(r, t, state.selected);
  renderNozzles(r, t, applyNozzles);
  renderDetail(state.selected, r, t, state.detail);
  paintExportBar();
}

function paintMap() {
  const r = state.result, t = task();
  $$("#views button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === state.view)));
  state.map.setColors(colorsFor(state.view, r, t));
  state.map.setSelected(state.selected);
  $("#legend").innerHTML = legendHtml(state.view, t, r);
}

function setView(v) {
  state.view = v;
  if (state.result) paintMap();
}

function setTab(name) {
  state.tab = name;
  $$("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.t === name)));
  for (const n of ["zones", "nozzles", "weather", "how"]) $(`#tab-${n}`).hidden = n !== name;
  if (name === "nozzles" && state.result && !state.result.suggestions && !state.result.chain.blockers.length) evaluate();
  if (name === "weather") renderWeather(state.geometry, state.result ? state.result.kpi.fines_avg_pct : null);
}

function applyNozzles(list) {
  const cfg = state.hw.get();
  cfg.nozzles = list;
  state.hw.write(cfg);
  onHwChange(state.hw.get());
  toast(`Ugelli: ${list.join(" + ")}. Guarda come cambia la mappa.`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ------------------------------------------------------------------ selezione zona e tooltip
async function select(k) {
  state.selected = state.selected === k ? null : k;
  state.map.setSelected(state.selected);
  if (state.result) renderZones(state.result, task(), state.selected);
  if (state.selected === null) { state.detail = null; renderDetail(null, state.result, task(), null); return; }
  renderDetail(state.selected, state.result, task(), null);
  try {
    const r = await api.evaluate({ task: state.taskIndex, config: state.cfg, detail: state.selected, rates: recipeRates() });
    if (r.detail && r.detail.i === state.selected) { state.detail = r.detail; renderDetail(state.selected, state.result, task(), r.detail); }
  } catch { /* il dettaglio è un di più */ }
}

function onMapClick(k) { if (k !== null && state.result) select(k); }

function onMapHover(k, e) {
  const tip = $("#tip");
  const r = state.result;
  if (k === null || !r || !e) { tip.hidden = true; return; }
  const c = task().classes[k], st = STATUS[r.plans.s[k]] || STATUS.n;
  const rate = c.rate && c.rate > 0;
  const after = STATUS[r.specialisation.s_after[k]] || STATUS.n;
  tip.innerHTML = `<b>${esc(c.label)}</b>${rate ? `Richiesti ${fmt(c.rate, 0)} L/ha` : "Non trattare"}<br>${rate ? `Sul tuo hardware: ${esc(st.name.toLowerCase())}${r.plans.delivered[k] !== null ? ` · erogati ${fmt(r.plans.delivered[k], 0)} L/ha` : ""}` : ""}${r.specialisation.new_rate[k] ? `<br>Nel file specializzato: ${fmt(r.specialisation.new_rate[k], 0)} L/ha · ${esc(after.name.toLowerCase())}` : ""}`;
  const wrap = $("#map").parentElement.getBoundingClientRect();
  tip.hidden = false;
  let x = e.clientX - wrap.left + 14, y = e.clientY - wrap.top + 14;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  if (x + tw > wrap.width - 6) x = e.clientX - wrap.left - tw - 14;
  if (y + th > wrap.height - 6) y = e.clientY - wrap.top - th - 14;
  tip.style.left = Math.max(4, x) + "px"; tip.style.top = Math.max(4, y) + "px";
}

// ------------------------------------------------------------------ esportazione
function paintExportBar() {
  if (!state.result) return;
  const r = state.result, sp = r.specialisation, ag = sp.agronomic;
  const multi = state.summary.tasks.length > 1;
  const blocked = r.chain.blockers.length > 0;
  $("#btn-export").disabled = blocked;
  let title, sub;
  if (blocked) {
    title = "Completa l'hardware per poter scaricare";
    sub = r.chain.blockers[0];
  } else if (sp.n_changed === 0) {
    title = "Questo hardware esegue già tutta la prescrizione";
    sub = "Il file verrà scaricato con i ratei originali e con una nota che indica l'hardware di riferimento.";
  } else {
    title = `${sp.n_changed} ${sp.n_changed === 1 ? "classe riscritta" : "classi riscritte"} per il tuo hardware · ${sp.strategy === "uniform" ? "rateo unico" : "ratei variabili"}`;
    sub = `Trattato bene ${fmt(r.kpi.on_target_pct, 0)} % → ${fmt(sp.kpi_after.on_target_pct, 0)} %` +
      (ag.volume_delta_pct !== undefined ? ` · miscela totale ${ag.volume_delta_pct > 0 ? "+" : ""}${fmt(ag.volume_delta_pct, 1)} % (${fmt(ag.volume_original_l, 0)} → ${fmt(ag.volume_specialised_l, 0)} L)` : "") +
      (multi ? " · vale per tutte le operazioni del file" : "");
  }
  $("#ex-title").textContent = title;
  $("#ex-sub").textContent = sub;
  // i volumi del ricettario diversi dal file riscrivono anch'essi il TASKDATA: serve la conferma
  const rr = recipeRates();
  const differs = !!rr && fileTask().classes.some((c) => c.rate > 0 && rr[c.i] !== undefined && Math.abs(rr[c.i] - c.rate) > 0.005);
  if (differs && !blocked) {
    const rec = selectedRecipe();
    if (sp.n_changed === 0) title = `File con i volumi del ricettario ${rec.letter} · ${rec.title}`;
    sub = `${sp.n_changed === 0 ? "L'hardware esegue questi volumi." : sub} I volumi del ricettario scelto sostituiscono quelli della prescrizione originale: controllali prima di scaricare.`;
  }
  $("#ex-title").textContent = title;
  $("#ex-sub").textContent = sub;
  const need = sp.n_changed > 0 || multi || differs;
  $("#ex-approve-wrap").hidden = !need || blocked;
}

async function doExport() {
  const cb = $("#ex-approve");
  const wrap = $("#ex-approve-wrap");
  if (!wrap.hidden && !cb.checked) {
    wrap.animate([{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(0)" }], { duration: 260 });
    toast("Controlla i ratei che cambiano e spunta la conferma.", true);
    return;
  }
  const btn = $("#btn-export");
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Preparo il file…';
  try {
    const { blob, name, summary } = await api.exportFile({ task: state.taskIndex, config: state.cfg, approve: cb.checked || wrap.hidden, rates: recipeRates() });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    state.exported = true;
    log("File ISOXML per il terminale scaricato", name);
    const n = summary ? summary.changed_classes : 0;
    $("#ex-title").textContent = `Scaricato: ${name}`;
    $("#ex-sub").textContent = `Riletto dal server prima dell'invio: ${n} ${n === 1 ? "classe riscritta" : "classi riscritte"}, ratei verificati.`;
    toast("File scaricato e verificato.");
  } catch (e) {
    if (/conferma/i.test(e.message)) { wrap.hidden = false; }
    toast(e.message, true, 7000);
  } finally {
    btn.innerHTML = label;
    btn.disabled = state.result ? state.result.chain.blockers.length > 0 : false;
  }
}

async function doReport() {
  const w = window.open("", "_blank");
  try {
    const html = await api.report({ task: state.taskIndex, config: state.cfg, rates: recipeRates() });
    if (w) { w.document.open(); w.document.write(html); w.document.close(); }
    else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      a.download = "piano_di_lavoro.html"; a.click();
    }
  } catch (e) {
    if (w) w.close();
    toast(e.message, true);
  }
}

init();
