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
9. **Il token del turno resta GET-only**, salvo la decisione **D2** qui sotto. Nessuna scrittura parte da un token del turno senza passare dalla regola della classe.
10. **Verso i client, solo cambi additivi** (`CLAUDE.md`): campi nuovi con default, kind e tipi d'evento nuovi dietro `readerSchema`; nel web vecchio i campi nuovi si difendono a lettura.
11. **Golden obbligatori** (si toccano prompt, tool MCP e runner) sul CLI pinnato 2.1.322, coordinati con stubwise-94; uno scenario rosso NON si aggiusta forzando il prompt: si porta all'orchestratrice.

## Decisioni da prendere prima di partire

- **D1 — «Annulla» di `createTask`.** Nel prototipo creare una task è A con «Annulla» = elimina. Sul server non c'è l'eliminazione delle task («Elimina task» entra con l'area che la definisce, design). Proposta: in questa fetta `createTask` è **B, irreversibile** (motivo `irreversible` nella scheda), finché l'eliminazione non esiste. Alternativa: un inverso ristretto («annulla la creazione» solo per una task nata da QUEL gruppo e mai toccata da altri), che però è un'eliminazione dalla porta di servizio. **Consiglio la prima.**
- **D2 — Come la proposta arriva al server.** (a) Il ponte del worker chiama `POST /api/claude/conversations/:id/proposals` col token del turno. È UNA rotta in un'allowlist di scrittura a sé (`CHAT_TOOL_WRITE_ROUTES`, una voce, col suo test di registro), che crea la proposta, calcola la classe e, se è A, la esegue subito come la persona. Cambia la condizione 2 del token («solo GET»), sul solo punto di creare una proposta. (b) Il ponte scrive la riga in DB (il worker ha il DB, come il ponte del refinement) e fa NOTIFY; il server ascolta, classifica ed esegue le A. Il token resta GET-only, ma l'esecuzione delle A diventa asincrona e c'è un secondo produttore di righe. **Consiglio (a)**: un solo produttore, esecuzione e classe nello stesso posto, il token resta incapace di scrivere fuori da quella rotta.
- **D3 — Le azioni della pagina** (filtro, lingua, tema): sono gesti del client, non scritture del server. Proposta: proposte di classe A con «Annulla» locale, eseguite dal renderer (`pageActions.ts`), registrate come evento della conversazione; il server le valida (elenco chiuso) e non esegue niente.

## Il catalogo della fetta

Classe dichiarata, inverso e servizio del server. «Sale a B se» elenca i motivi dai dati: avvisi ad altre persone e automazioni. Le automazioni (area 7) non sono integrate, quindi in questa fetta il solo motivo dai dati è «avvisa qualcuno»; più `irreversible` per ciò che non si annulla.

| `fn` | Classe | Inverso («Annulla») | Servizio / rotta di riferimento | Permesso | Sale a B se |
|---|---|---|---|---|---|
| `createTask` | B (D1) | — | `createTask` (`task-writes.ts`), `POST /api/tasks` | `tickets.create` | sempre (irreversibile) |
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
- **aree 6–9 e 11**: `deleteTask`, impostazioni e membri di progetto, impostazioni d'istanza, automazioni, iscrizioni agli avvisi, doc di prodotto, bozze nei campi.

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
  - `POST /api/claude/conversations/:id/proposals` (D2-a). Solo col token del turno di QUELLA conversazione, in `CHAT_TOOL_WRITE_ROUTES` con una sola voce e il suo test di registro.
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

Restano aperte, e si riscrivono nel registro:
- la C (fetta 4);
- `createTask` irreversibile (D1) finché non c'è l'eliminazione;
- le azioni delle aree non integrate;
- le pubbliche;
- «Claude can help you…» e le bozze nei campi.
