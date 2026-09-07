---
title: Fase 6 — Gmail e Calendar
date: 2026-09-07
status: validato (brainstorming)
program: 2026-08-31-stubwise-nerve-center-program-design.md
stubwise:
  project: stubwise
  backlog: a03a1621-6a9f-44d8-b0ec-631ee3d21cbf
---

# Fase 6 — Gmail e Calendar

Settima fase del programma. Le email e gli eventi di calendario degli
operatori diventano **proposte** nella inbox di Stubwise, confermate con un
tap: crea una voce di backlog, una milestone, aggiorna o commenta un ticket,
registra una decisione. Mai una mutazione senza conferma. Sola lettura su
Google, un'app OAuth **interna** per ogni Google Workspace, N caselle per
utente, privacy per costruzione (il proprietario della casella è l'unico
destinatario).

## 1. Stato di partenza (fatti verificati)

- **Nessun OAuth nel repo**: Slack (signing secret + bot token), git accounts
  e provider AI usano credenziali incollate. Mattoni presenti: `encrypt`/
  `decrypt` AES-256-GCM in `packages/db/src/secrets.ts` con `ENCRYPTION_KEY`
  condivisa da server e worker; segreti d'istanza in `instance_settings` con
  semantica write-only (`settings.ts:503-576`, `slack-section.tsx`);
  `PUBLIC_URL` validato (`apps/server/src/config.ts:35`); `randomBytes`,
  `timingSafeEqual`; Caddy proxya al server solo `/api/*`, `/ingest/*`,
  `/webhooks/*`, `/widget/*`, `/monitor/ingest|config`.
- **Il worker non importa da `apps/server`**: gli helper che decifrano
  segreti usati da entrambi vivono in package condivisi
  (`packages/notifications/src/slack-client.ts:457`).
- **Poller**: modello canonico `startXPoller` (`daily-report-poller.ts:1129`),
  claim con backoff pre-schedulato e classificazione fatale/transitorio del
  `deliveries-poller` (`apps/worker/src/notify/deliveries-poller.ts:69-109`,
  `isFatalSlackError`), job per-utente fuori dal serializer di progetto
  (`rollupDevSummaries`, `daily-report-poller.ts:638-641`, provider dalla
  chain globale).
- **Run AI su testo non fidato**: dottrina dell'intake
  (`apps/worker/src/backlog/prompts.ts:23-35`): `permissionMode "default"`
  (mai `"plan"`, che invita a leggere il filesystem), directory vuota,
  nessun tool, schema di output con cap; `runAgentText`/`parseAgentJson`/
  `capText` (`apps/worker/src/agent/text.ts`, default `"plan"`: va passato
  `"default"` esplicito). `agent_runs` accetta solo run con `job_id` o
  `pr_review_id` (`schema.ts:813`, `num_nonnulls = 1`): brief, riassunti e
  report **non sono contabilizzati**.
- **Proposte**: la macchina del pulse è kind-agnostica (`question`/
  `options`/`recommendedIndex`, `QuestionPanel`, `buildQuestionBlocks`,
  `PulseProposalCard`, `KINDS_WITH_OPTIONS`), ma `proceedWithProposal`
  esegue **una sola** azione, `PropagationTarget` ha `{pulseId}` cablato,
  `stateAllows`/`actorAllows` ammettono in positivo il solo `project.pulse`
  (`actions.ts:243,279`). Ordine claim → mutazione documentato in
  `services/pulse.ts:141-165`.
- **Audience**: `admins | broadcast | requester`, e `requester` include
  sempre gli admin (`routing.ts:96`): nessuna esprime «solo il proprietario
  della casella».
- **Mutazioni target**: `recordDecision` (idempotente, accetta `tx`),
  `recordTicketStatusChange`, `convertBacklogItem`, `publishNotification`
  sono servizi; creazione voce di backlog (job `intake`,
  `routes/backlog.ts:856`), milestone (`routes/milestones.ts:153`), PATCH
  ticket (`routes/tickets.ts:1176`) e commento sono **inline nelle rotte**.
  `project_decisions.source` è un CHECK su text (niente trappola enum).
- **Registro decisioni mai scritto dall'AI**: `decisions-never-ai.test.ts`
  diventa rosso se il modulo che registra importa un esecutore di agenti.
- **Attribuzione**: nessuna tabella `project_members` né un concetto di
  cliente/dominio; l'unico legame utente↔progetto è `project_follows`; le
  rotte di ticket/backlog/milestone sono `requireAuth`. Il precedente di
  «chiave esterna → progetto» è `projects.ingestionKey`.
- **Embedding**: dedup contro il backlog gratis passando dall'intake; i
  ticket non hanno `embedding`.
- **Allegati**: `attachments.ticket_id NOT NULL`, allowlist MIME stretta.
- **Compatibilità client**: enum aperti via `readerSchema`, campi nuovi
  sempre opzionali; un kind nuovo sull'app installata degrada a card
  informativa (`InboxCard` default → `InfoCard`, test esistenti).
- **Rollback (fasi 2 e 5)**: kind nuovo in `notifications` → immagine server
  precedente solo dopo aver eliminato quelle righe.

## 2. Perimetro (deciso)

Dentro: (1) registro Workspace Google d'istanza; (2) caselle collegate per
utente con OAuth (Gmail + Calendar read-only); (3) routing per progetto,
ingestione incrementale, classificazione AI dei segnali; (4) proposte
`google.proposal` con azioni per opzione, esecuzione con claim, pagina
Posta, tool MCP; (5) Calendar: eventi → proposte di milestone.

Fuori (v1): invio email; allegati (solo link al thread); caselle non
Workspace; IMAP; embedding dei ticket; card azionabile nell'app mobile
(informativa con «Apri»); promemoria e sincronizzazione bidirezionale del
calendario; contabilizzazione dei run di brief/riassunti (resta il backlog
della fase 5).

Invarianti: **mai una mutazione senza un tap**; **il registro decisioni
riceve solo template** con campi strutturati (mittente, oggetto, opzione
scelta), mai l'output del modello; **solo il proprietario della casella**
vede ciò che nasce dalla sua casella.

## 3. Workspace Google, OAuth, caselle

- **`google_workspaces`** (admin): `id`, `name`, `domains text[]`,
  `client_id`, `client_secret_encrypted`, `created_at`. Rotte
  `GET/POST/PATCH/DELETE /api/settings/google-workspaces` (`requireAdmin`),
  secret write-only (assente = invariato, `""` = azzera), risposta con
  `clientSecretSet`. UI Impostazioni → Google: lista, form, box «Da
  incollare nella Google Cloud Console» con redirect URI
  `<PUBLIC_URL>/api/me/google/callback`, scope, promemoria «app Interna».
  Guida utente passo-passo (progetto GCP, consenso interno, credenziali
  OAuth web, API Gmail e Calendar abilitate).
- **`google_accounts`** (per utente, N): `id`, `user_id` (cascade),
  `workspace_id` (restrict), `email` unique, `google_sub`,
  `refresh_token_encrypted`, `scopes text[]`, `proposals_enabled bool
  default true`, `gmail_history_id`, `calendar_sync_token`,
  `connected_at`, `last_sync_at`, `next_sync_at`, `sync_attempts`,
  `disabled_at`, `disabled_reason` (`revoked | invalid_grant |
  insufficient_scope | workspace_removed`). Nessun access token
  persistito: il worker lo ottiene dal refresh token a ogni ciclo, in
  memoria; un solo poller per casella (claim su `next_sync_at`).
- **Flusso OAuth** (server): `POST /api/me/google/connect { workspaceId }`
  → `state` HMAC (chiave d'istanza) con `userId`, `workspaceId`, nonce,
  scadenza 10' + riga in `oauth_states` monouso; risposta con URL di
  autorizzazione (`access_type=offline`, `prompt=consent`,
  `include_granted_scopes=true`, `hd=<primo dominio>`; scope
  `openid email gmail.readonly calendar.readonly`).
  `GET /api/me/google/callback?code&state`: verifica firma e nonce (e lo
  consuma), scambia il code, `userinfo`, **rifiuta se il dominio
  dell'email non è tra quelli del Workspace** (`domain_mismatch`), rifiuta
  senza refresh token (`no_refresh_token`, istruzione: revocare su Google
  e riprovare) e con scope insufficienti (`insufficient_scope`); upsert per
  email (ricollegare riattiva); redirect a `/settings/account?google=ok|
  <errore>`. Nessun cookie richiesto. Rate limit come il login.
  `DELETE /api/me/google/accounts/:id`: revoca su Google (best-effort),
  delete; messaggi e proposte già prodotti restano. `PATCH` per
  `proposalsEnabled`.
- **Client Google** in `packages/google` (condiviso server/worker): `fetch`
  iniettabile, timeout, `GoogleApiError`, fatali (`invalid_grant`,
  `insufficient_scope`, `unauthorized_client`, `access_denied`) →
  `disabled_reason`; transitori (rete, 429, 5xx) → backoff con
  `Retry-After`; refresh, Gmail (`history.list`, `messages.list`,
  `messages.get` format `full` con parsing MIME → testo), Calendar
  (`events.list` con `syncToken`), `userinfo`, `revoke`; helper
  `loadGoogleAccountCredentials(db, key, accountId)`.
- **UI Account → Caselle Google**: lista (email, Workspace, stato, ultima
  sync, scope, «Ricollega» se disabilitata con motivo, «Scollega», toggle
  «Proposte attive»), «Collega una casella» con scelta del Workspace (nessuno
  configurato → messaggio che rimanda all'admin).

## 4. Routing, ingestione, classificazione

- **`project_email_routes`**: `project_id` (cascade), `kind` (`sender_domain
  | sender_address | gmail_label | keyword`, CHECK), `value` (normalizzato
  lowercase), unique `(project_id, kind, value)`. Rotte `GET/PUT
  /api/projects/:id/email-routes` (sostituzione dell'insieme, admin; da
  registrare dopo `/pulse` e con la regola letterali-prima). UI: sezione
  «Posta» nel dettaglio progetto con tre editor a chip (`LabelsEditor`) e il
  picker delle etichette osservate (`ComboboxPicker` + `PickerFreeText`).
  Match: dominio/indirizzo su `From`, `To`, `Cc`; etichetta sulle label
  Gmail; parola chiave su oggetto e testo. Un messaggio è in perimetro se
  almeno una regola combacia; progetto risolto = massimo numero di regole
  soddisfatte; parità → `project_id NULL` e `candidate_project_ids`.
- **`email_messages`**: `id`, `account_id` (cascade), `gmail_message_id`,
  `thread_id`, `from_address`, `from_name`, `to_addresses text[]`,
  `subject`, `received_at`, `labels text[]`, `text_excerpt` (≤ 20k con
  marcatore), `project_id` (set null), `candidate_project_ids uuid[]`,
  `status` (`new | classified | proposed | actioned | ignored | failed`,
  CHECK), `signal`, `classification jsonb`, `proposal_notification_id`
  (set null), `outcome jsonb`, `error`, `created_at`, `updated_at`; unique
  `(account_id, gmail_message_id)`; indici su `(account_id, status)`,
  `(project_id, received_at)`.
- **Poller** `apps/worker/src/google/poller.ts` (`GMAIL_POLL_MINUTES`,
  default 5, 0 = spento): per casella attiva con `proposals_enabled` e
  `next_sync_at` scaduto: claim guardato (`next_sync_at = now() + backoff`
  nello stesso UPDATE, `sync_attempts`), refresh token → access token;
  History API da `gmail_history_id`; primo giro o history scaduta (404) →
  `messages.list q="newer_than:7d -from:me"` max 200; per ogni messaggio
  nuovo: header ed etichette (format `metadata`), scarto se inviato dalla
  casella, pre-filtro col routing di tutti i progetti; solo se passa:
  `messages.get full`, MIME → testo (text/plain preferito, HTML → testo,
  rimozione firme e citazioni con euristiche, cap 20k), insert
  `email_messages` (`onConflictDoNothing`); fuori perimetro → non scritto.
  Fine ciclo: `gmail_history_id`, `last_sync_at`, `sync_attempts = 0`.
  Errore fatale → `disabled_at` + motivo, nessun retry; transitorio →
  backoff, max 8 tentativi poi disabilitata `sync_failed`. Retention
  `GMAIL_RETENTION_DAYS` (default 90) sui messaggi in stato terminale.
- **Classificazione** (stesso poller, fase 2 del tick, per messaggi `new`,
  max 20 per tick): `runAgentText` con `permissionMode: "default"`, cwd
  vuota, nessun tool, `maxTurns 3`, timeout 90 s, modello `GMAIL_MODEL`
  (default `haiku`), provider `chain[0]`. Prompt con delimitatori, lingua
  di contenuto, input: mittente, oggetto, testo, progetti candidati (nome,
  descrizione), ultimi 20 titoli di backlog e ticket aperti del progetto
  risolto, numeri `#N` citati. Output JSON con cap: `signal` (`decision |
  request | deadline | blocker | none`), `summary` (≤ 400), `proposals[]`
  1..3 `{ type, projectId?, title?, body?, name?, dueDate?, ticketNumber?,
  status?, priority?, decision?, consequence }`, `recommendedIndex`. Il
  codice **rivalida i referenti**: `projectId` ∈ candidati, `ticketNumber`
  ∈ ticket aperti del progetto, `dueDate` ISO futura; azione senza
  referenti validi scartata; nessuna azione valida o `none` → `ignored`
  senza notifica. Costo: `agent_runs.email_message_id` (nuovo owner, check
  `num_nonnulls(job_id, pr_review_id, email_message_id) = 1`, phase
  `email_classify`), così Usage mostra «posta».
- **Calendar** (stesso tick, `calendar_sync_token` sul calendario
  `primary`, finestra 60 giorni, primo giro `timeMin=now`,
  `timeMax=+60d`): tabella `calendar_events` (`account_id`,
  `google_event_id` unique per casella, `title`, `starts_at`, `ends_at`,
  `all_day`, `attendees text[]`, `organizer`, `status`, `project_id`,
  `proposal_notification_id`, `outcome`, `fingerprint` = giorno+titolo).
  Pre-filtro con le stesse regole (domini dei partecipanti, parole chiave
  nel titolo). Senza AI: eventi in perimetro con `project_id` risolto →
  proposta `create_milestone` («<titolo> entro <data>») deterministica;
  stesso `fingerprint` già trattato → non riproposto; cancellato → outcome
  `cancelled` (nessuna mutazione).

## 5. Proposte, esecuzione, pagina Posta

- **Evento** `GoogleProposalEvent` (kind `google.proposal`): `proposalId`,
  `source` (`email | calendar`), `messageUrl` (thread Gmail o evento),
  `projectName?`, `signal`, `question` (template i18n con `from`/`subject`
  come **parametri non fidati** in `UNTRUSTED_SLACK_PARAMS`), `options[]`
  (label + consequence), `recommendedIndex`, `allowFreeText: false`,
  `actions[]` allineate 1:1 (union discriminata): `create_backlog_item
  { projectId, title, body }`, `create_milestone { projectId, name,
  dueDate? }`, `update_ticket { ticketId, status?, priority? }`,
  `comment_ticket { ticketId, body }`, `record_decision { projectId,
  ticketId?, title, decision }`, `choose_project { projectId }`, `ignore`.
  Invariante `actions[i] ↔ options[i]` difesa come nel pulse (lunghezze
  diverse → blocco di contorno omesso). Audience nuova **`mailbox_owner`**
  (`RoutingContext.mailboxOwner`, `PublishOpts.mailboxOwnerUserId`): solo
  quell'utente, mai admin. `KINDS_WITH_OPTIONS`, `EMOJI`, `KEY_FOR_KIND`,
  `PUSH_TITLE_KEY`, `TOGGLE_FOR_KIND` (`notify_google_proposal`),
  `CATALOG_FOR_KIND` (`decisions: ["answer"]`, `archivable`), `openUrl`,
  `sampleEvents`, `stateAllows`/`actorAllows` (Set `KINDS_WITHOUT_JOB`).
  Blocco `inboxItemSchema.google?` (`from`, `subject`, `receivedAt`,
  `signal`, `source`, `actions` come descrizioni non eseguibili) opzionale.
  Web: card con `QuestionPanel` e «Apri» al thread; mobile installata:
  informativa.
- **Esecuzione** `apps/server/src/services/google-proposal.ts` (separato da
  `inbox.ts` e da ogni modulo AI): rilettura tollerante del payload
  (`proposalId` + `actions[]`), indice validato contro le azioni
  persistite, `actorAllows`, pre-check `open`, **claim**
  `propagateHandled` generalizzato su `{ eventKey: { kind, field, value } }`
  (con indice parziale su `event->>'proposalId'`), poi l'azione con attore
  = chi conferma: `create_backlog_item` → servizio `enqueueBacklogIntake`
  estratto dalla rotta; `create_milestone` → `createMilestone` estratto
  (409 `milestone_exists` → outcome `exists`); `update_ticket` →
  `patchTicket` estratto (eventi con `actorId`); `comment_ticket` →
  `system` comment con link; `record_decision` → `recordDecision` source
  `email` (CHECK allargato), `sourceKey email:<messageId>`, testi da
  template i18n `decision.email.*`; `choose_project` → aggiorna
  `email_messages.project_id` e riaccoda la classificazione (nuova
  proposta); `ignore` → `ignored`. Esito su `email_messages.status`/
  `outcome` (o `calendar_events`), `mirrorDecision` su Slack, nota inbox.
  Fallimento dopo il claim → `status failed` con `error`, riproponibile.
  Errori nuovi in `ExecuteActionError`: `target_gone` (409),
  `action_failed` (409 col pezzo riuscito come dato).
- **Pagina Posta** `/mail` (nav, per utente): elenco di messaggi ed eventi
  trattati (casella, progetto, segnale, stato, esito, data), filtri per
  casella/stato/progetto, «Riproponi» su `failed`/`ignored` (ripubblica
  la proposta), link al thread, contatore delle proposte aperte. Rotte
  `GET /api/me/mail?…`, `POST /api/me/mail/:id/repropose`, sempre
  filtrate per `userId`; nessun admin vede la posta altrui.
- **MCP** `list_mail_proposals` (proposte aperte del titolare del token).

## 6. Test e deploy

- **Test**: `packages/google` (refresh, history, list/get, MIME → testo,
  calendar sync, fatali vs transitori, `Retry-After`) con `fetch` finto;
  OAuth (state firmato/monouso/scaduto, `domain_mismatch`,
  `no_refresh_token`, `insufficient_scope`, upsert/riattivazione, revoca);
  poller (claim e backoff, disabilitazione, history scaduta → fallback,
  idempotenza su `gmail_message_id`, pre-filtro senza download, cap testo,
  retention, max per tick); classificazione (schema con cap, referenti
  inventati scartati, `none`, `agent_runs` con owner email); routing
  (precedenza, parità, `Cc`, normalizzazione); calendar (fingerprint,
  cancellazione, finestra); proposta (allineamento, audience
  `mailbox_owner` senza admin, ogni azione: claim prima e stato dopo,
  fallimento dopo il claim → `failed` riproponibile, `choose_project`,
  409 `already_handled`); `decisions-never-ai` esteso al modulo
  `google-proposal`; card web e pagina Posta; app vecchia degrada; parità
  i18n; MCP. Nessuna chiamata reale a Google.
- **Deploy**: migrazione 0069 (`ADD VALUE 'google.proposal'` a sé;
  tabelle nuove; `notification_settings.notify_google_proposal`; CHECK
  `project_decisions.source` + `email`; `agent_runs.email_message_id` e
  check allargato; `agent_run_phase` + `email_classify` se enum: statement
  a sé); rebuild server+worker+caddy; env `GMAIL_POLL_MINUTES` (0 =
  rollback innocuo), `GMAIL_MODEL`, `GMAIL_RETENTION_DAYS`; changeset
  `shared` + `mcp`. Rollback dell'immagine server: prima eliminare le
  righe `google.proposal`. **Post-deploy (maintainer)**: app OAuth interna
  in ogni Workspace (guida), registrazione in Impostazioni → Google,
  collegamento caselle, regole di routing sui progetti.
