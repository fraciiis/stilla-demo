"""Fase 2 · tre ricettari operativi a partire dalle zone del campo e dai dati di etichetta inseriti dal tecnico.

Il progetto NON contiene un archivio di prodotti fitosanitari: prodotti, numeri di registrazione, finestre di
dose e di volume arrivano dall'etichetta ufficiale, copiati dal tecnico insieme alla fonte. Senza questi dati i
ricettari calcolano solo i volumi di miscela e segnalano le dosi come mancanti.

Regole di calcolo (tutte verificabili a mano):

* Volume di miscela per zona V_i: il rateo della prescrizione (L/ha), riportato dentro la finestra di volume
  dell'etichetta se indicata.
* Miscela unica nel serbatoio: la concentrazione c (L o kg di prodotto per L di miscela) è la stessa su tutto
  il campo, quindi la dose per ettaro di ogni zona è  d_i = c · V_i  (varia con il volume distribuito).
* Portata per ugello  q = V · v · s / 600  e pressione dalla curva dell'ugello  Q(p) = Q₃ · √(p / 3)  per gli
  ugelli con un solo punto di catalogo (engine.py / hardware.py): servono a verificare l'eseguibilità.

I tre ricettari differiscono per un criterio esplicito:

A · Aderente alla prescrizione: volumi variabili, dose media al centro della finestra di etichetta. Se i volumi
    sono troppo distanti perché un'unica miscela resti nella finestra in tutte le zone, A è segnato NON conforme.
B · Minimo prodotto entro etichetta: concentrazione minima che tiene ogni zona alla dose minima autorizzata (mai
    sotto). Se serve, riduce i volumi delle zone più intense finché nessuna supera la dose massima: perde un po'
    di aderenza spaziale ma resta sempre nelle condizioni d'impiego.
C · Rateo unico: un solo volume (media pesata) e dose al centro della finestra: per macchine senza rateo
    variabile, perde la variabilità.

L'efficacia agronomica non viene stimata: manca un modello validato. Al suo posto sono riportati indicatori
calcolati (aderenza alla prescrizione, quota di superficie entro le dosi di etichetta, eseguibilità sull'hardware).
"""

from __future__ import annotations

import math
from typing import Any, Optional

from .engine import ClassIn, evaluate, kpis
from .hardware import Catalog, HwConfig, num, resolve_chain

REQUIRED_LABEL = ("name", "reg_no", "source", "dose_min", "dose_max")
LABEL_FIELD_NAMES = {"name": "nome commerciale", "reg_no": "n. di registrazione", "source": "fonte (etichetta/banca dati)",
                     "dose_min": "dose minima", "dose_max": "dose massima"}

FORMULAS = [
    {"name": "Dose per zona con miscela unica", "expr": "d_i = c · V_i", "where": "recipes.py",
     "note": "c = concentrazione del serbatoio, V_i = volume di miscela della zona (L/ha)"},
    {"name": "Portata per ugello", "expr": "q = V · v · s / 600", "where": "engine.py · q_required",
     "note": "L/min con V in L/ha, v in km/h, s interasse in m"},
    {"name": "Curva portata/pressione (radice quadrata)", "expr": "Q(p) = Q₃ · √(p / 3)", "where": "hardware.py · Nozzle.from_product",
     "note": "usata per gli ugelli con un solo punto di catalogo; la pressione richiesta è p = 3 · (q / Q₃)²"},
]


class RecipeError(ValueError):
    pass


# --------------------------------------------------------------------------- prodotti

def clean_product(d: dict[str, Any]) -> dict[str, Any]:
    p = {
        "name": str(d.get("name", "") or "").strip()[:120],
        "reg_no": str(d.get("reg_no", "") or "").strip()[:40],
        "source": str(d.get("source", "") or "").strip()[:300],
        "checked_on": str(d.get("checked_on", "") or "").strip()[:20],
        "unit": "kg/ha" if str(d.get("unit", "")).startswith("kg") else "L/ha",
        "dose_min": num(d.get("dose_min")), "dose_max": num(d.get("dose_max")),
        "vol_min": num(d.get("vol_min")), "vol_max": num(d.get("vol_max")),
        "price": num(d.get("price")),
        "phi_days": str(d.get("phi_days", "") or "").strip()[:20],
        "max_treatments": str(d.get("max_treatments", "") or "").strip()[:20],
        "notes": str(d.get("notes", "") or "").strip()[:500],
    }
    problems = []
    missing = [LABEL_FIELD_NAMES[k] for k in REQUIRED_LABEL if p[k] in (None, "")]
    if p["dose_min"] is not None and p["dose_min"] <= 0:
        problems.append("la dose minima deve essere maggiore di zero")
    if p["dose_min"] is not None and p["dose_max"] is not None and p["dose_max"] < p["dose_min"]:
        problems.append("la dose massima è minore della minima")
    if p["vol_min"] is not None and p["vol_max"] is not None and p["vol_max"] < p["vol_min"]:
        problems.append("il volume massimo è minore del minimo")
    p["missing"] = missing
    p["problems"] = problems
    p["dose_ok"] = p["dose_min"] is not None and p["dose_max"] is not None and not problems
    return p


# --------------------------------------------------------------------------- calcolo

def _wmean(vals: list[float], w: list[float]) -> float:
    tw = sum(w) or 1.0
    return sum(v * x for v, x in zip(vals, w)) / tw


def _volume_window(products: list[dict[str, Any]]) -> tuple[Optional[float], Optional[float], Optional[str]]:
    lows = [p["vol_min"] for p in products if p["vol_min"] is not None]
    highs = [p["vol_max"] for p in products if p["vol_max"] is not None]
    lo = max(lows) if lows else None
    hi = min(highs) if highs else None
    if lo is not None and hi is not None and lo > hi:
        return None, None, f"Le finestre di volume dei prodotti non si sovrappongono ({lo:g} L/ha minimo > {hi:g} L/ha massimo): nessuna miscela unica rispetta tutte le etichette."
    return lo, hi, None


def _clamp(v: float, lo: Optional[float], hi: Optional[float]) -> float:
    if lo is not None and v < lo:
        return lo
    if hi is not None and v > hi:
        return hi
    return v


def _concentration(kind: str, p: dict[str, Any], vols: list[float], w: list[float]) -> tuple[Optional[float], list[str]]:
    """Concentrazione del serbatoio per un prodotto (unità di prodotto per litro di miscela)."""
    if not p["dose_ok"] or not vols:
        return None, []
    dmin, dmax = p["dose_min"], p["dose_max"]
    vmin, vmax = min(vols), max(vols)
    c_lo, c_hi = dmin / vmin, dmax / vmax              # intervallo che tiene tutte le zone dentro la finestra
    notes = []
    if kind == "risparmio":
        c = c_lo                                       # i volumi sono già stati limitati: nessuna zona oltre la dose massima
    else:                                              # aderente / uniforme: dose media al centro della finestra
        c = ((dmin + dmax) / 2.0) / (_wmean(vols, w) or 1.0)
        if c_lo <= c_hi + 1e-12:
            c = min(max(c, c_lo), c_hi)
        else:
            notes.append(f"{p['name']}: i volumi delle zone ({vmin:.0f}–{vmax:.0f} L/ha) sono troppo distanti perché un'unica miscela resti fra "
                         f"{dmin:g} e {dmax:g} {p['unit']} in tutte le zone: così com'è il ricettario esce dalle condizioni d'impiego.")
    return c, notes


def _hardware(task: Any, vols: dict[int, float], cfg: Optional[HwConfig], cat: Catalog) -> Optional[dict[str, Any]]:
    if cfg is None:
        return None
    chain = resolve_chain(cfg, cat)
    cin = [ClassIn(k.idx, vols.get(k.idx, 0.0) if (k.rate and k.rate > 0) else k.rate, k.area_ha) for k in task.classes]
    variable = len({round(v, 2) for v in vols.values() if v > 0}) > 1
    plans = evaluate(cin, cfg, chain, cat, variable_file=variable)
    k = kpis(cin, plans)
    return {"on_target_pct": k["on_target_pct"], "under_pct": k["under_pct"], "over_pct": k["over_pct"],
            "novra_pct": k.get("novra_pct", 0.0), "blockers": len(chain.blockers), "vra": chain.vra, "variable": variable}


def build(task: Any, zoning: dict[str, Any], products_in: list[dict[str, Any]], options: dict[str, Any],
          cfg: Optional[HwConfig], cat: Catalog) -> dict[str, Any]:
    ks = task.classes
    treated = [k for k in ks if k.rate and k.rate > 0]
    if not treated:
        raise RecipeError("L'operazione non contiene ratei da distribuire: non si possono costruire ricettari.")
    products = [clean_product(p) for p in (products_in or []) if str(p.get("name", "")).strip()]
    by_area = all(k.area_ha is not None for k in ks)
    w_all = {k.idx: (float(k.area_ha) if by_area else 1.0) for k in ks}
    cls_of = {z["i"]: z["cls"] for z in zoning.get("zones", [])}
    tank = num(options.get("tank_l"))
    objective = str(options.get("objective", "") or "").strip()[:200]

    vlo, vhi, vol_conflict = _volume_window(products)
    presc = {k.idx: float(k.rate) for k in treated}
    clamped = {i: _clamp(v, vlo, vhi) for i, v in presc.items()}
    w_tr = [w_all[i] for i in presc]

    defs = [
        ("aderente", "A", "Aderente alla prescrizione",
         "Segue la variabilità del campo: ogni zona riceve il volume della prescrizione, la dose media è al centro della finestra di etichetta.",
         "Massima aderenza alla mappa; richiede un impianto a rateo variabile."),
        ("risparmio", "B", "Minimo prodotto entro etichetta",
         "La miscela più diluita che tiene ogni zona alla dose minima autorizzata; se serve limita i volumi più alti perché nessuna zona superi la dose massima.",
         "Sempre dentro le condizioni d'impiego con il minimo prodotto, ma il margine sulla dose è nullo e può perdere un po' di aderenza alla mappa."),
        ("uniforme", "C", "Rateo unico",
         "Un solo volume per tutto il campo (media pesata della prescrizione) e dose al centro della finestra di etichetta.",
         "Eseguibile anche senza rateo variabile; perde la variabilità: alcune zone ricevono più, altre meno del necessario."),
    ]
    recipes = []
    for rid, letter, title, why, tradeoff in defs:
        capped = None
        if rid == "uniforme":
            v_u = _clamp(_wmean(list(presc.values()), w_tr), vlo, vhi)
            vols = {i: v_u for i in presc}
        else:
            vols = dict(clamped)
            ratios = [p["dose_max"] / p["dose_min"] for p in products if p["dose_ok"]]
            if rid == "risparmio" and ratios:
                # rapporto massimo fra i volumi compatibile con un'unica miscela: max/min ≤ dose_max/dose_min
                cap = min(vols.values()) * min(ratios)
                if max(vols.values()) > cap + 1e-9:
                    capped = cap
                    vols = {i: min(v, cap) for i, v in vols.items()}
        vlist = [vols[i] for i in presc]
        constraints: list[dict[str, str]] = []
        if vol_conflict:
            constraints.append({"level": "fail", "text": vol_conflict})
        n_clamped = sum(1 for i in presc if abs(clamped[i] - presc[i]) > 0.005)
        if capped is not None:
            n_cap = sum(1 for i in presc if clamped[i] > capped + 1e-9)
            constraints.append({"level": "warn", "text": f"Volume limitato a {capped:.0f} L/ha in {n_cap} zone: con un'unica miscela è il massimo che tiene tutte le zone dentro le dosi di etichetta."})
        if rid != "uniforme" and n_clamped:
            constraints.append({"level": "warn", "text": f"{n_clamped} zone portate dentro la finestra di volume dell'etichetta ({vlo if vlo is not None else '—'}–{vhi if vhi is not None else '—'} L/ha)."})

        prod_rows = []
        for p in products:
            c, notes = _concentration(rid, p, vlist, w_tr)
            for t in notes:
                constraints.append({"level": "fail", "text": t})
            if p["missing"] or p["problems"]:
                constraints.append({"level": "fail", "text": f"{p['name']}: dati di etichetta "
                                    + ("mancanti (" + ", ".join(p["missing"]) + ")" if p["missing"] else "non coerenti (" + "; ".join(p["problems"]) + ")")})
            doses = {i: (c * vols[i] if c is not None else None) for i in presc}
            within = None
            if c is not None:
                tw = sum(w_all[i] for i in presc) or 1.0
                ok_w = sum(w_all[i] for i in presc if p["dose_min"] - 1e-9 <= doses[i] <= p["dose_max"] + 1e-9)
                within = round(ok_w / tw * 100.0, 1)
            qty = sum(doses[i] * w_all[i] for i in presc) if (c is not None and by_area) else None
            prod_rows.append({
                "name": p["name"], "reg_no": p["reg_no"], "unit": p["unit"], "source": p["source"], "checked_on": p["checked_on"],
                "dose_min": p["dose_min"], "dose_max": p["dose_max"],
                "concentration": round(c, 6) if c is not None else None,
                "per_tank": round(c * tank, 2) if (c is not None and tank) else None,
                "dose_mean": round(_wmean([doses[i] for i in presc], w_tr), 3) if c is not None else None,
                "dose_range": [round(min(doses.values()), 3), round(max(doses.values()), 3)] if c is not None else None,
                "within_label_pct": within, "quantity": round(qty, 2) if qty is not None else None,
                "cost": round(qty * p["price"], 2) if (qty is not None and p["price"] is not None) else None,
                "price": p["price"], "phi_days": p["phi_days"], "max_treatments": p["max_treatments"],
                "missing": p["missing"], "problems": p["problems"],
            })
        if len(products) > 1:
            constraints.append({"level": "warn", "text": "Più prodotti nella stessa miscela: la miscibilità va verificata in etichetta (non è controllata dall'app)."})
        if not products:
            constraints.append({"level": "fail", "text": "Nessun prodotto con dati di etichetta: le dosi e le quantità di prodotto non sono calcolabili."})

        zones = []
        for k in ks:
            on = k.rate and k.rate > 0
            zones.append({
                "i": k.idx, "label": k.label, "area_ha": round(k.area_ha, 3) if k.area_ha is not None else None,
                "cls": cls_of.get(k.idx, "esclusa"), "rx_rate": k.rate,
                "volume": round(vols[k.idx], 2) if on else 0.0,
                "doses": [round(r["concentration"] * vols[k.idx], 3) if (on and r["concentration"] is not None) else None for r in prod_rows],
            })
        mixture = sum(vols[i] * w_all[i] for i in presc) if by_area else None
        liquid = sum(r["quantity"] for r in prod_rows if r["quantity"] is not None and r["unit"] == "L/ha") if by_area else None
        dev = _wmean([abs(vols[i] - presc[i]) / presc[i] for i in presc], w_tr) * 100.0
        costs = [r["cost"] for r in prod_rows]
        hw = _hardware(task, vols, cfg, cat)
        if hw and hw["variable"] and not hw["vra"]:
            constraints.append({"level": "warn", "text": "Richiede un rateo variabile che l'hardware attuale non esegue: vedi la fase Hardware."})
        within_all = [r["within_label_pct"] for r in prod_rows if r["within_label_pct"] is not None]
        complete = bool(products) and all(not r["missing"] and not r["problems"] for r in prod_rows) and not vol_conflict
        recipes.append({
            "id": rid, "letter": letter, "title": title, "objective": objective, "why": why, "tradeoff": tradeoff,
            "criterion": {"aderente": "aderenza spaziale", "risparmio": "minimo prodotto entro etichetta", "uniforme": "semplicità operativa"}[rid],
            "variable": len({round(v, 2) for v in vlist}) > 1,
            "volume_range": [round(min(vlist), 1), round(max(vlist), 1)],
            "volume_mean": round(_wmean(vlist, w_tr), 1),
            "products": prod_rows, "zones": zones,
            "totals": {
                "area_ha": round(sum(w_all[i] for i in presc), 2) if by_area else None,
                "mixture_l": round(mixture, 1) if mixture is not None else None,
                "water_l": round(mixture - liquid, 1) if (mixture is not None and liquid is not None) else None,
                "tank_loads": math.ceil(mixture / tank) if (mixture and tank) else None,
                "cost": round(sum(costs), 2) if costs and all(c is not None for c in costs) else None,
            },
            "metrics": {
                "deviation_pct": round(dev, 1),
                "within_label_pct": min(within_all) if within_all else None,
                "distinct_rates": len({round(v, 1) for v in vlist}),
                "hardware": hw,
            },
            "efficacy": {"estimated": False,
                         "text": "Efficacia non stimata: manca un modello agronomico validato. Usa gli indicatori calcolati e il giudizio del tecnico."},
            "reliability": ("Calcoli completi sui dati di etichetta inseriti: affidabili quanto la fonte indicata." if complete
                            else "Calcolo incompleto: mancano o non sono coerenti alcuni dati di etichetta."),
            "complete": complete,
            "constraints": constraints,
        })

    # differenze esplicite fra le proposte
    a, b, c = recipes
    for r in recipes:
        r["differences"] = []
    qa = [p["quantity"] for p in a["products"]]
    qb = [p["quantity"] for p in b["products"]]
    if qa and all(x is not None for x in qa + qb) and sum(qa) > 0:
        delta = (sum(qb) / sum(qa) - 1) * 100.0
        wa, wb = a["metrics"]["within_label_pct"], b["metrics"]["within_label_pct"]
        if delta <= -0.5:
            b["differences"].append(f"{-delta:.0f} % di prodotto in meno rispetto ad A.")
        elif delta >= 0.5:
            b["differences"].append(f"{delta:.0f} % di prodotto in più rispetto ad A: A non resta nelle dosi di etichetta in tutte le zone ({wa:.0f} % della superficie)."
                                    if wa is not None and wa < 100 else f"{delta:.0f} % di prodotto in più rispetto ad A.")
        if b["metrics"]["deviation_pct"] > a["metrics"]["deviation_pct"] + 0.5:
            b["differences"].append(f"Per restare in etichetta si scosta dalla prescrizione del {b['metrics']['deviation_pct']:.0f} % in media.")
        if wa is not None and wa >= 100:
            a["differences"].append("Più margine sulla dose rispetto a B; distribuzione identica alla prescrizione.")
    c["differences"].append(f"Scostamento medio dalla prescrizione {c['metrics']['deviation_pct']:.0f} % (A: {a['metrics']['deviation_pct']:.0f} %, B: {b['metrics']['deviation_pct']:.0f} %).")
    if a["variable"]:
        a["differences"].append(f"{a['metrics']['distinct_rates']} volumi diversi: serve il rateo variabile.")

    return {"ok": True, "task": task.index, "objective": objective, "tank_l": tank, "volume_window": [vlo, vhi],
            "products": products, "recipes": recipes, "formulas": FORMULAS,
            "notice": "Proposte calcolate su dati di etichetta inseriti dal tecnico: non sono raccomandazioni agronomiche né autorizzazioni all'uso."}


def recipe_rates(task: Any, recipe: dict[str, Any]) -> dict[int, float]:
    """Volumi di miscela per classe del ricettario (per valutazione hardware ed esportazione)."""
    return {z["i"]: float(z["volume"]) for z in recipe["zones"] if z["volume"] and z["volume"] > 0}
