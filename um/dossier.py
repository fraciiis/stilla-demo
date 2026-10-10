"""Fase 6 · documentazione del trattamento, compilata dai dati delle fasi precedenti.

Il server RICALCOLA zone, ricettario e compatibilità a partire dagli input (file, dati di etichetta, hardware):
il documento non si fida di numeri arrivati dal browser. Dal browser arrivano solo le informazioni che
appartengono all'operatore (anagrafica, date, quantità effettive, dichiarazioni, registro delle decisioni).

Ogni voce porta la sua provenienza: acquisito (dal file), calcolato (dall'app), dichiarato (dall'operatore),
mancante. Stato documentale:

* bozza          nessun ricettario scelto;
* da completare  mancano dati obbligatori (elencati);
* da verificare  dati completi ma dichiarazioni non confermate, oppure attrezzatura non idonea;
* validato       confermato esplicitamente dal tecnico con nome e data.

«Validato» significa che il tecnico ha controllato e confermato i dati: NON è un'attestazione di conformità
normativa e non esonera da responsabilità.
"""

from __future__ import annotations

import datetime as _dt
import json
import re
from html import escape
from typing import Any, Optional

DECLARATIONS = {
    "label_read": "Ho letto l'etichetta autorizzata di ogni prodotto e le dosi rientrano nelle condizioni d'impiego.",
    "mix_ok": "La miscela è ammessa dalle etichette (o è un solo prodotto).",
    "operator_license": "L'operatore è abilitato all'acquisto e all'uso dei prodotti fitosanitari (certificato valido).",
    "equipment_checked": "L'irroratrice è sottoposta al controllo funzionale periodico e alla regolazione previsti.",
    "weather_buffer": "Ho verificato condizioni meteo, fasce di rispetto e misure di mitigazione della deriva previste in etichetta.",
}
STATUS_LABEL = {"bozza": "Bozza", "da_completare": "Da completare", "da_verificare": "Da verificare", "validato": "Validato"}
MAX_MAP_BYTES = 1_500_000


def _s(v: Any, n: int = 200) -> str:
    return str(v or "").strip()[:n]


def build(*, summary: dict[str, Any], task: Any, zoning: dict[str, Any], recipes: Optional[dict[str, Any]],
          recipe_id: str, match: Optional[dict[str, Any]], cfg_names: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    op = body.get("operator") or {}
    actual = body.get("actual") or {}
    decl = body.get("declarations") or {}
    mode = "eseguito" if body.get("mode") == "eseguito" else "pianificato"
    recipe = next((r for r in (recipes or {}).get("recipes", []) if r["id"] == recipe_id), None)
    selection = body.get("selection") or {}
    missing: list[str] = []
    checks: list[dict[str, str]] = []

    def need(cond: bool, text: str) -> None:
        if not cond:
            missing.append(text)

    field = next((f for f in summary.get("fields", []) if f.get("id") == task.field_id), (summary.get("fields") or [{}])[0] if summary.get("fields") else {})
    ident = {
        "file": {"value": summary.get("filename", ""), "src": "acquisito"},
        "field": {"value": task.field_name or field.get("name") or task.field_id or "", "src": "acquisito" if (task.field_name or field.get("name")) else "mancante"},
        "crop": {"value": field.get("crop") or _s(body.get("crop")), "src": "acquisito" if field.get("crop") else ("dichiarato" if body.get("crop") else "mancante")},
        "task": {"value": task.name, "src": "acquisito"},
        "area_ha": {"value": (recipe or {}).get("totals", {}).get("area_ha"), "src": "calcolato"},
    }
    need(bool(ident["field"]["value"]), "identificazione del campo")
    need(bool(ident["crop"]["value"]), "coltura")
    need(ident["area_ha"]["value"] is not None, "superficie trattata (il file non ha geometria)")

    operator = {k: {"value": _s(op.get(k)), "src": "dichiarato" if _s(op.get(k)) else "mancante"}
                for k in ("name", "company", "license_no", "target", "date_planned", "date_done")}
    need(bool(operator["name"]["value"]), "nome dell'operatore")
    need(bool(operator["license_no"]["value"]), "numero del certificato di abilitazione dell'operatore")
    need(bool(operator["target"]["value"]), "avversità o infestante bersaglio")
    need(bool(operator["date_planned"]["value"] or operator["date_done"]["value"]), "data del trattamento")
    if mode == "eseguito":
        need(bool(operator["date_done"]["value"]), "data di esecuzione")

    if recipe is None:
        status = "bozza"
    else:
        for p in recipe["products"]:
            for m in p["missing"]:
                missing.append(f"{p['name']}: {m}")
            for pr in p["problems"]:
                missing.append(f"{p['name']}: {pr}")
        if not recipe["products"]:
            missing.append("almeno un prodotto con dati di etichetta")
        for c in recipe["constraints"]:
            if c["level"] == "fail":
                checks.append({"status": "fail", "text": c["text"]})
            else:
                checks.append({"status": "warn", "text": c["text"]})
        if mode == "eseguito":
            need(actual.get("mixture_l") not in (None, ""), "volume di miscela effettivamente distribuito")
            for p in recipe["products"]:
                need((actual.get("products") or {}).get(p["name"]) not in (None, ""), f"quantità effettiva di {p['name']}")
        status = "da_completare" if missing else "da_verificare"

    if match is not None:
        checks.insert(0, {"status": {"adeguata": "ok", "parziale": "warn", "insufficiente": "fail"}[match["level"]],
                          "text": f"Compatibilità hardware {match['level']}: {match['text']}"})
        for r in match["rows"]:
            if r["status"] in ("fail", "partial", "unknown"):
                checks.append({"status": {"fail": "fail", "partial": "warn", "unknown": "todo"}[r["status"]],
                               "text": f"{r['label']}: richiesto {r['required']}, disponibile {r['available']}" + (f" — {r['detail']}" if r["detail"] else "")})
    elif recipe is not None:
        missing.append("verifica dell'hardware (fase 4)")
        status = "da_completare"

    decl_rows = [{"id": k, "text": t, "confirmed": bool(decl.get(k))} for k, t in DECLARATIONS.items()]
    validator = body.get("validation") or {}
    if status == "da_verificare":
        hw_ok = match is not None and match["level"] != "insufficiente"
        rec_ok = not any(c["level"] == "fail" for c in (recipe or {}).get("constraints", []))
        if all(d["confirmed"] for d in decl_rows) and hw_ok and rec_ok and _s(validator.get("name")) and validator.get("confirm"):
            status = "validato"
    if match is not None and match["level"] == "insufficiente" and status == "validato":
        status = "da_verificare"

    rec_fails = [c["text"] for c in (recipe or {}).get("constraints", []) if c["level"] == "fail"]
    if status == "validato" and rec_fails:
        status = "da_verificare"
    blockers_to_validate = []
    if status in ("da_verificare",):
        blockers_to_validate += [f"ricettario non conforme: {t}" for t in rec_fails]
        if match is not None and match["level"] == "insufficiente":
            blockers_to_validate.append("l'attrezzatura non è idonea al ricettario: risolvi le incompatibilità (fasi 4 e 5)")
        blockers_to_validate += [f"dichiarazione da confermare: {d['text']}" for d in decl_rows if not d["confirmed"]]
        if not _s(validator.get("name")):
            blockers_to_validate.append("nome del tecnico che valida")

    map_png = body.get("map_png") or ""
    if not (isinstance(map_png, str) and len(map_png) <= MAX_MAP_BYTES and re.fullmatch(r"data:image/png;base64,[A-Za-z0-9+/]+=*", map_png)):
        map_png = ""

    log = []
    for e in (body.get("log") or [])[-200:]:
        if isinstance(e, dict):
            log.append({"t": _s(e.get("t"), 40), "what": _s(e.get("what"), 120), "detail": _s(e.get("detail"), 400)})

    return {
        "ok": True, "kind": "um-dossier", "version": 1,
        "generated_at": _dt.datetime.now().isoformat(timespec="seconds"),
        "mode": mode, "status": status, "status_label": STATUS_LABEL[status],
        "missing": missing, "to_validate": blockers_to_validate,
        "identification": ident, "operator": operator,
        "zoning": {"stats": zoning.get("stats"), "groups": zoning.get("groups"), "provenance": zoning.get("provenance"), "rule": zoning.get("rule")},
        "recipe": recipe, "selection": {"recipe_id": recipe_id, "at": _s(selection.get("at"), 40), "note": _s(selection.get("note"), 400)},
        "equipment": {"names": cfg_names, "nozzles": body.get("config", {}).get("nozzles", [])},
        "match": match, "checks": checks, "declarations": decl_rows,
        "actual": {"mixture_l": actual.get("mixture_l"), "products": actual.get("products") or {}},
        "validation": {"name": _s(validator.get("name")), "at": _s(validator.get("at"), 40)} if status == "validato" else None,
        "log": log, "map_png": map_png,
        "formulas": (recipes or {}).get("formulas", []),
        "disclaimer": ("Documento generato automaticamente dai dati raccolti nell'app. Supporta la tracciabilità ma non attesta la conformità "
                       "normativa e non esonera da responsabilità: etichette, autorizzazioni e prescrizioni vanno verificate sulle fonti ufficiali."),
    }


# --------------------------------------------------------------------------- HTML stampabile

CSS = """
:root{--brand:#007AC9;--brand-strong:#004F82;--brand-50:#EAF4FB;--ink:#13222E;--mut:#4A5A67;--line:#D5DEE6;--bg2:#F2F5F8;
--ok:#17703D;--ok-bg:#E7F5EC;--ad:#7A4E00;--ad-bg:#FFF4D6;--er:#B42330;--er-bg:#FDECEE}
*{box-sizing:border-box} body{font-family:"Inter","Helvetica Neue",Arial,sans-serif;color:var(--ink);margin:0;background:#fff;font-size:15px;line-height:1.5}
b,strong,th{font-weight:500} main{max-width:980px;margin:0 auto;padding:26px 22px 60px}
header{border-bottom:4px solid var(--brand);padding-bottom:12px;margin-bottom:16px;display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
h1{margin:0;font-size:26px;font-weight:500;color:var(--brand-strong)} h2{font-size:18px;font-weight:500;margin:24px 0 8px;color:var(--brand-strong)}
.sub{color:var(--mut)} .st{margin-left:auto;padding:4px 12px;border-radius:99px;font-weight:500;font-size:14px}
.st.bozza,.st.da_completare{background:var(--ad-bg);color:var(--ad)} .st.da_verificare{background:var(--brand-50);color:var(--brand-strong)} .st.validato{background:var(--ok-bg);color:var(--ok)}
table{width:100%;border-collapse:collapse;font-size:14px;margin-top:4px} th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{background:var(--bg2);color:var(--mut)} .num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.src{display:inline-block;font-size:11px;padding:0 7px;border-radius:99px;background:var(--bg2);color:var(--mut);margin-left:6px;white-space:nowrap}
.src.mancante{background:var(--er-bg);color:var(--er)} .src.dichiarato{background:var(--brand-50);color:var(--brand-strong)} .src.calcolato{background:var(--ad-bg);color:var(--ad)} .src.acquisito{background:var(--ok-bg);color:var(--ok)}
.box{border-left:4px solid var(--brand);background:var(--brand-50);padding:8px 14px;margin:10px 0;border-radius:4px}
.box.warn{border-color:#E0A100;background:var(--ad-bg)} .box.err{border-color:#C82A38;background:var(--er-bg)}
.chk{white-space:nowrap;font-weight:500} .chk.ok{color:var(--ok)} .chk.warn{color:var(--ad)} .chk.fail{color:var(--er)} .chk.todo{color:var(--mut)}
img.map{max-width:100%;border:1px solid var(--line);border-radius:8px} ul{margin:4px 0 4px 20px;padding:0} .small{font-size:13px;color:var(--mut)}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:30px} .sign div{border-top:1px solid var(--ink);padding-top:6px;font-size:13px;color:var(--mut)}
@media print{main{padding:0}.noprint{display:none}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
"""


def _f(v: Any, d: int = 1, unit: str = "") -> str:
    if v is None or v == "":
        return "—"
    try:
        return f"{float(v):,.{d}f}".replace(",", " ").replace(".", ",") + unit
    except (TypeError, ValueError):
        return escape(str(v))


def _src(s: str) -> str:
    return f'<span class="src {escape(s)}">{escape(s)}</span>'


def _val(item: dict[str, Any]) -> str:
    v = item.get("value")
    return (escape(str(v)) if v not in (None, "") else "—") + _src(item.get("src", ""))


def render_html(d: dict[str, Any]) -> str:
    rec = d.get("recipe")
    ident, op = d["identification"], d["operator"]
    chk_sym = {"ok": "✓ ok", "warn": "! attenzione", "fail": "✕ non superato", "todo": "? da verificare"}
    parts = [f"""<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scheda di trattamento · {escape(str(ident['task']['value']))}</title><style>{CSS}</style></head><body><main>
<header><div><h1>Scheda del trattamento</h1><div class="sub">{escape(str(ident['task']['value']))} · {escape(d['mode'])} · generata il {escape(d['generated_at'].replace('T', ' '))}</div></div>
<span class="st {d['status']}">{escape(d['status_label'])}</span></header>"""]
    if d["missing"]:
        parts.append('<div class="box err"><b>Dati obbligatori mancanti</b><ul>' + "".join(f"<li>{escape(m)}</li>" for m in d["missing"]) + "</ul></div>")
    if d["to_validate"]:
        parts.append('<div class="box warn"><b>Prima della validazione</b><ul>' + "".join(f"<li>{escape(m)}</li>" for m in d["to_validate"]) + "</ul></div>")
    if d.get("validation"):
        parts.append(f'<div class="box"><b>Validato</b> da {escape(d["validation"]["name"])} il {escape(d["validation"]["at"] or "")}. '
                     "Conferma del tecnico sui dati riportati: non è un'attestazione di conformità normativa.</div>")
    parts.append("<h2>Campo e superfici</h2><table><tbody>"
                 f"<tr><th>Campo</th><td>{_val(ident['field'])}</td></tr><tr><th>Coltura</th><td>{_val(ident['crop'])}</td></tr>"
                 f"<tr><th>Operazione</th><td>{_val(ident['task'])}</td></tr><tr><th>File</th><td>{_val(ident['file'])}</td></tr>"
                 f"<tr><th>Superficie trattata</th><td>{_f(ident['area_ha']['value'], 2, ' ha')}{_src('calcolato')}</td></tr></tbody></table>")
    if d.get("map_png"):
        parts.append(f'<h2>Mappa delle zone e dei livelli di intervento</h2><img class="map" alt="Mappa del ricettario" src="{d["map_png"]}">')
    z = d.get("zoning") or {}
    if z.get("groups"):
        parts.append("<h2>Classi di intervento</h2><table><thead><tr><th>Classe</th><th class='num'>Zone</th><th class='num'>ha</th><th class='num'>Quota</th><th class='num'>Ratei file L/ha</th></tr></thead><tbody>"
                     + "".join(f"<tr><td>{escape(g['label'])}</td><td class='num'>{g['n_zones']}</td><td class='num'>{_f(g['area_ha'], 2)}</td><td class='num'>{_f(g['share_pct'], 0, ' %')}</td>"
                               f"<td class='num'>{_f(g['rate_min'], 0)}–{_f(g['rate_max'], 0)}</td></tr>" for g in z["groups"])
                     + f"</tbody></table><p class='small'>Regola: {escape(z.get('rule') or '')}</p>")
    parts.append("<h2>Operatore e obiettivo</h2><table><tbody>"
                 f"<tr><th>Operatore</th><td>{_val(op['name'])}</td></tr><tr><th>Azienda</th><td>{_val(op['company'])}</td></tr>"
                 f"<tr><th>Certificato di abilitazione</th><td>{_val(op['license_no'])}</td></tr><tr><th>Avversità / infestante</th><td>{_val(op['target'])}</td></tr>"
                 f"<tr><th>Data prevista</th><td>{_val(op['date_planned'])}</td></tr><tr><th>Data di esecuzione</th><td>{_val(op['date_done'])}</td></tr></tbody></table>")
    if rec:
        t = rec["totals"]
        sel = d.get("selection") or {}
        parts.append(f"<h2>Ricettario scelto · {escape(rec['letter'])} {escape(rec['title'])}</h2>"
                     f"<p>{escape(rec['why'])} <span class='small'>Criterio: {escape(rec['criterion'])}. Compromesso: {escape(rec['tradeoff'])}</span></p>"
                     f"<p class='small'>Scelta registrata {escape(sel.get('at') or '')}{(' · nota: ' + escape(sel['note'])) if sel.get('note') else ''}{_src('dichiarato')}</p>")
        parts.append("<table><thead><tr><th>Prodotto</th><th>N. registrazione</th><th class='num'>Dose etichetta</th><th class='num'>Dose prevista</th><th class='num'>Per serbatoio</th><th class='num'>Quantità totale</th><th>Fonte</th></tr></thead><tbody>"
                     + "".join(f"<tr><td>{escape(p['name'])}</td><td>{escape(p['reg_no']) or '—'}{_src('dichiarato' if p['reg_no'] else 'mancante')}</td>"
                               f"<td class='num'>{_f(p['dose_min'], 2)}–{_f(p['dose_max'], 2)} {escape(p['unit'])}</td>"
                               f"<td class='num'>{(_f(p['dose_range'][0], 2) + '–' + _f(p['dose_range'][1], 2)) if p['dose_range'] else '—'} {escape(p['unit'])}{_src('calcolato')}</td>"
                               f"<td class='num'>{_f(p['per_tank'], 2)}</td><td class='num'>{_f(p['quantity'], 2)} {escape(p['unit'].split('/')[0])}{_src('calcolato')}</td>"
                               f"<td class='small'>{escape(p['source']) or '—'}{(' · verificata il ' + escape(p['checked_on'])) if p['checked_on'] else ''}</td></tr>" for p in rec["products"])
                     + "</tbody></table>")
        parts.append(f"<p>Miscela {_f(t['mixture_l'], 0, ' L')} · acqua {_f(t['water_l'], 0, ' L')} · serbatoi {_f(t['tank_loads'], 0)} · costo prodotti {_f(t['cost'], 2, ' €')}{_src('calcolato')}</p>")
        zones = [zz for zz in rec["zones"] if zz["volume"]]
        if len(zones) <= 60:
            names = [p["name"] for p in rec["products"]]
            parts.append("<table><thead><tr><th>Zona</th><th>Classe</th><th class='num'>ha</th><th class='num'>File L/ha</th><th class='num'>Miscela L/ha</th>"
                         + "".join(f"<th class='num'>{escape(n)}</th>" for n in names) + "</tr></thead><tbody>"
                         + "".join(f"<tr><td>{escape(zz['label'])}</td><td>{escape(zz['cls'])}</td><td class='num'>{_f(zz['area_ha'], 2)}</td><td class='num'>{_f(zz['rx_rate'], 0)}</td>"
                                   f"<td class='num'>{_f(zz['volume'], 0)}</td>" + "".join(f"<td class='num'>{_f(x, 2)}</td>" for x in zz["doses"]) + "</tr>" for zz in zones)
                         + "</tbody></table>")
        else:
            parts.append(f"<p class='small'>{len(zones)} zone (mappa continua): dettaglio per zona nell'esportazione JSON.</p>")
        a = d.get("actual") or {}
        if d["mode"] == "eseguito":
            parts.append("<h2>Quantità effettivamente utilizzate</h2><table><tbody>"
                         f"<tr><th>Miscela distribuita</th><td>{_f(a.get('mixture_l'), 0, ' L')}{_src('dichiarato' if a.get('mixture_l') not in (None, '') else 'mancante')}</td></tr>"
                         + "".join(f"<tr><th>{escape(p['name'])}</th><td>{_f((a.get('products') or {}).get(p['name']), 2)}{_src('dichiarato' if (a.get('products') or {}).get(p['name']) not in (None, '') else 'mancante')}</td></tr>" for p in rec["products"])
                         + "</tbody></table>")
    eq = d.get("equipment") or {}
    parts.append("<h2>Attrezzatura</h2><table><tbody>" + "".join(f"<tr><th>{escape(k)}</th><td>{escape(str(v))}</td></tr>" for k, v in (eq.get("names") or {}).items())
                 + f"<tr><th>Ugelli</th><td>{escape(', '.join(eq.get('nozzles') or [])) or '—'}</td></tr></tbody></table>")
    if d["checks"]:
        parts.append("<h2>Verifiche eseguite dall'app</h2><table><tbody>"
                     + "".join(f"<tr><td class='chk {c['status']}'>{chk_sym[c['status']]}</td><td>{escape(c['text'])}</td></tr>" for c in d["checks"]) + "</tbody></table>")
    parts.append("<h2>Dichiarazioni dell'operatore</h2><table><tbody>"
                 + "".join(f"<tr><td class='chk {'ok' if x['confirmed'] else 'todo'}'>{'✓ confermata' if x['confirmed'] else '? non confermata'}</td><td>{escape(x['text'])}</td></tr>" for x in d["declarations"])
                 + "</tbody></table>")
    if d["log"]:
        parts.append("<h2>Registro delle decisioni</h2><table><thead><tr><th>Quando</th><th>Decisione</th><th>Dettaglio</th></tr></thead><tbody>"
                     + "".join(f"<tr><td class='small'>{escape(e['t'])}</td><td>{escape(e['what'])}</td><td class='small'>{escape(e['detail'])}</td></tr>" for e in d["log"]) + "</tbody></table>")
    if d.get("formulas"):
        parts.append("<h2>Regole di calcolo usate</h2><ul>" + "".join(f"<li><b>{escape(f['name'])}</b>: <code>{escape(f['expr'])}</code> — {escape(f['note'])} <span class='small'>({escape(f['where'])})</span></li>" for f in d["formulas"]) + "</ul>")
    parts.append(f"<div class='box warn'>{escape(d['disclaimer'])}</div>")
    parts.append("<div class='sign'><div>Firma dell'operatore</div><div>Firma del tecnico</div></div>")
    parts.append("<p class='small noprint'>Per il PDF: stampa questa pagina e scegli «Salva come PDF».</p></main></body></html>")
    return "".join(parts)


def to_json(d: dict[str, Any]) -> bytes:
    out = dict(d)
    out.pop("map_png", None)
    return json.dumps(out, ensure_ascii=False, indent=2).encode("utf-8")


def safe_name(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", s).strip("_")[:60] or "trattamento"
