"""Fase 1 · analisi della variabilità del campo e classi di intervento.

Input: un'operazione del file (TaskModel) già letta da isoxml.analyse e, se presente, l'origine dei dati
(file ISOXML oppure mappa indice GeoJSON convertita, vedi geoimport.py).
Output: per ogni zona una classe di intervento, il riepilogo per classe, indicatori di variabilità e la
provenienza di ogni informazione (acquisita, elaborata, mancante).

Regola dichiarata (non un modello agronomico): le zone trattate vengono ordinate per rateo e divise in tre
classi di uguale superficie (terzili pesati sull'area). Le zone con rateo zero nel file sono «escluse».
Con tre o meno ratei distinti ogni rateo diventa una classe, dal più basso al più alto.
"""

from __future__ import annotations

import math
from typing import Any, Optional

CLASSES = ("esclusa", "ridotta", "standard", "intensa")
CLASS_LABEL = {
    "esclusa": "Esclusa (dose zero nel file)",
    "ridotta": "Intervento ridotto",
    "standard": "Intervento standard",
    "intensa": "Intervento intensificato",
}
RULE = ("Zone trattate ordinate per rateo e divise in tre classi di uguale superficie (terzili pesati sull'area); "
        "rateo zero nel file = esclusa; con tre o meno ratei distinti ogni rateo è una classe.")
# soglie del coefficiente di variazione: orientative, servono solo a descrivere la mappa
CV_LOW, CV_HIGH = 10.0, 25.0


def _weights(classes: list[Any]) -> tuple[list[float], str]:
    if classes and all(k.area_ha is not None for k in classes):
        return [float(k.area_ha) for k in classes], "area"
    return [1.0] * len(classes), "zone"


def assign(classes: list[Any]) -> list[str]:
    """Classe di intervento per zona, nello stesso ordine di `classes`."""
    w, _ = _weights(classes)
    treated = [i for i, k in enumerate(classes) if k.rate and k.rate > 0]
    out = ["esclusa"] * len(classes)
    if not treated:
        return out
    distinct = sorted({round(classes[i].rate, 2) for i in treated})
    if len(distinct) <= 3:
        names = {1: ["standard"], 2: ["ridotta", "intensa"], 3: ["ridotta", "standard", "intensa"]}[len(distinct)]
        lookup = dict(zip(distinct, names))
        for i in treated:
            out[i] = lookup[round(classes[i].rate, 2)]
        return out
    order = sorted(treated, key=lambda i: classes[i].rate)
    tot = sum(w[i] for i in order) or 1.0
    acc = 0.0
    for i in order:
        mid = (acc + w[i] / 2.0) / tot             # posizione del centro della zona sulla superficie cumulata
        out[i] = "ridotta" if mid < 1 / 3 else ("standard" if mid < 2 / 3 else "intensa")
        acc += w[i]
    return out


def stats(classes: list[Any]) -> dict[str, Any]:
    w, by = _weights(classes)
    treated = [i for i, k in enumerate(classes) if k.rate and k.rate > 0]
    if not treated:
        return {"weighted_by": by, "treated": 0}
    tw = sum(w[i] for i in treated) or 1.0
    mean = sum(w[i] * classes[i].rate for i in treated) / tw
    var = sum(w[i] * (classes[i].rate - mean) ** 2 for i in treated) / tw
    cv = math.sqrt(var) / mean * 100.0 if mean > 0 else 0.0
    lo, hi = min(classes[i].rate for i in treated), max(classes[i].rate for i in treated)
    level = "bassa" if cv < CV_LOW else ("media" if cv < CV_HIGH else "alta")
    reading = {
        "bassa": "Il campo è abbastanza omogeneo: un rateo unico perde poco rispetto alla prescrizione.",
        "media": "La variabilità è apprezzabile: un rateo variabile segue meglio le differenze fra le zone.",
        "alta": "Le zone sono molto diverse fra loro: un rateo unico sovra- o sotto-tratterebbe ampie superfici.",
    }[level]
    out = {"weighted_by": by, "treated": len(treated), "rate_min": round(lo, 1), "rate_max": round(hi, 1),
           "rate_mean": round(mean, 1), "cv_pct": round(cv, 1), "ratio": round(hi / lo, 2) if lo > 0 else None,
           "level": level, "reading": reading, "thresholds": {"cv_low": CV_LOW, "cv_high": CV_HIGH}}
    if by == "area":
        out["treated_ha"] = round(sum(w[i] for i in treated), 2)
        out["excluded_ha"] = round(sum(w[i] for i, k in enumerate(classes) if not (k.rate and k.rate > 0)), 2)
    return out


def provenance(rx: Any, task: Any, origin: Optional[dict[str, Any]]) -> dict[str, list[dict[str, str]]]:
    acquired: list[dict[str, str]] = []
    computed: list[dict[str, str]] = []
    missing: list[dict[str, str]] = []
    field = next((f for f in rx.fields if f.id == task.field_id), rx.fields[0] if rx.fields else None)
    geo_src = (origin or {}).get("kind") == "geojson"
    if geo_src:
        acquired.append({"what": "Mappa indice", "detail": f"GeoJSON «{origin.get('filename', '')}», proprietà «{origin.get('property', '')}», {origin.get('features', 0)} poligoni"})
        computed.append({"what": "Zone omogenee", "detail": f"{origin.get('classes')} classi per quantili di superficie dell'indice"})
        computed.append({"what": "Ratei di miscela per classe", "detail": f"regola lineare dichiarata dall'utente: {origin.get('vol_low')}–{origin.get('vol_high')} L/ha"
                         + (" (indice alto → volume alto)" if origin.get("direction", "up") == "up" else " (indice alto → volume basso)")})
        if origin.get("boundary") == "hull":
            computed.append({"what": "Perimetro del campo", "detail": "stimato come inviluppo convesso dei poligoni: verificalo"})
        else:
            acquired.append({"what": "Perimetro del campo", "detail": "poligono di confine presente nel GeoJSON"})
    else:
        if field is not None and field.rings and not field.boundary_from_grid:
            acquired.append({"what": "Perimetro del campo", "detail": f"dal file ({field.name or field.id})"})
        elif field is not None and field.boundary_from_grid:
            computed.append({"what": "Perimetro del campo", "detail": "ricavato dall'estensione della griglia (il file non ha un confine)"})
        else:
            missing.append({"what": "Perimetro del campo", "detail": "il file non contiene il confine"})
        geo = {"grid1": "griglia a zone", "grid2": "griglia a valori continui", "zones_geo": "zone poligonali"}.get(task.kind)
        if geo:
            acquired.append({"what": "Geometria delle zone", "detail": geo})
        else:
            missing.append({"what": "Geometria delle zone", "detail": "il file non dice dove si applicano i ratei"})
        acquired.append({"what": "Ratei di miscela per zona", "detail": "L/ha dalla prescrizione ISOXML"})
        missing.append({"what": "Immagine satellitare / indice originale", "detail": "il file contiene la prescrizione già elaborata, non i dati di partenza"})
    if task.products:
        acquired.append({"what": "Prodotti indicati nel file", "detail": ", ".join(task.products)})
    else:
        missing.append({"what": "Prodotti", "detail": "il file non indica prodotti: aggiungili nella fase Ricettari"})
    if all(k.area_ha is not None for k in task.classes) and task.classes:
        computed.append({"what": "Superfici per zona", "detail": "calcolate dalla geometria"})
    else:
        missing.append({"what": "Superfici per zona", "detail": "senza geometria le quantità totali non sono calcolabili"})
    computed.append({"what": "Classi di intervento", "detail": "terzili di superficie dei ratei (regola dichiarata, non un modello agronomico)"})
    computed.append({"what": "Variabilità", "detail": "coefficiente di variazione dei ratei pesato sulla superficie"})
    missing.append({"what": "Pressione delle infestanti / stadio colturale", "detail": "nessun dato rilevato: non sono usati nei calcoli"})
    return {"acquired": acquired, "computed": computed, "missing": missing}


def analyse(rx: Any, task: Any, origin: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    ks = task.classes
    cls = assign(ks)
    w, by = _weights(ks)
    groups = []
    for name in CLASSES:
        idx = [i for i, c in enumerate(cls) if c == name]
        if not idx:
            continue
        rates = [ks[i].rate for i in idx if ks[i].rate is not None]
        tw = sum(w[i] for i in idx)
        groups.append({
            "cls": name, "label": CLASS_LABEL[name], "n_zones": len(idx),
            "area_ha": round(tw, 2) if by == "area" else None,
            "share_pct": round(tw / (sum(w) or 1.0) * 100.0, 1),
            "rate_min": round(min(rates), 1) if rates else None, "rate_max": round(max(rates), 1) if rates else None,
        })
    lo = min((k.rate for k in ks if k.rate and k.rate > 0), default=0.0)
    hi = max((k.rate for k in ks if k.rate and k.rate > 0), default=0.0)
    zones = [{"i": k.idx, "cls": c, "intensity": round((k.rate - lo) / (hi - lo), 3) if (k.rate and k.rate > 0 and hi > lo) else (1.0 if k.rate and k.rate > 0 else 0.0)}
             for k, c in zip(ks, cls)]
    return {"ok": True, "task": task.index, "zones": zones, "groups": groups, "stats": stats(ks),
            "provenance": provenance(rx, task, origin), "rule": RULE}
