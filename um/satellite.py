"""Punto di integrazione per l'acquisizione diretta di immagini satellitari (non ancora collegato).

Oggi l'app riceve le mappe come file: prescrizioni ISOXML oppure mappe indice GeoJSON esportate da una
piattaforma che elabora immagini satellitari (NDVI, vigore, infestanti). Il download diretto richiede un
fornitore (ad es. Copernicus/Sentinel Hub, piattaforme agronomiche) con account, chiave API e una licenza
d'uso compatibile con un prodotto commerciale: nessuno di questi è configurato nel progetto.

Finché nessun fornitore è configurato, status() dichiara il simulatore dimostrativo (um/demo.py).
Per collegarne uno: implementare una classe con `fetch_index(boundary_lonlat, date, index) -> bytes GeoJSON`
che restituisca poligoni con una proprietà numerica, registrarla in PROVIDERS e leggere la chiave da una
variabile d'ambiente (mai nel codice). Il GeoJSON prodotto passa da geoimport.build come un file caricato.
"""

from __future__ import annotations

import os
from typing import Any, Protocol


class Provider(Protocol):
    name: str

    def fetch_index(self, boundary_lonlat: list[tuple[float, float]], date: str, index: str) -> bytes: ...


PROVIDERS: dict[str, Provider] = {}


DEMO_PROVIDER = "Simulatore DEMO (Sentinel-2 L2A e rilievi drone)"


def status() -> dict[str, Any]:
    name = os.environ.get("STILLA_SAT_PROVIDER") or os.environ.get("ULTIMO_METRO_SAT_PROVIDER", "")
    if name and name in PROVIDERS:
        return {"configured": True, "provider": name, "demo": False}
    # senza un fornitore reale l'app usa il simulatore (um/demo.py): catalogo di scene e mappe inventate
    return {"configured": True, "provider": DEMO_PROVIDER, "demo": True,
            "message": "Acquisizione simulata: scene Sentinel-2 e rilievi drone dimostrativi (dati inventati). "
                       "Un fornitore reale si collega impostando STILLA_SAT_PROVIDER."}
