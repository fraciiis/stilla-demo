"""Modalità dimostrativa: campi con mappe simulate da drone e satellite → prescrizione ISOXML a griglia.

I dati vengono da static/demo/fields.json (generato da tools/make_demo_fields.py): sono INVENTATI ma verosimili.
Il risultato passa poi dallo stesso lettore ISOXML degli altri file, quindi tutta la pipeline lavora su di lui.

Regole (dichiarate):
* l'indice a 2 m viene aggregato alla risoluzione dell'acquisizione (drone: celle di prescrizione da 6 m;
  Sentinel-2: pixel da 10 m) e corretto con il fattore stagionale della data;
* le celle dentro il campo vengono divise in N classi di uguale superficie e ripulite con un filtro di
  maggioranza 3×3 (unità minima cartografabile);
* volume per classe: lineare fra i due valori scelti dal tecnico; per la mappa delle infestanti le celle sotto
  la soglia di copertura non vengono trattate (irrorazione localizzata).
"""

from __future__ import annotations

import base64
import datetime as _dt
import io
import json
import math
import os
import random
import threading
import zipfile
from typing import Any, Optional
from xml.sax.saxutils import quoteattr

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(BASE_DIR, "static", "demo", "fields.json")
M_PER_DEG = 111_320.0

_lock = threading.Lock()
_cache: Optional[dict[str, Any]] = None


class DemoError(ValueError):
    pass


def _data() -> dict[str, Any]:
    global _cache
    with _lock:
        if _cache is None:
            try:
                with open(DATA_PATH, "r", encoding="utf-8") as fh:
                    _cache = json.load(fh)
            except (OSError, ValueError):
                _cache = {"fields": []}
        return _cache


def _field(fid: str) -> dict[str, Any]:
    f = next((x for x in _data()["fields"] if x["id"] == fid), None)
    if f is None:
        raise DemoError("Campo dimostrativo non trovato.")
    return f


def list_fields() -> list[dict[str, Any]]:
    out = []
    for f in _data()["fields"]:
        out.append({k: f.get(k) for k in ("id", "name", "crop", "place", "area_ha", "target", "acquisitions", "suggest", "hw")} |
                   {"indices": [{"id": k, "label": v["label"]} for k, v in f["indices"].items()], "demo": True})
    return out


def satellite_search(fid: str) -> dict[str, Any]:
    """Catalogo Sentinel-2 SIMULATO: le acquisizioni del campo più i passaggi ogni 5 giorni, con nuvolosità."""
    f = _field(fid)
    known = [a for a in f["acquisitions"] if a["type"] == "sentinel2"]
    rnd = random.Random(fid)
    latest = max((_dt.date.fromisoformat(a["date"]) for a in f["acquisitions"]), default=_dt.date(2026, 6, 1))
    scenes = list(known)
    for k in range(1, 7):
        d = latest - _dt.timedelta(days=5 * k - 2)
        if any(a["date"] == d.isoformat() for a in scenes):
            continue
        cloud = rnd.choice([0, 3, 8, 15, 35, 62, 88])
        scenes.append({"id": f"s2-{d.strftime('%m%d')}", "type": "sentinel2", "date": d.isoformat(), "cloud": cloud, "res_m": 10,
                       "factor": [round(0.8 + 0.03 * (6 - k), 2), 0.0], "usable": cloud < 40, "generated": True})
    for s in scenes:
        s.setdefault("usable", s.get("cloud", 0) < 40)
    scenes.sort(key=lambda s: s["date"], reverse=True)
    return {"ok": True, "field": fid, "provider": "Simulatore Sentinel-2 L2A (DEMO)", "scenes": scenes,
            "notice": "Catalogo simulato: date e nuvolosità sono inventate."}


def _acquisition(f: dict[str, Any], aid: str) -> dict[str, Any]:
    a = next((x for x in f["acquisitions"] if x["id"] == aid), None)
    if a is None:
        a = next((x for x in satellite_search(f["id"])["scenes"] if x["id"] == aid), None)
    if a is None:
        raise DemoError("Acquisizione non trovata.")
    if a.get("type") == "sentinel2" and a.get("cloud", 0) >= 40:
        raise DemoError(f"Scena del {a['date']} con nuvolosità {a['cloud']} %: scegline una più limpida.")
    return a


def _inside(ring: list[list[float]], x: float, y: float) -> bool:
    ins = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            ins = not ins
        j = i
    return ins


def index_values(f: dict[str, Any], index: str, acq: dict[str, Any]) -> list[Optional[float]]:
    g = f["grid"]
    if index not in f["indices"]:
        raise DemoError("Indice non disponibile per questo campo.")
    raw = base64.b64decode(f["indices"][index]["data"])
    a, b = acq.get("factor", [1.0, 0.0])
    out: list[Optional[float]] = []
    for v in raw:
        if index == "NDVI":
            nd = v / 254 * 1.2 - 0.2
            out.append(max(-0.2, min(1.0, a * nd + b)))
        else:
            out.append(None if v == 255 else float(v))
    return out


def build_prescription(fid: str, params: dict[str, Any]) -> tuple[bytes, dict[str, Any]]:
    f = _field(fid)
    acq = _acquisition(f, str(params.get("acquisition") or f["acquisitions"][0]["id"]))
    index = str(params.get("index") or "NDVI")
    try:
        k = int(params.get("classes", 3))
    except (TypeError, ValueError):
        k = 3
    if not 2 <= k <= 5:
        raise DemoError("Il numero di zone deve essere fra 2 e 5.")
    try:
        v_lo, v_hi = float(params.get("vol_low")), float(params.get("vol_high"))
    except (TypeError, ValueError):
        raise DemoError("Indica i due volumi di miscela (L/ha).")
    if not (0 < v_lo <= 2000 and 0 < v_hi <= 2000):
        raise DemoError("Volumi fuori campo (0–2000 L/ha).")
    direction = "down" if params.get("direction") == "down" else "up"
    thr = float(params.get("exclude_below") or 0) if index == "WEED" else 0.0

    g = f["grid"]
    vals = index_values(f, index, acq)
    cell_m = 10.0 if acq["type"] == "sentinel2" else 6.0
    step = max(1, int(round(cell_m / g["cell_m"])))
    cols, rows = math.ceil(g["cols"] / step), math.ceil(g["rows"] / step)
    lat0 = g["min_lat"] + g["rows"] * g["dlat"] / 2
    ring = f["boundary"]
    agg: list[Optional[float]] = []
    inside: list[bool] = []
    for r in range(rows):
        for c in range(cols):
            acc, n = 0.0, 0
            for rr in range(r * step, min(g["rows"], (r + 1) * step)):
                for cc in range(c * step, min(g["cols"], (c + 1) * step)):
                    v = vals[rr * g["cols"] + cc]
                    if v is not None:
                        acc += v
                        n += 1
            agg.append(acc / n if n else None)
            lon = g["min_lon"] + (c + 0.5) * step * g["dlon"]
            lat = g["min_lat"] + (r + 0.5) * step * g["dlat"]
            inside.append(_inside(ring, lon, lat))
    usable = sorted(v for v, ins in zip(agg, inside) if ins and v is not None and v >= thr)
    if len(usable) < k:
        raise DemoError("Troppe poche celle utili per questo numero di zone.")
    edges = [usable[int(len(usable) * q / k)] for q in range(1, k)]

    def cls_of(v: Optional[float]) -> int:
        if v is None:
            return 1
        if thr and v < thr:
            return 0
        return 1 + sum(v > e for e in edges)
    codes = [cls_of(v) for v in agg]
    # filtro di maggioranza 3×3 sulle celle interne (unità minima cartografabile)
    smooth = list(codes)
    for r in range(rows):
        for c in range(cols):
            i = r * cols + c
            if not inside[i]:
                continue
            votes: dict[int, int] = {}
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    rr, cc = r + dr, c + dc
                    if 0 <= rr < rows and 0 <= cc < cols and inside[rr * cols + cc]:
                        votes[codes[rr * cols + cc]] = votes.get(codes[rr * cols + cc], 0) + 1
            best = max(votes.items(), key=lambda kv: (kv[1], kv[0] == codes[i]))[0]
            if votes[best] >= 5:
                smooth[i] = best
    codes = smooth
    # valore medio dell'indice per classe → volume lineare
    sums: dict[int, list[float]] = {}
    for v, ins, cd in zip(agg, inside, codes):
        if ins and v is not None and cd > 0:
            sums.setdefault(cd, []).append(v)
    means = {cd: sum(vs) / len(vs) for cd, vs in sums.items()}
    lo_m, hi_m = min(means.values()), max(means.values())
    label_idx = f["indices"][index]["label"]
    zones = []
    for cd in range(1, k + 1):
        if cd not in means:
            continue
        t = (means[cd] - lo_m) / (hi_m - lo_m) if hi_m > lo_m else 0.5
        if direction == "down":
            t = 1 - t
        rate = v_lo + (v_hi - v_lo) * t
        vs = sums[cd]
        name = {2: ["Vigore basso", "Vigore alto"], 3: ["Vigore basso", "Vigore medio", "Vigore alto"]}.get(k, [])
        nm = name[cd - 1] if (index == "NDVI" and name) else f"Classe {cd}"
        if index == "WEED":
            nm = f"Infestanti {min(vs):.0f}–{max(vs):.0f} %"
        zones.append({"code": cd, "name": f"{nm} · {label_idx} {min(vs):.2f}–{max(vs):.2f}" if index == "NDVI" else nm,
                      "rate": round(rate, 1), "mean": round(means[cd], 3), "cells": len(vs)})
    if thr and any(cd == 0 and ins for cd, ins in zip(codes, inside)):
        zones.insert(0, {"code": 0, "name": f"Senza infestanti (< {thr:g} %) · non trattare", "rate": 0.0, "mean": None,
                         "cells": sum(1 for cd, ins in zip(codes, inside) if ins and cd == 0)})

    dlat, dlon = g["dlat"] * step, g["dlon"] * step
    crop = f["crop"]
    bnd = "".join(f'<PNT A="2" C="{lat:.7f}" D="{lon:.7f}"/>' for lon, lat in ring + [ring[0]])
    area_m2 = f["area_ha"] * 10000
    xml = ['<?xml version="1.0" encoding="UTF-8"?>\n<ISO11783_TaskData VersionMajor="4" VersionMinor="3" '
           'ManagementSoftwareManufacturer="Ultimo Metro DEMO (mappa simulata)" ManagementSoftwareVersion="1" DataTransferOrigin="1">',
           '<CTR A="CTR1" B="Cliente dimostrativo"/><FRM A="FRM1" B="Azienda agricola dimostrativa" I="CTR1"/>',
           f'<CTP A="CTP1" B={quoteattr(crop)}/>',
           f'<PFD A="PFD1" B="DEMO" C={quoteattr(f["name"])} D="{int(area_m2)}" E="CTR1" F="FRM1" G="CTP1"><PLN A="1" B="Confine"><LSG A="1">{bnd}</LSG></PLN></PFD>',
           '<VPN A="VPN1" B="0" C="0.01" D="2" E="L/ha"/>',
           f'<TSK A="TSK1" B={quoteattr(f["target"] + " · " + acq["date"])} C="CTR1" D="FRM1" E="PFD1" G="1">']
    for z in zones:
        xml.append(f'<TZN A="{z["code"]}" B={quoteattr(z["name"])}><PDV A="0001" B="{int(round(z["rate"] * 100))}" E="VPN1"/></TZN>')
    xml.append(f'<GRD A="{g["min_lat"]:.8f}" B="{g["min_lon"]:.8f}" C="{dlat:.9f}" D="{dlon:.9f}" E="{cols}" F="{rows}" G="GRD00001" I="1"/>')
    xml.append("</TSK></ISO11783_TaskData>\n")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("TASKDATA.XML", "".join(xml))
        zf.writestr("GRD00001.bin", bytes(codes))
    origin = {
        "kind": "demo", "demo": True, "field": fid, "name": f["name"], "crop": crop, "place": f["place"],
        "acquisition": acq, "index": index, "index_label": label_idx, "classes": len([z for z in zones if z["code"] > 0]),
        "vol_low": v_lo, "vol_high": v_hi, "direction": direction, "exclude_below": thr or None,
        "presc_cell_m": cell_m, "zones": zones, "target": f["target"], "hw": f.get("hw"),
        "rule": f"indice aggregato a {cell_m:g} m, {k} classi di uguale superficie, filtro di maggioranza 3×3, volume lineare "
                f"{v_lo:g}–{v_hi:g} L/ha" + (f", celle sotto {thr:g} % di infestanti non trattate" if thr else ""),
    }
    return buf.getvalue(), origin
