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

## Dati reali, dichiarati e dimostrativi

| Dato | Natura |
|---|---|
| Geometrie, superfici, ratei della prescrizione | reali, dal file caricato (gli 8 esempi sono sintetici, dichiarati) |
| Mappa NDVI di prova `static/data/esempio_ndvi.geojson` | **dimostrativa**, generata da `tools/make_geojson_example.py` |
| Catalogo ARAG (119 prodotti) | dalle pagine pubbliche (`docs/RICERCA_MERCATO.md`), da verificare con ARAG |
| Prodotti fitosanitari, n. di registrazione, dosi, volumi, prezzi | **dichiarati dal tecnico** con la fonte; l'app non ha un archivio |
| Volumi di miscela da GeoJSON | regola lineare scelta dal tecnico |
| Efficacia agronomica | **non stimata** (manca un modello validato): l'app mostra indicatori calcolati |
| Dichiarazioni dell'operatore | riportate come dichiarazioni, non verificate |

## Verifiche eseguite

- 70 test automatici (49 preesistenti + 21 nuovi in `tests/test_pipeline.py`), verdi su Python 3.9, 3.11 e 3.13.
- Percorso completo nel browser a 1440 e 375 px: esempio 01 → zone → dati di etichetta → ricettari → scelta → hardware adeguato → hardware senza regolazione (insufficiente) → proposta ARAG applicata (adeguata) → documento da completare → dichiarazioni → validato → JSON e ISOXML scaricati → cambio al ricettario A non conforme → validazione annullata e bloccata con il motivo.
- Tutti gli 8 esempi attraversano le fasi 1–6 senza errori JS né scorrimento orizzontale (375 e 1280 px).
- Import GeoJSON dall'interfaccia, rifiuto di coordinate proiettate e sistemi di riferimento diversi da WGS84.

## Integrazioni ancora necessarie

1. **Acquisizione satellitare diretta**: serve un fornitore con licenza commerciale, account e chiave (`um/satellite.py` descrive l'interfaccia; la chiave va in una variabile d'ambiente). Oggi si caricano file GeoJSON esportati dalle piattaforme.
2. **Banca dati delle etichette**: per precompilare dosi e autorizzazioni da fonte ufficiale (es. Ministero della Salute) serve un servizio o un'esportazione aggiornata con condizioni d'uso compatibili. Oggi i dati sono inseriti dal tecnico con la fonte.
3. **Modello di efficacia agronomica**: necessario per stimare il risultato atteso; senza, l'app non lo dichiara.
4. **Catalogo**: mancano sensori e sezioni di barra (le righe compaiono come «non verificabile»); la compatibilità IBX/ISOBUS va confermata con ARAG.
5. **Shapefile e GeoTIFF**: non letti (richiederebbero librerie esterne; il progetto usa solo la libreria standard).
6. **Disegno del perimetro sulla mappa**: non implementato; il perimetro viene dal file o è stimato (inviluppo convesso, dichiarato).

## Problemi residui noti

- Lo stato della pipeline vive nel browser (per file e operazione): un altro dispositivo non lo vede. Soluzione: salvarlo nella sessione del server o in un archivio, se servirà la condivisione.
- Le celle di una mappa GeoJSON possono sporgere dal confine del campo: il disegno non le ritaglia sui poligoni di zona.
- PDF: si ottiene dalla stampa del browser; un PDF generato dal server richiederebbe una libreria esterna.
