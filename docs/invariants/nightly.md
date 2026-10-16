# Giro notturno (riassunti, daily report, note di rilascio, Docs)

## Le regole che reggono il giro notturno (16 ott 2026)

Design: `docs/plans/2026-10-15-nightly-pipeline-design.md` §3, §5.2, §7.
Piano: `docs/plans/2026-10-15-nightly-pipeline-b-nightly.md` (D1–D32).
Codice: `apps/worker/src/nightly/`. Voce di deploy: «Giro notturno» in
`docs/operations/deploy-log.md`.

Il giro sostituisce l'aggiornamento dei Docs a ogni push, che consumava
l'abbonamento (tetti a 100000, diff bloccato su un commit vecchio, limite
dell'account non riconosciuto). Le regole qui sotto sono quelle che, tolte
«per semplificare», rifanno uno di quei difetti o ne aprono uno nuovo.

- **Il webhook push NON accoda lavoro Docs.** Il ramo push di
  `apps/server/src/routes/webhooks.ts` accoda solo il recount dei report e la
  build del grafo; i commit il giro li legge dal mirror. Rimettere un
  accodamento sul push riporta il lavoro Docs fuori dalla coda, dalla quota e
  dalla ripresa (e `doc_auto_update_jobs` non ha più consumatori: la tabella
  resta solo finché una migrazione a parte non la toglie).
- **Un commit si riassume UNA volta.** `commit_summaries` ha PK
  `(repository_id, sha)` e la scrittura è `ON CONFLICT DO NOTHING`: daily
  report, nota di rilascio e pagine leggono i riassunti salvati, non rileggono
  i diff. Chi aggiunge un consumatore legge la tabella; chi «rinfresca» un
  riassunto rompe l'idea che il costo di un commit si paghi una volta.
- **La regola del rumore è una lista DICHIARATA** (`nightly/noise.ts`):
  lockfile, cartelle di processo (`plans/`, `docs/`, `manual/`, `guides/`,
  `.github/`), segmenti `vendor/`/`node_modules/`/`dist/`, suffissi `.min.js`,
  `.min.css`, `.map`, `.snap`. È una funzione PURA del percorso — niente
  lettura del contenuto, niente euristica sull'intestazione «generated» — e
  `build/` resta fuori apposta (spesso è sorgente). Allargarla è una modifica
  esplicita con un test in `noise.test.ts`. Un commit di solo rumore riceve un
  riassunto deterministico, senza modello.
- **Il segnalibro dei Docs NON dipende dalla nota di rilascio.** Avanza
  (`advanceBookmarkIfDone`, `nightly/page-update.ts`) quando non resta nessun
  `page_update`/`page_create` `pending` del repository, e nella STESSA
  transazione scrive `commit_summaries.documented_at` sui commit documentati.
  L'avviso «il codice è cambiato dopo questa pagina» si deriva da
  `documented_at IS NULL`, non da un confronto di date: separare le due
  scritture, o dare a una delle due la data del JS, fa mentire l'avviso. La
  scrittura è guardata sulla generazione corrente: il segnalibro non va
  all'indietro dopo una rigenerazione completa.
- **La nota di rilascio ha il SUO punto di partenza**: il `toSha`
  dell'ultimo elemento `release` del repository (qualunque stato), altrimenti
  il segnalibro. Una nota scritta non si riscrive quando il segnalibro aspetta,
  e una nota fallita si riprova sul suo stesso intervallo.
- **Una pagina in escalation TIENE l'avviso.** Dopo 3 notti di fallimento un
  `page_update` va `escalated` (card in inbox) e il segnalibro avanza; i
  commit che la pagina non ha assorbito restano legati a lei in
  `doc_page_pending_commits`, scritta **all'escalation** (`failItem`,
  `nightly/queue.ts`, stessa transazione) — non all'avanzamento del
  segnalibro, o un avanzamento successivo resusciterebbe righe già risolte. Si
  cancellano **solo** le righe dei commit che un aggiornamento RIUSCITO della
  pagina ha visto (`sha = ANY(payload.commits)`, nella transazione che chiude
  l'elemento): un'escalation arrivata dopo la pianificazione resta. Spariscono
  anche con la pagina (CASCADE) o con una generazione completa che la
  sostituisce.
- **Nessun tetto al numero di pagine; il freno è la quota.** Né un cap di
  pagine aggiornate né di pagine create (i vecchi `DOCS_AUTOUPDATE_MAX_*` sono
  tolti): il freno è la soglia di sfondo degli account (piano A), e un piano
  insolitamente grande (`NIGHTLY_ALERT_RUNS`) gira comunque e manda una card
  ai maintainer. Un tetto taglierebbe la documentazione di un rilascio grosso
  in silenzio; l'allarme lo rende visibile senza tagliare.
- **Mirror e worktree solo DENTRO il serializer per-progetto.** Fetch del
  mirror, elenchi dei commit e apertura/chiusura dei worktree stanno in
  `serializer.run(projectId, …)`; i diff si leggono con `skipFetch: true`; i
  run `claude` stanno FUORI (worktree detached, nessun ref `stubwise/*` da
  potare). Un fetch fuori dal serializer può potare il branch non ancora
  pushato di un fix dello stesso progetto. Lo script `nightly:once` è un
  processo a parte, col suo serializer: per questo si lancia solo quando sul
  progetto non gira altro.
- **La lettura di una pagina è un'allowlist CHIUSA per file**, in una cwd
  VUOTA a parte (non il worktree: il CLI concede senza regole le letture sotto
  la cwd), `permissionMode: "default"` (non plan: lì la restrizione non
  regge). La regola per file su CLI 2.1.287 la misura il golden `nightly`
  (`apps/worker/scripts/golden/README.md`): va rilanciato quando si aggiorna
  il CLI. ⛔ **Cancello del rollout: NESSUN progetto riceve «Docs aggiornati
  ogni notte» acceso finché `golden:nightly` (la sonda dell'allowlist per
  file) non è VERDE sul CLI pinnato 2.1.287** — al merge del piano B non era
  mai stato lanciato. Vale anche dopo ogni aggiornamento del CLI: golden
  rosso o non lanciato con la versione nuova = interruttori spenti.
- **Rieseguire il piano non rifà ciò che è fatto** (spec §3.5). Le candidate
  si calcolano da TUTTI i commit dal segnalibro, e se il segnalibro resta
  fermo (basta una pagina pendente) mentre la head si muove, la chiave
  `<pagina>@<toSha>` cambia. `planPages` (`nightly/plan.ts`,
  `loadCoveredCommits`) toglie quindi a ogni candidata i commit già assorbiti
  da un suo `page_update` `done`/`escalated` (o dal `page_create` che l'ha
  creata) della generazione corrente con lo STESSO `fromSha`; se non ne resta
  nessuno, niente elemento. Lo stesso per le aree nuove (`commits` nel
  payload del `page_create`). Una pagina in escalation torna in coda solo con
  un commit che il suo elemento non aveva (e porta con sé i pendenti D31);
  senza, l'avviso lo tengono le righe D31. Chi toglie il filtro rifà Sonnet su
  ogni pagina già fatta a ogni notte in cui il segnalibro aspetta.
- **Il daily report aspetta i riassunti del giro, non li rifà.** Alle 02:00
  il giro pianifica i riassunti di ogni repository (gli elementi `summary`) e
  SOLO DOPO accoda i report, tutti insieme, prima che la fase 1 li consumi:
  così un report `queued` ha già i suoi `summary` e non c'è la finestra in
  cui il poller non li vede e li rifà. Il poller
  (`reports/daily-report-poller.ts`, `nightlySummarizing`) lascia `queued` —
  senza git né run — il report di un progetto con un `summary` `pending` che
  il giro ha in mano (lease viva) o reclamerà a breve (mai reclamato, non
  fallito stanotte, toccato da meno di `NIGHTLY_SUMMARY_DEFER_MS`, 3 ore), e
  lo riprende quando i riassunti sono scritti. Il limite di tempo tiene
  l'attesa finita: se il giro non arriva, il poller riassume da sé come
  prima. `summarizeCommit` guarda solo se la riga c'è PRIMA del run: senza
  l'attesa i due riassumevano gli stessi sha in parallelo.
- **La quota ferma il giro, la configurazione salta il progetto.** Un motivo
  di quota condivisa (`isQuotaWait`, e il `legacy_limited` dell'auth del
  container) ferma TUTTO il giro: gli abbonamenti sono condivisi. Un progetto
  «solo questo» col suo account indisponibile, o senza account utilizzabile,
  salta da solo per la notte. In entrambi i casi l'elemento torna `pending`
  senza contare un fallimento: la quota non è un errore della fase.
- **Tutto lo stato del giro sta nella coda** (`nightly_items`, unique
  `(repository_id, phase, key)`), tranne i worktree aperti e il flag «un giro
  alla volta». Un riavvio del worker riprende dall'elemento registrato; un
  elemento reclamato da un processo morto resta bloccato al più per la lease
  (`NIGHTLY_ITEM_LEASE_MS`, 60 minuti). «La notte è partita» lo dice la coda,
  non la memoria del processo.
