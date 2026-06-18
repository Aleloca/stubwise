# Ingestion esterna (webhook generico + Slack) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development.

**Goal:** Creare ticket da due fonti esterne — un **webhook generico** (`POST /api/inbound/:slug/ticket`, auth con ingestion key per-progetto) e **Slack** (slash command `/stubwise` + message action, modal Block Kit) — riusando la pipeline di creazione ticket esistente (così i ticket esterni entrano nelle `automation_rules` come gli altri). Attribuzione condivisa via email (match utente Stubwise → assegnato; altrimenti sorgente + badge).

**Architecture:** Entrambe le fonti convergono su `createTicket(...)` + l'automazione esistente. Si aggiungono: due valori `ticketSource` (`slack`, `webhook`); colonne Slack cifrate in `instance_settings`; un endpoint webhook dedicato; due endpoint Slack (commands + interactions) con verifica HMAC dello signing secret e chiamate all'API Slack (`views.open`, `users.info`) via `fetch` + bot token; un helper condiviso `resolveReporter(email)`.

**Design:** `docs/plans/2026-06-18-stubwise-external-ingestion-design.md`. **Convenzioni:** TDD, testcontainers per DB/route, migrazione additiva, i18n en/it (parità — test ricorsivo), errori inglese + `code`, NodeNext `.js`, review spec+qualità. **Pre-merge:** `pnpm lint` (root) + `pnpm -r typecheck` + `pnpm -r test` + `pnpm --filter @stubwise/web e2e`. Nessun nuovo workspace package (niente nuove COPY nei Dockerfile).

---

### Task 1: Schema — source slack/webhook + colonne Slack in instance_settings

**Files:** `packages/shared/src/schemas/ticket.ts` (`ticketSourceSchema`), `packages/db/src/schema.ts`, migrazione (`drizzle-kit generate`, verifica SQL), `packages/db/src/schema.test.ts`.

- **`ticketSourceSchema`**: aggiungi i valori `"slack"` e `"webhook"` all'enum (`["manual","sdk_error","sdk_feedback","api","slack","webhook"]`). Il pgEnum `ticket_source` deriva da `enumValues(ticketSourceSchema)`: la migrazione conterrà `ALTER TYPE "ticket_source" ADD VALUE …` (additivo, come `milestone_changed` in 0019 — NON usare il valore come dato nella stessa migrazione).
- **`instance_settings`**: aggiungi colonne nullable `slackSigningSecretEncrypted text` (`slack_signing_secret_encrypted`) e `slackBotTokenEncrypted text` (`slack_bot_token_encrypted`). Additive.
- Migrazione: `drizzle-kit generate` (sarà `0020_*.sql`), VERIFICA il SQL (additivo: 2× ADD VALUE enum + 2× ADD COLUMN nullable), e che un secondo `generate` non produca diff. Se l'ADD VALUE crea problemi, isolalo/correggi a mano e allinea snapshot.

**Test (testcontainers):** insert di un ticket con `source: "slack"` e `source: "webhook"` → letti correttamente; update del singleton instance_settings con le due colonne Slack → round-trip. (NB: i due nuovi enum value vanno testati in una transazione separata dall'ADD VALUE — già garantito perché lo schema è migrato prima dei test.)

**Commit:** `feat(db): ticketSource slack/webhook + colonne Slack in instance_settings`

---

### Task 2: Webhook generico + helper attribuzione condiviso

**Files:** `apps/server/src/ingest/processor.ts` (estrai la creazione del singolo ticket per il kind "ticket" in un helper riusabile che ritorna il ticket), `apps/server/src/routes/inbound.ts` (nuovo, registrato in app), `apps/server/src/ingest/reporter.ts` (nuovo, `resolveReporter`), test.

- **`resolveReporter(db, email?): Promise<{ userId: string | null }>`** in `reporter.ts`: se `email` presente, cerca un utente per email **case-insensitive** (`lower(users.email) = lower(:email)`); ritorna `userId` o null. Helper puro e testabile, riusato da webhook e Slack.
- **Helper creazione ticket esterno**: oggi `processEvents` gestisce il kind `ticket` creando il ticket via `createTicket(...)`. Estrai quella logica in una funzione riusabile (es. `createExternalTicket(db, project, { title, body, type, priority, source, assigneeId, reporterNote })`) che: compone il body (se attribuzione fallita, antepone una riga di provenienza leggibile, es. `> Reported via {source}{ by <email/handle> }`), chiama `createTicket` con `source` e `assigneeId`, applica lo **stesso percorso di automazione** dei ticket ingest (verifica come `processEvents`/`createTicket` accodano il job di automazione — riusa ESATTAMENTE quel percorso, non duplicarlo), e ritorna il ticket creato. Fai refactor di `processEvents` (kind ticket) per usare questo helper, mantenendo i test ingest verdi.
- **Endpoint `POST /api/inbound/:slug/ticket`** in `inbound.ts`:
  - Auth/CORS/rate-limit IDENTICI a `/ingest/:slug` (header `X-Stubwise-Key` vs `projects.ingestionKey`, ramo di rifiuto unico 401, keyGenerator per-chiave). Riusa gli stessi helper (`keysMatch`, ecc.).
  - Body zod: `{ title: string(1..300), body?: string, type: ticketTypeSchema, priority?: ticketPrioritySchema (default "medium"), reporterEmail?: email }`. Payload non valido → **422** (stesso schemaErrorFormatter dell'ingest).
  - Handler: `resolveReporter(reporterEmail)` → `createExternalTicket(..., source:"webhook", assigneeId, reporterNote)`; **201** con `{ id, number, url }` (url via `publicUrlOrUndefined` + path ticket; se publicUrl assente, ritorna il path relativo o ometti url).
- Registra `inboundRoutes` in `app.ts`.

**Test (testcontainers):** auth ok/ko (401 unico); payload valido → 201 + ticket con `source=webhook` + number/url; default priority; `type` mancante → 422; `reporterEmail` che matcha un utente → ticket `assigneeId` = quell'utente; no-match → assigneeId null + riga di provenienza nel body; rate-limit per-chiave (se testabile come per ingest); `resolveReporter` case-insensitive (unit).

**Commit:** `feat(server): webhook generico /api/inbound/:slug/ticket + attribuzione`

---

### Task 3: Settings Slack (credenziali cifrate) — server + UI

**Files:** `apps/server/src/routes/settings.ts`, `apps/web/src/components/` (nuovo pannello o sezione "Integrations/Slack"), `apps/web/src/routes/settings/`, `apps/web/src/lib/api.ts`, i18n, test.

- **Server** — estendi GET/PUT `/api/settings/instance` (requireAdmin) sul pattern S3 (vedi `storage-section` / settings S3):
  - GET: aggiungi `slackSigningSecretSet: boolean`, `slackBotTokenSet: boolean`, `slackEnabled: boolean` (= entrambi i segreti presenti). MAI restituire i segreti.
  - PUT: accetta `slackSigningSecret?`, `slackBotToken?` (string). Presenti e non vuoti → `encrypt(...)`; assenti → invariati; stringa vuota esplicita → azzera (null). Singleton upsert id=1, gli altri campi invariati.
- **Web** — pannello/sezione "Slack" in Settings (admin): campi write-only signing secret + bot token (placeholder "•••• set" se già impostati; checkbox "remove" per azzerare, come S3), badge `slackEnabled`, hint con i passi (crea app su api.slack.com, incolla i segreti, imposta gli URL `/api/slack/commands` e `/api/slack/interactions`, scopes richiesti). Voce nel layout settings.
- Client `api.ts`: estendi tipi instance settings + update.
- i18n en/it (parità) per tutte le stringhe nuove.

**Test (server + web):** PUT con i segreti → colonne cifrate (non in chiaro), GET ritorna `*Set:true`/`slackEnabled` senza esporre i segreti; PUT senza segreti non sovrascrive; "" azzera; requireAdmin (401/403). Web: il pannello rende i campi, invia l'update, non mostra mai i segreti.

**Commit:** `feat(server,web): impostazioni Slack con credenziali cifrate`

---

### Task 4: Slack — endpoint commands + interactions (verifica firma + modal + creazione)

**Files:** `apps/server/src/routes/slack.ts` (nuovo, registrato in app), `apps/server/src/slack/` (verifica firma `verifySlackSignature`, client API Slack `slackApi` per `views.open`/`users.info`), test.

- **Raw body:** Slack invia `application/x-www-form-urlencoded` e la firma è sul **raw body**. Aggiungi un content-type parser/scope dedicato per conservare il raw body su questi endpoint (NON rompere il body parsing globale degli altri route). Documenta l'approccio.
- **`verifySlackSignature(rawBody, headers, signingSecret)`**: HMAC-SHA256 `v0:{timestamp}:{rawBody}` confrontato in tempo costante con `X-Slack-Signature`; rifiuta se `X-Slack-Request-Timestamp` è fuori da ±5 min (anti-replay). Carica lo signing secret dalle instance settings (decifrato); se Slack non è configurato → risposta "non abilitato" coerente.
- **`slackApi`**: piccolo client `fetch` verso `https://slack.com/api/{method}` con `Authorization: Bearer {botToken}` (decifrato), per `views.open` (apertura modal col `trigger_id`) e `users.info` (email dell'utente). Gestione errori best-effort (mai 500 silenzioso verso Slack).
- **`POST /api/slack/commands`** (`/stubwise`): verifica firma → apri il modal via `views.open` (select progetto = progetti dell'istanza, input titolo/descrizione, select tipo) → rispondi **200** entro 3s (corpo vuoto o ack). Niente creazione qui.
- **`POST /api/slack/interactions`**: gestisce due `type`:
  - `message_action` ("Create Stubwise ticket"): apri il modal precompilato col testo del messaggio (titolo = prima riga/troncato, descrizione = testo) via `views.open`.
  - `view_submission`: estrai progetto/titolo/descrizione/tipo dal payload del modal; ricava l'email dell'utente Slack via `users.info` (best-effort), `resolveReporter(email)`; `createExternalTicket(..., source:"slack", assigneeId, reporterNote con @handle)`; rispondi con un ack che chiude il modal; conferma effimera/log col link al ticket. Errori di validazione → `response_action: "errors"` sul modal (messaggio leggibile).
- Registra `slackRoutes` in `app.ts`.

**Test (testcontainers + unit):** `verifySlackSignature` valida / firma manomessa / timestamp scaduto → rifiuto (unit); `/commands` senza Slack configurato → "non abilitato"; `/commands` con firma valida → chiama `views.open` (slackApi mockato) e 200; `view_submission` → crea ticket `source=slack` col progetto/titolo scelti; attribuzione via email (`users.info` mockato: match → assegnato, no-match → fallback con @handle nel body); `message_action` → apre modal precompilato; firma non valida su entrambi → 401/rifiuto.

**Commit:** `feat(server): Slack slash command + message action (modal, verifica firma, creazione ticket)`

---

### Task 5: Web — badge source + documentazione webhook nel progetto

**Files:** `apps/web/src/components/badges.tsx` (SourceBadge: label per `slack`/`webhook`), i18n en/it, eventuale sezione nella pagina progetto che mostra l'URL del webhook generico, test.

- **SourceBadge**: aggiungi le label i18n per `slack` e `webhook` (coerenti con gli altri source). Parità en/it.
- **Webhook URL nel progetto**: nella pagina/impostazioni del progetto (dove è già mostrata la ingestion key / l'endpoint ingest dell'SDK), aggiungi una breve sezione che mostra l'URL del webhook generico `POST {publicUrl}/api/inbound/{slug}/ticket` con l'header `X-Stubwise-Key` e un esempio di payload, così l'utente sa come usarlo da Zapier/n8n/script. (Riusa il modo in cui è già esposta la ingestion key — NON ri-esporre la chiave se è mascherata; mostra solo l'URL e rimanda alla chiave già visibile.)
- i18n en/it (parità).

**Test web:** SourceBadge rende le nuove label; la sezione webhook del progetto mostra URL/esempio (se aggiunta). Mantieni verdi i test esistenti.

**Commit:** `feat(web): badge source slack/webhook + URL webhook nel progetto`

---

### Task 6: Docs + verifica finale

**Files:** `apps/docs/src/content/docs/` — nuova pagina o sezioni: "Inbound webhook" (endpoint, auth, payload, esempio curl, risposta) e "Slack" (creare l'app, scopes, signing secret + bot token in Settings, URL `/api/slack/commands` e `/api/slack/interactions`, uso di `/stubwise` e della message action, attribuzione via email). In inglese. Aggiorna la sidebar/nav se serve. `pnpm --filter @stubwise/docs build`.

**Verifica finale:** `pnpm lint` (root), `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @stubwise/web e2e`, `pnpm -r build`. Code review finale d'insieme vs design. **Deploy:** backup DB, migrazione additiva 0020 (enum ADD VALUE + colonne), rebuild server+worker+caddy, verifica `/health` + enum/colonne + CI verde. **Env/infra:** nessuna env obbligatoria nuova; Slack si configura da Settings dopo il deploy (e gli URL vanno impostati nella Slack app dell'utente).

**Commit:** `docs: ingestion esterna (webhook + Slack)`

---

## Note / follow-up (NON in questa v1)
- **Email → ticket** e **GitHub Issues → ticket**: rimandati (decisione di scope).
- **Sync bidirezionale** Slack↔ticket (commenti/stato): non in v1.
- **Mappatura canale Slack → progetto** (zero-friction): non in v1 (scelto il modal esplicito).
- **Collegamento identità Slack ↔ account** oltre al match per email: non in v1.
- **Verifica `url_verification` / Events API**: non necessaria (usiamo slash command + interactivity, non gli Events). Se in futuro si aggiungono gli Events, gestire il challenge `url_verification`.
