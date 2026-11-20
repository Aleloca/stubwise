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
