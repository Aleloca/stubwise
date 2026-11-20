# Integrazione area 11, F3 — ricerca, citazioni, esportazione: piano

> Design: `docs/plans/2026-11-20-integrazione-area11-design.md`, «F3» (D-4 =
> a). Specifica: il prototipo (`data/productDocs/search.ts`, `export.ts` e
> `reads.ts` `getProductExport`; `palette/CommandPalette.tsx` con «In
> Product»; `data/docs/chat.ts`). Invarianti: `permissions.md` (elenchi
> filtrati nella WHERE), «Contenuto NON fidato» delle chat
> (`CHAT_TOOL_UNTRUSTED_ROUTES`), CLAUDE.md («Verso l'app mobile, solo cambi
> ADDITIVI»).
> Branch: `feat/area11-f3` da `feat/area11-f2`.

## Prima del codice

- **Nessuna [DECIDE].** Ciò che si vede è il prototipo: «In Product» in ⌘K,
  le pagine citate nella chat dei Docs, «Esporta» in PDF e Word.
- **Due fatti correggono il design** (lo dico qui, il design resta com'è e 46
  decide se aggiornarlo):
  - `doc_chunks` è legata ai Docs dei repository: `page_id → doc_pages` e
    `repository_id → repositories` sono `NOT NULL`, e il retrieval filtra
    sempre per repository e generazione corrente (`retrieveChunks…` in
    `packages/db/src/docs-retrieval.ts`). Il ruling del design («i chunk
    nella tabella dei Docs») toccherebbe ogni lettura dei Docs;
  - gli embedding delle pagine MANUALI dei Docs li fa già il server, al
    salvataggio (`embedManualPage`, `services/doc-embed.ts`), con lo stesso
    chunking di `@stubwise/docs-engine`: non è vero che solo il worker chiama
    ollama per i Docs.
- **Ruling (dove stanno i chunk)**: una tabella a parte,
  `product_page_chunks (id, page_id → product_pages cascade, project_id,
  content, embedding vector(1024), heading, token_count)`, con lo stesso
  chunking e lo stesso embedder. Il retrieval impara una seconda sorgente
  (`retrieveProductChunksForProject`) e la ricerca le unisce. Se sbagliato
  costa una migrazione di spostamento.
- **Ruling (quando si fanno gli embedding)**: dal server, come le pagine
  manuali, ma NON a ogni salvataggio (l'editor salva ogni 800 ms): un poller
  del server ogni 30 s rifà le pagine con `embedded_at < updated_at` e
  ferme da almeno 30 s, al più 20 per giro. Fail-open come `embedManualPage`:
  un embedder giù lascia la ricerca per testo. Se sbagliato costa un poller.
- **Ruling (la citazione)**: una pagina di prodotto è una citazione `doc`
  come le pagine dei Docs (l'id è la riga di `doc_page_codes`, D-9), con
  `doc: null` e un campo nuovo `product: { pageId } | null`
  (`.nullable().default(null)`). Un client vecchio legge la citazione col suo
  titolo e codice, senza destinazione. Nessun `kind` nuovo.
- **Fatti del codice che contano**:
  - `chatCitationSchema` ha già `doc` nullable e `code`;
  - la chat dei Docs del progetto legge con `retrieveChunksForProject`;
  - la ricerca globale ha le sue righe per tipologia (deploy-log, «Righe di
    ricerca per tipologia»): «In Product» è un ambito in più;
  - il testo di una pagina di prodotto lo scrive chiunque abbia `docs.edit`:
    nelle chat è contenuto NON fidato, come le pagine manuali dei Docs.

## Regole di lavoro (le solite)

Come F1. Nel giro anche `docs-retrieval.test.ts`, i test della chat dei Docs e
delle citazioni (`chat/citations` e `chat-claude`), `load-isolated.test.ts`.

## Task 1 — i chunk e il poller (db, server)

**File**: la migrazione (la tabella, l'indice HNSW come `doc_chunks`, e
`product_pages.embedded_at`), `services/product-embed.ts`, il poller nel boot
del server (spegnibile con un'env vuota, come `GRAPHIFY_MCP_URL`).

- Il testo da spezzare si ricava dai blocchi (`productBlocksToText` in shared:
  titoli, paragrafi, elenchi, celle; niente segni né `href`).

**Test**: una pagina ferma da 30 s riceve i chunk, una in scrittura no; i
chunk di prima si rifanno; un embedder giù lascia la pagina senza chunk e il
log; l'eliminazione della pagina toglie i chunk.

Mutazione: rifare anche le pagine in scrittura (il test della pagina «fresca»
deve cadere).

## Task 2 — la ricerca «In Product» (server)

- `GET /api/projects/:projectId/product/search?q=` e l'ambito nella ricerca
  globale: ibrida (vettore più testo), filtrata nella WHERE sui progetti in
  cui chi chiede ha `docs.view`, una riga per pagina con la frase che ha
  corrisposto (testo semplice, una riga, mai segni né indirizzi:
  `ProductSearchHit` del prototipo).

**Test**: chi non ha `docs.view` non trova niente (e il conteggio non lo
tradisce); un progetto archiviato fuori; la frase senza `href`; la ricerca
per testo con l'embedder giù.

Mutazione: il filtro di progetto dopo il limite invece che nella WHERE.

## Task 3 — le citazioni e la chat dei Docs (shared, server)

- `chatCitationSchema.product` (additivo, test di parse senza);
  `chat/citations.ts` risolve un codice `-D` di una pagina di prodotto con la
  visibilità di chi guarda (`docs.view`), come quelle dei Docs.
- La chat dei Docs del progetto unisce i chunk di prodotto al retrieval, e li
  passa al modello come contenuto non fidato (la nota che hanno già le pagine
  manuali).
- Il ponte di Claude (la chat dell'area 10): `read_doc_page` resta dei Docs;
  le pagine di prodotto per il modello arrivano con F6 (`read_product_page`).

**Test**: una citazione di una pagina di prodotto a chi non legge i Docs del
progetto non c'è; la chat dei Docs cita una pagina di prodotto col suo codice;
la nota del contenuto non fidato.

## Task 4 — l'esportazione (server)

- `GET /api/product-pages/:id/export` e `GET /api/projects/:projectId/product/export`
  (lo spazio intero, in ordine d'albero): i blocchi SENZA commenti, le
  decisioni come le vede chi esporta, le immagini con un URL firmato breve
  (10 minuti), i wireframe come immagine (da F6; prima nessuno). Il file lo
  compone il client (D-4 = a).
- Tetto: 200 pagine per l'esportazione dello spazio (oltre, 413 con il
  numero).

**Test**: niente commenti nell'esportazione; un'immagine con l'URL firmato
che scade; una decisione invisibile resta fuori; il tetto.

## Task 5 — api-client e documenti

- `api-client`: ricerca, esportazione, il campo della citazione.
- `deploy-log.md`: una migrazione (una tabella, una colonna), un poller del
  server con la sua env. ORDINE: server, poi caddy. Rollback: sicuro (un
  server vecchio ignora tabella e colonna; un client vecchio legge la
  citazione senza destinazione).

## Per 94 (renderer)

- «In Product» in ⌘K si accende; la citazione apre la pagina da
  `product.pageId`.
- L'esportazione: `printToPDF` nel desktop, la stampa del browser sul web,
  `docx` nel renderer, sulla lettura di questa fetta.

## Review Focus

- La ricerca filtra nella WHERE, prima di limite e conteggio.
- Il testo di una pagina è non fidato in ogni chat.
- L'esportazione non porta mai i commenti.
- Il poller non rifà una pagina mentre qualcuno la scrive.
