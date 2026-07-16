# Daily Activity Report — rilevamento commit mancanti + rigenerazione

Data: 2026-07-16
Stato: design validato. Chiude il limite "commit pushati su giorni già generati".

## Problema

I report sono generati sul giorno della **committer date** dei commit. Il poller
automatico genera solo il giorno precedente e non rigenera i giorni `done`.
Quindi commit con committer date di un giorno già generato (pushati dopo) NON
entrano in alcun report, e:
1. non si può chiedere una nuova generazione di un giorno già `done`;
2. non c'è alcun segnale che un report è incompleto.

## Soluzione (validata): segnala + rigenera a mano

- **Rilevamento** via webhook di push → job di recount nel worker (git-only) →
  `stale_commit_count` sul report.
- **UI**: badge/avviso col numero di commit mancanti + pulsante admin "Rigenera"
  (nessun run AI parte senza richiesta esplicita).

## Modello dati (migrazione 0052)

- `activity_reports.stale_commit_count` int notNull default 0 — commit di quel
  giorno presenti nel repo ma assenti dal report. Azzerato alla (ri)generazione.
- **`activity_recount_jobs`**: `projectId` PK (FK projects cascade), `notBefore`
  timestamptz. Debounce per-progetto (upsert sposta notBefore avanti), come
  `pr_review_jobs`/`doc_auto_update_jobs`.

## Rilevamento

### Webhook push (server)
Il webhook di push esistente (`apps/server/src/routes/webhooks.ts`), per un repo
il cui progetto ha `dailyReportEnabled=true`, fa upsert in `activity_recount_jobs`
per il `projectId` con `notBefore = now + debounce` (es. 60s). Nessun altro
effetto se il toggle è off.

### Fase recount (worker, nel daily-report poller)
Nuova fase in `pollDailyReportsOnce`: claim dei recount scaduti
(`DELETE ... WHERE not_before <= now RETURNING`, pattern debounce). Per ogni
`projectId`, dentro `serializer.run` (tocca il mirror), best-effort:
- carica i report `done` del progetto entro la retention;
- per i repo del progetto, `git log --branches --since=(now-retention)` →
  committer date + sha (merge esclusi), raggruppati per giorno UTC;
- per ogni report `done`: sha attesi del giorno (da tutti i repo) vs sha presenti
  in `activity_commits` di quel report → `stale_commit_count = |mancanti|`
  (ricalcolo pieno, non incrementale, così ripetuti recount sono idempotenti).
- I giorni senza commit mancanti tornano a 0 (es. dopo una rigenerazione).

Latenza: fino all'intervallo del poller (~15 min) — accettabile, il badge non è
urgente. Il recount è git-only (nessun agente): costo basso.

## API (`GET /api/activity` + `POST /api/activity/generate`)

- `GET`: `projects[].staleCommitCount` (dal report) + `staleCommitTotal`
  top-level (somma sui progetti del giorno).
- `POST /generate`: nuovo flag `force` (boolean, default false). Senza force =
  comportamento attuale (solo progetti senza report, onConflictDoNothing). Con
  `force`: per i progetti abilitati, i report `done`/`failed` del giorno vengono
  rimessi `queued` (update), i mancanti creati. Il poller li rigenera (reclaim →
  ricostruisce commit + azzera stale_commit_count + summary + rollup).
  Ritorna `{ queued }` = report accodati (nuovi + forzati).

## UI (`/activity`)

Per la data selezionata, quando esiste già un report:
- Pulsante admin **"Rigenera"** in cima (accanto a selettore/tab): chiama
  `generateActivity(date, { force: true })` → invalida la query → stato "in
  generazione" + polling esistenti.
- Se `staleCommitTotal > 0`: **avviso di giornata** "⚠ N nuovi commit non inclusi
  dopo l'ultima generazione — Rigenera" (visibile a tutti; pulsante admin-only).
- Vista per progetto: **badge sulla card** del progetto con `staleCommitCount > 0`
  ("N nuovi commit"), per indicare quale progetto è incompleto.

Polling: invariato (queued/running o developersSummaryPending). Dopo la
rigenerazione lo stale torna 0.

## Test

- Schema: stale_commit_count default 0; activity_recount_jobs PK/debounce; 0052.
- Server webhook: push su repo di progetto abilitato → upsert recount job
  (debounce sposta notBefore); progetto disabilitato → nessun job.
- Worker recount: git log del giorno vs activity_commits → stale_commit_count
  corretto (commit mancante conta; dopo rigenerazione → 0); idempotenza; solo
  report done entro retention.
- Server generate force: force riaccoda i done→queued; senza force invariato.
- Server GET: staleCommitCount/staleCommitTotal esposti.
- Web: badge/avviso quando stale>0, pulsante Rigenera (force) admin, invalidazione.

## Deploy

Backup DB (migrazione additiva 0052). Migrazione → ribuilda `server`+`worker`;
UI → `caddy`. Nessuna nuova env. Check `doc_generations` prima del restart worker.
I webhook Bitbucket/GitHub push devono già essere configurati (lo sono per docs/
pr-review): il recount riusa lo stesso evento push.
