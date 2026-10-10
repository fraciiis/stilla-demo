# Pipeline operativa · dalla mappa al trattamento documentato

Screenshot: `docs/pipeline/` (fasi 1–6 a 1440 e 375 px, import GeoJSON).

## Flusso e passaggio dei dati

```
File ISOXML ─┐
             ├─► FASE 1 zone e classi ──► FASE 2 tre ricettari ──► FASE 3 scelta ──► FASE 4 hardware ──► FASE 5 ARAG ──► FASE 6 documenti
GeoJSON ─────┘   (zoning.py)              (recipes.py)               (tracciata)       (matching.py)       (matching.py)    (dossier.py)
(geoimport.py)
```

| Fase | Input | Output | Modulo server | Interfaccia |
|---|---|---|---|---|
| 1 Mappa e zone | operazione del file (o GeoJSON convertito) | classi di intervento per zona, variabilità, provenienza dei dati | `um/zoning.py`, `um/geoimport.py`, `um/satellite.py` | `static/js/zones.js` |
| 2 Ricettari | zone + dati di etichetta inseriti dal tecnico + opzioni (obiettivo, serbatoio) + hardware attuale | 3 ricettari con volumi e dosi per zona, totali, costi, vincoli, confronto | `um/recipes.py` | `static/js/recipes.js` |
| 3 Scelta | ricettario scelto | volumi per zona da usare a valle, nota e voce nel registro | — (stato in `pipeline.js`) | `static/js/recipes.js` |
| 4 Hardware | volumi del ricettario + configurazione | requisiti richiesto/disponibile, livello adeguata/parziale/insufficiente | `um/matching.py` (+ `engine.py`) | `static/js/arag.js`, `main.js` |
| 5 ARAG | esito della fase 4 | componenti del catalogo, gruppo, prima/dopo ricalcolati | `um/matching.py` | `static/js/arag.js` |
| 6 Documenti | tutto il precedente + dati dell'operatore | scheda con stato (bozza / da completare / da verificare / validato), HTML stampabile, JSON, ISOXML per il terminale | `um/dossier.py` | `static/js/docs.js` |

**Continuità e invalidazioni** (`static/js/pipeline.js`): le scelte del tecnico (prodotti, ricettario, dati del documento, registro) sono salvate per file e operazione nel browser; i risultati calcolati si rigenerano. Cambiare i dati di etichetta ricalcola i ricettari e, se il ricettario scelto cambia, compatibilità e documento; cambiare ricettario o hardware ricalcola la compatibilità e le proposte ARAG e annulla la validazione. Ogni evento entra nel registro delle decisioni.

**Il server ricalcola, non si fida del browser**: compatibilità e documento rigenerano zone e ricettario dagli input (file, etichette, hardware). Dal browser arrivano solo le scelte e i dati dell'operatore.

## API nuove

`POST /api/zoning` · `/api/recipes` · `/api/match` · `/api/recommend` · `/api/dossier` · `/api/dossier/file` (`format: html|json`) · `/api/geojson/inspect` e `/api/geojson/load` (corpo binario, parametri in `X-Params`) · `GET /api/satellite`.
`/api/evaluate`, `/api/export`, `/api/report` accettano `rates` ({indice classe: L/ha}) per lavorare sui volumi del ricettario.

## Regole di calcolo

| Regola | Dove | Note |
|---|---|---|
| Classi di intervento: terzili di superficie dei ratei | `zoning.py` | regola dichiarata, non un modello agronomico |
| Dose per zona con miscela unica `d_i = c · V_i` | `recipes.py` | un serbatoio ⇒ concentrazione costante |
| A: dose media al centro della finestra di etichetta | `recipes.py` | se i volumi sono troppo distanti per una miscela unica è segnato **non conforme** e non validabile |
| B: concentrazione minima `c = d_min / V_min`, volumi limitati a `V_min · d_max / d_min` | `recipes.py` | sempre dentro le dosi di etichetta; dichiara quanta aderenza perde |
| C: volume unico = media pesata, dose al centro della finestra | `recipes.py` | |
| Portata per ugello `q = V · v · s / 600` | `engine.py` | esistente |
| **Formula della radice quadrata** `Q(p) = Q₃ · √(p / 3)` | `hardware.py` (Nozzle.from_product) | l'unica formula con radice quadrata presente nel progetto (codice, documenti, cronologia git): legge portata/pressione degli ugelli con un solo punto di catalogo. Usata per le pressioni richieste dai volumi del ricettario nella verifica hardware. Nessuna formula di dosaggio con radice quadrata è stata trovata: se ne esiste una, va fornita e si integra in `recipes.py` (`_concentration`). |
| Livelli di compatibilità: ≥ 95 % / ≥ 60 % della superficie entro tolleranza | `matching.py` | soglie dichiarate, modificabili |
| Proposte ARAG: varianti della configurazione con prodotti del catalogo, tenute solo se migliorano livello o copertura (≥ 3 punti) | `matching.py` | il guadagno è ricalcolato col motore |

## Modalità dimostrativa (simulazioni)

Screenshot: `docs/demo/`. Ogni dato simulato è marcato **DEMO** nell'interfaccia e nel documento, che diventa «documento dimostrativo».

| Integrazione mancante | Simulazione | File |
|---|---|---|
| Mappe da satellite e drone | 4 campi verosimili (vigneto, mais, frumento, pomodoro) con indice NDVI a 2 m, contesto attorno (strade, siepi, campi vicini), acquisizioni da drone (GSD 1,2–5,3 cm/px) e Sentinel-2 (10 m, nuvolosità); per il mais anche la mappa delle infestanti. Ortofoto e NDVI sono generati nel browser con filari, interfila, tracce di passaggio e pixel da 10 m per il satellite | `tools/make_demo_fields.py` → `static/demo/fields.json`, `static/js/imagery.js`, `static/js/demo.js`, `um/demo.py` |
| Fornitore satellitare | catalogo Sentinel-2 simulato: passaggi ogni 5 giorni con nuvolosità, scene nuvolose rifiutate | `um/demo.py` (`satellite_search`), `um/satellite.py` |
| Dalla mappa alla prescrizione | aggregazione alla risoluzione dell'acquisizione (6 m drone, 10 m satellite), N zone di uguale superficie, filtro di maggioranza 3×3, volumi lineari; per le infestanti irrorazione localizzata (celle sotto soglia non trattate). Esce un ISOXML a griglia vero | `um/demo.py` |
| Banca dati etichette | 8 prodotti inventati (nomi fittizi, n. registrazione DEMO-…) con principi attivi, dosi, volumi, intervallo di sicurezza, prezzo, efficacia di base e incompatibilità di miscela | `static/data/demo_etichette.json`, selettore nella fase 2 |
| Modello di efficacia | efficacia attesa simulata e dichiarata: efficacia di base × risposta alla dose (rispetto alla dose necessaria della zona) × copertura; ± 5 punti. Calcolata sul ricettario e sui volumi che l'hardware eroga davvero (senza rateo variabile: un volume unico) | `um/recipes.py` (`efficacy`) |
| Sensori e sezioni di barra | catalogo esteso con sensori (pressione, velocità radar, livello, vento) e gruppi di valvole di sezione (codici DEMO-…), sezioni gestibili dai terminali; il requisito «sezioni» confronta le sezioni con la risoluzione delle zone, il sensore di pressione è un requisito consigliato | `static/data/demo_catalog.json`, `um/hardware.py` (`merge_demo`), `um/matching.py` |
| Shapefile e UTM | lettura reale (non simulata) di shapefile poligonali zippati e conversione UTM WGS84/ETRS89 → WGS84, anche per GeoJSON | `um/shapefile.py` |

Esiti verificati sui 4 campi con la configurazione suggerita: il ricettario A (aderente alla mappa) ha l'efficacia simulata più alta, B usa meno prodotto, C (rateo unico) rende meno; sul mais la compatibilità parte «parziale» (3 sezioni per zone da 6 m su barra da 24 m) e la proposta del gruppo valvole a 5 sezioni la porta ad «adeguata».

## Dati reali, dichiarati e dimostrativi

| Dato | Natura |
|---|---|
| Geometrie, superfici, ratei di un file caricato dall'utente | reali |
| Gli 8 esempi ISOXML, la mappa NDVI di prova, i 4 campi dimostrativi | **simulati**, dichiarati |
| Catalogo ARAG (119 prodotti) | dalle pagine pubbliche (`docs/RICERCA_MERCATO.md`), da verificare con ARAG |
| Sensori e valvole di sezione DEMO-…, sezioni dei terminali | **simulati** |
| Prodotti fitosanitari | dal tecnico (con fonte) oppure dalla banca dati **dimostrativa** |
| Efficacia attesa | **simulata** con modello dichiarato |
| Dichiarazioni dell'operatore | riportate come dichiarazioni, non verificate |

## Verifiche eseguite

- 80 test automatici (49 preesistenti + 31 della pipeline, della modalità dimostrativa e dell'adattatore online), verdi su Python 3.9, 3.11 e 3.13.
- Percorso ISOXML completo nel browser (1440 e 375 px) e tutti gli 8 esempi attraverso le fasi 1–6.
- Percorso dimostrativo sui 4 campi: galleria → acquisizione (drone/Sentinel-2, ricerca scene) → zone → banca dati → ricettari → hardware → proposte ARAG applicate → documento validato con avviso DEMO; anche a 375 px. Nessun errore JS, nessuno scorrimento orizzontale.

## Integrazioni reali ancora da collegare (oggi simulate)

1. Fornitore satellitare/drone con licenza commerciale: implementare `Provider.fetch_index` in `um/satellite.py`; la chiave in una variabile d'ambiente.
2. Banca dati ufficiale delle etichette: sostituire `static/data/demo_etichette.json` con un servizio aggiornato (stesso formato dei campi).
3. Modello agronomico validato al posto di `recipes.efficacy`.
4. Codici e specifiche reali di sensori e valvole di sezione ARAG al posto di `static/data/demo_catalog.json`.
5. Non implementati: lettura GeoTIFF, disegno del perimetro sulla mappa, PDF generato dal server (si usa la stampa del browser).

## Problemi residui noti

- Versione online (Vercel e servizi serverless, `um/wsgi.py`): la sessione è nella memoria dell'istanza; quando l'istanza riparte il server risponde 409 «no_file» e il browser ricarica la sorgente (esempio, campo dimostrativo, file ancora in memoria) e ripete la richiesta. Caricamenti fino a circa 4 MB.
- Lo stato della pipeline vive nel browser (per file e operazione): un altro dispositivo non lo vede. Soluzione: salvarlo nella sessione del server o in un archivio, se servirà la condivisione.
- Le celle di una mappa GeoJSON possono sporgere dal confine del campo: il disegno non le ritaglia sui poligoni di zona.
- PDF: si ottiene dalla stampa del browser; un PDF generato dal server richiederebbe una libreria esterna.
