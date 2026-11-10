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

Nella build app sono accesi la destinazione, la sezione di progetto e la
feature `chat`. Le viste sono quelle del server; la UI è quella del
prototipo, con gli ingressi delle fette dopo spenti dietro flag
(`CHAT_LATER_FEATURES` in `data/integration.ts`, con la fetta che li accende).

| Voce | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| Il client della Chat: canali, messaggi, thread, reazioni, letti, preferenze, follow, Threads, Mentions, il segnale, il percorso dello stream | `packages/api-client/src/endpoints/chat.ts` | `/api/chat/*` | `packages/api-client/src/endpoints/chat.test.ts` |
| Le 23 funzioni della fetta 1 nella forma del prototipo: i permessi del server (`canManage` → rinomina, argomento, archivia, elimina; inviti, rimozioni ed eventi spenti), i rifiuti negli errori del prototipo (`forbidden`, `not_found`, `invalid: archived/general/name_taken/deleted/threadOf`), «altri messaggi» col cursore opaco del server, attivi e archiviati per «Browse» | `data/backend/real/chat.ts` | — | `real/chat.test.ts` |
| Lo stream: un SSE per canale, il thread ascolta quello del canale e tiene la radice e le sue risposte; ripresa dal cursore col backoff delle sessioni; 401/403/404 chiude; ogni cambio rinfresca le letture | `real/chatStream.ts`; la parte pura `packages/shared/src/chat/sse.ts` | `GET /api/chat/channels/:id/stream?after=` | `real/chatStream.test.ts`, `packages/shared/src/chat/sse.test.ts` |
| Sul desktop lo stream lo apre il main col Bearer, con un'allowlist stretta (uuid e cursore di cifre) accanto a quella delle sessioni; i frame arrivano come `chatFrame` | `apps/desktop/src/main/apiStream.ts` | — | `apps/desktop/src/main/apiStream.test.ts` («stream della Chat») |
| La card `chat.mention` nell'inbox apre il messaggio nel suo canale (o nel suo thread); eliminato, canale o progetto che non si vedono più: senza link | `real/notifications.ts` | `GET /api/inbox` | `real/chatNotifications.test.ts` |
| I permessi `chat.*` dal registro condiviso (gruppi «people» e «chat», come il web) | `data/access/catalog.ts`, `domain/access/actions.ts` | — | `domain/access/access.test.ts` |
| Le pagine: la colonna coi canali del server, senza «New message», ricerca e DM; il canale con la casella che manda il testo (niente allegati né opzioni); il menu del messaggio senza «Create task/request»; ⌘N non apre un DM; «New channel» senza privati né generali; le impostazioni senza gli eventi | `pages/chat/*`, `layout/useShortcuts.ts` | — | `real/chatPage.test.tsx`; `pages/ComingSoon.test.tsx` |

| Scelta o limite | Chi ha deciso |
|---|---|
| Gli ingressi delle fette dopo spenti con flag di feature, ognuno con la sua fetta (2: `chat-dm`, `chat-private`, `chat-general`, `chat-search`, `chat-questions`, `chat-also-in-channel`, `chat-from-message`; 3: `chat-claude`; 4: `chat-events`, `chat-attachments`) | orchestratrice |
| «Load earlier» e «vai al messaggio»: il prototipo alza `limit`; l'adapter chiede al server pagine da al più 200 e va avanti col cursore opaco `before` della pagina, accumulandole fino al `limit` (review della fetta 1: oltre 200 il server rispondeva 400). Verso un messaggio lontano si sale di 200; su un errore ci si ferma e la pagina lo dice, con «Retry» | costruttore (review) |
| Il canale della Chat in «Browse»: due letture (attivi e archiviati), unite per id | costruttore |
| Lo stream: UNA connessione per canale, condivisa dai suoi thread (che trovano il canale della radice, riprovando col backoff); «arrivato» solo un messaggio più nuovo dell'ultimo visto (il server può ripeterne); le letture si rinfrescano solo se la vista del canale cambia; alla ripresa si rilegge la pagina; watchdog dei ping a 60 s anche sul web; il cursore dello stream lo dà il server (senza `after`, «adesso»), la pagina letta non ne ha uno da seminare | stubwise-72 (server), costruttore (review) |
