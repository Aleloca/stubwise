# App desktop Stubwise, area 5: Docs e Drive — design

Data: 25 ott 2026. Quinto documento della serie (ossatura
`docs/plans/2026-10-23-desktop-ossatura-design.md`, area 2
`…-area2-task-design.md`, area 3 `…-area3-claude-design.md`, area 4
`…-area4-chat-design.md`). Si costruisce nel prototipo `apps/desktop` con
dati finti, con le stesse regole: ogni pagina definita fino in fondo, stati
veri, permessi verificati col «vedi come». Linguaggio visivo
`apps/desktop/DESIGN.md`; UI e UX definite con Impeccable (shape →
costruzione → revisione).

Le decisioni marcate *(maintainer)* vengono dalla conversazione; quelle
marcate *(scelta del costruttore)* sono proposte confermabili.

## Perché

**Docs.** La documentazione generata dai repository funziona e non dà
problemi: si porta com'è *(maintainer)*.

**Drive.** Concetto nuovo (l'ossatura lo chiama «spazio file del progetto»).
Tre fatiche di oggi *(maintainer)*:

1. **Il nome di un file non lo ricorda nessuno.** Si ricorda cosa c'era
   dentro. La ricerca deve guardare il contenuto, non solo il nome.
2. **I file usati davvero si perdono fra gli altri.** Stubwise sa quante
   volte un file viene aperto: i più usati devono venire a galla da soli,
   senza che qualcuno li fissi a mano.
3. **Il team non smette di usare Google Drive**, e buona parte dei documenti
   resterà lì. Stubwise deve arrivarci, non sostituirlo.

## Obiettivi

- **Docs come oggi**, dentro il progetto: spazi per repository, pagine
  generate e manuali, brief, releases, grafo, ricerca, chat
  *(maintainer)*.
- **Un Drive per progetto** con due tipi di file nello stesso elenco: file
  **caricati** in Stubwise e **riferimenti** a file di Google Drive
  *(maintainer)*.
- **Ricerca dentro i file** *(maintainer)*: testo intero indicizzato per
  trovare, più un **riassunto AI** di ogni file mostrato nei risultati per
  capire al volo se è quello giusto *(scelta del costruttore: le due cose
  insieme, che il maintainer aveva messo in alternativa)*.
- **I più usati salgono** *(maintainer)*: conteggio delle aperture visibile a
  tutti, usato per ordinare.
- **Claude e la chat leggono anche il Drive** *(maintainer)*.

## Non obiettivi

- **Versioni** dei file: ricaricare un file ne crea uno nuovo *(scelta del
  costruttore)*.
- **Modificare** un file dentro Stubwise (né caricati né Google).
- **Condividere** file con esterni (link pubblici).
- **Cartelle create in Stubwise**: l'organizzazione è filtri + ordinamenti
  (vedi sotto) *(scelta del costruttore)*.
- Cambiare i Docs: nessuna funzione nuova oltre al trasloco *(maintainer)*.

## Anti-obiettivi

- Un Drive che **duplica** Google Drive o costringe a spostarci i file: i
  file Google restano su Google e si aprono su Google.
- Un **contatore di sorveglianza**: chi ha aperto cosa non è in vista di
  tutti; serve a ordinare, non a controllare.
- Ricerca che **rivela l'esistenza** di un file a chi non può vederlo
  (stessa regola dell'area 4, R-G5: nascosto e inesistente sono identici).

## Docs *(maintainer: come oggi)*

Tutto ciò che `apps/desktop/docs/web-inventory.md` elenca sotto
«Documentation» si porta **dentro il progetto**, sezione Docs (modulo: c'è
solo nei progetti che lo accendono, dall'ossatura):

- **Pagina iniziale del progetto** (oggi «Project docs landing»): identità
  del brief, «Inizia da qui», spazi dei repository, sintesi del registro
  decisioni (il registro intero sta già in Overview, area 2: qui il link),
  «Novità», **chat del progetto** (RAG su tutti i repository, fonti col nome
  del repository, domande suggerite, nuova chat; stato «chat non
  disponibile»).
- **Spazio per repository**: albero Technical/Functional/Product/Manual
  (comprimi/espandi, scarica categoria .zip), pannello di generazione (stati
  never/queued/running/succeeded/failed/held/paused, ultimo commit, costo,
  provider, «Genera» e «Riprendi» con `docs.generate`, «+ Nuova pagina
  manuale»), indice del repository (brief, inizia da qui, categorie, novità,
  aggiornate di recente, più lette), pagina (badge, avviso di pagina
  vecchia coi commit successivi, collegamenti implements/implemented by/
  related, modifica ed eliminazione delle manuali con `docs.edit`, pagina
  non trovata), form pagina manuale (conflitto di slug), brief del
  repository (sezioni, fatti riservati, pagine escluse), releases (ricerca,
  «Solo significative», badge minor, pagine toccate), grafo (tutti gli stati
  e le azioni con `repos.manage`), chat del repository.
- **Ricerca**: ⌘K dentro uno spazio Docs cerca in quello spazio, con Tab per
  allargare a tutto (come oggi). Il «Docs hub» non ha una pagina sua: i Docs
  di più progetti si cercano da ⌘K (ossatura).
- La chat dei Docs usa le citazioni dell'area 3 (stesso componente, stesse
  regole R-E9).

*(scelta del costruttore)* Unica aggiunta di forma: le fonti della chat dei
Docs possono essere anche **file del Drive** del progetto (vedi «Claude»).

## Drive

### Cosa contiene *(maintainer)*

Ogni progetto ha il suo Drive (sempre presente, non è un modulo:
dall'ossatura). Due tipi di file, **un solo elenco**:

- **Caricati**: trascinati o scelti dal disco dentro il progetto. Si aprono
  **dentro Stubwise**: anteprima per PDF, immagini e testo/markdown; gli
  altri formati si scaricano *(scelta del costruttore sui formati)*.
- **Google**: riferimenti a file di Google Drive. Si aprono **in Google
  Drive** (browser) *(maintainer)*. Stubwise conserva nome, tipo,
  proprietario, ultima modifica, testo estratto e riassunto.

### Come un file Google entra nel progetto *(maintainer)*

1. **Cartella collegata**: ogni progetto può collegare **una o più cartelle**
   di Google Drive; **tutti** i file che contengono (sottocartelle comprese,
   *scelta del costruttore*) entrano nel progetto da soli e vi restano
   finché stanno nella cartella. Il contenuto diventa **leggibile da tutti i
   membri del progetto**, anche da chi su Google non avrebbe accesso
   *(maintainer)*: la cartella la legge Stubwise con l'account Google di chi
   l'ha collegata, e il dialogo di collegamento lo dice in chiaro.
2. **Aperto dalla ricerca**: la ricerca di Stubwise trova anche file di
   Google Drive **non ancora** in un progetto (quelli che l'account Google di
   chi cerca può vedere); aprirne uno lo apre su Google e **chiede a quale
   progetto collegarlo** *(maintainer)*. «Non ora» lo apre senza
   collegarlo. Collegato, da lì in poi si trova come ogni file del progetto.
3. **Aggiunto a mano**: «Aggiungi da Google Drive» nel Drive del progetto
   (selettore di file Google) *(scelta del costruttore)*.

Un file Google può stare in più progetti? *(scelta del costruttore)* Sì: è un
**riferimento per progetto**, con il suo codice, il suo conteggio e il suo
storico in ciascun progetto.

**Togliere un file di una cartella collegata** *(scelta del costruttore)*: non
si «toglie», si **nasconde dal progetto** (`drive.manage`). Resta su Google e
nella cartella; Stubwise ricorda l'esclusione, così la sincronizzazione non lo
rimette. I nascosti si vedono nel filtro «Nascosti» e si possono rimostrare.
I file di una cartella risultano **aggiunti da chi ha collegato la
cartella**.

### Codici *(scelta del costruttore; l'ossatura li lascia a quest'area)*

- File del Drive: prefisso del progetto + **F** + numero (`AUD-F7`). Un file
  Google in due progetti ha due codici, uno per riferimento.
- Pagine dei Docs: prefisso del progetto + **D** + numero (`AUD-D12`),
  stabile anche se la pagina cambia titolo o percorso. Le pagine dei dati
  finti esistenti ricevono il loro codice.
- Valgono le regole dell'ossatura (codice scritto a mano → link con
  anteprima) e quella dell'area 4 R-G5 (nascosto e inesistente identici).

### Organizzazione *(scelta del costruttore)*

- Nessuna cartella creata in Stubwise. Un elenco con **filtri** (tipo:
  documento, foglio, presentazione, PDF, immagine, altro; provenienza:
  caricato / Google; chi l'ha aggiunto) e **ordinamenti**: **Più usati**
  (predefinito), Recenti (ultima apertura o modifica), Nome.
- Le **cartelle Google collegate** compaiono come gruppi richiudibili in
  testa, con il nome della cartella e il numero di file.
- Ogni riga: icona del tipo, nome, provenienza (Google con la sua icona di
  apertura esterna), chi l'ha aggiunto, ultima modifica, **numero di
  aperture**, e la prima riga del riassunto.
- Dettaglio di un file (pannello a destra, come il dettaglio della task):
  anteprima (caricati) o scheda (Google), riassunto AI intero, metadati,
  aperture totali, **storico delle aperture** (solo con il permesso),
  «Apri» / «Apri in Google Drive», «Scarica», «Copia il link», «Cita in
  Chat», «Elimina» / «Togli dal progetto».

### Dove vive

- **Dentro il progetto**: sezione **Drive** della colonna (sempre presente).
- **Destinazione Drive sul binario** *(scelta del costruttore)*: i file di
  **tutti i progetti** che vedi, con un filtro per progetto, come Tasks
  raccoglie le task. Stessi filtri e ordinamenti. Una riga per riferimento:
  un file Google in due progetti compare due volte, ognuna col suo progetto e
  il suo conteggio (le azioni agiscono su quel riferimento).

### Aperture e «più usati» *(maintainer)*

- Ogni apertura conta: anteprima di un file caricato, «Apri in Google
  Drive», download. **Non** contano: comparire in un risultato, il
  riassunto letto nei risultati, la lettura di Claude.
- La stessa persona che riapre lo stesso file **entro 30 minuti** conta una
  volta *(scelta del costruttore)*.
- Il **numero** di aperture è visibile a **tutti** quelli che vedono il
  file *(maintainer)*.
- **Finestra di 90 giorni** *(maintainer)*: «Più usati» ordina sulle
  aperture degli **ultimi 90 giorni**, e la riga mostra quel numero («12 negli
  ultimi 90 giorni»); il totale da sempre sta nel dettaglio del file. Un file
  non più aperto scende da solo.
- Lo **storico** (chi, quando) lo vede solo chi ha **`drive.history`**
  *(maintainer: permesso apposito)*.
- Il conteggio ordina il Drive («Più usati») e pesa nella ricerca a parità di
  pertinenza *(scelta del costruttore)*.
- Un file aperto da Google direttamente (fuori da Stubwise) non conta: non lo
  sappiamo.

### Ricerca nei file *(maintainer)*

- Per ogni file Stubwise **estrae il testo** (Google Docs/Sheets/Slides
  esportati in testo, PDF, testo/markdown, docx; OCR per PDF scansionati e
  immagini) e lo **indicizza** per la ricerca semantica, come i Docs.
- Ogni file ha un **riassunto AI** di 2–3 frasi, mostrato nei risultati e nel
  dettaglio.
- **Stati del contenuto** di un file: in elaborazione, pronto, nessun testo
  (es. immagine senza testo), formato non supportato, errore di estrazione
  (con «Riprova» per chi gestisce il Drive). Un file non ancora pronto si
  trova per nome.
- La ricerca del Drive (nel Drive e in ⌘K, gruppo **File**) mostra:
  nome, progetto, riassunto, il passaggio del testo che corrisponde con
  l'evidenziazione (come la ricerca della Chat), numero di aperture.
- Un file Google modificato su Google viene **reindicizzato**; nel
  prototipo: un file «aggiornato su Google» con il riassunto in
  rielaborazione.

### Casi limite

- **File Google cancellato** o a cui Stubwise ha **perso accesso** (cartella
  scollegata su Google, account che l'aveva collegato disconnesso): resta
  nell'elenco come **«non disponibile»** con la causa; si può togliere dal
  progetto *(maintainer)*. Testo e riassunto restano cercabili? *(scelta del
  costruttore)* No: un file non disponibile si trova solo per nome, finché
  qualcuno non lo toglie.
- **Account Google non collegato** per chi cerca: la ricerca trova i file
  Google già nei progetti (li legge Stubwise), non quelli fuori; un invito a
  collegare l'account.
- **Collegamento della cartella scaduto**: avviso nel Drive del progetto a
  chi gestisce, con «Ricollega».
- **Caricamento**: in corso con avanzamento, fallito con «Riprova», file
  troppo grande (limite *scelta del costruttore*: 100 MB), nome uguale a uno
  esistente (si tengono entrambi, il nuovo con «(2)»).

## Claude *(maintainer)*

- Claude (destinazione, sezione della task, @Claude in Chat) e le chat dei
  Docs **leggono il contenuto dei file del Drive** dei progetti che chi
  chiede vede, con le stesse regole della ricerca.
- Le risposte **citano i file** come citano le pagine (citazione con codice/
  nome, apertura con un clic, R-E9 se il file non è più visibile).
- Esempio da avere nei dati finti: «cosa dice il contratto col cliente sui
  tempi di consegna» → risposta con citazione del contratto (file Google)
  del progetto.
- Claude **non carica né collega** file: non è fra le azioni dell'area 3
  *(scelta del costruttore)*.

## Citazioni *(scelta del costruttore)*

- I file del Drive si citano con «#» in Chat, nelle task e con Claude:
  nuovo tipo di citazione **drive** (accanto a `file`, che resta il file di
  un repository). Anteprima: nome, tipo, progetto, riassunto.
- Gli **allegati** dei messaggi della Chat (area 4) **non** entrano da soli
  nel Drive: l'allegato ha «Salva nel Drive» (con `drive.upload`). In un
  canale di progetto salva in quel progetto; in un DM o in un canale
  generale chiede il progetto, fra quelli in cui hai `drive.upload` (nessuno
  → l'azione non c'è). Chiude la decisione aperta dell'area 4.

## Quanto è vero nel prototipo *(scelta del costruttore)*

- **Caricare** legge davvero il file trascinato o scelto (nome, tipo,
  dimensione) nel renderer; l'anteprima di immagini, PDF e testo usa il file
  vero finché l'app resta aperta (al riavvio il file caricato resta
  nell'elenco con un'anteprima finta). Nessun lavoro nel processo main.
- **Testo estratto, OCR, riassunti e reindicizzazione** sono finti: arrivano
  dopo un ritardo simulato con gli stati veri (in elaborazione → pronto).
- **«Apri in Google Drive»** non apre il browser: mostra un avviso «Aperto in
  Google Drive» e conta l'apertura (nel prodotto vero: la pagina del file).
- **Google** (account collegato, cartelle, selettore di file) è simulato con
  i dati finti, come le altre integrazioni del prototipo.

## Permessi

- Nuovi permessi di progetto *(maintainer sul principio, scelta del
  costruttore sui nomi)*:
  - **`drive.upload`**: caricare file e aggiungere singoli file Google;
  - **`drive.manage`**: collegare/scollegare cartelle, eliminare o togliere
    file degli altri, «Riprova» sull'estrazione;
  - **`drive.history`**: vedere lo storico delle aperture.
- **Vedere** il Drive: essere membro del progetto (come le task: Viewer
  compreso). Nessun permesso nuovo per leggere.
- Ognuno **elimina i propri** file caricati e toglie i file Google che ha
  aggiunto lui *(maintainer)*.
- Preset *(scelta del costruttore)*: Project Lead tutti e tre; Developer
  `drive.upload`; Contributor `drive.upload`; Viewer nessuno.
- I permessi dei Docs restano quelli di oggi (`docs.view`, `docs.edit`,
  `docs.generate`, `repos.manage` per il grafo).
- Collegare il **proprio account Google** è un'impostazione personale
  (Impostazioni → Account), la stessa che servirà a Posta e Calendario
  (area 6) *(scelta del costruttore)*.

## Stati

Ogni pagina: caricamento, vuoto (con l'azione se permessa: «Carica un
file», «Collega una cartella»), errore con «Riprova», pieno, senza permessi.
Per i file: caricamento, contenuto in elaborazione, pronto, nessun testo,
non supportato, errore di estrazione, non disponibile. Per Google: account
non collegato, collegamento scaduto. Per i Docs: tutti gli stati di oggi.

## Dati finti

- **Docs**: gli spazi di AUD e STW come oggi (pagine generate e manuali,
  brief, releases, grafo pronto per uno e spento per l'altro, una
  generazione in pausa per limite), chat con risposte e fonti.
- **Drive**: in AUD una cartella Google collegata («AUD – Cliente») con un
  contratto, un preventivo (foglio), una presentazione; file caricati (PDF
  di specifiche, immagini dei mockup, un .zip); MKX con molti file grafici e
  una cartella collegata; un progetto senza file (stato vuoto).
- Conteggi di apertura diversi (alcuni file molto usati, altri mai aperti),
  storico per persona; un file Google «non disponibile», uno in
  elaborazione, un PDF scansionato con OCR, un'immagine senza testo.
- Un file Google fuori dai progetti, trovabile dalla ricerca di chi ha
  l'account collegato, per provare «a quale progetto?».
- Persone con account Google collegato e non (per il «vedi come»).

## Parità con il web

Le voci «Documentation» dell'inventario si portano tutte (tabella in
`apps/desktop/docs/area5-parity.md`). Il Drive non esiste nel web: le sue
voci sono nuove e non hanno parità da chiudere. Le «view pings» dei Docs
(«più lette») restano come oggi e non diventano il contatore del Drive.

## Lasciato al costruttore

- Forma visiva di elenco, dettaglio e anteprime (shape Impeccable).
- Lunghezza e tono del riassunto AI; quali formati hanno l'anteprima.
- Come si presenta «a quale progetto?» (dialogo, foglio, inline).
- Ordine dei gruppi di ⌘K con il nuovo gruppo File.

## Decisioni aperte

- Struttura del cassetto Google comune a Drive, Posta e Calendario (area 6).
