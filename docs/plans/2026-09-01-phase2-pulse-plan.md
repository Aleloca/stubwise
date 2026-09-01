---
title: Fase 2 — Pulse proattivo — Piano di implementazione
date: 2026-09-01
design: 2026-09-01-phase2-pulse-design.md
stubwise:
  project: stubwise
  backlogItem: 6a155c3a-ecb7-45f3-a9e0-5d62991413eb # https://stubwise.thecove.it/backlog/6a155c3a-ecb7-45f3-a9e0-5d62991413eb
---

# Fase 2 — Pulse proattivo — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Un poller nel worker rileva i progetti fermi e pubblica una notifica `project.pulse` con 2–3 proposte dal backlog (ranking deterministico); "Procedi" converte la voce in ticket e lancia la pianificazione con approvazione obbligatoria; riuso completo delle opzioni dinamiche della fase 1; tool MCP `list_proposals`; decisioni già prese iniettate anche sui rilanci manuali.

**Architecture:** Il worker (che non può importare i servizi del server) *rileva e propone*: `apps/worker/src/pulse/poller.ts` calcola i segnali per progetto, il ranking e pubblica via `publishNotification` in transazione con `pulse_last_sent_at`. Il server *esegue*: `executeAction("answer")` dispatcha per kind verso `proceedWithProposal` (`services/pulse.ts`) → `convertBacklogItem` (estratto dalla rotta) → `startRun({requirePlanApproval:true})` → propagazione. Il payload del pulse ha la forma della domanda della fase 1, quindi `QuestionPanel`, `buildQuestionBlocks` e gli schemi restano invariati. Design: `docs/plans/2026-09-01-phase2-pulse-design.md` (**LEGGILO PRIMA**).

**Tech Stack:** come fasi 0/1. Fuso orario via `Intl.DateTimeFormat` (nessuna dipendenza nuova).

**Convenzioni trasversali (identiche alle fasi precedenti):** TDD; test filtrati con `pnpm --filter @stubwise/<pkg> exec vitest run <pattern>`; ribuilda i `packages/*` toccati; commit `feat(scope):` in italiano; `pnpm lint` + `pnpm typecheck` + `pnpm test` prima del merge; commenti in italiano nello stile del file; worktree dedicato; parità i18n.

---

## Fase A — Dati, kind, catalogo

### Task 1: Migrazione 0065 (kind `project.pulse`, toggle `notify_pulse`, colonne progetto)

**Files:** Create `packages/db/drizzle/0065_project_pulse.sql` (+ journal); Modify `packages/db/src/schema.ts` (`notificationKind` + `project.pulse`; `notificationSettings.notifyPulse` default true; `projects.pulseEnabled` default false, `pulseEveryDays` int default 3, `pulseLastSentAt` timestamptz null); Test `packages/db/src/pulse-schema.test.ts`.

SQL: `ALTER TYPE "public"."notification_kind" ADD VALUE 'project.pulse';` (statement separato, non usato nel batch), `ALTER TABLE notification_settings ADD COLUMN notify_pulse boolean NOT NULL DEFAULT true;`, `ALTER TABLE projects ADD COLUMN pulse_enabled boolean NOT NULL DEFAULT false, ADD COLUMN pulse_every_days integer NOT NULL DEFAULT 3, ADD COLUMN pulse_last_sent_at timestamptz;` + `CHECK (pulse_every_days BETWEEN 1 AND 30)`. Test: default delle colonne, CHECK (23514), enum accettato. Commit `feat(db): migrazione 0065 — project.pulse e cadenza per progetto`.

### Task 2: Kind `project.pulse` (tre liste, Record, routing, toggle, i18n)

**Files:** Modify `packages/notifications/src/format.ts` (interfaccia `ProjectPulseEvent`: `kind`, `projectName`, `projectUrl`, `idleDays`, `question`, `options: {label, consequence?}[]`, `recommendedIndex?`, `allowFreeText: false`, `proposals: {backlogItemId, title, urgency, effort, hasAnalysis}[]`; unione; `NonTicketedEvent` + `hasTicket()`; EMOJI 📣; KEY_FOR_KIND `notify.pulse` con params `{project, idleDays, link}`; linkParam → `projectUrl`; formatGeneric; `UNTRUSTED_SLACK_PARAMS` per i titoli delle voci (arrivano da utenti/widget); sampleEvents), `routing.ts` (`AUDIENCE_FOR_KIND["project.pulse"] = "broadcast"`), `dispatch.ts` (`TOGGLE_FOR_KIND` → `notifyPulse`), `packages/shared/src/schemas/notification.ts` (`notificationKindSchema`), `packages/i18n/src/catalog.ts` (`notify.pulse` en+it, es. "📣 Nessun lavoro in corso su {project} da {idleDays} giorni: ci sono proposte nel backlog. {link}"), `apps/server/src/routes/settings.ts` (6 punti), `apps/web/src/lib/api.ts`, `apps/web/src/components/notifications-section.tsx` (EVENT_TOGGLES + SAMPLE_LABELS + i18n), `apps/web/src/components/inbox-item.tsx` (`INBOX_KIND_LABEL_KEYS` "Proposta"), `packages/notifications/src/actions.ts` (`CATALOG_FOR_KIND["project.pulse"] = { decisions: ["answer"], adminOnly: false, archivable: true }`, `openUrl` → `projectUrl`), `apps/server/src/services/notifications-propagation.ts` (NOTE_KEY invariato: la nota del pulse arriva dal Task 6).

Test: parità a tre vie e Record guidano; routing broadcast senza ticket (admin + follower, nessun assignee). Commit `feat(notifications): kind project.pulse`.

### Task 3: `answer` per-kind

**Files:** Modify `packages/notifications/src/actions.ts` (Set esportato `KINDS_WITH_OPTIONS = new Set<NotificationKind>(["job.awaiting_input","project.pulse"])`; `stateAllows("answer", jobStatus, kind)`: per `job.awaiting_input` → `awaiting_input`, per `project.pulse` → sempre true (lo stato della notifica lo verifica il servizio); `actorAllows("answer")`: per il pulse ogni destinatario; adegua la firma di `actionsFor` se serve il kind in `stateAllows` — è già in `notification.kind`), `apps/server/src/services/inbox.ts` (`renderItem`: `question` calcolato se `KINDS_WITH_OPTIONS.has(kind)`; `executeAction` ramo `answer`: dispatch per kind → `answerQuestion` | `proceedWithProposal` (stub che ritorna `invalid_action` fino al Task 6, o implementa direttamente l'import se preferisci ordinare i task diversamente — dichiara)), `apps/worker/src/notify/deliveries-poller.ts` (ternario → `KINDS_WITH_OPTIONS.has(kind)`).

Test: `actions.test.ts` tabella per kind; `inbox.test.ts` renderItem col kind pulse produce `question`; poller Slack usa i blocchi domanda per il pulse. Commit `feat(notifications): azione answer generalizzata ai kind con opzioni`.

---

## Fase B — Servizi server

### Task 4: `convertBacklogItem` estratto + `startRun.requirePlanApproval`

**Files:** Create `apps/server/src/services/backlog.ts` (`convertBacklogItem(db, { itemId, actor }) → { ok, ticketId, ticketNumber } | { error: "not_found" | "already_converted" | "not_convertible" }`, con il claim anti-TOCTOU e tutto il corpo attuale della rotta — `createTicket`, effort, `backlog_item_tickets`, chiusura sessione codice); Modify `apps/server/src/routes/backlog.ts` (la rotta `convert` diventa un adattatore), `apps/server/src/services/jobs.ts` (`StartRunInput.requirePlanApproval?: boolean`: se true → `planApprovalRequired: true` e, con piano salvato, parcheggio diretto in `awaiting_plan_approval` anche per admin, con la notifica `job.plan_review` già prevista in quel ramo).

Test: `backlog.test.ts` rotta invariata (tutti i test esistenti verdi); `services/backlog.test.ts` (claim con `Promise.all`, `already_converted`, archiviata → `not_convertible`); `services/jobs.test.ts` (admin + flag → approvazione; admin + flag + piano → `awaiting_plan_approval`). Commit `feat(server): convertBacklogItem come servizio e requirePlanApproval`.

### Task 5: Filtro `kind` sulla lista inbox

**Files:** Modify `apps/server/src/routes/inbox.ts` + `services/inbox.ts` (`listInbox` accetta `kind?: NotificationKind`), `packages/shared` se lo schema query è condiviso. Test: filtro applicato. Commit `feat(server): filtro kind sulla lista inbox`.

### Task 6: `proceedWithProposal` + propagazione + nota

**Files:** Create `apps/server/src/services/pulse.ts` (`proceedWithProposal(db, { notificationId, actor, optionIndex, publicUrl })`: legge la notifica (ownership), il payload `proposals[optionIndex]` (validato con zod, `invalid_answer` se fuori range), stato notifica `open` (altrimenti `already_handled` con chi), `convertBacklogItem` → su `already_converted`/`not_convertible` → `proposal_stale` (e chiude comunque le copie con nota "già presa in carico"), `startRun({ ticketId, actor, requirePlanApproval: true, publicUrl })`, `propagateDecision({ target: { notificationId… tutte le copie dello stesso pulse: chiave = (projectId, kind, createdAt?) — usa il campo `pulseId` nel payload (uuid generato dal poller) per identificare le copie }, action: "answer", nota "▶️ {actor} ha avviato «{title}»" })`; ritorna `{ ticketId, ticketNumber, jobId }`); Modify `services/inbox.ts` (dispatch), `notifications-propagation.ts` (target per `pulseId` se serve; NOTE_KEY/nota con param titolo), `packages/i18n` (chiavi nota + errore), `packages/shared` (risultato `answer` esteso con `ticketId?`/`ticketNumber?`), `routes/inbox.ts` (mapping `proposal_stale` → 409).

Test: felice (ticket creato, job `awaiting_plan_approval` o `queued`+`planApprovalRequired`, copie handled, nota); corsa `Promise.all` (uno vince, l'altro `already_handled`/`proposal_stale`); voce già convertita da altrove → `proposal_stale`; member destinatario può; non destinatario → `not_found`. Commit `feat(server): Procedi dal pulse — convert + run con approvazione`.

---

## Fase C — Worker

### Task 7: Poller pulse (segnali, ranking, finestra oraria, cadenza, pubblicazione)

**Files:** Create `apps/worker/src/pulse/poller.ts` (`pollPulseOnce(deps)`, `startPulsePoller(opts)`; funzioni pure esportate: `isInSendWindow(now, { timezone, hour, weekdaysOnly })` con `Intl.DateTimeFormat(..., {timeZone, hour: "numeric", weekday: "short", hour12:false})`, `rankCandidates(items)`, `buildPulseEvent(...)`), `apps/worker/src/pulse/signals.ts` (`isProjectIdle(db, projectId)`: 5 query o una CTE — commenta gli indici usati; `listCandidates(db, projectId)`), `apps/worker/src/config.ts` (`PULSE_POLL_MINUTES` 15, `PULSE_TIMEZONE` UTC — valida con `Intl.supportedValuesOf("timeZone")` o try/catch su DateTimeFormat, `PULSE_SEND_HOUR` 0..23 default 9, `PULSE_WEEKDAYS_ONLY` true), `apps/worker/src/index.ts` (avvio), `docker-compose.yml`, `.env.example`.

Tick: se non in finestra → return; per ogni progetto `pulse_enabled AND backlog_enabled` (best-effort): se `pulse_last_sent_at` recente → skip; `isProjectIdle` falso → skip; candidati → ranking → 0 → skip; transazione: UPDATE `projects SET pulse_last_sent_at = now() WHERE id = ? AND (pulse_last_sent_at IS NULL OR pulse_last_sent_at < now() - every_days)` → 0 righe → skip (un altro tick ha vinto); UPDATE copie `open` dei pulse precedenti del progetto → `handled` (nota "sostituita"); `publishNotification(tx, event, { projectId })` con `pulseId` uuid, `idleDays` (giorni dall'ultimo `ai_jobs.lastActivityAt`/`tickets.updatedAt`/`backlog_items.updatedAt` del progetto — scegli la più semplice e documenta; se nessuna, 0). Log per progetto.

Test (`pulse/poller.test.ts`, testcontainers, `now` iniettabile): finestra (ora/fuso/weekend — es. `Europe/Rome` alle 9:30 locali vs 7:30 UTC), ogni segnale di attività blocca il ping, ranking (urgenza/effort/ready/analisi/età), cadenza (secondo tick nello stesso giorno non manda; dopo N giorni sì), transazione idempotente (due tick concorrenti → una sola notifica), sostituzione delle copie precedenti, progetto senza backlog ignorato, 0/1/3+ candidati, payload conforme a `inboxQuestionSchema`. Commit `feat(worker): poller del pulse proattivo`.

### Task 8: Decisioni prese iniettate anche sui rilanci

**Files:** Modify `apps/worker/src/pipeline/fix.ts` (carica le Q&A risposte del job in ogni run di pianificazione — non solo con `plan_continue` — e inietta il blocco `<decisioni_prese>` se non vuoto; aggiorna il docblock che descriveva l'asimmetria), `prompts.ts` se il builder è legato a `plan_continue`. Test: rilancio manuale (`resumeMode: null`/`fix`) di un job con Q&A risposte → prompt contiene le decisioni; job senza Q&A → nessun blocco. Commit `fix(worker): decisioni già prese iniettate a ogni pianificazione`.

---

## Fase D — Web e MCP

### Task 9: Form progetto e card pulse

**Files:** Modify `packages/shared/src/schemas/project.ts` (`pulseEnabled`, `pulseEveryDays` in project/create/update), `apps/server/src/routes/projects.ts` (proiezione + PATCH), `apps/web/src/components/project-form.tsx` (toggle + numero 1..30, disabilitati con hint se `backlogEnabled` è off), `apps/web/src/components/inbox-item.tsx` (kind pulse: header con progetto/"fermo da N giorni"/link "Apri backlog"; `QuestionPanel` con etichetta di conferma "Avvia" — prop opzionale `submitLabel`; post-esito "▶️ Avviato da X" + link ticket dal risultato), i18n. Test: form (PATCH corretto, disabilitazione), card pulse (opzioni, conferma "Avvia", esito con link). Commit `feat(web): toggle pulse e card delle proposte`.

### Task 10: MCP `list_proposals` + skill

**Files:** Modify `packages/mcp/src/client.ts` (`listInbox({status, kind})`), `packages/mcp/src/tools/read.ts` (tool `list_proposals`: descrizione "elenca le proposte aperte del pulse per te; si risponde dalla web app o da Slack"), test (`read.test.ts`, `server.test.ts` 16 tool), changeset minor; `.claude/skills/stubwise/SKILL.md` (§ consultazione: "all'apertura di una sessione, `list_proposals`") + copia utente; `apps/docs` (pagina MCP + configuration.md con le env PULSE_*; guida notifiche: il pulse). Commit `feat(mcp): tool list_proposals`.

---

## Fase E — Chiusura

### Task 11: Verifica finale e note di deploy

`pnpm lint` + `pnpm typecheck` + `pnpm test`; playwright --list; `feature-backlog.md` (fase 2 ✅); `CLAUDE.md` § Deploy (fase 2: rebuild server+worker+caddy insieme, migrazione 0065, env `PULSE_*` — in prod `PULSE_TIMEZONE=Europe/Rome`, attivazione per progetto dal toggle) e § Invarianti (il pulse tace se ci sono decisioni pendenti). Chiudere la voce di backlog `8931d96d` (decisione presa: opzione 1, implementata nel Task 8). Commit `docs: note di deploy fase 2`.

**Deviazioni dal piano introdotte dal Task 7** (da riportare nelle note di deploy e nei follow-up):

- **Cadenza con tolleranza di un'ora.** Il piano recita la formula secca `pulse_last_sent_at < now() - every_days`. Presa alla lettera, un pulse mandato alle 9:50 rende "troppo presto" quasi tutta la finestra di N giorni dopo (che dura un'ora, e il poller gira ogni 15'): il ping **slitta al giorno successivo**. Il cutoff implementato sottrae `every_days` **più la durata della finestra**, così la cadenza si legge come è pensata — *ogni N giorni, nella finestra del mattino*. Non apre a due pulse nella stessa finestra (l'ultimo inviato sarebbe `now`, mai `< now - N giorni + 1h`); due test lo fissano.
- **Il campo `question` del payload è italiano hardcoded**, composto dal worker: è UNA stringa per tutte le copie, quindi non può essere per-lingua come il testo i18n dell'item. È il precedente già accettato del backlog di discovery (i18n lato server hardcoded `it`, innocuo su un'istanza italiana), ma va fra i follow-up: il giorno in cui l'istanza serve utenti `en`, la domanda del pulse resta in italiano mentre tutto il resto della card è tradotto. La forma `giorni di fermo: N` è già allineata al catalogo, quindi la traduzione sarebbe meccanica.
- **`held` blocca il pulse** (vedi l'emendamento al §2 del design): il pulse tace anche sui job parcheggiati su limite/budget/gate, che hanno già la loro `job.held` in inbox. `IN_FLIGHT_JOB_STATUSES` non è stata toccata.

**Cambio di superficie API introdotto dal Task 4:** `POST /api/backlog/:id/convert` su una voce **archiviata** ora risponde 409 `not_convertible` invece di convertirla (prima 200). Allinea l'API alla SPA, che già nasconde «Converti» sulle voci bloccate; l'unica superficie che poteva raggiungerla è il tool MCP `convert_backlog_to_ticket`.

**Voce di backlog `8931d96d` — chiusa.** La domanda era come trattare le decisioni già prese quando un job viene rilanciato a mano. Decisione: **opzione 1** — le Q&A risposte sono iniettate nel prompt di pianificazione ogni volta che esistono, a prescindere dal `resumeMode`, col budget dei round che resta per-job. Implementata nel Task 8 (`fix.ts`), coperta dai test della pipeline.

### Follow-up (nessuno bloccante per il merge)

Consolidati dalle review dei task; le prime tre sono conseguenze note e accettate delle scelte fatte, le ultime due sono cose da guardare dopo il deploy.

1. **i18n del payload del pulse.** `question` e `options[].consequence` sono **italiano hardcoded** nel worker (`pulse/poller.ts`), a differenza di `message`, che passa dal catalogo `@stubwise/i18n`. Le `consequence` sono visibili all'utente, sia nella card sia nel DM. È lo stesso precedente già accettato per il backlog di discovery (i18n lato server hardcoded `it`, innocuo su un'istanza italiana). Il miglioramento a costo più basso non è tradurre quelle stringhe lato worker — sono UNA per tutte le copie, quindi non possono essere per-destinatario — ma **comporre il contesto lato client** dal blocco `pulse.proposals`, che ora porta `urgency`, `effort` e `hasAnalysis` **strutturati**, tenendo `consequence` come fallback.
2. **Contratto: cancellare un ticket nato da una proposta cancella anche la riga del pulse già gestita.** La notifica `project.pulse` **acquisisce** il `ticket_id` al momento della decisione, e su `notifications.ticket_id` c'è una FK `onDelete: cascade`: la copia gestita sparisce insieme al ticket. È coerente col resto delle notifiche legate a un ticket, ma è un comportamento **nuovo** per il pulse (prima della decisione la riga non ha ticket e sopravvive a tutto), e va saputo prima di stupirsene.
3. **Prestazioni: nessun indice nuovo oggi.** La batteria dei segnali costa ~2,6 ms tutta in cache sui volumi sintetici misurati (misure e piani nel docblock di `pulse/signals.ts`, ristampate dal test "costo delle query dei segnali"). Se i volumi crescessero di ordini di grandezza, l'indice che pagherebbe di più è **`ai_jobs (ticket_id, status)`**: oggi c'è solo `ticket_id` e **tre rami** della query (job in volo, job `held`, `max(last_activity_at)`) tornano all'heap per leggere lo stato — il **78% dei buffer**. Secondo candidato: **`backlog_jobs (project_id, status)`**, che toglierebbe l'unico seq scan rimasto.
4. **Lacune pre-esistenti nella pagina notifiche di `apps/docs`.** Emerse durante il Task 10 e **non** toccate (fuori perimetro): gli eventi `monitor.*` mancano dalla tabella dei kind, e i loro campi dal contratto del webhook. Il Task 10 ha aggiunto `project.pulse` a entrambi, quindi la pagina è coerente per la fase 2 ma resta incompleta sul monitoraggio.
5. **Da osservare ai primi feedback: snooze contro cadenza corta.** Con `pulseEveryDays = 1` uno snooze può essere di fatto neutralizzato — il pulse del giorno dopo chiude la copia rinviata prima che la posticipazione scada. Coi default (cadenza 3) le due scale combaciano e il caso non si presenta. Se qualcuno mette la cadenza a 1 e si lamenta dello snooze, la leva è la cadenza, non lo snooze.

**Deploy:** backup DB → `git pull` → aggiungere `PULSE_TIMEZONE=Europe/Rome` a `.env` → `docker compose up -d --build server worker caddy` → verifica 0065 → attivare il toggle su un progetto con backlog.

**Post-merge (fuori dal deploy dell'istanza):** mergiare la PR di versioning Changesets che pubblica `@stubwise/mcp` con `list_proposals` — il tool arriva agli utenti a quel merge, non al deploy — e ricopiare la skill `stubwise` aggiornata in `~/.claude/skills/stubwise/` sulle macchine degli altri sviluppatori.
