# Integrazione area 4 «Chat», fetta 1 — parità col prototipo (10 nov 2026)

Cosa della Chat del prototipo (`data/chat/*`, area 4) funziona sul server vero
nella **build app** (desktop e `/app`). Design:
`docs/plans/2026-11-10-integrazione-area4-chat-design.md`; piano:
`docs/plans/2026-11-10-integrazione-area4-fetta1-plan.md`; invariante:
`docs/invariants/chat.md`. Convenzioni come `integration-claude-chat.md`
(«real/» è `data/backend/real/`). Fetta 1: i soli canali di PROGETTO aperti.
Il resto (privati, DM, canali d'istanza, ricerca, @Claude, domande, task da un
messaggio) sta nel registro dei rimandi, area 4.

## Server (F1.1 e F1.2)

| Voce | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| Tabelle della Chat: canali, membri, messaggi (thread a un livello, eliminato senza testo per CHECK), reazioni, letture di canale e di thread, preferenze, thread seguiti | `packages/db/drizzle/0135_chat_channels.sql`, `packages/db/src/schema.ts` | — | `apps/server/src/routes/chat.test.ts` |
| Il «general» di ogni progetto: backfill per i progetti esistenti, trigger per quelli nuovi; uno solo per progetto; se ne va col progetto | 0135 (`projects_chat_general`, `chat_project_general()`) | — | idem («il «general» nasce col progetto…», «eliminare il progetto…») |
| Permessi `chat.channels.create`/`manage` (progetto) e `chat.general.create`/`manage` (istanza, ancora senza rotte) ai preset e ai ruoli che li contenevano | `packages/shared/src/permissions.ts`, 0135 | — | `packages/shared/src/permissions.test.ts`, `packages/db/src/roles-migration.test.ts` |
| Chi vede (chi vede il progetto, altrimenti 404), chi scrive (i membri; nel «general» tutti quelli che vedono il progetto, derivato), chi gestisce (`chat.channels.manage`, mai il «general») | `apps/server/src/chat/access.ts` | tutte le rotte `/api/chat` | idem («chi vede e chi scrive») |
| Canali: lista con non letti e menzioni, crea (409 `name_taken`), rinomina e archivia, elimina, entra ed esci, preferenza di notifica | `apps/server/src/chat/service.ts` | `GET/POST /api/chat/channels`, `GET/PATCH/DELETE …/:id`, `POST/DELETE …/:id/join`, `PUT …/:id/pref` | idem |
| Messaggi: pagina delle radici, thread, invio, modifica ed eliminazione dei propri, reazioni a toggle, letto, follow | idem | `GET/POST …/channels/:id/messages`, `POST …/:id/read`, `GET/PATCH/DELETE /api/chat/messages/:id`, `GET …/:id/thread`, `POST …/:id/reactions/toggle`, `PUT …/:id/follow` | idem («messaggi e thread») |
| «Threads», «Mentions» e il segnale del binario | idem (`threadsWithNews`, `mentionsOf`, `signalOf`) | `GET /api/chat/threads`, `/mentions`, `/signal` | idem |
| Menzioni `@Nome` decise dal server sui nomi di chi LEGGE il canale (R-G6: `@channel` no); card `chat.mention` con push; una modifica avvisa solo i nuovi | idem (`postMessage`, `editMessage`), `packages/notifications` | `notification_kind` `chat.mention` (0136) | idem («menzioni») |
| Card d'inbox derivata a lettura: blocco `chat` e url `/app/#/chat/…`; `objectGone` senza link se il messaggio, il canale o il progetto non ci sono più | `apps/server/src/services/inbox.ts`, `chatMentionsFor` | `GET /api/inbox` | idem; `apps/mobile/src/components/inbox/InboxCard.test.tsx` (la card nell'app) |
| Stream per canale: SSE, cursore intero in microsecondi, risveglio con LISTEN/NOTIFY | `apps/server/src/routes/chat.ts`, `apps/server/src/chat/bus.ts` | `GET /api/chat/channels/:id/stream?after=` | idem («non letti, letto, e lo stream…») |
| Schemi condivisi delle risposte e dei body, cursore `CHAT_STREAM_CURSOR_RE` | `packages/shared/src/schemas/chat.ts` | — | `packages/shared` (load-isolated), `packages/api-client` |

## Renderer (F1.3)

La scrive la F1.3 (stubwise-94).
