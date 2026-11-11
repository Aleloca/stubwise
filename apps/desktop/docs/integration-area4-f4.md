# Integrazione area 4 «Chat», fetta 4: eventi dei progetti e allegati — parità col prototipo (11 nov 2026)

Cosa di `data/chat/events.ts`, `writes.ts` e `reads.ts` del prototipo arriva
sul server vero. Piano: `docs/plans/2026-11-11-integrazione-area4-fetta4-plan.md`;
invariante: `docs/invariants/chat.md` («Eventi dei progetti e allegati»). Le
fette 1–3 sono in `integration-area4.md`, `integration-area4-f2.md` e
`integration-area4-f3.md`.

## Server (F4.1–F4.3)

| Voce del prototipo | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| `publishChatEvent`: un messaggio di sistema in ogni canale di progetto non archiviato che pubblica l'evento | `packages/db/drizzle/0141_chat_events_attachments.sql` (`chat_publish_event` e cinque trigger) | scrittori di task, richieste, traguardi, brief, PR | `packages/db/src/migration-0141.test.ts` |
| `eventText` / `SystemCard`: la scheda dell'oggetto, il titolo solo a chi lo vede | `apps/server/src/chat/events.ts` (`eventViews`) | `event` del messaggio | `apps/server/src/routes/chat-f4.test.ts` («gli eventi dei progetti nei canali») |
| `setPublishedEvents`, `canEditEvents`, ordine canonico | `chat/service.ts` (`setPublishedEvents`), `CHAT_EVENT_KINDS` | `PUT /api/chat/channels/:id/events` | `chat-f4.test.ts` («setPublishedEvents») |
| `release_page` | inerte fino all'area 8 ([DECIDE] 1 = a) | — | registro, area 8 |
| allegati di `sendMessage` (anche senza testo) | `apps/server/src/chat/attachments.ts`, `chat/service.ts` (`postMessage`) | `POST /api/chat/channels/:id/attachments`, `POST …/messages {attachmentIds}` | `apps/server/src/routes/chat-attachments.test.ts` |
| allegati di `editMessage` (si tolgono, non si aggiungono) | `chat/service.ts` (`editMessage`) | `PATCH /api/chat/messages/:id {attachmentIds?}` | idem |
| `scrubDeleted`: un eliminato non ha allegati | `chat/service.ts` (`deleteMessage`), `deleteStoredObjects` | `DELETE /api/chat/messages/:id` | idem |
| il download per chi legge il canale | `chat/attachments.ts` (`downloadableAttachment`) | `GET /api/chat/attachments/:id/download` (302) | idem («un privato e un DM») |
| `searchChat`: «con allegati» e i nomi dei file nel `haystack` | `chat/service.ts` (`searchChat`, `search_folded`) | `GET /api/chat/search?withAttachments=true` | idem («la ricerca e la potatura») |
| (nuovo) la potatura dei sospesi oltre 24 ore | `chat/attachments.ts` (`pruneChatUploads`), timer in `app.ts` | — | idem |

## Renderer (stubwise-94)

La scrive il renderer.
