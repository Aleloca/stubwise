---
title: Fase 0 — Fondamenta — Piano di implementazione
date: 2026-08-31
design: 2026-08-31-phase0-foundations-design.md
stubwise:
  project: stubwise
  backlogItem: 729af693-502c-4df0-9959-2eb72118f2c5 # https://stubwise.thecove.it/backlog/729af693-502c-4df0-9959-2eb72118f2c5
---

# Fase 0 — Fondamenta — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ruoli coerenti (maintainer/operator), inbox di notifiche azionabili per-utente con outbox multi-canale (webhook invariato + DM Slack con bottoni), e il tool MCP `run_ticket` + comando `/stubwise:run` per mandare l'esecuzione di un piano sul VPS.

**Architecture:** `publishNotification` (in `@stubwise/notifications`) sostituisce il dispatch fire-and-forget: persiste una riga `notifications` per destinatario e delle `notification_deliveries` che un poller del worker invia (webhook d'istanza come oggi, `chat.postMessage` in DM). Le azioni (approva/rifiuta piano, rilancia, snooze) passano da funzioni di servizio condivise (`apps/server/src/services/jobs.ts`, `services/inbox.ts`) usate da rotte REST, pagina `/inbox` e `block_actions` Slack. I permessi vengono corretti server-side sulle rotte esistenti. Design completo: `docs/plans/2026-08-31-phase0-foundations-design.md` (**LEGGILO PRIMA**, in particolare §1 per i file:linea di partenza).

**Tech Stack:** Drizzle/Postgres (migrazione 0063), Fastify + Zod, poller worker (`intervalSeconds` + `AbortSignal`, pattern `apps/worker/src/backlog/poller.ts`), Slack Web API (`chat.postMessage`, Block Kit), React + TanStack Query, MCP SDK (`packages/mcp`).

**Convenzioni trasversali (valgono per ogni task):**
- TDD: test prima, verifica che fallisca, implementa, verifica che passi, commit.
- Test singolo package: `pnpm --filter @stubwise/db test`, `pnpm --filter @stubwise/server exec vitest run <pattern>`, `pnpm --filter @stubwise/worker exec vitest run <pattern>`, `pnpm --filter @stubwise/notifications test`, `pnpm --filter @stubwise/mcp test`, `pnpm --filter @stubwise/web exec vitest run <pattern>` (NB: `pnpm ... test -- <pattern>` NON filtra, lancia tutta la suite; server/worker/db usano testcontainers: serve Docker attivo).
- Dopo aver modificato `packages/*`: `pnpm --filter @stubwise/<pkg> build` (server/worker leggono `dist`).
- Commit frequenti, messaggi `feat(scope):` / `fix(scope):` in italiano come lo storico.
- Prima del merge: `pnpm lint` + `pnpm typecheck` + `pnpm test` dalla radice (la CI fallisce su lint anche col resto verde).
- Commenti in italiano, stile del file circostante. i18n: chiavi backend in `packages/i18n/src/catalog.ts` (parità `en`/`it` verificata da test); chiavi web in `apps/web/src/i18n/locales/{en,it}.json` (test di parità `apps/web/src/i18n/parity.test.ts`).
- Lavora nel worktree dedicato (NON su main): `git rev-parse --abbrev-ref HEAD` prima di ogni commit.

---

## Fase A — Schema e permessi

### Task 1: Migrazione 0063 (colonne job, `notifications`, `notification_deliveries`, `project_follows`, `users.notify_slack_dm`)

**Files:**
- Create: `packages/db/drizzle/0063_inbox_foundations.sql` (+ aggiorna `packages/db/drizzle/meta/_journal.json` come fanno le migrazioni precedenti)
- Modify: `packages/db/src/schema.ts` (enum vicino a `notificationFormat` :858; tabelle in coda; colonne su `aiJobs` :~670 e `users` :224)
- Test: `packages/db/src/inbox-schema.test.ts` (nuovo, harness testcontainers di `packages/db/src/backlog.test.ts`)

**Step 1: test** — (a) `ai_jobs` accetta `requested_by_user_id` null e `plan_approval_required` default `false`; (b) inserisce `notifications` per due utenti con lo stesso `job_id` e rilegge per `job_id`; (c) `notification_deliveries` con `notification_id` null e `channel='webhook'` è valido; `status` rifiuta valori fuori enum; (d) `project_follows` rifiuta il duplicato (PK composta); (e) `users.notify_slack_dm` default `true`.

**Step 2:** `pnpm --filter @stubwise/db exec vitest run inbox-schema` → FALLISCE.

**Step 3: SQL**

```sql
ALTER TABLE ai_jobs
  ADD COLUMN requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN plan_approval_required boolean NOT NULL DEFAULT false;

ALTER TABLE users ADD COLUMN notify_slack_dm boolean NOT NULL DEFAULT true;

CREATE TYPE notification_kind AS ENUM (
  'ticket.created','job.pr_opened','job.pr_closed','job.held','job.plan_review',
  'job.budget_held','review.completed','job.failed','docs.limit_paused',
  'monitor.alert','monitor.recovered');
CREATE TYPE notification_status AS ENUM ('open','handled','snoozed');
CREATE TYPE delivery_channel AS ENUM ('webhook','slack_dm','slack_update');
CREATE TYPE delivery_status AS ENUM ('pending','sent','failed','skipped');

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,
  job_id uuid REFERENCES ai_jobs(id) ON DELETE CASCADE,
  kind notification_kind NOT NULL,
  event jsonb NOT NULL,
  status notification_status NOT NULL DEFAULT 'open',
  snoozed_until timestamptz,
  read_at timestamptz,
  handled_at timestamptz,
  handled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_open_idx ON notifications (user_id, created_at DESC) WHERE status = 'open';
CREATE INDEX notifications_job_id_idx ON notifications (job_id);

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid REFERENCES notifications(id) ON DELETE CASCADE,
  event jsonb,                       -- valorizzato solo per channel='webhook' (per evento, non per utente)
  channel delivery_channel NOT NULL,
  status delivery_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error text,
  external_ref text,                 -- ts del messaggio Slack (per aggiornarlo)
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX notification_deliveries_pending_idx ON notification_deliveries (next_attempt_at) WHERE status = 'pending';

CREATE TABLE project_follows (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);
```

⚠️ Trappola documentata in CLAUDE.md: il migratore esegue il batch in UNA transazione — nessun valore di enum appena creato va usato in una migrazione successiva dello stesso batch. Qui non serve.

**Step 4:** schema Drizzle speculare (`pgEnum` + `pgTable`, `jsonb` tipizzato `$type<NotificationEvent>` importando il tipo da `@stubwise/notifications/format` SOLO come `import type` — verifica che `@stubwise/db` non abbia dipendenza circolare: se `notifications` dipende da `db`, dichiara il tipo in `packages/shared` (`packages/shared/src/schemas/notification.ts`) e importalo da entrambi). Test → PASSA. `pnpm --filter @stubwise/db build`.

**Step 5:** commit `feat(db): migrazione 0063 — inbox, deliveries, follow, colonne job`.

### Task 2: Servizio job condiviso + permessi sulle rotte ticket

**Files:**
- Create: `apps/server/src/services/jobs.ts`
- Modify: `apps/server/src/routes/tickets.ts` (`run-ai` :1241-1312, `approve-plan` :1318, `reject-plan` :1340, `resumeFromPlanApproval` :1368-1424 → spostata nel servizio)
- Modify: `apps/server/src/routes/backlog.ts:1448` (`convert`: `requireAdmin` → `requireAuth`)
- Test: `apps/server/src/services/jobs.test.ts` (nuovo), `apps/server/src/routes/tickets.test.ts` (estendi :1247-1550), `apps/server/src/routes/backlog.test.ts` (convert per member)

**Step 1: test del servizio** — `startRun(db, { ticketId, actor, mode?, withInstructions? })`:
- admin + piano salvato → job `queued`, `resumeMode:"execute"`, `planText` = piano, `requestedByUserId` = actor, `planApprovalRequired:false`;
- member + piano salvato → job **`awaiting_plan_approval`** con `planText` = piano, `manualTrigger:true`, `requestedByUserId`;
- member senza piano → `queued`, `planApprovalRequired:true`;
- ultimo job in `queued|triaging|fixing|awaiting_plan_approval` → ritorna `{ error: "job_in_flight", status }` e NON tocca il job;
- ultimo job in `held|failed|pr_closed|skipped|pr_opened|pr_merged` → riusa la riga come oggi (verifica `startedAt/finishedAt/error` azzerati).
- `resolvePlan(db, { ticketId, actor, mode: "execute"|"fix", instructions? })`: member → `{ error: "forbidden" }`; admin senza job pendente → `plan_not_pending`; con `instructions` inserisce il commento del team con quel testo PRIMA del commento di sistema (così il re-plan lo legge come "Rilancia con istruzioni" — cerca nel worker come vengono raccolti i `teamComments` in `pipeline/fix.ts` e usa lo stesso `authorType`/campo).

**Step 2:** `pnpm --filter @stubwise/server exec vitest run services/jobs` → FALLISCE.

**Step 3: implementazione** — firma:

```ts
export type Actor = { id: string; role: "admin" | "member" };
export type StartRunResult =
  | { ok: true; jobId: string; status: "queued" | "awaiting_plan_approval" }
  | { ok: false; error: "ticket_not_found" | "job_in_flight"; jobStatus?: string };
export async function startRun(db: Db, input: { ticketId: string; actor: Actor; mode?: "ai_plan"; withInstructions?: boolean }): Promise<StartRunResult>;
export type ResolvePlanResult =
  | { ok: true; jobId: string }
  | { ok: false; error: "ticket_not_found" | "plan_not_pending" | "forbidden" };
export async function resolvePlan(db: Db, input: { ticketId: string; actor: Actor; mode: "execute" | "fix"; instructions?: string }): Promise<ResolvePlanResult>;
```

`IN_FLIGHT = ["queued","triaging","fixing","awaiting_plan_approval"] as const`. Sposta il corpo di `resumeFromPlanApproval` in `resolvePlan` (tieni i commenti di sistema hardcoded → passali per `t()` del catalogo con chiavi `comment.planApproved` / `comment.planRejected`, aggiungendole in `catalog.ts` en+it).

**Step 4: rotte** — `run-ai`: chiama `startRun`, mappa `job_in_flight` → **409** (aggiungi `409: errorSchema` allo schema di risposta) e ritorna `202 { jobId, status }`; `approve-plan`/`reject-plan`: `preHandler: requireAdmin`, `reject-plan` accetta body `{ instructions?: string }` nullish; `convert`: `requireAuth`. Aggiorna i test di rotta: member → 403 su approve/reject, 200 su convert, 202 con `status:"awaiting_plan_approval"` su run-ai con piano; 409 quando l'ultimo job è `fixing`. Test → PASSA.

**Step 5:** commit `feat(server): servizio job condiviso, permessi maintainer/operator, 409 job_in_flight`.

### Task 3: Worker — `planApprovalRequired` forza `plan-only`

**Files:**
- Modify: `apps/worker/src/pipeline/fix.ts:337-347` (`resolveFixMode`)
- Test: `apps/worker/src/pipeline/fix.test.ts` (cerca i test esistenti di `resolveFixMode`/`plan-only`)

**Step 1:** test: job con `planApprovalRequired:true`, effort 1, `planApprovalMinEffort` 5 → `"plan-only"`; con `resumeMode:"execute"` + `planText` → resta `"execute-only"` (il piano è già stato approvato). **Step 2:** fallisce. **Step 3:** aggiungi la condizione dopo il ramo `execute-only`. Assicurati che il tipo `Job` passato al worker includa la colonna (query di claim in `apps/worker/src/queue.ts:83-115`: se seleziona colonne esplicite, aggiungila). **Step 4:** passa. **Step 5:** commit `feat(worker): approvazione del piano obbligatoria per i job richiesti dagli operatori`.

---

## Fase B — Notifiche persistite

### Task 4: `publishNotification` + routing in `@stubwise/notifications`

**Files:**
- Create: `packages/notifications/src/publish.ts`, `packages/notifications/src/routing.ts`
- Modify: `packages/notifications/src/index.ts` (esporta `publishNotification`; `dispatchNotification` resta esportata ma marcata `@internal` per il canale webhook), `packages/notifications/src/dispatch.ts` (estrai `shouldSendWebhook(settings, kind)` e `sendWebhookEvent(db, event)` senza gating — il gating lo fa `publish`)
- Test: `packages/notifications/src/routing.test.ts` (puro), `packages/notifications/src/publish.test.ts` (testcontainers: copia l'harness da `packages/db/src/backlog.test.ts` — aggiungi `testcontainers` alle devDeps del package se manca, e un `vitest.config.ts` con `maxForks` come gli altri)

**Step 1: test routing (puro)** — `recipientsFor(event, ctx)` con `ctx = { admins: string[], followers: string[], requestedBy?: string, assignee?: string, reporter?: string }`:
- `job.plan_review` → solo admin; `job.pr_opened` → unione senza duplicati; `monitor.alert` → admin; `docs.limit_paused` → admin.

**Step 2: test publish (db)** — dati: 1 admin con `slackUserId`, 1 member follower senza slack, 1 member non follower; `publishNotification(db, prOpenedEvent, { projectId, ticketId, jobId })` →
- 2 righe `notifications` (admin + follower), `event` salvato intero, `kind` corretto;
- deliveries: 1 `slack_dm` (admin), 0 per il follower (nessun `slackUserId` → **nessuna riga**, non `skipped`: lo `skipped` è per chi ha il DM ma il bot non è configurato al momento dell'invio), 1 `webhook` con `event` copiato solo se `notification_settings.webhookUrl` è impostato e il toggle del kind è on (testa on/off);
- admin con `notifySlackDm=false` → nessuna `slack_dm`;
- `publishNotification` con `tx` passato inserisce nella transazione (test: rollback → nessuna riga);
- non lancia mai (db che fallisce → ritorna `{ published: 0 }`).

**Step 3:** fallisce. **Step 4: implementazione**

```ts
export interface PublishOpts { projectId?: string; ticketId?: string; jobId?: string }
export async function publishNotification(db: Db | Tx, event: NotificationEvent, opts: PublishOpts = {}): Promise<{ published: number }>
```
Risoluzione destinatari: admin (`users.role='admin'`), follower (`project_follows` per `opts.projectId`), `ai_jobs.requested_by_user_id`, `tickets.assignee_id`/`reporter_id` (verifica i nomi reali delle colonne in `schema.ts`). Per gli eventi senza ticket (`docs.*`, `monitor.*`) solo admin. `ticketId`/`jobId` non passati → prova a dedurli: NON farlo, i chiamanti li passano (vedi Task 5-6).

**Step 5:** passa; `pnpm --filter @stubwise/notifications build`. Commit `feat(notifications): publishNotification con inbox per-utente e outbox per canale`.

### Task 5: Sostituzione degli 11 punti di emissione

**Files:**
- Modify (server): `apps/server/src/ingest/processor.ts:390-409` (`ticket.created`), `apps/server/src/routes/webhooks.ts:623-630` (`job.pr_closed`)
- Modify (worker): `apps/worker/src/pipeline/notify.ts` (`notify()` chiama `publishNotification`; `NotifyDeps.dispatch` → `publish` iniettabile con la nuova firma), `pipeline/fix.ts` (:534, :577, :1269, :1373), `pipeline/triage.ts` (:135, :386), `monitor/alerts.ts` (:161/:168/:319/:336), `docs/recursive/node-dispatch.ts:341`, `review/run-review.ts:749`
- Test: aggiorna i test esistenti che iniettano `dispatch` (grep `dispatch:` in `apps/worker/src/**/*.test.ts` e `apps/server/src/ingest/*.test.ts`) alla nuova firma; aggiungi in un test del worker (es. `pipeline/fix.test.ts` per `pr_opened`) l'asserzione che `publish` riceva `{ projectId, ticketId, jobId }` corretti.

**Step 1:** aggiorna i test (falliscono). **Step 2:** cambia `notify()`:
```ts
export type PublishFn = typeof publishNotification;
export interface NotifyDeps { publicUrl?: string; projectName?: string; publish?: PublishFn }
export async function notify(deps, db, event, opts: PublishOpts): Promise<void>
```
e passa `opts` in ogni punto (`ticketId`/`jobId`/`projectId` sono sempre a portata di mano nella pipeline; per `monitor.*` passa `projectId` del server se esiste, altrimenti nulla). `job.pr_opened`: `costUsd` resta `null` come oggi. **Emissione NUOVA lato server**: in `apps/server/src/services/jobs.ts`, quando `startRun` parcheggia direttamente il job di un `member` in `awaiting_plan_approval` (piano salvato), nessuno emette `job.plan_review` (oggi lo emette solo il worker in `fix.ts:1269`): aggiungi `publishNotification(db, { kind:"job.plan_review", … }, { projectId, ticketId, jobId })` dopo il commit, con test (il maintainer deve ricevere la notifica). **Step 3:** test passano; `pnpm --filter @stubwise/worker typecheck`. **Step 4:** commit `refactor(notify): tutti gli eventi passano da publishNotification`.

### Task 6: Poller delle deliveries nel worker (canale `webhook`)

**Files:**
- Create: `apps/worker/src/notify/deliveries-poller.ts`
- Modify: `apps/worker/src/config.ts` (`NOTIFY_POLL_SECONDS`, default 5, pattern di `BACKLOG_POLL_SECONDS` :492), `apps/worker/src/index.ts` (avvio dopo `startLimitResumePoller`), `docker-compose.yml` (env commentata con default)
- Test: `apps/worker/src/notify/deliveries-poller.test.ts` (testcontainers, pattern `apps/worker/src/backlog/chat-turn-poller.test.ts`)

**Step 1: test** — `processDeliveriesOnce(deps)`: (a) claim di una `webhook` pending → chiama `sendWebhookEvent(db, event)` iniettato → `sent` + `sentAt`; (b) invio che lancia → `attempts=1`, `next_attempt_at ≈ now+30s`, resta `pending`; (c) al 5° fallimento → `failed` con `error`; (d) due chiamate concorrenti non processano la stessa riga (`FOR UPDATE SKIP LOCKED`, test con due transazioni come in `queue.test.ts`); (e) `intervalSeconds ≤ 0` → `startDeliveriesPoller` non avvia nulla.

**Step 2:** fallisce. **Step 3:** implementa con `claimDue(db, limit=20)` (UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING), `backoffMs(attempt) = 30_000 * 2 ** attempt`, `MAX_ATTEMPTS = 5`; dispatcher per canale: `webhook` → `sendWebhookEvent`; `slack_dm`/`slack_update` → per ora `skipped` con `error:"channel_not_implemented"` (Task 9 li implementa). Il poller usa il logger del worker e non lancia mai. **Step 4:** passa. **Step 5:** commit `feat(worker): poller delle notification_deliveries (canale webhook)`.

---

## Fase C — Inbox: API

### Task 7: Servizio inbox (azioni calcolate, esecuzione, propagazione `handled`)

**Files:**
- Create: `apps/server/src/services/inbox.ts`
- Test: `apps/server/src/services/inbox.test.ts`

**Step 1: test** —
- `actionsFor(notification, jobStatus, actor)`: `job.plan_review` + job `awaiting_plan_approval` + admin → `["approve_plan","reject_plan","open","snooze","handled"]`; stesso con member → `["open","snooze","handled"]`; `job.plan_review` con job già `fixing` → niente approve/reject; `job.budget_held` member → niente `relaunch`; `job.held` member → `relaunch`; `job.pr_opened` → `open` (+ snooze/handled).
- `executeAction(db, { notificationId, action, actor, payload? })`: `approve_plan` → chiama `resolvePlan` (Task 2) e marca `handled`+`handledBy` su TUTTE le righe con stesso `jobId`+`kind`; ripetuto → `{ error: "already_handled", handledBy }`; `snooze` con `until:"1h"|"tomorrow"|"3d"` → `snoozed` + `snoozedUntil`; `handled` manuale → solo la propria riga; `relaunch` → `startRun` (409 mappato a `job_in_flight`); azione non ammessa per ruolo → `forbidden`; notifica di un altro utente → `not_found`.
- `listInbox(db, { userId, status, projectId, limit, cursor, lang })` → snoozate scadute tornano `open` (UPDATE lazy prima della SELECT), `text` prodotto con `formatNotification(event, "generic")`… → usa `formatNotificationText(event, lang)` (aggiungi in `format.ts` un formato `plain` che ritorna solo il testo mrkdwn-free se non esiste già: verifica `format.ts:402-485`).
- `unreadCount(db, userId)`.

**Step 2:** fallisce. **Step 3:** implementa (`ActionId = "approve_plan"|"reject_plan"|"relaunch"|"open"|"snooze"|"handled"`; l'`open` non è eseguibile server-side: `executeAction("open")` → `invalid_action`). **Step 4:** passa. **Step 5:** commit `feat(server): servizio inbox — azioni calcolate ed esecuzione condivisa`.

### Task 8: Rotte `/api/inbox` e `/api/me/{follows,notification-prefs}`

**Files:**
- Create: `apps/server/src/routes/inbox.ts`, `apps/server/src/routes/me-prefs.ts`
- Modify: `apps/server/src/app.ts` (register con prefix `/api/inbox` e `/api/me`), `packages/shared/src/schemas/notification.ts` (schemi Zod di `InboxItem`, `InboxAction`, `SnoozeUntil`, `NotificationPrefs`; esporta da `index.ts`)
- Test: `apps/server/src/routes/inbox.test.ts`, `apps/server/src/routes/me-prefs.test.ts` (pattern `tickets.test.ts`: `buildApp` + login)

**Step 1: test** — 401 senza auth; `GET /api/inbox` lista solo le proprie, con `actions` e `text`; `GET /api/inbox/unread-count`; `POST /:id/read`; `POST /:id/snooze {until:"1h"}`; `POST /:id/handled`; `POST /:id/actions/approve_plan` admin → 200 e job `queued`; member → 403; già gestita → 409 `{ code:"already_handled", handledBy:{ id, email } }`; `POST /:id/actions/reject_plan { instructions }`; `GET/PUT /api/me/follows` (`{ projectIds: string[] }`, PUT sostituisce l'insieme); `PUT /api/me/notification-prefs { slackDm:false }` → `users.notify_slack_dm=false`.

**Step 2:** fallisce. **Step 3:** implementa (schemi in `shared`, `apiError` per gli errori, cursor = `createdAt|id` come le liste esistenti — vedi `routes/backlog.ts` list). **Step 4:** passa. **Step 5:** `pnpm --filter @stubwise/shared build`; commit `feat(server): API inbox, follow dei progetti e preferenze notifiche`.

---

## Fase D — Slack interattivo

### Task 9: `SlackClient.postMessage` + canale `slack_dm` nel poller

**Files:**
- Modify: `apps/server/src/slack/api.ts` (aggiungi `postMessage({ channel, text, blocks }) → { ts }` con `chat.postMessage` json, e `updateMessage`/`chat.update` per `slack_update`), **spostando `SlackClient` in `packages/notifications/src/slack-client.ts`** (o in `packages/shared`) se il worker non può importarlo da `apps/server` — verifica: il worker NON dipende da `apps/server`; sposta il client (con `loadSlackCreds` da `apps/server/src/slack/creds.ts`) in `packages/notifications` e ri-esportalo dal server per non toccare le rotte esistenti
- Create: `packages/notifications/src/slack-blocks.ts` (`buildInboxBlocks(text, actions, notificationId)`: `section` mrkdwn + `actions` con `button` per `approve_plan`/`reject_plan`/`relaunch`/`handled` e `static_select` per snooze; `action_id = "inbox:<action>"`, `value = notificationId`; bottone `open` = `url`)
- Modify: `apps/worker/src/notify/deliveries-poller.ts` (canale `slack_dm`: carica creds; se assenti → `skipped`; risolve `users.slackUserId` del destinatario; calcola `actionsFor` — sposta `actionsFor` in `packages/notifications/src/actions.ts` così server e worker la condividono — e invia; salva `ts` in `external_ref`; `slack_update` → `chat.update` con blocchi senza bottoni + riga "✅ …")
- Test: `packages/notifications/src/slack-blocks.test.ts` (snapshot dei blocchi), `apps/worker/src/notify/deliveries-poller.test.ts` (aggiungi: `slack_dm` con client mock → `sent` + `external_ref`; senza creds → `skipped`; errore API `channel_not_found` → `failed` subito senza retry, altri errori → retry)

**Step 1:** test (falliscono). **Step 2:** implementa. **Step 3:** passa; build di `notifications`. **Step 4:** commit `feat(slack): DM con bottoni Block Kit per le notifiche azionabili`.

### Task 10: `block_actions` e modal di rifiuto

**Files:**
- Modify: `apps/server/src/slack/routes.ts` (`/interactions` :457-668: branch `block_actions` prima del fallback :666; branch `view_submission` con `callback_id = "inbox_reject_plan"`), `apps/server/src/slack/modal.ts` (nuovo builder `buildRejectPlanModal(notificationId)`)
- Test: `apps/server/src/slack/routes.test.ts` (estendi: firma non valida → 401; utente Slack non linkato → ack + `postResponse` ephemeral "collega l'account"; `inbox:approve_plan` admin → ack 200 entro la risposta, poi `executeAction` chiamato e `postResponse` con `replace_original:true` e testo contenente "✅"; member → ephemeral con errore `forbidden`; già gestita → ephemeral "gestita da X"; `inbox:snooze` con `selected_option.value="tomorrow"`; `inbox:reject_plan` → `views.open` con il modal; `view_submission` del modal → `executeAction` con `instructions`)

**Step 1:** test. **Step 2:** implementa: parsing `payload.actions[0]` (`action_id`, `value`, `selected_option`), risoluzione utente con `resolveReporterBySlackId` (+ fallback email via `users.info` come nel ticket modal, senza auto-link), ack immediato, lavoro in `setImmediate` con `postResponse(response_url, …)`. Enqueue una delivery `slack_update` per le altre copie (`external_ref` noti). **Step 3:** passa. **Step 4:** commit `feat(slack): block_actions — azioni dell'inbox dai bottoni DM`.

### Task 11: Guida Slack e pagina impostazioni

**Files:**
- Modify: `apps/docs/src/content/docs/integrations/slack.md` (scope `chat:write`, `im:write`; sezione "Notifiche in DM"; reinstallazione dell'app → nuovo token), `apps/web/src/routes/settings/slack.tsx` (nota sugli scope), `apps/web/src/components/notifications-section.tsx` (paragrafo: "il webhook resta il canale di gruppo; i DM personali si attivano dall'account")
- Test: nessuno (docs); `pnpm --filter @stubwise/docs build` deve passare.

Commit `docs(slack): scope chat:write/im:write e DM delle notifiche`.

---

## Fase E — Web UI

### Task 12: API client, query, i18n

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`getInbox`, `getInboxUnreadCount`, `postInboxRead/Snooze/Handled/Action`, `getMyFollows`, `putMyFollows`, `putNotificationPrefs`), `apps/web/src/lib/queries.ts` (`inboxQueryOptions(filters)`, `inboxUnreadQueryOptions()` con `refetchInterval: 30_000`; `ticketJobsQueryOptions` :191-196 → `refetchInterval: (q) => latest in queued|triaging|fixing ? 5_000 : false`), `apps/web/src/i18n/locales/{en,it}.json` (namespace `inbox.*`, `common:nav.inbox`, etichette ruolo `team.role.admin = "Maintainer"`, `team.role.member = "Operatore"` — trova le chiavi attuali del ruolo in `routes/team.tsx`)
- Test: `apps/web/src/lib/queries.test.ts` (refetchInterval adattivo dei job), parità i18n.

Commit `feat(web): client e query dell'inbox, polling adattivo dei job, etichette ruolo`.

### Task 13: Campanella + pagina `/inbox`

**Files:**
- Create: `apps/web/src/routes/inbox.tsx`, `apps/web/src/components/inbox-item.tsx`, `apps/web/src/components/inbox-bell.tsx`
- Modify: `apps/web/src/components/app-layout.tsx` (`NAV_ITEMS` + campanella nella sidebar e in `MobileTopBar`), `apps/web/src/router.tsx` (route `/inbox` sotto `authedRoute`, loader che prefetcha `inboxQueryOptions({status:"open"})`)
- Test: `apps/web/src/routes/inbox.test.tsx` (happy-dom, pattern `routes/activity.test.tsx`): sezioni *Da decidere*/*Da sapere*/*Snoozate*; bottoni presenti solo se in `actions`; `approve_plan` chiama l'API e la riga passa a "gestita"; `reject_plan` apre il campo istruzioni e invia `{ instructions }`; 409 mostra "gestita da X"; `apps/web/src/components/app-layout.test.tsx` (contatore visibile con `unread>0`).

Layout mobile-first: lista a una colonna, card con progetto (mono), testo, azioni in riga in fondo; ambra solo sulle azioni decisionali. Commit `feat(web): inbox azionabile e campanella`.

### Task 14: Gating ruolo nel dettaglio ticket, follow e preferenze

**Files:**
- Modify: `apps/web/src/routes/tickets/$id.tsx` (:487-509 bottoni Approva/Rifiuta solo `isAdmin`; "Rifiuta" apre campo istruzioni; per i member il bottone "Esegui con AI" ha sottotitolo "richiederà l'approvazione del piano"; gestisci il 409 di `run-ai` con toast), `apps/web/src/routes/settings/account.tsx` (sezioni "Progetti seguiti" con checkbox per progetto e "Notifiche in DM su Slack" — toggle disabilitato con hint se `me.user.slackUserId` è null), `apps/web/src/routes/projects/$projectId.tsx` (bottone "Segui/Non seguire"), `apps/web/src/routes/team.tsx` (etichette Maintainer/Operatore)
- Test: estendi `tickets/$id.test.tsx` (member non vede Approva; admin sì), `settings/account.test.tsx` (PUT follows).

Commit `feat(web): gating per ruolo, progetti seguiti, preferenze DM`.

---

## Fase F — MCP e comandi

### Task 15: Tool `run_ticket`

**Files:**
- Modify: `packages/mcp/src/client.ts` (`runTicket(id, body?) → { jobId, status }`, `listTicketJobs(id)`), `packages/mcp/src/tools/write.ts` (tool `run_ticket`), `packages/mcp/src/server.ts` (`SERVER_VERSION` da `package.json` via `createRequire`), `packages/mcp/README.md` se elenca i tool
- Test: `packages/mcp/src/tools/write.test.ts` (202 `queued` con piano → testo "verrà eseguito"; 202 `awaiting_plan_approval` → "attende l'approvazione"; 409 → "già un job in corso (fixing)"; 403 → messaggio permessi), `packages/mcp/src/server.test.ts` (15 tool), `client.test.ts` (parsing risposta)
- Create: `.changeset/run-ticket.md` (`"@stubwise/mcp": minor`)

Testo del tool (descrizione): "Avvia l'esecuzione del ticket sul worker Stubwise (POST run-ai). Con piano salvato esegue direttamente quel piano; se il tuo utente è operatore il job attende l'approvazione di un maintainer. Usa `mode: 'ai_plan'` per forzare triage+pianificazione anche con piano salvato." Commit `feat(mcp): tool run_ticket`.

### Task 16: Comando `/stubwise:run`, skill, docs, CLAUDE.md

**Files:**
- Create: `.claude/commands/stubwise/run.md` (frontmatter `description: Esegue un piano SU Stubwise — assicura il ticket, carica design e piano, lo mette in in_progress e lancia run_ticket (l'implementazione la fa il worker, non questa sessione).`; passi 1–2 copiati da `start.md`; passo 3 `set_ticket_status in_progress` + frontmatter + commit; passo 4 `run_ticket` e stampa dell'URL; nota finale: "NON implementare in locale: se l'utente voleva farlo, usa `/stubwise:start`")
- Modify: `.claude/skills/stubwise/SKILL.md` (§ "Tool MCP disponibili" +`run_ticket`; §8 riscritta; nuova § "Locale o Stubwise?" subito dopo "I flussi": `/stubwise:start` = implemento io qui; `/stubwise:run` = esegue il worker; quando l'utente dice "fallo fare a Stubwise / esegui sul VPS / lancia il run" → `run`), copia in `~/.claude/skills/stubwise/SKILL.md` e `~/.claude/commands/stubwise/run.md`
- Modify: `apps/docs/src/content/docs/integrations/claude-code-mcp.md` (riga `curl` per `run.md`; `run_ticket` nell'elenco tool; nota sui ruoli), `CLAUDE.md` (sezione "Integrazione Claude Code": comando `/stubwise:run`; sezione ruoli: `admin`=maintainer/`member`=operator, approve/reject solo admin)

Commit `docs(claude): comando /stubwise:run, skill aggiornata, docs MCP`.

---

## Fase G — Verifica finale

### Task 17: Verifica e note di deploy

1. `pnpm lint && pnpm typecheck && pnpm test` dalla radice: tutto verde (allega output).
2. E2E a mano (`apps/web/e2e`, Playwright): scenario "piano in attesa → approva dall'inbox" se lo stack E2E lo consente (il worker non è nello stack E2E: inserisci il job `awaiting_plan_approval` via seed/API e verifica inbox + approvazione → job `queued`).
3. Aggiorna `docs/plans/feature-backlog.md` (nuova voce "Programma centro nevralgico — Fase 0 ✅" con link) e `CLAUDE.md` § Deploy: "Fase 0: rebuild server+worker+caddy insieme; migrazione 0063; scope Slack `chat:write`+`im:write` e reinstallazione app; env opzionale `NOTIFY_POLL_SECONDS` (0 = spegne DM e webhook via poller)".
4. Aggiorna la voce di backlog/ticket Stubwise (skill `stubwise`: `in_review` a PR aperta).
5. Commit `docs: note di deploy fase 0`.

**Deploy (dopo il merge, a cura del maintainer):** backup DB → `git pull` → `docker compose up -d --build server worker caddy` → verificare la migrazione 0063 (`\dt notifications`) → app Slack: aggiungere scope, reinstallare, risalvare il bot token in Impostazioni → Slack → collegare gli account Slack degli utenti in `/team` → verificare un DM di prova (es. `job.plan_review` su un ticket di test).
