# Daily Activity Report — riassunti finali (per progetto e per sviluppatore)

Data: 2026-07-16
Stato: design validato. Aggiunge uno step finale di sintesi al modello per-commit.

## Obiettivo

Dopo che tutte le descrizioni per-commit sono generate, produrre due riassunti
**narrativi estesi**:
- **per progetto**: aggrega le descrizioni dei commit del progetto → resoconto;
- **per sviluppatore** (cross-progetto): aggrega le descrizioni dei commit della
  persona su tutti i progetti del giorno → resoconto.

In `/activity`, ogni card mostra il riassunto in cima e sotto la tabella dei
commit con righe espandibili (la descrizione per-commit diventa collassata di
default).

## Decisioni

- **Taglio riassunti**: narrativo esteso (racconta la giornata; il dettaglio
  fine resta nei commit espandibili).
- **Raggruppamento dev-summary**: per persona se l'email è associata a un membro
  (unisce le sue email), per email se non associata. Calcolato al momento della
  generazione; il re-linking successivo non ricompone il riassunto (si rigenera
  ri-lanciando il giorno). Accettabile per un report giornaliero.

## Modello dati (migrazione 0051)

- `activity_reports.summary` text nullable (markdown, riassunto del progetto).
- **`activity_dev_summaries`**: `id`, `date`, `userId` uuid nullable (FK users,
  set null), `gitEmail` text nullable, `summary` text (markdown), `createdAt`.
  Unique parziali/where: uno per `(date, userId)` e uno per `(date, gitEmail)`.
- **`activity_day_rollups`**: `date` PK, `generatedAt` timestamptz. Gating della
  fase dev-summary (idempotenza per giorno).

## Generazione (worker)

### Riassunto per progetto — dentro `generateForProject`
Dopo aver generato le descrizioni per-commit e prima di chiudere il report:
un run agente riceve subject + descrizioni di tutti i commit del progetto e
produce il resoconto narrativo. Persistenza in transazione: insert commits +
`summary` + `status='done'`. Best-effort: run fallito → `summary=null`, report
comunque `done`. Un progetto con 0 commit non-merge → nessun summary.

### Riassunto per sviluppatore — fase di rollup gated per giorno
Nuova fase in `pollDailyReportsOnce` (dopo queued/notturna, prima della
retention): per ogni `date` con **tutti** i report `done` e **senza** riga
`activity_day_rollups`:
- carica i commit del giorno (con descrizioni), raggruppa per dev (membro via
  `git_identities`, o email se non risolto);
- per ogni gruppo un run agente sulle descrizioni dei suoi commit (cross-progetto)
  → riga `activity_dev_summaries`;
- scrive la riga `activity_day_rollups` (idempotenza; scritta anche se 0 dev, così
  il giorno non resta "pending").
I run del rollup NON toccano git (usano le descrizioni già in DB) → non serve il
serializer per-progetto. Best-effort: un gruppo che fallisce → summary null.

### Invalidazione del rollup su rigenerazione
Quando un report torna `queued`/`running` (rigenerazione manuale o recovery
orfano), cancella la riga `activity_day_rollups` di quel `date` (il rollup verrà
rifatto quando tutti i report tornano `done`) e le `activity_dev_summaries` di
quel giorno.

## API (`GET /api/activity?date=`)

- `projects[].summary` (string|null) e `developers[].summary` (string|null).
- Flag a livello di risposta `developersSummaryPending: boolean` = true se i
  report del giorno sono tutti `done` ma manca la riga di rollup (con almeno un
  commit nel giorno). Serve al polling della UI.
- Il dev-summary si legge da `activity_dev_summaries` per la chiave del gruppo
  (userId o gitEmail), coerente col raggruppamento della vista developers.

## UI (`/activity`)

Card (dall'alto): intestazione (nome + status + numeri, cliccabile per
collassare l'intero blocco — invariato) → **riassunto narrativo** (markdown; se
non pronto, placeholder "riassunto in generazione…") → **tabella commit** con
righe espandibili: riga compatta (sha, ora, autore in vista progetto, oggetto,
+/−, chevron); click/chevron espande la descrizione markdown del commit
(collassata di default, `aria-expanded`).

**Polling**: continua finché ci sono report `queued`/`running` **oppure**
`developersSummaryPending` è true; poi si ferma.

## Test

- Schema: nuove colonne/tabelle, unique, cascade; migrazione 0051.
- Worker: riassunto-progetto in generateForProject (run sulle descrizioni, done
  con summary; run fallito → null); fase rollup (gate tutti-done, per-gruppo
  cross-progetto, idempotenza via day_rollups, invalidazione su re-queue).
- Server: summary in projects/developers, developersSummaryPending true/false,
  dev-summary risolto per gruppo.
- Web: riassunto in cima (markdown/placeholder), righe commit espandibili
  (descrizione collassata di default), polling esteso col flag.

## Deploy

Backup DB (nuova migrazione, non distruttiva). Migrazione 0051 → ribuilda
`server`+`worker`; UI → `caddy`. Nessuna nuova env. Check `doc_generations` prima
del restart worker.
