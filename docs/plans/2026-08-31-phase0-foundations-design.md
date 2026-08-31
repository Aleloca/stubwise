---
title: Fase 0 — Fondamenta (ruoli, inbox azionabile, Slack interattivo, run_ticket)
date: 2026-08-31
status: validato (brainstorming)
program: 2026-08-31-stubwise-nerve-center-program-design.md
stubwise:
  project: stubwise
  backlogItem: 729af693-502c-4df0-9959-2eb72118f2c5 # https://stubwise.thecove.it/backlog/729af693-502c-4df0-9959-2eb72118f2c5
---

# Fase 0 — Fondamenta

Prima fase del programma "centro nevralgico". Piccola per scelta: crea le
primitive che le fasi successive (`ask_user`, pulse, app mobile) riusano senza
modifiche di modello. Quattro componenti: **ruoli**, **inbox azionabile**,
**Slack interattivo**, **`run_ticket` + `/stubwise:run`**.

## 1. Stato di partenza (fatti verificati)

- Ruoli: enum `user_role = admin | member` (`packages/db/src/schema.ts:96`,
  `users.role` :228), globale; nessuna membership per progetto. `requireAuth`
  accetta PAT e cookie e il PAT eredita il ruolo (`apps/server/src/auth/session.ts:175-197`).
- Permessi incoerenti con il programma: `run-ai`, `approve-plan`, `reject-plan`
  sono `requireAuth` (`apps/server/src/routes/tickets.ts:1244, 1318, 1340`);
  `POST /api/backlog/:id/convert` è `requireAdmin` (`routes/backlog.ts:1448`).
- `run-ai` riscrive **incondizionatamente** l'ultimo job a `queued`, anche se
  è `triaging/fixing` (`tickets.ts:1290-1304`); il gate è solo client-side
  (`apps/web/src/routes/tickets/$id.tsx:259-276`).
- Notifiche: un solo webhook d'istanza (`notification_settings`, singleton
  id=1, `schema.ts:869-902`), fire-and-forget (`packages/notifications/src/dispatch.ts:176-195`),
  nessuna persistenza, nessun destinatario. 11 kind
  (`packages/notifications/src/format.ts:159-170`), testi i18n, formattazione
  pura riusabile dal web (`@stubwise/notifications/format`). Punti di
  emissione: server `ingest/processor.ts:390-409` (`ticket.created`),
  `routes/webhooks.ts:623-630` (`job.pr_closed`); worker via `pipeline/notify.ts:37-44`
  da `pipeline/fix.ts` (failed, budget_held, plan_review, pr_opened),
  `pipeline/triage.ts` (failed, held), `monitor/alerts.ts` (alert/recovered),
  `docs/recursive/node-dispatch.ts` (limit_paused), `review/run-review.ts` (review.completed).
- Slack: firma HMAC (`apps/server/src/slack/verify.ts`), `/api/slack/commands`
  e `/api/slack/interactions` (`slack/routes.ts:377-668`); `block_actions` è un
  ack vuoto (`routes.ts:666-667`); `SlackClient` ha solo `views.open`,
  `users.info`, `users.list` (`slack/api.ts`); scope attuali `commands`,
  `users:read`, `users:read.email`; credenziali cifrate in `instance_settings`
  (`schema.ts:935-936`); mapping Slack→utente via `users.slackUserId` o email
  (`ingest/reporter.ts`).
- SPA: nessuna campanella in `apps/web/src/components/app-layout.tsx`;
  `ticketJobsQueryOptions` senza `refetchInterval` (`apps/web/src/lib/queries.ts:191-196`).
- MCP: 14 tool (`packages/mcp/src/tools/{read,write}.ts`), nessuno lancia il
  run; `SERVER_VERSION = "0.1.0"` disallineato dal package (0.3.0). I comandi
  `/stubwise:init|start` vivono in `.claude/commands/stubwise/` e sono
  distribuiti via `curl` documentato in
  `apps/docs/src/content/docs/integrations/claude-code-mcp.md:107-131`.
- Ultima migrazione: 0062.

## 2. Ruoli e permessi

**Nessuna migrazione dell'enum.** `admin` = *maintainer*, `member` =
*operator*: cambiano solo le etichette i18n in UI (`/team`, account) e la
documentazione. Membership per progetto: no (YAGNI). I "progetti seguiti" sono
una preferenza dell'utente (vedi inbox), non un permesso.

Correzioni server-side:

| Azione | Oggi | Fase 0 |
| --- | --- | --- |
| `approve-plan` / `reject-plan` | qualsiasi utente | **solo admin** (403 per member) |
| `convert` backlog→ticket | solo admin | **qualsiasi utente** (`requireAuth`) |
| `run-ai` | qualsiasi utente, esecuzione immediata | qualsiasi utente; se il richiedente è `member` il job **richiede approvazione**: con piano salvato nasce direttamente in `awaiting_plan_approval` con `planText` = piano (lo stato che produce `parkForPlanApproval`, `apps/worker/src/queue.ts:275-292`); senza piano nasce `queued` con `planApprovalRequired = true` |
| `run-ai` con job in volo | riscrive il job | **409 `job_in_flight`** se l'ultimo job è in `queued | triaging | fixing | awaiting_plan_approval` |

Nuove colonne su `ai_jobs`: `requested_by_user_id uuid null` (FK users, set
null) e `plan_approval_required boolean not null default false`. Nel worker
`resolveFixMode` (`apps/worker/src/pipeline/fix.ts:337-347`) ritorna
`plan-only` quando `planApprovalRequired`, a prescindere da
`planApprovalMinEffort`. `manualTrigger` resta com'è (scavalca gate di
automazione e budget, non l'approvazione).

Merge e rilascio non passano da Stubwise: fuori scopo.

## 3. Inbox: modello dati e routing

Migrazione **0063**.

**`notifications`** (una riga per destinatario):
`id`, `user_id` (FK cascade), `project_id?`, `ticket_id?`, `job_id?`,
`kind` (enum `notification_kind` con gli 11 kind attuali; estendibile),
`event jsonb` (il `NotificationEvent` intero: i testi si rendono con
`formatNotification`), `status` enum `open | handled | snoozed`,
`snoozed_until?`, `read_at?`, `handled_at?`, `handled_by_user_id?`,
`created_at`. Indice parziale `(user_id, created_at desc) where status = 'open'`;
indice `(job_id)` per la propagazione di `handled`.

**`notification_deliveries`** (outbox per canale):
`id`, `notification_id?` (null per la delivery `webhook`, che è per evento non
per destinatario; in quel caso `event jsonb` è copiato qui), `channel` enum
`webhook | slack_dm | slack_update` (`slack_update` = aggiornamento del
messaggio delle altre copie dopo un'azione), `status` enum
`pending | sent | failed | skipped`,
`attempts int`, `next_attempt_at`, `error?`, `external_ref?` (ts del messaggio
Slack), `created_at`, `sent_at?`. Indice parziale su `(next_attempt_at) where
status = 'pending'`.

**`project_follows`**: `(user_id, project_id)` PK composta.

**Punto d'ingresso unico**: `publishNotification(db, event, opts)` in
`@stubwise/notifications` sostituisce `dispatchNotification` in tutti gli 11
punti. Riceve `db` (o `tx`: quando il chiamante ha una transazione, inserisce
dentro), calcola i destinatari, inserisce le righe `notifications` e le
`notification_deliveries`. Non fa I/O di rete: l'invio è del poller.
`dispatchNotification` resta come funzione interna del canale `webhook`
(stessa config, stessi toggle per kind, comportamento **invariato**).
`sendTest` invariato.

**Routing v1**:

- decisionali (`job.plan_review`, `job.held`, `job.budget_held`) → tutti gli admin;
- avanzamento (`job.pr_opened`, `job.pr_closed`, `job.failed`,
  `review.completed`, `ticket.created`) → admin ∪ `requestedByUserId` ∪
  assegnatario e reporter del ticket ∪ follower del progetto;
- `docs.limit_paused`, `monitor.*` → admin.

Gli admin ricevono tutto senza seguire. Delivery `slack_dm` creata per ogni
destinatario con `slackUserId` e preferenza attiva; delivery `webhook` una per
evento se il webhook è configurato e il toggle del kind è on.

**Poller** nel worker (`apps/worker/src/notify/deliveries-poller.ts`,
`NOTIFY_POLL_SECONDS` default 5, `0` = off): claim `FOR UPDATE SKIP LOCKED`
delle pending scadute, invio, `sent` / retry con backoff (30s·2^n, max 5
tentativi) / `failed`. Il poller è l'unico che parla con l'esterno; il server
si limita a inserire.

**Gestione**: un'azione decisionale eseguita da chiunque abbia il permesso
marca `handled` + `handled_by_user_id` su **tutte** le copie della stessa
notifica (stesso `job_id` + `kind`); le copie altrui mostrano "gestita da X".

## 4. Azioni, API e UI web

**Catalogo azioni** (calcolate dal server, mai persistite; dipendono da kind,
stato attuale del job, ruolo del richiedente):

| kind | azioni |
| --- | --- |
| `job.plan_review` | `approve_plan`, `reject_plan` (admin), `open` |
| `job.held` (`other`) | `relaunch`, `open` |
| `job.budget_held` | `relaunch` (admin), `open` |
| `job.failed`, `job.pr_closed` | `relaunch`, `open` |
| `job.pr_opened`, `review.completed`, `ticket.created`, `docs.*`, `monitor.*` | `open` |
| tutte | `snooze` (`1h | tomorrow | 3d`), `handled` |

`open` porta a `ticketUrl`/`prUrl`/`docsUrl`/`url` dell'evento. Un'azione è
presente solo se lo stato del job la consente (es. `approve_plan` solo con job
in `awaiting_plan_approval`).

**Servizi condivisi** (`apps/server/src/services/jobs.ts`): estrarre
`resumeFromPlanApproval` (`tickets.ts:1368-1424`) e la logica di `run-ai` in
funzioni pure con `db` + `actor` (utente) che ritornano risultato o errore
tipizzato (`plan_not_pending`, `job_in_flight`, `forbidden`). Le rotte
`tickets` e la nuova `inbox` e Slack le chiamano. `reject_plan` accetta
`instructions?: string` (salvato come commento del team, così il re-plan lo
legge come già fa "Rilancia con istruzioni").

**API** (`apps/server/src/routes/inbox.ts`, prefix `/api/inbox`, `requireAuth`):
- `GET /` — `?status=open|snoozed|handled&projectId=&limit=&cursor=`; ogni
  item = `{ id, kind, status, project, ticket?, job?, text (già formattato
  nella lingua dell'utente), actions[], createdAt, snoozedUntil, handledBy? }`.
- `GET /unread-count` — conteggio `open` (esclude snoozate non scadute).
- `POST /:id/read`, `POST /:id/snooze { until }`, `POST /:id/handled`.
- `POST /:id/actions/:action` — esegue via servizio, propaga `handled`; 409 con
  `handledBy` se già gestita; 403 se il ruolo non basta.
- `GET|PUT /api/me/follows` e `PUT /api/me/notification-prefs { slackDm: boolean }`
  (nuova colonna `users.notify_slack_dm boolean default true`).

Snooze scaduto: torna `open` al primo `GET` (lazy) — nessun job.

**UI web** (`apps/web`):
- Campanella con contatore in `app-layout.tsx` (sidebar + `MobileTopBar`),
  polling 30 s.
- Pagina `/inbox` (mobile-first): sezioni *Da decidere* / *Da sapere* /
  *Snoozate*, filtro progetto, azioni inline; `reject_plan` apre un campo
  istruzioni; `handled` e `snooze` ottimistici.
- `ticketJobsQueryOptions`: `refetchInterval` 5 s mentre l'ultimo job è
  `queued | triaging | fixing`, altrimenti off.
- Dettaglio ticket: bottoni Approva/Rifiuta visibili solo agli admin;
  "Esegui con AI" per i member mostra "richiederà l'approvazione del piano".
- Impostazioni Notifiche (admin, webhook) invariata + nota sugli scope Slack.
  Account: "Progetti seguiti" e "Notifiche in DM su Slack".
- Nav: voce `inbox` in `NAV_ITEMS`; etichette ruolo in `/team`.

## 5. Slack interattivo

- `SlackClient.postMessage({ channel, text, blocks })` (`chat.postMessage`) e
  `updateViaResponseUrl` (già esiste `postResponse`). Scope nuovi:
  **`chat:write`**, **`im:write`**; documentati nella guida Slack
  (`apps/docs/.../integrations/slack.md`) e nell'help della pagina impostazioni.
- Delivery `slack_dm`: `channel = users.slackUserId`; blocchi = testo di
  `formatNotification(event, "slack")` + `actions` con i bottoni del catalogo
  filtrati per il ruolo del destinatario. `action_id = "inbox:<action>"`,
  `value = notificationId`; snooze = `static_select`. `ts` → `external_ref`.
  Senza bot token o senza `slackUserId` → `skipped`.
- `block_actions` in `/api/slack/interactions`: HMAC → utente da
  `payload.user.id` (`resolveReporterBySlackId`; non linkato → ephemeral
  "collega l'account Slack in Stubwise") → ack 200 → `setImmediate` →
  `executeInboxAction(actor, notificationId, action)` → `response_url` con
  `replace_original` (testo + "✅ <azione> da <nome>, <ora>", bottoni rimossi)
  o ephemeral con l'errore ("già gestita da X").
- `reject_plan` da Slack: bottone → `views.open` con modal (textarea
  istruzioni, `private_metadata = notificationId`) → `view_submission` → azione.
- Le copie del messaggio degli altri destinatari vengono aggiornate dal poller
  (nuova delivery interna `slack_update` sulle `external_ref` note) — best
  effort.

## 6. `run_ticket` e `/stubwise:run`

- Tool **`run_ticket({ id, mode?: "ai_plan" })`** in `packages/mcp/src/tools/write.ts`:
  `POST /api/tickets/:id/run-ai`, poi `GET /api/tickets/:id/jobs` per lo stato
  iniziale. Testo: "Esecuzione avviata sul ticket #N (job …). <Il piano salvato
  verrà eseguito dal worker | Il job attende l'approvazione del piano (il tuo
  utente è operatore)>. URL". 409 → "C'è già un job in corso (stato …)".
  `client.ts`: `runTicket`, `listTicketJobs`. Test in `write.test.ts`; elenco
  dei 15 tool in `server.test.ts`. `SERVER_VERSION` letto dal `package.json`.
  Changeset minor (`@stubwise/mcp` 0.4.0).
- Comando **`.claude/commands/stubwise/run.md`**: passi 1–2 di `start`
  (assicura ticket; `set_design` e `set_plan` PRIMA del convert), poi
  `set_ticket_status in_progress`, `run_ticket`, riferimento `ticket:` nel
  frontmatter del doc e commit. Termina indicando l'URL del ticket: nessuna
  implementazione locale.
- `SKILL.md`: §8 riscritta ("usa `run_ticket`"), nuova sezione "Eseguire in
  locale (`/stubwise:start`) o su Stubwise (`/stubwise:run`)". Copia in
  `~/.claude/skills/stubwise/SKILL.md` e `~/.claude/commands/stubwise/run.md`.
- Docs `integrations/claude-code-mcp.md`: riga `curl` per `run.md`, tool
  `run_ticket`; `CLAUDE.md`: comando `/stubwise:run`.

## 7. Test

- **server**: permessi (approve/reject 403 member; convert 200 member; run-ai
  member con piano → `awaiting_plan_approval`; senza piano →
  `planApprovalRequired`; 409 `job_in_flight`; admin invariato); inbox
  (routing per ruolo/follow/requester/assegnatario; azioni calcolate per
  stato e ruolo; `handled` propagato; snooze e riapertura lazy; 409 già
  gestita); Slack `block_actions` (HMAC, non linkato, azione ok, già gestita,
  modal reject); `publishNotification` nei due punti server.
- **worker**: `planApprovalRequired` → `plan-only`; poller deliveries (claim,
  retry/backoff, `failed` dopo 5, `skipped` senza `slackUserId`, webhook
  invariato con toggle); `notify()` → `publishNotification`.
- **notifications**: test di `dispatch.ts` migrati sul canale webhook; nuovi
  test del routing.
- **web**: campanella e contatore; pagina inbox (sezioni, azioni, reject con
  istruzioni); polling adattivo dei job; gating ruolo nel dettaglio ticket.
  E2E Playwright (a mano): "piano in attesa → approva dall'inbox".
- **mcp**: `run_ticket` (202 con/senza piano, 409, 403).

## 8. Deploy e rollback

- Backup DB. Rebuild **server + worker + caddy** insieme (migrazione 0063
  all'avvio del server; il worker nuovo dipende dalle tabelle).
- Env opzionale `NOTIFY_POLL_SECONDS` (default 5).
- App Slack: aggiungere scope `chat:write` e `im:write`, reinstallare nel
  workspace (nuovo bot token → risalvarlo in Impostazioni → Slack).
- Rollback: `NOTIFY_POLL_SECONDS=0` spegne i DM ma NON il webhook (il canale
  webhook passa dal poller: se serve il vecchio comportamento sincrono,
  tornare all'immagine precedente). Le tabelle nuove sono additive.

## 9. Fuori scopo (fasi successive)

`ask_user`/`awaiting_input` (fase 1), pulse (fase 2), `list_proposals` MCP
(fase 2), push mobile (fase 4), email (nessun SMTP), membership per progetto.
