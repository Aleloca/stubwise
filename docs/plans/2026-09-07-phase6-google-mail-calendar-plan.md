---
title: Fase 6 — Gmail e Calendar — piano di implementazione
date: 2026-09-07
design: 2026-09-07-phase6-google-mail-calendar-design.md
stubwise:
  project: stubwise
  backlog: a03a1621-6a9f-44d8-b0ec-631ee3d21cbf
  ticket: https://stubwise.thecove.it/tickets/e459bab2-cb1a-45ff-8a8c-1f968f31b31e
---

# Fase 6 — Gmail e Calendar: piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **Prima del Task 1**: `/stubwise:start` sulla voce di backlog nel frontmatter
> del design doc. Worktree `feature/phase6-google-mail-calendar`. Alla fine:
> push, CI verde (incluso E2E), PR verso main; merge e deploy li fa il
> maintainer. Fai `git merge origin/main` nel branch prima del push finale.

**Goal:** email ed eventi Google degli operatori → proposte in inbox
confermate con un tap (backlog, milestone, ticket, decisione), con OAuth
interno per Workspace, N caselle per utente, routing per progetto,
classificazione AI sicura ed economica, pagina Posta, tool MCP.

**Architecture:** additiva: 6 tabelle nuove, un kind di notifica nuovo con
audience nuova `mailbox_owner`, un package condiviso `packages/google`
(client HTTP puro), un poller per casella nel worker fuori dal serializer di
progetto, un servizio di esecuzione delle proposte separato dall'AI. Mutazioni
estratte dalle rotte in servizi riusabili.

**Tech Stack:** Fastify + Zod + Drizzle, worker con claude CLI via
`runAgentText` (`permissionMode "default"`), React SPA, `packages/i18n`,
`packages/shared`, `packages/mcp` (Changesets). API Google REST via `fetch`.

**Convenzioni (ereditate)**: TDD; commit piccoli in italiano; `pnpm --filter
@stubwise/<pkg> exec vitest run <pattern>`; migrazioni SQL a mano + journal;
`ALTER TYPE … ADD VALUE` in statement proprio e mai usato nella stessa
migrazione; i18n backend en+it con parità; `pnpm -r build` dopo `packages/*`;
`pnpm lint` prima del merge; rotte letterali prima di `/:projectId`; campi
nuovi negli schemi di risposta sempre `.optional()`/`.nullable()`/`.default()`
con test che parsa senza il campo; segreti mai in risposta né nei log; il
worker non importa da `apps/server`; **il modulo che scrive nel registro
decisioni non importa mai esecutori AI** (`decisions-never-ai.test.ts`).

---

## Fase A — Fondamenta

### Task 1: migrazione 0069 + schema

**Files:**
- Create: `packages/db/drizzle/0069_google_mail_calendar.sql`; Modify: `meta/_journal.json` (idx 69)
- Modify: `packages/db/src/schema.ts` (tabelle `google_workspaces`, `google_accounts`, `oauth_states`, `project_email_routes`, `email_messages`, `calendar_events`; `notificationKind` += `google.proposal`; `notificationSettings.notifyGoogleProposal`; `agentRuns.emailMessageId` + check; `agentRunPhase` += `email_classify` se è enum PG, altrimenti solo TS)
- Modify: `packages/db/src/decisions.ts:8` (`DecisionSource` += `"email"`)
- Modify: `packages/shared/src/schemas/notification.ts` (`notificationKindSchema` += `google.proposal`), `packages/notifications/src/format.ts` (unione, `EMOJI`, `KEY_FOR_KIND`, `sampleEvents`), `push/payload.ts` (`PUSH_TITLE_KEY`), `dispatch.ts` (`TOGGLE_FOR_KIND`), `routing.ts` (audience `mailbox_owner`, vedi Task 10), `actions.ts` (catalogo, `KINDS_WITH_OPTIONS`, `openUrl`), `packages/i18n/src/catalog.ts` (`notify.googleProposal`, `push.title.google.proposal`)
- Test: `packages/db/src/enum-parity.test.ts` (verde), `packages/db/src/decisions.test.ts`, `packages/notifications/src/routing.test.ts` (sampleEvents), un test nuovo di parità `notificationKindSchema` ↔ enum PG (la lista più facile da dimenticare)

SQL (ordine): `ALTER TYPE notification_kind ADD VALUE 'google.proposal'` (statement a sé) → `ALTER TYPE agent_run_phase ADD VALUE 'email_classify'` se enum (statement a sé) → `ALTER TABLE project_decisions DROP CONSTRAINT project_decisions_source_chk, ADD CONSTRAINT … CHECK (source in ('ask_user','plan_review','pulse','manual','email'))` → `ALTER TABLE agent_runs ADD COLUMN email_message_id uuid` (FK dopo la tabella) e check `num_nonnulls(job_id, pr_review_id, email_message_id) = 1` → `notification_settings.notify_google_proposal boolean NOT NULL DEFAULT true` → tabelle come da design §3-4 con CHECK, unique e indici (`email_messages (account_id, gmail_message_id)` unique, `(account_id, status)`, `(project_id, received_at)`; `calendar_events (account_id, google_event_id)` unique; `project_email_routes (project_id, kind, value)` unique; `oauth_states (nonce)` unique + `expires_at`) → FK `agent_runs.email_message_id → email_messages ON DELETE SET NULL` → indice parziale `notifications ((event->>'proposalId')) WHERE kind = 'google.proposal'`.

**Step 1: test rosso** (enum-parity; unique/CHECK con insert; `agent_runs` con solo `email_message_id` accettato, con due owner rifiutato).
**Step 2–4**: rosso → schema → PASS (`pnpm --filter @stubwise/db test`, `pnpm -r build`, `pnpm --filter @stubwise/notifications test`).
**Step 5: Commit** `feat(db): migrazione 0069 — Google Workspace, caselle, routing, posta, calendario, kind google.proposal`.

### Task 2: `packages/google` — client HTTP puro

**Files:**
- Create: `packages/google/package.json` (privato, ESM, dip. solo `zod`), `tsconfig.json`, `src/index.ts`, `src/errors.ts` (`GoogleApiError { status, code, reason, retryAfterMs? }`, `isFatalGoogleError`), `src/oauth.ts` (`buildAuthorizeUrl`, `exchangeCode`, `refreshAccessToken`, `revokeToken`, `fetchUserinfo`), `src/gmail.ts` (`listHistory`, `listMessages`, `getMessageMetadata`, `getMessageFull`, `extractText(payload)`: text/plain preferito, HTML → testo, rimozione citazioni `>`/`On … wrote:`/`Il … ha scritto:` e firme `-- `, decodifica base64url, cap), `src/calendar.ts` (`listEvents` con `syncToken`/`pageToken`, 410 → `sync_token_expired`), `src/fetch.ts` (`fetchWithTimeout`, `Retry-After`)
- Test: `src/*.test.ts` con `fetch` finto (URL, header `Authorization`, body form-urlencoded per token; 401 `invalid_grant` → fatale; 429 con `Retry-After: 7` → `retryAfterMs 7000`; 404 su history → `history_expired`; 410 su events → `sync_token_expired`; MIME multipart con text/plain e text/html; HTML con `<blockquote>`, `<style>`, entità; cap con marcatore)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(google): client OAuth, Gmail e Calendar con fetch iniettabile`.

### Task 3: servizi estratti dalle rotte

**Files:**
- Create: `apps/server/src/services/backlog-intake.ts` (`enqueueBacklogIntake(tx, { projectId, title, body, requestedByUserId })` → job `intake`), `apps/server/src/services/milestones.ts` (`createMilestone(tx, { projectId, name, dueDate?, description?, repositoryId? })` con errori tipizzati `repository_not_in_project`, `milestone_exists`), `apps/server/src/services/tickets.ts` (`patchTicket(tx, { ticketId, actorId, patch })` con `diffTicketEvents` e validazioni), `apps/server/src/services/comments.ts` (`addSystemComment(tx, { ticketId, body })`)
- Modify: `routes/backlog.ts:856`, `routes/milestones.ts:153`, `routes/tickets.ts:1176`, `routes/comments.ts:74` (delegano; comportamento invariato)
- Test: test delle rotte esistenti restano verdi + test unitari dei servizi

**Step 1–4**: refactor coperto dai test esistenti + nuovi. **Step 5: Commit** `refactor(server): mutazioni di backlog, milestone, ticket e commenti come servizi`.

## Fase B — Workspace, OAuth, caselle

### Task 4: registro Workspace (admin)

**Files:**
- Modify: `packages/shared/src/schemas/google.ts` (nuovo: `googleWorkspaceSchema`, `googleWorkspaceDraftSchema`, `googleWorkspacePatchSchema`; `domains` normalizzati lowercase, ≥1; `clientSecret` write-only)
- Create: `apps/server/src/routes/google-workspaces.ts` (`/api/settings/google-workspaces` CRUD, `requireAdmin`, secret cifrato, risposta con `clientSecretSet` e `redirectUri`; DELETE → 409 `workspace_in_use` se ha caselle)
- Create: `apps/web/src/routes/settings/google.tsx` + `components/google-workspaces-section.tsx` (lista, form, box con redirect URI/scope/istruzioni, i18n `settings:google.*`), voce in `settings/layout.tsx` (`adminOnly`), rotta in `router.tsx`
- Docs: `apps/docs` pagina «Google Workspace: creare l'app OAuth interna» (passo-passo GCP)
- Test: rotta (segreto mai in risposta; patch senza `clientSecret` non lo tocca; `""` azzera; domini normalizzati; delete con caselle → 409), web

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(settings): registro dei Google Workspace con client OAuth cifrato`.

### Task 5: OAuth e caselle per utente

**Files:**
- Create: `apps/server/src/routes/me-google.ts` (`POST /api/me/google/connect`, `GET /api/me/google/callback`, `GET /api/me/google/accounts`, `PATCH /api/me/google/accounts/:id` (`proposalsEnabled`), `DELETE /api/me/google/accounts/:id`); `apps/server/src/services/google-oauth.ts` (`signState`/`verifyState` HMAC-SHA256 sulla chiave d'istanza + nonce monouso in `oauth_states` con scadenza 10'; `completeCallback` con `domain_mismatch`, `no_refresh_token`, `insufficient_scope`, upsert per email che riattiva)
- Create: `packages/google/src/credentials.ts` (`loadGoogleAccountCredentials(db, key, accountId)` → refresh token decifrato; usato da worker)
- Modify: `packages/shared/src/schemas/google.ts` (`googleAccountSchema` senza segreti), `apps/server/src/app.ts` (registrazione, rate limit del callback come login)
- Create: `apps/web/src/components/google-accounts-section.tsx` in `settings/account.tsx` (lista, stato, «Ricollega», «Scollega», toggle, «Collega una casella» con select Workspace; esito dal query param `google=`), i18n
- Test: `me-google.test.ts` (state manomesso → 400; nonce riusato → 400; scaduto → 400; dominio fuori dal Workspace → redirect con `domain_mismatch` e nessuna riga; senza refresh token → `no_refresh_token`; scope mancante → `insufficient_scope`; successo → riga con `refresh_token_encrypted` decifrabile solo con la chiave, `scopes`, `connected_at`; ricollegamento riattiva; DELETE chiama revoke e cancella; ogni rotta filtra per `userId`: un altro utente prende 404), web

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(auth): collegamento OAuth delle caselle Google per utente`.

## Fase C — Routing, ingestione, classificazione

### Task 6: routing per progetto

**Files:**
- Modify: `packages/shared/src/schemas/google.ts` (`emailRouteSchema`, `emailRoutesPutSchema`), `apps/server/src/routes/projects.ts` (`GET/PUT /:projectId/email-routes`, admin per PUT; dopo `/pulse`), `packages/notifications/src/email-routing.ts` (puro: `matchRoutes(message, routesByProject) → { projectId | null, candidates[] , matched }` con precedenza per numero di regole, normalizzazione, `To`/`Cc`)
- Create: `apps/web/src/components/project-email-routes-section.tsx` (tre `LabelsEditor` + picker etichette osservate da `GET /api/projects/:id/email-labels` che legge le label distinte dai messaggi dell'utente), sezione «Posta» in `$projectId.tsx`, i18n
- Test: `email-routing.test.ts` (dominio su From/To/Cc, indirizzo esatto, label, keyword su oggetto e testo, 2 regole > 1, parità → null con candidati, nessuna regola → fuori perimetro), rotte, web

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(projects): regole di routing della posta per progetto`.

### Task 7: poller Gmail — sincronizzazione e ingestione

**Files:**
- Create: `apps/worker/src/google/poller.ts` (`startGooglePoller`, `pollGoogleOnce`: claim guardato su `next_sync_at` con `sync_attempts`, refresh token, history/fallback, pre-filtro sui metadati, download `full` solo in perimetro, `extractText`, insert `onConflictDoNothing`, aggiornamento cursori; fatali → `disabled_at`+motivo; transitori → backoff con `Retry-After`, max 8 poi `sync_failed`; retention; `timer.unref`, AbortSignal, `running` guard; `intervalMinutes ≤ 0` → off), `apps/worker/src/google/sync.ts` (funzioni pure testabili)
- Modify: `apps/worker/src/config.ts` (`GMAIL_POLL_MINUTES` 5, `GMAIL_MODEL` haiku, `GMAIL_RETENTION_DAYS` 90, `GMAIL_MAX_PER_TICK` 20), `apps/worker/src/index.ts` (avvio + riga di riepilogo), `docker-compose.yml`, `.env.example`
- Test: `poller.test.ts` con client Google finto (claim e backoff; history 404 → fallback `newer_than:7d`; messaggio da `-from:me` scartato; fuori perimetro → nessun download né riga; in perimetro → riga con `text_excerpt` capato e `project_id`/candidati; riesecuzione → 0 righe nuove; `invalid_grant` → disabilitata senza retry; 429 → `next_sync_at` da `Retry-After`; retention cancella solo stati terminali oltre N giorni; casella con `proposals_enabled=false` saltata)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(worker): poller Gmail con sincronizzazione incrementale e pre-filtro`.

### Task 8: classificazione AI e costi

**Files:**
- Create: `apps/worker/src/google/classify.ts` (`buildEmailSignalsPrompt(lang, input)`, `emailSignalsSchema` con cap, `classifyEmail(deps, message)`: `runAgentText` con `permissionMode: "default"`, cwd vuota, `maxTurns 3`, timeout 90 s, `GMAIL_MODEL`, provider chain globale; **rivalidazione dei referenti** contro candidati/ticket aperti; `none` o nessuna azione valida → `ignored`; scrive `classification`, `signal`, `status classified`; registra `agent_runs` con `email_message_id` e phase `email_classify`)
- Modify: `apps/worker/src/google/poller.ts` (fase 2 del tick: max `GMAIL_MAX_PER_TICK` messaggi `new`), `apps/worker/src/queue.ts` (`recordAgentRun` accetta l'owner email), `packages/db/src/cost.ts` (voce «posta» in `monthlyCostUsd` per phase)
- Modify: `packages/i18n/src/catalog.ts` (istruzioni del prompt en/it)
- Test: `classify.test.ts` (prompt con delimitatori e regola "dati"; output con `projectId` inventato → azione scartata; `ticketNumber` non aperto → scartato; `dueDate` passata → scartata; `none` → ignored senza notifica; JSON invalido → `failed` con errore e nessun retry infinito; `agent_runs` scritto con owner email; runner fallito → `failed`), `cost.test.ts`

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(worker): classificazione dei segnali email con difese e costi tracciati`.

### Task 9: Calendar

**Files:**
- Modify: `apps/worker/src/google/poller.ts` (fase 3: `events.list` con `syncToken`, 410 → full resync finestra 60 gg; upsert `calendar_events`; fingerprint giorno+titolo; cancellati → outcome `cancelled`), `apps/worker/src/google/calendar.ts` (pure: pre-filtro con le regole, proposta deterministica di milestone)
- Test: `calendar.test.ts` (evento con partecipante del dominio → progetto; keyword nel titolo; fingerprint identico → non riproposto; cambio orario stesso giorno → non riproposto; cancellazione; 410 → resync)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(worker): eventi di calendario → proposte di milestone`.

## Fase D — Proposte

### Task 10: evento `google.proposal`, audience `mailbox_owner`, publish dal worker

**Files:**
- Modify: `packages/notifications/src/format.ts` (`GoogleProposalEvent` + `GoogleProposalAction` union; `question` da template; `from`/`subject` in `UNTRUSTED_SLACK_PARAMS`; `formatGeneric`), `routing.ts` (`Audience` += `mailbox_owner`; `RoutingContext.mailboxOwner`; `recipientsFor` → solo lui, **nessun admin**), `publish.ts` (`PublishOpts.mailboxOwnerUserId` → ctx), `actions.ts` (`CATALOG_FOR_KIND` con `answer`, `archivable`; `KINDS_WITH_OPTIONS`; `stateAllows`/`actorAllows` con Set `KINDS_WITHOUT_JOB = { project.pulse, google.proposal }`; `openUrl` → `messageUrl`), `slack-blocks.ts` (riuso `buildQuestionBlocks`), `packages/shared/src/schemas/notification.ts` (`inboxGoogleSchema` opzionale in `inboxItemSchema`), `apps/server/src/services/inbox.ts` (`readGoogle` tollerante, allineamento actions/options)
- Modify: `apps/worker/src/google/proposal.ts` (nuovo: `buildProposalEvent(message | event, classification)`: opzioni 1..3 + `ignore` sempre ultima, `recommendedIndex`; `publishNotification(tx, event, { mailboxOwnerUserId, projectId? })` nella stessa transazione dell'UPDATE `status proposed` + `proposal_notification_id`)
- Test: `routing.test.ts` (mailbox_owner → un solo destinatario anche con admin e follower), `format.test.ts`, `actions.test.ts`, `inbox.test.ts` (blocco `google` presente, omesso se lunghezze diverse), `proposal.test.ts`

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(notifications): proposte google.proposal per il solo proprietario della casella`.

### Task 11: esecuzione delle proposte

**Files:**
- Create: `apps/server/src/services/google-proposal.ts` (`answerGoogleProposal(db, { notificationId, actor, optionIndex })`: lettura, `actorAllows`, parse tollerante (`proposalId`, `actions[]`), indice valido, pre-check `open`, claim `propagateHandled({ eventKey })`, dispatch per `action.type` sui servizi del Task 3 + `recordDecision` (source `email`, `sourceKey email:<messageId>`, template `decision.email.*` con `from`/`subject`/`option`) + `choose_project` (aggiorna `project_id`, `status new` → riclassificazione) + `ignore`; esito su `email_messages`/`calendar_events`; `mirrorDecision`; fallimento dopo il claim → `status failed` + `error`; errori `target_gone`, `action_failed`)
- Modify: `apps/server/src/services/notifications-propagation.ts` (`PropagationTarget` += `{ eventKey: { kind, field, value } }`, `targetWhere` generalizzato; `pulseId` diventa un caso di `eventKey`), `services/inbox.ts:231-267` (dispatch per kind → `answerGoogleProposal`), `routes/inbox.ts` (`sendActionError` con i nuovi errori), `packages/i18n` (`decision.email.*`, note inbox)
- Modify: `apps/server/src/services/decisions-never-ai.test.ts` (include `google-proposal.ts` tra i moduli che NON devono importare esecutori AI)
- Test: `google-proposal.test.ts` (ogni azione: claim prima, mutazione, stato dopo; indice fuori range → 400; già gestita → 409 con `handledBy`; milestone esistente → outcome `exists` senza errore; ticket sparito → `target_gone`; fallimento nell'azione → `failed` con errore, riga chiusa, riproponibile; `choose_project` → riclassifica; `ignore`; utente diverso dal proprietario → 404; decisione registrata con template e chiave idempotente), `notifications-propagation.test.ts` (eventKey, pulse invariato), `routes/inbox.test.ts`

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(inbox): esecuzione delle proposte Google con claim e servizi estratti`.

### Task 12: card web, pagina Posta, MCP

**Files:**
- Modify: `apps/web/src/components/inbox-item.tsx` (`INBOX_KIND_LABEL_KEYS`, contorno `item.google` (mittente, oggetto, data, segnale), `QuestionPanel` con `submitLabel` «Conferma», «Apri» → thread; errori `target_gone`/`action_failed`), `notifications-section.tsx` (toggle `notifyGoogleProposal` + anteprima), i18n `inbox:*`
- Create: `apps/server/src/routes/me-mail.ts` (`GET /api/me/mail?account&status&project&cursor`, `POST /api/me/mail/:id/repropose` (solo `failed`/`ignored`: `status new`), `GET /api/me/mail/summary` (contatori); sempre `userId` nel WHERE), `apps/web/src/routes/mail.tsx` (lista, filtri, «Riproponi», link thread, contatore), voce nav, i18n `mail:*`
- Modify: `packages/mcp/src/tools/read.ts` (`list_mail_proposals`), `client.ts`, changeset `@stubwise/mcp` minor; `packages/shared` changeset; `.claude/skills/stubwise/SKILL.md`
- Modify: `apps/mobile/src/components/inbox/InfoCard.tsx` (`KIND_META` con etichetta per `google.proposal` — l'app resta informativa: degradazione voluta), test `InboxCard.test.tsx` (kind → InfoCard con «Apri»)
- Test: web (card, pagina), rotte (un altro utente non vede la posta altrui, admin compreso), MCP

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(mail): card della proposta, pagina Posta e tool MCP`.

## Fase E — Documentazione e consegna

### Task 13: documentazione, CLAUDE.md, verifica

- `CLAUDE.md`: monorepo (`packages/google`), Deploy **Fase 6** (migrazione 0069; rebuild server+worker+caddy; env `GMAIL_*`; rollback: `GMAIL_POLL_MINUTES=0` innocuo, immagine server precedente solo dopo `delete from notifications where kind='google.proposal'`), invarianti nuove (audience `mailbox_owner` mai admin; classificazione e registro in moduli separati; `permissionMode "default"` obbligatorio per testo non fidato; il poller Google non usa il serializer di progetto).
- `apps/docs`: guida «Collegare Gmail e Calendar» (admin: app OAuth interna per Workspace; utente: collegare le caselle; progetto: regole di routing; cosa succede alle email; privacy).
- Changesets; `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test`; `graphify update .`; `git merge origin/main`; push; CI verde; PR; report (HEAD, run, test flaky con nomi, passi manuali).

---

## Rischi e decisioni prese nel piano

- **Privacy prima di tutto**: audience `mailbox_owner` senza admin è
  esplicita nell'enum, non un caso speciale di `requester`; la pagina Posta
  è per utente; nessun log del testo delle email.
- **Testo non fidato**: `permissionMode "default"` + cwd vuota + nessun tool
  + schema con cap + rivalidazione dei referenti nel codice. Il peggio è una
  proposta fuorviante rifiutata con un tap.
- **Registro decisioni**: solo template; `google-proposal.ts` non importa
  moduli AI; il test `decisions-never-ai` lo verifica.
- **Rollback**: il kind nuovo ha il costo noto; `GMAIL_POLL_MINUTES=0` è la
  strada innocua.
- **Costi**: i run di classificazione entrano in `agent_runs` con owner
  email; brief e riassunti restano fuori (backlog fase 5), da uniformare poi.
