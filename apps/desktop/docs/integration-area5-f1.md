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

La scrive il renderer.
