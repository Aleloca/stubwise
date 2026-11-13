# Area 8 — Rilasci, ambienti, avvisi, Support, Servers: inventario

> Inventario per l'integrazione dell'area 8 nell'app nuova (`apps/desktop`),
> 13 nov 2026, su richiesta di stubwise-46. Lato server: stubwise-72. Lato
> renderer: stubwise-94. Solo documento: nessuna decisione presa qui, le
> domande stanno in fondo (S-n del server, R-n del renderer).
>
> Fonti: il registro dei rimandi (`docs/plans/integrazione-registro-rimandi.md`,
> «Area 8»), il prototipo (`apps/desktop/src/renderer/data/`,
> `pages/`, `.impeccable/shape/`), il server (`apps/server`, `apps/worker`,
> `packages/*`). Confine di prodotto invariato: **Stubwise non fa deploy, il
> merge di una PR già aperta è l'unica azione di rilascio** (CLAUDE.md, «I due
> divieti dell'operatore» e «Stubwise non fa deploy»).

## Le voci

Gli stessi titoli nei due lati, per leggerli in parallelo:

1. Home: il blocco «Rilasci» (e l'extra di `resolveHome` per `release.merge`)
2. Home: il blocco «Clienti in attesa»
3. Rilasci: la coda, la pagina di Release, il merge
4. Adozione delle PR
5. Note di rilascio
6. Ambienti
7. Avvisi e iscrizioni
8. Support: conversazioni, risposte, origine di una richiesta, «View conversation»
9. Servers e accesso SSH
10. Azioni di Claude dell'area 8
11. La Chat: l'evento `release_page`

## Lato server

> Di stubwise-72. Per ogni voce: dove sta nel prototipo, cosa c'è già nel
> server (percorsi e rotte), le lacune. La specifica è il prototipo con il suo
> design, `docs/plans/2026-10-28-desktop-area8-releases-support-servers-design.md`
> (piani `…-area8a-plan.md` e `…-area8b-plan.md`, shape
> `apps/desktop/.impeccable/shape/{releases,support,alerts,servers,server-access,server-task,claude-drafts}.md`).
> Quel design ha già molte decisioni del maintainer (segnate *(maintainer)*
> lì): qui le riporto come FATTI, non come domande. Nel design sono «non
> obiettivi» del prototipo, e quindi lavoro di questa integrazione, «il
> motore sul server»: la lettura vera delle run di CI, l'SSH vero, gli agenti
> veri sul worker, il push vero sul ramo dei colleghi.

### ⚠️ Prima del codice: due invarianti da riscrivere

Il design dell'area 8 (§ «Invarianti da riscrivere», decisioni 2 e 13 del
maintainer) dice di riscrivere CLAUDE.md e `docs/invariants/` **prima** del
codice. Oggi il server le applica alla lettera:

1. **«Stubwise non fa deploy: il merge è il confine (fase 8)»**: per i
   rilasci non cambia niente (il merge resta l'unica azione), ma nasce
   **un'azione sull'ambiente, una sola**: la correzione di un problema di un
   server, da una task, con l'accesso SSH di correzione, avviata da chi ha
   `servers.operate` e col piano sempre approvato prima. Il design dice anche
   la frase del nuovo confine (l'accesso di correzione non rilascia, non
   aggiorna immagini, non fa pull, non riavvia come passo di un rilascio).
   Oggi CLAUDE.md dice «nessun codice che esegua… qualunque azione
   sull'ambiente», e `project_environments` è «pura anagrafica».
2. **L'adozione delle PR** (`docs/invariants/pr-corrections.md`, «Adottare una
   PR aperta da altri»): il prototipo toglie il bottone «Adopt» (anti-obiettivo
   di `shape/releases.md`). Le PR dei colleghi si analizzano, e si correggono,
   secondo un'impostazione per repository (`Repository.colleaguePrs`), con «Solo
   analisi» per PR sotto `prs.adopt`. Oggi il server vuole l'adozione
   esplicita (`ticket_repositories.adopted_at`, rotte `…/adoption`).

### 1. Home: il blocco «Rilasci» (e l'extra di `resolveHome` per `release.merge`)

- **Prototipo**: `data/releases/reads.ts` `listMyReleases()` → `MyReleases
  {failed, ready}`; `data/queries.ts` passa `["releases"]` come extra a
  `resolveHome` per chi ha `release.merge` (solo Home nuove, [R 22]).
  Contenuto: i rilasci falliti che mi riguardano (il mio merge o un'iscrizione
  «rilascio fallito») finché la task di correzione è aperta, poi le PR pronte.
- **Server, c'è**: il tipo di blocco `releases` in
  `packages/shared/src/tasks/home.ts`, e `resolveHome(…, extras)`. Le PR
  pronte esistono già come dato: `listReleaseQueue`
  (`apps/server/src/services/release.ts`).
- **Lacune**:
  - `meHome` (`apps/server/src/services/home.ts`) chiama `resolveHome` senza
    l'extra `release.merge`;
  - nessuna lettura per il blocco. Le PR pronte si derivano dalla coda; i
    rilasci falliti no, perché il server non sa niente dopo il merge (voce 3).

### 2. Home: il blocco «Clienti in attesa»

- **Prototipo**: `data/support/reads.ts` `listWaitingCustomers()`, filtrato
  su chi vede il progetto e ha `support.reply`; solo dal catalogo, mai nelle
  Home di default ([A 17]); «in attesa da 3 h», `warning` dopo 24 h ([A 4]).
- **Server, c'è**: il tipo di blocco `waitingCustomers`; le conversazioni del
  widget (`widget_conversations`, `last_message_at`; `widget_messages`).
- **Lacune**: non esiste lo stato «il cliente aspetta noi»: oggi risponde
  solo l'AI del widget, e i messaggi sono `user`/`assistant`
  (`widget_messages.role`, testo libero). Non esiste il permesso
  `support.reply` (è solo del prototipo, `LocalProjectPermission`).

### 3. Rilasci: la coda, la pagina di Release, il merge

- **Prototipo**: `data/releases/` — `listOpenPrs`, `listReleaseQueue`,
  `listReleases`, `getRelease`, `mergePr` (due passi, [R 10]), `fixRelease`
  («Fai sistemare a Claude» apre una task normale, [R 16]), `explainRelease`
  ([R 17]); `Release` = un merge sul ramo di rilascio, codice `<PRJ>-V<n>`,
  stato DERIVATO dalle run di CI (`CiRun`) o, senza pipeline, dal commit che
  l'agente riporta in produzione (`seenInProductionAt`); `viaStubwise` falso
  per i merge fatti fuori. `Repository.releaseBranch`, `releasePipeline`
  (tutte le run o solo quelle coi nomi dati), `ciProvider`
  (`github_actions`|`bitbucket_pipelines`|null). Nessun Deploy né Re-run
  ([R 1]).
- **Server, c'è**:
  - `GET /api/release-queue` (filtrata nella WHERE sui progetti con
    `release.merge`) e `POST /api/tickets/:id/repositories/:repositoryId/release`
    (`releasePullRequest`, con `release.merge` ricontrollato nel servizio);
    gli errori del merge coincidono con `MergeError` del prototipo
    (`forbidden`, `not_found`, `already_closed`, `checks_failed`,
    `checks_unreadable`, `not_mergeable`, `merge_forbidden`; in più `502
    merge_failed`);
  - nella coda: `origin` stubwise/external, `reviewVerdict`, `checks` letti
    dal provider PRIMA del merge, `risk`, `deployedOn` («Già su staging?»,
    `sameCommit` contro il commit riportato dall'agente), `reviewStale`;
  - il polso `waitingForMerge[].canMerge` calcolato dal server;
  - test negativi (Legacy Member, Developer) e `releasePullRequest` nella lista
    NEVER delle azioni di Claude.
- **Lacune**:
  - **Il rilascio come oggetto non esiste**: nessuna tabella dei rilasci,
    nessun codice `<PRJ>-V<n>`, nessuna pagina di Release;
  - **niente dopo il merge**: nessuna lettura delle run di CI (GitHub
    Actions, Bitbucket Pipelines), nessuno stato del rilascio, nessun
    «rilascio fallito», nessun log per `repos.view`;
  - **i merge fatti fuori da Stubwise** (`viaStubwise` falso) richiedono di
    riconoscere un merge sul ramo di rilascio dal webhook push (oggi il push
    accoda solo recount dei report e build del grafo);
  - le impostazioni del repository `releaseBranch`, `releasePipeline`,
    `ciProvider`, `colleaguePrs` non esistono in `repositories`;
  - «Fai sistemare a Claude» e «Spiega» del rilascio: servono la task di
    correzione col rilascio collegato (`fixTaskId`) e la conversazione.

### 4. Adozione delle PR

- **Prototipo**: nessun bottone «Adopt»; `Repository.colleaguePrs` (analisi e
  correzioni, solo analisi, spento) e «Solo analisi» per PR con `prs.adopt`
  (`visibility.ts` `canSetAnalysisOnly`, `canRequestCorrection`).
- **Server, c'è**: l'adozione esplicita (`apps/server/src/services/pr-adoption.ts`:
  `adoptPullRequest`, `releaseAdoption`; `POST`/`DELETE
  /api/tickets/:id/repositories/:repositoryId/adoption`, `prs.adopt`), fail-closed
  su fork, rami di Stubwise e rami base; commenti da template; le review
  esterne (`pr_reviews`) e il ciclo di correzione post-PR.
- **Lacune**: l'analisi automatica di OGNI PR del repository secondo
  `colleaguePrs`, senza adozione, e il push sul ramo di un collega («push vero
  sul ramo dei colleghi», non obiettivo del prototipo): è il cambio
  d'invariante qui sopra.

### 5. Note di rilascio

- **Prototipo**: note PER PR (`data/releases/notes.ts`
  `releaseNotesDraftFor`, una riga per task; `setPrReleaseNotes`), scrivibili
  con `release.merge` o `tickets.edit` sulla task della PR
  (`canEditReleaseNotes`); al merge si fermano nel rilascio
  (`Release.releaseNotes`); nessun salvataggio automatico ([DR 9], [DR 10]).
  La scheda Docs si chiama «Release notes» ([R 25]).
- **Server, c'è**: le note di rilascio NOTTURNE (`apps/worker/src/nightly/release.ts`,
  `release-page.ts`): una pagina Docs `releases` per intervallo di commit,
  slug `release-<YYYYMMDD-HHmm>-<sha7>`, con un modello testo; coda
  `nightly_items`; avviso `docs.nightly_attention`; `docs/invariants/nightly.md`.
- **Lacune**: nessuna nota per PR (né campo né rotta), nessuna bozza di
  Claude per le note di una PR, e nessun legame fra le pagine notturne e un
  rilascio (vedi S-6).

### 6. Ambienti

- **Prototipo**: `data/releases/reads.ts` `listEnvironments` (`canManage`),
  `createEnvironment`/`updateEnvironment`/`deleteEnvironment`; un ambiente ha
  i suoi server PER REPOSITORY (`EnvironmentServer`, R-L2: repository diverse
  dello stesso progetto su server diversi); «= AUD-V6» accanto all'ambiente
  ([R 11]); una sola produzione per progetto ([R 12]).
- **Server, c'è**: `project_environments` (nome, `kind`
  test|staging|production, url, UN `server_id`), rotte `GET/POST/PATCH/DELETE
  /api/projects/:projectId/environments[/:environmentId]` (`environments.manage`
  per scrivere), `runningImage`/`runningCommitSha` dall'ultimo campione
  dell'agente quando un servizio ha il nome dell'ambiente; i file `.env` per
  ambiente (`project_env_files`, `repos.manage`), di cui solo `test` entra in
  un worktree.
- **Lacune**:
  - un server per ambiente, non per repository (R-L2);
  - «una sola produzione per progetto»: il server limita solo `test` a una;
  - «= AUD-V6» richiede i rilasci (voce 3).

### 7. Avvisi e iscrizioni

- **Prototipo**: `data/alerts/` (`subscriptionRows`, `setSubscription`,
  `setSubscriptionAs`, `copySubscriptions`, `muteProject`,
  `muteFromNotification`; `whyReceives`, `deliveredTo`, `wouldNotify`); un
  catalogo dei tipi (`domain/alerts/catalog.ts`, gruppi prs, releases, docs,
  tasks, support, monitor, claude) a cui le aree aggiungono i loro tipi
  (`data/servers/alertTypes.ts`); stati on|off|suspended|mandatory; i
  destinatari si calcolano A LETTURA (iscrizioni × permessi); Preferenze →
  Notifiche e la scorciatoia dalla colonna del progetto ([A 14]); niente Slack
  (in dismissione, *(maintainer)*).
- **Server, c'è**: il routing delle notifiche per audience
  (`packages/notifications/src/routing.ts`), le preferenze per canale
  (`PATCH /api/me/notification-prefs`), il push via relay; `monitor.alert` e
  `monitor.recovered` (worker `apps/worker/src/monitor/alerts.ts`: offline,
  cpu/mem/disco sostenuti, `check_down`, con isteresi), audience «deciders»
  ristretta a chi ha `monitor.manage`.
- **Lacune**: il sistema di iscrizioni non esiste — né tabella, né catalogo
  lato server, né destinatari calcolati da iscrizioni × permessi; i tipi
  nuovi del catalogo (`pr.opened`, `pr.analysis_issues`, `pr.corrected`,
  `release.merged`, `release.succeeded`, `release.failed`,
  `support.request`, `support.customer_replied`, …) non sono
  `notification_kind` (ognuno nuovo è un passo di rollback, CLAUDE.md).

### 8. Support: conversazioni, risposte, origine di una richiesta, «View conversation»

- **Prototipo**: `data/support/` (`listSupportConversations`,
  `getSupportConversation`, `replyToCustomer` con Undo di 5 s ([A 11]),
  `draftReply`, `openRequestFrom`, `followConversation` (chi risponde segue,
  [A 14]), `emailDraftFor` («Scrivigli anche per email», [A 12]); gli stati
  della conversazione per gruppo e priorità ([A 2]); canali `widget` e `mcp`
  (`SupportConversation.channel`); fuori ambito chiudere, assegnare,
  etichettare ([A 7]); nessuna risposta senza «Send to customer», nessuna
  risposta automatica *(maintainer)*. L'ORIGINE di una richiesta:
  `pages/support/RequestOrigin.tsx` in `RequestDetail` («Show the
  conversation (N messages)», sola lettura, [A 15]).
- **Server, c'è**: l'API pubblica del widget (`/widget/:slug/config`,
  `…/conversations`, `…/messages` con la risposta AI in streaming,
  `…/tickets` → ticket `source: "widget"` con tetto giornaliero), l'admin dei
  widget (`/api/projects/:projectId/widgets`, `widget.manage`), la lettura
  delle conversazioni per i membri
  (`GET /api/projects/:projectId/widget/conversations?ticketId=&widgetId=` e
  `…/:conversationId/messages`): `ticketId` è già il modo con cui un ticket
  trova la sua conversazione (`widget_messages.ticket_id`).
- **Lacune**:
  - nessuna risposta di una persona: niente rotta, niente ruolo `human` nei
    messaggi, e il widget non ha modo di ricevere un messaggio che non sia la
    risposta in streaming alla sua domanda (serve una lettura dei messaggi
    nuovi lato cliente);
  - niente `support.reply`, niente stati della conversazione («aspetta
    noi»), niente «segui», niente avviso `support.request` /
    `support.customer_replied`;
  - il canale `mcp` (le richieste dal server MCP in modalità collaboratore)
    non salva una conversazione;
  - l'origine di una RICHIESTA da Support: il widget oggi apre un TICKET; non
    c'è un legame richiesta (voce di backlog) → conversazione;
  - «Scrivigli anche per email» (R-K14): da quale casella;
  - **«View conversation» sulle task del widget** (voce del registro): nel
    prototipo non c'è (solo `TechnicalSection` col payload); il server ha già
    il dato (`ticketId` sulle conversazioni). Vedi S-9.

### 9. Servers e accesso SSH

- **Prototipo**: `data/servers/` — `listProjectServers`, `listAllServers`
  (`monitor.manage`), `getServer`, `getServerMetrics`, soglie e controlli
  (`monitor.ts`), accessi SSH (`access.ts`: `linkSshAccess`,
  `verifySshAccess`, `regenerateSshAccess`, `revokeSshAccess`; due coppie di
  chiavi, lettura e `stubwise-fix` con sudo, [SA 2]), correzione da task
  (`fix.ts` `startServerFix`: solo da una task legata a quel server, avviata
  da chi ha `servers.operate`, mai Claude (R-L9); nessun comando prima di un
  piano approvato da chi ha `plans.approve` (R-L11), un comando alla volta con
  i ricontrolli, controllo finale in sola lettura); l'analisi AUTOMATICA
  all'avviso (`analysis.ts`, *(maintainer, decisione 10)*: un agente entra in
  sola lettura, apre una task `bug` con sorgente `server` e la diagnosi).
  Visibilità: chi ha `monitor.manage` li vede tutti, gli altri quelli di un
  ambiente di un progetto che vedono.
- **Server, c'è**: tutto il monitor — `servers` (chiave `sk_…` come hash,
  soglie `alert_thresholds`, `active_alerts`), `server_projects`, metriche e
  rollup, `service_checks` e campioni; `POST /monitor/ingest`, `GET
  /monitor/config`; `/api/servers` (lettura con `monitor.view` o dai progetti
  visibili; scritture `monitor.manage`; chiave in chiaro una volta),
  `serverCheckRoutes`; gli avvisi del worker.
- **Lacune**:
  - nessun SSH: né chiavi (generazione, cifratura, verifica, revoca), né
    esecuzione, né utente di correzione;
  - nessuna analisi automatica (agente sul worker in sola lettura via SSH,
    un'analisi per episodio, tetto di durata e costo);
  - nessuna correzione da task (`servers.operate`, il gate del piano, i
    ricontrolli per comando, lo Stop, la revoca);
  - i permessi `servers.operate` (progetto) e `servers.ssh.manage` (istanza)
    sono solo del prototipo;
  - la visibilità di un server oggi passa da `server_projects`, nel prototipo
    dagli ambienti (R-L2).

### 10. Azioni di Claude dell'area 8

- **Prototipo**: `setSubscription` nel catalogo (classe A, annullabile,
  `data/claude/catalog.ts`); le bozze `supportReplyDraft` e
  `releaseNotesDraft` (`data/api-mutations.ts`, campi `supportReply` e
  `releaseNotes` in `data/claude/context.ts`); i suggerimenti relativi
  (`data/claude/suggestions.ts`); `explainRelease`, `fixRelease`.
- **Server, c'è**: il catalogo delle azioni
  (`apps/server/src/claude-actions/catalog.ts`, elenco in
  `packages/shared/src/schemas/claude-actions.ts`: task, commenti, richieste,
  avvio di un run, traguardi, filtri, `fillMailBody`), con la lista NEVER
  (`releasePullRequest` dentro).
- **Lacune**: nessuna delle tre (iscrizioni, bozza di risposta al cliente,
  bozza delle note della PR); dipendono dalle voci 5, 7 e 8. Il merge resta
  NEVER.

### 11. La Chat: l'evento `release_page`

- **Prototipo**: `data/chat/events.ts` `publishReleasePage` (usato solo da
  seme e test); `ReleasePage` in `data/model.ts` «finte fino all'area 8»;
  la scheda in `pages/chat/SystemCard.tsx`.
- **Server, c'è**: il tipo nell'enum (`CHAT_EVENT_KINDS`, fra i default del
  «general»), migrazioni 0135 e 0141; `apps/server/src/chat/events.ts` lo dice
  senza fonte.
- **Lacune**: nessun produttore, perché la pagina di Release non esiste (voce
  3); va deciso se la «pagina» è il rilascio `<PRJ>-V<n>` o la pagina
  notturna delle note (S-6).


## Lato renderer

(94)

## Domande di prodotto

### Del server (S-n)

Ognuna con la consigliata per prima. Le decisioni già prese dal maintainer
nel design dell'area 8 del prototipo non tornano qui.

S-1. **Come si taglia l'area in fette.** (a) Quattro fette nell'ordine delle
   dipendenze: rilasci (oggetto, stato dopo il merge dalle run di CI,
   ambienti per repository, note per PR, Home «Rilasci»); iscrizioni agli
   avvisi; Support (risposte di una persona, stati, Home «Clienti in
   attesa», origine); Servers (porto del monitor, poi SSH, analisi e
   correzione, per ultime e dopo la riscrittura dell'invariante).
   *(consigliata: ognuna sta in piedi da sola, e l'SSH, la più rischiosa,
   arriva quando il resto è stabile)* (b) 8a e 8b come nel prototipo, in due
   fette grandi.

S-2. **Le run di CI dopo il merge: con quali credenziali.** (a) Con
   l'account git d'istanza del repository (`gitAccountId`, gli scope di
   lettura delle Actions/Pipelines in più, controllati da «Validate» come gli
   altri), e senza pipeline lo stato dal commit che l'agente riporta in
   produzione. *(consigliata: nessun segreto nuovo)* (b) Un token a parte
   per la CI.

S-3. **I merge fatti fuori da Stubwise.** (a) Diventano rilasci anche loro
   (`viaStubwise` falso), riconosciuti dal webhook push sul ramo di rilascio,
   con la persona collegata se si sa. *(consigliata: è ciò che il prototipo
   mostra, e lo stato dopo il merge serve comunque)* (b) Solo i merge fatti da
   Stubwise sono rilasci.

S-4. **Le iscrizioni agli avvisi e le notifiche di oggi.** (a) Il catalogo
   copre i tipi nuovi dell'area 8 e i `monitor.*`; gli altri `notification_kind`
   restano sul routing di oggi finché un'area non li porta nel catalogo, e le
   preferenze per canale di oggi restano. *(consigliata: nessuna card di
   oggi cambia destinatari di colpo)* (b) Tutto il routing passa subito
   dalle iscrizioni.

S-5. **La risposta di una persona arriva al cliente.** (a) Nel widget, che
   legge i messaggi nuovi della conversazione (un polling leggero o lo
   stream), e «Scrivigli anche per email» dalla casella di chi risponde
   (area 6, le stesse regole di invio). *(consigliata)* (b) Solo per email.

S-6. **Che cos'è la «pagina di Release» (e quindi `release_page`).**
   (a) Il rilascio `<PRJ>-V<n>` (un merge sul ramo di rilascio) con le sue
   note per PR; le pagine notturne `releases` restano Docs.
   *(consigliata: è la pagina che il prototipo ha, ed è un evento per merge)*
   (b) La pagina notturna delle note.

S-7. **I tre permessi nuovi** (`support.reply` e `servers.operate` di
   progetto, `servers.ssh.manage` d'istanza): (a) ai preset come nella
   tabella del design dell'area 8 (`servers.ssh.manage` al solo Admin; gli
   altri secondo la tabella), con la regola dei preset per i ruoli
   personalizzati. *(consigliata)* (b) A nessun preset, solo al full admin.

S-8. **Le chiavi SSH.** (a) Le genera il server, la privata si cifra a
   riposo come i file `.env` e la usa SOLO il worker; il client vede solo la
   pubblica e il comando. *(consigliata: anti-obiettivo 3 del design, «un
   segreto che esce»)* (b) Nella cassaforte delle credenziali (che il server
   non decifra mai: il worker non potrebbe usarle).

S-9. **«View conversation» sulle task del widget** (voce del registro, ma il
   prototipo la mette solo sulle richieste): (a) anche sulle task, lo stesso
   blocco in sola lettura, dal dato che il server ha già (`ticketId` sulle
   conversazioni). *(consigliata)* (b) Solo sulle richieste, come il
   prototipo.

S-10. **L'analisi automatica di un server spende AI senza un umano davanti**
   (come l'eccezione Q8 delle automazioni): (a) sotto il budget mensile
   dell'istanza, con il tetto di durata e costo per analisi del design, e
   un'analisi per episodio. *(consigliata)* (b) Solo se qualcuno la avvia
   dall'avviso.

### Del renderer (R-n)

(94)
