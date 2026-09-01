---
title: Fase 2 — Pulse proattivo
date: 2026-09-01
status: validato (brainstorming)
program: 2026-08-31-stubwise-nerve-center-program-design.md
stubwise:
  project: stubwise
  backlogItem: 6a155c3a-ecb7-45f3-a9e0-5d62991413eb # https://stubwise.thecove.it/backlog/6a155c3a-ecb7-45f3-a9e0-5d62991413eb
---

# Fase 2 — Pulse proattivo

Terza fase del programma "centro nevralgico". Un job periodico rileva i
progetti **fermi** (nessun lavoro AI in corso, nessuna decisione pendente,
backlog con voci candidabili) e manda una notifica azionabile con 2–3 proposte
ordinate per urgenza/effort; "Procedi con X" converte la voce in ticket e lancia
la pianificazione con approvazione obbligatoria. Riusa le opzioni dinamiche
della fase 1 e inbox/outbox/Slack della fase 0.

## 1. Stato di partenza (fatti verificati)

- **Il worker non può importare da `apps/server`**: `convert` backlog→ticket
  è logica inline nella rotta (`apps/server/src/routes/backlog.ts:1447-1535`,
  claim anti-TOCTOU + `createTicket` di `apps/server/src/db/tickets.ts:60-97`);
  `startRun` è in `apps/server/src/services/jobs.ts:88` (input: `ticketId,
  actor, mode?, withInstructions?, publicUrl?`). Accodare un `backlog_jobs` è
  un singolo insert (`kind: deep_dive|intake|estimate|chat_turn`).
- **Progetti**: `projects` (`schema.ts:338-376`) ha i toggle
  `docAutoUpdate`, `dailyReportEnabled`, `backlogEnabled`; nessun
  `updatedAt`, nessun fuso orario. PATCH `/api/projects/:id` (requireAdmin,
  `updateProjectSchema` in `packages/shared/src/schemas/project.ts:116-123`,
  proiezione `toPublicProject` `routes/projects.ts:69-89`); form UI
  `apps/web/src/components/project-form.tsx` (card con checkbox per toggle).
  `automation_rules` è per TIPO di ticket, globale (`schema.ts:871-885`).
  `instance_settings` non ha timezone; **nessun fuso orario nel sistema**
  (tutto UTC, es. `previousUtcDay` del daily report).
- **Backlog**: `backlog_items` (`schema.ts:2101-2143`): `status ∈ new |
  refining | ready | converted | archived` (`ready` si imposta SOLO a mano da
  PATCH), `urgency` (= `ticket_priority`: low/medium/high/urgent), `effort`
  1-5, `risk`, `document`, `implementationPlan`, `suggested`, indice
  `(project_id, status)`. Deep dive fatto = sezione `## Analisi tecnica` nel
  `document` (`apps/worker/src/backlog/deep-dive.ts:48`). Lista ordinata solo
  per `createdAt desc`; nessun ordinamento per urgenza/effort esiste.
- **Segnali di attività** per progetto: `ai_jobs` (senza `projectId`: join
  `tickets.project_id`; in volo = `IN_FLIGHT_JOB_STATUSES` = queued, triaging,
  fixing, awaiting_plan_approval, awaiting_input; indice solo su `ticket_id` e
  parziale `queued`), `agent_questions.answered_at IS NULL` (ha `ticket_id`),
  `ticket_repositories.pr_state = 'open'`, `backlog_jobs` (`projectId`
  diretto, `status ∈ queued|running`), `backlog_code_sessions.status='active'`.
  Nessun campo "ultima attività" sul progetto.
- **Poller precedenti**: daily-report (`apps/worker/src/reports/daily-report-poller.ts`:
  itera `projects where dailyReportEnabled`, best-effort per progetto,
  serializer, gate idempotente via unique + `onConflictDoNothing`, `now`
  iniettabile, `intervalMinutes ≤ 0` = off); monitor (`servers.activeAlerts`
  con `notifiedAt` scritto PRIMA di notificare, `downNotifiedAt` sui check).
- **Notifiche (post fase 1)**: 12 kind; `AUDIENCE_FOR_KIND` esaustivo con
  `admins | broadcast | requester`; `CATALOG_FOR_KIND: Record<kind, {
  decisions, adminOnly, archivable }>`; `ActionId` include `answer`;
  `actorAllows` per `answer` = admin o `requestedByUserId`; `stateAllows`
  `answer` ⇔ job `awaiting_input`; `actionsFor({kind, requestedByUserId},
  jobStatus, actor)`.
- **Opzioni dinamiche (fase 1), riusabili senza modifiche**:
  `inboxQuestionSchema` / `answerBodySchema` / `agentQuestionAnswerSchema`
  (shared), `QuestionPanel` (generico: `question`, `onSubmit`, `pending`,
  `error`, `showQuestionText`), `buildQuestionBlocks` (legge il payload
  grezzo, non il kind; `inbox:answer:<i>`; degrada a `buildInboxBlocks` se
  manca `answer`), `buildAnswerModal`, `propagateDecision` con target
  `{ notificationId }` o `{ jobId, kind }`. **Agganciati al kind/job** (da
  generalizzare): `renderItem` (`inbox.ts:644-663`, `if kind ===
  "job.awaiting_input"`), ternario del poller Slack
  (`deliveries-poller.ts:512-531`), `stateAllows`/`actorAllows` per `answer`,
  `executeAction` ramo `answer` → `answerQuestion` (che risolve sempre un
  `jobId` e hardcoda il kind).
- **Rilancio manuale** (voce di backlog `8931d96d`): `startRun` RIUSA la
  riga del job; `agent_questions` restano attaccate; `questionRound = count +
  1`; le decisioni prese sono iniettate SOLO con `resumeMode = plan_continue`
  (`fix.ts:1167-1182` documenta l'asimmetria).
- Ultima migrazione: 0064.

## 2. "Progetto fermo" e proposte

**Fermo** = tutte le condizioni: nessun job AI in volo sui ticket del
progetto; nessuna domanda aperta; nessuna PR `open` in `ticket_repositories`;
nessun `backlog_jobs` in `queued|running`; nessuna sessione di analisi codice
`active`; **e** almeno una voce candidabile. Se il progetto è fermo per una
decisione umana pendente (piano, domanda, PR) il pulse **tace**: la notifica
originale è già in inbox. Promemoria sulle decisioni scadute: fase successiva.

**Candidati**: `backlog_items` del progetto con `status ∈ {ready, refining,
new}`, `document` non vuoto, nessun `backlog_jobs` attivo con quell'`itemId`
nel payload. **Ranking deterministico** (niente AI): urgenza
(urgent > high > medium > low, `null` = medium), effort crescente (`null` = 3),
bonus `ready`, bonus "Analisi tecnica" presente, poi `createdAt` crescente.
Proposte = prime 3 (2 se ce ne sono solo 2; con 1 sola si propone quella; con
0 niente ping). Contesto per opzione: "urgenza alta · effort 2 · analisi
pronta".

**"Procedi con X"** (server): `convertBacklogItem` + `startRun({
requirePlanApproval: true })` → esito sempre `awaiting_plan_approval` (con
`ask_user` attivo nel frattempo). Chi clicca è `requestedByUserId`. Il deep
dive preventivo previsto dal programma è **saltato**: la pianificazione
esplora già il repo. Il pulse **non** rilancia job `held`/`failed` (hanno la
loro notifica) e non genera proposte con l'AI.

## 3. Cadenza, orario, configurazione

- **Poller nel worker** `apps/worker/src/pulse/poller.ts` (pattern
  daily-report): `PULSE_POLL_MINUTES` (default 15, 0 = off); itera
  `projects where pulse_enabled AND backlog_enabled`, best-effort per progetto.
- **Finestra oraria d'istanza**: `PULSE_TIMEZONE` (IANA, default `UTC`; prod:
  `Europe/Rome`), `PULSE_SEND_HOUR` (default 9), `PULSE_WEEKDAYS_ONLY`
  (default true). Il pulse parte solo nella finestra `[ora, ora+1)` locale nei
  giorni ammessi → quiet hours per costruzione ("standup", non allarme).
  Conversione con `Intl.DateTimeFormat`/`Temporal`-free (nessuna dipendenza
  nuova): `now` iniettabile nei test.
- **Per progetto**: colonne `pulse_enabled` (bool, default false),
  `pulse_every_days` (int, default 3, 1..30), `pulse_last_sent_at`
  (timestamptz null). Gate: si manda se `last_sent_at IS NULL OR < now() -
  every_days`; **`pulse_last_sent_at` aggiornato nella stessa transazione
  dell'inserimento della notifica** con UPDATE condizionato sul valore letto
  (idempotenza fra tick/worker). Form progetto: toggle + numero, disabilitati
  con hint se `backlogEnabled` è off; PATCH/schemi/proiezione nei 5 punti.
- **Sostituzione**: al ping nuovo, le copie `open` del pulse precedente dello
  stesso progetto passano a `handled` (senza attore: "sostituita") nella
  stessa transazione.
- Snooze personale, come sempre.

## 4. Notifica `project.pulse`, azione `answer` generalizzata, "Procedi"

- **Kind `project.pulse`** (13°): audience **`broadcast`** (admin ∪ follower;
  senza ticket → assignee assente), toggle webhook `notifyPulse`.
  **Payload modellato sulla domanda**: `question` ("Nessun lavoro in corso su
  {project} da {idleDays} giorni. Da quale proposta partiamo?"), `options`
  (label = titolo voce, consequence = contesto), `recommendedIndex: 0`,
  `allowFreeText: false` + campi propri `projectName`, `projectUrl` (pagina
  backlog del progetto), `idleDays`, `proposals: [{ backlogItemId, title,
  urgency, effort, hasAnalysis }]`. Così schema, pannello web, blocchi Slack e
  modal funzionano invariati.
- **`answer` per-kind** (in `packages/notifications/src/actions.ts`): Set
  `KINDS_WITH_OPTIONS = {job.awaiting_input, project.pulse}`; `stateAllows`:
  awaiting_input → job `awaiting_input`; pulse → notifica `open` (nessun
  job); `actorAllows`: pulse → ogni destinatario. `CATALOG_FOR_KIND["project.pulse"]
  = { decisions: ["answer"], adminOnly: false, archivable: true }` (ignorare
  un suggerimento è legittimo). `renderItem` e il ternario del poller Slack
  usano il Set. `executeAction("answer")` dispatcha per kind: `answerQuestion`
  oppure `proceedWithProposal`.
- **`proceedWithProposal`** (`apps/server/src/services/pulse.ts`): valida
  `optionIndex` contro `proposals` del payload; la voce deve essere ancora
  convertibile (altrimenti `proposal_stale`); **`convertBacklogItem`**
  (nuovo `apps/server/src/services/backlog.ts`, estratto dalla rotta con il
  claim anti-TOCTOU: il primo click vince; la rotta HTTP lo riusa) →
  `startRun({ ticketId, actor, requirePlanApproval: true, publicUrl })`
  (estensione di `startRun`: il flag forza `planApprovalRequired` e il
  parcheggio diretto se c'è un piano, anche per admin) → `propagateDecision`
  su tutte le copie con nota "▶️ {actor} ha avviato «{titolo}»" + DM riscritti.
  Esito alla card: link al ticket. Errori: `proposal_stale`, `already_handled`,
  `job_in_flight` (mappato), `forbidden`, `not_found`.
- **Rilancio manuale (decisione: opzione 1 della voce `8931d96d`)**: le
  decisioni già prese (Q&A risposte del job) sono **sempre iniettate** nel
  prompt di pianificazione quando esistono, a prescindere da `resumeMode`;
  il budget dei round resta per-job. Vale anche per il caso "timeout in
  ripresa → failed → rilancio".

## 5. Superfici

- **Inbox web**: card `project.pulse` → `QuestionPanel` invariato (prima
  opzione "consigliata", conferma a due passi con etichetta "Avvia", niente
  "Altro…"); header con progetto, "fermo da N giorni", link "Apri backlog";
  post-esito "▶️ Avviato da X" + link al ticket. `INBOX_KIND_LABEL_KEYS`
  "Proposta". È in "Da decidere" (answer è decisionale).
- **Slack**: `buildQuestionBlocks` invariato (un bottone per opzione, click
  immediato); nota post-azione via propagazione.
- **Pagina progetto**: toggle `pulseEnabled` + `pulseEveryDays` nella form.
- **MCP `list_proposals`** (`packages/mcp`, read tool): `GET
  /api/inbox?status=open&kind=project.pulse` (nuovo filtro `kind` sulla
  lista inbox) → stampa progetto, opzioni con contesto, id notifica; la
  descrizione dichiara che serve a *sapere* (si risponde da web/Slack). La
  skill `stubwise` lo cita all'apertura di sessione.

## 6. Coerenza (censimento)

Kind nuovo: tre liste + Record esaustivi (EMOJI 📣, KEY_FOR_KIND,
formatGeneric, TOGGLE_FOR_KIND, AUDIENCE_FOR_KIND, CATALOG_FOR_KIND, openUrl →
`projectUrl`, INBOX_KIND_LABEL_KEYS, LABEL_KEY, NOTE_KEY, sampleEvents, i18n
`notify.pulse`, settings toggle 6 punti + UI). `hasTicket()`: il pulse NON ha
ticket (aggiungere a `NonTicketedEvent`). Progetto: 5 punti dello schema +
form. `startRun`: nuovo input opzionale, nessun cambio di comportamento senza
il flag.

## 7. Config e guardrail

`PULSE_POLL_MINUTES` (15), `PULSE_TIMEZONE` (UTC), `PULSE_SEND_HOUR` (9),
`PULSE_WEEKDAYS_ONLY` (true); per progetto `pulse_enabled` (off),
`pulse_every_days` (3). Idempotenza via `pulse_last_sent_at` in transazione;
sostituzione dei ping precedenti; il claim del convert protegge dal doppio
"Procedi"; `requirePlanApproval` garantisce che nulla venga eseguito senza
approvazione. Nessun costo AI fino al click.

## 8. Test

Poller (fermo/non-fermo per ciascun segnale; ranking; finestra oraria e fuso
con `now` iniettabile, weekend; cadenza e transazione; sostituzione ping
precedenti; progetti senza backlog ignorati; 0/1/2/3+ candidati); kind
(parità a tre vie, Record, routing broadcast senza ticket); `answer` per-kind
(tabelle `stateAllows`/`actorAllows`, dispatch in `executeAction`);
`convertBacklogItem` (rotta invariata, claim); `proceedWithProposal`
(`proposal_stale`, corsa `Promise.all`, run con approvazione anche admin,
propagazione, `requestedByUserId`); rilancio con decisioni iniettate
(worker); web/Slack con kind pulse; `list_proposals` + filtro `kind`.

## 9. Deploy e rollback

Rebuild server+worker+caddy insieme (migrazione **0065**: `ALTER TYPE
notification_kind ADD VALUE 'project.pulse'`, `notify_pulse`, 3 colonne
progetto). Env in prod: `PULSE_TIMEZONE=Europe/Rome`; le altre a default.
Attivazione per progetto dal toggle. Rollback additivo: con `PULSE_POLL_MINUTES=0`
il pulse tace.

## 10. Fuori scopo (v2+)

Promemoria sulle decisioni scadute; proposte generate/riassunte dall'AI;
rilancio dei job fermi dal pulse; risposta al pulse dal terminale MCP; fuso
orario per utente; deep dive automatico pre-conversione.
