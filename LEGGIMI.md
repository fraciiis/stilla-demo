# Stilla

Dalla mappa del campo al trattamento documentato, in sei fasi: carichi la prescrizione ISOXML o una mappa indice GeoJSON, vedi le **zone di intervento**, confronti **tre ricettari** calcolati sui dati di etichetta, verifichi la tua **attrezzatura Nordson/ARAG**, vedi i **componenti ARAG** che servono davvero e prepari la **scheda del trattamento** (stampabile, JSON) insieme al file ISOXML per il terminale. Architettura e limiti: `docs/PIPELINE.md`.

## Avvio (non serve installare nulla oltre a Python 3.9+)

| Sistema | Cosa fare |
|---|---|
| Windows | doppio clic su `run_windows.bat` |
| macOS | doppio clic su `run_macos.command` (la prima volta: clic destro → Apri) |
| Linux | `./run_linux.sh` |

Si apre il browser su `http://localhost:8765/`. Nella finestra nera compaiono anche gli indirizzi per gli amici.

## Pubblicarla online (un link da aprire con qualunque browser)

Il progetto è pronto per i servizi che eseguono app Python o container; non serve installare dipendenze.

- **Render, piano gratuito** (consigliato): crea un account su render.com, poi apri
  `https://render.com/deploy?repo=https://github.com/fraciiis/stilla-demo/tree/claude/esecuzione-progetto-1q3bi4`
  (oppure Dashboard → New → Blueprint → questo repository). La configurazione è in `render.yaml`. Dopo 2–3 minuti
  ricevi un indirizzo `https://….onrender.com` da condividere. Nel piano gratuito il servizio si addormenta dopo
  ~15 minuti senza visite: la prima apertura successiva impiega circa un minuto.
- **Vercel**: importa il repository su vercel.com (Add New → Project), scegli il ramo e pubblica senza cambiare
  impostazioni: la configurazione è in `vercel.json` (funzione Python `api/index.py`, adattatore `um/wsgi.py`).
  Limiti della versione online: file caricati fino a circa 4 MB; la memoria del server non è garantita tra una richiesta e
  l'altra, quindi se l'istanza riparte il browser ricarica da solo esempio, campo dimostrativo o file e ripete la richiesta
  (un file caricato a mano va ricaricato solo se nel frattempo hai ricaricato anche la pagina).
- **Altri servizi con container** (Fly.io, Railway, Koyeb, Google Cloud Run): usano il `Dockerfile`; l'app legge la porta da `PORT`.
- **Solo per una presentazione dal tuo computer**: avvia l'app e condividi l'indirizzo «per gli amici» (stessa rete Wi-Fi),
  oppure crea un link temporaneo con un tunnel (es. `cloudflared tunnel --url http://localhost:8765`).

Chi apre il link vede l'app completa; le sessioni vivono nella memoria del server e si perdono a ogni riavvio.

## Prova veloce (modalità dimostrativa)

Nella pagina iniziale scegli uno dei 4 **campi dimostrativi** (vigneto, mais, frumento, pomodoro): vedi ortofoto, NDVI e, per il mais, la mappa delle infestanti; scegli l'acquisizione da drone o Sentinel-2 (puoi cercare altre scene) e avvia il processo. Nella fase Ricettari aggiungi un prodotto dalla **banca dati etichette DEMO**. Campi, immagini, prodotti, efficacia, sensori e valvole di sezione marcati DEMO sono **inventati ma verosimili** e servono a mostrare il funzionamento (dettagli in `docs/PIPELINE.md`).

## Come si usa

1. **Mappa e zone**: scegli un campo dimostrativo, oppure trascina il `.zip`/`TASKDATA.XML`, una mappa indice `.geojson` o uno shapefile zippato (WGS84 o UTM; scegli indice, numero di zone e i due volumi estremi), oppure prova un esempio ISOXML. Vedi classi di intervento, variabilità e da dove arriva ogni dato.
2. **Ricettari**: inserisci i dati letti sull'etichetta autorizzata (n. registrazione, fonte, dosi, volumi, prezzo). L'app calcola tre proposte: **A** aderente alla prescrizione, **B** minimo prodotto entro etichetta, **C** rateo unico, con tabella di confronto.
3. **Scelta**: scegli una proposta; la decisione e la nota entrano nel registro. La scelta non autorizza l'esecuzione.
4. **Hardware**: indica ugelli, Flowtron, SELETRON, velocità… Il riquadro «Ricettario sull'hardware» confronta requisito per requisito (adeguata / parziale / insufficiente); mappa, indicatori e schede (Zone, Ugelli e portate, Meteo, Come si calcola) lavorano sui volumi del ricettario.
5. **Componenti ARAG**: compare quando serve. Proposte dal catalogo, divise in indispensabili / per la precisione / opzionali, con prima e dopo ricalcolati; «Prova questa configurazione» le applica.
6. **Documenti**: completa operatore, certificato, bersaglio, date (e quantità effettive se eseguito), conferma le dichiarazioni e valida. Esporti la scheda (stampa/PDF), i dati JSON, il file ISOXML per il terminale (riletto e verificato dal server) e il rapporto tecnico.

Il riepilogo sotto il nome del file mostra in ogni momento stato del trattamento, dati mancanti, avvisi e decisioni. Cambiare prodotti, ricettario o hardware aggiorna le verifiche a valle e annulla la validazione.

## Perché gli amici non riuscivano ad aprirlo (e cosa è cambiato)

- Il server ora ascolta su tutte le interfacce (`0.0.0.0`), non solo su `localhost`.
- Gli indirizzi mostrati sono ordinati: prima quello della rete principale, in fondo gli adattatori virtuali (VirtualBox, Docker, WSL), che erano la causa tipica dell'IP sbagliato. Il bottone **Condividi con gli amici** mostra indirizzo e QR.
- La porta è **8765** (la 5000 su Mac è occupata da AirPlay). Se è occupata, prende la successiva e te lo dice.
- Ogni visitatore ha una **sessione separata** (cookie): prima il file caricato da uno finiva a tutti.
- Windows: alla prima esecuzione compare la finestra del firewall: scegli **Consenti**. Se l'hai chiusa o annullata, esegui `apri_firewall_windows.bat` come amministratore (`chiudi_firewall_windows.bat` toglie la regola). macOS: «Consenti connessioni in entrata».
- Gli amici devono essere sulla **stessa rete Wi-Fi** (non dati mobili, non rete «ospiti» isolata dal resto).
- Fuori casa serve un tunnel (ad esempio `cloudflared tunnel --url http://localhost:8765`): non è incluso e **non l'ho potuto provare**. Chi ha l'indirizzo può usare l'app e caricare file: usalo solo per il tempo necessario.

## Cosa fa il file specializzato (e cosa no)

- Riscrive nel TASKDATA **solo i ratei che il tuo impianto non può erogare**, portandoli al valore più vicino che riesce a distribuire (strategia *variabile*), oppure a un rateo unico con stesso volume totale se la catena non esegue ratei variabili (strategia *uniforme*). Le zone già raggiungibili restano identiche; la geometria non viene toccata. Aggiunge una nota breve («UM NORDSON …») nell'operazione.
- **Non** contiene comandi proprietari Nordson/ARAG: ugello, pressione, velocità e duty sono indicazioni per l'operatore (tabella Zone e Rapporto).
- Il rateo riscritto cambia la dose: per questo l'app mostra la variazione di volume e chiede conferma.

## Cosa è calcolato e cosa è un'ipotesi

- Portata per ugello `q = rateo × velocità × interasse / 600`; curva portata/pressione dal catalogo ARAG/ASJ (interpolata). Per gli ugelli con un solo punto di catalogo (famiglie WRC 80/110 e AFC 80) uso √pressione e lo segnalo come **stima**.
- Con Flowtron (PWM) pressione fissa e apertura variabile; il **duty minimo (20 %) è un'ipotesi** modificabile. Senza PWM regola solo la pressione.
- Compatibilità fra componenti (terminale con Task Controller, IBX con IBX, regolazione di portata, finestra di pressione) dal catalogo pubblico: **da confermare con ARAG** prima di lavorare.
- Orientamento delle griglie GRD (riga 0 a sud, colonne da ovest): lettura mia della norma, da **confermare con un tuo export reale**. Non provato su un terminale Delta vero.
- **Etichette e ricettari**: non ho un archivio di etichette e non invento autorizzazioni. Dosi e volumi li copi dall'etichetta ufficiale indicando la fonte (restano nel tuo browser); con un'unica miscela la dose segue il volume di ogni zona. L'efficacia agronomica non è stimata.
- **Documenti**: la scheda supporta la tracciabilità ma non attesta la conformità normativa; «validato» è la conferma del tecnico.
- **Meteo**: previsioni Open-Meteo (serve internet sul dispositivo); soglie orientative, non un parere agronomico.
- Il catalogo ha 119 prodotti (ugelli ASJ AFC 80/110, WRC 80/110 e SF 110, SELETRON, FCV, flussimetri Orion, valvole 853, pompa MSP400, terminali Delta/Bravo, IBX50/IBX100) tratti da pagine pubbliche; `docs/RICERCA_MERCATO.md` elenca le fonti.

## Per sviluppatori

- Solo libreria standard Python, nessuna dipendenza. `python3 app.py [--port=9000] [--local] [--no-browser]`; variabili `PORT`, `STILLA_HOST`, `NO_BROWSER`.
- `python3 -m unittest discover -s tests -t .` (80 test: lettura ISOXML, idraulica, catene, specializzazione, server, sessioni, caricamenti ostili, zone, ricettari, compatibilità, proposte ARAG, documenti, GeoJSON, shapefile/UTM, modalità dimostrativa).
- `python3 tools/make_demo_fields.py` rigenera i campi dimostrativi (`static/demo/fields.json`).
- `python3 tools/make_geojson_example.py` rigenera la mappa NDVI di prova (`static/data/esempio_ndvi.geojson`, dati sintetici).
- `python3 tools/make_examples.py` rigenera gli 8 esempi in `examples/`.
- Limiti: file 25 MB, 4 milioni di celle, 80 sessioni in memoria per 6 ore. XML con DTD/entità e ZIP con percorsi non sicuri vengono rifiutati.
- Struttura: `um/isoxml.py` (lettura/scrittura), `um/hardware.py` (catalogo e catena), `um/engine.py` (idraulica, piano, specializzazione, suggerimenti), `um/zoning.py` (zone), `um/geoimport.py` (GeoJSON → ISOXML), `um/recipes.py` (ricettari), `um/matching.py` (compatibilità e proposte ARAG), `um/dossier.py` (documenti), `um/satellite.py` (punto di integrazione satellitare), `um/demo.py` (campi e acquisizioni simulati), `um/shapefile.py` (shapefile e UTM), `um/service.py` (sessioni, API), `um/server.py` (HTTP), `static/` (interfaccia: `pipeline.js` stato condiviso, un modulo per fase).
