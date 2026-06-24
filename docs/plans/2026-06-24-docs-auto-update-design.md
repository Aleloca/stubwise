# Auto-aggiornamento della documentazione su push — Design

**Data:** 2026-06-24
**Stato:** approvato. Implementazione in 2 fasi.

## Obiettivo

Ad ogni push sul branch di produzione di un progetto:
1. analizzare cosa è cambiato;
2. **rigenerare in modo mirato** solo le pagine di documentazione toccate (non
   l'intero albero);
3. creare una entry in una nuova sezione **"releases"** che traccia nel tempo le
   release e cosa contengono.

Tutto opzionale e controllato per costo/rumore.

## Decisioni (validate)

- **Refresh = rigenerazione mirata**: dal diff → pagine esistenti via
  `doc_pages.sourcePath` (+ overview-antenato) → rigenero SOLO quelle in-place.
  Il motore ricorsivo resta full-only per la generazione completa manuale; la
  mirata è un percorso nuovo e separato.
- **Controlli costo (tutti)**: debounce dei push, toggle per progetto (default
  off), skip dei diff di solo rumore, riuso del "provider bloccato" per i job auto.
- **Releases**: una entry per push, con **filtro di significatività** (l'agente
  marca "minore" i push banali).

## Stato attuale (mappa)

- `docGenerationTrigger` ha già `"push"` (predisposto); `projects.defaultBranch`
  esiste; webhook git `POST /webhooks/git/:projectSlug` (HMAC) esiste ma gestisce
  solo merge/chiusura PR — **niente push**.
- Motore ricorsivo **full-only** (`packages/docs-engine/src/recursive/`,
  `apps/worker/src/docs/recursive/`): rigenera sempre tutto; `doc_pages.sourcePath`
  esiste ma nessuna query lo usa per mappare file→pagina.
- **Manca**: parsing push, wrapper `git diff --name-only` nel MirrorManager,
  percorso push→job, logica mirata, query sourcePath→pagina.

## Architettura

### Trigger, debounce e gate (server)

1. Estendere il webhook git per parsare l'evento **push** (branch,
   `beforeSha`/`afterSha`, commit) oltre alle PR. Il provider `@stubwise/git`
   impara a estrarlo.
2. **Gate 1**: procedere solo se branch == `projects.defaultBranch` E
   `projects.docAutoUpdate` è on. Altrimenti 200 no-op.
3. **Debounce**: upsert di un pending per progetto in `doc_auto_update_jobs`:
   `fromSha` (= `commitSha` della generazione corrente / ultimo toSha), `toSha`
   (= head del push, aggiornato ad ogni push), `notBefore = now + N min`. Push
   ravvicinati spostano `notBefore` e aggiornano `toSha`.
4. Un **poller nel worker** (pattern dei poller esistenti usage/credential)
   reclama i pending con `notBefore <= now`.

### Job di auto-update (worker, nella catena per-progetto)

1. Apre il worktree al `defaultBranch` (`toSha`); calcola
   `git diff --name-only fromSha..toSha` (nuovo metodo MirrorManager) + i commit.
2. **Gate 2 (rumore, deterministico)**: se i file cambiati sono tutti rumore
   (lockfile, cartelle escluse plans/docs/…) → skip totale, aggiorna solo `fromSha`.
3. **Agente di analisi** (1 run read-only): input = file cambiati + commit + diff
   dei file rilevanti. Output strutturato: significatività (sostanziale/minore),
   contenuto della **entry release**, elenco **pagine impattate** (aiutato da un
   mapping deterministico sourcePath→pagina + antenati).
4. **Rigenerazione mirata** (Fase 2): per ogni pagina impattata (con un tetto),
   run "refresh pagina" (pagina attuale + nuovo codice del sourcePath + diff) →
   nuovo corpo; update `doc_pages.body`+`commitSha`, **re-embed** dei chunk.
   Pagine non toccate invariate. Aree nuove non mappate → segnalate nella entry.
5. **Entry release**: nuova pagina `kind="releases"` (una per push), corpo
   dell'agente, "[minore]" se tale, cross-link alle pagine aggiornate.
6. Aggiorna `commitSha` della generazione corrente a `toSha`.

Robustezza: best-effort/idempotente, ricalcolabile dal range SHA (fail-on-restart
ok); un refresh fallito di una pagina non blocca le altre né la entry.

### Dati

- `projects.docAutoUpdate boolean not null default false` — toggle.
- `projects.docAutoUpdateProviderId uuid` (FK `ai_providers`, on delete set null)
  — provider bloccato per i job auto (riuso `loadProviderById`).
- Nuova tabella `doc_auto_update_jobs`: `id`, `projectId` UNIQUE (un pending per
  progetto), `fromSha text`, `toSha text`, `notBefore timestamptz`, `createdAt`,
  `updatedAt`. (Eventuale `status`/`attempts` se serve per il claim.)
- `doc_page_kind` += `releases` (enum `ALTER TYPE … ADD VALUE 'releases'`).

### Releases come `doc_pages` (riuso del rendering)

- Una release = pagina `kind="releases"`, **persistente** come le manuali
  (`generationId` null → sopravvive alle rigenerazioni e al prune), `isManual`
  false (non editabile dal CRUD manuale). Slug `release-<data>-<shortSha>`.
- `position` impostata così le più recenti stanno in cima.
- Cross-link alle pagine aggiornate via il campo `links` già esistente.

### UI

- `DocsTree`: aggiungere `releases` a `GROUP_ORDER` + label → nuovo gruppo
  "Releases" nella sidebar. Nessun'altra modifica (pagina/markdown/cross-link/
  command palette si riusano).
- Impostazioni progetto: toggle "Auto-aggiorna la documentazione ad ogni push" +
  select opzionale del provider per i job automatici.

## Fasi

- **Fase 1 — Changelog automatico end-to-end**: dati (toggle, provider auto,
  `doc_auto_update_jobs`, kind `releases`), wrapper `git diff`, parsing push nel
  webhook, poller di debounce, gate rumore, agente di analisi → **entry release**
  con filtro di significatività. (Niente refresh dei docs ancora.) Già utile da sola.
- **Fase 2 — Rigenerazione mirata**: mapping sourcePath→pagine + antenati, agente
  "refresh pagina", update in-place + re-embed, segnalazione aree nuove.

## Testing

- DB: migrazioni (colonne progetto, tabella debounce, enum releases).
- Server: webhook push → upsert debounce (branch/toggle); branch diverso o toggle
  off → no-op; HMAC invariato.
- Worker: poller reclama solo gli scaduti; gate rumore; agente analisi (runner
  fake) → entry release + flag minore; Fase 2: mapping, refresh in-place + re-embed,
  pagine non toccate invariate, aree nuove segnalate.
- Git: wrapper diff --name-only.
- Web: gruppo Releases; toggle + select provider nelle impostazioni.

## Deploy

`server` (webhook + migrazioni) + `worker` (poller + agenti) + `caddy` (UI). Worker
ricostruito a generazioni ferme (fail-on-restart, vedi CLAUDE.md).

## Fuori scope (v1)

- Creazione automatica di pagine per aree NUOVE non documentate (solo segnalate).
- Gestione fine di file cancellati/rinominati (best-effort).
- Changelog per tag di versione (scelta: una entry per push).
