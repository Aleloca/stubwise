# Richieste: numeri di catalogo e fusione

## I codici R<n> sono un contatore per progetto, dato dal trigger, mai riusato (10 nov 2026)

Design: `docs/plans/2026-11-09-integrazione-area2-fetta4-design.md`
(«Codici R<n>»). Migrazione: `packages/db/drizzle/0121_request_numbers.sql`.
Test: `packages/db/src/migration-0121.test.ts`.

- **Il codice di una richiesta è `<CODICE DEL PROGETTO>-R<n>`**, con `n` =
  `backlog_items.number`, unico per progetto (`UNIQUE (project_id, number)`).
- **Il numero lo dà SOLO il trigger** `backlog_items_assign_number` (BEFORE
  INSERT, e BEFORE UPDATE OF `project_id`): prende `projects.next_request_number`
  sotto il lock della riga del progetto e lo incrementa. Vale per OGNI
  scrittore — server, intake e stima del worker, import — senza che nessuno
  lo debba ricordare: chi inserisce una voce non manda il numero.
- **Un `number` passato all'insert è IGNORATO**: il trigger dà sempre il
  numero dopo. Rispettarlo lascerebbe il contatore indietro, e l'insert
  successivo fallirebbe sul vincolo unico.
- **Mai riusato**: il contatore non scende, quindi un numero eliminato non
  torna. Una voce che cambia progetto prende il numero dopo nel progetto
  nuovo (il vecchio resta un buco).
- **Le voci di prima della 0121** sono numerate per `created_at` e `id`, fuse
  e archiviate comprese: sono gli stessi numeri che la fetta 3 ricavava a
  lettura, così i codici già mostrati non sono cambiati. Non va «rinumerato»
  niente: un codice citato da qualche parte deve restare vero.

## La fusione sta in UN posto: `services/backlog-merge.ts` (10 nov 2026)

- **«Fondi in…» (app) e la fusione del web vecchio passano dallo stesso
  servizio**: `mergedDocumentOf` chiede al modello il documento fuso, FUORI
  da ogni transazione; `applyBacklogMerge` applica tutto il resto in UNA
  transazione (link alle task, richiedenti — l'unione: una voce fusa ricorda
  tutti —, conteggio, documento, l'assorbita archiviata con
  `merged_into_id`, la sua sessione di refinement chiusa).
- **Se il modello non risponde, o risponde vuoto, non si scrive niente**:
  502 `merge_failed` (decisione del maintainer: l'app mostra l'errore con
  «Riprova» e nessuna delle due voci è cambiata).
- **Le scritture della voce restano in `backlog-item-writes.ts`** (vedi
  `docs/invariants/backlog-refine.md`): anche descrizione, accettazione e
  scarto delle proposte dell'intake (fetta 4) passano da lì, con la voce in
  lock. Chi aggiunge una scrittura della voce la aggiunge lì.
- **La creazione dall'app resta l'intake** (decisione del maintainer): la
  richiesta può essere fusa da sola in una esistente, e l'esito («nuova» o
  «fusa in R<n>») lo dice `GET /api/requests/jobs/:jobId`. «Fusa» vuol dire
  che la voce prodotta dal job esisteva già prima del job.

## Archiviare, ripristinare, riaprire (10 nov 2026, review della fetta 4)

Migrazione: `packages/db/drizzle/0122_backlog_archived_from.sql`. Test:
`apps/server/src/routes/project-requests.test.ts`.

- **Lo stato di ripristino lo decide il SERVER.** Il trigger
  `backlog_items_archived_from` scrive in `archived_from` lo stato che la voce
  aveva quando è stata archiviata, da QUALUNQUE percorso (app nuova, web
  vecchio, worker), e lo azzera quando esce dall'archivio. `POST
  /api/requests/:id/restore` la riporta lì; il `status` del body resta
  accettato per i client di prima, ma non conta. Un'archiviata di prima della
  0122 (stato precedente ignoto) torna «nuova».
- **Una fusa non si ripristina: si riapre** (`/reopen`, torna «nuova» e non
  è più fusa in niente). ⚠️ **Riaprire una fusa NON annulla gli effetti della
  fusione**: la destinazione tiene il documento fuso dal modello, i
  richiedenti dell'assorbita, i link alle task e il conteggio. La riaperta
  riparte col SUO documento, i suoi richiedenti e senza le task che erano
  passate alla destinazione. Non c'è un «disfa la fusione», ed è accettato:
  ricostruire la destinazione di prima vorrebbe dire conservarne la copia.
