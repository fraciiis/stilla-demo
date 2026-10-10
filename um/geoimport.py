"""Fase 1 · mappe indice (es. NDVI o vigore esportati da piattaforme satellitari) in GeoJSON → prescrizione ISOXML.

Solo libreria standard. Il GeoJSON deve essere in WGS84 (gradi, come da RFC 7946) e contenere poligoni con una
proprietà numerica. Le coordinate proiettate (UTM ecc.) vengono rifiutate: servirebbe una libreria di
riproiezione che il progetto non usa.

Conversione (regola dichiarata, scelta dal tecnico):
1. i poligoni vengono raggruppati in N classi di uguale superficie secondo il valore dell'indice;
2. a ogni classe viene assegnato un volume di miscela con una regola lineare fra due valori scelti dal tecnico
   (volume per la classe con indice più basso e per quella più alto; direzione invertibile);
3. il risultato è un TASKDATA.XML con il confine del campo (poligono con proprietà role=boundary oppure
   inviluppo convesso dei poligoni, dichiarato come stima) e una zona TZN per classe.

Il file prodotto passa poi dallo stesso lettore ISOXML degli altri file: mappa, hardware ed esportazione
funzionano allo stesso modo.
"""

from __future__ import annotations

import io
import json
import math
import zipfile
from struct import error as struct_error
from typing import Any, Optional

from . import shapefile

M_PER_DEG = 111_320.0
MAX_FEATURES = 5000
BOUNDARY_KEYS = ("role", "type", "tipo", "ruolo", "kind")
BOUNDARY_VALUES = {"boundary", "confine", "field", "campo", "perimetro", "perimeter"}


class GeoImportError(ValueError):
    pass


def _polys(geom: dict[str, Any], utm: Optional[tuple[int, bool]] = None) -> list[list[list[tuple[float, float]]]]:
    t = (geom or {}).get("type")
    coords = (geom or {}).get("coordinates")
    if t == "Polygon":
        groups = [coords]
    elif t == "MultiPolygon":
        groups = coords
    else:
        return []
    out = []
    for poly in groups or []:
        rings = []
        for ring in poly or []:
            pts = []
            for p in ring or []:
                if not (isinstance(p, (list, tuple)) and len(p) >= 2):
                    raise GeoImportError("Coordinate non valide nel GeoJSON.")
                lon, lat = float(p[0]), float(p[1])
                if utm:
                    lon, lat = shapefile.utm_to_lonlat(lon, lat, *utm)
                if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                    raise GeoImportError("Le coordinate non sono in gradi WGS84 (sembrano proiettate, ad es. UTM): esporta il GeoJSON in EPSG:4326.")
                pts.append((lon, lat))
            if len(pts) >= 4 and pts[0] == pts[-1]:
                pts = pts[:-1]
            if len(pts) >= 3:
                rings.append(pts)
        if rings:
            out.append(rings)
    return out


def _load(raw: bytes) -> list[dict[str, Any]]:
    utm: Optional[tuple[int, bool]] = None
    if shapefile.is_shapefile_zip(raw):
        try:
            data: Any = {"type": "FeatureCollection", "features": shapefile.read_zip(raw)}
        except (shapefile.ShapefileError, zipfile.BadZipFile, struct_error) as exc:
            raise GeoImportError(str(exc) or "Shapefile non leggibile.")
    else:
        try:
            data = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError):
            raise GeoImportError("Il file non è un GeoJSON né uno shapefile (.zip) leggibile.")
    if isinstance(data, dict) and data.get("type") == "Feature":
        data = {"type": "FeatureCollection", "features": [data]}
    if not (isinstance(data, dict) and data.get("type") == "FeatureCollection" and isinstance(data.get("features"), list)):
        raise GeoImportError("Serve una FeatureCollection GeoJSON con poligoni.")
    crs = ((data.get("crs") or {}).get("properties") or {}).get("name", "")
    if crs:
        try:
            utm = shapefile.utm_from_crs(crs)
        except shapefile.ShapefileError as exc:
            raise GeoImportError(str(exc))
    feats = data["features"]
    if len(feats) > MAX_FEATURES:
        raise GeoImportError(f"Troppi poligoni ({len(feats)}): il massimo è {MAX_FEATURES}.")
    out = []
    for f in feats:
        if not isinstance(f, dict):
            continue
        polys = _polys(f.get("geometry") or {}, utm)
        if polys:
            out.append({"polys": polys, "props": f.get("properties") or {}})
    if not out:
        raise GeoImportError("Il GeoJSON non contiene poligoni.")
    return out


def _is_boundary(props: dict[str, Any]) -> bool:
    return any(str(props.get(k, "")).strip().lower() in BOUNDARY_VALUES for k in BOUNDARY_KEYS)


def _area_m2(rings: list[list[tuple[float, float]]], lat0: float) -> float:
    k = math.cos(math.radians(lat0)) * M_PER_DEG

    def ring_a(r: list[tuple[float, float]]) -> float:
        a = 0.0
        for i in range(len(r)):
            x1, y1 = r[i][0] * k, r[i][1] * M_PER_DEG
            x2, y2 = r[(i + 1) % len(r)][0] * k, r[(i + 1) % len(r)][1] * M_PER_DEG
            a += x1 * y2 - x2 * y1
        return abs(a) / 2.0
    return max(0.0, ring_a(rings[0]) - sum(ring_a(r) for r in rings[1:]))


def _num(v: Any) -> float | None:
    try:
        x = float(str(v).replace(",", "."))
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def inspect(raw: bytes) -> dict[str, Any]:
    feats = _load(raw)
    zones = [f for f in feats if not _is_boundary(f["props"])]
    props: dict[str, list[float]] = {}
    for f in zones:
        for k, v in f["props"].items():
            x = _num(v) if not isinstance(v, bool) else None
            if x is not None:
                props.setdefault(k, []).append(x)
    usable = [{"name": k, "count": len(v), "min": round(min(v), 4), "max": round(max(v), 4)}
              for k, v in props.items() if len(v) >= max(2, int(0.8 * len(zones))) and max(v) > min(v)]
    usable.sort(key=lambda p: (-p["count"], p["name"]))
    return {"ok": True, "features": len(zones), "boundary": any(_is_boundary(f["props"]) for f in feats), "properties": usable}


def _hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts

    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _pln(rings: list[list[tuple[float, float]]], ptype: int, name: str) -> str:
    out = [f'<PLN A="{ptype}" B="{_esc(name)}">']
    for i, ring in enumerate(rings):
        out.append(f'<LSG A="{1 if i == 0 else 2}">')
        for lon, lat in ring + [ring[0]]:
            out.append(f'<PNT A="2" C="{lat:.7f}" D="{lon:.7f}"/>')
        out.append("</LSG>")
    out.append("</PLN>")
    return "".join(out)


def build(raw: bytes, filename: str, params: dict[str, Any]) -> tuple[bytes, dict[str, Any]]:
    feats = _load(raw)
    prop = str(params.get("property", "") or "")
    try:
        k = int(params.get("classes", 3))
    except (TypeError, ValueError):
        k = 3
    if not 2 <= k <= 6:
        raise GeoImportError("Il numero di classi deve essere fra 2 e 6.")
    v_lo, v_hi = _num(params.get("vol_low")), _num(params.get("vol_high"))
    if v_lo is None or v_hi is None or v_lo <= 0 or v_hi <= 0:
        raise GeoImportError("Indica i due volumi di miscela (L/ha) per la classe a indice più basso e per quella più alta.")
    if v_lo > 2000 or v_hi > 2000:
        raise GeoImportError("Volumi oltre 2000 L/ha: controlla i valori.")
    direction = "down" if params.get("direction") == "down" else "up"
    crop = str(params.get("crop", "") or "")[:60]
    field_name = str(params.get("field_name", "") or "").strip()[:60] or "Campo da mappa indice"

    boundary = next((f for f in feats if _is_boundary(f["props"])), None)
    zones = [f for f in feats if f is not boundary and not _is_boundary(f["props"])]
    vals = [(f, _num(f["props"].get(prop))) for f in zones]
    vals = [(f, v) for f, v in vals if v is not None]
    if len(vals) < 2:
        raise GeoImportError(f"La proprietà «{prop}» non ha valori numerici sufficienti.")
    all_pts = [p for f, _ in vals for poly in f["polys"] for p in poly[0]]
    lat0 = sum(p[1] for p in all_pts) / len(all_pts)
    items = [(f, v, sum(_area_m2(poly, lat0) for poly in f["polys"])) for f, v in vals]
    items.sort(key=lambda t: t[1])
    tot = sum(a for _, _, a in items) or 1.0
    groups: list[list[tuple[dict[str, Any], float, float]]] = [[] for _ in range(k)]
    acc = 0.0
    for it in items:
        c = min(k - 1, int((acc + it[2] / 2.0) / tot * k))
        groups[c].append(it)
        acc += it[2]
    groups = [g for g in groups if g]
    means = [sum(v * a for _, v, a in g) / (sum(a for _, _, a in g) or 1.0) for g in groups]
    m_lo, m_hi = min(means), max(means)

    if boundary is not None:
        b_rings = boundary["polys"][0]
        b_kind = "file"
    else:
        b_rings = [_hull(all_pts)]
        b_kind = "hull"
    area_b = _area_m2(b_rings, lat0)
    crop_attr = ' G="CTP1"' if crop else ""

    body = ['<?xml version="1.0" encoding="UTF-8"?>\n<ISO11783_TaskData VersionMajor="4" VersionMinor="3" '
            'ManagementSoftwareManufacturer="Stilla (da mappa indice GeoJSON)" ManagementSoftwareVersion="1" DataTransferOrigin="1">',
            '<CTR A="CTR1" B="Cliente"/><FRM A="FRM1" B="Azienda" I="CTR1"/>',
            f'<CTP A="CTP1" B="{_esc(crop)}"/>' if crop else "",
            f'<PFD A="PFD1" B="GEO" C="{_esc(field_name)}" D="{int(round(area_b))}" E="CTR1" F="FRM1"{crop_attr}>{_pln(b_rings, 1, "Confine")}</PFD>',
            '<VPN A="VPN1" B="0" C="0.01" D="2" E="L/ha"/>',
            f'<TSK A="TSK1" B="Prescrizione da {_esc(prop)}" C="CTR1" D="FRM1" E="PFD1" G="1">']
    classes_out = []
    for i, (g, m) in enumerate(zip(groups, means), 1):
        t = (m - m_lo) / (m_hi - m_lo) if m_hi > m_lo else 0.5
        if direction == "down":
            t = 1.0 - t
        rate = v_lo + (v_hi - v_lo) * t
        vmin, vmax = min(v for _, v, _ in g), max(v for _, v, _ in g)
        name = f"Classe {i} · {prop} {vmin:.3g}–{vmax:.3g}"
        plns = "".join(_pln(poly, 2, name) for f, _, _ in g for poly in f["polys"])
        body.append(f'<TZN A="{i}" B="{_esc(name)}"><PDV A="0001" B="{int(round(rate * 100))}" E="VPN1"/>{plns}</TZN>')
        classes_out.append({"class": i, "index_min": vmin, "index_max": vmax, "index_mean": round(m, 4), "rate": round(rate, 1),
                            "area_ha": round(sum(a for _, _, a in g) / 10000.0, 3), "polygons": sum(len(f["polys"]) for f, _, _ in g)})
    body.append("</TSK></ISO11783_TaskData>\n")
    xml = "".join(body)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("TASKDATA.XML", xml)
    origin = {"kind": "geojson", "filename": filename, "property": prop, "classes": len(groups), "vol_low": v_lo, "vol_high": v_hi,
              "direction": direction, "boundary": b_kind, "features": len(vals), "class_table": classes_out,
              "rule": "classi di uguale superficie per valore dell'indice; volume lineare fra i due valori scelti dal tecnico"}
    return buf.getvalue(), origin
