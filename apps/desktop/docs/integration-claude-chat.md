# Integrazione «Chat con Claude», fette 1 e 2 — parità col prototipo (10 nov 2026)

Cosa del prototipo della chat libera con Claude (area 3 §2 e §5, area 10)
funziona sul server vero nella **build app** (desktop e `/app`). Design:
`docs/plans/2026-11-10-integrazione-claude-chat-design.md`; piano:
`docs/plans/2026-11-10-integrazione-claude-chat-f1f2-plan.md`. Convenzioni come
`integration-area3{a,b,c,d}.md` («real/» è `data/backend/real/`).

In queste due fette Claude **legge e risponde**: non esegue né propone niente.
Il prototipo resta com'era; in `data/integration.ts` sono accese `claude-chat`
(la chat nella destinazione Claude) e `claude-panel` (il riquadro). Restano
spente `claude-public` (le pubbliche), `claude-suggestions` (la riga «Claude can
help you…»), `claude-chat-actions` (proposte e azioni in chat) e `product-docs`
(le domande della doc di prodotto nel riquadro).

## Server e worker (fetta 1)

| Voce | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| Conversazione libera = sessione `free`, a turni, PRIVATA dell'autore (nemmeno un full admin la vede) | `apps/server/src/services/claude-conversations.ts`, `agent-sessions.ts` | `GET/POST /api/claude/conversations`, `GET/PATCH/DELETE /api/claude/conversations/:id`; messaggi, eventi e stream sono quelli di `/api/agent-sessions/:id/…` | `apps/server/src/routes/claude-conversations.test.ts` |
| Titolo dalla prima domanda (template `conversationTitleFrom`), anche se la conversazione nasce vuota e il primo messaggio arriva dopo | `agent-sessions.ts` (`sendAgentMessage`, ramo `free`) | — | idem («nata vuota») |
| Budget del mese finito: niente conversazione nuova né messaggio (409 `budget_exhausted`); la casella lo legge prima di scrivere | `claude-conversations.ts` (rotta `status`) | `GET /api/claude/conversations/status` → `{ budgetExhausted }` | idem |
| Token del turno (`stw_chat_…`): emesso dal worker, hash nel DB, scade col turno, revocato nel finally; solo GET e solo `CHAT_TOOL_READ_ROUTES`; mai la riconferma; cade con la conversazione archiviata o eliminata | `packages/db/src/chat-tool-tokens.ts`, `apps/server/src/auth/{session,access,chat-tool-routes}.ts` | — | `apps/server/src/auth/chat-tool-token.test.ts`; invariante in `docs/invariants/second-factor.md` |
| Turno della chat: cwd vuota, `--tools ""` (nessun tool nativo), `--setting-sources ""`, MCP strict, solo i 6 tool di lettura di `stubwise_chat`; `--resume`; il contesto della pagina a ogni turno come `tipo: id` | `apps/worker/src/claude-chat/{turn,prompts,bridge,scheduler}.ts`, `apps/worker/src/chat-mcp/` | operazione AI `claude_chat` (migrazione 0128) | `apps/worker/src/claude-chat/*.test.ts`; golden `chat-read`, `chat-no-act`, `chat-no-leak` |

## Superfici (fetta 2, renderer)

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| «New conversation» (l'atterraggio di /claude), N: la casella crea la conversazione e manda la domanda | `pages/claude/ClaudePage.tsx`; `real/claudeChat.ts` (`createConversation`) | `POST /api/claude/conversations`, poi `POST /api/agent-sessions/:id/messages` | `real/claudeChatPage.test.tsx` |
| «Mine» (e «Recent» nella colonna) | `ClaudeColumn.tsx`, `ConversationList.tsx`; `real/claude.ts` → `real/claudeChat.ts` (`listMine`) | `GET /api/claude/conversations?scope=mine[&archived=true]` | `real/claude.test.ts`, `real/claudeChatPage.test.tsx` |
| La conversazione aperta (`/claude/:id`): flusso, casella, «Ferma» | `pages/claude/conversation/*`; `real/claude.ts` (`getConversation`, ramo `free`), `real/claudeActions.ts` (`sendMessage`, `stop`, `stopAndSend`) | `GET /api/claude/conversations/:id`, `GET /api/agent-sessions/:id/events`, lo stream, `POST …/messages` | `real/claudeChatPage.test.tsx` |
| Rinomina, archivia (e ripristina), elimina | `ClaudePage.tsx` (`PageHeader`); `real/claudeChat.ts` | `PATCH`, `DELETE /api/claude/conversations/:id` | `real/claudeChatPage.test.tsx` |
| Il progetto di contesto scelto all'inizio | `ClaudePage.tsx`; `real/claudeChat.ts` (`setConversationContext`) | `PATCH … { context: { kind: "project", id } }` | — (da provare a mano) |
| Il riquadro (⌘J, ⌘K «Ask Claude…»), col chip del contesto della pagina | `layout/claudePanel/*`; `real/claudeChat.ts` (`describeContext`, `contextIdOf`, `sendFreeMessage`) | il chip rilegge la task (`/api/tasks/by-code/:code`, `/api/tickets/:id`) o la richiesta; il messaggio aggiorna prima il contesto (`PATCH`) | `real/claudeChat.test.ts`, `real/claudeChatPage.test.tsx` («il riquadro») |
| Budget finito: la casella si spegne con la sua frase | `ClaudePage.tsx`, `Composer.tsx`, `ClaudePanel.tsx`; `real/instanceChat.ts` (`instance.getAiBlock(null)`) | `GET /api/claude/conversations/status` | `real/claudeChatPage.test.tsx` |
| «/» (comandi), «#» (task e progetti), «@» (persone), codici nel testo | `Composer.tsx`; `real/claudeChat.ts` (`listCommands`, `searchMentions`, `resolveCodes`) | `GET /api/tasks?text=`, `/api/projects`, `/api/people`, `/api/tasks/by-code/:code`, `/api/requests/by-code/:code` | `real/claudeChat.test.ts` |

## Scelte e limiti

| Scelta o limite | Chi ha deciso |
|---|---|
| Solo le proprie («Mine»): niente pubbliche, niente «Continua», niente «Make public» | maintainer (pubbliche dopo) |
| Niente proposte né azioni di Claude in chat; fuori portata il modello risponde e dice dove si fa a mano | maintainer |
| Il token del turno invece di un servizio interno, con le sei condizioni | orchestratrice (approvato) |
| `--tools ""` nei turni di chat: il CLI esponeva tool nativi oltre l'elenco dei negati (`ToolSearch` eseguito al primo giro dei golden) | orchestratrice (approvato) |
| La riga di benvenuto promette la sola lettura (`landing.introRead`) | orchestratrice (approvato) |
| Il titolo dal primo messaggio anche per una conversazione nata vuota | orchestratrice (approvato) |
| UN contesto per conversazione: il chip di un messaggio lo sostituisce (l'ultimo vince); per task e richieste al server va il CODICE, che il modello rilegge coi tool | costruttore (approvato) |
| Nessuna skill dei plugin del progetto in «/» | costruttore |
| «#» senza richieste e pagine Docs; le citazioni registrate sui messaggi non esistono sul server (Claude cita col codice nel testo) | costruttore / server |
| Il chip c'è per task, richieste, pagine e impostazioni di progetto; gli oggetti delle aree non integrate (rilasci, supporto, PR, automazioni, posta) non danno chip né contesto | costruttore |
| Conservazione: le conversazioni inattive da 14 giorni si potano come le altre sessioni (`pruneAgentSessions`), con le trascrizioni del CLI (`claude-chat/cli-dir.ts`, potatura dello scheduler); la sessione del CLI nata da più di 14 giorni si scarta. La casella lo dice («Conversations inactive for 14 days are deleted») | maintainer (review delle fette 1–2) |
| Il budget in chat non lo scavalca nessuno | costruttore |
| `--resume` vero: cwd deterministica per conversazione (`<tmp>/stubwise-chat/<id>`); eliminare la conversazione toglie cwd e trascrizioni del CLI | review delle fette 1–2 |
| «/» con `/explain` e `/docs` soli (i comandi che i tool di lettura coprono), descrizioni tradotte | review delle fette 1–2 |
| Nessun allegato nei messaggi (`claude-attachments` resta spenta) | server |

## Fetta 3.0 — «Elimina task» (server e renderer)

| Voce | Dove vive | Rotta | Test |
|---|---|---|---|
| «Delete task…» nel menu «⋯» della task e il dialogo (si può, perché no col «Who?», cosa la occupa, le figlie che restano, il codice che non si riusa) | `pages/task/TaskMoreMenu.tsx`, `DeleteTaskDialog.tsx`; `real/taskDelete.ts` | `GET /api/tasks/:id/deletion`, `DELETE /api/tasks/:id` (409 `busy`, 403, 404) | `apps/server/src/routes/tasks.delete.test.ts`, `real/taskPanel.test.tsx` |
| La richiesta d'origine dice «La task MKX-31 è stata eliminata» | `real/requests.ts` (`deletedTaskCodes`) | il dettaglio della richiesta | `real/requests.test.ts` |
| La card d'inbox di una task eliminata: codice in testo, nessun link (`objectGone`) | `real/notifications.ts` | `/api/inbox` (`objectGone`, `taskCode` dalla lapide) | `real/session.test.ts`, test del server |
| Lo standup elenca le task eliminate del giorno, a chi le ha eliminate | `real/peopleActivity.ts` (invariato) | `/api/people/activity` (`tasksDeleted`) | test del server |

| Scelta o limite | Chi ha deciso |
|---|---|
| Eliminazione VERA, regole del prototipo (chi: autore con `tickets.edit` o `tickets.moderate`; busy; niente annullamento né riconferma) | maintainer |
| La lapide tiene codice, titolo, richiesta d'origine, chi, quando: mai descrizione, commenti, allegati, storia | orchestratrice / costruttore |
| Le sessioni dell'agente della task se ne vanno con lei (il prototipo le tiene): la loro visibilità passa dal ticket. Il dialogo lo dice («Anche il lavoro di Claude su questa task… viene eliminato; restano i consumi e il registro decisioni») | maintainer |
| Una ragione in più di `busy`: «una correzione della sua PR è ancora aperta» (`open_correction`); i fix di server e rilasci del prototipo non ci sono (aree non integrate) | costruttore |
| Gli allegati si tolgono anche dallo storage, dopo il commit e best-effort (come l'eliminazione di un commento) | costruttore |

## Rimandate

| Voce | Fetta |
|---|---|
| Proposte e azioni di Claude in chat (classi A/B/C/D calcolate dal server, «Annulla») | 3 della chat |
| Conversazioni pubbliche e continuazione | fetta a sé, dopo |
| Riga «Claude can help you…», bozze nei campi, azioni della pagina | con le azioni |
| Azioni delle aree non integrate | con la loro area |
