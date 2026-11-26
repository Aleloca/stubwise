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

## F4 — la scrittura dal vivo (server; il renderer è di 94)

| Voce del prototipo | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| Le sezioni (`sectionOf`, `sectionRange`, `inSectionOf`) | `packages/shared/src/product-docs/sections.ts` (più `sectionKeyOf`, `top`) | — | `sections.test.ts` |
| Le forme dello stream, il parser, l'allowlist | `packages/shared/src/schemas/product-docs.ts`, `product-docs/live.ts` | `parseProductLiveFrame`, `isAllowedProductLiveStreamPath` | `live.test.ts` |
| La sezione presa (chi scrive qui) | `packages/db/src/product-holds.ts` (`takeSection`), `0209_*` | — | `product-holds.test.ts` |
| Le operazioni rispettano la presa | `apps/server/src/services/product-docs-ops.ts` | 409 `section_busy` di `POST /api/product-pages/:id/ops` | `product-section-busy.test.ts` |
| La presenza, i cursori, i blocchi degli altri senza ricaricare (al posto del copione) | `services/product-live.ts`, `product-live-notify.ts` | `GET /api/product-pages/:id/live`, `POST …/live/presence` | `product-live.test.ts` |
| L'api-client del renderer | `packages/api-client/src/endpoints/product-docs.ts` | `client.productDocs.beat` | `reader.test.ts` |

| Scelta o limite | Chi ha deciso |
|---|---|
| La sezione presa sta in tabella (la vede il worker, F5); presenza e cursori in memoria | costruttore (ruling del piano) |
| La sezione di una presa è `sectionOf` (il titolo più vicino sopra), come il prototipo | costruttore |
| Le revisioni di un altro processo arrivano senza operazioni: il client rilegge la pagina | costruttore, d'accordo con 94 |
| Un solo processo server: più processi dietro caddy romperebbero la presenza in memoria | piano, nella voce del deploy-log |

## F5 — Claude sulla doc: le scelte del renderer (94)

| Scelta o limite | Chi ha deciso |
|---|---|
| «Open a request» nella build app: la scheda B sta nel filo, sotto la domanda (titolo e descrizione da `question.request`, «Create request» / «Cancel»), non nel riquadro. La conferma è `requests.create` con `origin.product_doc`, e il server chiude la domanda; annullata, la domanda resta aperta. «Una richiesta è in preparazione…» = la scheda aperta nel filo. Da Home «Decide» «Open a request» porta al filo con la scheda aperta (`?comment=<domanda>&requestCard=1`), mai un messaggio al Claude del server. L'esito è la risposta della POST (`createRequestFromQuestion`), non l'intake. Il prototipo resta col riquadro (motore di intenti, `productQuestionRequestDraft`) | maintainer, via 46 |
| I gesti di Claude di F6 (prima versione, dalla doc al backlog, richieste nate dalla pagina, bozze di schermata) stanno su `product-claude-actions`, acceso il 22 nov 2026 dopo lo «Stop» della prima versione | 46 |

## Il renderer della build app (94)

Ogni fetta si accende con la sua funzione (`PRODUCT_LATER` in
`data/queries/productDocs.ts`, l'elenco in `data/integration.ts`); la
pagina e i componenti sono quelli del prototipo, cambia solo il livello
dati (`data/backend/real/product*.ts`).

| Fetta | Funzione | Adattatore | Test dell'adattatore | Stato |
|---|---|---|---|---|
| F1 — lo spazio, l'editor, la cronologia, Segui, le immagini | `product-space` | `productDocs.ts` (`baseSeq` e un tentativo dopo `stale`, i blocchi letti uno per uno con `productBlockSchema`) | `productDocs.test.ts` | accesa |
| F2 — fili, segni, «Comment», «@», le card della doc | `product-comments` | `productDocs.ts`, `notifications.ts` (`product_doc.*`) | `productDocs.test.ts`, `productDocNotifications.test.ts` | accesa |
| F3 — «Search ⌘K», Export | `product-search`, `product-export` | `productDocs.ts` | `productDocsF3.test.ts` | accese |
| F4 — presenza, cursori, sezioni prese, `section_busy` | `product-live` | `productLive.ts` (uno stream per pagina) | `productLive.test.ts` | accesa |
| F5 — segni e domande di Claude, «Looks good», «Undo», «Undo all», le risposte, «Open a request» dal filo | `product-docs` | `productClaude.ts` | `productClaude.test.ts` | accesa |
| F6 — prima versione, dalla doc al backlog, richieste nate dalla pagina, bozze di schermata | `product-claude-actions` | `productFirstVersion.ts`, `productBacklog.ts`, `productWireframes.ts`, gli stati del disegno in `productDocs.ts` (`wireframeStatesOf`) | `productFirstVersion.test.ts`, `productBacklog.test.ts`, `productWireframes.test.ts`, `productDocs.test.ts` | spenta: aspetta il catalogo di Claude (Task 4 di 72) |

| Scelta o limite del renderer | Chi ha deciso |
|---|---|
| «Mostra le due versioni»: una scrittura di testo rifiutata (`stale`, `section_busy`, il paragrafo tolto da un altro) resta sotto il paragrafo, con «Use mine» e «Discard»; i gesti di struttura hanno solo la frase in barra | maintainer (21 nov 2026), la struttura 46 |
| «Some changes aren't saved yet» · Stay · Leave without saving uscendo dalla pagina o cambiando persona con scritture in fila, ferme su un errore o riquadri aperti; la fila ha 1,5 s per svuotarsi prima di chiedere; chiudere la finestra non chiede | maintainer via 46 (21 nov 2026), i dettagli 94 |
| Anche «Sign out» chiede prima, come il cambio di persona; «Leave without saving» svuota la fila (una scrittura già in viaggio arriva, nessuna dietro di lei); il testo scritto durante l'attesa di 1,5 s conta; il titolo e la didascalia col fuoco si salvano uscendo; un'immagine che carica al posto di una bozza conta come non salvata | 46 (revisione di R11-6, 22 nov 2026) |
| La frase di una voce di Claude sulla doc dice la pagina col codice del server (`codes` del gruppo) e il titolo solo se chi guarda l'ha letta in questa sessione; senza una lettura: solo il codice, o «a page» senza nemmeno quello. Una pagina riletta con 404 o 403 non dice più il titolo | costruttore, 46 (revisione di R11-6, M4–M5) |
| «Update it from this email/meeting» (`updateProductPage`) nella build app è `starts_work` e `irreversible`, e la riga non ha «Undo»: il server la applica dopo, in un lavoro della coda, quindi alla conferma non c'è ancora una revisione da annullare. Nel prototipo è sincrona e la riga ha «Undo». | costruttore, approvata da 46 (22 nov 2026) |
| Una bozza di schermata in disegno nasconde lo schizzo di prima; un disegno fallito lo dice sotto il blocco, col motivo | 46 |
| «Replace with an image» carica il file come ogni blocco immagine (`product-image:<id>`) | costruttore |
| La chiave di un commento (`clientId`) vale per un testo: cambiato fra l'errore e il «Retry», è un commento diverso con una chiave nuova, quindi se il primo era stato salvato restano due commenti | costruttore, approvata da 46 (22 nov 2026) |
| Lo Stato dell'istanza: un aggiornamento della doc nomina la pagina (codice, titolo, link) solo a chi legge i Docs del progetto e solo se il lavoro è di UNA pagina (a mano o una bozza); una fonte automatica o la prima versione restano «Product doc update» | 72 (136a81da2) su richiesta di 94, come `readsPage` del prototipo |
| «Pick» di una variante già disegnata (`POST …/wireframes/:blockId/pick`) c'è sul server ma non nel prototipo: il renderer non lo usa | costruttore |
| «Stop» della prima versione accanto all'avanzamento, solo con `permissions.stop`, senza conferma; Claude finisce la pagina in corso; «Stopping after this page…» da `stopping` della vista (riletta ogni 2 s mentre scrive), prima nel prototipo e poi su `stopFirstVersion` (a7f558344) | maintainer via 46 (22 nov 2026) |
