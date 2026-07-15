# Daily Activity Report — modello per-commit (descrizione dal diff)

Data: 2026-07-15
Stato: design validato. Rifonda il contenuto della feature Daily Activity Report
(già in prod) sul commit come unità.

## Problema

Il modello attuale genera UN riassunto AI per autore/giorno, aggregando tutti i
suoi commit in un paragrafo. Risultato vago e superficiale: l'agente riceve solo
i *subject* dei commit (non i diff) e ha istruzione di stare in "2-4 righe".

## Ripensamento (validato)

L'unità è il **commit**, non l'autore. Ogni commit porta già `autore`, `repo`
(→ progetto), `data`, `subject`, `+/−`. Aggiungiamo una **descrizione AI generata
dal diff di quel commit**. Le due viste diventano proiezioni degli stessi commit:
per progetto = `GROUP BY repo`, per persona = `GROUP BY autore`. Nessuna doppia
generazione, nessuna perdita di granularità.

## Decisioni

- **Dettaglio adattivo**: commit piccolo → 1 frase tecnica; commit grosso →
  paragrafo (file/funzioni, approccio, effetti). Markdown, tecnico (per i dev).
- **Intestazione gruppo non-AI**: numeri (n commit, +/−, n autori o n progetti);
  sotto, la lista dei commit con descrizione.
- **Volume**: descrivi TUTTI i commit non-merge, nessun tetto. Merge esclusi.

## Modello dati (migrazione 0050)

- **DROP** `activity_report_entries` (modello per-autore; dati storici solo di
  test).
- **CREATE** `activity_commits` — una riga per commit descritto:
  - `id` uuid PK
  - `reportId` uuid FK → activity_reports (cascade)
  - `sha` text, `repoId` uuid FK → repositories (cascade), `authorEmail` text
    (lowercase), `authorName` text nullable
  - `committedAt` timestamptz, `subject` text, `additions`/`deletions` integer
  - `aiDescription` text nullable (markdown; null se il run fallisce → fallback
    al subject)
  - unique `(reportId, repoId, sha)` (idempotenza rigenerazione)
  - index su `reportId`, su `authorEmail`
- `activity_reports` (intestazione progetto/giorno + status) invariata.

## Generazione (worker)

- Nuovo `MirrorManager.getCommitDiff(project, sha)` → diff del commit
  (`git show <sha>`), troncato con un tetto di sicurezza (come `getPrDiff`).
- In `generateForProject`, per ogni progetto: `getCommitsInRange` (come oggi),
  ESCLUDI i merge; per OGNI commit non-merge un run agente che riceve
  subject+numstat+diff e produce la descrizione **adattiva** (markdown, tecnico),
  `permissionMode: "plan"`. Best-effort: run fallito → `aiDescription = null`.
  Inserisci una riga `activity_commits` per commit (transazione col passaggio a
  `done`). Registra gli autori in `git_authors_seen` (come oggi).
- Nessun tetto: N run = numero commit non-merge, sequenziali nel serializer del
  progetto. Wall-clock di qualche minuto su giornate intense (coperto da stato
  "in generazione" + polling). Parallelizzazione dei run per-commit possibile in
  futuro (read-only, indipendenti); per ora sequenziale.
- Gate notturno, recovery orfani (running→queued), generazione manuale
  on-demand, retention: INVARIATI. Cambia solo *cosa* produce la generazione.

## API (`GET /api/activity?date=`)

Due viste popolate dai `activity_commits` del giorno (una query commit + mappa
`git_identities`→membro, resto aggregato in memoria):
- **per progetto**: `[{ project, header:{commitCount,additions,deletions,
  authorCount}, commits:[{sha,authorName,resolvedUser,committedAt,subject,
  additions,deletions,aiDescription}] }]` (commit per data).
- **per persona**: `[{ resolvedUser|gitEmail, header:{commitCount,additions,
  deletions,projectCount}, byProject:[{project,commits:[…]}] }]`.
- `status` del report mantenuto per lo stato "in generazione".

`POST /api/activity/generate` (manuale) invariato.

## UI (`/activity`)

Ogni gruppo (progetto o persona):
- **intestazione con numeri** (no AI);
- lista commit: sha breve (mono), autore (avatar se membro risolto, o email
  grezza), subject, +add/−del, descrizione in **markdown** (renderer esistente).
  Commit senza descrizione → solo subject.

Pulsante "Genera per questo giorno", stato "in generazione", polling, selettore
data: invariati.

## Test

- Schema: activity_commits (unique reportId+repoId+sha, cascade), drop entries.
- Worker: getCommitDiff (tetto); generateForProject produce una riga per commit
  non-merge con aiDescription (stub runner); merge esclusi; run fallito →
  aiDescription null ma riga presente; idempotenza/recovery invariati.
- Server: GET /api/activity aggrega i commit nelle due viste (header corretti,
  resolvedUser, raggruppamenti); giorno vuoto; status in-generazione.
- Web: viste per-progetto/per-persona rendono header+commit+markdown; email non
  risolta grezza; commit senza descrizione → subject; pulsante/polling invariati.

## Deploy

Backup DB (c'è la DROP). Migrazione 0050 → ribuildare `server`+`worker`; UI →
`caddy`. Nessuna nuova env. Check `doc_generations` prima del restart worker.
