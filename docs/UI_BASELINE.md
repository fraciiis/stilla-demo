# Redesign UI/UX · baseline e audit

Riferimento: `CLAUDE.md` (redesign solo UI/UX, comportamento invariato).
Data baseline: 10/10/2026 · commit di partenza `0f7f025`.

## 1. Baseline tecnica

| Controllo | Esito |
|---|---|
| Test `python3 -m unittest discover -s tests -t .` | **49 test, tutti OK** (≈2,4 s, Python 3.13) |
| Build | non esiste un passo di build: frontend statico (`static/`), server solo libreria standard |
| Avvio | `python3 app.py --no-browser` → `http://localhost:8765/` |
| Console del browser | nessun errore JS. Due errori di rete **attesi**: 400 sul file rotto caricato apposta, `ERR_FAILED` su Open-Meteo bloccato apposta |

Screenshot in `docs/ui-baseline/` a **375 px** (`m375`), **768 px** (`t768`), **1440 px** (`d1440`):

| File | Schermata |
|---|---|
| `01_landing_*` | caricamento file + esempi (pagina intera) |
| `02_landing_errore_*` | file non leggibile |
| `03_workspace_*` / `03b_*` | area di lavoro con l'esempio 01 (pagina intera / prima schermata) |
| `04_dopo_modifica_*` | barra «Rispetto a prima» dopo il cambio di preset |
| `05_scheda_{nozzles,labels,weather,how}_*` | schede in basso (meteo nello stato «non raggiungibile») |
| `06_bloccato_*` | preset «Terminale ISOBUS senza controllo di portata» |
| `07_condividi_*` | finestra «Condividi con gli amici» |

Lo script che li rigenera è riproducibile (Playwright, Chromium preinstallato): stessi passi per il confronto dopo ogni fase.

## 2. Flusso principale (pipeline reale)

1. **File** — trascina/scegli `.zip` o `TASKDATA.XML`, oppure un esempio → `POST /api/import` o `/api/example`.
2. **Hardware** — preset o componenti singoli; ogni modifica (debounce 220 ms) → `POST /api/evaluate` → esito, KPI, mappa, tabelle.
3. **Scarica** — eventuale conferma «Ho controllato i ratei» → `POST /api/export` → download `…_NORDSON.zip`. Accessori: Rapporto (`/api/report`), schede, condivisione.

Questi passi, le chiamate e i loro corpi sono il riferimento da non cambiare.

## 3. Audit rispetto a CLAUDE.md

### Già buono (da conservare)
- Stepper a 3 fasi già presente, linguaggio dell'utente, messaggi d'errore che dicono cosa fare.
- Badge di stato con testo (non solo colore) nelle tabelle; legenda sotto la mappa.
- Stati vuoti/caricamento/errore già progettati in quasi tutte le schede.
- `:focus-visible`, `prefers-reduced-motion`, safe-area su iOS.

### Problemi trovati

| # | Area | Problema | Principio |
|---|---|---|---|
| A1 | Stepper | sotto 1050 px lo stepper è **nascosto** (`.steps{display:none}`): su tablet e telefono l'utente non sa in che fase è | 1, 5 |
| A2 | Stepper | la fase 3 si accende solo **dopo** il download; la fase «Scarica» non indica cosa manca (conferma, blocchi) | 1 |
| A3 | Azione principale | su mobile la barra di esportazione fissa occupa ~25 % dello schermo e propone «Scarica» prima che l'utente abbia visto l'hardware (il pannello finisce in fondo alla pagina) | 1, 2 |
| A4 | Colore errore | la card KPI «Fuori bersaglio» è **sempre rossa**, anche a 0 % (screenshot `05_scheda_nozzles_d1440`): rosso letto come errore su un valore buono | colori |
| A5 | Rosso decorativo | freccia del Nord in rosso **sulla mappa**, accanto alle zone rosse «sotto-dosato» | colori |
| A6 | Solo colore | sulla mappa lo stato è affidato solo al colore; rosso `#E03040` e verde `#1f9d55` hanno contrasto di luminanza **1,29:1** → per un daltonico deuteranope sono quasi uguali | 4 |
| A7 | Contrasto | bianco su verde `#1f9d55` (badge «Perfetto», KPI verde) = **3,49:1**, sotto AA | 4 |
| A8 | Contrasto | bordo dei campi `#d3dfe8` su bianco = **1,36:1**: input e select poco visibili al sole (WCAG 1.4.11 chiede 3:1) | 4 |
| A9 | Contrasto | pulsante segmentato disabilitato «Rispetto a prima» ≈ 2,2:1 | 4 |
| A10 | Link | link in `#007AC9` a dimensione normale (vedi nota sotto) | colori |
| A11 | Token | colori scritti a mano in JS (`util.js` STATUS/DIFF, `ui.js`, `map.js`, `extras.js`) e nel CSS (`#8cbfe3`, `#b8d9ef`, `#fff7e0`…) | colori |
| A12 | Tipografia | dimensioni sparse (`.8rem`, `.85rem`, `.88rem`, `.9rem`, `.92rem`, `.95rem`…), nessuna scala a token | tipografia |
| A13 | Touch | misurati a 375 px: `.btn.sm` 34 px di altezza («Cambia file», «Vedi sulla mappa»…), ✕ ugello 37×34, viste della mappa 36, «Condividi» 38, checkbox 20×20: sotto i 44 px. Schede (46) e gruppi hardware (49) sono già a norma | 4 |
| A14 | Header mobile | a 375 px «Ultimo Metro» va a capo su due righe | 5 |
| A15 | Microcopy | «+ Aggiungi un secondo ugello» resta tale anche col secondo già montato; doppio spazio in «Scarica ISOXML  per il mio hardware» | 2 |

### Nota critica sul blu
CLAUDE.md indica `#007AC9` su bianco a ~4,3:1. Il calcolo WCAG 2.x dà **4,54:1**: passa AA per un soffio. La conclusione operativa però resta valida: il margine è nullo e l'app si usa al sole, quindi per link e testo blu normale propongo comunque `#0066A8` (**6,06:1**). Lo stesso vale per il rosso `#E03040`: **4,50:1** esatti, al limite.

## 4. Bloccanti: servono decisioni prima di procedere

1. **Font Neue Montreal assente.** Nel repo ci sono solo i file di Source Sans 3 (`static/fonts/`, licenza OFL). Neue Montreal è un font commerciale (Pangram Pangram): servono i `.woff2` Medium 500 (e Regular 400 se disponibile) con una licenza web valida. Senza file **non** sostituisco il font: resta Source Sans 3.
2. **Palette neutri e stati da approvare** (CLAUDE.md: «proponili prima di applicarli»): vedi `docs/ui-proposta-colori.html`.
3. **Zona grigia, file da confermare:**
   - `static/js/util.js` contiene i colori di stato (STATUS/DIFF) insieme a funzioni di utilità. Per centralizzare i colori cambierei **solo** i valori/colori letti da CSS, senza toccare `fmt`, `esc`, `debounce` né i codici di stato.
   - `static/js/map.js` è solo disegno, ma contiene anche il calcolo dei clic (`_hit`). Per A6 aggiungerei un tratteggio sulle zone sotto/sovra-dosate dentro `draw()`, senza toccare proiezione né `_hit`.
   - `um/report.py` (server Python) genera il rapporto stampabile con CSS interno: allinearlo ai nuovi token vuol dire toccare un file backend, anche se solo la stringa `CSS`. Propongo di **lasciarlo com'è** salvo tua conferma.
4. **Branch.** CLAUDE.md chiede `ui-redesign`; questa sessione è vincolata a `claude/esecuzione-progetto-1q3bi4`. Lavoro qui; se vuoi, il branch si rinomina al merge.

## 5. Redesign applicato (decisioni del 10/10/2026)

Decisioni: font da web app al posto di Neue Montreal (assente) · palette approvata · via libera su `util.js` e `map.js` · `um/report.py` lasciato com'è · si resta su questo branch.

| # | Intervento | File |
|---|---|---|
| font | **Inter** 400/500 in locale (`static/fonts/inter-*.woff2`, licenza OFL in `OFL-Inter.txt`), fallback `"Helvetica Neue", Arial`. Peso 500 per titoli, pulsanti, etichette, numeri | `style.css`, `static/fonts/` |
| A11, A12 | token centralizzati: colori, scala tipografica, spazi, raggi, icone. I colori della mappa li legge anche JS (`tok()` in `util.js`) | `style.css`, `util.js` |
| A1, A14 | stepper sempre visibile: in testata su desktop/tablet, seconda riga fissa su telefono (la riga del marchio scorre via). Fase completata = spunta | `style.css`, `index.html` |
| A2 | la fase 3 mostra se il download è pronto (contorno) o bloccato (lucchetto), letto dal pulsante di download: nessuna logica nuova | `style.css` |
| A3 | barra di esportazione più compatta su telefono; «Provalo» non è più un'azione primaria | `style.css`, `ui.js` |
| A4 | card «Fuori bersaglio» rossa solo quando c'è davvero qualcosa fuori bersaglio | `ui.js` |
| A5 | freccia del Nord in inchiostro, non più rossa | `map.js` |
| A6 | tratteggio diagonale (sotto-dosato), incrociato (sovra-dosato) e diagonale su «va peggio», anche su griglia; stessa trama nella legenda. Trattini delle portate: lunghi = non raggiunti, corti = raggiunti | `map.js`, `ui.js`, `style.css` |
| A7 | badge con testo scuro su fondo chiaro + simbolo (✓ ≈ ▼ ▲ ≠) | `style.css` |
| A8, A9, A10 | bordi dei campi 3,42:1 · bottone disabilitato con barrato + suggerimento · link `#0066A8` | `style.css`, `index.html` |
| A13 | target ≥ 44 px (38 px solo per `.btn.sm` con mouse), checkbox 22 px con area di tocco 44 | `style.css` |
| A15 | «Aggiungi un altro ugello» dal secondo in poi · niente doppio spazio in «Scarica ISOXML per il mio hardware» | `hw.js`, `index.html` |
| stati | esito, avvisi, toast e meteo hanno sempre icona + testo | `style.css` |

Verifiche: 49/49 test OK · nessun errore JS · nessuno scroll orizzontale sugli 8 esempi a 375/768/1440 px · screenshot «dopo» in `docs/ui-after/` con gli stessi nomi di `docs/ui-baseline/`.
Il flusso è identico: `main.js`, `api.js` e `um/` non sono stati modificati, quindi chiamate, corpi delle richieste e file prodotti restano gli stessi.

Restano fuori: il rapporto stampabile (`um/report.py`) usa ancora il vecchio stile; i file Source Sans 3 restano in `static/fonts/` ma non sono più usati.

## 6. Tipologie di mappa

Il server classifica ogni operazione (`task.kind` in `um/isoxml.py`) e la mappa (`static/js/map.js`) ha quattro modi di disegno:

| Tipo (`kind`) | Cosa contiene | Come si disegna | Esempi |
|---|---|---|---|
| `zones_geo` | zone TZN con poligoni (anche con buchi) | poligoni vettoriali | 01, 05 (operazione 1) |
| `grid1` | griglia GRD tipo 1: ogni cella ha un codice zona | raster a celle, ritagliato sul contorno | 02, 05 (operazione 2) |
| `grid2` | griglia GRD tipo 2: un valore per cella (mappa continua) | raster a celle, classi raggruppate in fasce nella tabella | 03 |
| `zones_nogeo` | ratei senza posizione | un solo rateo: campo pieno · più ratei: solo contorno + messaggio | 04, 06 |
| `none` | nessun rateo | solo contorno | — |

Varianti che cambiano l'aspetto senza cambiare tipo: griglia **senza coordinate** adattata al campo (`geo: false`, es. 07), contorno del campo **ricavato dalla griglia** (`from_grid`), campo in **file esterno XFR** (es. 08), griglie grandi **campionate** per la visualizzazione (`decimated`).

Su ognuna si applicano 4 viste di colore: Prescrizione (rampa blu per L/ha), Sul tuo hardware (stati), File specializzato (stati dopo la riscrittura), Rispetto a prima (meglio / peggio / invariato).
