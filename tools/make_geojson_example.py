#!/usr/bin/env python3
"""Genera static/data/esempio_ndvi.geojson: una mappa indice SINTETICA (dati di prova, non un campo reale).

Celle da 20 m dentro il campo dell'esempio 01, con un valore «NDVI» calcolato da una funzione regolare, più il
poligono di confine (role = boundary). Serve a provare l'import delle mappe indice senza file propri.
Uso:  python3 tools/make_geojson_example.py
"""

from __future__ import annotations

import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from make_examples import Frame, field_a, inside, noise_fn  # noqa: E402

OUT = os.path.join(os.path.dirname(HERE), "static", "data", "esempio_ndvi.geojson")


def main() -> None:
    fr = Frame(44.9120, 9.9840)
    ring = field_a(fr)
    cell = 20.0
    f = noise_fn(7)
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    cells = []
    x = math.floor(min(xs) / cell) * cell
    while x < max(xs):
        y = math.floor(min(ys) / cell) * cell
        while y < max(ys):
            if inside(ring, x + cell / 2, y + cell / 2):
                cells.append((x, y, f(x + cell / 2, y + cell / 2)))
            y += cell
        x += cell
    lo, hi = min(c[2] for c in cells), max(c[2] for c in cells)
    feats = []
    for x, y, v in cells:
        pts = [fr.ll(x, y), fr.ll(x + cell, y), fr.ll(x + cell, y + cell), fr.ll(x, y + cell)]
        coords = [[round(lon, 7), round(lat, 7)] for lat, lon in pts]
        coords.append(coords[0])
        ndvi = 0.25 + 0.6 * (v - lo) / (hi - lo)
        feats.append({"type": "Feature", "properties": {"NDVI": round(ndvi, 3)}, "geometry": {"type": "Polygon", "coordinates": [coords]}})
    b = [[round(lon, 7), round(lat, 7)] for lat, lon in (fr.ll(*p) for p in ring)]
    b.append(b[0])
    feats.append({"type": "Feature", "properties": {"role": "boundary", "name": "Campo Pomodoro Nord"},
                  "geometry": {"type": "Polygon", "coordinates": [b]}})
    data = {"type": "FeatureCollection", "name": "Mappa NDVI sintetica · dati di prova",
            "description": "Valori generati da una funzione: non provengono da immagini satellitari reali.", "features": feats}
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"{OUT}: {len(feats) - 1} celle")


if __name__ == "__main__":
    main()
