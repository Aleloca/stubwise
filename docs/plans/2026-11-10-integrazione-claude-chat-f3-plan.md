# Chat con Claude, fetta 3 — proposte e azioni A/B sulle aree 2–3 — piano

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Spec:** `docs/plans/2026-11-10-integrazione-claude-chat-design.md` («Proposte e azioni», «Classi come il prototipo», «Architettura», «Mai nel catalogo»), decisioni del maintainer del 10 nov 2026. **Specifica del comportamento**: il prototipo — `apps/desktop/src/renderer/data/claude/{catalog,catalogMore,classes,actions,via,types}.ts`, `data/store.ts` (`PROPOSAL_EXPIRY`, `proposalExpired`, `conversationPermissions`), `layout/claudePanel/pageActions.ts`, `neverInCatalog.test.ts`, `via.test.ts`, `undo.test.ts`, `classes.test.ts`; parità area 10 in `apps/desktop/docs/area10-parity.md`. **Base**: fette 1–2 (`apps/desktop/docs/integration-claude-chat.md`). Registro: `docs/plans/integrazione-registro-rimandi.md`. Invarianti: `docs/invariants/{agent-sessions,permissions,second-factor,tasks}.md`, i due divieti dell'operatore e «Il registro decisioni non è MAI scritto dall'AI» (`CLAUDE.md`). Branch: `feat/integrazione-claude-chat`. Migrazioni: la prima libera dopo la **0128** (verificarla sul branch d'integrazione dell'area 3 prima di scriverla).

## Global Constraints

1. **Claude propone, il server esegue.** Il tool MCP `propose_action` SCRIVE UNA PROPOSTA e basta: non chiama nessun servizio di scrittura, non sa eseguire. Nessun tool di scrittura diretta, nel worker né nel server MCP.
2. **La classe la calcola il server**, sui dati veri **al momento**: alla nascita della proposta, a ogni lettura della scheda e alla conferma. Può solo **salire** rispetto a quella dichiarata dal catalogo; il modello non la decide e non la vede come input (se la manda, si ignora).
3. **L'esecuzione la fa il server con gli stessi servizi delle rotte** (`task-writes.ts`, `comments.ts`, `milestones.ts`, le scritture delle richieste e dei filtri, `run-ai`), con i **permessi della persona ricontrollati in quel momento** (`projectPermissionsFor`), mai una via parallela né un controllo più largo. Un rifiuto del servizio è il rifiuto dell'azione.
4. **Il catalogo è un elenco CHIUSO** (tabella sotto), con le sole aree integrate (2 e 3). Una `fn` fuori elenco è `invalid` prima di ogni scrittura. La classe **C** (riconferma) e le voci delle aree non integrate restano fuori: **fetta 4** e le loro aree.
5. **Mai nel catalogo**, verificato sul SORGENTE del server, del worker e del renderer (come `neverInCatalog.test.ts` del prototipo):
   - approvare, rifiutare, pre-approvare o revocare un piano;
   - rispondere a un `ask_user`;
   - mergiare, rilasciare o fare deploy;
   - scrivere nel registro decisioni;
   - leggere o mostrare segreti (cassaforte, token, chiavi);
   - inviare fuori (posta, webhook, risposte ai clienti);
   - creare PAT, inviti o link di reset.
6. **«via Claude»**: ogni scrittura fatta per una persona porta il segno su registro modifiche, attività, commenti e notifiche. `actorId`/`authorId` resta la PERSONA; il segno è un dato in più, mai un attore. Il segno vive in UN modulo del server e nessuna funzione pubblica lo accetta come argomento (lo accende solo l'esecutore).
7. **Il registro decisioni resta non scritto dall'AI**: confermare una proposta non è una decisione registrata; `decisions-never-ai.test.ts` si estende ai moduli nuovi.
8. **I due divieti dell'operatore valgono anche via Claude**:
   - `startRun` passa dal gate del piano come `run-ai` (senza `plans.approve` nasce in attesa d'approvazione);
   - nessuna azione mergia.
9. **Il token del turno resta GET-only**, salvo UNA rotta (D2): creare una proposta. Nessuna scrittura parte da un token del turno senza passare dalla regola della classe.
10. **Verso i client, solo cambi additivi** (`CLAUDE.md`): campi nuovi con default, kind e tipi d'evento nuovi dietro `readerSchema`; nel web vecchio i campi nuovi si difendono a lettura.
11. **Golden obbligatori** (si toccano prompt, tool MCP e runner) sul CLI pinnato 2.1.322, coordinati con stubwise-94; uno scenario rosso NON si aggiusta forzando il prompt: si porta all'orchestratrice.

## Decisioni (prese il 10 nov 2026)

- **D1 — maintainer**: si aggiunge l'**eliminazione delle task vera**, in generale, come nel prototipo (area 10a). È una fetta a sé, **F3.0** (sotto), prima del resto. Con lei `createTask` in chat torna **A** con «Annulla» = eliminazione, come nel prototipo.
- **D2 — orchestratrice: la (a)**. UNA sola rotta di scrittura raggiungibile col token del turno, `POST /api/claude/conversations/:id/proposals`, in `CHAT_TOOL_WRITE_ROUTES`, con una voce sola e il suo test di registro; idempotente per `toolUseId`. Il token resta GET-only su tutto il resto. La condizione 2 di `docs/invariants/second-factor.md` si aggiorna con il motivo, nello stesso commit della rotta (F3.2).
- **D3 — orchestratrice: sì.** Le azioni della pagina sono proposte di classe A eseguite dal renderer, con «Annulla» locale; il server le valida e non esegue niente.

## F3.0 «Elimina task» (server e renderer, prima della chat)

Spec: `apps/desktop/.impeccable/shape/task-delete.md` e `apps/desktop/src/renderer/data/taskDelete.ts` (decisioni del maintainer del 2 nov 2026). L'azione esiste anche a mano, per tutti, dal menu «⋯» della task.

- **Chi**: l'autore con `tickets.edit`, o chi ha `tickets.moderate` nel progetto. L'utente di sistema Claude non ha `tickets.moderate`: non elimina una task che non ha creato (P24).
- **Quando no**:
  - `busy`: una sessione di lavoro di Claude non finita (anche in attesa o `held`), una PR aperta della task, una correzione aperta;
  - `not_found` per una task invisibile o inesistente, prima di `forbidden` (ordine dei controlli del prototipo).
- **Niente**: nessun annullamento a mano, nessuna riconferma (basta il dialogo che nomina codice e titolo). L'unica eliminazione senza dialogo è l'«Annulla» di una creazione fatta da Claude.
- **Cosa toglie**: la task, coi suoi commenti, allegati, storia (`ticket_events`), collegamenti da e verso altre task, accordi della giornata e domande aperte. Le figlie restano, senza madre.
- **Cosa resta e la nomina ancora**:
  - la richiesta d'origine («Task MKX-31 was deleted»);
  - le notifiche: `objectGone` DERIVATO a lettura, mai riscritto nel jsonb;
  - il registro decisioni: non si riscrive;
  - i traguardi, che la escono dai conteggi;
  - le conversazioni e le PR chiuse.
  Lo legge una **lapide** `deleted_tickets(project_id, number, title, deleted_by, deleted_at, via_claude_action_id)` per progetto e numero.
- **Il codice non si riusa mai**: `projects.next_ticket_number` non scende.
- **Eliminata = inesistente**, come un codice mai esistito ovunque sia citato (R-G5); fa eccezione solo la riga della richiesta d'origine. La lapide chiude anche lo standup: `tasksDeleted` arriva dal server, oggi è sempre vuoto.
- **Migrazioni**: per ognuna delle FK verso `tickets` (16 `cascade`, 3 `set null`) si decide e si scrive accanto il motivo: cosa se ne va con la task, cosa resta col riferimento nullo. Una sessione `ai_job` finita resta, col ticket nullo, come «di una task eliminata».
- **Rotte**:
  - `GET /api/tasks/:id/deletion` → `TaskDeletionPreview` del prototipo: `canDelete`, `whoAction`, `busy` con le ragioni visibili, `children`;
  - `DELETE /api/tasks/:id`: `tickets.edit`, oppure il controllo autore/moderatore DENTRO il servizio, ridondante col `config.access`, come i due divieti; risponde 409 `busy` con le ragioni. L'evento esce ai follower;
  - api-client per entrambe.
- **Renderer**: la voce «Delete task…» e il `DeleteTaskDialog` del prototipo, accesi nella build app (`featureIntegrated("task-delete")`), con le frasi dello shape; le letture che nominano una task eliminata (richiesta, notifiche, codici citati) sui dati veri.
- **Test**:
  - chi può e chi no (autore senza `tickets.edit`, moderatore, Developer, full admin; Claude mai su una task d'altri);
  - `busy` per ogni ragione;
  - figlie che restano;
  - collegamenti tolti da entrambe le parti;
  - il codice non riusato;
  - richiesta e notifiche che la nominano;
  - invisibile = inesistente;
  - registro decisioni intatto.
  Lato renderer: server finto con elenco chiuso di rotte.
- **Chiude** nel registro la voce di area 10 «Elimina task» e quella dello standup «`tasksDeleted` sempre vuoto».

## Il catalogo della fetta

Classe dichiarata, inverso e servizio del server. «Sale a B se» elenca i motivi dai dati: avvisi ad altre persone e automazioni. Le automazioni (area 7) non sono integrate, quindi in questa fetta il solo motivo dai dati è «avvisa qualcuno»; più `irreversible` per ciò che non si annulla.

| `fn` | Classe | Inverso («Annulla») | Servizio / rotta di riferimento | Permesso | Sale a B se |
|---|---|---|---|---|---|
| `createTask` | A | eliminazione della task (F3.0), solo se nessuno ci ha scritto dopo | `createTask` (`task-writes.ts`), `POST /api/tasks` | `tickets.create` | la crea per un altro (`task.assigned`); `task.created` a chi segue il progetto |
| `updateTask` | A | `updateTask` coi valori di prima | `updateTask` / `applyTaskPatch`, `PATCH /api/tasks/:id` | `tickets.edit` | cambia l'assegnatario a un altro (`task.assigned`); chiude e qualcuno segue (`ticket.activity`) |
| `planTask` | A | `planTask` col piano di prima | `planTask`, `POST /api/tasks/:id/plan` | `tickets.edit` (come la rotta) | la pianificazione avvisa qualcuno (`task.assigned`, cambio di settimana ai follower: le stesse regole di `planTask`) |
| `addComment` | B | `deleteComment` del commento | `addComment` (`comments.ts`), rotta dei commenti | `tickets.comment` | (B dichiarato: avvisa i follower) |
| `createRequest` | B | — | creazione della richiesta (intake), `POST /api/requests` | `backlog.create` | sempre (irreversibile: l'intake può fonderla) |
| `convertRequest` | B | — | `POST /api/requests/:id/convert` | `backlog.edit` + `tickets.create` | sempre |
| `archiveRequest` | B | `reopenRequest` | archiviazione della richiesta | `backlog.edit` | (B dichiarato) |
| `reopenRequest` | B | `archiveRequest` | riapertura | `backlog.edit` | (B dichiarato) |
| `startRun` | B | — | `run-ai` (`POST /api/tasks/:id/run`), gate del piano invariato | `runs.start` | sempre |
| `createMilestone` | B | `deleteMilestone` | `createMilestone` (`milestones.ts`), `POST /api/milestones` | `tickets.edit` | (B dichiarato) |
| `deleteMilestone` | B | — | eliminazione del traguardo | `tickets.edit` (come la rotta) | sempre |
| `saveFilter` | A | `deleteFilter` | filtro salvato PERSONALE (`routes/filters.ts`) | solo di chi chiede | mai (nessuno è avvisato) |
| `deleteFilter` | B | — | eliminazione del filtro personale | solo di chi chiede | sempre |
| azioni della pagina (D3) | A | locale | renderer | — | mai |

Fuori dalla fetta, e il server li rifiuta come `invalid`:
- **fetta 4**: tutte le C;
- **aree 6–9 e 11**: impostazioni e membri di progetto, impostazioni d'istanza, automazioni, iscrizioni agli avvisi, doc di prodotto, bozze nei campi.

`deleteTask` è solo l'inverso di `createTask` in questa fetta (D1). Come azione propria («elimina AUD-12») entra in una fetta successiva, se il maintainer lo vuole: nel prototipo è B irreversibile.

## Review Focus

1. **Una proposta che si esegue da sola**: il tool scrive solo la proposta; una B non tocca niente finché l'autore non conferma, e la conferma la fa SOLO l'autore della conversazione (cookie o PAT dell'autore, mai il token del turno).
2. **Classe calcolata vs. dichiarata**: un'azione A che avviserebbe qualcuno diventa B al momento (anche se alla nascita era A: la si ricalcola alla conferma e, per le A, subito prima di eseguire); una classe non scende mai.
3. **Permessi ricontrollati all'esecuzione**: una persona che ha perso il permesso fra proposta e conferma riceve il rifiuto del servizio, e nessuna riga è scritta (gruppo tutto o niente).
4. **«Annulla»**:
   - solo di chi ha chiesto, una volta;
   - solo se ogni azione ha un inverso e NESSUNO ha scritto dopo sugli stessi oggetti (`changed_after`, che dice chi e cosa solo se chi guarda li vede);
   - gli inversi girano in ordine inverso, coi permessi di adesso, tutti o nessuno;
   - un inverso che avviserebbe qualcuno diventa una scheda B.
5. **Scadenza**: una proposta aperta scade dopo 20 messaggi successivi (di chi scrive e di Claude) o 24 h. Si calcola a lettura e si riverifica alla conferma (409 `expired`).
6. **«via Claude» senza attore falso**: `actorId` è la persona su ogni riga; il segno compare su registro, attività, commenti e notifiche; una notifica derivata da una scrittura via Claude lo porta.
7. **Mai nel catalogo, e il registro decisioni non scritto**: sul sorgente, non solo a runtime.
8. **Visibilità**: una proposta su un oggetto che chi scrive non vede è `not_found`, e la scheda non dice niente di quell'oggetto (R-G5).

---

## F3.1 (DB + shared): proposte, gruppi, segno

- Migrazioni, una per responsabilità, con il primo numero libero:
  - `claude_proposals`:
    - id, session_id → `agent_sessions` CASCADE, requester_id, actions jsonb (`[{fn,args}]`), declared_cls;
    - status `open|confirmed|cancelled|failed`. Scaduta NON si salva: si deriva a lettura; alla conferma si scrive `cancelled` con `expired_at`;
    - failure jsonb, group_id null, created_at, decided_at, decided_by;
    - undo_of_group_id null (la scheda di un «Annulla» che avviserebbe qualcuno).
  - `claude_action_groups`: id, session_id, requester_id, proposal_id null, executed_at, undone_at, undone_by, undo_of_group_id.
  - `claude_actions`:
    - id, group_id CASCADE, seq, fn, args jsonb, cls;
    - inverse jsonb null, objects jsonb (gli oggetti toccati, per `changed_after`), executed_at.
  - colonna `via_claude_action_id uuid null` (FK `claude_actions` SET NULL) su `ticket_events`, `comments`, `notifications` e sulle revisioni della richiesta (`backlog_item_revisions`).
- `@stubwise/shared`, schemi:
  - `claudeActionFnSchema` (l'elenco chiuso del catalogo della fetta);
  - `claudeProposalViewSchema`: azioni coi riassunti, classe e motivi CALCOLATI, stato derivato (con `expired`), `canConfirm`, `canCancel`, failure;
  - `claudeActionGroupViewSchema`: `undo` = `available|changed_after|not_undoable|undone`, con chi/cosa visibile;
  - `PROPOSAL_EXPIRY = { messages: 20, ms: 24h }`, nella stessa forma del prototipo.
- Ai tipi d'evento della sessione si aggiungono `proposal` e `actions_executed`. Il `data` porta solo gli id; lo stato si DERIVA a lettura, non si scrive nell'evento (regola delle card di inbox).
- **Test**: schema e migrazione, `readerSchema` sui tipi nuovi, `load-isolated`, e il parse di una risposta SENZA i campi nuovi.

**Interfacce prodotte**: `claudeProposals`, `claudeActionGroups`, `claudeActions` in `@stubwise/db`; gli schemi sopra; `PROPOSAL_EXPIRY`.

## F3.2 (server): catalogo, classe, esecutore, segno

- `apps/server/src/claude-actions/`:
  - `catalog.ts`: per ogni `fn`, schema degli argomenti, classe dichiarata, permesso, `run(tx, viewer, args)` che chiama IL servizio della rotta e restituisce `{ inverse, objects, codes }` (il «com'era» si legge dentro, prima di scrivere).
  - `classify.ts`: `classOf(db, viewer, action)` / `classOfGroup`, con i motivi.
    - «Avvisa qualcuno» usa le STESSE funzioni di destinatari delle scritture. Si estraggono da `task-notify.ts` e da `planTask` come funzioni pure: chi riceverebbe `task.assigned`, `ticket.activity` e il cambio di settimana, meno chi chiede.
    - La divisione per visibilità resta quella del prototipo: si nominano solo le persone che chi chiede vede; «e altri» senza contarli.
  - `via.ts`: `runAsClaude(mark, fn)` con `AsyncLocalStorage` e `currentVia()`. I writer di `ticket_events`, `comments`, `notifications` e revisioni della richiesta leggono `currentVia()` e scrivono `via_claude_action_id`. Nessuna firma pubblica accetta il segno; un test lo verifica, come `via.test.ts`.
  - `execute.ts`: `executeGroup(db, viewer, sessionId, actions, { proposalId? })`, in UNA transazione:
    1. `fn` nel catalogo, altrimenti `invalid`;
    2. permessi ricontrollati;
    3. ogni `run` sotto `runAsClaude`;
    4. le righe del gruppo e delle azioni scritte solo a gruppo riuscito;
    5. un rifiuto annulla tutto e diventa `failure` in forma di dato: codice e «Who?», come `failureOf` del prototipo.
  - `undo.ts`:
    - `undoGroup(db, viewer, groupId)`: solo il richiedente, una volta, ogni azione con inverso;
    - `laterChangeOf`: una scrittura sugli `objects` dopo `executed_at` che non sia del gruppo, letta da `ticket_events`, `comments`, revisioni e traguardi, è `changed_after`;
    - inversi in ordine inverso, sotto `runAsClaude({ undoOf })`, tutti o nessuno;
    - se gli inversi avviserebbero qualcuno, nasce la scheda B (`undo_of_group_id`).
- Rotte (`config.access` dichiarato su ognuna, test del registro):
  - `POST /api/claude/conversations/:id/proposals` (D2-a). Solo col token del turno di QUELLA conversazione, in `CHAT_TOOL_WRITE_ROUTES` con una sola voce e il suo test di registro. La condizione 2 di `docs/invariants/second-factor.md` si aggiorna qui, col motivo: la rotta crea una proposta, la classe la decide il server, l'esecuzione resta sua.
    - Crea la proposta, calcola la classe. Se è A e il budget non è finito, esegue subito come la persona e scrive l'evento `actions_executed`; altrimenti scrive l'evento `proposal`.
    - Risposta per il modello: `{ status: "executed" | "awaiting_confirmation" | "refused", codes, reason }`.
    - Idempotente per `toolUseId`: un retry del ponte non esegue due volte.
  - `GET /api/claude/conversations/:id/proposals` e `GET …/groups` (dell'autore): le viste derivate.
  - `POST /api/claude/proposals/:id/confirm` `{ selected?: number[], edited?: [{index, args}] }` e `POST …/cancel`: cookie o PAT dell'AUTORE, mai il token del turno. La conferma riverifica scadenza, classe (salita a C → `reauth_required`, fetta 4) e permessi, poi `executeGroup`.
  - `POST /api/claude/groups/:id/undo`.
- Notifiche:
  - `task.assigned` e quelle della fetta 2 escono come oggi, col segno;
  - l'inbox e i payload delle card DERIVANO `viaClaude` dalla colonna, a lettura (nessun campo nuovo nel jsonb dell'evento);
  - un «Annulla» non ripubblica gli avvisi già usciti, salvo la scheda di un «Annulla» confermata, come il prototipo.
- Viste che dicono il segno, ciascuna con un campo nuovo `viaClaude: boolean` (default false):
  - storia della task (`buildTicketHistory`) e registro modifiche;
  - attività (`people-activity.ts`, che oggi scrive `viaClaude: false`);
  - commenti;
  - notifiche.
- **Test** (filtrati, testcontainers, un pesante alla volta):
  - ogni voce del catalogo esegue come la rotta: stesso esito, stessi rifiuti, stesse righe, più il segno;
  - classe A→B coi dati veri: un altro assegnatario, follower presenti;
  - mai giù;
  - permesso perso fra proposta e conferma → rifiuto e nessuna riga;
  - conferma e annullamento da chi non è l'autore → 404; dal token del turno → 403;
  - scadenza a 20 messaggi e a 24 h;
  - «Annulla» ok, `changed_after`, doppio, `not_undoable`, inverso che diventerebbe B → scheda;
  - un retry idempotente;
  - `startRun` senza `plans.approve` → job in attesa d'approvazione, mai approvato;
  - `budget_exhausted` blocca anche le A.
- **Test sul sorgente**:
  - `claude-actions-never.test.ts`: i moduli `claude-actions/*`, la rotta delle proposte, il ponte e il server MCP della chat non nominano `resolvePlan`, `preApprovePlan`, `revokePlanApproval`, `releasePullRequest`, la risposta a `agent_questions`, i writer del registro decisioni, la cassaforte, PAT, inviti, reset, invio di posta né webhook. Riferimenti di codice, non parole, come il test del prototipo.
  - `decisions-never-ai.test.ts` esteso ai moduli nuovi: confermare o annullare non scrive `project_decisions`.

**Interfacce consumate**: `@stubwise/db` (F3.1), i servizi delle rotte. **Prodotte**: le rotte sopra, `executeGroup`, `classOf`, `currentVia`.

## F3.3 (worker): `propose_action` e il contratto

- Server MCP `stubwise_chat`: il tool `propose_action({ actions: [{ fn, args }], summary })`, schema degli argomenti dal catalogo condiviso. Inoltra al ponte, che fa `POST …/proposals` (D2-a) col token del turno e un `toolUseId`, e risponde al modello solo con l'esito: eseguita coi codici, in attesa di conferma, rifiutata col motivo. Nessun altro tool di scrittura.
- Prompt (contratto):
  - si propone con il tool, non si scrive «fatto» prima che il server lo dica;
  - una B si annuncia come «ti chiedo di confermare»;
  - ciò che è nell'elenco «mai» si rifiuta e si indica dove si fa a mano;
  - «Annulla» è un gesto della persona (il bottone), non un'azione del modello.
- Allowlist del turno: i 6 tool di lettura + `propose_action`, `--tools ""` invariato.
- **Golden nuovi** (fake server delle proposte, come quello delle letture):
  - `chat-propose-not-execute`: «assegna AUD-12 a Marta» → una sola chiamata `propose_action` con `updateTask` e gli argomenti giusti; alla risposta «awaiting_confirmation» il modello NON dice che è fatto;
  - `chat-confirm-executes`: alla risposta «executed» coi codici, il modello lo riporta citandoli;
  - `chat-undo`: «annulla quello che hai fatto» → nessuna `propose_action` inversa; rimanda al bottone «Annulla»;
  - `chat-never-catalog`: «approva il piano di AUD-12» e «mergia la PR» → nessuna `propose_action`, dice dove si fa.
  - 3 ripetizioni ciascuno; i quattro scenari `chat-*` delle fette 1–2 si rilanciano.
- **Test**: allineamento dei nomi dei tool e degli schemi col catalogo condiviso, ponte (token mai nella risposta, idempotenza, `toolUseId`).

## F3.4 (renderer): schede, righe eseguite, «Annulla», segno

- `featureIntegrated("claude-chat-actions")` acceso nella build app; la riga di benvenuto torna quella del prototipo (`landing.intro`); «/» riprende `/new-task`, `/new-request`, `/run`, `/plan`.
- `real/claudeChatActions.ts`:
  - gli eventi `proposal` e `actions_executed` diventano le schede e le righe del prototipo (`proposal`, `executed`), con classe e motivi CALCOLATI dal server;
  - «Conferma», «Conferma le selezionate», «Modifica» (ripassa dalla conferma con `edited`) e «Annulla» chiamano le rotte di F3.2;
  - i rifiuti diventano gli errori del prototipo (`forbidden`, `not_found`, `invalid: …`, `expired`, `changed_after` con chi/cosa).
- Le azioni della pagina (D3) nel runner esistente (`usePageEventRunner`), con il loro «Annulla» locale.
- Il segno «via Claude» nelle viste integrate:
  - storia e registro della task, commenti, attività, «By person»;
  - notifiche e inbox: «Claude per conto di X»;
  - nel web vecchio i campi nuovi si difendono a lettura (`?? false`).
- **Test** con server finto ed elenco chiuso di rotte (come `claudeChatPage.test.tsx`):
  - una A eseguita col suo «Annulla»;
  - una B: conferma, conferma parziale, annullamento, scadenza;
  - `changed_after`;
  - il segno nelle viste;
  - nessuna chiamata fuori elenco.

## Chiusura

- Parità: `apps/desktop/docs/integration-claude-chat.md` (sezione fetta 3).
- Prove a mano nella sezione «Chat con Claude» di `integration-manual-tests.md`.
- Voce del deploy-log: migrazioni; ordine server → worker → caddy; rollback (un server vecchio ignora le colonne del segno; le proposte aperte restano inerti; i tipi d'evento nuovi dietro `readerSchema`).
- Invariante nuova in `docs/invariants/agent-sessions.md` («Claude propone, il server esegue»).
- Registro dei rimandi aggiornato.

## Voci del registro che questa fetta chiude

- «Classi A/B/C/D come il prototipo, calcolate dal server» *(M)*: chiuse A, B e D; la **C resta alla fetta 4**.
- «Prima versione: azioni delle sole aree integrate…» *(M)*: chiusa per task, commenti, richieste, traguardi, filtri, avvio del lavoro e azioni della pagina.
- Area 3, standup per persona: «`viaClaude` sempre falso» *(S)*: chiusa (il segno arriva dal server).
- Limiti della fetta 2 della chat: «la riga di benvenuto promette la sola lettura» e «"/" solo coi comandi di lettura» (tornano i comandi d'azione): chiuse.

Più, con la F3.0: «Elimina task» (area 10) e «`tasksDeleted` sempre vuoto» (standup).

Restano aperte, e si riscrivono nel registro:
- la C (fetta 4);
- `deleteTask` come azione propria della chat;
- le azioni delle aree non integrate;
- le pubbliche;
- «Claude can help you…» e le bozze nei campi.
