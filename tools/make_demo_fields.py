#!/usr/bin/env python3
"""Genera static/demo/fields.json: campi DIMOSTRATIVI con mappe indice simulate da drone e satellite.

Dati inventati ma verosimili (riferimenti consultati: rilievi drone multispettrali in vigneto con GSD
1,8 cm/px RGB e 5–7 cm/px multispettrale; NDVI Sentinel-2 a 10 m da B4/B8; 2–3 zone di vigore):
* indice NDVI su celle da 2 m che coprono il campo e una fascia di contesto (strade, siepi, campi vicini);
* per il mais anche una mappa di copertura delle infestanti (%), come da rilievo drone post-emergenza;
* acquisizioni simulate: drone (data, sensore, GSD) e Sentinel-2 L2A (data, nuvolosità), con un fattore
  stagionale che modifica l'NDVI della data.

NESSUN dato proviene da immagini reali. Uso:  python3 tools/make_demo_fields.py
"""

from __future__ import annotations

import base64
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from make_examples import Frame, inside, noise_fn, polygon_area, rotate  # noqa: E402

OUT = os.path.join(os.path.dirname(HERE), "static", "demo", "fields.json")
CELL = 2.0          # m
MARGIN = 28.0       # m di contesto attorno al campo


def enc_ndvi(v: float) -> int:
    return max(0, min(254, int(round((v + 0.2) / 1.2 * 254))))


def smooth(v: float, a: float, b: float) -> float:
    t = max(0.0, min(1.0, (v - a) / (b - a)))
    return t * t * (3 - 2 * t)


FIELDS = [
    {
        "id": "vigneto_colle", "name": "Vigneto Colle Est", "crop": "Vite · Barbera", "place": "Oltrepò Pavese (PV)",
        "lat0": 44.9821, "lon0": 9.2415, "seed": 21,
        "shape": [(-140, -78), (128, -92), (146, 70), (-126, 88)], "rot": 8,
        "rows": {"spacing": 2.4, "angle": 98, "kind": "vine"}, "soil": [176, 150, 112], "canopy": [58, 104, 44],
        "target": "Peronospora della vite", "vol": [250, 375], "direction": "up",
        "hw": {"terminal": "4675204", "rate_control": "4679013", "actuator": "4063T95A0", "flowmeter": "46211P40000", "valve": "853T04A55", "pump": "97055201", "nozzles": ["AFC11003"], "boom_width": 10, "speed_nom": 6, "speed_min": 5, "speed_max": 7},
        "acq": [
            {"id": "drone-0618", "type": "drone", "date": "2026-06-18", "sensor": "Drone multispettrale 5 bande (simulato)", "gsd_cm": 5.3, "rgb_gsd_cm": 1.8, "factor": [1.0, 0.0]},
            {"id": "s2-0616", "type": "sentinel2", "date": "2026-06-16", "cloud": 4, "res_m": 10, "factor": [0.94, 0.02]},
            {"id": "s2-0527", "type": "sentinel2", "date": "2026-05-27", "cloud": 11, "res_m": 10, "factor": [0.78, 0.03]},
        ],
    },
    {
        "id": "mais_cascina", "name": "Mais Cascina Ovest", "crop": "Mais da granella", "place": "Pianura lodigiana (LO)",
        "lat0": 45.2518, "lon0": 9.4532, "seed": 7,
        "shape": [(-215, -145), (215, -145), (215, 145), (-215, 145)], "rot": 4,
        "rows": {"spacing": 0.75, "angle": 4, "kind": "row"}, "soil": [112, 92, 72], "canopy": [62, 118, 46],
        "target": "Infestanti dicotiledoni in post-emergenza", "vol": [160, 260], "direction": "up",
        "hw": {"terminal": "4675202", "flowmeter": "46211P40000", "valve": "853T04A55", "pump": "97055201", "nozzles": ["AFC11002"], "boom_width": 24, "boom_sections": 3},
        "weeds": True,
        "acq": [
            {"id": "drone-0605", "type": "drone", "date": "2026-06-05", "sensor": "Drone multispettrale + RGB (simulato) · stadio V6", "gsd_cm": 4.1, "rgb_gsd_cm": 1.5, "factor": [1.0, 0.0]},
            {"id": "s2-0603", "type": "sentinel2", "date": "2026-06-03", "cloud": 0, "res_m": 10, "factor": [0.92, 0.01]},
        ],
    },
    {
        "id": "frumento_podere", "name": "Frumento Podere Sud", "crop": "Frumento duro", "place": "Tavoliere (FG)",
        "lat0": 41.4562, "lon0": 15.5531, "seed": 33,
        "shape": [(-250, -170), (230, -195), (270, 60), (60, 200), (-235, 150)], "rot": -6,
        "rows": {"spacing": 24.0, "angle": 30, "kind": "tramline"}, "soil": [150, 128, 98], "canopy": [92, 132, 58],
        "target": "Septoria e ruggini del frumento", "vol": [170, 250], "direction": "up",
        "hw": {"terminal": "4675204", "rate_control": "4679013", "actuator": "4063T95A0", "flowmeter": "46211P40000", "valve": "853T04A55", "pump": "97055201", "nozzles": ["AFC11002"], "boom_width": 24},
        "acq": [
            {"id": "s2-0412", "type": "sentinel2", "date": "2026-04-12", "cloud": 1, "res_m": 10, "factor": [1.0, 0.0]},
            {"id": "s2-0328", "type": "sentinel2", "date": "2026-03-28", "cloud": 6, "res_m": 10, "factor": [0.82, -0.02]},
        ],
    },
    {
        "id": "pomodoro_nord", "name": "Pomodoro Campo Nord", "crop": "Pomodoro da industria", "place": "Piacentino (PC)",
        "lat0": 44.9934, "lon0": 9.8577, "seed": 52,
        "shape": [(-170, -110), (150, -125), (180, 95), (-150, 115)], "rot": -3,
        "rows": {"spacing": 1.5, "angle": 92, "kind": "bed"}, "soil": [140, 112, 84], "canopy": [56, 112, 50],
        "target": "Peronospora del pomodoro", "vol": [360, 540], "direction": "up",
        "hw": {"terminal": "4675202", "flowmeter": "46211P40000", "valve": "853T04A55", "pump": "97055201", "nozzles": ["AFC11004"], "boom_width": 18, "speed_nom": 6, "speed_min": 5, "speed_max": 8, "boom_sections": 3},
        "acq": [
            {"id": "drone-0702", "type": "drone", "date": "2026-07-02", "sensor": "Drone RGB + NIR (simulato)", "gsd_cm": 3.2, "rgb_gsd_cm": 1.2, "factor": [1.0, 0.0]},
            {"id": "s2-0630", "type": "sentinel2", "date": "2026-06-30", "cloud": 2, "res_m": 10, "factor": [0.95, 0.01]},
        ],
    },
]


def vigor(f: dict, x: float, y: float, base) -> float:
    """NDVI del campo: struttura a grande scala + elementi tipici della coltura."""
    v = 0.6 + 0.11 * base(x, y)
    if f["id"] == "vigneto_colle":
        v += 0.12 * (y / 90.0)                                           # pendio: più vigore a valle (nord)
        v -= 0.25 * math.exp(-((x - 95) ** 2 + (y + 55) ** 2) / (2 * 30 ** 2))   # affioramento sassoso
    elif f["id"] == "mais_cascina":
        v -= 0.33 * math.exp(-(((x + 90) / 70) ** 2 + ((y - 40) / 42) ** 2))     # ristagno idrico
        v -= 0.12 * math.exp(-((x * 0.4 + y - 20) / 26) ** 2)                     # paleoalveo sabbioso
    elif f["id"] == "frumento_podere":
        v += 0.08 * math.sin(x / 55.0) * math.cos(y / 70.0)
        v -= 0.18 * math.exp(-((x - 120) ** 2 + (y - 90) ** 2) / (2 * 45 ** 2))   # carenza di azoto
    elif f["id"] == "pomodoro_nord":
        v -= 0.22 * math.exp(-((x + 60) ** 2 + (y + 40) ** 2) / (2 * 28 ** 2))    # focolaio
        v += 0.06 * (x / 170.0)
    return max(0.12, min(0.9, v))


def context(f: dict, x: float, y: float, ring, rnd_noise) -> float:
    """Fuori dal campo: strada sterrata, siepe e appezzamenti vicini."""
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    if y < min(ys) - 10 and y > min(ys) - 16:
        return 0.06                                      # capezzagna / strada
    if x > max(xs) + 8 and x < max(xs) + 16:
        return 0.82 + 0.05 * rnd_noise(x, y)             # siepe
    return 0.32 + 0.2 * rnd_noise(x * 1.7, y * 1.3)      # campi vicini


def weeds(x: float, y: float, rng_spots, edge_d: float) -> float:
    w = 0.0
    for sx, sy, r, a in rng_spots:
        w += a * math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / (2 * r * r))
    w += 18.0 * math.exp(-edge_d / 9.0)                  # capezzagne più infestate
    return max(0.0, min(60.0, w))


def edge_distance(ring, x: float, y: float) -> float:
    best = 1e9
    for i in range(len(ring)):
        (x1, y1), (x2, y2) = ring[i], ring[(i + 1) % len(ring)]
        dx, dy = x2 - x1, y2 - y1
        t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)))
    return best


def build(f: dict) -> dict:
    fr = Frame(f["lat0"], f["lon0"])
    ring = rotate(f["shape"], f["rot"])
    base = noise_fn(f["seed"])
    ctx_noise = noise_fn(f["seed"] + 100)
    rnd = random.Random(f["seed"])
    spots = [(rnd.uniform(-180, 180), rnd.uniform(-120, 120), rnd.uniform(10, 26), rnd.uniform(20, 45)) for _ in range(6)]
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    minx, miny = math.floor((min(xs) - MARGIN) / CELL) * CELL, math.floor((min(ys) - MARGIN) / CELL) * CELL
    cols = int(math.ceil((max(xs) + MARGIN - minx) / CELL))
    rows = int(math.ceil((max(ys) + MARGIN - miny) / CELL))
    nd = bytearray()
    wd = bytearray()
    inside_n = 0
    for r in range(rows):                           # riga 0 a sud, colonne da ovest
        for c in range(cols):
            x, y = minx + (c + 0.5) * CELL, miny + (r + 0.5) * CELL
            ins = inside(ring, x, y)
            if ins:
                inside_n += 1
                v = vigor(f, x, y, base)
                if f.get("weeds"):
                    w = weeds(x, y, spots, edge_distance(ring, x, y))
                    v = min(0.9, v + w / 400.0)       # le infestanti alzano un po' l'NDVI nell'interfila
                    wd.append(int(round(w)))
            else:
                v = context(f, x, y, ring, ctx_noise)
                if f.get("weeds"):
                    wd.append(255)
            nd.append(enc_ndvi(v))
    lat_min, lon_min = fr.ll(minx, miny)
    lat_max, lon_max = fr.ll(minx + cols * CELL, miny + rows * CELL)
    boundary = [[round(lon, 7), round(lat, 7)] for lat, lon in (fr.ll(*p) for p in ring)]
    out = {
        "id": f["id"], "name": f["name"], "crop": f["crop"], "place": f["place"], "target": f["target"],
        "area_ha": round(polygon_area(ring) / 10000.0, 2), "boundary": boundary,
        "grid": {"cols": cols, "rows": rows, "cell_m": CELL, "min_lon": round(lon_min, 8), "min_lat": round(lat_min, 8),
                 "dlon": (lon_max - lon_min) / cols, "dlat": (lat_max - lat_min) / rows},
        "indices": {"NDVI": {"label": "NDVI", "encoding": "uint8: (NDVI+0.2)/1.2*254", "data": base64.b64encode(bytes(nd)).decode()}},
        "rows": f["rows"], "soil": f["soil"], "canopy": f["canopy"],
        "suggest": {"vol": f["vol"], "direction": f["direction"]}, "hw": f["hw"],
        "acquisitions": f["acq"],
        "demo": True,
    }
    if f.get("weeds"):
        out["indices"]["WEED"] = {"label": "Copertura infestanti (%)", "encoding": "uint8: percentuale, 255 = fuori campo",
                                  "data": base64.b64encode(bytes(wd)).decode()}
    return out


def main() -> None:
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    data = {"notice": "Campi e mappe DIMOSTRATIVI generati da tools/make_demo_fields.py: dati inventati, non immagini reali.",
            "fields": [build(f) for f in FIELDS]}
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    for f in data["fields"]:
        print(f"{f['id']}: {f['grid']['cols']}×{f['grid']['rows']} celle, {f['area_ha']} ha")
    print(OUT, os.path.getsize(OUT) // 1024, "KB")


if __name__ == "__main__":
    main()
