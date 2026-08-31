---
title: Fase 1 — Pianificazione interattiva — Piano di implementazione
date: 2026-09-01
design: 2026-09-01-phase1-ask-user-design.md
stubwise:
  project: stubwise
  backlogItem: 6947dc02-930c-44a1-b270-db5670b28a6e # https://stubwise.thecove.it/backlog/6947dc02-930c-44a1-b270-db5670b28a6e
  ticket: 6 # https://stubwise.thecove.it/tickets/2acabf72-9ec3-4689-8180-2eda195bcd7a
---

# Fase 1 — Pianificazione interattiva — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** L'agente di pianificazione del fix può fare una domanda strutturata (`ask_user` via MCP locale al run), il job si parcheggia in `awaiting_input`, la domanda arriva come notifica azionabile con opzioni dinamiche (inbox, DM Slack, pagina ticket), la risposta riprende la sessione CLI con `--resume` (fallback: ri-pianificazione con storia Q&A).

**Architecture:** Il worker abilita nei soli run di pianificazione un server MCP stdio bundlato che scrive la domanda su file (il child CLI non ha accesso al DB); al ritorno del run il worker parcheggia (`parkForInput`), persiste in `agent_questions`, pubblica il kind nuovo `job.awaiting_input` (audience `requester`). La risposta passa dal servizio `answerQuestion` (validazione + propagazione, tutte le superfici convergono) e rimette il job `queued` con `resume_mode='plan_continue'`; la fase plan riprende con `--resume` su directory deterministica. Design completo: `docs/plans/2026-09-01-phase1-ask-user-design.md` (**LEGGILO PRIMA**: §1 ha i file:linea di partenza, §3-§6 le decisioni).

**Tech Stack:** come fase 0 + `--mcp-config` del claude CLI, `@modelcontextprotocol/sdk` (server stdio nel worker).

**Convenzioni trasversali (identiche alla fase 0):** TDD; test filtrati con `pnpm --filter @stubwise/<pkg> exec vitest run <pattern>` (NB: `test -- <pattern>` NON filtra); dopo modifiche a `packages/*` ribuilda il package; commit `feat(scope):`/`fix(scope):` in italiano; prima del merge `pnpm lint` + `pnpm typecheck` + `pnpm test` dalla radice; commenti in italiano nello stile del file; lavora nel worktree dedicato (verifica `git rev-parse --abbrev-ref HEAD` prima di ogni commit); parità i18n (catalog.ts en/it; locales web en/it).

---

## Fase A — Dati, kind, catalogo

### Task 1: Migrazione 0064 (`awaiting_input`, `plan_continue`, `cli_session_id`, `agent_questions`)

**Files:** Create `packages/db/drizzle/0064_agent_questions.sql` (+ `_journal.json`); Modify `packages/db/src/schema.ts`; Test `packages/db/src/agent-questions.test.ts` (harness testcontainers).

SQL (adattare allo stile drizzle-kit del repo, statement-breakpoint fra gli ALTER TYPE):
```sql
ALTER TYPE "public"."ai_job_status" ADD VALUE 'awaiting_input';
ALTER TYPE "public"."resume_mode" ADD VALUE 'plan_continue';
ALTER TABLE ai_jobs ADD COLUMN cli_session_id text;
CREATE TABLE agent_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  round integer NOT NULL,
  question text NOT NULL,
  options jsonb NOT NULL,
  recommended_index integer,
  allow_free_text boolean NOT NULL DEFAULT true,
  asked_at timestamptz NOT NULL DEFAULT now(),
  answer jsonb,
  answered_at timestamptz,
  answered_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT agent_questions_answer_chk CHECK ((answer IS NULL) = (answered_at IS NULL))
);
CREATE UNIQUE INDEX agent_questions_open_job_unique ON agent_questions (job_id) WHERE answered_at IS NULL;
CREATE INDEX agent_questions_ticket_idx ON agent_questions (ticket_id, asked_at);
```
⚠️ Trappola enum: gli `ADD VALUE` NON vanno usati da altri statement dello stesso batch (qui non serve). L'ordine dei valori nell'array di `schema.ts` deve combaciare col tipo Postgres (in coda). Test: job in `awaiting_input` inseribile; `resume_mode='plan_continue'` accettato; unico parziale (seconda domanda aperta sullo stesso job → 23505); CHECK answer⇔answered_at (23514); cascate. Commit `feat(db): migrazione 0064 — awaiting_input, plan_continue, agent_questions`.

### Task 2: Kind `job.awaiting_input` (tre liste, Record, routing `requester`, toggle)

**Files:** Modify `packages/notifications/src/format.ts` (interfaccia `JobAwaitingInputEvent` — campi: soliti ticketed + `questionId`, `round`, `question`, `options: {label, consequence?}[]`, `recommendedIndex?`, `allowFreeText` — union, EMOJI ❓, KEY_FOR_KIND `notify.awaitingInput`, linkParam, formatGeneric, sampleEvents), `packages/notifications/src/routing.ts` (audience `"requester"` in `AUDIENCE_FOR_KIND` + `recipientsFor`: requester = `requestedBy ∪ admins`), `packages/notifications/src/publish.ts` (`resolveRoutingContext`: per audience requester risolvi `requestedBy` da `opts.jobId` senza le query follower/ticket), `packages/notifications/src/dispatch.ts` (`TOGGLE_FOR_KIND` → `notifyAwaitingInput`), `packages/db/src/schema.ts` + **stessa migrazione 0064** (colonna `notification_settings.notify_awaiting_input boolean NOT NULL DEFAULT true` + `ALTER TYPE notification_kind ADD VALUE 'job.awaiting_input'` — attenzione: statement separati), `packages/shared/src/schemas/notification.ts` (`notificationKindSchema`), `packages/i18n/src/catalog.ts` (`notify.awaitingInput` en+it, es. "❓ L'AI ha una domanda su {ref} — {ticketTitle}: {question} {link}"), `apps/server/src/routes/settings.ts` (6 punti del toggle), `apps/web/src/lib/api.ts` (NotificationSettings), `apps/web/src/components/notifications-section.tsx` (EVENT_TOGGLES + SAMPLE_LABELS + chiavi i18n), `apps/web/src/components/inbox-item.tsx` (`INBOX_KIND_LABEL_KEYS` + chiave `inbox.kinds.*`).

I test di parità (kind a tre vie, routing, i18n) e i Record esaustivi guidano: compila finché non è tutto allineato. Test nuovi: routing requester (con requestedBy → {richiedente, admin}; senza → solo admin; follower ESCLUSI); publish con kind nuovo scrive inbox+deliveries. Commit `feat(notifications): kind job.awaiting_input con audience requester`.

### Task 3: Azione `answer` nel catalogo

**Files:** Modify `packages/notifications/src/actions.ts` (`ActionId` +`"answer"`; `DECISION_FOR_KIND["job.awaiting_input"] = { actions: ["answer"], adminOnly: false }`; `ALWAYS` NON si applica al kind domanda per `handled` → introduci un override per-kind: per `job.awaiting_input` le azioni base sono `["open","snooze"]` senza `handled` — scegli l'implementazione più pulita (es. `ALWAYS_FOR_KIND` o un Set di kind senza handled) e documenta; `stateAllows("answer")` → job `awaiting_input`; **`roleAllows` esteso**: la firma di `actionsFor` guadagna il `requestedByUserId` della notifica (nuovo campo in `ActionableNotification` o parametro) — `answer` è permessa ad admin O actor.id === requestedByUserId), `packages/notifications/src/slack-blocks.ts` (`LABEL_KEY.answer` — usata solo come fallback: i bottoni della domanda sono dinamici, Task 9), `apps/server/src/services/notifications-propagation.ts` (`NOTE_KEY.answer` → `notify.inbox.noteAnswered` con la label della risposta come param), `packages/shared/src/schemas/notification.ts` (`inboxActionSchema` + answer; `inboxDecisionActionSchema` + answer — così la card la mette in "Da decidere"), `packages/i18n/src/catalog.ts` (chiavi nuove en+it), `apps/server/src/slack/inbox-actions.ts` (lista `INBOX_ACTIONS`).

Aggiorna i chiamanti di `actionsFor` (services/inbox.ts, deliveries-poller.ts) alla firma nuova passando `requestedByUserId` (risolvibile: la notifica ha jobId → i batch esistenti; valuta di aggiungerlo alla SELECT del batch, senza N+1). Test puri estesi in `actions.test.ts` (richiedente member vede answer, altro member no, admin sì; job non più awaiting → niente answer). Commit `feat(notifications): azione answer con permesso richiedente-o-admin`.

---

## Fase B — Tool MCP e worker

### Task 4: Server MCP `ask_user`

**Files:** Create `apps/worker/src/ask-user-mcp/server.ts` (+ entry `apps/worker/src/ask-user-mcp/index.ts` eseguibile via `node dist/ask-user-mcp/index.js`); Test `apps/worker/src/ask-user-mcp/server.test.ts`.

Server MCP stdio (`@modelcontextprotocol/sdk`, aggiungi la dep al worker; pattern `packages/mcp/src/server.ts`: stdout = protocollo, log su stderr). Config via env: `ASK_USER_FILE` (path di output, obbligatorio), `ASK_USER_ROUND`, `ASK_USER_MAX_ROUNDS`. Tool `ask_user`: schema zod `{ question: string (1..2000), options: array(2..4) di { label: string (1..200), consequence?: string (..500) }, recommendedIndex?: int, allowFreeText?: bool default true }` con refine `recommendedIndex < options.length`. Comportamento: round > max → risposta "Tetto di domande raggiunto (N): scegli tu l'opzione più ragionevole e documenta la scelta nella sezione 'Decisioni e assunzioni' del piano." SENZA scrivere il file; file già esistente → "Hai già una domanda registrata: termina il turno."; ok → scrive il JSON (write atomica: tmp+rename) e risponde "Domanda registrata. Termina il turno ORA senza produrre il piano: riceverai la risposta in un turno successivo." Test: schema (rifiuti: 1 opzione, 5 opzioni, indice fuori range), tetto, doppia chiamata, file scritto e parsabile, output MCP ben formato. Verifica che il build del worker includa l'entry nel dist. Commit `feat(worker): server MCP ask_user (bridge su file)`.

### Task 5: Runner con `--mcp-config`

**Files:** Modify `apps/worker/src/agent/runner.ts` (`AgentRunOptions.mcpConfig?: { servers: Record<string, {command, args?, env?}> }`), `apps/worker/src/agent/claude-cli.ts` (serializza in un file temporaneo nella cwd del run — o JSON inline se il CLI lo accetta: verifica `claude --help`; aggiungi `--mcp-config <path>` e `--strict-mcp-config` se disponibile per escludere config utente), `apps/worker/src/agent/fake.ts` (registra l'opzione). Test in `claude-cli.test.ts` (argv con e senza mcpConfig; il file di config scritto contiene il server; cleanup). Commit `feat(worker): supporto --mcp-config nel runner`.

### Task 6: Parcheggio con domanda (dir deterministica, `parkForInput`, integrazione fix)

**Files:** Modify `packages/git/src/mirrors.ts` (variante `withProjectWorktrees` con `parentDir` esplicito e opzione `keep`/riuso: se la dir esiste già la ripulisce e ricrea — serve alla ripresa; NON cambiare il comportamento dei chiamanti esistenti), `apps/worker/src/queue.ts` (`parkForInput(db, jobId, {cliSessionId, log})` gemello di `parkForPlanApproval`: status `awaiting_input`, `cli_session_id`, NO finishedAt), `apps/worker/src/pipeline/fix.ts` (fase plan: parent dir `/tmp/stubwise-plan-<jobId>` via la variante; costruzione `mcpConfig` col server ask_user (`node <dist>/ask-user-mcp/index.js`, env ASK_USER_*) + allowlist `mcp__stubwise_ask__ask_user`; round corrente = `count(agent_questions where job_id)`+1; dopo il run: lettura+rivalidazione zod del file — presente → ritorno `{kind:"question", payload, cliSessionId: result.sessionId}` (vince sul piano, log warning se entrambi); fuori dalla callback: insert `agent_questions` (round, payload), `parkForInput`, `notify` `job.awaiting_input` con l'evento completo, commento `ai` sul ticket con la domanda (visibilità nel feed), `return "awaiting_input"` — nuovo valore in `FixOutcome`), `apps/worker/src/pipeline/prompts.ts` (`buildFixPlanPrompt`: regola d'ingaggio + sezione obbligatoria "Decisioni e assunzioni" + menzione del tool e del tetto), `apps/worker/src/handler.ts` (outcome nuovo trattato come awaiting_approval: return false).

Test (`fix.test.ts` + `queue.test.ts`): run che scrive il file → job `awaiting_input` con cli_session_id, riga agent_questions round 1, notifica pubblicata con opts {projectId,ticketId,jobId}, worktree distrutti; file malformato → ignorato con warning e flusso normale; file+piano → vince il file; dir parent deterministica usata. Commit `feat(worker): la pianificazione può fermarsi con una domanda (awaiting_input)`.

### Task 7: Ripresa `plan_continue` (resume + fallback)

**Files:** Modify `apps/worker/src/pipeline/fix.ts` (`resolveFixMode`: `resumeMode==='plan_continue'` → modalità plan-continue, PRIMA del gate planApprovalRequired; nella fase plan: carica le Q&A da `agent_questions` (answered) ordinate per round; se `job.cliSessionId` presente → run con `resumeSessionId` su parent dir `/tmp/stubwise-plan-<jobId>` e prompt = blocco risposta ("Risposta alla tua domanda (round N): «Q» → «label/testo». Continua la pianificazione: se hai un'altra domanda materiale usa ask_user, altrimenti produci il piano completo con 'Decisioni e assunzioni'."); se il run resume fallisce subito (exit≠0 senza output utile) o cliSessionId è null → **fallback**: run di pianificazione da zero (prompt pieno) con blocco "Decisioni già prese" (tutte le Q&A) — azzera `cli_session_id` (verrà riscritto); il resto del flusso (nuova domanda / piano / parcheggio approvazione) identico), `apps/worker/src/pipeline/prompts.ts` (builder del blocco Q&A e del prompt continue), `apps/server/src/services/jobs.ts` (NON toccare startRun; `IN_FLIGHT` include già awaiting_input? NO: `IN_FLIGHT_JOB_STATUSES` va esteso — è nel Task 3/actions... verifica che sia fatto lì e che `startRun` su job `awaiting_input` risponda `job_in_flight`).

Test: risposta → resume con `--resume` e cwd giusta (FakeAgentRunner: asserisci `resumeSessionId` e `cwd`); fallback su cliSessionId null; fallback su resume exit≠0; dopo la ripresa il piano va in `awaiting_plan_approval` come oggi; due round consecutivi (domanda → risposta → seconda domanda → risposta → piano). Commit `feat(worker): ripresa della pianificazione dalla risposta (plan_continue)`.

---

## Fase C — Servizio e superfici server

### Task 8: `answerQuestion` + rotta REST + contratto

**Files:** Create `apps/server/src/services/questions.ts` (`answerQuestion(db, { notificationId | jobId, actor, answer: {optionIndex} | {text}, publicUrl? })`: risolve la domanda aperta del job, valida (indice nel range delle options persistite; text solo se allowFreeText, max 4000, trim), UPDATE condizionato `answered_at IS NULL` (perdente → `already_handled` con chi ha risposto), job `awaiting_input` → `queued` + `resume_mode='plan_continue'` (UPDATE guarded), commento `user` sul ticket con la risposta (così il feed la mostra e il fallback re-prime resta coerente coi teamComments — valuta e documenta), `propagateDecision` per (jobId, kind `job.awaiting_input`) con nota "💬 …"; errori: `question_not_pending`, `invalid_answer`, `forbidden`, `not_found`); Modify `apps/server/src/services/inbox.ts` (`executeAction` ramo `answer` → delega a `answerQuestion`; `InboxItem.question?` calcolato nel recinto per-item dall'event; batch: `requestedByUserId` per actionsFor), `packages/shared/src/schemas/notification.ts` (`inboxQuestionSchema`, `answerBodySchema` — `{optionIndex}` XOR `{text}` via refine — item esteso), `apps/server/src/routes/inbox.ts` (`/actions/answer` accetta il body nuovo; mapping errori: `invalid_answer`→400, `question_not_pending`→409), rotta lettura Q&A per la pagina ticket: `GET /api/tickets/:id/questions` (requireAuth, lista `agent_questions` del ticket con answeredBy email) in `apps/server/src/routes/tickets.ts` o file dedicato.

Test: validazioni tutte; corsa `Promise.all` (una vince, l'altra `already_handled`); permessi (richiedente member sì, altro member forbidden, admin sì); propagazione su tutte le copie; job rimesso queued con plan_continue; rotta answer (200/400/403/409); GET questions. Commit `feat(server): risposta alle domande dell'agente con propagazione multi-superficie`.

### Task 9: Slack — bottoni dinamici e modal "Altro"

**Files:** Modify `packages/notifications/src/slack-blocks.ts` (per il kind `job.awaiting_input` una `buildQuestionBlocks(event, lang, notificationId)`: sezione domanda + per ogni opzione un bottone `action_id="inbox:answer:<index>"` (⭐ sulla raccomandata) con le conseguenze nel testo della sezione; bottone "Altro…" `inbox:answer_free` se allowFreeText; il poller la usa al posto dei blocchi standard per quel kind), `apps/worker/src/notify/deliveries-poller.ts` (render della domanda per il kind nuovo), `apps/server/src/slack/routes.ts` + `inbox-actions.ts` (parsing `inbox:answer:<n>` → `executeAction answer {optionIndex:n}`; `inbox:answer_free` → `views.open` modal con textarea (pattern reject: `buildAnswerModal`, `private_metadata`, callback `inbox_answer_free`, errori in-modal) → `executeAction answer {text}`), `apps/server/src/slack/modal.ts`, i18n catalog (etichette modal + nota risposta).

Test: blocchi (snapshot due lingue, ⭐, ≤4+altro), parsing block_actions con indice, modal submit, già-risposto → ephemeral con email, non-richiedente member → forbidden ephemeral. Commit `feat(slack): risposta alle domande dell'agente dai DM`.

---

## Fase D — Web

### Task 10: Card domanda nell'inbox

**Files:** Create `apps/web/src/components/question-panel.tsx` (componente condiviso: opzioni verticali con conseguenza, raccomandata marcata "consigliata" MAI preselezionata, selezione → bottone "Invia risposta", "Altro…" con textarea; props: question + onSubmit + stato pending/errore); Modify `apps/web/src/components/inbox-item.tsx` (per kind `job.awaiting_input` rende il panel; `can("answer")`), `apps/web/src/lib/api.ts` (`postInboxAction` col body answer; tipi), `apps/web/src/i18n/locales/{en,it}.json` (namespace question). Test: opzioni rese, conferma a due passi, Altro, 409 "già risposto da X", niente handled sulla card domanda. Commit `feat(web): card domanda con opzioni nell'inbox`.

### Task 11: Pagina ticket, timeline, stati

**Files:** Modify `apps/web/src/routes/tickets/$id.tsx` (blocco domanda col `question-panel` quando `latestJob.status==='awaiting_input'` — visibile a admin e richiedente (`requestedByUserId` esposto? verifica `GET /tickets/:id/jobs`: aggiungi il campo se manca), altri vedono riga informativa; Q&A passate da `GET /questions` in una sezione collassabile), `apps/web/src/lib/api.ts`+`queries.ts` (client questions; `AIJobStatus` +awaiting_input; `WAITING_JOB_STATUSES` +awaiting_input), `apps/web/src/components/ai-job-timeline.tsx` + `activity-feed.tsx` (Record: dot/text/nota), i18n `jobStatus.labels/notes.awaiting_input`. Test: gating per identità/ruolo, risposta dalla pagina, polling 20s, timeline. Commit `feat(web): domanda dell'agente sulla pagina ticket`.

---

## Fase E — Rifiniture e chiusura

### Task 12: MCP `run_ticket`, skill, docs

**Files:** Modify `packages/mcp/src/tools/write.ts` (menzione del possibile esito domanda nel testo di run_ticket) + changeset patch, `.claude/skills/stubwise/SKILL.md` + copia utente (`~/.claude/skills/stubwise/`), `.claude/commands/stubwise/run.md` (esito nuovo), `apps/docs` (pagina notifications/slack: la domanda con bottoni; configuration.md: `AGENT_QUESTION_MAX_ROUNDS`), `.env.example`, `apps/worker/src/config.ts` (`AGENT_QUESTION_MAX_ROUNDS` default 5) + compose. Commit `docs(fase1): domanda dell'agente su tutte le superfici documentata`.

### Task 13: Verifica finale e note di deploy

`pnpm lint` + `pnpm typecheck` + `pnpm test` dalla radice; playwright --list; `docs/plans/feature-backlog.md` (voce fase 1 ✅); `CLAUDE.md` § Deploy (fase 1: rebuild server+worker+caddy insieme, migrazione 0064, env `AGENT_QUESTION_MAX_ROUNDS` opzionale, nessun passo Slack) e sezione ruoli/MCP se serve. Commit `docs: note di deploy fase 1`. Report finale: log del branch, conteggi, working tree pulito.

**Deploy (dopo il merge):** backup DB → `git pull` → `docker compose up -d --build server worker caddy` → verifica 0064 (`\d agent_questions`) → smoke: run-ai su un ticket di test con domanda → risposta dall'inbox.
