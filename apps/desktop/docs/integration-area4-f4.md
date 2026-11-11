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

Flag accesi nella build app: `chat-events`, `chat-attachments`
(`data/integration.ts`).

## Renderer (stubwise-94)

| Voce del prototipo | Build app | Test |
|---|---|---|
| La scheda di un evento (`SystemCard`): tipo, oggetto, «Open» | `toMessage` legge `event {kind, ref, object, pr}`; l'oggetto entra nelle viste delle citazioni (`eventViews` in `real/chat.ts`): codice e titolo a chi vede, il solo codice tenue a chi no; traguardi e brief col progetto (`#/p/<code>`, come il prototipo). Un oggetto che non c'è più (`object: null`) è `gone`: resta l'intestazione col tipo. `pr` non si mostra (il prototipo non lo fa) | `real/chatF4.test.ts`, `real/chatF4Page.test.tsx` |
| `setPublishedEvents` | `PUT /api/chat/channels/:id/events`; la sezione delle impostazioni del canale con `canEditEvents` del server | idem |
| `publishChatEvent`, `publishReleasePage`, `publishWeeklyBrief`, `recordPullRequestEvent` | restano del prototipo: sul server pubblicano i trigger. `release_page` è acceso ma inerte fino all'area 8 | — |
| Gli allegati di un messaggio | dal server, nell'ordine (nome, peso, `image` se il tipo è `image/*`); un eliminato non ne ha | `real/chatF4.test.ts` |
| Allegare (graffetta, incolla, trascina) e mandare | la casella tiene il `File`; i limiti sono quelli del server (25 MB, 10 per messaggio) e tipo ed estensione si controllano prima (`chatAttachmentAllowed`, `pages/chat/attachments.ts`). All'invio ogni file si carica nel canale (`POST …/attachments`, multipart), poi il messaggio li lega con `attachmentIds`; il testo è facoltativo. Un rifiuto (tipo, peso, storage spento, allegato scaduto) ferma l'invio e «Not sent» dice il perché. Il prototipo resta a 20 MB e ogni tipo | `real/chatF4.test.ts`, `real/chatF4Page.test.tsx` |
| `editMessage` | gli allegati restano invariati (`attachmentIds` non si manda), come il prototipo | — |
| «Download» (nuovo: il prototipo ha solo «Save to Drive») | `downloadAttachment`: sul desktop `api:download` del main (`apps/desktop/src/main/apiDownload.ts`: solo i download degli allegati, col bearer, 302 obbligatorio, Location https o http solo su un'istanza http; `will-download` chiede sempre dove salvare, nome ridotto al solo nome, non apre mai il file; né token né URL firmato nel renderer). Sul web un link allo stesso percorso | `main/apiDownload.test.ts`, `main/main.test.ts`, `real/chatF4.test.ts`, `real/chatF4Page.test.tsx` |
| La ricerca «con allegati» | `withAttachments=true` | `real/chatF4.test.ts`, `real/chatF4Page.test.tsx` |
| — | Il proxy del main accetta 26 MB solo per `POST /api/chat/channels/<uuid>/attachments`; altrove 15 MB | `main/apiProxy.test.ts` |
| — | `request` dell'api-client passa un `FormData` così com'è (prima lo serializzava in JSON: anche l'upload degli allegati dei ticket del desktop mandava `{}`) | `packages/api-client/src/endpoints/chat.test.ts` |
