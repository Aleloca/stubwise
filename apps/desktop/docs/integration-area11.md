# Integrazione area 11 «La documentazione di prodotto» — parità col prototipo

Cosa dell'area 11 del prototipo (`data/productDocs/*`, `domain/productDocs/*`,
`data/model.ts` «Doc di prodotto») arriva sul server vero, fetta per fetta.
Design: `docs/plans/2026-11-20-integrazione-area11-design.md`; i piani
`docs/plans/2026-11-20-integrazione-area11-f<N>-plan.md`.

## F1 — lo spazio e l'editor (server; il renderer è di 94)

| Voce del prototipo | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| Il documento a blocchi, le operazioni, le ancore, il testo (`domain/productDocs/blocks.ts`, `richText.ts`) | `packages/shared/src/product-docs/{blocks,rich-text}.ts`, `schemas/product-docs.ts` | — | `blocks.test.ts`, `rich-text.test.ts` (shared) |
| I segni validi, link solo http(s) (`validMark`, `safeLinkHref`) | `product-docs/validate.ts`, `safe-url.ts` (`isSafeWebUrl`) | — | `validate.test.ts` |
| L'albero e lo spostamento senza cicli (`tree.ts`) | `product-docs/tree.ts` | — | `tree.test.ts` |
| L'unione delle revisioni della stessa sessione (`mergeChanges`) | `product-docs/revisions.ts` | — | `product-docs-ops.test.ts` |
| La serie `-D` condivisa coi Docs, mai riusata | `packages/db/drizzle/0202_product_docs.sql` (trigger `product_pages_code`) | — | `migration-0202.test.ts` |
| Lo spazio, la pagina per codice (403 senza `docs.view`, anche se non c'è) | `apps/server/src/services/product-docs.ts` | `GET /api/projects/:projectId/product`, `GET /api/product-pages/by-code/:code` | `product-docs.test.ts` |
| Crea, rinomina, sposta, elimina (revisioni `create`, `rename`, `move`) | idem | `POST …/product/pages`, `PATCH`/`DELETE /api/product-pages/:id` | idem |
| La scrittura a operazioni, un id mai riusato salvo ⌘Z, `stale` | `services/product-docs-ops.ts` | `POST /api/product-pages/:id/ops` | `product-docs-ops.test.ts` |
| La cronologia, Segui | idem | `GET …/revisions`, `PUT`/`DELETE …/follow` | idem |
| Le immagini (D-3 = a) | idem, `chat/attachments.ts` (`storageKeysOfProject`) | `POST`/`GET …/images` | idem |
| L'api-client del renderer | `packages/api-client/src/endpoints/product-docs.ts` | `client.productDocs.*` | `reader.test.ts` |

| Scelta o limite | Chi ha deciso |
|---|---|
| Lo spazio dà le pagine in fila: l'albero lo costruisce il client (`buildProductTree`), perché `readerSchema` non attraversa uno schema ricorsivo | costruttore |
| I blocchi in lettura sono record, validati dal client con `productBlockSchema` (il noto o il ripiego per un tipo futuro) | costruttore |
| L'immagine di un blocco è `product-image:<id>`, mai un data URL | costruttore (ruling del piano) |
| Gli id dei blocchi li genera il client (`blk-<uuid>`); il server ricorda quelli dati e chi li ha tolti (⌘Z) | costruttore |
| Il padre di una pagina è NO ACTION (un progetto eliminato porta via le pagine annidate) | costruttore |
| L'«Undo» dalla cronologia arriva con F5 (nel prototipo è delle modifiche di Claude) | costruttore (ruling del piano) |
| Il modulo Docs spento non chiude le rotte (come i Docs): nel registro dei rimandi | 46 |

## F2 — commenti, menzioni e le notifiche nel catalogo (server; il renderer è di 94)

| Voce del prototipo | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| Le tre righe della doc di prodotto nel catalogo degli avvisi (`alertTypes.ts`, riallineate a N-1 = a) | `packages/shared/src/alerts/catalog.ts` (`mentioned`, `follower`, `seePerm`) | — | `catalog.test.ts`, `alert-recipients.test.ts`, `alert-subscriptions.test.ts` |
| I tre `notification_kind` | `packages/db/drizzle/0203_product_doc_notifications.sql`, `notifications/src/format.ts` | — | `migration-0203.test.ts`, `format.test.ts` |
| La frase citata (`cleanQuote`) | `packages/shared/src/product-docs/comments.ts` | — | `comments.test.ts` (shared) |
| I fili, le risposte, «Frase eliminata» derivata, il `merge` che sposta i fili (`comments.ts`, `onAnchorsMerged`) | `packages/db/drizzle/0204_product_comments.sql`, `apps/server/src/services/product-comments.ts` | `GET`/`POST /api/product-pages/:id/comments` | `product-comments.test.ts` |
| «Resolve» / «Reopen» | idem | `POST /api/product-comments/:id/resolve`, `…/reopen` | idem |
| Chi si può menzionare (`productMentionCandidates`) | idem | `GET /api/projects/:projectId/product/mention-candidates` | idem |
| La notifica della menzione (`publishMentions`) e la card a lettura (`presentProductMention`) | `services/product-comments.ts` (`publishMention`, `productDocCardsFor`), `services/inbox.ts` (`productDoc`) | `GET /api/inbox` | `inbox-product-mention.test.ts` |
| L'api-client del renderer | `packages/api-client/src/endpoints/product-docs.ts` | `client.productDocs.{comments,addComment,resolveComment,reopenComment,mentionCandidates}` | `reader.test.ts` |

| Scelta o limite | Chi ha deciso |
|---|---|
| La menzione è solo obbligatoria (nessun interruttore); aggiornamento e domanda hanno la riga del progetto, chi segue la pagina li riceve sempre (N-1 = a) | maintainer |
| `seePerm`: chi non legge i Docs del progetto non riceve la card, nemmeno da obbligatorio | costruttore, approvato da 46 |
| La frase citata è UNA riga (gli a capo diventano uno spazio); il tetto di 200 lo tiene `cleanQuote`, non una CHECK | costruttore |
| Le menzioni le trova il server nel testo (`@Nome`, i nomi più lunghi prima, come la Chat) | costruttore |
| Nessuna rotta di eliminazione dei commenti (il prototipo non elimina): la colonna e la CHECK sono una predisposizione | 46 |
| Una card sparita o di una pagina che chi guarda non legge più ha una frase neutra; senza l'autore visibile, «Ti hanno menzionato…» | costruttore, approvato da 46 |

## F3 — ricerca, citazioni, esportazione (server; il renderer è di 94)

| Voce del prototipo | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| La ricerca nelle pagine (`searchProductPages`, `passageIn`, `fold`) | `packages/shared/src/product-docs/search.ts`, `apps/server/src/services/product-search.ts` | `GET /api/projects/:projectId/product/search`, il gruppo `product` di `GET /api/search` | `search.test.ts` (shared), `product-search.test.ts` |
| Gli embedding delle pagine (il poller del server) | `services/product-embed.ts`, `packages/db/drizzle/0206_*`, `0207_*` | `PRODUCT_EMBED_POLL_SECONDS` | `product-embed.test.ts` |
| Una pagina di prodotto citata nella Chat | `apps/server/src/chat/citations.ts` (`product: { pageId }`) | le rotte della Chat | `product-citations.test.ts` |
| Le pagine di prodotto nella chat dei Docs del progetto (contenuto non fidato) | `services/product-retrieval.ts`, `routes/docs-rag.ts` (`appendProductContext`), `0208_*` | `POST /api/projects/:projectId/docs/chat`, `productSources` (anche nello storico) | idem |
| L'esportazione (`getProductExport`) | `services/product-export.ts` | `GET /api/product-pages/:id/export`, `GET /api/projects/:projectId/product/export` | `product-export.test.ts` |
| L'api-client del renderer | `packages/api-client/src/endpoints/product-docs.ts` | `client.productDocs.{search,exportPage,exportSpace}` | `reader.test.ts` |

| Scelta o limite | Chi ha deciso |
|---|---|
| I chunk in una tabella a parte (`doc_chunks` è legata ai repository); gli embedding dal server, non a ogni salvataggio ma da un poller, sulle pagine ferme da 30 s | costruttore (ruling del piano) |
| Il testo cercabile si piega in TypeScript (`search_text`), non nel database: la piegatura del database dipende dalla codifica | costruttore, approvato da 46 |
| La ricerca globale è solo per testo (la corsia veloce, come il gruppo Docs); quella dello spazio è ibrida | costruttore, approvato da 46 |
| Una pagina di prodotto è una citazione `doc` col codice `-D` e `product: { pageId }`, nessun `kind` nuovo | costruttore (ruling del piano) |
| Le fonti di prodotto della chat dei Docs stanno in `productSources`, non in `sources` (che vuole un repository); si salvano solo gli id e si rileggono con la visibilità di adesso | costruttore e 46 |
| L'esportazione non porta URL firmati: le immagini dalla rotta coi byte | costruttore, approvato da 46 |
| I nomi dei file del Drive nell'esportazione (`files`), null per chi non vede il file | 94 |
