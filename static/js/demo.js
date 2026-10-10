// Modalità dimostrativa · galleria dei campi con mappe da drone e satellite (dati simulati) e pannello di acquisizione.

import { $, esc, fmt, toast } from "./util.js";
import { api } from "./api.js";
import { FieldMap } from "./map.js";
import { demoFields, render, stats, histogramSvg, NDVI_LEGEND, ndviColor } from "./imagery.js";

const rgb = (c) => `rgb(${c.map(Math.round).join(",")})`;
const SRC = { drone: "Drone", sentinel2: "Sentinel-2" };
const acqLabel = (a) => (a.type === "drone"
  ? `${SRC.drone} · ${new Date(a.date).toLocaleDateString("it-IT")} · GSD ${fmt(a.gsd_cm, 1)} cm/px`
  : `${SRC.sentinel2} · ${new Date(a.date).toLocaleDateString("it-IT")} · ${a.res_m} m · nuvole ${a.cloud} %`);

export async function renderGallery(onLoaded) {
  const box = $("#demo-gallery");
  if (!box) return;
  let data;
  try { data = await demoFields(); } catch { box.closest("section").hidden = true; return; }
  box.innerHTML = data.fields.map((f) => `<button class="dfield" type="button" data-id="${esc(f.id)}">
      <canvas aria-hidden="true"></canvas>
      <span class="dbadges">${[...new Set(f.acquisitions.map((a) => a.type))].map((t) => `<span class="badge src ${t}">${SRC[t]}</span>`).join("")}<span class="badge demo">DEMO</span></span>
      <b>${esc(f.name)}</b><span>${esc(f.crop)} · ${fmt(f.area_ha, 1)} ha · ${esc(f.place)}</span><span class="mut small">${esc(f.target)}</span></button>`).join("");
  // anteprime: ortofoto dell'acquisizione più dettagliata
  box.querySelectorAll(".dfield").forEach((btn) => {
    const f = data.fields.find((x) => x.id === btn.dataset.id);
    const cv = btn.querySelector("canvas");
    requestAnimationFrame(() => {
      const r = cv.getBoundingClientRect();
      cv.width = Math.max(10, Math.round(r.width * devicePixelRatio)); cv.height = Math.max(10, Math.round(r.height * devicePixelRatio));
      const m = new FieldMap(cv, { furniture: false, pad: -18 });          // anteprima: campo grande, niente scala e nord
      m.setData({ fields: [{ rings: [f.boundary], from_grid: false }], tasks: [] }, 0);
      m.setImagery(render(f, "rgb", f.acquisitions[0], { scale: 2 }));
    });
    btn.addEventListener("click", () => openSetup(f, onLoaded));
  });
}

async function openSetup(f, onLoaded) {
  const box = $("#demo-setup");
  box.hidden = false;
  let acqs = [...f.acquisitions];
  const st = { acq: acqs[0], layer: "rgb", index: f.indices.WEED ? "WEED" : "NDVI" };
  box.innerHTML = `
    <header><div><span class="eyebrow">Acquisizione · dati simulati</span><h2>${esc(f.name)}</h2>
      <p class="mut">${esc(f.crop)} · ${fmt(f.area_ha, 2)} ha · ${esc(f.place)} · obiettivo: ${esc(f.target)}</p></div>
      <button class="btn ghost" type="button" id="ds-close">Chiudi</button></header>
    <div class="ds-grid">
      <div>
        <div class="seg" role="group" aria-label="Livello della mappa" id="ds-layers">
          <button type="button" data-l="rgb" aria-pressed="true">Ortofoto</button>
          <button type="button" data-l="ndvi" aria-pressed="false">NDVI</button>
          ${f.indices.WEED ? '<button type="button" data-l="weed" aria-pressed="false">Infestanti</button>' : ""}
        </div>
        <div class="mapwrap gap-top"><canvas id="ds-map" role="img" aria-label="Mappa del campo dall'acquisizione scelta"></canvas><span class="map-chip" id="ds-chip"></span></div>
        <div class="legend" id="ds-legend"></div>
      </div>
      <div>
        <h3 class="sub-h">1 · Scegli l'acquisizione</h3>
        <div class="acqs" id="ds-acqs"></div>
        <button class="btn sm" type="button" id="ds-search">Cerca altre scene Sentinel-2</button>
        <div id="ds-stats" class="gap-top"></div>
        <h3 class="sub-h">2 · Dalla mappa alla prescrizione</h3>
        <div class="row2"><div><label class="f" for="ds-index">Mappa da usare</label><select id="ds-index">
            <option value="NDVI">NDVI · vigore</option>${f.indices.WEED ? '<option value="WEED" selected>Copertura infestanti</option>' : ""}</select></div>
          <div><label class="f" for="ds-k">Zone di gestione</label><select id="ds-k">${[2, 3, 4, 5].map((k) => `<option ${k === 3 ? "selected" : ""}>${k}</option>`).join("")}</select></div></div>
        <div class="row2"><div><label class="f" for="ds-lo">Volume zona a indice basso (L/ha)</label><input id="ds-lo" type="number" min="1" value="${f.suggest.vol[0]}"></div>
          <div><label class="f" for="ds-hi">Volume zona a indice alto (L/ha)</label><input id="ds-hi" type="number" min="1" value="${f.suggest.vol[1]}"></div></div>
        <div id="ds-weed" ${f.indices.WEED ? "" : "hidden"}><label class="f" for="ds-thr">Non trattare sotto (% di infestanti)</label><input id="ds-thr" type="number" min="0" max="30" step="1" value="3">
          <p class="small mut">Irrorazione localizzata: le celle senza infestanti restano escluse.</p></div>
        <div class="actions gap-top"><button class="btn primary" type="button" id="ds-go">Avvia il processo con questa mappa</button></div>
        <p class="small mut">Campo, immagini, date e indici sono dimostrativi (inventati ma verosimili). La pipeline che segue è quella reale.</p>
      </div>
    </div>`;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  const map = new FieldMap($("#ds-map"), {});
  map.setData({ fields: [{ rings: [f.boundary], from_grid: false }], tasks: [] }, 0);

  const paint = () => {
    const layer = st.layer === "weed" && !f.indices.WEED ? "rgb" : st.layer;
    map.setImagery(render(f, layer, st.acq));
    $("#ds-chip").textContent = acqLabel(st.acq);
    $("#ds-layers").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.l === st.layer)));
    $("#ds-legend").innerHTML = layer === "ndvi" ? `<span>NDVI</span><span class="ramp" style="background:linear-gradient(90deg,${NDVI_LEGEND.map(([v, c]) => `${rgb(c)} ${Math.round(v * 100)}%`).join(",")})"></span><span>0 → 0,9</span>`
      : layer === "weed" ? '<span>Infestanti</span><span class="ramp" style="background:linear-gradient(90deg,#faf6ee,#d78cc4,#ce1256,#460020)"></span><span>0 → 60 %</span>'
      : `<span class="mut small">${st.acq.type === "drone" ? `Ortofoto RGB · GSD ${fmt(st.acq.rgb_gsd_cm, 1)} cm/px (resa a 0,5 m/px)` : "Colori naturali · pixel 10 m"}</span>`;
    const idx = $("#ds-index").value, s = stats(f, idx, st.acq);
    $("#ds-stats").innerHTML = `<div class="statline"><span><small>${idx === "NDVI" ? "NDVI medio" : "Infestanti medie"}</small><b>${idx === "NDVI" ? fmt(s.mean, 2) : fmt(s.mean, 1) + " %"}</b></span>
      <span><small>10° – 90° percentile</small><b>${idx === "NDVI" ? `${fmt(s.p10, 2)} – ${fmt(s.p90, 2)}` : `${fmt(s.p10, 0)} – ${fmt(s.p90, 0)} %`}</b></span>
      <span><small>Celle analizzate</small><b>${fmt(s.n, 0)}</b></span></div>${histogramSvg(s, idx)}`;
  };
  const paintAcqs = () => {
    $("#ds-acqs").innerHTML = acqs.map((a) => {
      const bad = a.type === "sentinel2" && a.cloud >= 40;
      return `<label class="acq ${bad ? "cloudy" : ""}"><input type="radio" name="ds-acq" value="${esc(a.id)}" ${a.id === st.acq.id ? "checked" : ""} ${bad ? "disabled" : ""}>
        <span><b>${esc(a.type === "drone" ? a.sensor : "Sentinel-2 L2A (simulato)")}</b><span class="small mut">${esc(acqLabel(a))}${bad ? " · troppo nuvolosa" : ""}</span></span></label>`;
    }).join("");
    $("#ds-acqs").querySelectorAll("input").forEach((r) => r.addEventListener("change", () => { st.acq = acqs.find((a) => a.id === r.value); paint(); }));
  };
  paintAcqs(); paint();
  $("#ds-layers").addEventListener("click", (e) => { const b = e.target.closest("button[data-l]"); if (b) { st.layer = b.dataset.l; paint(); } });
  $("#ds-index").addEventListener("change", () => { $("#ds-weed").hidden = $("#ds-index").value !== "WEED"; paint(); });
  $("#ds-close").addEventListener("click", () => { box.hidden = true; });
  $("#ds-search").addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.innerHTML = '<span class="spin"></span> Interrogo il catalogo (simulato)…';
    try {
      const r = await api.demoSearch(f.id);
      const known = new Set(acqs.map((a) => a.id));
      acqs = [...acqs, ...r.scenes.filter((s) => !known.has(s.id))].sort((a, b) => (a.type === b.type ? b.date.localeCompare(a.date) : a.type === "drone" ? -1 : 1));
      paintAcqs();
      toast(`${r.scenes.length} scene trovate · catalogo simulato`);
    } catch (err) { toast(err.message, true); }
    e.target.hidden = true;
  });
  $("#ds-go").addEventListener("click", async () => {
    const btn = $("#ds-go"); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Creo la prescrizione…';
    try {
      const r = await api.demoLoad({ field: f.id, acquisition: st.acq.id, index: $("#ds-index").value, classes: Number($("#ds-k").value),
        vol_low: $("#ds-lo").value, vol_high: $("#ds-hi").value, direction: "up", exclude_below: $("#ds-thr").value });
      box.hidden = true;
      onLoaded(r);
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = "Avvia il processo con questa mappa"; }
  });
}

// livelli d'immagine per la fase 1 di un campo dimostrativo
export async function demoImagery(origin) {
  const data = await demoFields();
  const f = data.fields.find((x) => x.id === origin.field);
  if (!f) return null;
  const acq = origin.acquisition;
  return { f, acq, layers: { rgb: () => render(f, "rgb", acq), ndvi: () => render(f, "ndvi", acq), ...(f.indices.WEED ? { weed: () => render(f, "weed", acq) } : {}) },
    stats: (idx) => stats(f, idx, acq), hist: (s, idx) => histogramSvg(s, idx), label: acqLabel(acq), ndviColor };
}
