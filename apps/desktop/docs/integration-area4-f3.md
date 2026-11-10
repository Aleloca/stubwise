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
| Proposte di una risposta (R-G1): sempre B, conferma solo chi ha chiamato (membro, non archiviato), scadenza 20 messaggi del thread o 24 ore, niente «Annulla»; per gli altri lettori senza argomenti (`redactClaudeEvents`, ridotto a ciò che il server registra) | `apps/server/src/claude-actions/proposals.ts`, `chat/claude.ts` (`chatProposalExpired`, `chatProposalGuard`, `claudeReplyViews`) | `POST /api/claude/proposals/:id/confirm|cancel`, `POST /api/claude/groups/:id/undo` → `not_undoable` | `chat-claude.test.ts` («le proposte in Chat»); golden `chat-mention-propose` |
| `answerChatClaudeQuestion` (R-G4): una domanda a chi chiama, una risposta sola, la ripresa | `apps/worker/src/claude-chat/mention.ts` (`askChatQuestion`, nel ponte), `chat/service.ts` (`answerClaudeQuestion`) | tool `ask_question`; `POST /api/chat/messages/:id/claude/answer` | `mention.test.ts` («ask_question, dal ponte»), `chat-claude.test.ts`; golden `chat-mention-ask` |
| `chatClaudeQuestionsOf`: «Da decidere» | `chat/claude.ts` (`claudeQuestionsOf`) | `GET /api/chat/claude-questions` | `chat-claude.test.ts` |
| `stopClaudeReply`, `retryClaudeReply`, eliminazione della risposta (D6) | `chat/service.ts` | `POST …/claude/stop`, `POST …/claude/retry`, `DELETE /api/chat/messages/:id` | `chat-claude.test.ts` («fermare, rifare, eliminare, rispondere») |
| Il segnale «Claude sta rispondendo» sulla radice | `chat/claude.ts` (`rootsWithClaudeWorking`) | `claudeReplying` del messaggio | `chat-claude.test.ts` |

## Renderer (stubwise-94)

La scrive il renderer.
