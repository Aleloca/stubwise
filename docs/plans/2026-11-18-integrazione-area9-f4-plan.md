# Integrazione area 9, F4 — Stato dell'istanza: piano

> Design: `docs/plans/2026-11-16-integrazione-area9-design.md`, «F4 — Stato
> dell'istanza» (D-7 = a). Specifica dell'app: il prototipo,
> `apps/desktop/src/renderer/data/instance/status.ts` (la vista
> `InstanceStatusView`), `queue.ts` (pausa e ripresa), `retry.ts` (il
> rilancio), `blocks.ts` (i blocchi `queue_paused` e `monthly_budget`) e i tipi
> del registro `queue.paused`, `queue.resumed`, `job.retried`
> (`instance/changeTypes.ts`). Invarianti: CLAUDE.md, «Stubwise non fa deploy:
> il merge è il confine» (la pausa e il rilancio agiscono SOLO sulla coda di
> Stubwise), `docs/invariants/pr-corrections.md` («Il rilancio generico non
> tocca una correzione ferma»), `docs/invariants/automations.md`
> (invariante 5), `docs/invariants/change-log.md`, `permissions.md`.
> Branch: `feat/area9-f4` da `feat/integrazione-area9` (con F1, F2 e F3).

## Prima del codice

- Le **[DECIDE] J-1…J-6** in fondo. Il piano è scritto con le (a).
- **Il confine, per costruzione.** La pausa e il rilancio non toccano un
  ambiente, un server, un processo: niente riavvii, niente comandi ai
  server, niente stop di un lavoro partito. Un test di sorgente lo fissa
  (Task 8): i moduli di F4 non importano niente di `server-ops`, del
  bridge degli agenti né di `server_commands`.
- **Fatti del codice che il design non dice**:
  - le code NON hanno un claim comune: ogni coda reclama a modo suo, e la
    pausa va nella WHERE di ciascuna (Task 2):
    - `ai_jobs` (`apps/worker/src/queue.ts`, `claimNextJob`: fix, correzioni
      post-PR, e il resto dei job delle task);
    - `pr_review_jobs` (`review/poller.ts`, claim per `DELETE … RETURNING`
      dei pending scaduti);
    - `backlog_jobs` intake/estimate (`backlog/poller.ts`,
      `claimNextBacklogJob`; NON i turni di refinement, che sono una
      sessione interattiva);
    - `doc_generation_jobs` e i nodi (`docs/queue.ts`, `docs/nodes.ts`);
    - `nightly_items` (`nightly/queue.ts`, `claimNext`);
    - `graph_jobs` (`graph/queue.ts`);
    - `drive_content_jobs` (`drive/content-job.ts`, il riassunto con Claude);
    - le esecuzioni delle automazioni, al passo di Claude
      (`automations/executor.ts` / `claude-step.ts`);
    - le analisi dei server (`server-ops/analysis.ts`,
      `runNextServerAnalysis`) e il giudizio della posta
      (`google/reply-judgment.ts`): vedi J-3;
  - il passo di Claude di un'automazione fermo per il budget **riprova già
    da solo** ogni 15′ (`AI_RETRY_MS`, `executor.ts:507`, `aiWaiting:
    monthly_budget`): l'invariante 5 è quasi vera oggi, manca solo la
    ripartenza SUBITO quando il budget torna (J-5);
  - le letture delle automazioni conoscono già `aiWaiting` `queue_paused`
    (`packages/shared/src/automations/types.ts`, il tipo; nessuno lo
    scrive): F4 lo scrive;
  - non c'è nessun heartbeat dei worker: nasce qui (Task 3);
  - il rilancio di una task è `startRun` (`apps/server/src/services/jobs.ts`),
    lo stesso di `run_ticket` e del bottone della task: il rilancio dello
    Stato dell'istanza lo chiama, mai una copia (Task 6);
  - `instance.status.view` non esiste: è un permesso d'istanza nuovo, nel
    preset Admin (il full admin l'ha implicito);
  - i tipi `queue.paused`, `queue.resumed`, `job.retried` non sono nel
    catalogo del registro (`packages/shared/src/change-log.ts`): entrano qui.
- **Primo numero libero**: 0191.

## Regole di lavoro (le solite)

- TDD con le mutazioni (`mut.py`), che girano e danno l'esito sbagliato; un
  verde sospetto si guarda (perché è verde?).
- I file di test toccati si lanciano INTERI, uno alla volta; ribuild delle
  dipendenze dopo un cambio di branch o fra pacchetti.
- Commit su percorsi espliciti, lint + test + commit + push in una catena.
- Campi dei client solo additivi, coi default; parse senza i facoltativi.
- Container dei test tolti per id; un rosso con CONNECTION_CLOSED/409 si
  rilancia da solo prima di crederci.
- Ogni scrittura nuova lascia la sua voce nel registro, nella sua transazione.

## Task

### Task 1 — La migrazione 0191 e il catalogo

- `projects.queue_paused_at timestamptz` e `queue_paused_by_user_id`
  (FK `SET NULL`): nulli = la coda va.
- `worker_heartbeats`: `worker_id text` PK (l'id del processo, scelto
  all'avvio), `started_at`, `seen_at`, `concurrency int`, `running jsonb`
  (J-2: gli id dei lavori che ha in mano, per tipo).
- Il permesso `instance.status.view` nel catalogo dei permessi e nel preset
  Admin (seed in `runMigrations` se il preset ha bisogno della riga, come i
  permessi d'istanza di prima: la regola degli enum non c'entra, sono testo).
- I tipi del registro: `queue.paused` e `queue.resumed` (di progetto,
  `project.settings.manage`; `queue.resumed` con prima e dopo
  `paused:<ISO>` → `running`, come `encodeQueue` del prototipo),
  `job.retried` (di progetto, oggetto la task).
- *Test*: la migrazione (colonne, FK, nulli); il catalogo (permesso nel
  preset, i tre tipi con il loro ambito).

### Task 2 — La pausa nella WHERE di ogni coda

- Una funzione SQL di frammento, in UN posto (`packages/db` o
  `notifications`): `projectQueueRunnable(projectIdExpr)` →
  `NOT EXISTS (select 1 from projects p where p.id = … and p.queue_paused_at is not null)`.
  Ogni claim della lista sopra la aggiunge alla sua WHERE, risalendo al
  progetto per la sua strada (ticket → progetto, repository → progetto…).
- Il passo di Claude di un'automazione, su un progetto in pausa: non parte,
  l'esecuzione resta `running` con `aiWaiting: { reason: "queue_paused",
  byId, since }` e `dueAt` fra 15′ (come il budget), e riparte alla
  ripresa (Task 5). Un'automazione generale senza progetto non si ferma.
- **Non si fermano** (D-7, maintainer 30 ott): la chat (`chat`, `claude_chat`),
  «Chiedi a Claude», le sessioni interattive (refinement, sessioni degli
  agenti già aperte), e tutto ciò che non lancia lavoro di Claude (il poller
  delle consegne, il push, Slack, il monitoraggio, la posta).
- **Il lavoro già partito finisce**: la pausa non tocca un `running`.
- Nessun lavoro si cancella; alla ripresa l'ordine è quello delle code
  (`created_at`).
- *Test*, per OGNI coda della lista: un lavoro di un progetto in pausa non
  viene reclamato, quello di un altro progetto sì, e dopo la ripresa sì;
  un `running` non cambia stato. Una mutazione per coda (togliere il
  frammento dalla sua WHERE) deve essere rossa.

### Task 3 — L'heartbeat dei worker

- Il worker scrive `worker_heartbeats` all'avvio e a ogni giro del suo loop
  principale (al più ogni 15″): `seen_at`, la concorrenza, i lavori in mano
  (J-2). Best-effort: un errore di scrittura non ferma il worker.
- Un worker è «attivo» se `seen_at` è negli ultimi 2′; le righe più vecchie
  di 1 giorno si potano.
- *Test*: la scrittura, la potatura, un errore che non lancia.

### Task 4 — La vista: `GET /api/instance/status`

- `inst:instance.status.view`. La forma è `InstanceStatusView` del
  prototipo, calcolata dal server (chi legge non deduce):
  - `queues`: per progetto VISIBILE (`visibleProjectIds`, nella WHERE): la
    pausa (`byId`, `byName`, `at`), i conteggi `running`/`waiting`/`failed`,
    `pause` (`allowed`/`forbidden`: `project.settings.manage` lì),
    `budgetAfterResume` (i lavori in attesa che il budget del mese
    terrebbe fermi);
  - `otherProjects`: solo i conteggi dei progetti che chi guarda non vede;
  - `jobs`: i lavori in coda e in corso e i falliti degli ultimi 7 giorni,
    coi campi del prototipo (`kind`, `state`, `waiting`, `since`,
    `workerId`, `retry`, `retryNeeds`, `retryBlock`, `retryStopsAtPlan`,
    `summary`, `superseded`, `href`). `retry` e compagni li calcola la
    STESSA funzione del Task 6 (mai una copia);
  - `workers`: dall'heartbeat (J-2), un lavoro di un progetto invisibile è
    `hidden` senza id;
  - `quota`: le snapshot che ci sono, con la banda di F3 (`quotaBand`);
  - `errors`: i falliti legati a una task, il più recente prima, al più 5;
  - `nightly`: lo stato del giro notturno dei progetti visibili (dalla coda
    `nightly_items`);
  - `refreshedAt`.
- I tipi in `@stubwise/shared` (letti dal client), i campi nuovi coi default.
- *Test*: la forma; i progetti invisibili solo contati; `retry` con e senza
  i permessi; una correzione ferma `waiting` senza blocco e senza Retry; un
  `superseded`; i 7 giorni; `budgetAfterResume`.

### Task 5 — Pausa e ripresa

- `POST /api/projects/:projectId/queue/pause` e `/resume`
  (`proj:project.settings.manage`, J-1). Un progetto invisibile è 404.
- Pausa: `409 already_paused` se lo è; scrive le due colonne e
  `queue.paused`, in una transazione.
- Ripresa: `409 not_paused` se non lo è; azzera le colonne e scrive
  `queue.resumed`; le esecuzioni delle automazioni ferme per la pausa di quel
  progetto ripartono SUBITO (`dueAt = now()`), nell'ordine.
- *Test*: i due 409, il 404, i permessi (negativo, stato invariato), la
  voce, la ripresa che sveglia le automazioni ferme per la pausa e NON
  quelle ferme per il budget.

### Task 6 — Il rilancio: `POST /api/instance/jobs/:id/retry`

- `proj:project.settings.manage` + `proj:runs.start` nel progetto del lavoro
  (D-7, decisione del maintainer del 30 ott).
- Solo un job di una task (`ai_jobs` di un ticket, non una correzione)
  `failed` negli ultimi 7 giorni; superato da un lavoro più recente sulla
  task: `409 conflict` se è vivo, `422 not_retryable` se è finito. Mai su una
  correzione ferma (`pr-corrections.md`).
- Riparte a nome di chi preme con `startRun` (gate del piano compreso: chi
  non ha `plans.approve` si ferma al piano, `retryStopsAtPlan`), poi
  `job.retried` nella voce. Il budget del mese raggiunto: `422
  monthly_budget` (`retryBlock`); la pausa NON spegne Retry: il lavoro
  aspetta in coda.
- *Test*: i permessi (due negativi), una correzione rifiutata, il
  superato, il gate del piano, il budget, la voce; e che è `startRun` (spia
  o test di sorgente: nessuna seconda logica di rilancio).

### Task 7 — Il budget che torna (invariante 5, J-5)

- Oggi il passo fermo per il budget riprova da solo ogni 15′. In più: quando
  il budget torna disponibile per un gesto (il `PUT /api/settings/instance`
  che alza o toglie il tetto), le esecuzioni ferme per `monthly_budget`
  ripartono SUBITO (`dueAt = now()`), nella stessa transazione. Il mese nuovo
  le trova al giro dei 15′.
- Il `budget_held` dei job delle task resta com'è (l'invariante 5 lo dice).
- *Test*: tetto alzato → l'esecuzione ferma riparte al giro successivo;
  tetto abbassato o uguale → no; un job `budget_held` non cambia.

### Task 8 — Il confine, il client, il deploy-log, la review

- **Test di sorgente**: i moduli di F4 (rotte e servizi dello Stato
  dell'istanza, pausa, rilancio) non importano niente di `server-ops`,
  `server_commands`, del bridge degli agenti, di `docker`/`ssh`; nessuna
  rotta di F4 riavvia, ferma o annulla un lavoro.
- **Client**: `instance.status()`, `projects.pauseQueue/resumeQueue`,
  `instance.retryJob`; parse senza i facoltativi.
- **Deploy-log**: ordine **server** (0191) → **worker** (le WHERE della
  pausa e l'heartbeat: un worker vecchio IGNORA la pausa, quindi fino al suo
  deploy una pausa non ferma niente — da non usare nel mezzo) → **caddy**;
  il permesso nuovo nel preset Admin; il rollback (un worker vecchio ignora
  la pausa; le colonne restano; i progetti in pausa al rollback ripartono
  di fatto, e tornano in pausa al ritorno).
- CLAUDE.md: l'aggiunta del design all'invariante «Stubwise non fa deploy»
  c'è già (46); `docs/invariants/server-operations.md` la rimanda. La voce
  `docs/invariants/automations.md` (invariante 5) la applica 46.
- `pnpm build` + `check:dist`; review con un revisore fresco. Review Focus:
  - una coda che reclama lavoro di un progetto in pausa (una WHERE
    dimenticata, una strada al progetto sbagliata);
  - qualcosa che si ferma e non dovrebbe (chat, «Chiedi a Claude», sessioni);
  - un'azione su un server, un ambiente, un processo;
  - un rilancio che non passa da `startRun` o tocca una correzione ferma;
  - un lavoro di un progetto invisibile nella vista.

## [DECIDE]

- **J-1 — Chi mette in pausa.**
  - **(a) consigliata**: chi ha `project.settings.manage` nel progetto (il
    design): una pausa è una decisione sul progetto, e chi lo gestisce la
    deve poter prendere.
  - (b) solo `settings.manage` d'istanza, come il prototipo.
- **J-2 — I worker nella vista.**
  - **(a) consigliata**: l'heartbeat porta i lavori in mano (`running`
    jsonb, per tipo e id), così la vista dice quale worker fa cosa come il
    prototipo.
  - (b) l'heartbeat dice solo processo, concorrenza e `seen_at`; i lavori
    in corso si contano dalle tabelle, senza attribuirli a un worker (la
    pagina mostra «N worker, M lavori in corso»).
- **J-3 — Le code oltre la lista del design.**
  - **(a) consigliata**: la pausa ferma anche le analisi dei server legate
    a un progetto e il riassunto dei file del Drive (lavoro di Claude
    pagato dal progetto); NON la classificazione e il giudizio della posta,
    che girano prima di sapere il progetto (la regola non si applicherebbe
    in modo coerente). Lo dichiara la pagina.
  - (b) solo la lista del design (con il giudizio della posta dove ha già
    un progetto).
- **J-4 — Gli errori.**
  - **(a) consigliata**: i job falliti legati a una task, 7 giorni, al più
    5 (il prototipo); gli altri fallimenti (Docs, grafo, review) restano
    nelle loro pagine.
  - (b) tutte le code, con il tipo.
- **J-5 — Il budget che torna.**
  - **(a) consigliata**: subito quando il tetto si alza (Task 7), al giro
    dei 15′ per il mese nuovo.
  - (b) solo il giro dei 15′ di oggi (l'invariante 5 è già vera, si
    documenta e basta).
- **J-6 — Un progetto in pausa nelle altre pagine.**
  - **(a) consigliata**: il server lo dice dove un lavoro aspetta
    (`aiWaiting: queue_paused` sulle task e sulle automazioni, che il tipo
    conosce già), così «Avvia» su una task di un progetto in pausa accetta
    e dice «in coda, la coda è in pausa».
  - (b) solo nello Stato dell'istanza.

## Cosa F4 non fa

- Riavvii, deploy, azioni sui server: nessuno, per costruzione.
- Annullare o fermare un lavoro partito.
- Le impostazioni del progetto (F5), l'archivio (F6, che estende la WHERE
  della pausa agli archiviati).

## Stima

Otto task. Il 2 è il più largo (una WHERE per coda, ciascuna col suo test e
la sua mutazione); il 4 il più lungo (la vista del prototipo, calcolata).
