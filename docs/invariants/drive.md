# Drive: i file caricati nei progetti (11 nov 2026)

Area 5, fetta 2 dell'integrazione del desktop (piano
`docs/plans/2026-11-11-integrazione-area5-fetta2-plan.md`; decisioni D1 = a,
niente Google fino all'area 6; D3 = a, permessi come il prototipo; D4 = a, 100 MB
e i tipi della Chat). Migrazione `packages/db/drizzle/0143_drive_files.sql`,
servizio `apps/server/src/drive/service.ts`, rotte `apps/server/src/routes/drive.ts`,
test `apps/server/src/routes/drive.test.ts`.

## Chi vede, chi carica, chi toglie: lo decide il SERVER

- **Vedere il Drive di un progetto vuol dire esserne MEMBRI** (Viewer compreso;
  i full admin sono membri impliciti), non avere un permesso: per questo le
  rotte sono `{ kind: "user" }` e il controllo sta nel servizio
  (`visibleProjectIds`). Un file di un progetto che non si vede risponde 404
  come uno che non esiste, ovunque: elenco del progetto, dettaglio, download,
  anteprima, codici; l'elenco globale filtra nella WHERE.
- Caricare vuole `drive.upload` nel progetto (Project Lead, Developer,
  Contributor, Legacy Member); il controllo gira PRIMA di leggere il file, così
  un 403/404 non costa la lettura di 100 MB.
- Eliminare: il PROPRIO file, oppure qualunque con `drive.manage` (solo Project
  Lead). La storia delle aperture (chi e quando) solo con `drive.history`
  (solo Project Lead): senza, `history` è null. `permissions.delete` di una
  riga lo calcola il server; il client lo legge, non lo deduce.
- I permessi nuovi li hanno ricevuto anche i ruoli che contenevano già tutti i
  permessi di un preset (la regola della 0135, `permissions.md`).

## Il binario va in STREAMING, mai tutto in memoria

- Il caricamento è multipart, un file per richiesta, al più
  `DRIVE_FILE_MAX_BYTES` (100 MB, `@stubwise/shared`), 30 al minuto per persona.
  Lo stream va dritto allo storage (`putObjectStream`, `@aws-sdk/lib-storage`,
  parti da 5 MB, una alla volta): il server non tiene mai il file intero.
  `putObject` col Buffer resta per gli allegati della Chat (25 MB).
- Il multipart è UN file e nient'altro: `files: 1, fields: 0, parts: 1`; un
  campo o una parte in più è 400 `invalid_multipart` (anche per gli allegati
  della Chat).
- Lo stream passa da `stream.pipeline`, MAI da `.pipe()`: un client che si
  stacca distrugge lo stream senza errore, e con `.pipe()` il contatore non
  finiva mai, l'handler restava appeso e il multipart S3 restava aperto. Con
  `pipeline` la chiusura prematura è un errore (400 `upload_incomplete`), e
  `putObjectStream` chiama `Upload.abort()`.
- Due difese contro un file troppo grande, e servono entrambe: il limite di
  busboy (`request.file({ limits })`) e un contatore di byte nel servizio, che
  ferma lo stream A METÀ anche per un chiamante che non passa da busboy. Oltre
  il tetto: 413 `file_too_large`, l'oggetto parziale si toglie, nessuna riga.
- La riga nasce DOPO l'oggetto; se l'insert fallisce, l'oggetto si toglie.
- Un oggetto rimasto senza riga (caricamento interrotto o troppo grande,
  insert o copia falliti) non si ingoia: si prova a toglierlo, e se lo storage
  rifiuta la chiave va in `storage_orphans` (0144), che la pulizia oraria
  ritenta (`purgeStorageOrphans`). Mai un `deleteObject(...).catch(() => undefined)`.
- Il nome mostrato perde i caratteri di controllo (NUL compreso) e quelli di
  direzione del testo (bidi), e resta entro 255 anche con « (2)»
  (`displayFileName`, `storage/filenames.ts`, lo stesso per la Chat).

## L'anteprima inline solo da un'ALTRA origine, e solo per i tipi sicuri

- `GET /api/drive/files/:id/preview` è inline SOLO se lo storage serve gli URL
  firmati da un'origine DIVERSA da quella dell'istanza (`storage.origin` contro
  `PUBLIC_URL`). Dalla stessa origine un file caricato (un HTML, un SVG) girerebbe
  coi cookie della sessione di chi lo apre: lì l'anteprima è sempre un
  download (`attachment`).
- E anche da un'altra origine, inline solo per i tipi di `inlineContentTypeFor`,
  col Content-Type DECISO dal server, non quello dichiarato da chi ha caricato:
  PDF, immagini raster (png, jpeg, gif, webp), e il testo (plain, markdown, csv)
  servito come `text/plain; charset=utf-8`. Mai HTML, mai SVG. Il resto è
  `attachment`. Il download è sempre `attachment`.
- Chi aggiunge un tipo all'elenco inline si chiede se un browser può
  ESEGUIRLO: se sì, non ci va.
- Limite accettato: l'URL firmato di S3 non può portare
  `X-Content-Type-Options: nosniff`. Regge perché il Content-Type lo forza il
  server sui soli tipi sicuri e perché inline c'è solo da un'altra origine;
  sta nel registro dei rimandi.

## Il codice `<PRJ>-F<n>` non si riusa: eliminare lascia una LAPIDE

- Il numero è per progetto, il massimo più uno sotto un advisory lock del
  progetto, contando anche le lapidi. Eliminare scrive `deleted_at` e la riga
  sparisce da ogni lettura; un numero eliminato non torna. Le eccezioni sono
  quelle dei codici delle task: un progetto eliminato porta via i suoi file in
  cascata, e un codice di progetto rinominato cambia il prefisso di tutti.
- Il nome è unico fra i file VIVI del progetto, senza distinzione di maiuscole:
  un doppione diventa «Nome (2).ext» e la risposta lo dice (`keptBoth`).
- L'oggetto nello storage si toglie DOPO la lapide, e `storage_purged` dice se è
  andata. Con lo storage giù la lapide si scrive comunque, e
  `purgeDeletedDriveObjects` (timer orario del server, accanto alla potatura
  degli allegati della Chat) ritenta, dalla lapide più vecchia; senza storage
  configurato non tocca niente. Ogni passo della pulizia oraria (Chat, lapidi,
  orfani) ha il SUO try (`runStorageHygiene`): uno che fallisce non salta gli altri.

## Le aperture si contano UNA volta ogni 30 minuti

- Download e anteprima scrivono un'apertura in `drive_opens`, salvo che la
  stessa persona abbia aperto lo stesso file negli ultimi 30 minuti: la
  deduplica è nella stessa INSERT (`where not exists`), non a lettura, sotto
  un advisory lock per (file, persona): due aperture insieme ne contano una.
- «Più usati» ordina per aperture degli ultimi 90 giorni, di tutti.

## «Save to Drive» è una COPIA, mai un riferimento

- (Fetta 2.4.) Salvare un allegato della Chat nel Drive copia l'oggetto
  (`copyObject`) sotto una chiave nuova del Drive: le due vite sono separate, e
  eliminare il messaggio non tocca il file del Drive, né il contrario.
- In gara con l'eliminazione del messaggio l'oggetto della Chat può non esserci
  più: `copyObject` lancia `StorageObjectNotFound` (S3 `NoSuchKey`) e la
  rotta risponde 404, non 500.

## Il contenuto (fetta 3): il worker LEGGE lo storage, e solo quello

- (Area 5, fetta 3, decisione (a) dell'orchestratrice.) Il worker legge gli
  oggetti del Drive per estrarne il testo: `apps/worker/src/drive/storage-read.ts`,
  UNA funzione (`getObjectStream`), solo chiavi `drive/` senza `..`, e un tetto
  di byte letti pari al peso nel DB più 1 MB (oltre, lo stream si ferma e il
  file è `no_text` `limits`). Le credenziali sono quelle dell'istanza, quindi la
  sola lettura è una regola del CODICE: il sorgente del worker non importa
  niente che scriva, cancelli, copii o firmi (`storage-read.test.ts` lo verifica
  sul sorgente, e che l'SDK S3 compaia solo lì, con `GetObjectCommand` e
  `S3Client`). La configurazione S3 è una sola, `s3ConfigFromSettings` in
  `@stubwise/db`. Scrivere e potare restano del server. Limite accettato,
  nel registro: credenziali di sola lettura separate per il worker, se lo
  storage lo permette.
- Il file sta nella tmp del job col nome nostro (`input.<ext>`), scritto in
  streaming: il worker non tiene mai il file intero in memoria. Il resto delle
  regole sull'input non fidato sta nel docblock di `drive/extract/extract.ts`
  e `drive/extract/exec.ts`.
- Il riassunto è un run di un turno SENZA tool (nessun nativo, nessun MCP),
  `UsageTag { operation: "drive_summary", projectId }`, sui primi 20.000
  caratteri, con il testo incorniciato come documento da non seguire. È
  narrativa generata: non entra mai nel registro decisioni. Un documento ostile
  può far mentire solo il SUO riassunto (limite accettato).
- Il testo, il riassunto e i chunk si scrivono in UNA transazione guardata sulla
  lapide (`deleted_at is null`): un file eliminato a metà non riceve niente; la
  lapide li toglie nella sua transazione.
- La ricerca (F3.4): `q` cerca nel nome, nel codice e nel contenuto (la
  tsvector, più la corsia semantica sui chunk, fail-open, solo sotto una
  distanza coseno di 0,35 e al più 20 file). Visibilità nella WHERE di
  ENTRAMBE le corsie, prima del limite: un non membro col testo giusto non
  trova niente (test negativo). Lo `snippet` è testo PURO (ts_headline senza
  marcatori, al più 300 caratteri), calcolato in una query sola sulle righe
  restituite; null per le righe trovate per nome.
- La corsia semantica è ESATTA (review della F3): filtro prima, poi la
  distanza, il passaggio migliore per file (`DISTINCT ON`), senza `ORDER BY
  distanza LIMIT`, che scenderebbe sull'indice HNSW e perderebbe file oltre
  `ef_search`. Il costo, misurato il 12 nov 2026 (Docker Desktop, Apple
  Silicon): per un full admin che vede tutto, con 50.000 chunk nell'istanza,
  l'intera richiesta di ricerca sta a 290–340 ms a caldo (1,5 s la prima).
  Sopra la soglia di ~200 ms: la strada, se serve, è nel registro (HNSW con
  `ef_search` alto per chi vede tutto).
- «Riprova» (`POST /api/drive/files/:id/retry`): solo `drive.manage`, solo su
  `no_text` o `error` (409 `not_retryable` altrimenti); `permissions.retry` lo
  calcola il server con la stessa regola.
- **I riferimenti a Google Drive (area 6, F5b; la specifica è il prototipo,
  `apps/desktop/src/renderer/data/drive/`).** Un riferimento NON è una copia:
  il file resta su Google, «Apri» va su Google (`GET
  /api/drive/files/:id/open`, conta un'apertura `via: google`) e i permessi
  del file li applica Google a chi apre; un riferimento non si scarica né si
  vede in anteprima dallo storage, e un caricato non si apre «su Google».
  - **Il testo SÌ, come un caricato** (B2): lo stesso estrattore del worker,
    con la sorgente che legge da Google (export per Doc/Fogli/Presentazioni);
    contenuto NON fidato. Togliere un riferimento o un file sparito da Google
    ne cancella testo, riassunto e frammenti. Un file `access_lost` (di una
    cartella scaduta) li TIENE nel DB ma non li dà a nessuno: lo filtra la
    lettura (`driveFileUnreadableSql`, `apps/server/src/drive/service.ts`,
    review del server, punto 3, decisione «O»), cioè la ricerca per testo e
    semantica, gli snippet, il riassunto, il contenuto per Claude
    (`unavailable` nella risposta) e gli allegati; ricollegata la cartella,
    tornano. Il job del contenuto non riscrive un file che la
    sincronizzazione ha segnato `deleted` mentre lo leggeva.
  - **Si legge SOLO con la casella del riferimento** (B3,
    `drive_files.google_account_id`): quella di chi l'ha aggiunto, o di chi
    ha collegato la sua cartella. Mai con un'altra. Il picker e la ricerca
    fuori dai progetti leggono il Drive di CHI GUARDA.
  - **«Scaduta» e «accesso perso» si DERIVANO** (B4): una cartella è scaduta
    se la casella di chi l'ha collegata non c'è più, è disattivata o non ha
    `drive.readonly`, **oppure se lui non ha più `drive.manage` nel progetto**
    (uscito, ruolo cambiato: review del server, punto 4, decisione «O»), e i
    suoi file sono `access_lost` (non si aprono, non si leggono); ricollegata
    la casella o rimesso il permesso, tornano senza riscrivere niente. La
    regola sta in UN posto, `folderLinkExpiredSql`
    (`packages/notifications/src/drive-folder-link.ts`): la usano le viste e
    le letture del server, il claim della sincronizzazione e la sorgente del
    contenuto nel worker. Chi ha collegato vede SEMPRE le sue cartelle
    (`GET /api/drive/google/links`, anche fuori dai progetti che vede) e le può
    scollegare; chi ha `drive.manage` nel progetto le ricollega o le
    scollega. Solo `deleted` (sparito da Google) si scrive, alla
    sincronizzazione.
  - **Scollegare Google non le perde** (review del server, punto 5, 0168):
    scollegare cancella la riga della casella e la FK mette a NULL gli id, ma
    l'indirizzo resta (`account_email`/`google_account_email`, scritti da un
    trigger); quando la STESSA persona ricollega lo STESSO indirizzo,
    `reattachDriveReferences` riaggancia le sue cartelle (`linked_by`) e i
    suoi riferimenti (`added_by`) alla riga nuova e chiede la
    sincronizzazione.
  - **La sincronizzazione** (B5, QB1 = b, decisione del maintainer): al
    collegamento, a «Sincronizza ora» e UNA VOLTA AL GIORNO da sola, nel
    worker (`apps/worker/src/drive/folder-sync.ts`), con la casella di chi ha
    collegato; un LEASE per cartella (`lease_until`, `SKIP LOCKED`) perché
    due giri non si sovrappongano; le cartelle scadute restano FUORI dal
    claim (la richiesta resta: cinque scadute non fermano più le altre,
    review punto 1), e una cartella in errore aspetta un'ora prima del
    tentativo dopo (il lease fa da backoff); scollegare prende la riga della
    cartella in esclusiva, e un riferimento della sincronizzazione o entra
    prima e se ne va con lei o non entra; un file spostato fra due cartelle
    collegate dello stesso progetto passa alla seconda; al più 5 cartelle per giro e 500 file per cartella, e
    una lista tagliata dal tetto non fa sparire niente. Sono letture: nessuna
    scrittura verso Google.
  - **Permessi** (il prototipo): aggiungere un file `drive.upload`, una volta
    per progetto (`already_in_project`; in un altro progetto è un riferimento
    nuovo, col suo codice); collegare, scollegare, sincronizzare, nascondere
    `drive.manage`; «Togli» chi l'ha aggiunto o `drive.manage`, e un file di
    cartella disponibile non si toglie, si nasconde (`use_hide`). Un nascosto
    sta fuori da elenco, ricerca, dettaglio e contenuto per chi non ha
    `drive.manage`. Il numero di un riferimento si prende sotto lo STESSO
    lock dei caricati (`insertDriveReference`, `packages/db`): i codici non si
    ripetono.
  - **«Save to Drive» resta una COPIA**: un riferimento Google è un'altra cosa.

