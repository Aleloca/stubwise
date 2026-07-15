# Daily Activity Report — generazione manuale on-demand

Data: 2026-07-15
Stato: design validato, estende la feature Daily Activity Report (già in prod)

## Problema

Il poller genera solo il report di *ieri* (`previousUtcDay`). Non c'è modo di:
- generare il report di una data passata (backfill), né
- forzare una generazione on-demand per provarla senza aspettare la mezzanotte.

## Soluzione (validata)

Un pulsante **"Genera report per questo giorno"** nella pagina `/activity`,
visibile agli admin quando per la data selezionata non c'è ancora un report.
Genera il report di quel giorno per **tutti i progetti con
`dailyReportEnabled=true`** (come farebbe il poller a mezzanotte).

Riusa lo stato `queued` di `activity_reports` (finora "riservato"): il server
accoda, il poller esistente genera. Nessuna nuova tabella, nessuna migrazione.

## Decisioni

- **Ambito**: una data alla volta, dalla UI `/activity`. Un click = tutti i
  progetti abilitati per quel giorno.
- **Reattività**: semplice. Il poller notturno esistente, a ogni tick (~15 min),
  oltre al report di ieri raccoglie anche i `queued` manuali. La UI fa polling e
  mostra lo stato reale nell'attesa.
- **Date ammesse**: fino a oggi (l'input è già cappato). Generare *oggi* dà un
  report parziale del giorno in corso (utile per il test); i giorni passati sono
  completi.

## Backend

### Endpoint `POST /api/activity/generate` (admin)
- Body: `{ date: "YYYY-MM-DD" }` (stessa validazione di calendario reale di
  `GET /api/activity`).
- Per ogni progetto con `dailyReportEnabled=true`, insert
  `activity_reports { projectId, date, status: 'queued' }` con
  `onConflictDoNothing` sull'unique `(projectId, date)` (non tocca i giorni già
  generati, niente doppioni).
- Risposta: `{ queued: number }` (0 se nessun progetto abilitato).

### Poller esteso (`pollDailyReportsOnce`)
A ogni tick, **prima** del gate notturno:
- SELECT delle coppie `(projectId, date)` dei report con `status='queued'`;
- per ciascuna, dentro `serializer.run(projectId, …)`, chiama
  `generateForProject(project, date)`.

Poi come oggi: gate notturno `previousUtcDay` per gli abilitati, retention.

### Generalizzazione di `generateForProject`
Oggi calcola la finestra con `previousUtcDay`. La si parametrizza sulla data:
`[date 00:00 UTC, date+1 00:00 UTC)`. Il resto (claim/reclaim, aggregazione,
riassunto AI, persistenza) è INVARIATO — il reclaim esistente processa
naturalmente la riga `queued` (la vede non-`done` → `running` → genera → `done`).

## Frontend

### Client (`api.ts`)
`generateActivity(date): Promise<{ queued: number }>` → `POST /api/activity/generate`.

### Pagina `/activity`
- **Nessun report per il giorno** (`projects: []`): pulsante admin "Genera report
  per questo giorno". Al click → `generateActivity(date)`:
  - `queued ≥ 1` → refetch, la vista mostra i blocchi in stato "in generazione…";
  - `queued === 0` → messaggio "Nessun progetto ha il report attività abilitato"
    con link al dettaglio progetto.
- **Report in corso** (`status` `queued`/`running`): blocco progetto con etichetta
  "in generazione…" + **refetch periodico** (~10s) finché esistono report
  non-`done`, così la pagina si aggiorna da sola al termine.

Il pulsante è admin-only; per i non-admin resta il messaggio "nessun report".

## Test

- Server: `POST /api/activity/generate` accoda `queued` per gli abilitati
  (skip dei già presenti via onConflict), 0 se nessun abilitato; admin-only
  (403 member, 401 non auth); date malformata → 400.
- Worker: il poller raccoglie i `queued` di una data arbitraria e li genera
  (report → `done` con entries); idempotenza (un `done` non viene rigenerato);
  `generateForProject` con data esplicita usa la finestra corretta.
- Web: pulsante visibile solo admin su giorno vuoto; click chiama l'endpoint;
  stato "in generazione" per report non-`done`; polling che si ferma a `done`;
  messaggio quando `queued === 0`.

## Deploy
Backend (server + worker) → ribuildare `server` e `worker`. Frontend (`apps/web`)
→ ribuildare `caddy`. Nessuna nuova env, nessuna migrazione.
