// Stepper a 6 fasi, riepilogo del processo sempre visibile e barra delle azioni in basso.

import { $, esc } from "./util.js";
import { P, PHASES, phaseStatus, reachable, overall, selectedRecipe } from "./pipeline.js";

const ICON = { done: "✓", warn: "!", blocked: "✕", skip: "–" };
const WORD = { done: "completata", warn: "da rivedere", blocked: "bloccata", skip: "non necessaria", todo: "da fare", current: "in corso" };

export function renderStepper(go) {
  const st = phaseStatus(), cur = P.state.phase, inWs = !$("#workspace").hidden;
  $("#steps").innerHTML = PHASES.map((p) => {
    const s = inWs ? st[p.n] : (p.n === 1 ? "todo" : "todo");
    const on = inWs ? p.n === cur : p.n === 1;
    const can = inWs && reachable(p.n);
    return `<button type="button" class="step ${on ? "on" : ""} st-${s}" data-n="${p.n}" ${can ? "" : "disabled"} ${on ? 'aria-current="step"' : ""}
      aria-label="Fase ${p.n}: ${esc(p.label)} (${WORD[on ? "current" : s] || ""})"><i>${!on && ICON[s] ? ICON[s] : p.n}</i><span class="st-txt">${esc(p.short)}</span></button>`;
  }).join("");
  $("#steps").querySelectorAll("button[data-n]").forEach((b) => b.addEventListener("click", () => go(Number(b.dataset.n))));
}

export function renderProcess() {
  const s = P.state, st = phaseStatus(), ov = overall(), rec = selectedRecipe();
  const missing = s.dossier ? s.dossier.missing : [];
  const warns = [];
  if (rec) rec.constraints.forEach((c) => warns.push(c.text));
  if (s.match) s.match.rows.filter((r) => r.status === "fail" || r.status === "partial").forEach((r) => warns.push(`${r.label}: disponibile ${r.available}`));
  const decisions = s.log.slice(-6).reverse();
  $("#process").innerHTML = `<details class="process-box" ${$("#process").dataset.open === "1" ? "open" : ""}>
    <summary><span class="ov ov-${ov.tone}">${esc(ov.label)}</span>
      <span class="ov-facts">${rec ? `Ricettario ${esc(rec.letter)} · ${esc(rec.title)}` : "Nessun ricettario scelto"}${missing.length ? ` · ${missing.length} dati mancanti` : ""}${warns.length ? ` · ${warns.length} avvisi` : ""}</span>
      <span class="ov-more">Riepilogo</span></summary>
    <div class="process-body">
      <div><h3>Fasi</h3><ol class="plist">${PHASES.map((p) => `<li class="ps-${st[p.n]}${p.n === s.phase ? " cur" : ""}"><b>${p.n}</b> ${esc(p.label)} <span>${esc(p.n === s.phase ? "in corso" : WORD[st[p.n]])}</span></li>`).join("")}</ol></div>
      <div><h3>Dati mancanti</h3>${missing.length ? `<ul>${missing.slice(0, 8).map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : `<p class="mut small">${s.dossier ? "Nessuno." : "Calcolati nella fase Documenti."}</p>`}
        <h3>Avvisi</h3>${warns.length ? `<ul>${warns.slice(0, 6).map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : '<p class="mut small">Nessuno.</p>'}</div>
      <div><h3>Decisioni</h3>${decisions.length ? `<ul class="dlog">${decisions.map((e) => `<li><span class="mut small">${esc(e.t)}</span> ${esc(e.what)}${e.detail ? ` <span class="mut small">· ${esc(e.detail)}</span>` : ""}</li>`).join("")}</ul>` : '<p class="mut small">Nessuna decisione registrata.</p>'}</div>
    </div></details>`;
  $("#process details").addEventListener("toggle", (e) => { $("#process").dataset.open = e.target.open ? "1" : "0"; });
}

// barra in basso: indietro / azione principale della fase
export function renderBar({ title, sub = "", next = null, back = null }) {
  $("#pb-title").textContent = title;
  $("#pb-sub").textContent = sub;
  const nb = $("#pb-next"), bb = $("#pb-back");
  nb.hidden = !next; bb.hidden = !back;
  if (next) { nb.textContent = next.label; nb.disabled = !!next.disabled; nb.onclick = next.onClick; }
  if (back) { bb.textContent = back.label; bb.onclick = back.onClick; }
}
