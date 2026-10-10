// Fase 4 (riquadro di compatibilità) e fase 5 · componentistica ARAG proposta quando serve davvero.

import { $, esc, fmt, toast } from "./util.js";
import { api } from "./api.js";
import { P, set, log } from "./pipeline.js";

const LEVEL = {
  adeguata: { cls: "good", badge: "ok", word: "Compatibilità adeguata" },
  parziale: { cls: "mid", badge: "adapt", word: "Compatibilità parziale" },
  insufficiente: { cls: "bad", badge: "under", word: "Incompatibile o insufficiente" },
};
const ROW = { ok: ["ok", "soddisfatto"], partial: ["adapt", "parziale"], fail: ["under", "non soddisfatto"], unknown: ["off", "non verificabile"] };

let mctl = null, rctl = null;
const body = (ctx) => ({ task: ctx.taskIndex(), products: P.state.products, options: P.state.options, recipe_id: P.state.recipeId, config: ctx.cfg() });

export async function refreshMatch(ctx) {
  if (!P.state.recipeId) return;
  if (mctl) mctl.abort();
  mctl = new AbortController();
  try {
    const m = await api.match(body(ctx), mctl.signal);
    const prev = P.state.match && P.state.match.level;
    P.state.match = m;
    if (prev && prev !== m.level) log(`Compatibilità hardware: ${m.level}`, "ricalcolata dopo una modifica");
    set({}, "match");
    refreshRecs(ctx);
  } catch (e) {
    if (e.name === "AbortError") return;
    P.state.match = null;
    set({}, "match");
    const box = $("#match");
    if (box) box.innerHTML = `<div class="alert red"><b>Verifica di compatibilità non riuscita</b>${esc(e.message)}</div>`;
  }
}

export async function refreshRecs(ctx) {
  if (!P.state.recipeId) return;
  if (rctl) rctl.abort();
  rctl = new AbortController();
  try {
    P.state.recs = await api.recommend(body(ctx), rctl.signal);
    set({}, "recs");
  } catch (e) {
    if (e.name !== "AbortError") { P.state.recs = { ok: false, error: e.message, recommendations: [] }; set({}, "recs"); }
  }
}

export function renderMatch(ctx) {
  const box = $("#match");
  if (!box) return;
  const m = P.state.match, recs = P.state.recs;
  if (!P.state.recipeId) { box.innerHTML = ""; return; }
  if (!m) { box.innerHTML = '<div class="card"><p class="mut"><span class="spin"></span> Confronto il ricettario con l\'hardware…</p></div>'; return; }
  const L = LEVEL[m.level];
  const n = recs && recs.recommendations ? recs.recommendations.length : 0;
  box.innerHTML = `<div class="card match ${L.cls}">
    <header><h2>Ricettario sull'hardware</h2><span class="badge ${L.badge}">${esc(L.word)}</span></header>
    <p>${esc(m.text)}</p>
    <div class="tw"><table class="t"><thead><tr><th>Requisito</th><th>Richiesto</th><th>Disponibile</th><th>Esito</th></tr></thead><tbody>
      ${m.rows.map((r) => `<tr><td>${esc(r.label)}${r.detail ? `<div class="small mut">${esc(r.detail)}</div>` : ""}</td><td>${esc(r.required)}</td><td>${esc(r.available)}</td><td><span class="badge ${ROW[r.status][0]}">${ROW[r.status][1]}</span></td></tr>`).join("")}
    </tbody></table></div>
    <p class="small mut">Soglie: adeguata ≥ ${m.thresholds.ok_pct} % della superficie entro tolleranza, parziale ≥ ${m.thresholds.partial_pct} %. Il confronto rilancia il calcolo idraulico con i volumi del ricettario.</p>
    ${m.level !== "adeguata" || n ? `<div class="changebar"><div class="txt">${m.level === "insufficiente" ? "<b>Il trattamento non è pronto per l'esecuzione.</b> " : ""}${n ? `${n} ${n === 1 ? "proposta" : "proposte"} di componentistica ARAG calcolate per questo ricettario.` : "Cerco componenti che risolvano i requisiti mancanti…"}</div>
      <button class="btn sm primary" type="button" id="to-arag">Vedi i componenti ARAG</button></div>` : ""}
  </div>`;
  const b = $("#to-arag"); if (b) b.addEventListener("click", () => ctx.go(5));
}

const GROUP = {
  indispensabile: { title: "Indispensabili", text: "Senza questi componenti il ricettario non è eseguibile correttamente." },
  precisione: { title: "Per migliorare la precisione", text: "Il ricettario è eseguibile, questi componenti lo eseguono meglio." },
  opzionale: { title: "Opzionali", text: "Aggiungono capacità senza cambiare l'esito." },
};

export function renderArag(ctx) {
  const box = $("#phase-5");
  const m = P.state.match, recs = P.state.recs;
  P.state.aragSeen = true;
  if (!m || !recs) {
    box.innerHTML = `<div class="phase-head"><span class="eyebrow">Fase 5 di 6</span><h2>Componentistica ARAG</h2></div><div class="card"><p class="mut"><span class="spin"></span> Calcolo le proposte…</p></div>`;
    if (!m) refreshMatch(ctx); else if (!recs) refreshRecs(ctx);
    return;
  }
  const list = recs.recommendations || [];
  const groups = ["indispensabile", "precisione", "opzionale"].map((g) => [g, list.filter((r) => r.group === g)]).filter(([, l]) => l.length);
  const card = (r, i) => `<article class="arag">
      <header><h3>${esc(r.items.map((it) => it.product.name).join(" + "))}</h3><span class="badge ${LEVEL[r.after.level].badge}">dopo: ${esc(r.after.level)}</span></header>
      <dl class="facts">
        <div><dt>Requisito non soddisfatto</dt><dd>${esc(r.requirement)}</dd></div>
        <div><dt>Limite attuale</dt><dd>${esc(r.current_limit || "—")}</dd></div>
        <div><dt>Entro tolleranza</dt><dd>${fmt(r.before.on_target_pct, 0)} % → <b>${fmt(r.after.on_target_pct, 0)} %</b></dd></div>
      </dl>
      <p>${esc(r.why)}</p>
      ${r.gained.length ? `<ul class="diffs">${r.gained.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : ""}
      <div class="tw"><table class="t"><thead><tr><th>Posizione</th><th>Oggi</th><th>Proposto</th></tr></thead><tbody>
        ${r.items.map((it) => `<tr><td>${esc(it.slot_label)}</td><td>${esc(Array.isArray(it.current) ? it.current.join(" + ") : it.current || "nessuno")}</td>
          <td><b>${esc(it.product.code)}</b> · ${esc(it.product.name)}<div class="small mut">${esc(it.product.specs || it.product.short)}</div>${it.product.official_url ? `<a class="small" href="${esc(it.product.official_url)}" target="_blank" rel="noopener">Scheda ufficiale ↗</a>` : ""}</td></tr>`).join("")}
      </tbody></table></div>
      ${r.after.warnings.length ? `<div class="alert amber"><b>Da verificare con questa configurazione</b><ul>${r.after.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
      <button class="btn" type="button" data-apply="${i}">Prova questa configurazione</button>
    </article>`;
  box.innerHTML = `<div class="phase-head"><span class="eyebrow">Fase 5 di 6</span><h2>Componentistica ARAG</h2>
      <p class="mut">Compare quando la verifica dell'hardware trova un limite reale. Ogni proposta viene dal catalogo ARAG del progetto ed è ricalcolata con il motore idraulico sul ricettario scelto.</p></div>
    ${!list.length ? `<div class="card"><div class="empty"><b>${m.level === "adeguata" ? "Nessun componente necessario" : "Nessun componente del catalogo risolve il problema"}</b>
      <p class="mut">${m.level === "adeguata" ? "L'attrezzatura attuale esegue il ricettario con la precisione richiesta." : "Il catalogo non contiene un componente che porti il ricettario a un livello migliore: valuta un altro ricettario (fase 2) o verifica con ARAG."}</p></div></div>` : ""}
    ${groups.map(([g, l]) => `<section class="gap-top"><h3 class="grp-title">${GROUP[g].title}</h3><p class="mut small">${GROUP[g].text}</p><div class="arags">${l.map((r) => card(r, list.indexOf(r))).join("")}</div></section>`).join("")}
    <p class="small mut gap-top">${esc(recs.source || "")}</p>`;
  box.querySelectorAll("[data-apply]").forEach((b) => b.addEventListener("click", () => {
    const r = list[Number(b.dataset.apply)];
    const cfg = { ...ctx.cfg(), ...r.changes };
    log("Componentistica ARAG applicata", r.items.map((it) => `${it.slot_label}: ${it.product.code} ${it.product.name}`).join(" · "));
    ctx.applyConfig(cfg);
    toast("Configurazione applicata: guarda il risultato nella fase Hardware.");
    ctx.go(4);
  }));
  set({}, "arag-seen");
}
