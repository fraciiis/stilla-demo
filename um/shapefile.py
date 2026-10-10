"""Lettura minima di Shapefile poligonali (zip con .shp, .dbf, .prj) e conversione UTM → WGS84. Solo libreria standard.

Supporta: poligoni (tipi 5, 15, 25), attributi numerici e testuali del .dbf, coordinate geografiche WGS84 oppure
UTM su WGS84/ETRS89 (fusi 1–60, nord e sud) riconosciute dal .prj o dal codice EPSG. Altri sistemi vengono
rifiutati con un messaggio esplicito.
"""

from __future__ import annotations

import io
import math
import re
import struct
import zipfile
from typing import Any, Optional


MAX_PART_BYTES = 60 * 1024 * 1024      # per file decompresso: protegge da archivi «bomba»


class ShapefileError(ValueError):
    pass


# --------------------------------------------------------------------------- UTM

def utm_to_lonlat(x: float, y: float, zone: int, north: bool = True) -> tuple[float, float]:
    """Trasversa di Mercatore inversa (ellissoide WGS84; ETRS89 coincide entro il metro)."""
    a, f, k0 = 6378137.0, 1 / 298.257223563, 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    x -= 500000.0
    if not north:
        y -= 10000000.0
    m = y / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    s, c, t = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    c1, t1 = ep2 * c * c, t * t
    n1 = a / math.sqrt(1 - e2 * s * s)
    r1 = a * (1 - e2) / (1 - e2 * s * s) ** 1.5
    d = x / (n1 * k0)
    lat = phi1 - (n1 * t / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
                                  + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / c
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    return math.degrees(lon0 + lon), math.degrees(lat)


def utm_from_crs(text: str) -> Optional[tuple[int, bool]]:
    """(fuso, emisfero nord) da un codice EPSG o da un WKT .prj; None se il sistema è geografico WGS84."""
    t = text.upper()
    m = re.search(r"EPSG[:\s]*(?::)?(\d{4,5})", t)
    if m:
        code = int(m.group(1))
        if code in (4326, 4258):
            return None
        if 32601 <= code <= 32660:
            return code - 32600, True
        if 32701 <= code <= 32760:
            return code - 32700, False
        if 25828 <= code <= 25838:
            return code - 25800, True
        raise ShapefileError(f"Sistema di riferimento EPSG:{code} non supportato: usa WGS84 (EPSG:4326) o UTM WGS84/ETRS89.")
    m = re.search(r"UTM[_ ]ZONE[_ ](\d{1,2})\s*([NS])?", t)
    if m:
        if not any(k in t for k in ("WGS_1984", "WGS 84", "WGS84", "ETRS", "D_ETRS_1989")):
            raise ShapefileError("Proiezione UTM su un datum diverso da WGS84/ETRS89: non supportata.")
        return int(m.group(1)), (m.group(2) or "N") != "S"
    if "CRS84" in t or "GCS_WGS_1984" in t or "WGS 84" in t or "WGS_1984" in t or "ETRS89" in t:
        return None
    raise ShapefileError("Sistema di riferimento non riconosciuto: esporta in WGS84 (EPSG:4326) o in UTM WGS84.")


# --------------------------------------------------------------------------- shapefile

def is_shapefile_zip(raw: bytes) -> bool:
    if not raw.startswith(b"PK"):
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            names = [n.lower() for n in zf.namelist()]
    except zipfile.BadZipFile:
        return False
    return any(n.endswith(".shp") for n in names) and not any(n.endswith("taskdata.xml") for n in names)


def _signed_area(ring: list[tuple[float, float]]) -> float:
    return sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring))) / 2.0


def _read_shp(data: bytes) -> list[list[list[tuple[float, float]]]]:
    if len(data) < 100 or struct.unpack(">i", data[0:4])[0] != 9994:
        raise ShapefileError("File .shp non valido.")
    shape_type = struct.unpack("<i", data[32:36])[0]
    if shape_type not in (5, 15, 25):
        raise ShapefileError("Lo shapefile non contiene poligoni (servono poligoni con un attributo numerico).")
    out = []
    pos = 100
    while pos + 8 <= len(data):
        length = struct.unpack(">i", data[pos + 4:pos + 8])[0] * 2
        rec = data[pos + 8:pos + 8 + length]
        pos += 8 + length
        if len(rec) < 44 or struct.unpack("<i", rec[0:4])[0] == 0:
            out.append([])
            continue
        nparts, npts = struct.unpack("<ii", rec[36:44])
        parts = list(struct.unpack(f"<{nparts}i", rec[44:44 + 4 * nparts]))
        base = 44 + 4 * nparts
        pts = [struct.unpack("<dd", rec[base + 16 * i:base + 16 * i + 16]) for i in range(npts)]
        polys: list[list[list[tuple[float, float]]]] = []
        for k, start in enumerate(parts):
            end = parts[k + 1] if k + 1 < nparts else npts
            ring = [(float(x), float(y)) for x, y in pts[start:end]]
            if len(ring) >= 4 and ring[0] == ring[-1]:
                ring = ring[:-1]
            if len(ring) < 3:
                continue
            if _signed_area(ring) < 0 or not polys:      # orario = anello esterno nello standard shapefile
                polys.append([ring])
            else:
                polys[-1].append(ring)
        out.append(polys)
    return out


def _read_dbf(data: bytes, encoding: str) -> list[dict[str, Any]]:
    if len(data) < 32:
        return []
    n = struct.unpack("<I", data[4:8])[0]
    hlen, rlen = struct.unpack("<HH", data[8:12])
    fields = []
    pos = 32
    while pos + 32 <= hlen and data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b"\x00")[0].decode("ascii", "ignore").strip()
        ftype = chr(data[pos + 11])
        flen = data[pos + 16]
        fields.append((name, ftype, flen))
        pos += 32
    rows = []
    for i in range(n):
        rec = data[hlen + i * rlen:hlen + (i + 1) * rlen]
        if not rec:
            break
        off = 1
        row: dict[str, Any] = {}
        for name, ftype, flen in fields:
            raw = rec[off:off + flen]
            off += flen
            txt = raw.decode(encoding, "replace").strip()
            if ftype in ("N", "F"):
                try:
                    row[name] = float(txt) if txt else None
                except ValueError:
                    row[name] = None
            else:
                row[name] = txt
        rows.append(row)
    return rows


def read_zip(raw: bytes) -> list[dict[str, Any]]:
    """Feature in formato GeoJSON (coordinate lon/lat WGS84) da uno zip di shapefile."""
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        names = {n.lower(): n for n in zf.namelist()}
        shp = next((n for n in names if n.endswith(".shp")), None)
        if shp is None:
            raise ShapefileError("Nello zip manca il file .shp.")
        stem = shp[:-4]
        for ext in (".shp", ".dbf", ".prj", ".cpg"):
            if (stem + ext) in names and zf.getinfo(names[stem + ext]).file_size > MAX_PART_BYTES:
                raise ShapefileError("Shapefile troppo grande una volta decompresso.")
        read = lambda ext: zf.read(names[stem + ext]) if (stem + ext) in names else None   # noqa: E731
        shp_b, dbf_b, prj_b, cpg_b = read(".shp"), read(".dbf"), read(".prj"), read(".cpg")
    enc = (cpg_b or b"").decode("ascii", "ignore").strip() or "latin-1"
    if enc.upper() in ("UTF8", "UTF-8"):
        enc = "utf-8"
    try:
        "".encode(enc)
    except LookupError:
        enc = "latin-1"
    geoms = _read_shp(shp_b)
    attrs = _read_dbf(dbf_b, enc) if dbf_b else [{} for _ in geoms]
    utm = utm_from_crs(prj_b.decode("latin-1", "ignore")) if prj_b else None
    feats = []
    for g, a in zip(geoms, attrs + [{}] * (len(geoms) - len(attrs))):
        if not g:
            continue
        coords = []
        for poly in g:
            rings = []
            for ring in poly:
                pts = [list(utm_to_lonlat(x, y, *utm)) if utm else [x, y] for x, y in ring]
                rings.append(pts + [pts[0]])
            coords.append(rings)
        feats.append({"type": "Feature", "properties": a, "geometry": {"type": "MultiPolygon", "coordinates": coords}})
    if not feats:
        raise ShapefileError("Lo shapefile non contiene poligoni leggibili.")
    return feats
