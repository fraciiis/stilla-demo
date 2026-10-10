// Fase 1 · mappa del campo e classi di intervento (input della pipeline).

import { $, esc, fmt, tok } from "./util.js";
import { api } from "./api.js";
import { FieldMap } from "./map.js";
import { P, set } from "./pipeline.js";
import { demoImagery } from "./demo.js";

const CLS = {
  esclusa: { name: "Esclusa", t: "--zone-esclusa", sym: "–" },
  ridotta: { name: "Ridotto", t: "--zone-ridotta", sym: "▽" },
  standard: { name: "Standard", t: "--zone-standard", sym: "◇" },
  intensa: { name: "Intensificato", t: "--zone-intensa", sym: "▲" },
};
let zmap = null;

export async function loadZoning(ctx) {
  if (P.state.zoning) return P.state.zoning;
  const z = await api.zoning({ task: ctx.taskIndex() });
  set({ zoning: z }, "zoning");
  return z;
}

export function zoneColors(task, zoning) {
  const by = new Map(zoning.zones.map((z) => [z.i, z.cls]));
  const out = task.classes.map((c) => tok(CLS[by.get(c.i) || "esclusa"].t));
  out.labels = task.classes.map((c) => {
    const k = by.get(c.i);
    return k && k !== "esclusa" ? { s: CLS[k].sym, t: fmt(c.rate, 0), u: "L/ha" } : null;
  });
  return out;
}

export async function renderFieldPhase(ctx) {
  const box = $("#phase-1");
  const task = ctx.task();
  let z;
  try { z = await loadZoning(ctx); } catch (e) {
    box.innerHTML = `<div class="alert red"><b>Analisi del campo non riuscita</b>${esc(e.message)}</div>`;
    return;
  }
  const st = z.stats || {};
  const origin = ctx.origin();
  const legend = z.groups.map((g) => `<span><i style="background-color:${tok(CLS[g.cls].t)}"></i>${esc(CLS[g.cls].name)} <b>${fmt(g.share_pct, 0)} %</b></span>`).join("");
  const prov = (list, cls, title) => `<div class="prov ${cls}"><h4>${title}</h4><ul>${list.map((p) => `<li><b>${esc(p.what)}</b><span>${esc(p.detail)}</span></li>`).join("") || "<li class='mut'>—</li>"}</ul></div>`;
  box.innerHTML = `
    <div class="phase-head"><span class="eyebrow">Fase 1 di 6</span><h2>Mappa del campo e zone di intervento</h2>
      <p class="mut">La mappa è l'input di tutto il processo: da qui escono le zone omogenee e le classi di intervento usate dai ricettari.</p></div>
    <div class="grid-2">
      <div class="card">
        <header><h2>Classi di intervento</h2><span class="badge blue">${esc(task.classes.length)} zone</span></header>
        <div id="zlayers"></div>
        <div class="mapwrap"><canvas id="zmap" role="img" aria-label="Mappa delle classi di intervento"></canvas><div class="mapmsg" id="zmapmsg" hidden></div><span class="map-chip" id="zchip" hidden></span></div>
        <div class="legend">${legend}</div>
        <p class="small mut hint">${esc(z.rule)}</p>
      </div>
      <div class="card">
        <header><h2>Variabilità del campo</h2>${st.level ? `<span class="badge ${st.level === "alta" ? "adapt" : st.level === "media" ? "blue" : "ok"}">variabilità ${esc(st.level)}</span>` : ""}</header>
        ${st.treated ? `<div class="kpis tight">
          <div class="kpi"><small>Ratei del file</small><b>${fmt(st.rate_min, 0)}–${fmt(st.rate_max, 0)}</b><em>L/ha · media ${fmt(st.rate_mean, 0)}</em></div>
          <div class="kpi"><small>Coefficiente di variazione</small><b>${fmt(st.cv_pct, 0)} %</b><em>soglie ${st.thresholds.cv_low} / ${st.thresholds.cv_high} %</em></div>
          ${st.treated_ha !== undefined ? `<div class="kpi"><small>Superficie trattata</small><b>${fmt(st.treated_ha, 1)} ha</b><em>esclusa ${fmt(st.excluded_ha, 1)} ha</em></div>` : ""}
        </div><p>${esc(st.reading)}</p>` : '<div class="alert amber"><b>Nessun rateo da distribuire</b>Il file non contiene zone da trattare.</div>'}
        <div class="tw"><table class="t"><thead><tr><th>Classe</th><th class="n">Zone</th><th class="n">ha</th><th class="n">Quota</th><th class="n">L/ha nel file</th></tr></thead>
        <tbody>${z.groups.map((g) => `<tr><td><span class="sw" style="background:${tok(CLS[g.cls].t)}"></span>${esc(g.label)}</td><td class="n">${g.n_zones}</td><td class="n">${g.area_ha === null ? "—" : fmt(g.area_ha, 2)}</td><td class="n">${fmt(g.share_pct, 0)} %</td><td class="n">${g.rate_min === null ? "—" : `${fmt(g.rate_min, 0)}–${fmt(g.rate_max, 0)}`}</td></tr>`).join("")}</tbody></table></div>
        <div id="zacq"></div>
        ${origin && origin.kind === "geojson" ? `<div class="alert"><b>Prescrizione creata dalla mappa indice</b>${esc(origin.filename)} · proprietà «${esc(origin.property)}» · ${origin.classes} classi · ${fmt(origin.vol_low, 0)}–${fmt(origin.vol_high, 0)} L/ha (${origin.direction === "up" ? "indice alto → più volume" : "indice alto → meno volume"}). Regola scelta dal tecnico, non un modello agronomico.</div>` : ""}
      </div>
    </div>
    <div class="card gap-top"><header><h2>Da dove arrivano i dati</h2></header>
      <div class="prov-grid">${prov(z.provenance.acquired, "acq", "Acquisiti")}${prov(z.provenance.computed, "cmp", "Elaborati dall'app")}${prov(z.provenance.missing, "mis", "Mancanti")}</div>
      <p class="small mut" id="sat-note"></p>
    </div>`;
  zmap = new FieldMap($("#zmap"), {});
  zmap.setData(ctx.geometry(), task.index);
  if (!zmap.hasGeometry()) { $("#zmapmsg").hidden = false; $("#zmapmsg").textContent = "Il file non contiene la geometria: le classi valgono per zona ma non si possono disegnare."; }
  zmap.setColors(zoneColors(task, z));
  if (origin && origin.kind === "demo") demoLayers(origin, zmap);
  api.satellite().then((s) => { $("#sat-note").textContent = s.configured ? `Acquisizione satellitare collegata: ${s.provider}.` : s.message; }).catch(() => {});
}

// campi dimostrativi: ortofoto / NDVI / infestanti sotto le zone, con opacità regolabile
async function demoLayers(origin, map) {
  const im = await demoImagery(origin);
  if (!im) return;
  const st = { layer: origin.index === "WEED" ? "weed" : "rgb", alpha: 0.55 };
  const names = { rgb: "Ortofoto", ndvi: "NDVI", weed: "Infestanti", none: "Solo zone" };
  const keys = [...Object.keys(im.layers), "none"];
  $("#zlayers").innerHTML = `<div class="layerbar"><div class="seg" role="group" aria-label="Immagine sotto le zone">${keys.map((k) => `<button type="button" data-l="${k}" aria-pressed="${k === st.layer}">${names[k]}</button>`).join("")}</div>
    <label class="opac">Zone <input type="range" id="zalpha" min="0" max="100" value="${st.alpha * 100}" aria-label="Opacità delle zone"></label></div>`;
  const cacheImg = {};
  const paint = () => {
    if (st.layer === "none") map.setImagery(null, 1);
    else map.setImagery(cacheImg[st.layer] || (cacheImg[st.layer] = im.layers[st.layer]()), st.alpha);
    $("#zlayers").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.l === st.layer)));
  };
  $("#zlayers").addEventListener("click", (e) => { const b = e.target.closest("button[data-l]"); if (b) { st.layer = b.dataset.l; paint(); } });
  $("#zalpha").addEventListener("input", (e) => { st.alpha = Number(e.target.value) / 100; if (st.layer !== "none") map.setOverlay(st.alpha); });
  const chip = $("#zchip"); chip.hidden = false; chip.textContent = `${im.label} · DEMO`;
  const idx = origin.index, s = im.stats(idx);
  const a = origin.acquisition;
  $("#zacq").innerHTML = `<div class="acqcard"><header><b>${esc(a.type === "drone" ? a.sensor : "Sentinel-2 L2A (simulato)")}</b><span class="badge demo">DEMO</span></header>
    <div class="statline"><span><small>Data</small><b>${new Date(a.date).toLocaleDateString("it-IT")}</b></span>
      <span><small>${a.type === "drone" ? "Risoluzione" : "Pixel / nuvole"}</small><b>${a.type === "drone" ? `${fmt(a.gsd_cm, 1)} cm/px` : `${a.res_m} m · ${a.cloud} %`}</b></span>
      <span><small>${idx === "NDVI" ? "NDVI medio" : "Infestanti medie"}</small><b>${idx === "NDVI" ? fmt(s.mean, 2) : fmt(s.mean, 1) + " %"}</b></span>
      <span><small>Celle di prescrizione</small><b>${fmt(origin.presc_cell_m, 0)} m</b></span></div>
    ${im.hist(s, idx)}<p class="small mut">${esc(origin.rule)}</p></div>`;
  paint();
}
