# Integrazione area 5, fetta 2 — il Drive dei file caricati — piano (11 nov 2026)

> Autore: stubwise-72 (server); renderer a stubwise-94. Branch
> `feat/area5-drive-server`, da `feat/integrazione-area5`.
> Design e decisioni: `docs/plans/2026-11-11-integrazione-area5-docs-design.md`.
> - D1 = a: niente Google in questa fetta (i riferimenti con l'area 6).
> - D3 = a: i permessi come il prototipo, con la regola dei preset.
> - D4 = a: 100 MB per file, i tipi della Chat.
>
> **Specifica**: il prototipo.
> - `apps/desktop/src/renderer/data/drive/{reads,writes,visibility,work}.ts`;
> - `data/model.ts` (`DriveFile`, `DriveOpen`, `DriveFilters`, `DriveFileRow`, `DriveFileDetail`, `DriveFilePermissions`);
> - `pages/drive/*`, `pages/chat/SaveToDrive.tsx`, `pages/drive/ShareToChat.tsx`;
> - `apps/desktop/docs/area5-parity.md`;
> - lo shape `apps/desktop/.impeccable/shape/drive.md`.

## Perimetro

1. **Il Drive di ogni progetto**, sempre presente e non un modulo, e la destinazione globale `#/drive`.
   - Un elenco di file CARICATI. La sorgente `google` nasce con l'area 6.
   - Il codice `<PRJ>-F<n>`, per progetto, mai riusato.
   - Filtri: tipo (document, sheet, slides, pdf, image, other, dedotto dal MIME), chi l'ha aggiunto, e il nome nella ricerca.
   - Ordinamento: «Più usati» (default, aperture in 90 giorni), «Recenti», «Nome».
   - Una riga dice: nome, tipo, chi l'ha aggiunto, quando, aperture in 90 giorni. La riga del riassunto arriva con la F3.
   - Dettaglio: aperture totali, e la storia delle aperture solo con `drive.history`.
2. **Chi vede**: i MEMBRI del progetto, Viewer compreso; i full admin sono membri impliciti. Un file di un progetto che non si vede è 404, come uno che non esiste (R-G5), anche nelle letture trasversali: «#», citazioni, codici.
3. **Le scritture**:
   - caricare: `drive.upload`, al più 100 MB, i tipi della Chat (`chatAttachmentAllowed`, tipo ed estensione). Un nome già usato fra i file vivi del progetto prende « (2)», « (3)»…;
   - eliminare: il proprio file, o un file qualunque con `drive.manage`.
   «Nascondi» e «Riprova» non ci sono: sono dei file delle cartelle Google e del contenuto (F3, area 6).
4. **Le aperture**: anteprima, download, e più avanti l'apertura in Google. Contano per chi apre. La stessa persona sullo stesso file entro 30 minuti conta una volta. Non contano un risultato di ricerca, la miniatura del dettaglio, né Claude che legge.
   - Anteprima `inline` solo per i tipi sicuri: PDF, immagini raster, testo. Tutto il resto, e il download, sempre `attachment`.
5. **«Save to Drive» dalla Chat**:
   - in un canale di progetto, nel suo progetto; in un DM o in un generale, nel progetto scelto;
   - con `drive.upload` in quel progetto, e solo per chi legge il messaggio;
   - è una COPIA dell'oggetto nello storage, con una chiave del Drive: mai un riferimento all'oggetto della Chat, che la Chat pota o elimina.
6. **Citazioni `drive`** nella Chat:
   - un `kind` nuovo, col CHECK della tabella;
   - il «#» elenca i file per nome e codice, mai per contenuto;
   - un codice F scritto a mano diventa una citazione per chi vede il file;
   - la vista ha codice, nome, progetto, tipo, aperture in 90 giorni, e `route`. R-H5: un file non più visibile si legge come un codice tenue.
   «Cite in Chat» lo fa il renderer, col codice nel testo.
7. **Fuori**:
   - Google (area 6);
   - contenuto, OCR, riassunto e ricerca per contenuto (F3);
   - i tool di Claude sul Drive (F3, quando c'è il testo da leggere);
   - versioni, modifica dei file, cartelle in Stubwise, condivisione esterna.

## Il modello (tecnico, mie scelte)

- **Migrazione 0143** (il primo numero libero; lo ricontrollo prima di scriverla).
  - La tabella `drive_files`:
    - colonne: `id`, `project_id`, `number`, `source` (CHECK `upload`; `google` arriva con l'area 6), `name`, `mime`, `type`, `size_bytes`, `storage_key` (unico), `added_by`, `added_at`, `deleted_at`, `deleted_by`, `storage_purged`;
    - gli unici: `(project_id, number)`, e il nome fra i vivi `(project_id, lower(name))` dove `deleted_at is null`.
  - Eliminare lascia una LAPIDE (`deleted_at`): il numero non si riusa, e la riga sparisce da ogni lettura. L'oggetto si toglie dopo il commit, e `storage_purged` dice se è andata.
  - `drive_opens (file_id, person_id, at, via)`, con indice `(file_id, at)`. La deduplica dei 30 minuti si fa in SQL alla scrittura.
  - I permessi: `drive.upload`, `drive.manage` e `drive.history` nel registro shared.
    - Project Lead li ha tutti e tre.
    - Developer, Contributor e Legacy Member hanno `drive.upload`.
    - Viewer nessuno.
    - Si danno anche ai ruoli di progetto che contenevano il preset (lo schema della 0135: prima i ruoli, poi il preset).
  - Il CHECK di `chat_message_citations` accoglie `drive`.
- **Lo storage**: due metodi nuovi in `ObjectStorage`.
  - `putObjectStream(key, stream, contentType)`, col caricamento multipart di `@aws-sdk/lib-storage` (dipendenza nuova, pacchetto AWS ufficiale, stessa linea di versione di `client-s3`): 100 MB non si bufferizzano.
  - `copyObject(fromKey, toKey)` (`CopyObjectCommand`), per «Save to Drive».
  - `getSignedDownloadUrl` prende un'opzione `inline` per l'anteprima dei tipi sicuri.
- **Il caricamento**: multipart in STREAMING, nell'ordine:
  1. accesso e tipo PRIMA di leggere il file;
  2. il flusso va diretto allo storage, contando i byte;
  3. oltre 100 MB lo stream si tronca, il caricamento si annulla e l'oggetto si toglie (413);
  4. la riga si scrive dopo l'oggetto, e un errore toglie l'oggetto.
  Un rate limit per persona, come la Chat.
- **Le rotte**:
  - `GET /api/projects/:projectId/drive/files`, coi filtri;
  - `GET /api/drive/files`, globale, sui progetti di cui si è membri, con `projectId` opzionale;
  - `GET /api/drive/files/:id`, il dettaglio;
  - `POST /api/projects/:projectId/drive/files`;
  - `DELETE /api/drive/files/:id`;
  - `GET /api/drive/files/:id/download` e `GET …/preview`, 302 all'URL firmato, e l'apertura si conta;
  - `GET /api/drive/codes/:code`;
  - `POST /api/chat/attachments/:id/save-to-drive {projectId?}`.
  Le letture d'elenco contano le aperture in UNA query (niente N+1).
- **La pulizia**: il timer orario del server, quello della Chat, ritenta gli oggetti delle lapidi con `storage_purged = false`. Con lo storage spento non tocca niente.

## Task

- **F2.1 — DB, permessi, schemi**: la 0143, `schema.ts`, il registro dei permessi, gli schemi shared. Test: la migrazione (lapide e numero, unico del nome fra i vivi, CHECK); i preset e un ruolo che conteneva il preset.
- **F2.2 — Storage in streaming e copia**: `putObjectStream`, `copyObject`, `inline`. Test sul client S3 finto, come `s3.test.ts`.
- **F2.3 — Rotte del Drive**: caricamento, elenco, dettaglio, eliminazione, apertura, codici. Test:
  - un non membro riceve 404; un Viewer vede ma non carica;
  - 100 MB + 1 dà 413, senza oggetti rimasti;
  - un tipo eseguibile si rifiuta;
  - il nome « (2)»;
  - la deduplica delle aperture; la storia solo con `drive.history`;
  - eliminare: il proprio sì, uno altrui solo con `drive.manage`; una lapide sparisce da tutto e il numero non si riusa;
  - l'elenco globale.
- **F2.4 — «Save to Drive» e citazioni**: la copia, e le citazioni `drive` (il «#», i codici scritti a mano, R-H5). Test:
  - una copia con chiave sua;
  - eliminare il messaggio della Chat lascia il file del Drive, eliminare il file lascia il messaggio;
  - senza `drive.upload` dà 403; da un DM serve `projectId`;
  - chi non vede il file non vede la citazione.
- **F2.5 — Chiusura**:
  - deploy-log: la 0143, i permessi nuovi, la dipendenza nuova, il rollback. Un server vecchio non conosce i permessi nuovi, ed è innocuo; non conosce il `kind` `drive`, quindi le citazioni `drive` spariscono;
  - un invariante nuovo `docs/invariants/drive.md`;
  - registro, parità server, righe di CLAUDE.md per l'orchestratrice.

## Da coordinare con stubwise-94

- **Il tetto del proxy del desktop**: `apiProxy.ts` ha `MAX_BODY` a 15 MB e `MAX_CHAT_UPLOAD_BODY` a 26 MB per la rotta della Chat. Per `POST /api/projects/:projectId/drive/files` serve un tetto suo, almeno 101 MB: 100 MB più il multipart.
  - Il body passa dal renderer al main via IPC. Con 100 MB conviene che il main legga il file dal disco, con un percorso scelto dal dialogo, e lo mandi in streaming, invece di ricevere il buffer dal renderer. La scelta è di 94.
- **Le forme** delle rotte e degli schemi: le mando quando la F2.1 è pushata.

## Global Constraints

- Chi vede il Drive lo decide l'appartenenza al progetto, calcolata dal server in UN posto (una funzione del Drive sopra `visibleProjectIds`), e i permessi li legge il client dal server (`permissions` sulla riga).
- Il binario non passa mai dall'API: streaming verso lo storage e URL firmati. L'anteprima `inline` vale solo per i tipi sicuri, il resto è `attachment`.
- Un file invisibile o eliminato è come uno che non esiste, ovunque (R-G5).
- Il registro decisioni non si scrive.
- Verso i client solo cambi additivi; un `kind` nuovo dietro `readerSchema`.
- Test filtrati, mutazioni sui test passati al primo colpo, Docker coordinato con stubwise-94.

## Review Focus

- **La visibilità per membri** in ogni lettura, comprese quelle trasversali (citazioni, codici, l'elenco globale, «Save to Drive» che sceglie il progetto). Il negativo va sempre scritto: un non membro con il codice giusto.
- **Lo streaming**: un caricamento di 100 MB non deve mai stare tutto in memoria. Va misurato con un test di un file grande (la memoria residente non cresce del file intero), e lo stream troncato deve annullare il multipart e togliere l'oggetto.
- **Il tetto del proxy del desktop** per quella sola rotta, con 94.
- **La pulizia con lo storage spento**: la lapide si scrive comunque e il file sparisce subito per tutti. L'oggetto lo ritenta il timer, mai la cancellazione della riga.
- **«Save to Drive» è una copia**: il file del Drive ha la SUA chiave, e la potatura dei sospesi o l'eliminazione del messaggio non lo toccano mai. Il test elimina il messaggio e poi scarica dal Drive.
