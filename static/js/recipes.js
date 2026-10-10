// Fasi 2 e 3 · dati di etichetta → tre ricettari confrontabili → scelta tracciata del tecnico.

import { $, $$, esc, fmt, debounce, toast } from "./util.js";
import { api } from "./api.js";
import { FieldMap } from "./map.js";
import { colorsFor, legendHtml } from "./ui.js";
import { P, set, log, invalidateFrom, selectedRecipe } from "./pipeline.js";

const OFFICIAL_DB = "https://www.fitosanitari.salute.gov.it/fitosanitariws_new/";
const keyOf = (name) => name.trim().toLowerCase().replace(/\s+/g, " ");
const FIELDS = ["name", "reg_no", "source", "checked_on", "unit", "dose_min", "dose_max", "vol_min", "vol_max", "price", "phi_days", "max_treatments", "notes"];

// archivio locale dei dati di etichetta (per nome prodotto, condiviso fra i file; compatibile con la vecchia scheda Etichette)
function labelStore() { try { return JSON.parse(localStorage.getItem("um_labels") || "{}"); } catch { return {}; } }
function saveLabel(p) {
  const all = labelStore();
  all[keyOf(p.name)] = { ...(all[keyOf(p.name)] || {}), ...p, vmin: p.vol_min, vmax: p.vol_max };
  try { localStorage.setItem("um_labels", JSON.stringify(all)); } catch { /* memoria non disponibile */ }
}
function fromStore(name) {
  const d = labelStore()[keyOf(name)] || {};
  return {
    name, reg_no: d.reg_no || "", source: d.source || "", checked_on: d.checked_on || "", unit: d.unit || "L/ha",
    dose_min: d.dose_min ?? "", dose_max: d.dose_max ?? "", vol_min: d.vol_min ?? d.vmin ?? "", vol_max: d.vol_max ?? d.vmax ?? "",
    price: d.price ?? "", phi_days: d.phi_days ?? d.phi ?? "", max_treatments: d.max_treatments ?? d.maxn ?? "", notes: d.notes ?? d.note ?? "",
  };
}

export function initProducts(task, summary) {
  if (P.state.products.length) return;
  const names = task.products && task.products.length ? task.products : (summary.products || []).map((p) => p.name);
  P.state.products = names.map(fromStore);
}

const sig = (r) => (r ? JSON.stringify([r.zones.map((z) => z.volume), r.products.map((p) => [p.name, p.concentration])]) : "");

let ctl = null;
export async function generate(ctx) {
  if (ctl) ctl.abort();
  ctl = new AbortController();
  const before = sig(selectedRecipe());
  try {
    const r = await api.recipes({ task: ctx.taskIndex(), products: P.state.products, options: P.state.options, config: ctx.cfg() }, ctl.signal);
    P.state.recipes = r;
    const after = sig(selectedRecipe());
    if (P.state.recipeId && before && before !== after) {
      log("Ricettario aggiornato", "i dati di etichetta o le opzioni sono cambiati: compatibilità e documento vengono ricalcolati");
      invalidateFrom("select", "il ricettario scelto è cambiato");
      P.state.recipes = r;
    }
    set({}, "recipes");
  } catch (e) {
    if (e.name === "AbortError") return;
    P.state.recipes = null;
    set({}, "recipes");
    const box = $("#recipes-out");
    if (box) box.innerHTML = `<div class="alert red"><b>Non riesco a calcolare i ricettari</b>${esc(e.message)}</div>`;
  }
}
const regen = debounce((ctx) => generate(ctx), 450);

// ---------------------------------------------------------------- fase 2

function productCard(p, i) {
  const v = (k) => esc(p[k] ?? "");
  const num = (k, label, extra = "") => `<div><label class="f" for="p${i}-${k}">${label}</label><input id="p${i}-${k}" data-k="${k}" type="number" min="0" step="any" value="${v(k)}" ${extra}></div>`;
  return `<div class="prod" data-i="${i}">
    <div class="prod-head"><input class="pname" data-k="name" value="${v("name")}" aria-label="Nome commerciale" placeholder="Nome commerciale">
      <button class="btn sm ghost" type="button" data-rm="${i}" aria-label="Togli ${v("name") || "prodotto"}">Togli</button></div>
    <div class="row3">
      <div><label class="f" for="p${i}-reg_no">N. registrazione</label><input id="p${i}-reg_no" data-k="reg_no" type="text" value="${v("reg_no")}" placeholder="dall'etichetta"></div>
      <div><label class="f" for="p${i}-source">Fonte</label><input id="p${i}-source" data-k="source" type="text" value="${v("source")}" placeholder="etichetta autorizzata del …"></div>
      <div><label class="f" for="p${i}-checked_on">Verificata il</label><input id="p${i}-checked_on" data-k="checked_on" type="date" value="${v("checked_on")}"></div>
    </div>
    <div class="row3">
      <div><label class="f" for="p${i}-unit">Unità di dose</label><select id="p${i}-unit" data-k="unit"><option ${p.unit !== "kg/ha" ? "selected" : ""}>L/ha</option><option ${p.unit === "kg/ha" ? "selected" : ""}>kg/ha</option></select></div>
      ${num("dose_min", "Dose minima in etichetta")}${num("dose_max", "Dose massima in etichetta")}
    </div>
    <div class="row3">${num("vol_min", "Volume minimo (L/ha)")}${num("vol_max", "Volume massimo (L/ha)")}${num("price", `Prezzo (€/${p.unit === "kg/ha" ? "kg" : "L"})`)}</div>
    <details class="more"><summary>Altre indicazioni di etichetta</summary>
      <div class="row2"><div><label class="f" for="p${i}-phi_days">Intervallo di sicurezza (giorni)</label><input id="p${i}-phi_days" data-k="phi_days" type="text" value="${v("phi_days")}"></div>
      <div><label class="f" for="p${i}-max_treatments">Numero massimo di trattamenti</label><input id="p${i}-max_treatments" data-k="max_treatments" type="text" value="${v("max_treatments")}"></div></div>
      <label class="f" for="p${i}-notes">Avvertenze e note</label><input id="p${i}-notes" data-k="notes" type="text" value="${v("notes")}" placeholder="ugelli, deriva, fasce di rispetto…">
    </details></div>`;
}

const chip = (t, cls = "") => `<span class="chip ${cls}">${t}</span>`;

function recipeCard(r) {
  const chosen = P.state.recipeId === r.id;
  const fails = r.constraints.filter((c) => c.level === "fail").length, warns = r.constraints.length - fails;
  const hw = r.metrics.hardware;
  return `<article class="recipe ${chosen ? "chosen" : ""}" aria-label="Ricettario ${r.letter}">
    <header><span class="rl">${esc(r.letter)}</span><div><h3>${esc(r.title)}</h3>${chip("criterio: " + esc(r.criterion))}</div></header>
    <p>${esc(r.why)}</p>
    <dl class="facts">
      <div><dt>Volumi</dt><dd>${r.variable ? `${fmt(r.volume_range[0], 0)}–${fmt(r.volume_range[1], 0)}` : fmt(r.volume_mean, 0)} L/ha</dd></div>
      <div><dt>Miscela</dt><dd>${r.totals.mixture_l === null ? "—" : fmt(r.totals.mixture_l, 0) + " L"}</dd></div>
      ${r.products.map((p) => `<div><dt>${esc(p.name)}</dt><dd>${p.quantity === null ? "—" : `${fmt(p.quantity, 1)} ${esc(p.unit.split("/")[0])}`}</dd></div>`).join("")}
      <div><dt>Costo prodotti</dt><dd>${r.totals.cost === null ? "—" : fmt(r.totals.cost, 0) + " €"}</dd></div>
      <div><dt>Sull'hardware attuale</dt><dd>${hw ? `${fmt(hw.on_target_pct, 0)} % entro tolleranza` : "—"}</dd></div>
    </dl>
    <p class="small mut">${esc(r.tradeoff)}</p>
    ${r.differences.length ? `<ul class="diffs">${r.differences.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
    <div class="rfoot">${fails ? `<span class="badge under">non conforme · ${fails} da risolvere</span>` : ""}${warns ? `<span class="badge adapt">${warns} ${warns === 1 ? "avviso" : "avvisi"}</span>` : ""}${!fails && !warns ? '<span class="badge ok">nessun vincolo</span>' : ""}
      <button class="btn ${chosen ? "" : "primary"}" type="button" data-pick="${r.id}">${chosen ? "Scelto · vedi dettagli" : "Scegli questo ricettario"}</button></div>
  </article>`;
}

function compareTable(rs) {
  const best = (vals, low = true) => { const ok = vals.filter((v) => v !== null && v !== undefined); if (!ok.length) return null; return low ? Math.min(...ok) : Math.max(...ok); };
  const row = (label, vals, f, low = true, hint = "") => {
    const b = best(vals, low);
    return `<tr><th scope="row">${label}${hint ? `<span class="mut small"> · ${hint}</span>` : ""}</th>${vals.map((v) => `<td class="n">${v === null || v === undefined ? "—" : f(v)}${b !== null && v === b && vals.filter((x) => x === b).length < vals.length ? ' <span class="best">migliore</span>' : ""}</td>`).join("")}</tr>`;
  };
  const prodNames = rs[0].products.map((p) => p.name);
  return `<div class="tw"><table class="t cmp"><thead><tr><th></th>${rs.map((r) => `<th class="n">${esc(r.letter)} · ${esc(r.title)}</th>`).join("")}</tr></thead><tbody>
    <tr><th scope="row">Efficacia attesa</th>${rs.map(() => '<td class="n mut">non stimata</td>').join("")}</tr>
    ${row("Aderenza alla prescrizione", rs.map((r) => r.metrics.deviation_pct), (v) => `scostamento ${fmt(v, 0)} %`, true, "precisione spaziale")}
    ${row("Superficie entro le dosi di etichetta", rs.map((r) => r.metrics.within_label_pct), (v) => `${fmt(v, 0)} %`, false)}
    ${row("Miscela totale", rs.map((r) => r.totals.mixture_l), (v) => `${fmt(v, 0)} L`)}
    ${prodNames.map((n, k) => row(esc(n), rs.map((r) => r.products[k].quantity), (v) => `${fmt(v, 1)} ${esc(rs[0].products[k].unit.split("/")[0])}`)).join("")}
    ${row("Costo prodotti", rs.map((r) => r.totals.cost), (v) => `${fmt(v, 0)} €`)}
    ${row("Serbatoi da preparare", rs.map((r) => r.totals.tank_loads), (v) => fmt(v, 0), true, "impatto operativo")}
    ${row("Volumi diversi da regolare", rs.map((r) => r.metrics.distinct_rates), (v) => fmt(v, 0), true, "impatto operativo")}
    ${row("Eseguibile sull'hardware attuale", rs.map((r) => (r.metrics.hardware ? r.metrics.hardware.on_target_pct : null)), (v) => `${fmt(v, 0)} %`, false, "compatibilità")}
    <tr><th scope="row">Vincoli</th>${rs.map((r) => `<td class="n">${r.constraints.length ? `${r.constraints.length}` : "0"}</td>`).join("")}</tr>
  </tbody></table></div>
  <p class="small mut">«Migliore» confronta solo i numeri della riga: la scelta resta del tecnico. L'efficacia non è stimata perché manca un modello agronomico validato.</p>`;
}

export function renderRecipes(ctx) {
  const box = $("#phase-2");
  const s = P.state;
  box.innerHTML = `
    <div class="phase-head"><span class="eyebrow">Fase 2 di 6</span><h2>Tre ricettari per questo campo</h2>
      <p class="mut">Inserisci i dati letti sull'etichetta autorizzata: l'app non ha un archivio di prodotti e non inventa dosi. Con questi dati calcola tre proposte diverse per criterio.</p></div>
    <div class="card">
      <header><h2>Obiettivo e prodotti</h2><a class="btn sm" href="${OFFICIAL_DB}" target="_blank" rel="noopener">Banca dati fitosanitari ↗</a></header>
      <div class="row2"><div><label class="f" for="o-objective">Obiettivo del trattamento</label><input id="o-objective" type="text" value="${esc(s.options.objective)}" placeholder="es. peronospora, infestanti graminacee…"></div>
      <div><label class="f" for="o-tank">Capacità del serbatoio (L)</label><input id="o-tank" type="number" min="0" step="10" value="${esc(s.options.tank_l)}" placeholder="per contare i serbatoi"></div></div>
      <div id="prods">${s.products.map(productCard).join("")}</div>
      <button class="btn sm" type="button" id="p-add">+ Aggiungi un prodotto</button>
      <p class="small mut">I dati restano in questo browser e vengono riproposti per lo stesso prodotto. Indica sempre la fonte: finisce nel documento.</p>
    </div>
    <div id="recipes-out" class="gap-top"></div>`;
  const prods = $("#prods");
  const sync = (el) => {
    const card = el.closest(".prod"); const i = Number(card.dataset.i); const k = el.dataset.k;
    s.products[i] = { ...s.products[i], [k]: el.value };
    if (s.products[i].name) saveLabel(s.products[i]);
    set({}, "products");
    regen(ctx);
  };
  prods.addEventListener("input", (e) => { if (e.target.dataset.k) sync(e.target); });
  prods.addEventListener("change", (e) => { if (e.target.dataset.k === "unit") { sync(e.target); renderRecipes(ctx); } });
  prods.addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]"); if (!b) return;
    const p = s.products[Number(b.dataset.rm)];
    s.products.splice(Number(b.dataset.rm), 1);
    log("Prodotto tolto", p && p.name);
    set({}, "products"); renderRecipes(ctx); generate(ctx);
  });
  $("#p-add").addEventListener("click", () => {
    s.products.push(fromStore(`Prodotto ${s.products.length + 1}`));
    set({}, "products"); renderRecipes(ctx);
    const last = $$(".prod .pname").pop(); if (last) { last.select(); last.focus(); }
  });
  $("#o-objective").addEventListener("input", (e) => { s.options.objective = e.target.value; set({}, "options"); regen(ctx); });
  $("#o-tank").addEventListener("input", (e) => { s.options.tank_l = e.target.value; set({}, "options"); regen(ctx); });
  paintRecipes(ctx);
  if (!s.recipes) generate(ctx);
}

export function paintRecipes(ctx) {
  const out = $("#recipes-out");
  if (!out) return;
  const r = P.state.recipes;
  if (!r) { out.innerHTML = '<div class="card"><p class="mut"><span class="spin"></span> Calcolo i ricettari…</p></div>'; return; }
  out.innerHTML = `<div class="notice small">${esc(r.notice)}</div>
    <div class="recipes">${r.recipes.map(recipeCard).join("")}</div>
    <div class="card gap-top"><header><h2>Confronto</h2></header>${compareTable(r.recipes)}</div>
    <details class="card gap-top more"><summary>Come sono calcolati</summary>
      <ul>${r.formulas.map((f) => `<li><b>${esc(f.name)}</b>: <code>${esc(f.expr)}</code> — ${esc(f.note)} <span class="mut small">(${esc(f.where)})</span></li>`).join("")}</ul>
      <p class="small mut">A e B usano gli stessi volumi della prescrizione (portati dentro la finestra di volume dell'etichetta, se indicata); C usa la media pesata. Una sola miscela nel serbatoio ⇒ concentrazione costante ⇒ la dose per ettaro segue il volume di ogni zona.</p></details>`;
  out.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => pick(ctx, b.dataset.pick)));
}

function pick(ctx, id) {
  const s = P.state;
  if (s.recipeId !== id) {
    const r = s.recipes.recipes.find((x) => x.id === id);
    s.recipeId = id;
    s.selection = { at: new Date().toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }), note: "" };
    log(`Ricettario scelto: ${r.letter} · ${r.title}`, r.criterion);
    invalidateFrom("select", "è stato scelto un altro ricettario");
  }
  ctx.go(3);
}

// ---------------------------------------------------------------- fase 3

let rmap = null;
export function recipeTask(task, r) {
  const vol = new Map(r.zones.map((z) => [z.i, z.volume]));
  return { ...task, rate_mean: r.volume_mean, classes: task.classes.map((c) => ({ ...c, rate: c.rate && c.rate > 0 ? vol.get(c.i) : c.rate })) };
}

export function renderSelect(ctx) {
  const box = $("#phase-3");
  const r = selectedRecipe(), s = P.state;
  if (!r) { box.innerHTML = '<div class="card"><p>Scegli prima un ricettario nella fase 2.</p></div>'; return; }
  const zones = r.zones.filter((z) => z.volume > 0);
  const fails = r.constraints.filter((c) => c.level === "fail");
  box.innerHTML = `
    <div class="phase-head"><span class="eyebrow">Fase 3 di 6</span><h2>Ricettario ${esc(r.letter)} · ${esc(r.title)}</h2>
      <p class="mut">Scelto il ${esc(s.selection ? s.selection.at : "")}. La scelta non autorizza l'esecuzione: prima vanno verificati hardware e documenti.</p></div>
    <div class="grid-2">
      <div class="card"><header><h2>Distribuzione prevista</h2></header>
        <div class="mapwrap"><canvas id="rmap" role="img" aria-label="Volumi del ricettario sul campo"></canvas></div>
        <div class="legend" id="rlegend"></div></div>
      <div class="card"><header><h2>Composizione</h2></header>
        <p>${esc(r.why)}</p>
        ${r.objective ? `<p><b>Obiettivo:</b> ${esc(r.objective)}</p>` : ""}
        <div class="tw"><table class="t"><thead><tr><th>Prodotto</th><th class="n">Dose prevista</th><th class="n">Per serbatoio</th><th class="n">Totale</th></tr></thead><tbody>
        ${r.products.map((p) => `<tr><td>${esc(p.name)}<div class="small mut">${p.reg_no ? "reg. " + esc(p.reg_no) : "n. registrazione mancante"}</div></td>
          <td class="n">${p.dose_range ? `${fmt(p.dose_range[0], 2)}–${fmt(p.dose_range[1], 2)}` : "—"} ${esc(p.unit)}</td>
          <td class="n">${p.per_tank === null ? "—" : `${fmt(p.per_tank, 2)} ${esc(p.unit.split("/")[0])}`}</td>
          <td class="n">${p.quantity === null ? "—" : `${fmt(p.quantity, 1)} ${esc(p.unit.split("/")[0])}`}</td></tr>`).join("") || '<tr><td colspan="4" class="mut">Nessun prodotto: aggiungilo nella fase 2.</td></tr>'}
        </tbody></table></div>
        <dl class="facts"><div><dt>Superficie</dt><dd>${r.totals.area_ha === null ? "—" : fmt(r.totals.area_ha, 2) + " ha"}</dd></div>
          <div><dt>Miscela</dt><dd>${r.totals.mixture_l === null ? "—" : fmt(r.totals.mixture_l, 0) + " L"}</dd></div>
          <div><dt>Acqua</dt><dd>${r.totals.water_l === null ? "—" : fmt(r.totals.water_l, 0) + " L"}</dd></div>
          <div><dt>Serbatoi</dt><dd>${r.totals.tank_loads === null ? "—" : fmt(r.totals.tank_loads, 0)}</dd></div></dl>
        ${r.constraints.length ? `<div class="alert ${fails.length ? "red" : "amber"}"><b>Vincoli e compromessi</b><ul>${r.constraints.map((c) => `<li>${esc(c.text)}</li>`).join("")}</ul></div>` : ""}
      </div>
    </div>
    <div class="card gap-top"><header><h2>Quantità per zona</h2><span class="mut small">${zones.length} zone trattate</span></header>
      <div class="tw scroll-y"><table class="t"><thead><tr><th>Zona</th><th>Classe</th><th class="n">ha</th><th class="n">File L/ha</th><th class="n">Miscela L/ha</th>${r.products.map((p) => `<th class="n">${esc(p.name)} ${esc(p.unit)}</th>`).join("")}</tr></thead>
      <tbody>${zones.slice(0, 120).map((z) => `<tr><td>${esc(z.label)}</td><td>${esc(z.cls)}</td><td class="n">${z.area_ha === null ? "—" : fmt(z.area_ha, 2)}</td><td class="n">${fmt(z.rx_rate, 0)}</td><td class="n"><b>${fmt(z.volume, 0)}</b></td>${z.doses.map((d) => `<td class="n">${d === null ? "—" : fmt(d, 2)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      ${zones.length > 120 ? `<p class="small mut">Mostrate 120 zone su ${zones.length}: l'elenco completo è nell'esportazione JSON della fase 6.</p>` : ""}</div>
    <div class="card gap-top"><header><h2>Prima dell'esecuzione</h2></header>
      <ul class="checklist">
        <li class="${fails.length ? "todo" : "ok"}">Dati di etichetta completi e coerenti ${fails.length ? "— da completare nella fase 2" : ""}</li>
        <li class="${s.match ? (s.match.level === "insufficiente" ? "fail" : "ok") : "todo"}">Compatibilità con l'attrezzatura (fase 4)${s.match ? ": " + esc(s.match.level) : ""}</li>
        <li class="todo">Dichiarazioni dell'operatore e validazione del tecnico (fase 6)</li>
      </ul>
      <label class="f" for="sel-note">Nota sulla scelta (finisce nel registro)</label>
      <input id="sel-note" type="text" value="${esc(s.selection && s.selection.note ? s.selection.note : "")}" placeholder="perché questo ricettario">
    </div>`;
  rmap = new FieldMap($("#rmap"), {});
  const t = recipeTask(ctx.task(), r);
  rmap.setData(ctx.geometry(), t.index);
  rmap.setColors(colorsFor("rx", null, t));
  $("#rlegend").innerHTML = legendHtml("rx", t, null);
  $("#sel-note").addEventListener("change", (e) => {
    s.selection = { ...(s.selection || {}), note: e.target.value };
    log("Nota sulla scelta", e.target.value);
    set({}, "note");
    toast("Nota registrata");
  });
}
