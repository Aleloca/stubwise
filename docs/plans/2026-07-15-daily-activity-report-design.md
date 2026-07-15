# Daily Activity Report — standup asincrono dai commit

Data: 2026-07-15
Stato: design validato, non ancora implementato

## Obiettivo

Ogni notte, per ogni progetto collegato, raccogliere tutti i commit del giorno
dai repo, attribuirli agli sviluppatori e produrre uno **standup asincrono**:
una sezione SPA navigabile per data dove il team vede, per ciascun dev, un
riassunto in linguaggio naturale di cosa ha fatto, con i commit sotto.

Non è uno strumento di metriche/produttività: il valore è la leggibilità e il
coordinamento, non i numeri.

## Fattibilità (perché è semplice)

Il worker mantiene già un **mirror git completo** di ogni repo collegato
(`git clone --mirror`, aggiornato on-demand con `fetch --prune`, vedi
`apps/worker/src/git/mirrors.ts`). Quindi NON serve l'API del provider né scope
aggiuntivi sul token: basta `git log` locale sul mirror per ottenere tutti i
commit del giorno con autore, email, timestamp e numstat. L'unico accorgimento è
che il mirror si aggiorna on-demand, quindi il job notturno deve fare prima un
`fetch --prune`.

## Decisioni di prodotto

- **Scopo**: standup asincrono (non metriche, non changelog).
- **Consegna**: sezione nella SPA con storico navigabile per giorno.
- **Contenuto per dev**: riassunto AI (l'agente legge i diff del giorno) + i
  commit grezzi sotto.
- **Aggregazione**: due viste — per progetto e globale per-dev.
- **Identità**: il report si genera SEMPRE sull'email git grezza; l'associazione
  email git / account Bitbucket ai membri si fa da `/team`, riusando il pattern
  del linking Slack esistente. Un'email non associata compare comunque; una volta
  associata, l'autore è mostrato come il membro (risoluzione a display time,
  nessuna rigenerazione).

## Modello dati

Riferimenti al pattern esistente: `packages/db/src/schema.ts:190-206` (`users`
con `slackUserId`/`slackAvatarUrl` come colonne di linking).

Lo Slack usa una singola colonna perché un utente = un id Slack. Per git un dev
committa spesso con più email → serve una tabella a parte.

### Nuove tabelle

- **`git_identities`** — alias email → membro (relazione 1 membro : N email).
  - `id` uuid PK
  - `userId` uuid FK → users (onDelete cascade)
  - `email` text notNull unique (memorizzata lowercase)
  - `authorName` text nullable
  - `createdAt` timestamptz notNull default now()

- **`git_authors_seen`** — auto-raccolta degli autori realmente osservati nei
  repo, per alimentare il picker in `/team` (analogo a `slack workspace-users`).
  - `email` text PK (lowercase)
  - `authorName` text nullable
  - `firstSeenAt` / `lastSeenAt` timestamptz
  - (la risoluzione a membro passa da `git_identities`, non serve `userId` qui)

- **`activity_reports`** — un report per (progetto, giorno UTC).
  - `id` uuid PK
  - `projectId` uuid FK → projects
  - `date` date notNull (giorno UTC)
  - `status` enum (`queued` | `running` | `done` | `failed`)
  - `createdAt` timestamptz
  - unique `(projectId, date)` → idempotenza del gate notturno

- **`activity_report_entries`** — una riga per (report, autore).
  - `id` uuid PK
  - `reportId` uuid FK → activity_reports (onDelete cascade)
  - `gitEmail` text notNull (lowercase)
  - `authorName` text nullable
  - `commitCount` / `additions` / `deletions` integer
  - `repoIds` jsonb (repo toccati)
  - `commits` jsonb (`[{ sha, subject, repoId }]`)
  - `aiSummary` text nullable
  - `resolvedUserId` NON persistito: la risoluzione email→membro avviene a
    display time via `git_identities` (così associare dopo non richiede
    rigenerare).

### Colonne su `users`

- **`bitbucketUsername`** text unique nullable — speculare a `slackUserId`
  (account provider singolo per membro).

## Scheduling ed esecuzione

Riferimenti al pattern esistente: i poller ricorrenti in
`apps/worker/src/index.ts:212-317`, struttura canonica in
`apps/worker/src/review/poller.ts:146-177` e
`apps/worker/src/providers/limit-resume-poller.ts`. Serializer per-progetto in
`apps/worker/src/handler.ts:298-317`. NON esiste oggi un cron a mezzanotte: si
combina il pattern poller (`setInterval`) con un gate temporale.

### Poller

Nuovo file `apps/worker/src/reports/daily-report-poller.ts`, struttura canonica:
`setInterval` in minuti, flag `running` anti-sovrapposizione, `timer.unref()`,
stop idempotente su `signal.abort`. Registrato in `apps/worker/src/index.ts`
accanto agli altri `start*Poller`. Knob env `DAILY_REPORT_POLL_MINUTES`
(default 15) in `apps/worker/src/config.ts`.

### Gate a mezzanotte UTC

Ad ogni tick, per ogni progetto con `dailyReportEnabled`, verifica se esiste un
`activity_reports` per il **giorno precedente** (UTC — coerente con i cap
giornalieri già in UTC, `apps/server/src/app.ts:168`). Se manca ed è passata la
mezzanotte, inserisce la riga `status='queued'` (l'unique `(projectId, date)`
previene doppioni tra tick concorrenti) e la processa. Pattern "rivaluta a ogni
tick" del resume poller — nessuna colonna `run_at`.

### Esecuzione per-progetto (serializzata)

Dentro `serializer.run(projectId, …)` con il serializer condiviso
(`apps/worker/src/index.ts:117`), per non collidere col mirror git (fix/docs/
review dello stesso progetto):

1. `ensureMirror` → `fetch --prune` sui repo del progetto.
2. `git log --all --since/--until` sulla finestra del giorno UTC, con
   `--numstat` e formato: sha, email autore, nome, data ISO, subject.
3. Raggruppa per email (lowercase) → `activity_report_entries` con conteggi e
   lista commit. Registra le email nuove in `git_authors_seen`.
4. Per ogni autore con commit, un run dell'agente (claude CLI, stesso pattern di
   Docs/fix) sui diff/subject del giorno → `aiSummary`.
5. `status='done'`.

### Robustezza

Best-effort come gli altri poller: ogni progetto in try/catch isolato (il tick
non propaga mai); l'agente che fallisce per un singolo autore lascia l'entry coi
dati grezzi e nessun summary.

## Interfaccia (SPA)

### Sezione "Attività"

Nuova route SPA con storico navigabile (modello `/monitor`), visibile a **tutti
i membri**. Selettore data (default: ieri) e due tab:

- **Per progetto**: per il giorno scelto, un blocco per progetto → autori
  (avatar/nome del membro risolto, o email grezza in corsivo se non associata),
  riassunto AI, e sotto i commit (subject, repo, +/−).
- **Globale per-dev**: un blocco per sviluppatore che aggrega i commit del giorno
  su tutti i repo/progetti.

Entrambe leggono gli stessi `activity_report_entries`, aggregati diversamente.
Email non associate compaiono comunque, con hint "associa in Team" per gli admin.

### Linking in `/team`

Riferimenti: `apps/web/src/routes/team.tsx` (MemberRow, SlackPicker),
`apps/server/src/slack/identity-routes.ts`, resolver
`apps/server/src/ingest/reporter.ts`.

Estendo `MemberRow` con azioni accanto a quelle Slack (solo admin):

- **Git**: badge `GIT · N email`; LINK apre un picker che pesca da
  `git_authors_seen` (ricerca/autocomplete come `SlackPicker`), associabili più
  email; UNLINK per singola email.
- **Bitbucket**: badge `BITBUCKET · username` + LINK/UNLINK, speculare a Slack
  (colonna singola).

### API server

Nuovo plugin stile `identity-routes.ts` (`requireAdmin` per il linking):

- `GET /api/git/observed-authors` → email da `git_authors_seen` con eventuale
  `linkedUserId`.
- `POST /api/users/:id/git-identities` `{ email }` /
  `DELETE /api/users/:id/git-identities/:email`.
- `PUT /api/users/:id/bitbucket` `{ username }` / `DELETE /api/users/:id/bitbucket`.
- `GET /api/activity?date=&view=project|dev` → i report (visibile ai membri).

Gestione unique violation → 409 (es. `git_identity_taken`,
`bitbucket_identity_taken`), 404 su utente inesistente — come il pattern Slack.

## Config, costi, casi limite

### Abilitazione e permessi

- Toggle per-progetto `dailyReportEnabled`.
- Sezione "Attività" visibile a tutti i membri; linking in `/team` solo admin.

### Costo agente

- Un run per (progetto, autore) al giorno, solo autori con commit.
- Cap `DAILY_REPORT_MAX_AUTHORS_PER_PROJECT` (default 25); oltre il cap, entry
  senza summary ma con dati grezzi + `log()` di quanti saltati (niente
  troncamento silenzioso).
- Interazione col limite provider: **best-effort**. Se l'agente va in limite,
  l'entry resta coi dati grezzi e nessun summary. NIENTE resume complesso in MVP
  (a differenza di Docs). Limite noto documentato.

### Casi limite

- Progetto senza commit nel giorno → report `done` vuoto ("nessuna attività"),
  non saltato (storico completo).
- Commit di merge e bot (`*@users.noreply`, dependabot, …): flag configurabile
  per escluderli; default esclude i merge.
- Autore con email in più progetti → più entry, aggregate nella vista per-dev.
- Retention: env `DAILY_REPORT_RETENTION_DAYS` (default 90); pulizia in coda al
  poller.

## Test (Vitest, testcontainers dove serve)

- Risoluzione email→membro: case-insensitive, multi-email, email non associata.
- Gate mezzanotte UTC e idempotenza unique `(projectId, date)`.
- Parsing `git log --numstat`.
- Esclusione merge/bot.
- API link/unlink git-identity e bitbucket: 409 su unique, 404 su utente assente.
- Rendering delle due viste SPA (happy-dom).

## Deploy

Modifiche a backend (server + worker) e frontend (`apps/web`):

- Ribuilda `server` e `worker` (nuovo poller, nuove route, migrazioni).
- Ribuilda `caddy` (nuova sezione SPA + linking in `/team`).
- Nuove env: `DAILY_REPORT_POLL_MINUTES`, `DAILY_REPORT_MAX_AUTHORS_PER_PROJECT`,
  `DAILY_REPORT_RETENTION_DAYS`.
- Migrazioni Drizzle applicate all'avvio del server.

## Limiti noti / possibili estensioni future

- Nessun resume sul limite provider per i summary notturni (best-effort).
- Attribuzione via API provider (Bitbucket/GitHub) non usata: ci si basa
  sull'email git. `bitbucketUsername` è predisposto per un futuro arricchimento.
- Consegna Slack/email del digest non inclusa (solo SPA); riutilizzabile il
  package `notifications` in un secondo momento.
