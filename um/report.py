"""Rapporto stampabile del piano di lavoro: una pagina HTML autonoma (nessuna risorsa esterna)."""

from __future__ import annotations

import datetime as _dt
from html import escape
from typing import Any

from .engine import ClassIn, Plan, Specialisation
from .hardware import Catalog, Chain, HwConfig

STATUS_LABEL = {
    "ok": ("✓ Perfetto", "ok"),
    "adapt": ("≈ Con adattamento", "adapt"),
    "under": ("▼ Sotto-dosato", "under"),
    "over": ("▲ Sovra-dosato", "over"),
    "off": ("– Spento", "off"),
    "nodata": ("Dato mancante", "off"),
    "novra": ("≠ Rateo variabile non eseguibile", "novra"),
}

# Stessa palette dell'interfaccia (static/css/style.css): stati con testo scuro su fondo chiaro + simbolo
CSS = """
:root{--brand:#007AC9;--brand-text:#0066A8;--brand-strong:#004F82;--brand-50:#EAF4FB;--ink:#13222E;--mut:#4A5A67;--line:#D5DEE6;--bg2:#F2F5F8;
--ok:#17703D;--ok-bg:#E7F5EC;--ad:#7A4E00;--ad-bg:#FFF4D6;--ad-fill:#E0A100;--er:#B42330;--er-bg:#FDECEE;--ov:#5B2C8C;--ov-bg:#F1EAF8;--nv:#3B4650;--nv-bg:#E4E8EC}
*{box-sizing:border-box}
body{font-family:"Inter","Helvetica Neue",Arial,sans-serif;color:var(--ink);margin:0;background:#fff;font-size:16px;line-height:1.5}
b,strong,th{font-weight:500}
main{max-width:980px;margin:0 auto;padding:28px 22px 60px}
header{border-bottom:4px solid var(--brand);padding-bottom:12px;margin-bottom:18px}
h1{margin:0;font-size:28px;font-weight:500;color:var(--brand-strong);letter-spacing:-.01em} h2{font-size:20px;font-weight:500;margin:28px 0 8px;color:var(--brand-strong)}
.sub{color:var(--mut)} .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:10px 0}
.kpi{border:1px solid var(--line);border-top:3px solid var(--line);border-radius:10px;padding:10px 14px} .kpi b{display:block;font-size:26px;font-variant-numeric:tabular-nums}
.kpi small{color:var(--mut)} table{width:100%;border-collapse:collapse;font-size:14px;margin-top:6px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top} th{background:var(--bg2);color:var(--mut)}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums} .tag{display:inline-block;padding:1px 9px;border-radius:99px;font-size:13px;font-weight:500;white-space:nowrap}
.tag.ok{background:var(--ok-bg);color:var(--ok)}.tag.adapt{background:var(--ad-bg);color:var(--ad)}.tag.under{background:var(--er-bg);color:var(--er)}
.tag.over{background:var(--ov-bg);color:var(--ov)}.tag.novra{background:var(--nv-bg);color:var(--nv)}.tag.off{background:var(--bg2);color:var(--mut)}
.note{background:var(--brand-50);border-left:4px solid var(--brand);padding:8px 14px;margin:10px 0;border-radius:4px}
.warn{background:var(--ad-bg);border-left-color:var(--ad-fill)} ul{margin:6px 0 6px 20px;padding:0} .small{font-size:14px;color:var(--mut)}
@media print{main{padding:0}.noprint{display:none}.tag,.note,th{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
"""


def _f(v: Any, d: int = 1, unit: str = "") -> str:
    if v is None:
        return "—"
    try:
        return f"{v:.{d}f}".replace(".", ",") + unit
    except (TypeError, ValueError):
        return escape(str(v))


def _kpi(label: str, value: str, sub: str = "") -> str:
    return f'<div class="kpi"><small>{escape(label)}</small><b>{value}</b><small>{escape(sub)}</small></div>'


def render_report(session: Any, task: Any, cfg: HwConfig, chain: Chain, cat: Catalog,
                  cin: list[ClassIn], plans: list[Plan], spec: Specialisation) -> str:
    from .engine import kpis
    k = kpis(cin, plans)
    ka = spec.kpi_after
    today = _dt.datetime.now().strftime("%d/%m/%Y %H:%M")
    rows = []
    order = sorted(range(len(task.classes)), key=lambda i: (task.classes[i].rate or 0))
    if len(order) > 60:       # mappe continue: mostro solo le classi che richiedono attenzione e il resto in sintesi
        shown = [i for i in order if plans[i].status in ("under", "over", "novra")][:60]
        hidden = len(order) - len(shown)
    else:
        shown, hidden = order, 0
    for i in shown:
        c, p = task.classes[i], plans[i]
        label, cls = STATUS_LABEL.get(p.status, (p.status, "off"))
        new = spec.new_rate.get(c.idx) if c.idx in spec.changed else None
        rows.append(
            "<tr>"
            f"<td>{escape(c.label)}</td><td class='num'>{_f(c.area_ha, 2)}</td><td class='num'>{_f(c.rate, 0)}</td>"
            f"<td><span class='tag {cls}'>{label}</span></td><td class='num'>{_f(p.delivered, 0)}</td>"
            f"<td>{escape(p.nozzle or '—')}</td><td class='num'>{_f(p.speed, 1)}</td><td class='num'>{_f(p.pressure, 1)}</td>"
            f"<td class='num'>{_f(p.duty * 100, 0) if p.duty is not None else '—'}</td>"
            f"<td class='num'>{_f(new, 0) if new is not None else '—'}</td>"
            "</tr>")
    hw_rows = "".join(f"<tr><td>{escape(a)}</td><td>{escape(b)}</td></tr>" for a, b in chain.names.items())
    noz = ", ".join(escape(n.code) for n in chain.nozzles) or "—"
    blockers = "".join(f"<li>{escape(b)}</li>" for b in chain.blockers)
    warns = "".join(f"<li>{escape(w)}</li>" for w in chain.warnings)
    strategy = ("ratei variabili riscritti solo dove l'hardware non arriva" if spec.strategy == "variable"
                else f"rateo uniforme di {_f(spec.uniform_rate, 0)} L/ha (l'hardware scelto non esegue ratei variabili)")
    agr = spec.agronomic
    vol = ""
    if "volume_delta_pct" in agr:
        vol = (f"<p>Volume totale: {_f(agr['volume_original_l'], 0)} L prescritti → {_f(agr['volume_specialised_l'], 0)} L dopo la specializzazione "
               f"({_f(agr['volume_delta_pct'], 1)} %).</p>")

    return f"""<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ultimo Metro · piano di lavoro</title><style>{CSS}</style></head><body><main>
<header><h1>Piano di lavoro per l'hardware Nordson</h1>
<div class="sub">{escape(task.name)} · campo {escape(task.field_name or '—')} · file {escape(session.filename)} · {today}</div></header>

<h2>Esito sul tuo hardware</h2>
<div class="grid">
{_kpi("Area/zone trattate bene (prima)", _f(k['on_target_pct'], 0, ' %'), f"di cui perfette {_f(k['ok_pct'], 0)} %")}
{_kpi("Fuori bersaglio (prima)", _f(k['under_pct'] + k['over_pct'] + k.get('novra_pct', 0), 0, ' %'), f"sotto {_f(k['under_pct'], 0)} % · sopra {_f(k['over_pct'], 0)} %")}
{_kpi("Trattate bene (file specializzato)", _f(ka['on_target_pct'], 0, ' %'), f"classi modificate: {len(spec.changed)}")}
{_kpi("Gocce fini (sotto 136 µm)", _f(k.get('fines_avg_pct'), 0, ' %'), "media ponderata, se nota")}
</div>
<div class="note">Strategia del file specializzato: {strategy}.</div>{vol}

<h2>Piano per zona</h2>
<table><thead><tr><th>Zona</th><th class="num">ha</th><th class="num">Richiesto L/ha</th><th>Esito</th><th class="num">Erogato L/ha</th>
<th>Ugello</th><th class="num">km/h</th><th class="num">bar</th><th class="num">Duty %</th><th class="num">Nuovo rateo</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table>
{f'<p class="small">Mappa continua: mostrate le {len(shown)} classi fuori bersaglio, altre {hidden} classi non elencate.</p>' if hidden else ''}

<h2>Configurazione usata</h2>
<table><tbody>{hw_rows}<tr><td>Ugelli</td><td>{noz}</td></tr>
<tr><td>Barra</td><td>{_f(cfg.boom_width, 1)} m · {cfg.n_nozzles} ugelli a {_f(cfg.spacing * 100, 0)} cm</td></tr>
<tr><td>Velocità</td><td>nominale {_f(cfg.speed_nom, 1)} km/h · ammessa {_f(cfg.speed_min, 1)}–{_f(cfg.speed_max, 1)} km/h</td></tr>
<tr><td>Tolleranza</td><td>±{_f(cfg.tolerance_pct, 0)} %</td></tr></tbody></table>
{f'<div class="note warn"><b>Incompatibilità:</b><ul>{blockers}</ul></div>' if blockers else ''}
{f'<div class="note warn"><b>Attenzione:</b><ul>{warns}</ul></div>' if warns else ''}

<h2>Cosa è calcolato e cosa è un'ipotesi</h2>
<ul>
<li>Portata dell'ugello dalle curve del catalogo ARAG (interpolazione lineare tra i punti pubblicati); dove c'è un solo punto la curva è stimata con √pressione e il risultato è marcato come stima.</li>
<li>Con PWM (Flowtron) la pressione resta fissa e varia la percentuale di apertura; il minimo duty usato ({_f(cfg.duty_min_pct, 0)} %) è un'ipotesi da verificare sul terminale.</li>
<li>Il file ISOXML specializzato contiene solo i ratei (L/ha): nessun comando proprietario Nordson. Ugello, pressione e velocità di questa tabella sono le impostazioni consigliate per l'operatore.</li>
<li>Le compatibilità tra componenti vengono dai dati del catalogo: conferma sempre con la scheda tecnica o con l'assistenza prima di lavorare.</li>
</ul>
<p class="small noprint">Stampa questa pagina o salvala in PDF dal browser.</p>
</main></body></html>
"""
