# Integrazione area 4 «Chat», fetta 3: @Claude nei canali — parità col prototipo (10 nov 2026)

Cosa di `data/chat/claude.ts` del prototipo arriva sul server vero e sul
worker. Piano: `docs/plans/2026-11-10-integrazione-area4-fetta3-plan.md`;
invariante: `docs/invariants/chat.md` («@Claude nella Chat»). Le fette 1 e 2
sono in `integration-area4.md` e `integration-area4-f2.md`.

## Server e worker (F3.1–F3.5)

| Voce del prototipo | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| `callClaudeIfAsked` / `startReply`: «@Claude» fa nascere subito la risposta nel thread, «chiamato da» chi scrive; una modifica non chiama | `apps/server/src/chat/claude.ts` (`callsClaude`, `startClaudeReply`), `chat/service.ts` (`postMessage`), 0140 | `POST /api/chat/channels/:id/messages` | `apps/server/src/routes/chat-claude.test.ts` («la chiamata») |
| `threadContext`: il thread prima della chiamata, come lo legge chi chiama, senza eliminati, citazioni visibili | `chat/claude.ts` (`callContext`, `openingText`) | primo input della sessione | idem; golden `chat-mention-read` |
| La sessione è di chi chiama, gli eventi dei tool solo suoi (D5) | `services/agent-sessions.ts` (`visibleTo`), kind `chat_mention`, `claude_conversations` | `/api/agent-sessions/:id/…` | `chat-claude.test.ts` (404 a un altro membro) |
| `work` / `chatSteps`: il testo dal vivo, «done», «waiting», «failed» col motivo | `apps/worker/src/claude-chat/{turn,mention,prompts}.ts` | turno `chat_mention` | `apps/worker/src/claude-chat/mention.test.ts`; golden `chat-mention-*` |
| Proposte di una risposta (R-G1): sempre B, conferma solo chi ha chiamato (membro, non archiviato), scadenza 20 messaggi del thread o 24 ore, niente «Annulla»; per gli altri lettori gli argomenti delle sole azioni sugli oggetti che vedono, correzione dell'11 nov 2026 (`redactClaudeEvents`, ridotto a ciò che il server registra) | `apps/server/src/claude-actions/proposals.ts`, `chat/claude.ts` (`chatProposalExpired`, `chatProposalGuard`, `claudeReplyViews`, `argsVisibleTo`) | `POST /api/claude/proposals/:id/confirm|cancel`, `POST /api/claude/groups/:id/undo` → `not_undoable` | `chat-claude.test.ts` («le proposte in Chat», «due lettori»); golden `chat-mention-propose` |
| `answerChatClaudeQuestion` (R-G4): una domanda a chi chiama, una risposta sola, la ripresa | `apps/worker/src/claude-chat/mention.ts` (`askChatQuestion`, nel ponte), `chat/service.ts` (`answerClaudeQuestion`) | tool `ask_question`; `POST /api/chat/messages/:id/claude/answer` | `mention.test.ts` («ask_question, dal ponte»), `chat-claude.test.ts`; golden `chat-mention-ask` |
| `chatClaudeQuestionsOf`: «Da decidere» | `chat/claude.ts` (`claudeQuestionsOf`) | `GET /api/chat/claude-questions` | `chat-claude.test.ts` |
| `stopClaudeReply`, `retryClaudeReply`, eliminazione della risposta (D6) | `chat/service.ts` | `POST …/claude/stop`, `POST …/claude/retry`, `DELETE /api/chat/messages/:id` | `chat-claude.test.ts` («fermare, rifare, eliminare, rispondere») |
| Il segnale «Claude sta rispondendo» sulla radice | `chat/claude.ts` (`rootsWithClaudeWorking`) | `claudeReplying` del messaggio | `chat-claude.test.ts` |

## Renderer (stubwise-94)

`chat-claude` è acceso nella build app (`data/integration.ts`). Il livello dati
è `data/backend/real/chatClaude.ts` (la vista) più le funzioni in
`real/chat.ts`; la scheda e la casella sono quelle del prototipo.

| Voce del prototipo | Build app | Test |
|---|---|---|
| La risposta «Claude · called by X» nel thread, il segnale «Claude is replying…» sulla radice | `toMessage` + `claudeFieldsOf`: `claudeRun` (stato, motivo, `retried`) dal blocco `claude` del server; `claudeReplying` della radice | `real/chatClaude.test.ts`, `real/chatClaudePage.test.tsx` |
| Le righe d'azione («cosa ha letto») solo a chi ha chiamato (D5) | lette dalla sessione (`/api/agent-sessions/:id/events`) SOLO se il server dà `sessionId`, cioè a chi ha chiamato; per gli altri nessuna richiesta | idem («un altro lettore»: nessuna richiesta alle sessioni) |
| Il testo e le righe dal vivo | lo stream del canale porta la risposta; le righe si leggono a parte e la risposta torna «cambiata» quando cambiano (una lettura per risposta alla volta) | `real/chatStream.test.ts` («@Claude dal vivo») |
| Le schede (R-G1): B, niente «Annulla», decide solo chi ha chiamato | evento `proposal` con `cls: "B"`, senza gruppo; `canDecide` = `canConfirm`/`canCancel` del server; gli argomenti solo a chi ha chiamato, agli altri un riassunto senza titoli (`claude.chatActions.summaryHidden.*`) | `chatClaudePage.test.tsx` (anche chi ha chiamato coi flag spenti; confermata senza «Undo») |
| `confirmChatProposal` / `cancelChatProposal` / `editChatProposal` | le rotte delle proposte (`/api/claude/proposals/:id/confirm|cancel`); «Edit» conferma coi valori cambiati (`edited`, li esegue il server); `completeEditedChatProposal` resta del prototipo | `chatClaude.test.ts` («le proposte») |
| Il canale archiviato o lasciato mentre la scheda è aperta | il 404 della rotta si distingue col canale: archiviato → «invalid: archived», non più membro o non letto → «not_member»; la scheda lo dice (`refusalText`: `chat.claude.proposalArchived`, `proposalNotMember`) | `chatClaude.test.ts`, `chatClaudePage.test.tsx` |
| `answerChatClaudeQuestion` (R-G4), dal thread e da «Da decidere» | `POST …/claude/answer`; chi arriva secondo legge `already_answered` | `chatClaude.test.ts`, `chatClaudePage.test.tsx`, `homePage.test.tsx` |
| `chatClaudeQuestionsOf` («Da decidere») | `listClaudeQuestions` su `GET /api/chat/claude-questions`, col canale come lo legge chi guarda | `chatClaude.test.ts`, `homePage.test.tsx` |
| `stopClaudeReply`, `retryClaudeReply` | le rotte `…/claude/stop|retry`; i bottoni seguono `canStop`/`canRetry`/`canAnswer` del server | `chatClaude.test.ts`, `chatClaudePage.test.tsx` («seguono i flag del server») |
| Il budget finito | `failed` col motivo `budget` (nuovo nel tipo `ChatClaudeFailure` e in i18n) | `chatClaudePage.test.tsx` |
| La casella: «@Claude» fra le menzioni, l'avviso, il thread che si apre dopo l'invio | accesi col flag | `chatClaudePage.test.tsx`, `real/chatOpenThread.test.tsx` |

Restano del prototipo (non chiamate dalla build app): `whenClaudeIdle`,
`callText`, `completeEditedChatProposal`.
