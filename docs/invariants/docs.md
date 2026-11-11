# Docs: codici delle pagine, citazioni, embedding, lettura di Claude (11 nov 2026)

Area 5, fetta 1 dell'integrazione del desktop (design
`docs/plans/2026-11-11-integrazione-area5-docs-design.md`, piano
`docs/plans/2026-11-11-integrazione-area5-fetta1-plan.md`). I Docs restano
«come oggi»: queste sono le regole che il desktop aggiunge. Il giro notturno ha
le sue in `nightly.md`.

## Il codice di una pagina è di (repository, slug), non della riga

- Una rigenerazione INSERISCE righe nuove con gli stessi slug e pota le
  generazioni vecchie. `doc_pages.id` non è quindi un riferimento stabile, e
  nessun riferimento duraturo deve puntarci. Il riferimento stabile è
  `doc_page_codes` (0142): un codice `<PRJ>-D<n>` per coppia (repository,
  slug), numerato per PROGETTO e mai riusato, nemmeno dopo l'eliminazione di
  una pagina manuale. Le due eccezioni sono quelle dei codici delle task:
  - **progetto eliminato**: i suoi codici vanno via in cascata, e un progetto
    nuovo con lo stesso codice ricomincia da D1;
  - **codice del progetto rinominato**: il prefisso si legge da
    `projects.code`, quindi tutti i codici cambiano prefisso insieme, e un
    `VECCHIO-D3` scritto in un messaggio non si risolve più (resta testo).
- Il numero lo dà `stubwise_ensure_doc_page_codes(repository, slugs)`, in UN
  posto, sotto un advisory lock per progetto. La chiama il trigger
  `doc_pages_code` per ogni pagina nuova (ogni scrittore è coperto, pagine
  manuali comprese), e la chiama PRIMA lo scrittore LUNGO, in una
  transazione breve e sua (`ensureDocPageCodes` di `@stubwise/db`, sempre col
  `Db` e mai con un `tx`): finalize della generazione completa e creazione
  notturna. Il lock dura fino alla fine della transazione che chiama: preso
  dal trigger dentro una finalize, resterebbe tenuto per tutti gli
  embedding, e una pagina manuale nuova dello stesso progetto aspetterebbe
  minuti. Con i codici già dati il trigger non lo prende.
  **Chi aggiunge uno scrittore di `doc_pages` con una transazione lunga
  chiama `ensureDocPageCodes` prima**, con gli slug che scriverà. Togliere
  il lock non basta: senza, una seconda transazione non vede il numero non
  committato della prima e si ferma sull'indice unico (progetto, numero) fino
  alla sua fine. Un codice dato a uno slug la cui transazione poi fallisce
  resta (non si riusa, e torna buono alla prossima pagina con quello slug).
- Le note di rilascio non hanno codice: nel prototipo non sono pagine. Per
  lo stesso motivo non stanno nel gruppo docs della ricerca globale quando
  chi chiede passa `citable=true` (`GET /api/search` del desktop, cioè ⌘K e
  il selettore «#»; il web vecchio non lo passa e le vede come prima), e il backfill delle
  citazioni della 0142 ha tolto quelle che puntavano a una nota.
- Una pagina che cambia slug riceve un codice nuovo; il vecchio resta, e si
  risolve con `available: false`.
- Una pagina manuale e una generata con lo stesso slug nello stesso
  repository condividono il codice, che si risolve come la rotta della pagina:
  prima la generata.
- `GET /api/docs/codes/:code` risolve un codice a repository e slug, con
  `docs.view` nel progetto del codice, senza distinzione di maiuscole come
  la ricerca. Un progetto invisibile e un codice che non c'è danno lo stesso
  404 (R-G5). **Il tempo di risposta no**: un codice che non c'è si ferma
  alla prima query, uno invisibile ne fa una seconda (i permessi). Accettato
  (review della fetta 1): la differenza è di una query su un indice, e dice
  al più che il NUMERO esiste in un progetto di cui si conosce già il
  codice, non cosa c'è dentro; i codici delle task si comportano allo stesso
  modo.

## Le citazioni `doc` della Chat puntano al CODICE

- `chat_message_citations` di tipo `doc` ha come `ref_id` l'id del codice, non
  della pagina. Il backfill della 0142 le ha portate al codice. Un client che
  manda ancora un id di pagina viene convertito al codice dal server.
- La vista porta `code` e `doc { repositoryId, repositorySlug, slug }` (la
  destinazione `#/p/<CODE>/docs/<repositorySlug>/<slug>`), e `label` è il
  titolo di ADESSO. Si vede con `docs.view` nel progetto della pagina, e solo
  se la pagina c'è ancora.
- Un codice D scritto a mano diventa una citazione per chi legge la pagina,
  come i codici delle task (`codesIn` riconosce `-D`); per gli altri resta
  testo. Una pagina scelta col «#» resta citata finché il testo ne nomina il
  titolo; se ne scrive il codice, la ritrova `citeablesFromCodes`.

## Le pagine manuali hanno i loro embedding

- Alla creazione e alla modifica le scrive il SERVER (`services/doc-embed.ts`),
  col chunking dei Docs (`DOC_CHUNK_*` di `@stubwise/docs-engine`, gli stessi
  numeri del worker), in `doc_chunks` con `generation_id` nullo. Alla modifica
  i chunk si rifanno; all'eliminazione vanno via in cascata.
- Fail-open: un embedder giù lascia la pagina salvata e trovabile per testo,
  e lo dice il log. I chunk del testo di PRIMA si tolgono comunque: lasciati
  lì, la ricerca per significato e la chat RAG troverebbero ciò che la
  pagina non dice più.
- Le manuali scritte prima della 0142 li ricevono da
  `backfillManualPageEmbeddings` (server, all'avvio e ogni ora): le manuali
  con un corpo e senza chunk, a lotti, idempotente, fermo al primo errore
  dell'embedder.
- Le note di rilascio restano senza embedding, come oggi.

## Claude legge una pagina intera, coi permessi di chi parla

- Il tool `read_doc_page` (repository e slug di un risultato di
  `search_docs`) chiama `GET /api/repositories/:repositoryId/docs/pages/:slug`
  col token del turno. La rotta è nell'allowlist (`chat-tool-routes.ts`), e
  vale `docs.view` nel progetto del repository, come per chi la apre.
  L'albero, l'export e la generazione restano FUORI dall'allowlist.
- Il corpo arriva fino a 30.000 caratteri (`CHAT_DOC_PAGE_BODY_MAX`, lo
  stesso tetto del `read_doc_page` dell'MCP); oltre, si tronca e il tool lo
  dice con la lunghezza totale. Gli altri tool restano a 12.000.

## Lo stato della generazione dice solo ciò che il server sa

- `reasonCode` deriva dai dati:
  - una pausa per il limite degli account o per la soglia di sfondo è
    `usage_limit`;
  - un job fermo dice il suo `held_reason`: `budget` diventa `monthly_budget`;
  - un job fallito con l'errore del fail-on-restart è `worker_restart`. Il
    testo è la costante `DOCS_WORKER_RESTART_ERROR` di
    `@stubwise/notifications`, scritta dal worker e confrontata dal server: non
    si ritocca da sola;
  - il resto è `other`. `provider_error` non si emette finché non c'è un
    segnale strutturato che lo distingua.
- `resumesAt` è il `limited_until` più vicino fra gli account che quel
  lavoro può usare, scelti come li sceglie il worker (`providers.md`): il pin
  della generazione o il provider del progetto con «solo questo» è l'unico;
  altrimenti il preferito più gli altri abilitati, con la chiave API solo
  se non c'è nessun abbonamento. Solo per `usage_limit`, e MAI per la pausa
  della soglia settimanale dello sfondo: quella riprende al reset settimanale
  o, dopo `DOCS_BACKGROUND_PAUSE_MAX_HOURS` (env del worker, che il server
  non sa), come lavoro interattivo, e il server non sa quale delle due viene
  prima. Niente stime.
- `progress` conta i nodi fatti su quelli totali della generazione in corso o
  in pausa; senza nodi è null.

## Limiti accettati

- La cronologia della ricerca globale (`search_history`, `type = 'doc'`) punta
  ancora a id di pagina, che una rigenerazione cambia: un clic vecchio può non
  trovare più la pagina. È lo stato di prima, nel registro.
