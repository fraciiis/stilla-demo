// Fase 6 · documentazione compilata dalle fasi precedenti, con stato esplicito e validazione del tecnico.

import { $, esc, fmt, debounce, toast } from "./util.js";
import { api } from "./api.js";
import { FieldMap } from "./map.js";
import { colorsFor } from "./ui.js";
import { recipeTask } from "./recipes.js";
import { P, set, log, selectedRecipe } from "./pipeline.js";

const DECL = {
  label_read: "Ho letto l'etichetta autorizzata di ogni prodotto e le dosi rientrano nelle condizioni d'impiego.",
  mix_ok: "La miscela è ammessa dalle etichette (o è un solo prodotto).",
  operator_license: "L'operatore è abilitato all'acquisto e all'uso dei prodotti fitosanitari (certificato valido).",
  equipment_checked: "L'irroratrice è sottoposta al controllo funzionale periodico e alla regolazione previsti.",
  weather_buffer: "Ho verificato condizioni meteo, fasce di rispetto e misure di mitigazione della deriva previste in etichetta.",
};
const STATUS = {
  bozza: ["off", "Bozza"], da_completare: ["adapt", "Da completare"], da_verificare: ["blue", "Da verificare"], validato: ["ok", "Validato"],
};

function mapPng(ctx) {
  const r = selectedRecipe();
  if (!r) return "";
  const cv = document.createElement("canvas");
  cv.width = 1100; cv.height = 680;
  const m = new FieldMap(cv, {});
  const t = recipeTask(ctx.task(), r);
  m.setData(ctx.geometry(), t.index);
  if (!m.hasGeometry()) return "";
  m.setColors(colorsFor("rx", null, t));
  // sfondo bianco per la stampa
  const out = document.createElement("canvas");
  out.width = cv.width; out.height = cv.height;
  const o = out.getContext("2d");
  o.fillStyle = "#fff"; o.fillRect(0, 0, out.width, out.height); o.drawImage(cv, 0, 0);
  return out.toDataURL("image/png");
}

function payload(ctx, withMap = false) {
  const s = P.state;
  return {
    task: ctx.taskIndex(), products: s.products, options: s.options, recipe_id: s.recipeId, config: ctx.cfg(),
    mode: s.doc.mode, operator: s.doc.operator, actual: s.doc.actual, declarations: s.doc.declarations,
    validation: s.doc.validation, selection: s.selection, log: s.log, crop: s.doc.operator.crop || "",
    map_png: withMap ? mapPng(ctx) : "",
  };
}

let dctl = null;
export async function refreshDossier(ctx) {
  if (!P.state.recipeId) { P.state.dossier = null; return; }
  if (dctl) dctl.abort();
  dctl = new AbortController();
  try {
    P.state.dossier = await api.dossier(payload(ctx), dctl.signal);
    set({}, "dossier");
  } catch (e) {
    if (e.name !== "AbortError") toast(e.message, true);
  }
}
const refreshSoon = debounce((ctx) => { refreshDossier(ctx); refreshPreview(ctx); }, 600);

async function refreshPreview(ctx) {
  const fr = $("#doc-preview");
  if (!fr || !P.state.recipeId) return;
  try {
    const { blob } = await api.dossierFile({ ...payload(ctx, true), format: "html" });
    fr.srcdoc = await blob.text();
  } catch { /* l'anteprima è un di più */ }
}

export function paintStatus() {
  const d = P.state.dossier, box = $("#doc-status");
  if (!box) return;
  if (!d) { box.innerHTML = '<p class="mut"><span class="spin"></span> Compilo il documento…</p>'; return; }
  const [cls, word] = STATUS[d.status];
  box.innerHTML = `<div class="docstate"><span class="badge ${cls} big">${word}</span><span class="mut small">generato ${esc(d.generated_at.replace("T", " "))} · modalità ${esc(d.mode)}</span></div>
    ${d.demo && d.demo.length ? `<div class="alert demo"><b>Documento dimostrativo</b>Contiene dati simulati: ${esc(d.demo.join(", "))}. Mostra il funzionamento, non vale per un trattamento reale.</div>` : ""}
    ${d.efficacy && d.efficacy.recipe !== null ? `<p class="small">Efficacia attesa (simulata): <b>${fmt(d.efficacy.recipe, 0)} %</b> sul ricettario · <b>${d.efficacy.on_hardware === null ? "—" : fmt(d.efficacy.on_hardware, 0) + " %"}</b> con l'attrezzatura scelta.</p>` : ""}
    ${d.missing.length ? `<div class="alert red"><b>Dati obbligatori mancanti (${d.missing.length})</b><ul>${d.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>` : ""}
    ${d.to_validate.length ? `<div class="alert amber"><b>Prima della validazione</b><ul>${d.to_validate.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>` : ""}
    ${d.status === "validato" ? `<div class="alert"><b>Validato da ${esc(d.validation.name)} · ${esc(d.validation.at)}</b>È la conferma del tecnico sui dati: non attesta la conformità normativa.</div>` : ""}
    <h3 class="sub-h">Verifiche eseguite dall'app</h3>
    <ul class="checklist">${d.checks.map((c) => `<li class="${c.status === "ok" ? "ok" : c.status === "fail" ? "fail" : "todo"}">${esc(c.text)}</li>`).join("") || '<li class="todo">Nessuna verifica ancora disponibile.</li>'}</ul>`;
  const vb = $("#doc-validate");
  if (vb) {
    const ready = d.status === "da_verificare" && Object.keys(DECL).every((k) => P.state.doc.declarations[k]) && (P.state.doc.validation.name || "").trim() && P.state.match && P.state.match.level !== "insufficiente";
    vb.disabled = !ready;
    vb.textContent = d.status === "validato" ? "Validato ✓" : "Valida il documento";
  }
}

export function renderDocs(ctx) {
  const box = $("#docs-dyn");
  const s = P.state, r = selectedRecipe();
  const o = s.doc.operator, a = s.doc.actual;
  if (!r) { box.innerHTML = '<div class="card"><p>Scegli prima un ricettario (fasi 2 e 3).</p></div>'; return; }
  const inp = (k, label, type = "text", ph = "") => `<div><label class="f" for="op-${k}">${label}</label><input id="op-${k}" data-op="${k}" type="${type}" value="${esc(o[k] || "")}" placeholder="${esc(ph)}"></div>`;
  box.innerHTML = `
    <div class="grid-2">
      <div class="card"><header><h2>Stato del documento</h2></header><div id="doc-status"></div></div>
      <div class="card"><header><h2>Dati dell'operatore</h2>
        <div class="seg" role="group" aria-label="Tipo di documento"><button type="button" data-mode="pianificato" aria-pressed="${s.doc.mode !== "eseguito"}">Pianificato</button><button type="button" data-mode="eseguito" aria-pressed="${s.doc.mode === "eseguito"}">Eseguito</button></div></header>
        <div class="row2">${inp("name", "Operatore")}${inp("company", "Azienda")}</div>
        <div class="row2">${inp("license_no", "Certificato di abilitazione (n.)")}${inp("target", "Avversità / infestante bersaglio", "text", s.options.objective || "")}</div>
        <div class="row2">${inp("date_planned", "Data prevista", "date")}${inp("date_done", "Data di esecuzione", "date")}</div>
        ${inp("crop", "Coltura (se il file non la indica)")}
        ${s.doc.mode === "eseguito" ? `<h3 class="sub-h">Quantità effettivamente utilizzate</h3>
          <div class="row2"><div><label class="f" for="ac-mix">Miscela distribuita (L)</label><input id="ac-mix" data-ac="mixture_l" type="number" min="0" step="any" value="${esc(a.mixture_l ?? "")}" placeholder="previsti ${r.totals.mixture_l === null ? "—" : fmt(r.totals.mixture_l, 0)}"></div>
          ${r.products.map((p, i) => `<div><label class="f" for="ac-p${i}">${esc(p.name)} (${esc(p.unit.split("/")[0])})</label><input id="ac-p${i}" data-acp="${esc(p.name)}" type="number" min="0" step="any" value="${esc((a.products || {})[p.name] ?? "")}" placeholder="previsti ${p.quantity === null ? "—" : fmt(p.quantity, 1)}"></div>`).join("")}</div>` : ""}
      </div>
    </div>
    <div class="card gap-top"><header><h2>Dichiarazioni e validazione</h2></header>
      <p class="mut small">Sono dichiarazioni dell'operatore: l'app non può verificarle e le riporta come tali nel documento.</p>
      ${Object.entries(DECL).map(([k, t]) => `<label class="check"><input type="checkbox" data-decl="${k}" ${s.doc.declarations[k] ? "checked" : ""}><span>${esc(t)}</span></label>`).join("")}
      <div class="row2 gap-top"><div><label class="f" for="val-name">Tecnico che valida</label><input id="val-name" type="text" value="${esc(s.doc.validation.name || "")}" placeholder="nome e cognome"></div>
      <div class="end"><button class="btn primary" type="button" id="doc-validate" disabled>Valida il documento</button></div></div>
      <p class="small mut">La validazione registra che il tecnico ha controllato i dati. Non è un'attestazione di conformità e si annulla se cambiano ricettario, prodotti o hardware.</p>
    </div>
    <div class="card gap-top"><header><h2>Esporta</h2></header>
      <div class="actions">
        <button class="btn primary" type="button" id="doc-print">Scheda stampabile / PDF</button>
        <button class="btn" type="button" id="doc-json">Dati strutturati (JSON)</button>
      </div>
      <p class="small mut">Il PDF si ottiene dalla finestra di stampa del browser («Salva come PDF»).</p>
    </div>
    <div class="card gap-top"><header><h2>Anteprima</h2></header><iframe id="doc-preview" title="Anteprima della scheda di trattamento" class="preview"></iframe></div>`;
  box.querySelectorAll("[data-op]").forEach((el) => el.addEventListener("input", () => { s.doc.operator = { ...s.doc.operator, [el.dataset.op]: el.value }; set({}, "doc"); refreshSoon(ctx); }));
  box.querySelectorAll("[data-ac]").forEach((el) => el.addEventListener("input", () => { s.doc.actual = { ...s.doc.actual, mixture_l: el.value }; set({}, "doc"); refreshSoon(ctx); }));
  box.querySelectorAll("[data-acp]").forEach((el) => el.addEventListener("input", () => { s.doc.actual = { ...s.doc.actual, products: { ...(s.doc.actual.products || {}), [el.dataset.acp]: el.value } }; set({}, "doc"); refreshSoon(ctx); }));
  box.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    if (s.doc.mode === b.dataset.mode) return;
    s.doc.mode = b.dataset.mode; log(`Documento: ${b.dataset.mode}`); s.doc.validation = {}; set({}, "doc"); renderDocs(ctx);
  }));
  box.querySelectorAll("[data-decl]").forEach((el) => el.addEventListener("change", () => {
    s.doc.declarations = { ...s.doc.declarations, [el.dataset.decl]: el.checked };
    log(el.checked ? "Dichiarazione confermata" : "Dichiarazione ritirata", DECL[el.dataset.decl]);
    if (!el.checked && s.doc.validation.confirm) s.doc.validation = {};
    set({}, "doc"); refreshSoon(ctx);
  }));
  $("#val-name").addEventListener("input", (e) => { s.doc.validation = { ...s.doc.validation, name: e.target.value, confirm: false }; set({}, "doc"); paintStatus(); });
  $("#doc-validate").addEventListener("click", () => {
    s.doc.validation = { name: s.doc.validation.name, confirm: true, at: new Date().toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) };
    log("Documento validato", s.doc.validation.name);
    set({}, "doc"); refreshDossier(ctx).then(() => refreshPreview(ctx));
  });
  $("#doc-print").addEventListener("click", async () => {
    const w = window.open("", "_blank");
    try {
      const { blob } = await api.dossierFile({ ...payload(ctx, true), format: "html" });
      const html = await blob.text();
      if (w) { w.document.open(); w.document.write(html); w.document.close(); setTimeout(() => { try { w.focus(); w.print(); } catch { /* stampa manuale */ } }, 400); }
      log("Scheda di trattamento esportata", "HTML/PDF");
    } catch (e) { if (w) w.close(); toast(e.message, true); }
  });
  $("#doc-json").addEventListener("click", async () => {
    try {
      const { blob, name } = await api.dossierFile({ ...payload(ctx, false), format: "json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob); link.download = name; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 4000);
      log("Dati del trattamento esportati", "JSON");
    } catch (e) { toast(e.message, true); }
  });
  paintStatus();
  refreshDossier(ctx).then(() => refreshPreview(ctx));
}
