# Integrazione area 5 «Docs e Drive», fetta 1: Docs nel desktop — parità col prototipo (11 nov 2026)

Cosa dei Docs del prototipo (`data/docs/{reads,writes,chat}.ts`, `data/model.ts`)
arriva sul server vero. Design: `docs/plans/2026-11-11-integrazione-area5-docs-design.md`;
piano: `docs/plans/2026-11-11-integrazione-area5-fetta1-plan.md`; invariante:
`docs/invariants/docs.md`. I Docs restano «come oggi» (maintainer): le rotte di
albero, pagina, brief, release, grafo e chat c'erano già.

## Server (F1.1–F1.6)

| Voce del prototipo | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| `DocPage.code` `<PRJ>-D<n>`, stabile, mai riusato | `packages/db/drizzle/0142_doc_page_codes.sql` (`doc_page_codes`, trigger `doc_pages_code`), `apps/server/src/services/doc-codes.ts` | `code` su albero, pagina, highlights, ricerche | `packages/db/src/migration-0142.test.ts`, `apps/server/src/routes/docs-codes.test.ts` |
| Il link di un codice (`resolveCodes`, la rotta della pagina) | `services/doc-codes.ts` (`resolveDocCode`) | `GET /api/docs/codes/:code` | `docs-codes.test.ts` («la risoluzione di un codice») |
| ⌘K: un codice esatto in cima | `routes/search.ts` | `GET /api/search` | `docs-codes.test.ts` |
| Citazione `doc` con la rotta, codici scritti a mano (R-H2, R-G5) | `apps/server/src/chat/citations.ts` | `citations[]` dei messaggi (`code`, `doc`) | `docs-codes.test.ts` («le citazioni doc della Chat») |
| `askDocs` con le fonti per codice | `routes/project-docs.ts`, `routes/docs-chat.ts` | `sources[].code` | `apps/server/src/routes/project-docs.test.ts` |
| Pagina manuale trovata come le altre | `services/doc-embed.ts` | `POST/PATCH …/docs/manual` | `apps/server/src/routes/docs-manual-embed.test.ts` |
| Claude legge le pagine | `apps/worker/src/chat-mcp/server.ts`, `claude-chat/bridge.ts`, `apps/server/src/auth/chat-tool-routes.ts` | tool `read_doc_page` | `bridge.test.ts`, `apps/server/src/auth/chat-tool-token.test.ts`; golden `chat-read`, `chat-mention-read` |
| `DocGeneration.reason`, `resumesAt`, `progress` | `routes/docs.ts` (stato) | `GET …/docs/status` (`reasonCode`, `resumesAt`, `progress`) | `apps/server/src/routes/docs-status.test.ts` |
| `DocSpace.projectId` | `routes/docs.ts`, `routes/project-docs.ts` | `projectId` sugli spazi | `docs-status.test.ts` |
| CRUD manuale, generazione, stato per il renderer | `packages/api-client/src/endpoints/docs.ts` | `client.docs.*` | `packages/api-client/src/endpoints/docs.test.ts` |
| Grafo (`GraphState`) | `packages/shared/src/schemas/repo-graph.ts` | `repoGraphStateSchema` | (i metodi dell'api-client li scrive stubwise-94) |

## Renderer (stubwise-94)

Accesi nella build app: la sezione `docs` del progetto e la feature `docs`
(`data/integration.ts`). Il livello dati è `data/backend/real/docs.ts`; il
grafo ha i suoi metodi in `packages/api-client/src/endpoints/graph.ts`. I Docs
arrivano «come oggi» (maintainer): nessuna funzione oltre il prototipo.

| Voce del prototipo | Build app | Test |
|---|---|---|
| Citazione `doc` nella Chat e codici D scritti a mano | codice e titolo, link `#/p/<CODE>/docs/<repo>/<slug>`; un codice D si risolve con `GET /api/docs/codes/:code` e la pagina (404 o pagina tolta: non torna) | `real/docCodes.test.ts` |
| `listDocSpaces`, `getDocSpace` | spazi del progetto + per ciascuno albero, highlights, stato, brief e grafo; permessi `docs.edit`/`docs.generate`/`repos.manage` da quelli di progetto che il server calcola | `real/docs.test.ts`, `real/docsPage.test.tsx` |
| `listDocTree` | l'albero del server (piatto, con `parentId`) nelle quattro categorie; il percorso è la catena dei titoli delle madri | idem |
| `getDocPage`, `recordDocView` | la pagina col codice, `staleSince` come commit successivi, i link risolti per slug sull'albero; la visita con `docs.viewPage`, fire-and-forget | idem |
| `searchDocs` | `projectSearch` dei progetti con i Docs (o di quello del repository) | `real/docs.test.ts` |
| `getRepoBrief` | il brief del server nei campi del prototipo | idem |
| `getProjectDocsHome` | spazi, «inizia da qui», le decisioni dal registro del progetto (recenti e totale vero, fino al tetto di 200), «novità» dalle note di rilascio | idem |
| `createManualPage`, `updateManualPage`, `deleteManualPage` | le rotte `…/docs/manual`; 409 `doc_page_slug_conflict` è `slug_conflict` | `real/docs.test.ts`, `real/docsPage.test.tsx` |
| `startGeneration`, `resumeGeneration` | `generate`/`resume`, lo stato riletto; `reasonCode`, `resumesAt`, `progress` del server | `real/docs.test.ts` |
| `askDocs` | la chat del progetto o del repository con `stream=false`, ogni domanda a sé (nessuna sessione che continua), come il prototipo; 503 è «non disponibile» | idem, `real/docsPage.test.tsx` |
| `graphAction`, lo stato del grafo, le comunità | `graph.state`/`generate` (`force` per «da zero»)/`setupPr`/`report`; le comunità dal resoconto Markdown, lette una volta per costruzione | `real/docs.test.ts`, `real/docsPage.test.tsx`, `packages/api-client/src/endpoints/graph.test.ts` |
| `generationHistory`, `whenDocsIdle` | strumenti del prototipo: nessuna storia, niente da aspettare | — |

### Differenze dichiarate

- **Niente streaming nella chat** (come il prototipo): la risposta arriva intera.
  Nessun timeout la taglia oggi (server limitato da `CHAT_MAX_TOKENS` = 4096; il
  main senza timeout proprio, quindi i 300 s di intestazioni di undici; web e
  Caddy senza). Se il tetto dei token sale molto o un modello è molto lento, i
  300 s del main scattano per primi: allora la strada è lo streaming.
- **La chat si assume disponibile**: il server non lo dice prima di una
  domanda; un 503 mostra la riga «non disponibile».
- **Note di rilascio**: le «pagine toccate» il server non le dà (vuote); il
  testo si legge solo aprendo lo spazio (le 30 più recenti).
- **Estratto** delle pagine negli elenchi vuoto (lo dà solo la ricerca e la
  pagina aperta); negli elenchi niente data di modifica né «commit successivi».
- **Albero**: una pagina che ha figlie compare sia come cartella sia come pagina.
- **Slug** di una manuale: sul server non cambia; il form lo dice (`slug_fixed`).
- **Brief**: i percorsi sono un titolo e un riassunto (un solo passo); le fonti
  sono percorsi.
- **Grafo**: il resoconto non dà il riassunto delle comunità né le comunità
  vicine; «Abilita» su un grafo spento non funziona dal desktop (si accende
  nelle impostazioni del repository, non integrate) e dice l'errore;
  `graph.json` scaricato è quello composto dallo stato, non il file del server.
- **Spazio Prodotto** (area 11a) nella pagina iniziale: assente.
- **Export** zip dei Docs: assente (il prototipo non lo ha), e `api:download`
  non cambia allowlist.
