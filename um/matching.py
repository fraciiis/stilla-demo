"""Fasi 4 e 5 · confronto fra i requisiti del ricettario scelto e l'hardware disponibile, poi componentistica ARAG.

Il confronto non guarda la sola presenza dei componenti: rilancia il motore idraulico (engine.py) con i volumi
del ricettario e confronta portate, pressioni e campi di misura con i dati tecnici del catalogo.

Livelli (soglie dichiarate, modificabili qui):
* adeguata      nessun requisito fallito, almeno il 95 % della superficie trattata entro tolleranza;
* parziale      eseguibile, ma con requisiti non garantiti o tra il 60 e il 95 % entro tolleranza;
* insufficiente blocchi della catena, rateo variabile richiesto e assente, o meno del 60 % entro tolleranza.

Le proposte ARAG vengono SOLO dal catalogo (static/data/arag_catalog.json) e ognuna è verificata rilanciando il
motore con la configurazione modificata: il guadagno mostrato è calcolato, non dichiarato.
"""

from __future__ import annotations

import math
from dataclasses import replace
from typing import Any, Optional

from .engine import ClassIn, Plan, _compress, evaluate, kpis, q_required, suggest
from .hardware import Catalog, Chain, HwConfig, resolve_chain

OK_PCT, PARTIAL_PCT = 95.0, 60.0
SLOTS = {"extras": "Sensori e sezioni", "terminal": "Terminale", "rate_control": "Controllo rateo", "ecu": "Centralina", "actuator": "Attuatore / portaugello",
         "flowmeter": "Flussimetro", "valve": "Valvola di regolazione", "pump": "Pompa", "nozzles": "Ugelli"}


def _classes(task: Any, rates: Optional[dict[int, float]]) -> list[ClassIn]:
    out = []
    for k in task.classes:
        r = k.rate
        if rates is not None and k.rate and k.rate > 0:
            r = rates.get(k.idx, k.rate)
        out.append(ClassIn(k.idx, r, k.area_ha))
    return out


def _run(cin: list[ClassIn], cfg: HwConfig, cat: Catalog) -> tuple[Chain, list[Plan], dict[str, Any]]:
    chain = resolve_chain(cfg, cat)
    variable = len({round(c.rate, 2) for c in cin if c.rate and c.rate > 0}) > 1
    plans = evaluate(cin, cfg, chain, cat, variable_file=variable)
    return chain, plans, kpis(cin, plans)


def _cell_m(task: Any) -> float:
    g = getattr(task, "grid", None)
    if g is not None and g.dlat:
        return max(1.0, g.dlat * 111_320.0)
    return 10.0                                  # zone poligonali: risoluzione tipica di una prescrizione


def _extras(cfg: HwConfig, cat: Catalog) -> tuple[int, set[str]]:
    secs = cfg.boom_sections or 0
    measures: set[str] = set()
    for code in cfg.extras:
        p = cat.get(code) or {}
        c = p.get("capabilities") or {}
        if p.get("category") == "section_valves" and c.get("sections"):
            secs = max(secs, int(c["sections"]))
        if p.get("category") == "sensor" and c.get("measures"):
            measures.add(str(c["measures"]))
    return secs, measures


def _delivered(cin: list[ClassIn], plans: list[Plan]) -> dict[int, Optional[float]]:
    """Volume effettivo per zona. Senza rateo variabile la macchina distribuisce un solo volume (media pesata)."""
    tr = [(c, p) for c, p in zip(cin, plans) if c.rate and c.rate > 0]
    w = [(c.area or 1.0) for c, _ in tr]
    uni = sum(c.rate * x for (c, _), x in zip(tr, w)) / (sum(w) or 1.0) if tr else None
    out: dict[int, Optional[float]] = {}
    for c, p in zip(cin, plans):
        if not (c.rate and c.rate > 0):
            out[c.idx] = None
        elif p.status == "novra":
            out[c.idx] = uni
        else:
            out[c.idx] = p.delivered
    return out


def requirements(cin: list[ClassIn], cfg: HwConfig, cat: Catalog, cell_m: float = 10.0) -> dict[str, Any]:
    chain, plans, k = _run(cin, cfg, cat)
    treated = [i for i, c in enumerate(cin) if c.rate and c.rate > 0]
    rates = [cin[i].rate for i in treated]
    variable = len({round(r, 2) for r in rates}) > 1
    rows: list[dict[str, Any]] = []

    def row(rid: str, label: str, required: str, available: str, status: str, detail: str = "", advisory: bool = False) -> None:
        rows.append({"id": rid, "label": label, "required": required, "available": available, "status": status, "detail": detail,
                     "advisory": advisory})

    row("tc", "Task Controller ISOBUS", "sì: il ricettario arriva al terminale come file ISOXML",
        chain.names.get("Terminale", "nessun terminale"), "ok" if chain.task_controller else "fail",
        "" if chain.task_controller else (chain.blockers[0] if chain.blockers else ""))
    if variable:
        row("vra", "Rateo variabile", f"{len({round(r, 1) for r in rates})} volumi diversi",
            "sì" + (" (PWM per ugello)" if chain.pwm else " (regolazione a pressione)") if chain.vra else "no",
            "ok" if chain.vra else "fail", "" if chain.vra else "Serve Flowtron oppure valvola di regolazione + flussimetro.")
    else:
        row("vra", "Rateo variabile", "non richiesto (rateo unico)", "sì" if chain.vra else "no", "ok")
    pct = k["on_target_pct"]
    row("rates", f"Volumi eseguibili entro ±{cfg.tolerance_pct:g} %", f"{min(rates):.0f}–{max(rates):.0f} L/ha",
        f"{pct:.0f} % della superficie trattata", "ok" if pct >= OK_PCT else ("partial" if pct >= PARTIAL_PCT else "fail"),
        f"sotto-dosato {k['under_pct']:.0f} % · sovra-dosato {k['over_pct']:.0f} %" + (f" · rateo variabile non eseguibile {k.get('novra_pct', 0):.0f} %" if k.get("novra_pct") else ""))
    # pressioni effettivamente richieste dal piano (curva dell'ugello, √p per gli ugelli stimati)
    ps = [plans[i].pressure for i in treated if plans[i].pressure is not None]
    if ps:
        lo, hi = min(ps), max(ps)
        inside = chain.p_lo - 1e-6 <= lo and hi <= chain.p_hi + 1e-6
        row("pressure", "Pressione di lavoro", f"{lo:.1f}–{hi:.1f} bar", f"finestra {chain.p_lo:.1f}–{chain.p_hi:.1f} bar",
            "ok" if inside else "partial", "" if inside else "Alcune zone sono al limite della finestra di pressione.")
    # portata totale della barra (q per ugello × numero di ugelli) contro flussimetro e pompa
    flows = []
    for i in treated:
        p = plans[i]
        if p.delivered and p.speed:
            flows.append(q_required(p.delivered, p.speed, cfg.spacing) * cfg.n_nozzles)
    if flows:
        fmin, fmax = min(flows), max(flows)
        if chain.meter_range:
            mlo, mhi = chain.meter_range
            fits = mlo <= fmin and fmax <= mhi
            row("meter", "Campo del flussimetro", f"{fmin:.0f}–{fmax:.0f} L/min sulla barra", f"{mlo:g}–{mhi:g} L/min",
                "ok" if fits else "partial", "" if fits else "La portata di barra esce dal campo di misura dichiarato: la regolazione perde precisione.")
        elif cfg.flowmeter:
            row("meter", "Campo del flussimetro", f"{fmin:.0f}–{fmax:.0f} L/min", "campo non indicato in catalogo", "unknown")
        if chain.pump_flow:
            fits = chain.pump_flow >= fmax
            row("pump", "Portata della pompa", f"almeno {fmax:.0f} L/min alla barra", f"{chain.pump_flow:g} L/min nominali",
                "ok" if fits else "fail", "Valore nominale: il ritorno per l'agitazione richiede margine, da verificare sull'impianto.")
        else:
            row("pump", "Portata della pompa", f"almeno {fmax:.0f} L/min alla barra", "pompa non indicata", "unknown")
    switch = any("switch" in plans[i].flags for i in treated)
    if switch:
        row("switch", "Commutazione fra ugelli", "il piano usa più di un ugello", f"{chain.ways} vie · SELETRON" if chain.ways > 1 else "portaugello singolo",
            "ok" if len(chain.nozzles) > 1 else "partial")
    # sezioni: la barra deve chiudere almeno con la risoluzione delle zone (celle della prescrizione)
    need_sec = max(1, min(13, math.ceil(cfg.boom_width / max(1.0, cell_m))))
    secs, measures = _extras(cfg, cat)
    term_max = (cat.caps(cfg.terminal) or {}).get("sections")
    if chain.individual_nozzle:
        row("sections", "Sezioni di barra", f"almeno {need_sec} (barra {cfg.boom_width:g} m, zone da {cell_m:.0f} m)",
            "chiusura ugello per ugello", "ok")
    elif secs:
        eff = min(secs, int(term_max)) if term_max else secs
        row("sections", "Sezioni di barra", f"almeno {need_sec} (barra {cfg.boom_width:g} m, zone da {cell_m:.0f} m)",
            f"{eff} sezioni" + (f" (terminale fino a {term_max})" if term_max else ""), "ok" if eff >= need_sec else "partial",
            "" if eff >= need_sec else "Con meno sezioni i bordi delle zone ricevono il volume della zona vicina.")
    else:
        row("sections", "Sezioni di barra", f"almeno {need_sec} (barra {cfg.boom_width:g} m, zone da {cell_m:.0f} m)",
            "numero di sezioni non indicato", "unknown", "Indica le sezioni della macchina nel pannello hardware (Sezioni e sensori).")
    if variable:
        has_p = "pressure" in measures or chain.pwm
        row("sensors", "Sensori per il rateo variabile", "pressione di barra e velocità",
            ", ".join(sorted({"pressure": "pressione", "speed": "velocità radar", "level": "livello", "wind": "vento"}.get(m, m) for m in measures))
            + ("" if measures else "velocità dal GPS del terminale") if measures else "velocità dal GPS del terminale",
            "ok" if has_p else "partial", "" if has_p else "Consigliato: senza sensore di pressione la regolazione non è verificabile durante il lavoro.",
            advisory=True)
    else:
        row("sensors", "Sensori", "velocità (GPS del terminale)", "presente", "ok")

    fails = [r for r in rows if r["status"] == "fail"]
    partial = [r for r in rows if r["status"] == "partial" and not r.get("advisory")]
    if chain.blockers or fails:
        level = "insufficiente"
    elif partial:
        level = "parziale"
    else:
        level = "adeguata"
    text = {
        "adeguata": "La componentistica disponibile esegue il ricettario con la precisione richiesta.",
        "parziale": "Il ricettario è eseguibile, ma alcune funzioni o livelli di precisione non sono garantiti.",
        "insufficiente": "La componentistica disponibile non esegue correttamente il ricettario: non è pronto per l'esecuzione.",
    }[level]
    return {"level": level, "text": text, "rows": rows, "kpi": k, "chain": chain, "plans": plans,
            "delivered": _delivered(cin, plans),
            "blockers": chain.blockers, "warnings": chain.warnings,
            "thresholds": {"ok_pct": OK_PCT, "partial_pct": PARTIAL_PCT}}


def match(task: Any, cfg: HwConfig, cat: Catalog, rates: Optional[dict[int, float]]) -> dict[str, Any]:
    r = requirements(_classes(task, rates), cfg, cat, _cell_m(task))
    return {k: v for k, v in r.items() if k not in ("chain", "plans")}


# --------------------------------------------------------------------------- proposta ARAG

def _product(cat: Catalog, code: str) -> dict[str, Any]:
    p = cat.get(code) or {}
    return {"code": p.get("code", code), "name": p.get("name", code), "short": p.get("short", ""),
            "specs": p.get("specs", ""), "official_url": p.get("official_url", ""), "category": p.get("category", ""),
            "demo": bool(p.get("demo"))}


def _candidates(cfg: HwConfig, base: dict[str, Any], cin: list[ClassIn], cat: Catalog) -> list[tuple[dict[str, Any], str]]:
    """Configurazioni alternative da provare: (modifiche, requisito interessato)."""
    chain: Chain = base["chain"]
    rows = {r["id"]: r for r in base["rows"]}
    prods = list(cat.products.values())
    out: list[tuple[dict[str, Any], str]] = []
    if rows.get("tc", {}).get("status") == "fail" or any("IBX" in b for b in chain.blockers):
        for p in prods:
            if p.get("category") == "controller" and (p.get("capabilities") or {}).get("task_controller") and p["code"] != cfg.terminal:
                out.append(({"terminal": p["code"]}, "tc"))
        if any("IBX" in b for b in chain.blockers):
            for p in prods:
                if p.get("category") in ("rate_control", "ecu"):
                    out.append(({p["category"]: p["code"]}, "tc"))
    if rows.get("vra", {}).get("status") == "fail" or (rows.get("rates", {}).get("status") != "ok" and not chain.pwm):
        for p in prods:
            if p.get("category") == "rate_control" and p["code"] != cfg.rate_control:
                ch = {"rate_control": p["code"]}
                if not (cat.caps(cfg.actuator).get("selective_nozzle_control") or cat.caps(cfg.actuator).get("pwm_valve")):
                    act = next((a for a in prods if a.get("category") == "actuator" and (a.get("capabilities") or {}).get("selective_nozzle_control")), None)
                    if act:
                        ch["actuator"] = act["code"]
                out.append((ch, "vra"))
        if not chain.vra:
            need = base.get("flow_max")
            valves = [p for p in prods if p.get("category") == "valve"][:2]
            meters = [p for p in prods if p.get("category") == "flowmeter" and (p.get("capabilities") or {}).get("range_max_l_min")]
            if need:
                meters = [m for m in meters if m["capabilities"]["range_max_l_min"] >= need and (m["capabilities"].get("range_min_l_min") or 0) <= need / 3]
            meters = sorted(meters, key=lambda m: m["capabilities"]["range_max_l_min"])[:2]
            for v in valves[:1]:
                for m in meters:
                    out.append(({"valve": v["code"], "flowmeter": m["code"]}, "vra"))
    if rows.get("meter", {}).get("status") == "partial" and base.get("flow_max"):
        need_lo, need_hi = base["flow_min"], base["flow_max"]
        fits = [p for p in prods if p.get("category") == "flowmeter" and (p.get("capabilities") or {}).get("range_max_l_min")
                and p["capabilities"]["range_max_l_min"] >= need_hi and (p["capabilities"].get("range_min_l_min") or 0) <= need_lo]
        for m in sorted(fits, key=lambda m: m["capabilities"]["range_max_l_min"])[:2]:
            out.append(({"flowmeter": m["code"]}, "meter"))
    if rows.get("sections", {}).get("status") in ("partial", "unknown"):
        need = base.get("need_sections", 3)
        units = sorted((p for p in prods if p.get("category") == "section_valves"), key=lambda p: (p.get("capabilities") or {}).get("sections", 0))
        unit = next((u for u in units if u["capabilities"]["sections"] >= need), units[-1] if units else None)
        if unit:
            out.append(({"extras": cfg.extras + [unit["code"]]}, "sections"))
    if rows.get("sensors", {}).get("status") == "partial":
        ps = next((p for p in prods if p.get("category") == "sensor" and (p.get("capabilities") or {}).get("measures") == "pressure"), None)
        if ps:
            out.append(({"extras": cfg.extras + [ps["code"]]}, "sensors"))
    if not chain.blockers and chain.nozzles:
        sug = suggest(cin if len(cin) <= 80 else _compress(cin), cfg, chain, cat)
        for s in sug.get("singles", [])[:2]:
            if s["nozzles"] != [n.code for n in chain.nozzles]:
                out.append(({"nozzles": s["nozzles"]}, "rates"))
        for s in sug.get("pairs", [])[:1]:
            out.append(({"nozzles": s["nozzles"]}, "rates"))
        if chain.ways < 2 and rows.get("rates", {}).get("status") != "ok":
            act = next((a for a in prods if a.get("category") == "actuator" and (a.get("capabilities") or {}).get("selective_nozzle_control")), None)
            if act:
                out.append(({"actuator": act["code"]}, "rates"))
    return out


OPTIONAL = {"level": "Litri caricati registrati automaticamente: quantità effettive nel documento senza stime.",
            "wind": "Vento registrato durante il lavoro: dato utile per la deriva e per il registro dei trattamenti."}


def recommend(task: Any, cfg: HwConfig, cat: Catalog, rates: Optional[dict[int, float]], eff=None) -> dict[str, Any]:
    cin = _classes(task, rates)
    cell = _cell_m(task)
    base = requirements(cin, cfg, cat, cell)
    base["need_sections"] = max(1, min(13, math.ceil(cfg.boom_width / max(1.0, cell))))
    treated = [i for i, c in enumerate(cin) if c.rate and c.rate > 0]
    flows = [q_required(base["plans"][i].delivered, base["plans"][i].speed, cfg.spacing) * cfg.n_nozzles
             for i in treated if base["plans"][i].delivered and base["plans"][i].speed]
    # portata di barra necessaria anche se oggi non viene raggiunta: uso il rateo richiesto alla velocità di lavoro
    need = [q_required(cin[i].rate, cfg.speed_nom, cfg.spacing) * cfg.n_nozzles for i in treated]
    base["flow_min"] = min(need + flows) if (need or flows) else None
    base["flow_max"] = max(need + flows) if (need or flows) else None
    rank = {"insufficiente": 0, "parziale": 1, "adeguata": 2}
    before_pct, before_level = base["kpi"]["on_target_pct"], base["level"]
    seen: set[str] = set()
    recs: list[dict[str, Any]] = []
    rows = {r["id"]: r for r in base["rows"]}
    for changes, req in _candidates(cfg, base, cin, cat):
        key = repr(sorted(changes.items()))
        if key in seen:
            continue
        seen.add(key)
        new_cfg = replace(cfg, **{k: (list(v) if k in ("nozzles", "extras") else v) for k, v in changes.items()})
        after = requirements(cin, new_cfg, cat, cell)
        gain = after["kpi"]["on_target_pct"] - before_pct
        level_up = rank[after["level"]] > rank[before_level]
        fixes = req in rows and rows[req]["status"] in ("fail", "partial") and \
            next((r for r in after["rows"] if r["id"] == req), {}).get("status") == "ok"
        if not (level_up or gain >= 3.0 or fixes):
            continue
        if before_level == "insufficiente" and after["level"] != "insufficiente":
            group = "indispensabile"
        elif gain >= 3.0 or fixes:
            group = "precisione"
        else:
            group = "opzionale"
        items = []
        for slot, val in changes.items():
            codes = [c for c in val if c not in cfg.extras] if slot == "extras" else (val if slot == "nozzles" else [val])
            for code in codes:
                items.append({"slot": slot, "slot_label": SLOTS.get(slot, slot), "current": getattr(cfg, slot) if slot != "nozzles" else cfg.nozzles,
                              "product": _product(cat, code)})
        req_row = rows.get(req, {})
        new_rows = {r["id"]: r for r in after["rows"]}
        gained = [f"{r['label']}: {rows[k]['available']} → {r['available']}" for k, r in new_rows.items()
                  if k in rows and rows[k]["status"] != "ok" and r["status"] == "ok"]
        recs.append({
            "group": group, "requirement": req_row.get("label", req), "requirement_id": req,
            "current_limit": req_row.get("detail") or req_row.get("available", ""),
            "changes": changes, "items": items,
            "before": {"level": before_level, "on_target_pct": before_pct},
            "after": {"level": after["level"], "on_target_pct": after["kpi"]["on_target_pct"],
                      "warnings": after["warnings"], "blockers": after["blockers"]},
            "gained": gained,
            "efficacy": {"before": eff(base["delivered"]) if eff else None, "after": eff(after["delivered"]) if eff else None},
            "why": (f"Porta i volumi eseguibili entro tolleranza dal {before_pct:.0f} % al {after['kpi']['on_target_pct']:.0f} % della superficie"
                    + (f" e la compatibilità da «{before_level}» ad «{after['level']}»" if level_up else "") + ", ricalcolato con il motore idraulico."),
        })
    # opzionali: sensori che non cambiano l'esito ma aggiungono capacità documentate
    _, measures = _extras(cfg, cat)
    for p in cat.products.values():
        m = (p.get("capabilities") or {}).get("measures")
        if p.get("category") == "sensor" and m in OPTIONAL and m not in measures and p["code"] not in cfg.extras:
            recs.append({"group": "opzionale", "requirement": "Tracciabilità", "requirement_id": "trace", "current_limit": "dato non registrato",
                         "changes": {"extras": cfg.extras + [p["code"]]},
                         "items": [{"slot": "extras", "slot_label": SLOTS["extras"], "current": "nessuno", "product": _product(cat, p["code"])}],
                         "before": {"level": before_level, "on_target_pct": before_pct},
                         "after": {"level": before_level, "on_target_pct": before_pct, "warnings": [], "blockers": []},
                         "gained": [OPTIONAL[m]], "efficacy": {"before": None, "after": None},
                         "why": OPTIONAL[m] + " Non cambia la distribuzione."})
    order = {"indispensabile": 0, "precisione": 1, "opzionale": 2}
    recs.sort(key=lambda r: (order[r["group"]], -(r["after"]["on_target_pct"] - r["before"]["on_target_pct"])))
    return {"ok": True, "level": before_level, "recommendations": recs[:10],
            "needed": before_level != "adeguata" or bool(recs),
            "source": "Catalogo ARAG del progetto (pagine pubbliche, vedi docs/RICERCA_MERCATO.md): verifica sempre la scheda ufficiale."}
