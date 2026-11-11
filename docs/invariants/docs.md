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
  una pagina manuale.
- Il codice lo dà il trigger `doc_pages_code` a ogni pagina nuova, in UN
  posto, per ogni scrittore: generazione completa, giro notturno, pagine
  manuali. Un advisory lock per progetto mette in fila due generazioni dello
  stesso progetto. Le note di rilascio non hanno codice: nel prototipo non
  sono pagine.
- Una pagina che cambia slug riceve un codice nuovo; il vecchio resta, e si
  risolve con `available: false`.
- Una pagina manuale e una generata con lo stesso slug nello stesso
  repository condividono il codice, che si risolve come la rotta della pagina:
  prima la generata.
- `GET /api/docs/codes/:code` risolve un codice a repository e slug, con
  `docs.view` nel progetto del codice. Un progetto invisibile e un codice che
  non c'è danno lo stesso 404 (R-G5).

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
  e lo dice il log.
- Le note di rilascio restano senza embedding, come oggi.

## Claude legge una pagina intera, coi permessi di chi parla

- Il tool `read_doc_page` (repository e slug di un risultato di
  `search_docs`) chiama `GET /api/repositories/:repositoryId/docs/pages/:slug`
  col token del turno. La rotta è nell'allowlist (`chat-tool-routes.ts`), e
  vale `docs.view` nel progetto del repository, come per chi la apre.
  L'albero, l'export e la generazione restano FUORI dall'allowlist.

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
- `resumesAt` è il `limited_until` più vicino degli account abilitati, solo per
  `usage_limit`. Niente stime.
- `progress` conta i nodi fatti su quelli totali della generazione in corso o
  in pausa; senza nodi è null.

## Limiti accettati

- La cronologia della ricerca globale (`search_history`, `type = 'doc'`) punta
  ancora a id di pagina, che una rigenerazione cambia: un clic vecchio può non
  trovare più la pagina. È lo stato di prima, nel registro.
