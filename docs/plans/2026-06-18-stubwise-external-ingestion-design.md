# Stubwise — Ingestion in entrata da fonti esterne (design)

> Design validato il 2026-06-18. Copre la voce "Ingestion in entrata da fonti
> esterne" della sezione 3 del backlog (`docs/plans/feature-backlog.md`). Scope
> v1: **Webhook generico** + **Slack**. Email→ticket e GitHub Issues sono
> esplicitamente FUORI scope per ora (scelta dell'utente).

## Obiettivo

Far confluire ticket da canali che non passano per l'SDK: un **webhook generico
in entrata** (Zapier/n8n/script custom) e **Slack** (slash command + message
action). I ticket esterni entrano nella pipeline AI come tutti gli altri.

## Principio guida

Entrambe le fonti convergono sull'unico percorso interno già esistente —
`createTicket(...)` + le `automation_rules` — così i ticket esterni seguono la
pipeline AI (triage → fix) senza codice speciale. Cambia solo l'**adattatore
d'ingresso** e l'**autenticazione**.

## Componenti

### 1. Webhook generico in entrata
- **Endpoint:** `POST /api/inbound/:slug/ticket` (nuovo, separato dall'`/ingest/:slug`
  dell'SDK per offrire un contratto pulito *single-ticket* invece del batch
  `{events:[...]}`).
- **Auth:** header `X-Stubwise-Key` confrontato con `projects.ingestionKey` (stesso
  pattern di `/ingest`: ramo di rifiuto unico 401 — chiave assente / slug ignoto /
  chiave errata indistinguibili — e rate-limit per-chiave). Limite di dimensione body.
- **Payload (JSON):**
  ```json
  { "title": "...", "body": "...",
    "type": "bug|feature|task|…",
    "priority": "low|medium|high|…",
    "reporterEmail": "user@example.com" }
  ```
  `body`/`priority`/`reporterEmail` opzionali (priority default "medium"). Validato
  con zod dedicato (riusa `ticketTypeSchema`/`ticketPrioritySchema`).
- **Risposta:** **201** con `{ id, number, url }` (creazione sincrona di un singolo
  ticket — comoda per le automazioni). Payload non valido → **422** (coerente col
  contratto ingest).
- **Comportamento:** crea il ticket con `source: "webhook"`; attribuzione via
  `reporterEmail` (sotto). Entra nelle `automation_rules` come un ticket UI/SDK.
- **YAGNI:** niente trasformazioni custom, niente mappatura campi configurabile,
  niente batch (per quello c'è già l'SDK ingest). Un payload → un ticket.

### 2. Slack app (una per istanza)
- **Modello:** un workspace Slack → una istanza Stubwise. L'admin registra l'app su
  api.slack.com e incolla **signing secret** + **bot token** in Settings →
  Integrations (cifrati AES-256-GCM come le credenziali S3). Scopes: `commands`,
  `users:read`, `users:read.email`, interactivity + message action abilitate.
- **Endpoint (pubblici, verificati con signing secret):**
  - `POST /api/slack/commands` — riceve `/stubwise`. Slack pretende risposta entro
    **3 secondi**: si risponde subito aprendo un modal via `views.open` (col
    `trigger_id`), senza creare nulla ancora.
  - `POST /api/slack/interactions` — riceve il `view_submission` del modal e la
    **message action** (`message_action` → apre il modal precompilato col testo del
    messaggio).
- **Verifica:** HMAC-SHA256 su `X-Slack-Signature` + `X-Slack-Request-Timestamp`
  (raw body, finestra anti-replay ~5'). Serve il **raw body**: content-type
  parser/scope dedicato (Slack invia `application/x-www-form-urlencoded`).
- **Modal (Block Kit):** select **progetto** (progetti dell'istanza), input
  **titolo**, **descrizione** (multiline), select **tipo**. La message action
  precompila titolo/descrizione dal messaggio. Al `view_submission`: crea il ticket
  (`source: "slack"`), attribuzione via email (`users.info`), conferma effimera +
  link al ticket.
- **YAGNI:** niente sync bidirezionale Slack↔ticket, niente notifiche in entrata
  (le notifiche *in uscita* esistono già). Solo creazione.

### 3. Attribuzione condivisa
- Funzione `resolveReporter(email)` che cerca un utente Stubwise per email
  (case-insensitive):
  - **match** → ticket attribuito/assegnato a quell'utente (`assigneeId`); l'azione
    compare nel feed attribuita a lui.
  - **no match / email assente** → `assigneeId` null; l'identità della sorgente
    (es. "Created from Slack by @mario.rossi" o `reporterEmail`) è scritta in testa
    al corpo del ticket come metadato leggibile, più il badge `source`.
- Per Slack l'email arriva da `users.info` (`users:read.email`); scope mancante o
  email non pubblica → fallback. Per il webhook è il campo opzionale `reporterEmail`.
- **Il match per email NON è autenticazione** e non concede privilegi: serve solo ad
  attribuire/assegnare. Un'email arbitraria nel webhook può solo puntare un ticket a
  un utente esistente, non compiere azioni.

## Modello dati (migrazione additiva)

- `ticketSource` enum: aggiungo **`slack`** e **`webhook`** (`ALTER TYPE ADD VALUE`,
  additivo come `milestone_changed`). `SourceBadge` UI: due nuove label i18n.
- `instance_settings`: `slackSigningSecretEncrypted`, `slackBotTokenEncrypted` (text
  nullable, cifrati). `slackEnabled` = derivato (entrambi presenti), come
  `attachmentsEnabled` per S3. GET espone solo `slackEnabled` + flag "secret set",
  mai i segreti.
- Nessuna nuova tabella: i ticket esterni sono normali righe `tickets`.

## Pipeline AI e audit

- I ticket esterni passano dalle `automation_rules` esistenti come quelli UI/SDK:
  nessun trattamento speciale (se una regola prevede auto-fix, parte; altrimenti
  restano in attesa).
- Nessun `ticket_event` speciale per la creazione esterna: il `source` sul ticket è
  già il marcatore (coerente con i ticket SDK).

## Sicurezza

- Webhook: `ingestionKey` per-progetto, rate-limit per-chiave, rifiuto unico 401,
  limite dimensione body. Markdown sanitizzato in rendering (componente esistente).
- Slack: verifica HMAC obbligatoria (signature + timestamp anti-replay); endpoint
  rispondono "non abilitato" senza app configurata; credenziali cifrate a riposo,
  mai esposte in lettura.

## Gestione errori

- Slack: rispondere a `/stubwise` entro 3s (apri modal subito, crea dopo); errori di
  creazione → messaggio effimero leggibile, mai 500 silenzioso.
- Webhook: 401 auth, 422 payload non valido, 201 con `{id,number,url}`; errori con
  `code` inglese come il resto dell'API.

## Testing (TDD, testcontainers + unit)

- **Webhook:** auth ok/ko, payload valido → 201 + ticket + `source=webhook`, default
  type/priority, `reporterEmail` match → assegnato / no-match → fallback, 422,
  rate-limit.
- **Slack:** verifica firma (valida / scaduta / manomessa → rifiuto), apertura modal
  su command e message action, `view_submission` → ticket `source=slack`,
  attribuzione via email (`users.info` mockato), "non abilitato" senza credenziali.
- **Attribuzione:** `resolveReporter` match case-insensitive / no-match.
- **i18n** en/it parità (badge source, Settings Slack).

## Deploy

Migrazione additiva (enum + colonne `instance_settings`); nessuna env obbligatoria
nuova (Slack si configura da Settings dopo il deploy); rebuild server+worker+caddy;
verifica `/health` + enum/colonne + CI.

## Fuori scope (follow-up documentati)

- **Email → ticket** (provider inbound / IMAP / mailserver): rimandato.
- **GitHub Issues → ticket** (webhook repo): rimandato.
- **Sync bidirezionale** (commenti, stato) verso Slack/sorgenti: non in v1.
- **Mappatura canale Slack → progetto** (zero-friction senza modal): non in v1
  (scelto il modal con selettore progetto esplicito).
- **Collegamento identità Slack ↔ account Stubwise** (oltre al match per email):
  non in v1.
