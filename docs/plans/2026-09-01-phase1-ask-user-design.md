---
title: Fase 1 — Pianificazione interattiva (`ask_user`)
date: 2026-09-01
status: validato (brainstorming)
program: 2026-08-31-stubwise-nerve-center-program-design.md
stubwise:
  project: stubwise
  backlogItem: 6947dc02-930c-44a1-b270-db5670b28a6e # https://stubwise.thecove.it/backlog/6947dc02-930c-44a1-b270-db5670b28a6e
  ticket: 6 # https://stubwise.thecove.it/tickets/2acabf72-9ec3-4689-8180-2eda195bcd7a
---

# Fase 1 — Pianificazione interattiva (`ask_user`)

Seconda fase del programma "centro nevralgico". L'agente che pianifica un fix
può fare una domanda strutturata a un umano, il job si parcheggia in
`awaiting_input`, la domanda arriva come notifica azionabile con bottoni
dinamici (inbox web + DM Slack + pagina ticket), la risposta riprende la
sessione CLI. Riusa per intero le fondamenta della fase 0 (inbox, outbox,
propagazione, Slack interattivo).

## 1. Stato di partenza (fatti verificati)

- **Runner**: `AgentRunner.run` (`apps/worker/src/agent/runner.ts:21-68`)
  supporta già `resumeSessionId` → `--resume` (`claude-cli.ts:287-289`) ed
  estrae `sessionId` dal JSON di output (`claude-cli.ts:245`, anche su exit≠0
  :343-349, NON su timeout). Nessun campo per config MCP: i run del worker non
  passano alcun `--mcp-config` (zero occorrenze in agent/pipeline/backlog).
- **Env del child CLI**: allowlist `ANTHROPIC_*`/`CLAUDE_*`/`PATH`/… con
  denylist assoluta `DATABASE_URL`/`ENCRYPTION_KEY`/`SESSION_SECRET`
  (`claude-cli.ts:61-93`) → un MCP locale al run NON può parlare col DB.
- **Sessioni CLI legate alla cwd**: la chat backlog tiene i worktree in un
  registro in-memoria (`backlog/code-session.ts:31-95`) e al riavvio del worker
  RI-PRIMA la sessione (nuovo worktree, `cliSessionId` riscritto, mai `--resume`
  su registro perso — docblock :20-23). Le sessioni CLI vivono nel volume
  `claude-config` (`CLAUDE_CONFIG_DIR`).
- **Fix**: worktree per-progetto in parent `mkdtemp(/tmp/stubwise-proj-)`
  distrutti in `finally` (`git/mirrors.ts:505-542`); `parkForPlanApproval`
  avviene DOPO la distruzione (`fix.ts:1266-1300`); la ripresa post-approvazione
  riapre worktree freschi dal mirror. `resolveFixMode` (`fix.ts:339-357`):
  `execute-only` → `plan-only` (planApprovalRequired) → soglia → `full`.
  Heartbeat 60s dentro la callback (`fix.ts:791-797`). Prompt di pianificazione
  `buildFixPlanPrompt` (`prompts.ts:460-489`) con sezioni "Procedure" e "Rules".
- **Staleness**: `requeueStale` sorveglia solo `ACTIVE_STATUSES =
  ["triaging","fixing"]` (`queue.ts:59,305-322`); il claim filtra hardcoded
  `status='queued'` (`queue.ts:92-107`) → un nuovo stato d'attesa è escluso per
  costruzione da entrambi.
- **Enum**: `ai_job_status` è lista letterale in `schema.ts:142-161`;
  precedente `ALTER TYPE ADD VALUE` nella migrazione 0012. `resume_mode` =
  `["fix","execute"]` (:175).
- **Notifiche**: aggiungere un kind tocca ~23 punti censiti (3 liste + parità a
  tre vie `apps/server/src/notification-kinds.test.ts`; Record esaustivi:
  `EMOJI`, `KEY_FOR_KIND`, `formatGeneric`, `TOGGLE_FOR_KIND`,
  `AUDIENCE_FOR_KIND`, `DECISION_FOR_KIND`, `openUrl`, `INBOX_KIND_LABEL_KEYS`,
  `LABEL_KEY` slack-blocks, `NOTE_KEY` propagation; + sampleEvents, i18n,
  settings toggle in 6 punti, EVENT_TOGGLES/SAMPLE_LABELS web).
- **Routing**: `AUDIENCE_FOR_KIND` ha solo `admins | broadcast`
  (`routing.ts:42-57`); `requestedBy` risolto solo nel ramo broadcast e solo
  con `opts.jobId` (`publish.ts:170-177`).
- **Azioni**: catalogo statico calcolato (`actions.ts`), `actionsFor({kind},
  jobStatus, actor)`; validazione azioni in `inboxActionSchema` (shared), lista
  gemella in `slack/inbox-actions.ts:54-61`; il precedente "testo libero" è il
  reject (textarea web inline + modal Slack con `private_metadata`).
- **Propagazione (fase 0)**: `services/notifications-propagation.ts`
  (`propagateDecision` = propagateHandled + mirror Slack), chiamata DENTRO i
  servizi così tutte le superfici convergono.
- Ultima migrazione: 0063.

## 2. Scopo v1

**Solo la pianificazione del fix**: run `plan-only` e fase plan del flusso a
due fasi. Esclusi (deliberatamente, v2+): la fase *execute* (una domanda a metà
esecuzione richiederebbe worktree vivi con modifiche non committate), il *deep
dive* del backlog e la *chat* (hanno già l'umano nel loop / coda diversa;
riuseranno questa meccanica).

## 3. Il tool `ask_user` (MCP locale al run, bridge su file)

- Nuovo pacchetto/binario **server MCP stdio bundlato nell'immagine del
  worker** (`apps/worker/src/ask-user-mcp/` compilato nel dist, o script
  dedicato): UN tool `ask_user` con schema zod stretto:
  `{ question: string, options: 2..4 × { label, consequence? },
  recommendedIndex?, allowFreeText = true }`.
- Il worker abilita l'MCP SOLO nei run di pianificazione: il runner guadagna
  un'opzione `mcpConfig?` che genera `--mcp-config` (file temporaneo o JSON
  inline) + il tool nell'`allowedTools` (`mcp__stubwise_ask__ask_user`).
- **Bridge su file** (il child non ha accesso al DB, by design): il worker
  passa al server MCP (via env `ASK_USER_FILE` nella config MCP) un path nella
  parent dir del run; il tool valida, scrive il JSON `{question, options,
  recommendedIndex, allowFreeText}` e risponde al modello **"Domanda
  registrata: termina il turno ora, senza produrre il piano"**. Passa anche
  `ASK_USER_ROUND`/`ASK_USER_MAX_ROUNDS`: oltre il tetto il tool NON scrive e
  risponde "tetto raggiunto: scegli l'opzione più ragionevole e documentala in
  Decisioni e assunzioni".
- Al ritorno del run il worker legge il file (rivalidato con zod: mai fidarsi
  del contenuto) — se presente → parcheggio; se il run ha prodotto sia file sia
  piano, vince il file (log di warning).
- **Prompt** (`buildFixPlanPrompt`): regola d'ingaggio — scelte reversibili o
  minori da solo, elencate nella sezione obbligatoria **"Decisioni e
  assunzioni"** del piano; `ask_user` solo per bivi che producono lavori
  materialmente diversi; menzione del tetto round.

## 4. Stato, persistenza, ripresa

- **Migrazione 0064**: `ALTER TYPE ai_job_status ADD VALUE 'awaiting_input'`;
  `ALTER TYPE resume_mode ADD VALUE 'plan_continue'`; colonna
  `ai_jobs.cli_session_id text`; tabella **`agent_questions`**:
  `id, job_id FK ai_jobs (cascade), ticket_id FK tickets (cascade),
  round int, question text, options jsonb, recommended_index int?,
  allow_free_text bool, asked_at, answer jsonb?, answered_at?,
  answered_by_user_id FK users (set null)`; indice unico parziale
  `(job_id) WHERE answered_at IS NULL` (una domanda aperta per job); indice
  `(ticket_id, asked_at)` per la timeline. Trappola enum rispettata: gli
  `ADD VALUE` non vengono usati da migrazioni dello stesso batch.
- **Parcheggio**: `parkForInput(db, jobId, { questionId, cliSessionId, log })`
  gemello di `parkForPlanApproval` (status-guarded su ACTIVE_STATUSES, niente
  `finishedAt`, salva `cli_session_id`). Nel `runFix` la callback dei worktree
  ritorna `{kind:"question", payload}`; il parcheggio + insert
  `agent_questions` + notifica avvengono FUORI dalla callback (worktree già
  distrutti), in transazione dove possibile.
- **Ripresa (decisione A del brainstorming): `--resume` con directory
  deterministica + fallback.** La parent dir dei run di pianificazione diventa
  deterministica (`/tmp/stubwise-plan-<jobId>`, variante di
  `withProjectWorktrees` con dir fissa). Alla risposta: job `queued` con
  `resume_mode='plan_continue'`; il handler salta il triage; `resolveFixMode`
  ritorna la fase plan in modalità *continue*: ricrea i worktree nello stesso
  path e lancia con `--resume <cliSessionId>` e prompt = la risposta ("Risposta
  a: <domanda> → <opzione scelta / testo>. Continua la pianificazione; se hai
  altre domande materiali usa ask_user, altrimenti produci il piano.").
  Le sessioni CLI stanno nel volume `claude-config` → la ripresa sopravvive al
  riavvio del worker. **Fallback** (cliSessionId null, `--resume` fallito,
  timeout precedente senza sessionId): run di pianificazione da zero con blocco
  "Decisioni già prese" costruito da `agent_questions` (Q → risposta, in
  ordine). `plan_continue` passa PRIMA del gate `planApprovalRequired` in
  `resolveFixMode` (come `execute-only`: si sta continuando, non ricominciando).
- **Timeout**: resta in attesa (nessuna scadenza in v1; il pulse della fase 2
  ricorderà le domande aperte). `awaiting_input` non è claimabile né soggetto a
  `requeueStale` per costruzione.

## 5. Notifica, routing, azione `answer`

- **Kind `job.awaiting_input`** nelle tre liste + tutti i Record censiti in §1.
  Payload evento: `ticketNumber, ticketTitle, projectName, ticketUrl` + la
  domanda intera (`questionId, round, question, options, recommendedIndex,
  allowFreeText`) — l'evento è autosufficiente per il rendering. Toggle
  webhook nuovo `notifyAwaitingInput` (colonna + 6 punti settings + UI).
- **Audience nuova `"requester"`** in `AUDIENCE_FOR_KIND`: destinatari =
  `requestedBy ∪ admins` (non i follower: è una decisione). In
  `resolveRoutingContext` il ramo requester risolve `requestedBy` dal `jobId`
  anche fuori dal broadcast; `requested_by_user_id` null (run
  dell'automazione) → solo admin.
- **Azione `answer`** nell'`ActionId` (una sola azione con payload). Catalogo
  per `job.awaiting_input`: `["answer","open","snooze"]` — **niente `handled`
  manuale** (una domanda si chiude solo rispondendo; archiviarla lascerebbe il
  job parcheggiato in silenzio); snooze personale come sempre. `stateAllows`:
  `answer` solo con job `awaiting_input`. **Chi risponde: richiedente o
  admin** (`roleAllows` esteso: usa anche l'identità dell'actor rispetto a
  `requestedByUserId` della notifica/job, non solo il ruolo).
- **`answerQuestion` nel servizio** (`services/jobs.ts` o modulo dedicato):
  valida contro la domanda persistita (indice nel range; testo solo se
  `allowFreeText`; max 4000), UPDATE condizionato su `answered_at IS NULL`
  (una risposta vince le corse), scrive `answer/answered_at/answered_by`,
  job → `queued` + `resume_mode='plan_continue'` (UPDATE guarded su
  `awaiting_input`), poi **propagazione nel servizio** (lezione fase 0):
  copie → `handled`, DM altrui riscritti "💬 Risposta di X: <label>".
  Errori tipizzati: `question_not_pending`, `invalid_answer`,
  `already_handled` (con chi ha risposto), `forbidden`.

## 6. Superfici

- **Contratto**: `InboxItem.question?: { questionId, round, options:
  [{label, consequence?}], recommendedIndex?, allowFreeText }` calcolato
  server-side nel recinto per-item (payload marcio → card degradata, mai 500);
  schema in `packages/shared`. Rotta `POST /api/inbox/:id/actions/answer`,
  body `{ optionIndex?: number } | { text?: string (max 4000) }` (esattamente
  uno).
- **Card inbox**: domanda + opzioni come bottoni verticali (raccomandata
  marcata bordo ambra + "consigliata", MAI preselezionata; conseguenza in
  `fg-muted` sotto ogni opzione) + "Altro…" con textarea inline (pattern
  reject). **Conferma esplicita** (selezione → "Invia risposta"): un tap
  accidentale su mobile non decide. Niente ottimismo.
- **Slack**: sezione con domanda e conseguenze, un bottone per opzione
  (`action_id="inbox:answer:<index>"`, `block_id` carrier del notificationId,
  ⭐ sulla raccomandata) + "Altro…" → modal con textarea (riuso pattern
  reject: `private_metadata`, `view_submission`, errori in-modal). Click
  esegue subito (il 409 "già risposto da X" protegge le corse).
- **Pagina ticket**: blocco domanda (stesso componente della card, estratto)
  quando l'ultimo job è `awaiting_input`, per richiedente e admin; per gli
  altri "In attesa di una risposta di …". Risposta dalla pagina ticket →
  stesso `answerQuestion` (propagazione inclusa). Q&A passate leggibili
  (esposte da una rotta: dettaglio nel piano). Timeline: `awaiting_input` in
  `JOB_STATUS_WITH_NOTE` + etichette `jobStatus.labels/notes`; polling: il
  nuovo stato entra in `WAITING_JOB_STATUSES` (20 s).
- **MCP/skill**: il testo di `run_ticket` e la skill `stubwise` menzionano il
  nuovo esito ("il run può fermarsi con una domanda: rispondi dall'inbox o dal
  ticket").

## 7. Coerenza stati (censimento da toccare)

`IN_FLIGHT_JOB_STATUSES` (+`awaiting_input`), `WAITING_JOB_STATUSES` SPA,
`Record` timeline/activity-feed (rompono la compilazione), `AIJobStatus` in
`apps/web/src/lib/api.ts`, etichette i18n `jobStatus.*`, messaggi del tool MCP
`run_ticket`, `RELAUNCHABLE_STATUSES` (NON include `awaiting_input`),
`resolveFixMode` (ramo `plan_continue`), guida docs. `ACTIVE_STATUSES` e il
claim NON cambiano.

## 8. Config e guardrail

- `AGENT_QUESTION_MAX_ROUNDS` (env, default 5): unico parametro nuovo.
- Una domanda aperta per job (indice unico parziale); risposta unica (UPDATE
  condizionato); il file-bridge è rivalidato dal worker; la risposta umana è
  contenuto FIDATO nel prompt del turno (come il piano approvato).
- Heartbeat: il run di pianificazione continua a girare dentro la callback dei
  worktree con l'heartbeat esistente; l'attesa non ne ha bisogno
  (`awaiting_input` fuori da ACTIVE_STATUSES).

## 9. Test

- MCP `ask_user`: schema, tetto round, scrittura file, risposta al modello.
- Runner: `--mcp-config` nell'argv, allowedTools.
- Worker: park (file presente → awaiting_input + agent_questions + notifica),
  ripresa con `--resume` (dir deterministica), fallback re-prime (sessione
  persa / riavvio), file+piano insieme → vince il file, tetto round.
- Servizio `answerQuestion`: validazioni, corse (Promise.all), propagazione,
  permessi (richiedente sì, altro member no, admin sì).
- Kind nuovo: parità a tre vie + Record; routing `requester` (con e senza
  requestedBy).
- Web: card domanda (opzioni/consigliata/Altro/conferma), pagina ticket,
  polling. Slack: bottoni answer, modal Altro, già-risposto.
- E2E manuale: domanda → risposta dall'inbox → piano → approvazione.

## 10. Deploy e rollback

- Rebuild **server + worker + caddy** insieme (migrazione 0064 all'avvio del
  server). Nessun passo Slack manuale (scope già presenti). Env opzionale
  `AGENT_QUESTION_MAX_ROUNDS`. Rollback: additivo; i job eventualmente
  parcheggiati in `awaiting_input` su un'immagine vecchia resterebbero fermi
  (nessun consumatore) → rilanciarli con run-ai.

## 11. Fuori scopo (v2+)

`ask_user` in execute/deep dive/chat; timeout "procedi con la raccomandata";
domande multiple contemporanee; `list_proposals` MCP (fase 2); push mobile.
