# Integrazione area 9, F6 — archivio ed eliminazione: piano

> Design: `docs/plans/2026-11-16-integrazione-area9-design.md`, «F6 —
> archivio ed eliminazione (D-8)» e la voce nuova di
> `docs/invariants/permissions.md` (D-8). Specifica dell'app: il prototipo,
> `apps/desktop/src/renderer/data/projectSettings/archive.ts` (archivia,
> riapri, anteprime, elimina), `projectSettings/purge.ts` (cosa toglie
> l'eliminazione e cosa resta), `data/instance/repositories.ts` (i
> repository senza progetto: elenco, collega, elimina),
> `data/changelog/reads.ts` (come si leggono le voci di un archiviato e di un
> eliminato), le pagine `pages/projects/ArchivedProjects.tsx` e
> `ArchivedProjectPage.tsx`. Invarianti: `permissions.md` (404 come uno che
> non c'è, filtri nella WHERE), `second-factor.md` (la riconferma),
> `change-log.md`, CLAUDE.md («Stubwise non fa deploy»).
> Branch: `feat/area9-f6` da `feat/integrazione-area9` **dopo il merge di F5**
> (servono `repository.deleted` nel catalogo, la 0192 e i pattern di F5).

## Prima del codice

- Le **[DECIDE] L-1…L-7** in fondo. Il piano è scritto con le (a).
- **Fatti del codice che il design non dice**:
  - **i repository muoiono col progetto**: `repositories.project_id` è `NOT
    NULL` con `ON DELETE CASCADE` (`packages/db/src/schema.ts`). Staccarli
    vuole una migrazione (nullable, `ON DELETE SET NULL`), e da lì
    `projectId` del repository è `string | null` nel codice: il compilatore
    elenca ogni punto che lo dava per certo;
  - **23 tabelle dipendono dal repository**, quasi tutte in cascata:
    `milestones`, `ticket_repositories`, `project_env_files`, i Docs
    (`doc_generations`, `doc_generation_jobs`, `doc_auto_update_jobs`,
    `doc_pages`, `doc_page_codes`, `doc_chunks`, `doc_nodes`,
    `doc_chat_sessions`), le PR (`pr_review_jobs`, `pr_reviews`,
    `pr_corrections`, `pr_release_notes`), `releases`,
    `environment_servers`, `activity_commits`, `commit_summaries`,
    `repo_graphs`, `graph_jobs`, `nightly_items`, `search_history` (set
    null). Con il repository staccato, ciò che non ha anche il `project_id`
    in cascata RESTA, se non lo si toglie a mano (L-2);
  - **`DELETE /api/projects/:projectId` oggi** è `project.settings.manage`,
    senza riconferma né archivio, e cancella tutto in cascata (con le chiavi
    dello storage tolte dopo il commit, `routes/projects.ts`);
  - **non esiste `DELETE` di un repository** sul server, né un elenco dei
    repository senza progetto (F3 l'aveva rimandato a F6);
  - **`change_log.project_id` è `ON DELETE SET NULL`**: eliminato il
    progetto, le sue voci di progetto resterebbero con `project_id` null,
    e un lettore d'istanza le vedrebbe come voci senza progetto (L-3);
  - **la visibilità ha due forme**: `projectPermissionsFor` /
    `projectPermissionsOfUser` / `projectPermissionsByProject` per UN progetto
    (`null` = 404), e `visibleProjectIds` / `projectIdsWithPermission` /
    `projectPermissionsMap` per gli elenchi, dove un full admin riceve
    `"all"` e il chiamante non filtra. I chiamanti sono ~80 per forma, e
    i controlli `=== "all"` / `!== "all"` sono 98 (server, worker,
    `packages/notifications`): «l'archiviato sparisce ovunque» non si
    ottiene con un `if` in `visibleProjectIds` (L-1);
  - **la pausa di F4 sta in UN frammento**, `projectQueueRunnable` /
    `repositoryQueueRunnable` (`packages/db/src/queue-pause.ts`), già nella
    WHERE di ogni claim: l'archivio lo estende lì. Un lavoro senza progetto
    (un repository staccato) non si ferma;
  - **«collega» nel prototipo** lo fa chi ha `repos.manage` nel progetto di
    DESTINAZIONE (col rifiuto `name_taken`); il design dice il full admin
    (L-4);
  - **`busy` nel prototipo** sono le sessioni di Claude non finite (anche
    in attesa per la coda) e i rilasci in corso; il design dice job in volo,
    sessioni attive e generazioni Docs (L-5).
- **Primo numero libero**: 0193 (dopo la 0192 di F5).

## Regole di lavoro (le solite)

- TDD con le mutazioni (`mut.py`), che girano e danno l'esito sbagliato; un
  verde sospetto si guarda.
- I file di test toccati si lanciano INTERI, uno alla volta (anche quelli dei
  moduli che chiamano ciò che si cambia); ribuild delle dipendenze dopo un
  cambio di branch o fra pacchetti.
- Commit su percorsi espliciti, lint + test + commit + push in una catena.
- Campi dei client solo additivi, coi default; un corpo che cresce è una patch.
- Container dei test tolti per id; un rosso con CONNECTION_CLOSED/409 si
  rilancia da solo prima di crederci.
- Ogni scrittura lascia la sua voce nel registro, nella SUA transazione.

## Task

### Task 1 — La migrazione e il catalogo

- **0193**:
  - `projects.archived_at` e `archived_by_user_id` (FK utenti, set null);
  - `repositories.project_id` nullable, FK `ON DELETE SET NULL`;
  - `change_log.project_id` senza FK (si tiene l'id del progetto eliminato,
    L-3), con l'indice che c'è;
  - un indice parziale su `projects(id) WHERE archived_at IS NOT NULL`, per
    i filtri;
  - **la memoria del progetto eliminato** (decisione del Task 1, approvata
    da 46 il 19 nov 2026): `deleted_projects` (`id` = quello del progetto,
    `code`, `name`, `deleted_at`) e `deleted_project_members` (`project_id`,
    `user_id`, FK utenti in cascata). Nient'altro del progetto sopravvive.
    Servono a dire «chi conosceva il progetto»: l'etichetta di
    `project.deleted`, `formerProject` e il `fullName` intero di un
    repository staccato vanno solo agli ex membri e ai full admin;
  - `repositories.detached_at` e `detached_from_project_id` (FK
    `deleted_projects`, set null): quando e da dove è stato staccato. Si
    azzerano insieme al collegamento (Task 6).
- Il catalogo (`packages/shared/src/change-log.ts`):
  - `project.archived` e `project.reopened`, di progetto, gruppo
    `settings`, `project.settings.manage`;
  - `project.deleted`, d'istanza, `instance.full_admin`, gruppo `projects`,
    `params.detachedRepositories`, etichetta vuota (si risolve a lettura);
  - `repository.linked`, di progetto, gruppo `repositories`, `repos.manage`;
  - `repository.deleted` (dichiarato in F5) riceve lo scrittore.
- Lo schema Drizzle e i tipi: `repositories.projectId` `string | null`; il
  typecheck di server e worker elenca i punti da sistemare. Ognuno si
  sistema con la regola «un repository senza progetto lo vede solo
  l'Amministrazione» (le rotte `repositoryAccess` danno 404). Fatto così:
  dove la query unisce già `projects`, il progetto si legge da
  `projects.id` (l'inner join esclude lo staccato anche per il full admin,
  che riceve `"all"`); le liste e la ricerca dei repository uniscono
  `projects` apposta; un webhook di uno staccato risponde 401 come una firma
  sbagliata; i lavori del worker (Docs, grafo, review PR) lo trattano come
  un repository che non c'è. `isAttachedRepository` (`@stubwise/db`)
  restringe il tipo dove serve.
- *Test*: la migrazione (consecutive, `when` crescenti, applicate in
  ordine, le colonne e le FK nuove); la parità del catalogo col prototipo
  (F6 non più esclusa).

### Task 2 — L'archiviato sparisce ovunque, in UN posto (L-1)

- **Per un progetto**: `projectPermissionsByProject` (che sta sotto
  `projectPermissionsFor` e `projectPermissionsOfUser`) dà `null` per un
  archiviato. Da lì ogni rotta di progetto risponde 404, e ogni
  destinatario del worker (notifiche, Slack, automazioni) lo perde, senza
  toccare i chiamanti.
- **Per gli elenchi**: `visibleProjectIds` e `projectIdsWithPermission` non
  danno più `"all"` a un full admin ma `{ all: true, archived: string[] }`
  (`ProjectScope`). Il tipo nuovo fa fallire il typecheck in ognuno dei 98
  punti, che si sistemano uno per uno: `inProjects` lo traduce in `NOT IN`
  gli archiviati, e chi controllava `"all"` per non filtrare filtra gli
  archiviati. `projectPermissionsMap` (cioè `/api/auth/me`) li esclude.
- **Le eccezioni sono dichiarate**:
  - `config.archived: "read"` su una rotta di progetto la lascia passare su
    un archiviato, in sola lettura, a chi ne era membro e ai full admin;
  - `config.archived: "write"` solo su riapri ed elimina.
  - Il registro delle rotte ha un test «le rotte che passano su un
    archiviato sono ESATTAMENTE queste».
- **Scrivere su un archiviato**: chi lo vedrebbe (membro di allora o full
  admin) riceve `409 archived` su ogni rotta di progetto senza
  `config.archived`; gli altri ricevono 404. La regola sta in
  `evaluateProjectAccess`, quindi vale anche per le azioni di Claude.
- **Il worker** (`queue-pause.ts`): `projectQueueRunnable` esclude anche
  `archived_at IS NOT NULL`. Il lavoro già partito finisce, e niente si
  cancella (riaprendo riparte).
- *Test*:
  - l'archiviato non compare in elenchi, ricerca, ⌘K, Home, «Chi può
    farlo?», Stato dell'istanza, `/api/auth/me`, automazioni (elenco), né
    nei destinatari di una notifica nuova; un test per superficie, con un
    full admin E con un membro, sugli stessi dati;
  - il claim di ogni coda non prende il lavoro di un archiviato (gli stessi
    test della pausa di F4, col progetto archiviato);
  - NEGATIVI: una scrittura su un archiviato è 409 per il membro di allora e
    404 per un estraneo, e niente cambia; una lettura non dichiarata è 404.

### Task 3 — Archivia e riapri

- `GET /api/projects/:projectId/archive-preview`
  (`project.settings.manage`): `openAutomationRuns` (quante esecuzioni si
  annulleranno) e `busy`, le ragioni.
- `POST /api/projects/:projectId/archive` (`project.settings.manage`, senza
  riconferma come nel prototipo):
  - `409 busy` con le ragioni (L-5): job dell'agente in esecuzione, sessioni
    di Claude non finite, generazioni Docs `running`/`paused`, rilasci con
    le run non concluse (`runs_settled_at` null). Una ragione su un oggetto
    che chi archivia non vede ha codice e titolo `null`, come nel
    prototipo;
  - `409 already_archived`;
  - nella transazione, con il progetto FOR UPDATE: si ricontrolla `busy`;
    le esecuzioni aperte delle automazioni del progetto (`running`,
    `waiting_*`, `suspended`) passano a `cancelled` con la ragione
    «Project archived»; si scrivono `archived_at` e `archived_by_user_id`;
    voce `project.archived`.
- `POST /api/projects/:projectId/reopen` (`config.archived: "write"`,
  `project.settings.manage`): `409 not_archived` se non lo è. Azzera le
  due colonne, voce `project.reopened`. Interruttori, appartenenze,
  notifiche e fissati non sono mai stati toccati: tornano come erano.
- Le **automazioni generali** che agiscono su un archiviato: il passo
  fallisce in «Needs attention» con la ragione del progetto non
  disponibile ([PX 5]), come su un progetto in pausa.
- *Test*: `busy` per ogni ragione (e la ragione cieca per chi non vede la
  sessione); le esecuzioni annullate con la loro ragione; riaprire riporta
  tutto; due archiviazioni insieme (una sola voce); la voce nella
  transazione (trigger che fa fallire l'insert → niente archiviato).

### Task 4 — Le letture di un archiviato

- `GET /api/projects/archived` (letterale, registrato PRIMA di
  `/:projectId`): le righe del prototipo (`ArchivedProjectRow`: codice,
  nome, cliente, quando e da chi, `canReopen`, `canDelete`), per i membri di
  allora e i full admin, dal più recente. Le calcola il server.
- `GET /api/projects/:projectId/archived-view` (`config.archived: "read"`):
  l'`ArchivedProjectView` del prototipo (descrizione, membri col ruolo, i
  conteggi, i nomi dei repository, gli interruttori com'erano, la cadenza
  del pulse). I conteggi sono COUNT nella WHERE, non letture intere.
- Il registro: le voci di un archiviato si leggono dalla sua pagina (filtro
  `projectId`) per chi lo vede da archiviato (`reads.ts` del prototipo).
- *Test*: un estraneo riceve 404 e la lista vuota; il membro di allora vede,
  ma non scrive.

### Task 5 — Elimina (solo un archiviato, solo un full admin)

- `GET /api/projects/:projectId/deletion-preview`
  (`config.archived: "read"`, `instance.full_admin`): i conteggi, i server
  che resterebbero senza ambienti (R-L7) e i repository che restano
  staccati.
- `DELETE /api/projects/:projectId` cambia regola:
  - accesso `instance.full_admin` (non più `project.settings.manage`);
  - `config.archived: "write"`, riconferma (`config.reauth`);
  - corpo `{ confirmCode }`, che deve coincidere col codice esatto
    (`400 code_mismatch`);
  - `409 not_archived` su un progetto aperto.

  Un client vecchio che lo prova riceve 403 (chi non è full admin) o 400
  (senza corpo).
- Nella transazione:
  1. si leggono le chiavi dello storage (come oggi);
  2. si staccano i repository, coi figli scelti da L-2;
  3. si elimina il progetto (le cascate fanno il resto);
  4. voce `project.deleted` d'istanza con `detachedRepositories`.

  Le voci di progetto restano col loro `project_id` (L-3) e non le legge più
  nessuno (i lettori uniscono `projects`), tranne `project.deleted` e
  `repository.deleted`, che si risolvono a lettura (`reads.ts`).
- *Test*:
  - NEGATIVI: non archiviato, non full admin, senza riconferma, col codice
    sbagliato (minuscole comprese); in ogni caso niente cambia;
  - i repository restano, staccati, con quello che L-2 tiene, e il resto
    non c'è più;
  - le chiavi dello storage tolte;
  - la voce; le voci di progetto non più leggibili, nemmeno da un full admin
    con `changelog.view`.

### Task 6 — I repository senza progetto

- `GET /api/repositories/detached` (letterale, prima di `/:slug`): per chi
  ha `repos.manage` in almeno un progetto o è full admin (come il
  prototipo). Nome, URL, provider, account, da quale progetto (il nome di
  allora, se chi guarda lo conosceva), quando, `canDelete`.
- `POST /api/repositories/:id/link` `{ projectId }` (L-4: `repos.manage`
  nel progetto di destinazione): `409 name_taken` se il nome è già di un
  repository di quel progetto. Il webhook resta da configurare. Voce
  `repository.linked` nel progetto di destinazione.
- `DELETE /api/repositories/:id`: solo uno staccato (`409 not_detached`),
  solo un full admin, con la riconferma. Voce `repository.deleted`
  d'istanza. Il mirror e il grafo sul volume li pota il worker (L-2).
- I poller del worker non trovano un repository staccato (nessun
  progetto): un test per il giro notturno e per il grafo.
- *Test*: collegare (il permesso nel progetto di destinazione, NEGATIVO da
  un altro progetto, `name_taken`); eliminare (NEGATIVI: collegato, non
  full admin, senza riconferma).

### Task 7 — Il web vecchio, il client, il deploy-log, la review

- **Web vecchio** (L-6): via il bottone «Elimina» del progetto
  (`routes/projects/$projectId.tsx`) e `deleteProject` da `lib/api.ts`.
  Un archiviato sparisce dagli elenchi e il suo link dà la pagina «non
  trovato» che c'è già. Niente archivio nel web vecchio.
- **Client** (`@stubwise/api-client`, coi 94):
  - `projects.archivePreview`, `archive`, `reopen`, `archived`,
    `archivedView`, `deletionPreview`, `delete(projectId, confirmCode)`;
  - `repositories.detached`, `link`, `deleteDetached`.

  Gli schemi in `@stubwise/shared` sono nuovi, i campi coi default.
- **Deploy-log**:
  - ordine: server (0193), poi caddy;
  - eliminare un progetto cambia regola (solo full admin, solo archiviato);
  - l'archiviato sparisce ovunque e il worker non ne prende il lavoro;
  - i repository di un progetto eliminato restano staccati;
  - rollback: la 0193 non si annulla. Un server vecchio vede gli archiviati
    come aperti (riappaiono a tutti e il worker riprende) e vede i
    repository staccati con `project_id` null. Va controllato che il server
    vecchio non vada in 500 su una riga così: se ci va, il rollback vuole
    prima di ricollegarli o eliminarli. Lo verifica un test sul codice
    vecchio prima di scrivere la voce.
- `pnpm build` + `check:dist`; review con un revisore fresco. Review Focus:
  - un elenco, un conteggio o un destinatario che vede ancora un archiviato
    (soprattutto nei punti `"all"` del full admin);
  - una scrittura su un archiviato che passa;
  - un'eliminazione senza archivio, riconferma o codice giusto;
  - un dato del progetto eliminato che resta leggibile (Docs, PR, voci);
  - un repository staccato raggiungibile da una rotta di progetto;
  - una voce scritta fuori dalla transazione della sua scrittura.

## [DECIDE]

- **L-1 — Come l'archiviato sparisce dagli elenchi.**
  - **(a) consigliata**: il tipo di ritorno di `visibleProjectIds` e
    `projectIdsWithPermission` cambia (`"all"` diventa `{ all: true,
    archived }`), così il compilatore trova ognuno dei 98 punti e nessuno si
    dimentica. Più lavoro (Task 2 è il più largo), ma la regola resta in un
    posto.
  - (b) si lascia `"all"` e si aggiunge il filtro a mano dove serve, guidati
    da un grep: meno righe, ma un punto dimenticato fa vedere l'archiviato
    al full admin in silenzio.
- **L-2 — Cosa tiene un repository staccato.**
  - **(a) consigliata**: come il prototipo.
    - **Tiene** nome, URL, account git, comandi, rami protetti, il grafo
      (`repo_graphs`), i riassunti dei commit (`commit_summaries`) e
      l'attività (`activity_commits`), che sono fatti del repository e non
      del progetto.
    - **Perde** i file d'ambiente (vanno con gli ambienti), i Docs (tutte le
      tabelle `doc_*`), le PR (`pr_reviews`, `pr_corrections`,
      `pr_review_jobs`, `pr_release_notes`), i rilasci, i milestone, gli
      elementi del giro notturno e il webhook: `webhook_configured_at`
      null e il segreto vuoto. Il webhook rifiuta da sé un segreto vuoto
      (`webhooks.ts`), quindi le consegne della piattaforma vengono
      rifiutate finché non lo si ricollega e riconfigura. Sulla piattaforma
      non si tocca niente.
  - (b) tiene anche i Docs: si ricollega e ritrova le pagine, ma restano
    pagine generate per un progetto che non c'è più.
- **L-3 — Le voci di un progetto eliminato.**
  - **(a) consigliata**: `change_log.project_id` perde la FK e tiene l'id
    (D-4: il registro si tiene per sempre); i lettori le escludono perché il
    progetto non esiste più, e restano leggibili solo `project.deleted` e
    `repository.deleted`, come nel prototipo.
  - (b) `SET NULL` come oggi, e le voci di progetto si cancellano
    nell'eliminazione: contraddice D-4.
- **L-4 — Chi collega un repository staccato.**
  - **(a) consigliata**: come il prototipo, chi ha `repos.manage` nel
    progetto di destinazione. Collegare non dà accesso a niente che quel
    progetto non avesse.
  - (b) come il design, solo il full admin.
- **L-5 — Cosa rende un progetto `busy`.**
  - **(a) consigliata**: ciò che il worker sta ESEGUENDO: job dell'agente
    in esecuzione (non quelli fermi in attesa di una persona: `held`,
    `awaiting_plan_approval`, `awaiting_input` restano lì e ripartono
    riaprendo), sessioni di Claude non finite (anche in attesa per la coda,
    come il prototipo), generazioni Docs `running`/`paused`, rilasci con le
    run non concluse. È l'unione di design e prototipo.
  - (b) anche i job fermi in attesa di una persona: archiviare chiede prima
    di chiuderli.
- **L-6 — Il web vecchio.**
  - **(a) consigliata**: perde solo «Elimina» (D-8). Archivio, riapertura e
    l'Amministrazione dei repository staccati solo nell'app.
  - (b) anche archivia e riapri nel web vecchio.
- **L-7 — Le letture di un archiviato.**
  - **(a) consigliata**: due rotte dedicate (`GET /api/projects/archived` e
    `…/:projectId/archived-view`), dichiarate `config.archived: "read"`.
    Una lettura vecchia non cambia significato, e il test del registro ne
    tiene l'elenco.
  - (b) come il design, `?archived=true` sulle letture esistenti: il
    parametro passerebbe da ogni lettura, e ognuna dovrebbe ricordarsene.

## Cosa F6 non fa

- Le azioni di Claude «archivia» e «riapri» (F7, classe B).
- I permessi di progetto dei reparti (F8).
- Toccare la piattaforma git di un repository staccato (L-2).

## Stima

Sette task. Il 2 è il più largo e il più delicato (98 punti, e una
dimenticanza è silenziosa); il 5 il più irreversibile (va provato coi
negativi prima di tutto il resto).
