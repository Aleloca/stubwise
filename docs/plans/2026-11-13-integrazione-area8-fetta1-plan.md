# Area 8, fetta 1 — i rilasci

> Piano di stubwise-72, 13 nov 2026, su richiesta di stubwise-46.
> Design: `docs/plans/2026-11-13-integrazione-area8-design.md` (§ Fette F1,
> § Il modello dei dati F1, § Il motore nel worker, Review Focus F1, il lato
> renderer di 94 per la F1). Inventario e decisioni:
> `docs/plans/2026-11-13-integrazione-area8-inventario.md` (voci 1, 3, 4, 5, 6,
> 11; «Decisioni»; «Le righe delle due invarianti»). Specifica: il prototipo
> (`apps/desktop/src/renderer/data/releases/`, `domain/releases/`,
> `pages/releases/`, `.impeccable/shape/releases.md`, `claude-drafts.md` §3.7).
> Branch: `feat/area8-f1` (server, 72), `feat/area8-f1-renderer` (94).

## Cosa entra

- Il **rilascio come oggetto**: `<PRJ>-V<n>` = un merge di una PR sul ramo
  di rilascio del repository, da Stubwise o da fuori (S-3 = a *(M)*), con le
  note della PR fermate al merge.
- Il suo **stato DERIVATO, mai salvato**: dalle run di CI del commit di merge
  lette col token dell'account git del repository (S-2 = a), o, senza
  pipeline, dal commit che l'agente riporta sull'ambiente di produzione
  (`sameCommit`). Il rilascio fallito ha «Fai sistemare a Claude» (una task
  normale col rilascio collegato) e «Spiega».
- Le **impostazioni del repository** per i rilasci: ramo di rilascio,
  pipeline (tutte le run o quelle coi nomi dati), provider di CI, le PR dei
  colleghi (`analyze_and_fix` | `analyze_only` | `off`).
- **Le PR dei colleghi senza adozione** (invariante 2 riscritta).
- Le **note per PR** (bozza calcolata, come il prototipo: una riga per task).
- Gli **ambienti per repository** (R-L2), prerequisito anche della F4.
- La **Home «Rilasci»** (con l'extra di `release.merge`) e l'evento
  `release_page` della Chat.

## Fuori dalla F1

Le iscrizioni agli avvisi (F2: qui l'avviso del rilascio fallito usa il
routing di oggi), Support (F3), Servers (F4), il log delle run dentro l'app
(vedi la domanda P-1), nessun Deploy né Re-run (anti-obiettivo).

## Task 0 — l'invariante «Le PR dei colleghi» (46, PRIMA del codice)

All'unione di questo piano, prima di ogni commit di codice della F1, 46
applica le righe dell'inventario («Le righe delle due invarianti», (2)) a
`docs/invariants/pr-corrections.md` (la voce «Adottare una PR aperta da
altri» diventa «Le PR dei colleghi»; la riga sul push) e il rimando in
CLAUDE.md. Il codice del Task S8 la segue alla lettera. L'invariante (1),
«Stubwise non fa deploy», NON si tocca nella F1 (è della F4b).

## Task del SERVER (72)

S1. **La migrazione 0175** (il primo numero libero su tutti i remoti, `when`
   crescente):
   - `releases` (`id`, `code`, `seq`, `project_id`, `repository_id`,
     `pr_number`, `pr_url`, `title`, `merge_sha`, `merged_at`, `merged_by`
     (utente, nullable), `merged_git_name`, `via_stubwise`, `release_notes`,
     `seen_in_production_at`, `fix_ticket_id`), unici `(project_id, seq)`,
     `code`, e `(repository_id, merge_sha)` (una riconsegna del webhook non
     crea un secondo rilascio); `release_code_seqs` per progetto (come
     `automation_code_seqs`);
   - `release_ci_runs` (`release_id`, `provider_run_id`, `name`, `status`
     `running` | `success` | `failed`, `url`, `failed_step`, `started_at`,
     `ended_at`), unico `(release_id, provider_run_id)`;
   - `repositories`: `release_branch` (null = il ramo di default),
     `release_pipeline` jsonb (`{mode:"auto"}` | `{mode:"named",names}`),
     `ci_provider` (`github_actions` | `bitbucket_pipelines` | null),
     `colleague_prs` (default `analyze_and_fix`? vedi P-2);
   - `pr_reviews.analysis_only` (bool, «Solo analisi» per PR) e chi/quando;
   - `pr_release_notes` (`repository_id`, `pr_number`, `body`, `updated_by`,
     `updated_at`), unico `(repository_id, pr_number)`;
   - `environment_servers` (`environment_id`, `repository_id`, `server_id`),
     unico `(environment_id, repository_id)`; i dati di oggi: per ogni
     ambiente con `server_id`, una riga per ogni repository del progetto;
     `project_environments.server_id` resta (inerte) per il rollback;
     «una sola produzione per progetto» ([R 12]) come indice unico parziale,
     preceduto da un controllo che lo dice se i dati di oggi lo violano;
   - il `notification_kind` `release.failed` (statement a sé, mai usato nel
     batch);
   - il trigger della Chat `releases_chat_release_page` (`AFTER INSERT ON
     releases`), con la funzione della 0141.
   *Test*: i vincoli (unicità, la sequenza, la produzione unica), la
   migrazione dei server degli ambienti, la parità degli enum.

S2. **Il provider git** (`packages/git`):
   - l'evento `merged` (`WebhookEvent`) porta in più, facoltativi,
     `targetBranch`, `mergeSha`, `title`, `mergedByLogin` (GitHub:
     `base.ref`, `merge_commit_sha`, `title`, `merged_by.login`; Bitbucket:
     `destination.branch.name`, `merge_commit.hash`, `title`, `closed_by`);
   - `getCommitRuns(p, sha)`: le run di CI di un commit (GitHub check-runs
     del commit; Bitbucket statuses del commit), con nome, stato, url e il
     passo fallito quando il provider lo dice; `unknown` su un errore di
     lettura (mai «nessuna run»), come `getPullRequestChecks`.
   *Test* sulle fixture dei due provider, compreso il caso illeggibile.

S3. **Il rilascio nasce dal merge** (`apps/server`):
   - da Stubwise: `releasePullRequest` crea il rilascio nella sua stessa
     transazione dopo il merge riuscito (`via_stubwise`, `merged_by` = chi
     ha fatto il merge), con le note della PR fermate;
   - da fuori: il webhook `merged` con `targetBranch` = ramo di rilascio del
     repository crea il rilascio (`via_stubwise` falso, `merged_git_name`;
     la persona solo se collegata), idempotente su `(repository_id,
     merge_sha)` anche contro il merge da Stubwise della stessa PR (il primo
     che arriva lo crea, l'altro lo trova);
   - un merge su un ramo che non è quello di rilascio non è un rilascio.
   *Test*: un merge da Stubwise → un rilascio; la riconsegna del webhook dopo
   → nessun secondo; un merge esterno → `via_stubwise` falso; un merge su un
   altro ramo → niente.

S4. **Lo stato dopo il merge** (`apps/worker`):
   - un poller legge le run del commit di merge dei rilasci non conclusi
     (`getCommitRuns`, col token dell'account del repository), filtrate da
     `release_pipeline`, e le scrive in `release_ci_runs`; si ferma quando
     tutte sono concluse o dopo un tetto di tempo;
   - senza pipeline (`ci_provider` null), lo stato viene dal commit che
     l'agente riporta sull'ambiente di produzione del repository
     (`environment_servers`, `sameCommit`): `seen_in_production_at`;
   - lo stato si DERIVA in shared (`releaseStatusOf`, la regola di
     `domain/releases/releaseStatus.ts` del prototipo spostata): `running`,
     `succeeded`, `failed`, `unknown`, «non ancora in produzione»;
   - al primo `failed`, l'avviso `release.failed` a chi ha fatto il merge (se
     collegato) e a chi ha `release.merge` nel progetto (routing di oggi; la
     F2 lo porta nel catalogo).
   *Test*: le run → lo stato; una lettura illeggibile non dice «riuscito»; un
   avviso solo al primo `failed`; il commit in produzione con lo SHA corto.

S5. **Le rotte dei rilasci**: `GET /api/projects/:projectId/releases`
   (elenco, filtrato nella WHERE sui progetti visibili), `GET
   /api/releases/:code` (dettaglio: run, stato derivato, note, la task di
   correzione, i permessi calcolati), `POST /api/releases/:code/fix` («Fai
   sistemare a Claude»: una task `bug` col rilascio collegato e il passo
   fallito nella descrizione, con `tickets.create`; una sola per rilascio),
   `GET /api/releases/:code/runs/:runId/log` solo se P-1 lo vuole. «Spiega»
   apre una conversazione con Claude dal renderer, col contesto del rilascio
   (nessuna rotta nuova: le conversazioni dell'area 3). Nascosto =
   inesistente (404). *Test* negativi sui permessi.

S5b. **L'elenco delle PR aperte** (richiesta di 94, `releases-prs`): `GET
   /api/projects/:projectId/pulls`, le PR aperte dei repository del progetto
   (interne ed esterne, la stessa deduplica della coda), a CHIUNQUE veda il
   progetto (404 se no; la coda resta filtrata su `release.merge`, ed è lei a
   dire `canMerge`), coi campi di `listOpenPrs` del prototipo: autore
   (persona collegata o nome git), origine `stubwise` | `colleague`, task,
   branch e base, `headSha`, `checks` (passing | failing | pending |
   unreadable), `mergeable`, «Già su staging?», l'analisi (verdetto e
   riassunto), le correzioni fatte, lo stato derivato, il tetto, «Solo
   analisi» (chi e quando), e i permessi calcolati per chi guarda
   (`actions.analysisOnly`, `actions.requestCorrection`,
   `canEditReleaseNotes`). Con S8 entrano le PR dei colleghi, con S9
   `canEditReleaseNotes`. *Test* negativi (chi non vede il progetto: 404; un
   Developer vede le PR ma non `canMerge`).

S6. **Le impostazioni del repository**: `PATCH /api/repositories/:id` con
   `releaseBranch`, `releasePipeline`, `ciProvider`, `colleaguePrs`
   (`repos.manage`), campi additivi nella risposta. *Test*.

S7. **Gli ambienti per repository** (R-L2): le rotte degli ambienti leggono e
   scrivono `environment_servers` (un server per repository; la forma di oggi
   resta come campo derivato per i client vecchi); `deployedOn` della coda e
   lo stato dei rilasci passano da lì; «una sola produzione». La visibilità
   dei server resta `server_projects` (F4a). *Test*.

S8. **Le PR dei colleghi** (invariante 2, Task 0):
   - ogni PR aperta su un repository collegato si analizza secondo
     `colleague_prs` (il ciclo di review di oggi, `pr_reviews`), senza
     adozione;
   - con `analyze_and_fix` la prima correzione parte da sola, salvo «Solo
     analisi» (`POST/DELETE …/analysis-only`, `prs.adopt`, calcolato dal
     server per il client);
   - le regole di sicurezza dell'adozione restano tutte (fork, protetti,
     default, target, `stubwise/…`, push in avanti, verifica dal provider,
     fail-closed), sotto il lock dove sono oggi;
   - «Chiedi modifiche» e la ripresa su una PR di un collega vogliono
     `prs.adopt` (`correctionActionAllowed`);
   - le rotte di adozione restano per i client vecchi e diventano un modo di
     scrivere «analisi e correzioni» su quella PR (nessuna rottura); il
     renderer non le usa (R-3).
   *Test*: niente correzione su un fork o un protetto anche senza adozione;
   «Solo analisi» ferma la prima correzione; un collega senza `prs.adopt` non
   chiede modifiche; mutazioni sul controllo dei protetti.

S9. **Le note per PR**: `GET/PUT /api/repositories/:id/pulls/:number/release-notes`
   (scrivere: `release.merge` o `tickets.edit` sulla task della PR, come
   `canEditReleaseNotes`), la bozza CALCOLATA (`releaseNotesDraftFor` del
   prototipo, una riga per task dalle task della PR e dai commit che ne citano
   i codici, spostata in shared: nessun modello), fermate nel rilascio al
   merge. *Test*.

S10. **La Home «Rilasci»**: `meHome` passa l'extra `releases` a `resolveHome`
   per chi ha `release.merge` in qualche progetto (solo Home nuove, [R 22]);
   `GET /api/me/releases` → `MyReleases { failed, ready }` (i falliti che mi
   riguardano finché la loro task è aperta, poi le PR pronte della coda).
   *Test*.

S11. **`release_page`**: il trigger di S1 pubblica l'evento nel «general» del
   progetto (chi l'ha acceso, D8 dell'area 4); la scheda la deriva il server
   a lettura (codice, titolo, stato). *Test*: un rilascio → un evento; uno
   nascosto non esce.

S12. **Il client e le forme** (`packages/api-client`, `@stubwise/shared`):
   rilasci, run, stato, note, impostazioni del repository, ambienti per
   repository, «Solo analisi», `MyReleases`; campi nuovi facoltativi, con un
   test che parsa una risposta senza. Il catalogo delle forme lo mando a 94.

S13. **Il deploy-log**: la voce della F1 (ordine server → worker → caddy, la
   0175, `release.failed` nel rollback, gli scope delle run per «Validate»).

## Global Constraints

- Il merge resta l'unica azione di rilascio; nessun Deploy, nessun Re-run;
  `releasePullRequest` resta NEVER per Claude.
- Lo stato di un rilascio si DERIVA e si LEGGE; un errore di lettura non è
  mai «riuscito».
- Le regole di sicurezza delle PR dei colleghi sono quelle dell'adozione,
  fail-closed, prima del worktree e prima del push.
- Nascosto = inesistente; i permessi li calcola il server.
- Verso i client solo campi additivi con default; ogni `notification_kind`
  nuovo è un passo di rollback.
- TDD con mutazioni sui controlli di permesso, sui protetti e sul confine.

## Review Focus

- Nessun percorso esegue una pipeline o un deploy.
- Un merge esterno crea UN rilascio (riconsegne, corsa col merge da Stubwise).
- Lo stato derivato non afferma ciò che la CI non dice.
- Una PR di un collega non si corregge mai su un fork, un protetto, il
  default, il target o un `stubwise/…`; il push sempre in avanti; «Solo
  analisi» ferma davvero.
- Le note: chi non può scrivere non scrive; la bozza non inventa task.

## Domande (per 46, non del maintainer) — risposte *(O, 46, 13 nov 2026)*:
P-1 = a, P-2 = a

P-1. **Il log di una run di CI dentro l'app** (il prototipo lo mostra a chi
   ha `repos.view`). (a) Nella F1 solo il link alla run sul provider; il log
   nell'app va nel registro (leggere i log delle Actions è un archivio zip per
   job, Bitbucket per passo: lavoro a sé). *(consigliata)* (b) Nella F1, il
   log letto dal provider su richiesta.

P-2. **Il default di `colleague_prs`** per i repository già collegati.
   (a) `analyze_only`: nessuna correzione parte da sola su una PR di un
   collega finché chi ha `repos.manage` non sceglie «analisi e correzioni».
   *(consigliata: nessun push nuovo sui rami dei colleghi il giorno del
   deploy)* (b) `analyze_and_fix`, come dice l'invariante riscritta per un
   repository nuovo.
