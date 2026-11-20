# Integrazione «Chat con Claude», fette 1–3 — parità col prototipo (10 nov 2026)

Cosa del prototipo della chat libera con Claude (area 3 §2 e §5, area 10)
funziona sul server vero nella **build app** (desktop e `/app`). Design:
`docs/plans/2026-11-10-integrazione-claude-chat-design.md`; piano:
`docs/plans/2026-11-10-integrazione-claude-chat-f1f2-plan.md`. Convenzioni come
`integration-area3{a,b,c,d}.md` («real/» è `data/backend/real/`).

Nelle fette 1 e 2 Claude **legge e risponde**: non esegue né propone niente.
Dalla fetta 3 (sezione sotto) **propone**, e il server esegue.
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
| Token del turno (`stw_chat_…`): emesso dal worker, hash nel DB, scade col turno, revocato nel finally; solo GET e solo `CHAT_TOOL_READ_ROUTES`, più UN POST dalla fetta 3 (`CHAT_TOOL_WRITE_ROUTES`: creare una proposta); mai la riconferma; cade con la conversazione archiviata o eliminata | `packages/db/src/chat-tool-tokens.ts`, `apps/server/src/auth/{session,access,chat-tool-routes}.ts` | — | `apps/server/src/auth/chat-tool-token.test.ts`; invariante in `docs/invariants/second-factor.md` |
| Turno della chat: cwd vuota, `--tools ""` (nessun tool nativo), `--setting-sources ""`, MCP strict, solo i tool di `stubwise_chat` (dalla fetta 3: 7 di lettura, con `list_people`, più `propose_action`); `--resume`; il contesto della pagina a ogni turno come `tipo: id` | `apps/worker/src/claude-chat/{turn,prompts,bridge,scheduler}.ts`, `apps/worker/src/chat-mcp/` | operazione AI `claude_chat` (migrazione 0128) | `apps/worker/src/claude-chat/*.test.ts`; golden `chat-read`, `chat-no-leak`, `chat-resume` (`chat-no-act` ritirato nella fetta 3) |

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

## Fetta 3 — proposte e azioni (server e worker; il renderer è la F3.4)

Claude **propone, il server esegue**. Il renderer (schede, conferma,
«Annulla», «via Claude», azioni della pagina) ha la sua parte, scritta con la
F3.4.

| Voce | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| Il catalogo CHIUSO delle azioni (aree 2 e 3) con la classe dichiarata; `deleteTask` solo come inverso di `createTask` | `packages/shared/src/schemas/claude-actions.ts` (`CLAUDE_ACTION_FNS`, `CLAUDE_DECLARED_CLASS`, `CLAUDE_ACTION_ARGS`), `apps/server/src/claude-actions/catalog.ts` | — | `claude-actions.test.ts` («il catalogo del server»: lo STESSO accesso della rotta), `claude-actions-never.test.ts` (sul sorgente di server e worker) |
| La classe la calcola il server con una prova a secco (esecuzione e ROLLBACK): sale a B se avviserebbe altri (`notifies`), se avvia lavoro di Claude (`starts_work`) o se manca l'inverso (`irreversible`); niente esce dalla transazione a secco | `claude-actions/execute.ts`, `effects.ts` | — | `claude-actions-effects.test.ts` (a runtime e sulla chiusura degli import) |
| La proposta: il token del turno la CREA (la sola rotta di scrittura del token), idempotente per `toolUseId`; una A si esegue subito, una B aspetta l'autore; scade dopo 20 messaggi o 24 h | `claude-actions/proposals.ts`, `routes/claude-conversations.ts`, `auth/chat-tool-routes.ts` | `POST/GET /api/claude/conversations/:id/proposals`, `GET …/groups` | `claude-actions.test.ts`, `chat-tool-token.test.ts` |
| Conferma, rifiuto, «Annulla» SOLO dell'autore (cookie o PAT, mai il token del turno); i permessi si ricontrollano; tutto o niente; «Annulla» una volta, se nessuno ha scritto dopo (`changed_after`), e diventa una scheda B se avviserebbe qualcuno | `claude-actions/{proposals,undo}.ts`, `routes/claude-actions.ts` | `POST /api/claude/proposals/:id/confirm`, `…/cancel`, `POST /api/claude/groups/:id/undo` | `claude-actions.test.ts` |
| Il segno «via Claude»: `via_claude_action_id` su storia, commenti, notifiche e lapidi, da un DEFAULT di colonna che solo l'esecutore accende; l'attore resta la persona | migrazione 0131; `claude-actions/execute.ts` | — | `claude-actions.test.ts` |
| Le notifiche di un'azione hanno il link pubblico (il piano da approvare di uno `startRun`) | `routes/claude-actions.ts` (`actionEffects`) | — | `claude-actions.test.ts` («LINK pubblico») |
| Il tool `propose_action` (worker): il ponte fa il POST della proposta e al modello torna solo l'esito (EXECUTED coi codici, NOT DONE YET, REFUSED col motivo); `toolUseId` dal `_meta` del CLI | `apps/worker/src/chat-mcp/server.ts`, `claude-chat/bridge.ts` | — | `claude-chat/bridge.test.ts` |
| `list_people` per proporre un assegnatario per nome: solo id, nome, iniziali, reparti e la riga di Claude; MAI le email | `claude-chat/bridge.ts` (`projectToolResult`), `auth/chat-tool-routes.ts` | `GET /api/people` | `bridge.test.ts` («list_people non porta email»), `chat-tool-token.test.ts` |
| Il contratto del prompt: si propone col tool; mai «fatto» prima di EXECUTED; una B è «ti chiedo di confermare»; «Annulla» è il bottone della persona, col suo nome nella lingua di chi scrive; il «mai» si rifiuta dicendo dove si fa; le firme delle azioni generate dagli schemi del server | `claude-chat/prompts.ts`, `claudeActionSignatures` (shared) | — | `prompts.test.ts`, `turn.test.ts`; golden `chat-propose-not-execute`, `chat-confirm-executes`, `chat-undo`, `chat-never-catalog` |

| Scelta o limite | Chi ha deciso |
|---|---|
| UNA rotta di scrittura col token del turno, che crea una proposta (D2) | orchestratrice |
| `createTask` è A, con «Annulla» = eliminazione vera (D1) | maintainer |
| Le azioni della pagina sono A ed eseguite dal renderer; il server le valida soltanto (D3) | orchestratrice |
| Assegnare Claude (con `updateTask`/`planTask`) o `startRun` sono sempre B (`starts_work`) | orchestratrice (approvato) |
| `list_people` senza email | orchestratrice |
| `chat-no-act` ritirato: il suo prompt regge `chat-confirm-executes` | costruttore (approvato) |
| Senza il `toolUseId` del CLI il ponte ne conia uno: niente idempotenza in quel caso (registro dei rimandi) | costruttore (approvato) |
| `changed_after` delle richieste e dei filtri guarda solo `updated_at` e non dice chi (`changedBy` null); quello di un traguardo guarda solo che esista ancora; i fix di server e i rilasci non sono nel catalogo (aree non integrate) | costruttore |

## F3.4 — il renderer delle proposte e delle azioni

Il flag `claude-chat-actions` è acceso nella build app. Gli eventi
`proposal`/`actions_executed` della sessione portano solo gli id: la scheda e
la riga si DERIVANO dalle viste del server (classe e motivi calcolati adesso,
stato di «Annulla» per chi guarda), e i riassunti delle azioni si leggono dai
dati, mai dal modello.

| Voce | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| Scheda di una B (classe e motivi del server, anche `starts_work`) e riga «executed» di una A col suo gruppo e i codici; una B confermata resta scheda, senza riga in più | `data/backend/real/claudeChatActions.ts` (`readChatActions`, `chatActionEvents`), `real/claude.ts` (`getConversation`), `pages/claude/conversation/ProposalCard.tsx` | `GET …/proposals`, `GET …/groups` | `real/claudeChatActions.test.ts`; un server senza le rotte (404) legge la conversazione senza schede |
| Dal vivo: una proposta arrivata nello stream diventa la sua scheda | `real/claudeStream.ts` (`actions`, `readActions()`) | stream della sessione | `real/claudeStream.test.ts` |
| Confirm, Confirm selected, Cancel, «Undo» (subito, o una scheda se gli inversi avviserebbero qualcuno; `changed_after` col nome) | `claudeChatActions.ts` (`confirmProposal`, `cancelProposal`, `claude.undoClaudeActions`, `undoViewsOf`) | `POST /api/claude/proposals/:id/confirm`, `…/cancel`, `POST /api/claude/groups/:id/undo` | `real/claudeChatActionsPage.test.tsx` |
| «Edit» di `createTask`/`createRequest`: il dialogo di sempre, e la conferma porta i valori cambiati (`edited`); la esegue il server | `ProposalCard.tsx` (`confirmEdited`, solo build app), `NewTaskDialog`/`NewRequestDialog` (`submit`) | `confirm` con `edited` | `claudeChatActionsPage.test.tsx` |
| Riga di benvenuto `landing.intro` e i comandi d'azione di «/» (`/plan`, `/new-task`, `/new-request`, `/run`) col flag | `pages/claude/ClaudePage.tsx`, `real/claudeChat.ts` (`listCommands`) | — | `real/claudeChat.test.ts`, `claudeChatPage.test.tsx` |
| Azioni della pagina (D3): una proposta di sole `pageAction` diventa eventi `pageAction`, eseguiti dal renderer SOLO se arrivano dal vivo in questa finestra; lette dalla storia restano «non applicate» col gesto «Apply»; lo stato è per persona, in memoria | `claudeChatActions.ts` (`settlePageEvent`, `forgetPageStatuses`) | — | `claudeChatActionsPage.test.tsx` |
| Il segno «via Claude» dal server: `via: "claude"` sul registro della task, «Claude on behalf of …» sulle card d'inbox (le persone si leggono solo se serve), «By person» | `real/taskDetail.ts`, `real/notifications.ts`, `real/peopleActivity.ts`; server `services/via-claude.ts` | campi `viaClaude*` di commenti, `/activity`, `/api/inbox`, `/api/people/activity` | `real/viaClaude.test.ts`; server `claude-actions/via-reads.test.ts` |

| Scelta o limite | Chi ha deciso |
|---|---|
| `viaClaude` si DERIVA a lettura (colonne `via_claude_action_id` → azione → gruppo), mai nel jsonb delle notifiche; il server dà l'id del richiedente, il nome lo risolve il renderer | orchestratrice |
| Lo stato delle azioni della pagina («fatto», «annullato») vive nel renderer, per persona e in memoria; un'azione parte solo dal vivo, mai da una lettura (dopo un ricaricamento il tema non torna da solo) | orchestratrice (review F3.4) |
| «Edit» nella build app conferma la proposta coi valori cambiati (`edited`) invece di creare a mano come il prototipo: l'esecuzione resta del server, col segno «via Claude» | costruttore |

## Fetta 5 — conversazioni pubbliche e continuazione (server e worker; il renderer è la F5.4)

Piano: `docs/plans/2026-11-10-integrazione-claude-chat-f5-plan.md`, con le
decisioni del maintainer D1–D6. Il modulo unico è
`apps/server/src/services/claude-public.ts`.

| Voce | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| Chi vede: l'autore; da pubblica chi ha `claude.public.view` (preset User per migrazione; l'Admin per costruzione, perché full admin). Una privata altrui è 404 anche per il full admin | `services/agent-sessions.ts` (`visibleTo`), `services/claude-conversations.ts` (`readableRow`), `claude-public.ts` (`canReadPublic`); migrazione 0133 | `GET /api/claude/conversations/:id`, eventi e stream delle sessioni | `routes/claude-public.test.ts` («chi vede»); `packages/shared/src/permissions.test.ts` |
| «Make public» con la conferma ESPLICITA dei progetti letti o toccati (sempre, anche con l'elenco vuoto), che dice delle letture dei tool (D1); «Make private» azzera; un'archiviata non si pubblica | `claude-conversations.ts` (`setClaudeConversationVisibility`) | `POST /api/claude/conversations/:id/visibility` (409 `needs_confirmation` con `projects`, `includesToolReads`, `reconfirm`) | `claude-public.test.ts` («pubblicare…») |
| I progetti letti o toccati (D2): le letture del token per codice o per id, le azioni proposte, i codici citati, il contesto; mai il dato letto | `claude-public.ts` (`recordChatToolReadProjects` in `onSend`, `recordConversationProjects`, `touchedProjectIds`); `claude-actions/proposals.ts` | tabella `claude_conversation_projects` | idem |
| Gli eventi dei tool RESTANO visibili ai lettori (decisione del maintainer, D1, con l'esempio in `docs/invariants/agent-sessions.md`) | — | — | `claude-public.test.ts` (il seguito rilasciato porta `tool_use`/`tool_result`) |
| Proposte e gruppi per i lettori: argomenti INVARIATI (coperti da D1, come gli eventi dei tool), senza quelli del seguito privato, in sola lettura (`canConfirm` false, `undo` `not_yours`, nessuna prova a secco) | `claude-actions/proposals.ts` (`readerLimits`, `proposalView`) | `GET …/:id/proposals`, `GET …/:id/groups` | `claude-public.test.ts` («proposte e gruppi») |
| Il seguito privato, DERIVATO a lettura: un turno in corso, o che ha toccato un progetto nuovo, non arriva ai lettori (eventi, proposte, gruppi, parziali dello stream) finché non è finito e pulito, o riconfermato | `claude-public.ts` (`holdOf`, `holdForOwnerMessage`, `readerCut`); `agent-sessions.ts` (eventi, `sendAgentMessage`); `routes/agent-sessions.ts` (stream senza parziali); `proposals.ts` (`readerLimits`) | `private_from_event_id` | `claude-public.test.ts` («il seguito privato», «proposte e gruppi») |
| La vista per chi guarda: `author`, `isOwner`, `publishedBy`, `publishedProjects` (solo i visibili), `privateTail` (lettore), `heldProjects` (autore), `canPublish`, `canContinue`; il contesto invisibile a null; niente interventi per i lettori | `claude-conversations.ts` (`toView`), `agent-sessions.ts` (`loadAgentSession`) | `GET …/:id`, `GET …?scope=public` | `claude-public.test.ts`, `packages/shared/src/schemas/claude-conversation-public.test.ts` |
| «Public»: le pubbliche di altri, non archiviate, con il permesso; le proprie restano in «Mine» | `claude-conversations.ts` (`listClaudeConversations`) | `GET /api/claude/conversations?scope=public` | `claude-public.test.ts` |
| «Continua»: una conversazione NUOVA, privata, di chi continua; titolo, contesto se lo vede, primo messaggio suo; Claude agisce come lui | `claude-conversations.ts` (`continueClaudeConversation`) | `POST /api/claude/conversations/:id/continue` (409 `not_public`, 404) | `claude-public.test.ts` («Continua») |
| La prosa LEGGIBILE dell'originale nel primo prompt della continuazione (D3): un'istantanea calcolata dal server al «Continua», fino al seguito privato, mai gli eventi dei tool, con un tetto | `claude-conversations.ts` (`readableTranscript`), `apps/worker/src/claude-chat/{prompts,turn}.ts`; migrazione 0134 (`origin_transcript`) | — | `claude-public.test.ts`, `worker/src/claude-chat/{prompts,turn}.test.ts`; golden `chat-continue` |
| Una pubblica non si pota; una tornata privata riparte da «Make private» (D5) | `apps/worker/src/sessions/store.ts` (`pruneAgentSessions`) | `visibility_changed_at` | `worker/src/sessions/prune-public.db.test.ts` |

| Scelta o limite | Chi ha deciso |
|---|---|
| Gli eventi dei tool restano per i lettori (D1); la conferma lo dice | maintainer |
| I progetti letti o toccati li ricava il server (D2); gli elenchi generici contano solo per ciò che la risposta cita | maintainer (D2); limite nel registro |
| La continuazione porta solo la prosa dell'originale (D3), anche se chi continua vede gli eventi dei tool | maintainer (D3); orchestratrice (solo prosa) |
| `claude.public.view` al preset User; l'Admin per costruzione (D4) | maintainer |
| Una pubblica non si pota (D5); la finestra riparte da «Make private» | maintainer; orchestratrice (contorno) |
| La riga di «Public» con l'autore (D6) | maintainer |
| La conferma di pubblicazione è sempre esplicita, anche senza progetti | costruttore (approvato) |
| L'originale di una continuazione è un uuid senza FK: un'origine eliminata si legge «non più disponibile» | costruttore (approvato) |
| L'istantanea della prosa al «Continua», non letta dal vivo, con un tetto di 40 messaggi e 12.000 caratteri; «Public» ordinato per `updated_at` (il messaggio dell'autore fa salire la riga anche se il turno resta privato) | costruttore; limiti nel registro |

## F5.4 — il renderer delle pubbliche e della continuazione

Il flag `claude-public` è acceso nella build app (con la F5.3 il server è
completo). Le viste sono quelle del server (F5.1–F5.3); la UI è quella del
prototipo.

| Voce | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| Il client: `list({ scope: "public" })`, `setVisibility` (409 `needs_confirmation` nei `details`), `continue` | `packages/api-client/src/endpoints/claude.ts` | `GET …?scope=public`, `POST …/:id/visibility`, `POST …/:id/continue` | `packages/api-client/src/endpoints/claude.test.ts` |
| «Public»: le pubbliche di altri, con l'autrice e chi l'ha resa pubblica; il seguito privato (`privateTail`) nella riga e nel dettaglio | `data/backend/real/claudeChat.ts` (`listPublic`, `toConversation`, `toFreeRow`) | `GET …?scope=public` | `real/claudePublic.test.ts` |
| Chi legge una pubblica di un altro la legge e basta (`isOwner: false`): niente casella, niente gestione, `readOnlyReason: "not_owner"`, «Continue» | `claudeChat.ts` (`freeDetailOf`) | `GET …/:id` | `claudePublic.test.ts`, `real/claudePublicPage.test.tsx` |
| «Make public» / «Make private»: il dialogo si mostra sempre (anche senza progetti), coi progetti del 409 e la frase sulle letture di Claude (`includesToolReads`, D1); la riconferma del seguito privato chiede solo i progetti nuovi (`heldProjects`) | `claudeChat.ts` (`setVisibility`), `pages/claude/PublishDialog.tsx` | `POST …/:id/visibility` | `claudePublic.test.ts`, `claudePublicPage.test.tsx` |
| «Continue»: nasce la conversazione di chi legge (201), il primo messaggio va lì; l'originale si legge DAL VIVO, come lo vede chi continua, e se non c'è più `available: false` | `claudeChat.ts` (`continueConversation`), `real/claude.ts` (`originOf`) | `POST …/:id/continue` | `claudePublic.test.ts`, `claudePublicPage.test.tsx` |
| `claude.public.view` dal registro condiviso, nel gruppo «people» come il web (via dai permessi locali) | `data/access/catalog.ts`, `domain/access/actions.ts` | — | `domain/access/access.test.ts` |

| Scelta o limite | Chi ha deciso |
|---|---|
| Il server non dà l'indice del seguito privato: per l'autrice `privateFromIndex` dice solo se c'è (`heldProjects` non vuoto); la pagina non usa altro | costruttore |
| R-G5 regge per costruzione: nella build app i codici nella prosa di Claude non si collegano (solo le citazioni registrate, che il server non registra), quindi un codice che chi legge non vede non si apre | costruttore (limite che già c'era) |
| Lo stream di chi legge si ferma al confine del seguito privato e riprende da sé al rilascio: lo fa il server (F5.2), il renderer legge e basta | orchestratrice |

## Area 10, F1 — le letture dei chip (server e worker; i chip sono di 94)

Piano `docs/plans/2026-11-19-integrazione-area10-f1-plan.md`. Ogni tool è una
GET sulla rotta che la pagina usa già, col token del turno, e il ponte passa
al modello solo i campi in ALLOWLIST.

| Tool | Chip (contesto) | Rotta | Da fuori | Test |
|---|---|---|---|---|
| `read_automation` | `{ kind: "automation", id: "AUD-A3" }` (anche `AUT-4`) | `GET /api/automations/:code` | no | `bridge.test.ts`, `chat-tool-token.test.ts`; golden `chat-automation-read` |
| `read_server` | `{ kind: "server", id: "SRV-12" }` | `GET /api/servers/by-code/:code` | no | come sopra; golden `chat-server-read` |
| `read_support_conversation` | `{ kind: "support", id: "AUD-S4" }` | `GET /api/support/conversations/by-code/:code` | **sì** | come sopra; golden `chat-support-hostile` |
| `read_channel` | `{ kind: "channel", id: "<uuid>" }` | `GET /api/chat/channels/:id` e `…/messages?limit=30` | **sì** | come sopra; golden `chat-channel-hostile` |
| `read_mail_thread` | `{ kind: "mail", id: "<accountId>/<threadId>" }` (il tool prende `ref`) | `GET /api/me/mail/threads/:threadId?account=` | **sì** | come sopra; golden `chat-mail-hostile` |
| `read_calendar_event` | `{ kind: "calendar_event", id: "<uuid>" }` | `GET /api/me/calendar/events/:id` | **sì** | come sopra |

| Scelta o limite | Chi ha deciso |
|---|---|
| Un tool per tipo, ognuno con la sua allowlist (D-12 = a) | orchestratrice |
| Da fuori = rotta anche in `CHAT_TOOL_UNTRUSTED_ROUTES`: da lì ogni proposta è almeno B; il testo dentro `untrusted_content` con la nota fissa | costruttore (regola dell'area 5) |
| Posta e calendario solo di chi chiede, anche per un full admin (`mailbox_owner`) | invariante |
| Il chip della posta porta `<accountId>/<threadId>` in un solo `id` | 94 e 72 |
| Le PR non hanno un tool (nessuna lettura per Claude) | costruttore |
| Posta, calendario, canali privati e DM, automazioni generali solo in una conversazione libera PRIVATA (403 altrove); letti, la conversazione non si pubblica (409 `private_content`, la pagina lo dice) | orchestratrice (review di F1, I2: rifiutare invece di tagliare gli eventi) |
| Nei turni di @Claude nella Chat posta e calendario non ci sono (I3) | orchestratrice |
| Oggetto della mail, nome e descrizione del canale, titolo e descrizione della richiesta del supporto, hostname e nomi dei servizi: dentro `untrusted_content` (I4, M6); delle condizioni delle automazioni niente valori (M5); niente indirizzi web nel testo di un invito (M2) | orchestratrice |

## Area 10, F2 — un'automazione dal riquadro (server e worker; la scheda e la prova sono di 94)

| Voce | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| Le bozze di automazione: `createAutomation` (A), `saveAutomationDraft` (A), `deleteAutomationDraft` (B), solo di progetto; mai accese | `claude-actions/catalog-automations.ts`, sui servizi di `automations/writes.ts` | `POST /api/automations`, `PUT`/`DELETE …/:code/draft` | `claude-actions-automations.test.ts`, `claude-actions-never.test.ts` |
| «Annulla» di una bozza: cade se qualcuno salva dopo (versione, rev, pubblicazione) | `claude-actions/undo.ts` (`automationStamp`) | — | `claude-actions-automations.test.ts` |
| Le domande a scelta nella libera: UNA per risposta, scritta dal worker; letta filtrata per chi legge una pubblica; risposta dell'autore come suo messaggio | `claude-chat/conversation-question.ts`, `services/claude-conversation-questions.ts` | `GET /api/claude/conversations/:id/questions`, `POST …/questions/:questionId/answer` | `conversation-question.test.ts`, `claude-conversation-questions.test.ts` |
| I reparti per «avvisa un reparto» | `claude-chat/bridge.ts` | `list_departments` → `GET /api/departments` | `bridge.test.ts`, `chat-tool-token.test.ts` |
| La guida ai flussi nel contratto | `@stubwise/shared` `claudeAutomationGuide` | — | `claudeGuide.test.ts`, `prompts.test.ts`; golden `chat-s1-automation` |

| Scelta o limite | Chi ha deciso |
|---|---|
| Le domande hanno una lettura a sé (come le proposte), non un campo della vista | orchestratrice (ruling approvato) |
| La prova della bozza la fa il renderer e la segna provata (`testedRev`) | orchestratrice |
| `list_departments`: una lettura nuova, che il design non prevedeva (serve a «avvisa un reparto») | costruttore |

## Area 10, F3 — rispondere sui dati (server e worker; la riga «Details» è di 94)

| Voce | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| Il lavoro fermo con le soglie dei progetti (la regola e la rotta della lista delle task) | `claude-chat/bridge.ts` (`read_stalled_work`, `stalledProjects`) | `GET /api/tasks/stalled`, `GET /api/projects` | `bridge.test.ts`, `claude-asides.test.ts` (oltre la soglia sì, dentro no); golden `chat-s2-stalled` |
| L'`aside` («Hypothesis», «Details»): scritto dal worker, arricchito a lettura | `claude-chat/aside.ts`, `services/claude-asides.ts` (in `listAgentSessionEvents`) | evento `aside` (0199) | `aside.test.ts`, `claude-asides.test.ts` |
| La spesa del mese coi permessi del server; senza, `canSee: false` e chi può dirlo | `claude-chat/bridge.ts` (`read_usage_month`) | `GET /api/ai-usage/summary`, `GET /api/access/who-can` | `bridge.test.ts`, `chat-tool-token.test.ts`; golden `chat-s3-usage`, `chat-s3-usage-denied` |

| Scelta o limite | Chi ha deciso |
|---|---|
| «Fermo» = le soglie dei progetti, non la regola del polso | maintainer (20 nov 2026) |
| `thresholdDays` solo per il motivo `idle` (gli altri motivi non hanno soglia) | costruttore |
| Chi non vede nessuno riceve `whoCan` vuoto (R-G5): Claude dice «chi amministra l'istanza» | costruttore (accettato) |
| D-13 = a: la spesa a chi ha `usage.view` o `project.usage.view`, a nessun altro | maintainer |

## Area 10, F4 — archiviare in blocco (server e worker)

| Voce | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| L'ultima attività di un progetto (come `lastActivityOf`), in una query | `services/project-activity.ts` (`lastActivityByProject`) | — | `project-activity.test.ts` |
| I progetti da archiviare: candidati, occupati, non gestibili; mai un invisibile | `services/project-activity.ts` (`archiveCandidates`) | `GET /api/projects/archive-candidates` | `project-activity.test.ts` |
| Claude legge prima e propone i soli candidati (D-9 = a) | `claude-chat/bridge.ts` (`read_archive_candidates`), `prompts.ts` (`BULK_ARCHIVE_RULE`) | — | `bridge.test.ts`, `prompts.test.ts`; golden `chat-s4-archive` |

| Scelta o limite | Chi ha deciso |
|---|---|
| Un tool che dà anche i fermi (deviazione dal design: senza l'ultima attività Claude non saprebbe quali chiedere) | orchestratrice (approvata) |
| Niente esiti per riga: le righe non fattibili stanno nella prosa, non spente nella scheda | orchestratrice (D-9 = a) |

## Area 10, F5 — chi entra in un progetto (server; la card è di 94)

| Voce | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| Il tipo `member.added` nel catalogo degli avvisi (famiglia «members»): alla persona aggiunta sempre (`added`), a chi gestisce i membri di partenza | `@stubwise/shared` `alerts/catalog.ts`; `notifications` (`format`, `alert-recipients` con `exclude`) | `notification_kind` (0200) | `alert-recipients.test.ts`, `format.test.ts`, `migration-0200.test.ts` |
| La card nasce nella transazione della voce del registro, a ogni INGRESSO (a mano, `addMember` di Claude, invito accettato); mai a chi ha agito, mai per un cambio di ruolo, un reparto o l'agente | `services/roles.ts` (`publishMemberAdded`), `services/change-log.ts` (`recordChange` dà l'id) | `PUT /api/projects/:projectId/members/:userId`, accettazione dell'invito | `project-members.notify.test.ts` |
| «Undone by» derivato a lettura dal registro (voce d'ingresso → azione di Claude → voce che la annulla), mai dal jsonb | `services/inbox.ts` (`undoneByOfMemberAdded`) | `/api/inbox` (`undoneBy`, additivo) | `inbox-member-added.test.ts`, `notification.test.ts` (shared) |
| Claude propone `addMember` coi membri e i ruoli del progetto | — | `read_project_members` | golden `chat-s5-member` |

| Scelta o limite | Chi ha deciso |
|---|---|
| Alla persona aggiunta e a chi gestisce i membri, spegnibile per i gestori | maintainer (D-11 = b) |
| Nell'invito accettato l'attore è chi accetta: la card va ai gestori, non a lui | orchestratrice |
| Il full admin dell'istanza riceve la card come gestore di ogni progetto | costruttore (come gli altri tipi del catalogo) |

## Area 10, F6 — le bozze nei campi (server e worker; il segno «Bozza di Claude», Undo e Apply sono di 94)

| Voce | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| `fillField` nel catalogo condiviso (A, args strict, tetto della rotta del campo) e `RENDERER_FNS` | `@stubwise/shared` `schemas/claude-actions.ts` | — | `claude-actions.test.ts` (shared, anche il parse `UNKNOWN`) |
| La strada del renderer: da sola, mai nella Chat, B dopo un contenuto non fidato; nessuna scrittura | `claude-actions/proposals.ts` | `POST /api/claude/conversations/:id/proposals` | `claude-actions-fill-field.test.ts` |
| Chi può scrivere il campo: le regole delle rotte (voce `updateTask`; `releaseNotesWriteAccess`) | `services/claude-field-access.ts` (`canFillField`), `services/pr-release-notes.ts` | — | `claude-actions-fill-field.test.ts` |
| Le note di una PR per Claude, contenuto non fidato | `claude-chat/bridge.ts` (`read_pull_request_notes`), `auth/chat-tool-routes.ts` | `GET /api/repositories/:repositoryId/pulls/:prNumber/release-notes` | `bridge.test.ts`, `chat-tool-token.test.ts`; golden `chat-pr-notes-hostile` |
| La regola del prompt: una bozza, la salva la persona | `claude-chat/prompts.ts` (`FIELD_DRAFT_RULE`) | — | `prompts.test.ts`; golden `chat-s6-field` |

| Scelta o limite | Chi ha deciso |
|---|---|
| Claude legge le note della PR con un tool nuovo (F6-1 = a) | maintainer |
| Il tetto del testo è quello della rotta del campo (100 000 la descrizione, 20 000 le note) | costruttore (ruling del piano) |
| Il contesto della pagina di una PR è `pr: <repositoryId>:<prNumber>` (lo stesso oggetto dei suggerimenti di F7) | costruttore |

## Area 10, F8 — «/status» e «/today» (server e worker; i comandi sono di 94)

| Voce | Dove vive | Rotta / pezzo | Test |
|---|---|---|---|
| `assigneeIds=me` nella lista delle task, risolto dal server su chi chiede | `services/task-view.ts` (`taskFilterConditions`), shared `task-view.ts` | `GET /api/tasks` | `tasks.read.test.ts` |
| Il codice della task nell'elenco delle decisioni | `services/decisions.ts` (`listDecisions`) | `GET /api/decisions` (`taskCode`, additivo) | `decisions.test.ts` |
| «/today»: le decisioni che aspettano chi scrive e le sue task aperte | `claude-chat/bridge.ts` (`read_my_week`, `myWeekResult`), `prompts.ts` (`STATUS_AND_TODAY_RULE`) | `GET /api/decisions?askedOfId=me&open=true`, `GET /api/tasks?assigneeIds=me` | `bridge.test.ts`, `prompts.test.ts`, `chat-tool-token.test.ts`; golden `chat-today` |
| «/status»: seguiti, polso (senza titoli né `stalled`), task ferme con le soglie, codici | `claude-chat/bridge.ts` (`read_followed_projects`, `followedProjectsResult`) | `GET /api/me/follows`, `GET /api/projects/pulse`, `GET /api/tasks/stalled` | `bridge.test.ts`, `chat-tool-token.test.ts`; golden `chat-status` |

| Scelta o limite | Chi ha deciso |
|---|---|
| Il polso entra nelle letture di Claude, ma il suo fermo no: il fermo è quello delle soglie (F3) | maintainer (20 nov 2026) |
| `me` nella lista delle task invece di dare al ponte l'id di chi scrive (`/api/auth/me` resta fuori: dà la sessione intera) | costruttore (ruling del piano) |

## Rimandate

| Voce | Fetta |
|---|---|
| La classe C (riconferma) e le azioni che la chiedono | 4 della chat (dopo la riconferma dal desktop) |
| Riga «Claude can help you…» e bozze nei campi | con le azioni |
| Azioni delle aree non integrate | con la loro area |
