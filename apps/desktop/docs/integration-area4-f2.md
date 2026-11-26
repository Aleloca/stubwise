# Integrazione area 4 «Chat», fetta 2 — parità col prototipo (10 nov 2026)

Cosa della Chat del prototipo (`data/chat/*`) arriva sul server vero con la
fetta 2. Piano: `docs/plans/2026-11-10-integrazione-area4-fetta2-plan.md`;
invariante: `docs/invariants/chat.md`. La fetta 1 è in `integration-area4.md`.
Convenzioni come quel file. Le citazioni restano fuori, in attesa del
[DECIDE] 1 del piano.

## Server (F2.1–F2.5)

| Voce del prototipo | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| Vedere ≠ leggere (`canSeeChannel` / `canReadChannel`): privato ai membri, visto da chi gestisce l'ambito ma non letto; DM solo per chi partecipa, nemmeno per il full admin | `apps/server/src/chat/access.ts` (`channelVisibleSql`, `channelReadableSql`) | tutte le rotte `/api/chat` | `apps/server/src/routes/chat-f2.test.ts` («DM», «privati») |
| `channelPermissions`: `canRead`, `canEditInfo` (creatore o chi gestisce), `canEditTopic` (membri), `canEditEvents`, `canInvite`, `canRemove`, `canArchive`, `canDelete` (solo chi gestisce l'ambito, R-G3) | `access.ts` (`channelAccess`), `packages/shared/src/schemas/chat.ts` | la vista del canale | `chat-f2.test.ts`, `apps/server/src/routes/chat.test.ts` («gestire…») |
| `openDm`: da 2 a 8, si ritrova con le stesse persone, il più vecchio; un DM a due non si lascia | `apps/server/src/chat/service.ts` (`openDm`, `dm_key`), 0137 | `POST /api/chat/dm`, `DELETE …/channels/:id/join` | `chat-f2.test.ts` («DM»), `packages/db/src/migration-0137.test.ts` |
| `createChannel` generale o privato con gli invitati; nome unico nell'ambito | `service.ts` (`createChannel`), 0137 (`chat_channels_general_name_idx`) | `POST /api/chat/channels` (senza `projectId` = generale) | `chat-f2.test.ts` («generali d'istanza») |
| `inviteMembers` (mai sé stesso in un privato, solo persone dell'ambito), `removeMember` (mai l'ultimo di un privato) | `service.ts` | `POST /api/chat/channels/:id/members`, `DELETE …/members/:userId` | `chat-f2.test.ts` («invitare…») |
| `alsoInChannel`: la risposta nel flusso del canale | `service.ts` (`flowSql`), 0137 (`also_in_channel`) | `POST …/messages` con `alsoInChannel` | `chat-f2.test.ts` («anche nel canale») |
| `countsOf`: non letti per livello, `@channel` e `@reparto` fra le menzioni con «tutti», DM rivolti a chi partecipa; `chatSignalOf` | `service.ts` (`countsOf`, `signalOf`) | vista del canale, `GET /api/chat/signal` | `chat-f2.test.ts` («i non letti seguono il livello…», «DM») |
| `isGone`: un eliminato senza risposte sparisce dopo un giorno | `service.ts` (`goneSql`) | flusso, thread | `chat-f2.test.ts` («un eliminato senza risposte…») |
| Domande (`questionTargets`, `chatQuestionsOf`, `dismissQuestion`), card `chat.question` a un membro e `chat.mention` agli altri | `service.ts` (`questionsOf`, `publishCards`), 0137, 0138, `packages/notifications` | `GET /api/chat/questions`, `POST …/questions/:id/dismiss`, `notification_kind` `chat.question` | `chat-f2.test.ts` («domande»), `apps/mobile/src/components/inbox/InboxCard.test.tsx` |
| `searchChat`: canali letti, archiviati sì, eliminati no, parole senza maiuscole né accenti, contesto e radice | `service.ts` (`searchChat`, `foldChatText`), 0137 (`search_folded`, trigram) | `GET /api/chat/search` | `chat-f2.test.ts` («ricerca») |
| `createTaskFromMessage` / `createRequestFromMessage` e `linkedCodes`, filtrati per chi guarda | `apps/server/src/services/task-writes.ts`, `routes/project-requests.ts`, `apps/worker/src/backlog/chat-link.ts`, `service.ts` (`linksOf`) | `POST /api/tasks` e `POST /api/requests` con `chatMessageId` | `chat-f2.test.ts` («dal messaggio a Stubwise»), `apps/worker/src/backlog/intake.test.ts` («d-chat») |

## Renderer (F2, stubwise-94)

La scrive il renderer.
