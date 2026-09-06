---
title: Fase 5 — Roadmap e narrativa
date: 2026-09-06
status: validato (brainstorming)
program: 2026-08-31-stubwise-nerve-center-program-design.md
stubwise:
  project: stubwise
  backlog: fd5129d8-347e-457a-9da8-86cfd7355b67
---

# Fase 5 — Roadmap e narrativa

Sesta fase del programma. Dà a chi non legge codice il "dove siamo" di ogni
progetto: riassunti in linguaggio umano di piani e PR nelle card, una
timeline di progetto (milestone, ticket, PR, report, decisioni), un brief
settimanale scritto per non-tecnici e inoltrabile, e un registro delle
decisioni prese dagli umani, dentro i Docs di progetto.

## 1. Stato di partenza (fatti verificati)

- **Nessuna narrativa di progetto.** Il pulse (`apps/worker/src/pulse/poller.ts`)
  non usa AI: ranking deterministico e domanda da template. L'unico testo AI
  di progetto è `activity_reports.summary` (giornaliero), generato in
  `apps/worker/src/reports/daily-report-poller.ts` con prompt "per
  sviluppatori" e **"Scrivi in ITALIANO" cablato** (`:184-275`), provider
  pinnato del progetto altrimenti `chain[0]`, `permissionMode "plan"`,
  cwd mirror bare, `SUMMARY_INPUT_MAX_CHARS = 80_000` con marcatore di
  troncamento (`cappedCommitList`). Il pattern "run di solo testo" è
  **triplicato** (`textFromRun` nel report, `outputOrThrow`/`parseAgentJson`
  in `backlog/intake.ts` e `backlog/estimate.ts`); non esiste un helper.
- **Il piano non arriva alle card.** `JobPlanReviewEvent`
  (`packages/notifications/src/format.ts:76-82`) porta solo ticket/progetto/
  url; la card web (`inbox-item.tsx:380`) e mobile (`PlanReviewCard.tsx:66`)
  mostrano `item.text`; l'app mostra il piano intero troncato a 4 righe sotto
  il titolo "Il piano, in breve" (`PlanSection.tsx:54-56`). Il piano vive in
  `ai_jobs.plan_text` (`schema.ts:726`), scritto solo da `parkForPlanApproval`
  (`apps/worker/src/queue.ts:276-292`, UPDATE guardato) e azzerato al rifiuto
  (`services/jobs.ts:291`); il replan crea una **notifica nuova**. Un job
  parcheggiato dal server con piano ereditato (`jobs.ts:199-218`) non passa
  dal worker.
- **PR**: `ai_jobs.pr_url` è l'unico campo PR sul job; lo stato per-repo è in
  `ticket_repositories.pr_state`; la review AI è in `pr_reviews` (`verdict`,
  `summary` markdown, `pr_title`, `head_sha`, `ticket_id` SET NULL) scritta da
  `apps/worker/src/review/run-review.ts:715-731`, con `pr_body`/`pr_title`
  già in `pr_review_jobs`. **Nessuna rotta legge `pr_reviews`.**
- **Timeline**: esiste già per ticket, `GET /api/tickets/:id/activity`
  (`routes/tickets.ts:653-714`, `discriminatedUnion` di commenti, eventi e
  job, fusi in memoria). `ticket_events` (`schema.ts:644`) è scritto **solo**
  da `routes/tickets.ts`: le transizioni fatte dal webhook
  (`routes/webhooks.ts:416,551,600`) e dal worker non lasciano traccia.
  Nessun `closed_at`/`done_at` su ticket e milestone.
- **Milestone**: `milestones` (`schema.ts:464-489`) con `repository_id NOT
  NULL` "tenuto per continuità"; **la creazione dalla web app è rotta**: la
  UI (`milestone-manager.tsx:43-49`) non manda `repositoryId`, che il server
  esige (`routes/milestones.ts:50`); mascherato nei test da un wrapper e da un
  mock. Nessun tool MCP milestone. Manca `description`, `closed_at`.
- **Pagina progetto**: `/projects/$projectId` è configurazione; la home per
  non-tecnici è `/docs/project/$projectId` (`ProjectDocsLanding`). "Brief" è
  un nome già preso: il *project brief* di documentazione
  (`projectBriefSchema`, tab `/docs/$projectId/brief`).
- **Decisioni**: l'unica fonte strutturata (domanda, alternative con
  conseguenza, scelta, attore, timestamp) è `agent_questions`
  (`schema.ts:2633-2685`, `answered_by_user_id` SET NULL). Approvazione/
  rifiuto del piano (`services/jobs.ts:267-340`) lasciano solo commenti
  (`user` con le istruzioni, `system` senza attore) e `handled_by_user_id`
  sulle notifiche; "Procedi" del pulse (`services/pulse.ts:177-315`) idem;
  merge/chiusura PR dal webhook **senza attore**; `backlog_chat_messages`
  senza `user_id`.
- **Docs**: `doc_pages.repository_id NOT NULL` (nessuna pagina di progetto);
  le pagine persistenti (manuali e release, `generation_id IS NULL`)
  sopravvivono alle rigenerazioni ma **non sono embeddate**
  (`embedAndStoreChunks` gira solo da finalize e auto-update, e pretende un
  `generationId`): raggiungibili solo full-text, config `'english'`, score
  sempre sotto i match semantici. La chat di progetto ha un solo punto di
  innesto per contesto extra, fail-open: `appendGraphContext`
  (`apps/server/src/graph-chat/context.ts:133`), usato in
  `project-docs.ts:420-431`, `docs-chat.ts`, `docs-rag.ts`.
- **Compatibilità client**: ogni risposta letta dall'app passa da
  `readerSchema` (enum aperti → `UNKNOWN`), gli schemi di risposta sono
  `z.object` strip: **campi opzionali nuovi sono sempre sicuri**; un
  `notification_kind` nuovo va allineato in tre liste e le app vecchie lo
  vedono `UNKNOWN`. Modifiche a `packages/shared` richiedono un changeset.
- **Rollback (lezione fase 2)**: un kind nuovo in `notifications` fa fallire
  `/api/inbox` intera sul binario server precedente finché esistono righe
  con quel kind.

## 2. Perimetro (deciso)

Dentro: (1) riassunti "in breve" di piano e PR; (2) timeline di progetto con
pagina web "Roadmap", più due riparazioni a monte (milestone, audit degli
eventi di sistema); (3) brief settimanale per progetto con poller, kind di
notifica `project.brief`, pagina web, API per l'app, tool MCP; (4) registro
decisioni `project_decisions` con writer automatici, voci manuali, sezione
nei Docs di progetto, contesto nella chat, tool MCP.

Fuori (v1): canale email; UI per "superata" oltre il campo; narrativa per
milestone; kind nuovi di `ticket_events`; Gmail come fonte (fase 6); vista
roadmap mobile; tool MCP per la timeline.

**Due ondate**: ondata 1 = server + worker + web (beneficia subito anche
l'app installata: `summary` opzionale, brief nel dettaglio progetto tramite
rotta nuova letta dall'app dell'ondata 2); ondata 2 = rilascio mobile che
legge i campi nuovi. La fase non dipende da un passaggio in store.

## 3. Riassunti "in breve"

- **Colonne**: `ai_jobs.plan_summary text NULL`, `pr_reviews.pr_summary text
  NULL`. Best-effort come ogni colonna AI del repo: run fallito → `NULL`, il
  flusso non degrada.
- **Helper** `runAgentText(runner, { prompt, cwd?, model?, provider?,
  timeoutMs, maxChars? })` in `apps/worker/src/agent/text.ts`: `permissionMode
  "plan"`, `maxTurns 3`, cwd `mkdtemp` se assente, `null` su `exitCode ≠ 0` o
  output vuoto; più `parseAgentJson` condiviso. Report, intake e stima lo
  adottano (refactor senza cambi di comportamento).
- **Piano**: in `apps/worker/src/pipeline/fix.ts` il testo viene generato
  **prima** di `parkForPlanApproval` (fuori da ogni transazione, dopo la
  chiusura dei worktree) e passato a `parkForPlanApproval({ planText,
  planSummary })`, che lo scrive **nello stesso UPDATE guardato**: nessun
  riassunto su un job non più nostro. Poi la notifica. Il ramo server
  (`jobs.ts:199-218`) pubblica senza riassunto in v1. `resolvePlan(mode:
  "fix")` azzera `plan_text` **e** `plan_summary`.
- **PR**: in `run-review.ts` dopo `parseReviewOutput` e dopo il cap di costo,
  dentro la transazione che scrive `verdict`/`summary`. Input: `pr_title`,
  `pr_body`, verdetto, analisi (sotto tetto). PR senza review → nessun
  riassunto.
- **Prompt**: lingua = `getContentLanguage(db)` interpolata (mai "ITALIANO"
  cablato); tono per non-tecnici; input troncato con marcatore; lunghezza
  fissa: piano = tre frasi (cosa cambia per l'utente, cosa tocca, cosa resta
  fuori); PR = due frasi (cosa fa, verdetto della review in parole). Modello
  `SUMMARY_MODEL` (default = modello della review); `SUMMARIES_ENABLED`
  (default true) spegne la sola generazione.
- **Consegna**: `inboxItemSchema.summary?: string` (pattern di `question`/
  `pulse`), riempito dal server per `job.plan_review` (da `ai_jobs`) e
  `job.pr_opened`/`review.completed` (da `pr_reviews` per url/ticket);
  `ticketDetailSchema.planSummary?`; `aiJobSchema.planSummary?`; nel payload
  webhook come campo nuovo di `formatGeneric`; Slack in una `section`
  separata con `escapeSlackMrkdwn` (testo generato su input non fidato).
  Web: la card del piano mostra il riassunto sopra Approva/Rifiuta; la card
  PR sotto il testo. App (ondata 2): `PlanSection` legge `planSummary` con
  fallback al piano troncato; `PrReadyCard` mostra `summary`.

## 4. Timeline di progetto

- **Riparazione milestone**: `milestones.repository_id` → nullable;
  `description text NULL`, `closed_at timestamptz NULL` (impostato quando
  `status` passa a `closed`); `POST /api/milestones` con `repositoryId`
  opzionale; `MilestoneDraft` web coerente; i test smettono di iniettare il
  campo. `milestoneSchema` promosso in `packages/shared`.
- **Riparazione audit**: helper `recordTicketStatusChange(tx, { ticketId,
  from, to, actorId: null })` in `packages/db` (o servizio condiviso) usato da
  `routes/webhooks.ts` (merge → `done`, close → `triaged`, chiusura ticket)
  e dal worker dove cambia `tickets.status` (`fix.ts` in_progress/in_review,
  intake). Kind `status_changed` esistente, `actor_id NULL` = sistema.
  **Backfill** una tantum (script idempotente, non migrazione): per i ticket
  `done` senza evento `status_changed → done`, un evento datato
  `ai_jobs.finished_at` del job `pr_merged` (o `tickets.updated_at`).
- **Rotta** `GET /api/projects/:id/timeline?from=&to=&kinds=` (registrata
  **prima** di `/:projectId`), risposta `projectTimelineSchema` =
  `discriminatedUnion("kind")` di: `ticket_opened`, `ticket_done`,
  `milestone_due`, `milestone_closed`, `pr_opened`, `pr_merged`, `pr_closed`
  (con `reviewVerdict?`, `prSummary?`, `prUrl`), `report_day` (data +
  `summary`), `decision` (id, titolo, decisione, attore), `brief` (id,
  periodo, prima sezione). Default `to = oggi`, `from = to − 28 giorni`,
  massimo 180 giorni. Fusione in memoria di 6-7 query (una per sorgente,
  nessuna N+1), ordine `at ASC` con tie-break su id. Member: solo progetti
  seguiti o di cui è membro; admin: tutti.
- **Rotta** `GET /api/projects/:id/reviews` (prima lettura di `pr_reviews`),
  usata dalla timeline e dall'app.
- **Web**: `/projects/:id/roadmap` (link dal dettaglio progetto e dalla
  home Docs del progetto): milestone aperte con scadenza e avanzamento
  (`counts` già dal server), poi la timeline raggruppata per settimana, coi
  brief come separatori; filtri per kind; sola lettura.
- **App (ondata 2)**: `lib/timeline.ts` prende le date dei passi "piano
  approvato" e "PR e review" dagli eventi (`/tickets/:id/activity`) e il
  verdetto da `/projects/:id/reviews`.

## 5. Brief settimanale

- **Tabella** `project_briefs`: `id`, `project_id` (cascade), `period_start
  date`, `period_end date`, `status text` (`queued|running|done|failed`,
  CHECK), `error`, `summary text NULL` (markdown completo), `sections jsonb
  NULL` (`{ whereWeAre, whatChanged, whatBlocks, whatWeNeed }`),
  `notification_id uuid NULL` (SET NULL), `attempts`, `last_activity_at`,
  `created_at`, `finished_at`; unique `(project_id, period_start)`.
  `projects.weekly_brief_enabled bool default false` (indipendente dal
  backlog).
- **Poller** `apps/worker/src/briefs/poller.ts` sul modello del daily report:
  finestra `BRIEF_WEEKDAY` (1..7, default 1) + `BRIEF_SEND_HOUR` (default 9)
  nel fuso `PULSE_TIMEZONE`; `BRIEF_POLL_MINUTES` (default 15, **0 = spento =
  rollback innocuo**). Per ogni progetto abilitato senza brief `done` per la
  settimana precedente: claim guardato (`queued → running`), recovery degli
  orfani (`running` con `last_activity_at` vecchia → `queued`, max 3
  tentativi), `timer.unref`, stop su `AbortSignal`. Rigenerazione manuale
  `POST /api/projects/:id/briefs/generate` (admin, `force` per rifare).
- **Input** (sotto tetto, ordine fisso, troncamento marcato): riassunti
  giornalieri della settimana (`activity_reports.summary`, mai i commit),
  eventi della timeline del periodo, blocchi correnti dai segnali condivisi
  (`packages/notifications/src/project-signals.ts`: domande aperte, piani da
  approvare, PR aperte, job `held`/`failed`), decisioni del periodo, brief
  precedente (continuità). Prompt per non-tecnici nella lingua di contenuto,
  con regole: niente invenzioni, dato mancante = dichiarato, "cosa serve da
  voi" solo da blocchi reali; output in 4 sezioni con marcatori parseabili.
  Provider assente → brief `done` con `summary NULL` (come il report).
- **Notifica** `project.brief` (kind nuovo: enum Postgres `notification_kind`
  in statement proprio, unione in `@stubwise/notifications`,
  `notificationKindSchema`, `EMOJI`, `KEY_FOR_KIND`, `PUSH_TITLE_KEY`, toggle
  webhook `notifyBrief`): informativa, audience admin + follower, azioni solo
  `open`/`snooze`/`handled`, `archivable`. Payload: `projectName`,
  `projectUrl` (→ roadmap), `briefId`, `periodStart`, `periodEnd`,
  `headline` (prima frase di "dove siamo"). Pubblicata **dopo** il commit del
  brief; `notification_id` salvato sul brief. Slack: `section` col markdown
  del brief (escape) + bottone Apri. **Rollback documentato**: scendere di
  immagine sul server richiede prima di eliminare le righe `project.brief`
  da `notifications` (lezione fase 2). Sull'app installata il kind è
  `UNKNOWN` e degrada a card informativa: test dedicato.
- **Superfici**: `GET /api/projects/:id/briefs?limit=` e `GET
  /api/briefs/:id` (`projectBriefWeeklySchema`, nome distinto dal project
  brief dei Docs); web: vista del singolo brief con "Copia come testo"; app
  (ondata 2): sezione "Brief settimanale" nel dettaglio progetto; MCP
  `get_project_brief` (ultimo brief in markdown; changeset `@stubwise/mcp`
  minor).

## 6. Registro decisioni

- **Tabella** `project_decisions`: `id`, `project_id` (cascade), `source
  text` (`ask_user|plan_review|pulse|manual`, CHECK), `source_key text`
  (chiave idempotente, es. `question:<id>`, `plan_review:<jobId>:<n>`,
  `pulse:<notificationId>`), `source_ref jsonb` (id di origine), `ticket_id`
  (SET NULL), `title`, `context`, `decision`, `consequences` (text NULL),
  `decided_by_user_id` (SET NULL), `decided_at`, `superseded_by_id` (self,
  SET NULL), `created_at`; unique `(project_id, source_key)`.
- **Writer**, nella stessa transazione dell'evento d'origine, con testi da
  template i18n (`decision.*`) nella lingua di contenuto, **mai dall'AI**:
  - `answerQuestion` (`services/questions.ts`): titolo = domanda, decisione =
    etichetta scelta o testo libero, conseguenze = `consequence` dell'opzione,
    attore = chi risponde;
  - `resolvePlan`: approvazione → decisione "piano approvato" con
    `plan_summary` se presente; rifiuto con istruzioni → decisione = le
    istruzioni; rifiuto senza istruzioni → nessuna voce;
  - `proceedWithProposal`: decisione = voce scelta, contesto = alternative
    scartate, attore = `handled_by_user_id`.
  - Merge/chiusura PR: fuori (nessun attore).
- **Manuali**: `POST/PATCH /api/projects/:id/decisions` (member; modifica e
  `supersede` solo autore o admin). `GET /api/projects/:id/decisions?source=
  &limit=&cursor=`.
- **Docs**: sezione "Decisioni" nella home Docs di progetto
  (`project.$projectId.tsx`, accanto a "Novità", alimentata da `highlights`
  esteso con `latestDecisions`) e pagina `/docs/project/$projectId/decisions`
  (lista + form manuale). Non una `doc_page`: le pagine non conoscono i
  progetti, non entrano nell'embedding, non hanno attore strutturato.
- **Chat**: `retrieveDecisionContext(db, projectId, question)` fail-open
  (`string | null`) sul modello di `appendGraphContext`: ultime N decisioni
  del progetto per full-text (`to_tsvector('simple')` su titolo+decisione) e
  recency; appeso nei tre call site; nessuna citazione (la forma di
  `Citation` resta quella delle pagine).
- **MCP** `list_decisions` (per progetto, ultime N, con sorgente e attore).

## 7. Test e deploy

- **Test**: writer del registro (idempotenza su replay, attore, SET NULL
  alla cancellazione del ticket, nessuna voce su rifiuto senza istruzioni);
  `runAgentText`/`parseAgentJson` (e i tre adottanti invariati);
  `parkForPlanApproval` con riassunto nello stesso UPDATE, rifiuto che azzera
  entrambi; review con `pr_summary` nella stessa transazione; poller del
  brief (finestra/fuso, claim, recovery, input sotto tetto, provider assente,
  notifica dopo il commit); timeline (unione, finestra, ordine, filtri, ACL);
  reviews esposte; milestone (creazione senza repo, `closed_at`); audit dei
  webhook e backfill; `inboxItemSchema.summary` opzionale; card app con kind
  `UNKNOWN` → informativa; parità i18n; MCP tool. Nessun run AI vero nei
  test.
- **Deploy**: migrazione 0068 (statement `ADD VALUE 'project.brief'` a sé
  e mai usato nella stessa migrazione; colonne nullable su `ai_jobs`,
  `pr_reviews`, `milestones`, `projects`; tabelle `project_briefs`,
  `project_decisions`); rebuild **server + worker + caddy insieme**; env
  opzionali `BRIEF_POLL_MINUTES`, `BRIEF_WEEKDAY`, `BRIEF_SEND_HOUR`,
  `SUMMARY_MODEL`, `SUMMARIES_ENABLED`; script di backfill degli eventi da
  lanciare una volta; toggle brief per progetto; changeset per `shared` e
  `mcp`. **Rollback**: `BRIEF_POLL_MINUTES=0` e `SUMMARIES_ENABLED=false`
  innocui; immagine server precedente solo dopo aver eliminato le righe
  `project.brief`; worker precedente innocuo (i brief `running` restano
  orfani finché non torna il nuovo).
