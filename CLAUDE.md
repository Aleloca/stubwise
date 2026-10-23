# Stubwise

Sistema di ticketing self-hostable con pipeline AI: un worker prende i ticket,
pianifica ed esegue il fix sul repo collegato (claude CLI), apre PR e notifica.
Include una sezione "Docs" Confluence-like con documentazione autogenerata dai
repo, ricerca vettoriale e chat RAG.

## Monorepo (pnpm workspace, Node >= 22, pnpm 10.9)

- `apps/server` — API Fastify + Zod; applica le migrazioni Drizzle all'avvio.
- `apps/worker` — coda di job durabile (`FOR UPDATE SKIP LOCKED`); esegue fix e
  generazione Docs via l'agente claude CLI. Serializza i job per-progetto.
- `apps/web` — SPA React + Vite + TanStack Router/Query, Tailwind v4 (estetica
  "terminal", test in happy-dom). **Servita da caddy** (vedi sotto), non dal server.
- `apps/docs` — sito Starlight (guida utente), buildato e servito su `/guide`.
- `apps/mobile` — app React Native **bare** (iOS + Android, niente Expo) di
  Stubwise; build/distribuzione manuali, vedi `apps/mobile/README.md`.
- `apps/push-relay` — relay HTTP delle notifiche push (fase 4), servizio
  `push-relay` sotto il profilo compose `relay`: **gira solo sul nostro VPS**
  (vedi "Architettura runtime" e "Deploy" sotto).
- `packages/*` — `api-client` (client HTTP tipato verso l'API server, condiviso
  da `apps/web` — dependency, non devDependency: vedi il commento in
  `Dockerfile.caddy` — e da `apps/mobile`; dalla App M3 copre anche posta e
  calendario: i gruppi `mail` e `calendar`, verso `/api/me/mail` e
  `/api/me/calendar`), `db` (Drizzle + Postgres/pgvector),
  `docs-engine`, `embeddings`, `git`, `google` (client HTTP puro OAuth/Gmail/
  Calendar, `fetch` iniettabile, condiviso da server e worker — fase 6, nessuna
  API Google chiamata da nessun altro punto del monorepo), `i18n`,
  `notifications`, `sdk`, `shared`, `widget` (bundle embeddabile del customer
  service, servito come `/widget.js` da caddy).
  `notifications` ospita anche i moduli **puri e condivisi fra server e
  worker** che leggono lo stato di un progetto: `project-signals.ts` (i
  segnali del pulse) e, dalla fase 5, `project-timeline.ts` — l'unione degli
  eventi di un progetto in una finestra temporale. La timeline serve sia alla
  rotta `GET /api/projects/:projectId/timeline` (server) sia al brief
  settimanale (worker): sta in un package che entrambi hanno già come
  dipendenza proprio per non duplicarne le query in due posti che poi
  divergono. `shared` ospita anche `design-tokens.ts` (colori/raggi del
  design, App M1+M2, 11 set 2026): la fonte VERA resta Tailwind
  (`apps/web/src/styles.css`, `--color-*`), e `design-tokens.ts` ne è una
  copia tenuta allineata da un test di parità regex
  (`apps/web/src/theme-parity.test.ts`, non un passo di codegen — deliberato,
  per non complicare il build web) — non generarla mai da lì: è `apps/mobile`
  (`theme/tokens.ts`) a importarla, non il contrario.
  Dalla **App M3** (12 set 2026) `shared` ospita anche `calendar-grid.ts`: le
  funzioni PURE della griglia del calendario (celle del mese, eventi di un
  giorno, posizionamento orario) più le due costanti della **finestra di
  ingestione** — `CALENDAR_LOOKBACK_DAYS`/`CALENDAR_WINDOW_DAYS`, `now − 30gg
  → now + 60gg`. Stava in `apps/web/src/lib/`, e le costanti in
  `apps/worker/src/google/calendar.ts` (che le ri-esporta, così
  nessun import esistente cambia, e resta l'unico punto che le usa per
  DECIDERE COSA INGERIRE — la finestra che il poller interroga; l'app le usa
  a sua volta operativamente, ma per un'altra domanda: fin dove far navigare
  la griglia). Sono qui perché le usano tutte e tre le
  superfici: il web per la sua griglia, il worker per sapere cosa ingerire,
  l'app mobile per fermare la navigazione fra i mesi esattamente ai bordi
  della finestra. Due numeri che DEVONO restare d'accordo scritti in due
  posti sono la divergenza che questo repo evita altrove (stesso
  ragionamento di `calendarAttendeeSchema`, dichiarata una volta sola per
  `packages/db` e `packages/google`).
  ⚠️ **I fusi orari del calendario sono decisi lì dentro e non si
  ridecidono**: un evento con orario si legge nel fuso LOCALE di chi guarda,
  uno «tutto il giorno» con i getter UTC (il worker lo fissa a mezzanotte
  UTC perché è una DATA, non un istante: leggerlo in locale lo farebbe
  scivolare al giorno prima per chi sta in un fuso negativo). Il
  ragionamento è scritto per esteso nel docblock del modulo e i suoi test
  girano con `TZ` su un fuso negativo apposta.

## Comandi (dalla radice)

- `pnpm test` — tutti i test (Vitest; server/worker/db usano testcontainers).
- `pnpm typecheck` — `tsc --noEmit` su tutti i package.
- `pnpm lint` — ESLint. **La CI fallisce su lint anche con typecheck+test verdi:
  lancialo SEMPRE prima del merge.**
- `pnpm build` — build di tutti i package.
- Per un singolo package: `pnpm --filter @stubwise/<nome> <script>`. **Per un
  build standalone** (senza aver già girato `pnpm -r build`): serve
  `pnpm --filter @stubwise/<nome>... build` (**con i tre puntini** — "il
  package e le sue dipendenze", le costruisce prima nell'ordine giusto), non
  `pnpm --filter @stubwise/<nome> build` da solo, che fallisce con `Cannot
  find module '@stubwise/db'`/`'@stubwise/shared'` se quei package non sono
  già buildati (i loro `dist/` sono gitignorati). Prima (fino all'11 set
  2026) `notifications`/`google`/`push-relay` avevano lo script `build`
  stesso che rifaceva questo lavoro con una `pnpm --filter ... build`
  **annidata** — tolta apposta: sotto `pnpm -r build`, che ordina già
  topologicamente, quella chiamata annidata ricostruiva `packages/db`/
  `packages/shared` una SECONDA volta, e due package annidati che la
  rifacevano insieme (`notifications` e `google`, entrambi con `db` fra le
  dipendenze) lanciavano due `tsc` concorrenti che scrivevano nella stessa
  `dist/` — la CI del workflow Release ne ha preso uno intermittente
  (`Module '@stubwise/db' has no exported member 'tickets'`, un `tsc` che
  leggeva `dist/index.d.ts` mentre l'altro lo stava ancora riscrivendo).
  `pnpm -r build`/`pnpm build` non ne risentono (l'ordinamento topologico
  del root basta da solo): il rischio esisteva solo nella chiamata annidata
  dentro lo script `build` dei tre package.
- I test E2E Playwright (`apps/web/e2e`) NON girano in `pnpm -r test` (solo in CI):
  eseguili a mano per modifiche UI rilevanti.

## Architettura runtime (docker-compose)

Servizi: `postgres` (pgvector/pgvector:pg17), `ollama` (embedding bge-m3,
1024-dim, via API OpenAI-compatibile), `server`, `worker`, `graphify`, `caddy`.
**Non esiste un servizio `web`.** Caddy fa da reverse proxy verso il server e
serve gli statici: SPA da `/srv/web` (root) e Starlight da `/srv/docs` (`/guide`).
Entrambi i bundle sono buildati dentro l'immagine caddy (`Dockerfile.caddy`).
`/docs` (non `/guide`) è la sezione Docs della SPA, sul fallback web.
Caddy serve anche `/widget.js` (bundle IIFE embeddabile da `/srv/widget`,
buildato in `Dockerfile.caddy`); `/widget/*` è la superficie API pubblica del
widget customer service, proxata al server.
`/monitor/ingest` e `/monitor/config` sono la superficie pubblica degli agenti
di monitoraggio (auth con chiave per-server `sk_…`), proxate al server; il resto
di `/monitor` è la sezione SPA. L'agente (`packages/agent`) gira SUGLI host
monitorati come container a sé (`Dockerfile.agent` → immagine `stubwise/agent`,
un singolo bundle esbuild), non nel compose di Stubwise.
`graphify` (`Dockerfile.graphify`) è il server MCP HTTP sui knowledge graph, solo
sulla rete interna (`http://graphify:8080/mcp`, nessuna porta né rotta Caddy). I
grafi stanno sul volume condiviso `graphs`, per repository in
`/graphs/<repositoryId>/graphify-out/`: li scrive il **worker** (rw, unico
produttore) col CLI graphify, `server` e `graphify` lo montano `:ro`. La build è
un job `build` della coda `graph_jobs`, accodato dal webhook push con debounce,
sotto il toggle per-repository `graphEnabled` (default off).
Il consumatore di `graphify` è il **server**: le chat interne (Docs repo e
progetto, `/docs` di Slack — il widget NO; la chat della voce di backlog non
esiste più dal 19 ott 2026) gli chiedono
via MCP il sottografo della domanda e allegano gli snippet di codice letti dai
mirror git, che il server monta `:ro` (`apps/server/src/graph-chat`, fail-open:
spegnibile con `GRAPHIFY_MCP_URL=` vuota).
I Docs generati, i daily report e le note di rilascio si aggiornano col **giro
notturno** del worker (`apps/worker/src/nightly/`, dal 16 ott 2026), non più a
ogni push: alle `NIGHTLY_START` (default `02:00`, ora di Roma) riassume ogni
commit nuovo una volta sola (`commit_summaries`, Haiku), accoda i daily report
del giorno UTC chiuso, poi per i progetti con «Docs aggiornati ogni notte»
(`projects.doc_auto_update`) scrive la nota di rilascio e aggiorna/crea le
pagine, a turno fra i repository, fermandosi alla quota e riprendendo dalla
coda `nightly_items`. Il webhook push accoda solo recount dei report e build
del grafo; `doc_auto_update_jobs` resta come tabella ma non ha più
consumatori. Un giro su un solo repository, a mano (rollout):
`docker compose exec worker node dist/nightly/once.js --repository <id>`.
Le regole stanno in `docs/invariants/nightly.md`.
`push-relay` (fase 4, servizio `push-relay` in `docker-compose.yml`,
`Dockerfile.push-relay`) è il relay HTTP (`POST /v1/send`) che tiene le chiavi
APNs/FCM legate all'identità di publisher dell'app mobile — una sola, sugli
store — e **gira solo sul nostro VPS**, sotto il profilo compose `relay`
(`docker compose --profile relay up -d`): senza quel flag il servizio non si
builda né si avvia, ed è così che resta fuori dalle istanze self-hosted. Il
worker gli parla via HTTPS (env `PUSH_RELAY_URL` sul worker: assente = il
relay pubblico che operiamo noi, di default `https://push.stubwise.aleloca.dev`
— `DEFAULT_PUSH_RELAY_URL` in `packages/notifications/src/push/config.ts` —,
stringa vuota = push spente, un URL = quel relay), mai per import diretto: le
istanze self-hosted non vedono le chiavi, solo i token dei propri device. Non
pubblica porte sull'host (ci arriva solo Caddy dalla rete interna, blocco
opzionale in `caddy.d/`, vedi `caddy.d/README.md`) e non monta volumi.

## Plugin e skill dell'agente (registro d'istanza)

Fase 3. Un **registro d'istanza** (`plugins`, permesso d'istanza `plugins.manage`, Impostazioni → Plugin)
tiene i plugin Claude Code che possono entrare nei run dell'agente: repo git
**pubblici https** (fetch senza credenziali per costruzione, protocolli in
allowlist, errori redatti) **pinnati a uno sha**. Il worker li materializza in
`/plugins/<slug>/<sha>/` sul volume `claude-plugins`, validando con `claude
plugin validate --strict` e **rifiutando gli alberi che contengono symlink**.
Quel volume lo monta **solo il worker**: il server legge l'inventario dal DB e
non ha bisogno dei file. Quella dir è già la dir del plugin anche quando c'è un
`sourceSubdir`. Poi gira uno **smoke run**
(`haiku`, 1 turno, `--setting-sources ""`, base + plugin integrale): `passed`
solo se tutte le skill dell'inventario compaiono col namespace atteso.
Coda `plugin_jobs` (kind `materialize` e `smoke`), poller `PLUGIN_POLL_SECONDS`.
Lo **slug** è validato `^[a-z0-9][a-z0-9-]{0,63}$` perché è un componente di
percorso sul volume.

- **⚠️ Registrare un plugin ne ESEGUE già il codice, prima di ogni
  abilitazione.** Lo smoke run parte da solo subito dopo la materializzazione,
  col plugin **integrale**, e gli hook di un plugin scattano in `-p` **senza
  approvazione**, coi permessi del worker — che monta i mirror dei repo e il
  volume `claude-config` con le credenziali del CLI. Un `SessionStart` ostile
  gira quindi al primo tick dopo la registrazione, **prima** che qualcuno abbia
  potuto leggere l'inventario. Il consenso informato è perciò sulla
  REGISTRAZIONE — si registra solo un repo e un commit di cui ci si fida — e
  l'ispezione di skill e hook serve a decidere **cosa abilitare**, non **se
  registrare**.
- **Plugin base `stubwise-base`** (`apps/worker/plugins/`, bundlato
  nell'immagine, fuori dal registro, mai filtrato): un hook `SessionStart` col
  **contratto della run** e la skill `stubwise-conventions`. Il contratto dice
  che worktree, branch, commit e PR li fa la pipeline, che le domande passano da
  `ask_user` e quali skill di terze parti qui non si applicano — ma **non impone
  la forma del deliverable**: lo stesso hook entra anche nei run di backlog,
  dove è il prompt a deciderla. Il matcher è `startup|resume|compact`, e
  `compact` non è di troppo: i run lunghi auto-compattano e il contratto va
  re-iniettato.
- **Abilitazioni per progetto** (Progetto → Plugin, permesso `project.settings.manage` nel progetto): per
  **sottrazione** (default tutto acceso), per singola skill e per gruppo di hook
  (`<Evento>#<indice>`). Il CLI non sa disabilitare una skill di plugin
  (`skillOverrides` ignora `source: "plugin"`), quindi ogni run riceve una
  **copia filtrata** della dir in una tmp fuori dalla cwd, più la deny rule
  `Skill(<plugin>:<skill>)`: la copia la toglie dall'elenco, la deny rule ne
  blocca l'esecuzione. Servono entrambe. Il preset consigliato per `superpowers`
  spegne le 4 skill che rifanno il lavoro della pipeline
  (`using-git-worktrees`, `finishing-a-development-branch`,
  `dispatching-parallel-agents`, `subagent-driven-development`) ed è chiavato sul
  **`name` del manifest**, non sullo slug.
- **Run col perimetro plugin**: fix (piano, ripresa del piano, esecuzione,
  self-repair) e turno di refinement del backlog. **Esclusi**:
  triage, intake/stima, docs, review PR, daily report, test credenziali.
  (Deep dive e chat di analisi del backlog, che c'erano, sono stati dismessi
  il 19 ott 2026: vedi «Backlog solo sessioni».)
- **INVARIANTE — il `.mcp.json` di un plugin non è mai caricato.** I server MCP
  di un run passano SOLO da `--mcp-config` + `--strict-mcp-config`; la copia
  filtrata omette quel file per costruzione (il CLI lo caricherebbe con
  `--plugin-dir`). Chi tocca la copia non lo reintroduca «per completezza».
- **`--setting-sources ""` va insieme ai plugin** (c'è solo quando c'è almeno un
  `--plugin-dir`): spegne plugin dell'utente, `.claude/` e `.mcp.json` intorno
  alla cwd, così l'insieme di skill e hook è deterministico. **Asimmetria da
  ricordare**: nei run di fix la cwd è SEMPRE la parent dir dei worktree (anche
  con un repo solo), quindi le `.claude/settings.json` dei repo target non erano
  mai state caricate e non cambia nulla. Lo stesso vale, dal 19 ott 2026, per
  l'unico run di backlog rimasto nel perimetro, il **turno di refinement**: la
  sua cwd è la parent dir della sessione (`refineParentDir`,
  `<tmp>/stubwise-refine/<agentSessionId>`, in
  `apps/worker/src/backlog/refine/worktrees.ts`), non la radice di un
  worktree. L'asimmetria valeva per **deep dive** e **chat di analisi** (cwd =
  radice del worktree, lì il flag le disattivava davvero), dismessi quel
  giorno: l'avviso della UI (`projects:plugins.settingSourcesWarning`) che la
  descriveva è da allora stantio.
- Tutto il percorso è **fail-open ma mai silenzioso**: un plugin non preparabile
  viene saltato per quel run con una riga nel log (log del job per il fix,
  logger per i job di backlog) e il run prosegue.
- **Scenari golden (manuali, mai in CI)**: `pnpm --filter @stubwise/worker
  golden -- --plugin <dir> --claude <path>` (`apps/worker/scripts/golden/`,
  README accanto) fa nove scenari veri col CLI su un repo fixture: `plan-only`
  (piano read-only), `ask-user` (bivio materiale: l'agente DEVE chiamare
  `ask_user`), `no-ask` (nessun bivio: NON deve chiedere), `execute`
  (esecuzione), `correction` (correzione su una PR), `intervene` (sessioni
  degli agenti: un messaggio a metà turno assorbito nello stesso turno, e
  «Ferma e scrivi» che dà un `result` `error_during_execution` e poi cambia
  direzione), `intervene-plan` (un intervento non sostituisce il piano:
  assorbito a metà turno il piano resta tale, arrivato dopo il primo
  `result` viene rifiutato), `stop-pause` («Ferma» senza testo), `refine`
  (turno di refinement del backlog: design e piano salvati coi tool, nessun
  file toccato, `Skill` invocabile) e `refine-read` (una lettura FUORI dalla
  cartella di lavoro è negata); opt-in, solo se nominato: `refine-read-bash`
  (un `cat` via Bash fuori dalla cartella è bloccato dal CLI: è la prova
  dell'invariante, va rilanciato quando si aggiorna il CLI). Lo scenario
  `refine-read-plan` (la plan mode della chat CODE e del deep dive, rosso
  noto) è stato tolto il 19 ott 2026 insieme a quei run. A parte, con la
  sua entry, il golden
  **`nightly`** (`pnpm --filter @stubwise/worker golden:nightly -- --claude
  <path>`): Postgres effimero con testcontainers dentro lo script (serve
  Docker), una notte vera del giro notturno su una fixture di 5 commit, e la
  prova che l'allowlist PER FILE delle pagine notturne nega un file del
  worktree non in elenco sul CLI pinnato — va lanciato al rollout del giro e
  quando si aggiorna il CLI. `ask-user` e `no-ask` sono
  probabilistici e si lanciano 5 volte ciascuno, `intervene`,
  `intervene-plan`, `refine` e `refine-read` 3 volte (vedi il README). Girano col runner di
  produzione, `StreamingClaudeRunner` (`--classic` per quello storico,
  `AGENT_STREAMING=false`), e col binario passato da `--claude`, che deve
  essere la versione pinnata in `apps/worker/Dockerfile`: il `claude` nel
  `PATH` di una macchina di sviluppo è quasi sempre più nuovo. Verifica che
  l'agente rispetti ancora il contratto (nessun commit/branch/worktree,
  sezione delle decisioni, report nella radice della working dir). **Lanciali
  quando aggiorni un plugin, un prompt, il CLI `claude` o il runner in
  streaming** (`apps/worker/src/agent/streaming-cli.ts`) o il turno di
  refinement (`apps/worker/src/backlog/refine/`): sono l'unica
  verifica che copre il comportamento del modello con i plugin caricati (la
  copia filtrata è già coperta dai test unitari).

## Deploy (prod)

Host: SSH `stubwise-vps`, checkout in `/opt/stubwise`. Deploy = `git pull` +
`docker compose up -d --build <servizio>`. Variabili in `/opt/stubwise/.env`.

- Modifica al **frontend** (`apps/web`, `apps/docs` o `packages/widget`) →
  ribuilda **`caddy`**.
- Modifica al **backend** → ribuilda `server` e/o `worker`.
- Modifica all'**agente di monitoraggio** (`packages/agent`) → l'immagine
  `alelocadev/stubwise-agent` su Docker Hub (multi-arch, così gli host la pullano
  senza clonare il repo) viene **ripubblicata dalla CI** (`agent-image.yml`) a
  ogni push su main che tocca `packages/agent`, `packages/shared`,
  `Dockerfile.agent` o il lockfile; tag `latest` + `sha-<commit>`. Pubblicazione
  manuale (fallback / `workflow_dispatch`): `docker buildx build --platform
  linux/amd64,linux/arm64 -f Dockerfile.agent -t alelocadev/stubwise-agent:latest
  --push .` (serve `docker login`). Gli host NON si auto-aggiornano: `docker pull`
  + ricrea il container. Se cambi anche il comando mostrato dalla UI
  (`apps/web/.../settings/servers.tsx`), ribuilda pure `caddy`.
- Modifica al **grafo** (`apps/worker/src/graph`) → ribuilda `worker`; a
  `Dockerfile.graphify` → ribuilda `graphify`; alla tab UI → `caddy`. Il pin
  `graphifyy==0.9.28` va tenuto ALLINEATO in 4 punti quando si aggiorna:
  `apps/worker/Dockerfile`, `Dockerfile.graphify`, `GRAPHIFY_VERSION` in
  `apps/worker/src/graph/setup-pr.ts` e il pin `uvx` del server MCP `graphify`
  in `.mcp.json`. NON è un quinto punto
  `.claude/skills/graphify/.graphify_version`: è il marcatore di versione della
  skill, riscritto da `graphify claude install`.
- **Versione del CLI `claude` nel worker — FISSATA** (2 ott 2026):
  `ARG CLAUDE_CODE_VERSION` in `apps/worker/Dockerfile` (oggi `2.1.287`, quella
  con cui sono passati tutti gli scenari golden). Prima era `npm install -g
  @anthropic-ai/claude-code` senza versione: la versione in produzione
  dipendeva dalla cache di Docker, e un rebuild senza cache avrebbe preso
  l'ultima uscita, mai provata. **Aggiornarla è una modifica esplicita**:
  cambia l'`ARG`, rilancia gli scenari golden in locale con la STESSA
  versione del CLI, poi rebuild del worker (senza job né generazioni Docs in
  corso). Un cambio di comportamento del CLI rompe i run in silenzio: è così
  che `ask_user` è rimasto bloccato dalla plan mode fino al 2 ott 2026.
- Modifica al **retrieval dal grafo nelle chat** (`apps/server/src/graph-chat`) →
  ribuilda `server`.
- **Voci per fase e per rilascio → `docs/operations/deploy-log.md`.** Ogni
  rilascio (fasi 0–9 e successivi) ha lì la sua voce: cosa ribuildare e in che
  ORDINE, migrazioni, env nuove, passi manuali post-deploy (backfill, resync
  webhook, scope dei token) e soprattutto il **rollback** (quali discese
  d'immagine sono sicure e quali no, e cosa ripulire prima). **Leggi la voce
  pertinente PRIMA di un deploy o di un rollback**: qui ne resta solo l'indice.
  Regole ricorrenti, valide salvo diversa indicazione nella voce: una
  migrazione che aggiunge colonne che il worker nomina vuole **prima il
  server** (healthy e migrazione applicata), poi worker e caddy; in un
  rollback il caddy scende **insieme** al server; un `notification_kind` nuovo
  rende NON sicuro scendere d'immagine sul server finché ne esistono righe
  (500 su `/api/inbox`); niente riavvii del worker con lavoro dell'agente in
  corso (vedi «Worker fail-on-restart»). Indice delle voci:
  - Fase 0 (inbox/notifiche)
  - Fase 1 (domande dell'agente, `ask_user`)
  - Fase 2 (pulse proattivo)
  - Fase 3 (registro plugin/skill)
  - Fase 4 (app mobile + notifiche push)
  - Fase 5 (roadmap, brief settimanale, registro decisioni)
  - Fase 6 (Gmail e Calendar)
  - Fase 6b (un'email, più progetti)
  - Fase 6c (ammissione della posta separata dall'attribuzione)
  - Fase 7 (workflow guidato web per non-tecnici)
  - Fase 7b (Posta e Calendario dentro la piattaforma)
  - Fase 8 (ambienti e coda di rilascio)
  - Fase 9 (Posta e Calendario che si guardano volentieri)
  - «La posta si legge per conversazione» (14 set 2026)
  - «Righe di ricerca per tipologia» (16 set 2026)
  - «Una keyword non scavalca il cancello» (17 set 2026)
  - «Spostare una proposta sul progetto giusto» (17 set 2026)
  - «Far vedere cosa ha generato una proposta» (18 set 2026)
  - «Far vedere ciò che è fermo» (21 set 2026)
  - «Hub di progetto, tappa 3: monitor e impostazioni» (23 set 2026)
  - «Le mail tenute fuori» (25 set 2026)
  - «Una mail, più azioni e più progetti» (26 set 2026)
  - «Una proposta decisa mostra la decisione» (27 set 2026)
  - «Dettaglio progetto v3, a tre tab» (28 set 2026)
  - «I progetti in ordine alfabetico» (28 set 2026)
  - «Correzioni post-PR: il ciclo review → correzione» (1 ott 2026)
  - «Revisore predefinito e scope di Validate» (1 ott 2026)
  - «I controlli del revisore: REST delle PR e scope del token» (1 ott 2026)
  - «La storia vera del ticket e le risposte ai commenti» (5 ott 2026)
  - «Modificare e cancellare i commenti» (5 ott 2026)
  - «Adozione delle PR aperte da altri» (6 ott 2026)
  - «Sessioni degli agenti dal vivo» (8 ott 2026, piano A: il backend)
  - «Sessioni degli agenti nell'app» (9 ott 2026, piano C)
  - «Sessioni di refinement del backlog» (14 ott 2026)
  - «Daily report su Haiku» (15 ott 2026)
  - «Quota degli account» (15 ott 2026)
  - «Giro notturno» (16 ott 2026, stesso rilascio della voce precedente)
  - «Backlog solo sessioni» (19 ott 2026)
  - «MCP per i collaboratori» (20 ott 2026)
  - «Aggiornamento automatico del plugin» (20 ott 2026)
  - «Rilascio senza PR di versioning» (20 ott 2026)
  - «Reset e cambio della password» (21 ott 2026)
  - «Modelli per operazione e consumi» (21 ott 2026)
  - «Ruoli e membri di progetto» (22 ott 2026)
  - «Secondo fattore sul login» (23 ott 2026)
- Verifica il bundle servito cercando una stringa nuova:
  `docker exec stubwise-caddy-1 sh -c 'grep -rl "<stringa>" /srv/web'`.
- Backup del DB prima di operazioni rischiose.

## Invarianti e trappole

Qui stanno le invarianti trasversali. Quelle di un'area stanno in
`docs/invariants/` (contenuto invariato, solo spostato): **prima di toccare
un'area, leggi il suo file** — l'elenco dei titoli sotto serve a capire se
una voce ti riguarda.

- **Sessioni degli agenti → `docs/invariants/agent-sessions.md`**:
  - Chi può scrivere, fermare o rispondere in una sessione lo decide il SERVER (9 ott 2026).
  - Sessioni degli agenti — le regole che reggono la vista dal vivo (8 ott 2026).
  - Le sessioni degli agenti nell'app: privacy, fuoco, confini (9 ott 2026, piano C).
- **Posta e calendario (Google) → `docs/invariants/mail-calendar.md`**:
  - L'audience `mailbox_owner` non include MAI gli admin.
  - Confermare una proposta chiede il permesso nel progetto; chi non ce l'ha la PASSA, e la card passata è una card NUOVA (22 ott 2026).
  - Passare al progetto: le regole di contorno e i limiti accettati (calendario escluso, veto di «Non fare nulla», proposta orfana).
  - La classificazione dei segnali email gira con la stessa dottrina dell'intake, non un'eccezione per la posta.
  - Il modulo che scrive nel registro decisioni non importa MAI un esecutore AI — vale anche per `google-proposal.ts`.
  - Il poller Google non usa il serializer di progetto.
  - UNA PROPOSTA PER RICHIESTA, NON PER MESSAGGIO
  - Il cancello dell'ammissione si allarga col THREAD, e il limite che lo rende accettabile è `admitted`.
  - La potatura della posta è legata al THREAD, e va in due passi.
  - Confermare una proposta non chiude le sorelle.
  - `choose_project` ha DUE semantiche diverse, sul padre e sui figli — mai unificarle.
  - Una serie ricorrente è spenta di default, e la sua azione automatica non avvia MAI lavoro.
  - Un appuntamento passato non diventa MAI una proposta (fase 9, fix di review).
  - Il corpo HTML di un'email: dove si conserva, e dove no.
  - Un appuntamento che hai RIFIUTATO non diventa mai una proposta, e i punti d'accordo sono TRE — non quattro (15 set 2026, design §1).
  - Lo stato normalizzato del calendario NON sa nulla del rifiuto, ed è deliberato (15 set 2026).
  - `cc_addresses` è NULLABLE mentre `to_addresses` non lo è, e non è un'incoerenza da uniformare (16 set 2026).
  - `to` e `cc` si MOSTRANO, non si cercano (16 set 2026).
  - La ricerca della posta non incrina `mailbox_owner`, e il test che lo verifica è NEGATIVO (15 set 2026, design §3).
  - La posta NON entra nella cronologia della ricerca, ed è una scelta di RETENZIONE prima che di enum (15 set 2026).
  - Una serie resta raggiungibile anche senza occorrenze nella finestra visibile (fase 9, fix di review).
- **Review, correzioni post-PR, revisore e adozione → `docs/invariants/pr-corrections.md`**:
  - Il ciclo di correzione non si innesca da sé, e la difesa è fail-closed (1 ott 2026).
  - Il revisore effettivo si risolve in UN posto (1 ott 2026).
  - Le review di Stubwise sono FIRMATE, e la firma esclude a prescindere dall'autore (1 ott 2026).
  - Validate chiede gli scope del RUOLO, e il ruolo lo calcola il server (1 ott 2026).
  - Una correzione non forza MAI il push.
  - Il contatore dei giri si DERIVA, non si salva.
  - Una correzione non è un piano nuovo, e per questo non passa dal gate.
  - Il budget di una correzione lo scavalca solo chi ha `plans.approve`, e il client non lo deduce (1 ott 2026).
  - Job e correzione si chiudono INSIEME.
  - Un lavoro per ticket, richieste in fila per PR — e una `pending` ha sempre un punto di promozione.
  - Il rilancio generico non tocca una correzione ferma (1 ott 2026).
  - La review «in attesa» esiste dal claim, e si riaccoda all'avvio perché il worker è UN processo.
  - Una sola regola di correggibilità
  - Adottare una PR aperta da altri (6 ott 2026) — chi, quale, dove.
  - Il webhook «Request changes» non legge i commenti della PR, e scarta le riconsegne.
  - Staleness: la correzione non sposta `WORKER_STALE_MINUTES`, ma ha DUE heartbeat.
- **Sessioni di refinement del backlog → `docs/invariants/backlog-refine.md`**:
  - Le regole a turni del relay valgono SOLO per `TURN_BASED_SESSION_KINDS`, e nel refinement scrive chi ha `backlog.edit`.
  - Un messaggio di una sessione a turni non diventa MAI `undelivered` per tempismo.
  - Sola lettura per COSTRUZIONE.
  - Il server MCP dei tool non vede DB né credenziali.
  - Le regole di scrittura di design, piano e metadati stanno in `backlog-item-writes.ts`.
  - Ordine dei lock: prima la voce, poi la sessione, in OGNI percorso.
  - Una voce chiusa chiude la sessione con `item_closed`, anche se era già chiusa.
  - Un piano scritto in una sessione di refinement NON è approvato.
  - `agent_sessions.backlog_item_id` non vuol dire più «chat della voce»
    (dal 19 ott 2026 la chat non esiste più: kind `backlog_item` = sessioni
    di stima e di merge dell'intake, non interattive).
  - Lo scheduler esiste solo col runner in streaming.
  - Limiti noti, accettati (costo fuori dal budget, retention).
- **Permessi, ruoli e membri di progetto → `docs/invariants/permissions.md`** (22 ott 2026):
  - Ogni rotta dichiara `config.access`, anche le pubbliche (test del registro).
  - Un progetto invisibile risponde 404 `not_found`, come uno che non esiste.
  - Gli elenchi filtrano nella WHERE, prima di paginazione e conteggi.
  - Il client legge i permessi calcolati dal server, non li deduce.
  - Nessuna escalation, e il bersaglio è protetto (`escalation`, `target_above`).
  - Resta sempre un full admin; i preset Admin e User non si eliminano finché esiste `users.role`.
  - La revoca si applica a lettura, senza riscrivere righe.
  - I full admin sono membri impliciti di ogni progetto.
  - `users.role` è DERIVATA (trigger), e la sua rimozione è un rilascio successivo.
- **Secondo fattore sul login → `docs/invariants/second-factor.md`** (23 ott 2026):
  - Una sessione parziale apre SOLO le rotte `second_factor` (test del registro).
  - Ogni porta che dà una sessione o un token passa dal secondo fattore (`/login`, `/mobile-login`).
  - Ogni verifica di un codice o di una passkey passa da `attemptSecondFactor`.
  - La riconferma si DICHIARA (`config.reauth`, test del registro), un PAT non la soddisfa mai.
  - Il segreto TOTP è cifrato, i codici sono hash, niente in log/elenchi/notifiche.
  - Il tetto per account non tocca sessioni e token aperti.
  - `security.alert` ignora le preferenze e va solo all'interessato.
  - Admin che azzera un pari grado: accettato, registrato e avvisato (decisione del 23 ott 2026).
- **Account e provider dell'agente → `docs/invariants/providers.md`**:
  - La scelta dell'account sta in `providers/select.ts`, e la ripresa usa la stessa funzione (15 ott 2026).
- **Giro notturno → `docs/invariants/nightly.md`**:
  - Il webhook push NON accoda lavoro Docs.
  - Un commit si riassume UNA volta.
  - La regola del rumore è una lista DICHIARATA.
  - Il segnalibro dei Docs NON dipende dalla nota di rilascio, e avanza con `documented_at` nella stessa transazione.
  - La nota di rilascio ha il SUO punto di partenza.
  - Una pagina in escalation TIENE l'avviso (`doc_page_pending_commits`).
  - Nessun tetto al numero di pagine; il freno è la quota.
  - Mirror e worktree solo DENTRO il serializer per-progetto.
  - La lettura di una pagina è un'allowlist CHIUSA per file.
  - La quota ferma il giro, la configurazione salta il progetto.
  - Tutto lo stato del giro sta nella coda.
- **App mobile (UI e test) → `docs/invariants/mobile-app.md`**:
  - Nell'app la ricerca è un'AZIONE, non una destinazione — e i repository non ci sono (15 set 2026, design §3).
  - La pagina del ticket nell'app è a quattro tab
  - Un foglio nativo che porta a un'altra schermata: chiudere, smontare, POI navigare (5 ott 2026, verificato sul telefono).
  - ⚠️ Nei test dell'app `render` di `@testing-library/react-native` si ASPETTA

- **I due divieti dell'operatore (fase 7, riscritti sui permessi il 22 ott
  2026) — invarianti, nessuna apertura li tocca.** Chi non ha `plans.approve`
  nel progetto non può approvare un piano da sé, e chi non ha `release.merge`
  non può mandare nulla in produzione. Erano scritti sul ruolo `member`; dalla
  fase permessi (`docs/invariants/permissions.md`) il ruolo non decide più
  niente, decide il PERMESSO nel progetto del ticket, calcolato dal server
  (`projectPermissionsFor` in `apps/server/src/auth/access.ts`). Un full admin
  li ha entrambi su ogni progetto; il preset `Legacy Member` (i member di
  prima) e `Developer` non hanno nessuno dei due.
  1. *Approvazione del piano*: il gate è UNA riga in
     `apps/server/src/services/jobs.ts` — `needsApproval =
     (!actor.permissions.has("plans.approve") && !planPreApproved) ||
     input.requirePlanApproval === true` — e le tre funzioni che decidono su
     un piano (`resolvePlan`, `preApprovePlan`, `revokePlanApproval`, stesso
     file) iniziano tutte con `if (!actor.permissions.has("plans.approve"))
     return { ok: false, error: "forbidden" }`, ridondante con il
     `config.access` (`plans.approve`) delle loro rotte: difesa in
     profondità. La pre-approvazione NON è un'eccezione: allarga COSA si può
     approvare in anticipo, mai CHI approva. Verificato **negativamente**
     (`jobs.test.ts`, `tickets.test.ts` — approve, reject, pre-approve,
     revoke, ciascuno con un `Legacy Member` E un `Developer`): 403/`forbidden`
     E stato in colonna invariato, non solo il codice di risposta. Il gate
     segue il permesso, non il ruolo: un Developer (che ha `runs.start`) passa
     dal gate come un Legacy Member.
  2. *Rilascio in produzione*: la sola capacità è il merge esplicito di una
     PR già aperta (`POST /api/tickets/:id/repositories/:repositoryId/release`,
     `releasePullRequest` in `apps/server/src/services/release.ts`):
     `config.access` con `release.merge` sulla rotta **e** `if
     (!actor.permissions.has("release.merge")) return { ok: false, error:
     "forbidden" }` ridondante dentro il servizio. Verificato
     **negativamente** (`release.test.ts`, Legacy Member e Developer): 403
     **e** nessun merge parte. La coda `/api/release-queue` mostra solo i
     progetti in cui chi guarda ha `release.merge`. Resta vero il confine di
     prodotto: **l'unica azione è il merge di una PR già aperta**, mai un
     deploy, mai un'esecuzione di ambiente (vedi l'invariante dedicata più
     sotto). Chi aggiunge un'integrazione che esegue un DEPLOY rompe questa
     frase, non solo il codice: è un cambio di prodotto.
     **Il divieto vale anche IN LETTURA**: il polso non dice a chi non può
     mergiare che una PR aspetta LUI. `waitingForMerge[].canMerge`
     (`packages/notifications/src/project-pulse-summary.ts`) lo calcola il
     SERVER da `release.merge` nel progetto del viewer, e il client lo LEGGE,
     non lo deduce: la copia della regola starebbe dalla parte che non
     possiamo aggiornare (l'app). Verificato con un test a DUE ruoli sugli
     stessi dati (`project-pulse-summary.test.ts`, «stessi dati, due ruoli:
     `canMerge` è vero per il Project Lead e falso per il Developer»).
- **I campi che un client legge su una card di inbox si DERIVANO A LETTURA,
  non si scrivono nell'evento (18 set 2026).** `notifications.event` è un
  jsonb **persistito al momento della publish**: un campo aggiunto lì ce
  l'hanno solo le card pubblicate DOPO, e quelle già in inbox restano senza
  **per sempre** — non c'è nessun processo che le riscriva.
  **Non è teoria: è successo il 17 settembre.** `reassign_project` («Sposta su
  un altro progetto») è stata aggiunta alle azioni che il worker scrive
  nell'evento, quindi la scelta compariva solo sulle card nuove. Ce ne siamo
  accorti quando il maintainer ha aperto una card più vecchia e il bottone non
  c'era, e la riparazione è stata riscrivere **a mano il contenuto di 8
  notifiche in produzione**.
  **La forma giusta** è quella di `InboxGoogle.sourceProposalId`
  (`packages/shared/src/schemas/notification.ts`): il campo non viene mai
  scritto nel jsonb: `readGoogle` (`apps/server/src/services/inbox.ts`) lo
  risolve dal DATABASE — la riga `email_proposals` che possiede la notifica —
  e lo SOVRASCRIVE su quello che il payload dicesse. Vale per tutte le card,
  vecchie e nuove, senza toccare una riga di dati. Il batch loader
  (`sourceProposalIdsByNotification`) fa UNA query per pagina, non una per
  card, come `usersById` accanto.
  **Il corollario che vale la pena conoscere**: la derivazione non solo
  raggiunge le card vecchie, **scavalca anche un jsonb sbagliato**.
  `proposalId` nell'evento dovrebbe già essere `email_proposals.id`, ma lo è
  solo dalle card successive al fix di App M3 Fase C — prima `assembleEvent`
  ci scriveva un `randomUUID()` che non apre nessun dettaglio. Un campo
  derivato non eredita quel difetto.
  **Quando invece scrivere nell'evento è giusto**: per ciò che è vero SOLO al
  momento della publish e non è più ricostruibile dopo (il testo della
  domanda, le opzioni con le loro conseguenze, `auto` di una serie). La
  domanda da farsi non è «è comodo averlo nel payload» ma «se lo derivassi
  ora, otterrei la stessa risposta?»: se sì, va derivato. C'è un test che
  fissa proprio il caso vecchio — `apps/server/src/services/inbox.test.ts`,
  «CARD VECCHIA: un evento senza campi nuovi produce comunque l'id», che
  asserisce anche che il valore derivato **non coincide** con quello del
  jsonb (senza quella seconda asserzione il test passerebbe anche leggendo
  dall'evento).
- **Verso l'app mobile, solo cambi ADDITIVI — alle risposte E alle
  richieste.** L'app si aggiorna dagli store, non dai nostri deploy: per
  settimane un server nuovo parla a client vecchi. Aggiungere un campo è
  sicuro (il client vecchio lo scarta); aggiungere un valore a un enum è
  sicuro **solo perché** gli schemi dei client passano da `readerSchema`
  (`packages/shared/src/reader.ts`), che li apre e riporta l'ignoto come
  `UNKNOWN`. **Rimuovere o rinominare un campo NON è sicuro e nessun
  meccanismo lo copre**: il parse dell'intera risposta fallisce, e sulla
  lista d'inbox significa schermata principale vuota su ogni telefono finché
  l'utente non aggiorna. Un rename «tanto è solo un rename» su una rotta che
  il mobile legge è un incidente di produzione che non possiamo ritirare.

  **Vale anche nel verso opposto**: l'app *manda* richieste, quindi rendere
  OBBLIGATORIO un campo nuovo in un body rompe le app vecchie esattamente
  come rimuovere un campo da una risposta. È già successo in fase 4:
  aggiungere `push` a `notificationPrefsSchema` ha reso
  `PUT /api/me/notification-prefs` non soddisfacibile da un client che non lo
  conosce. La forma giusta per un body che cresce nel tempo è la **patch**:
  campi opzionali, gli assenti restano invariati (è la ragione per cui quella
  rotta è un `PATCH` e non un `PUT`, vedi il docblock in
  `apps/server/src/routes/me-prefs.ts`).

  **Regola operativa che ne discende, senza eccezioni**: ogni campo NUOVO in
  uno schema di risposta che l'app legge nasce `.default()`, `.optional()` o
  `.nullable()` — mai obbligatorio — e arriva con un test che parsa una
  risposta **senza** quel campo. Il motivo è che la simmetria non è ovvia:
  «aggiungere un campo è sicuro» vale per il client vecchio che riceve un
  campo IN PIÙ, non per il client nuovo che riceve un campo in MENO da un
  server più vecchio — un rollback, o un'istanza self-hosted non aggiornata,
  e l'app è UNA per tutte. `readerSchema` non copre questo caso: apre gli
  enum, non i campi mancanti. È già stato colto due volte in review
  (`notificationPrefsViewSchema.push` in fase 4, `weeklyBriefEnabled` in fase
  5, `packages/shared/src/schemas/project.ts` — il test è
  `project.test.ts` accanto), e `readerSchema` attraversa i `.default()`
  apposta perché usare la forma giusta non costi la chiusura degli enum
  sottostanti.

  ⚠️ **E quella regola NON protegge il web, che è il caso in cui morde più
  forte.** `apps/web/src/lib/api.ts` non passa uno schema di risposta al
  client: fa un **cast**, per scelta dichiarata nel docblock del file
  (accendere `parse` su ~40 rotte trasformerebbe ogni divergenza latente in
  un'eccezione in faccia a un utente). Quindi sul web il `.default()` **non
  gira mai**: un campo che il server non manda non diventa `[]` o `false`,
  resta `undefined`. L'app, che parsa davvero via `packages/api-client`
  (`readerSchema(schema).parse`), è coperta; la SPA no.
  **E il modo in cui si rompe non è un campo degradato**: un `undefined` dove
  il codice chiama `.map()` fa lanciare il render, e React smonta l'intero
  sottoalbero — nel caso che l'ha fatto scoprire (App «posta per
  conversazione», 14 set 2026) spariva il pannello di lettura INTERO, non una
  riga. E i test della SPA non lo scoprono da soli: usano mock, e un mock
  scritto insieme al campo ce l'ha sempre.
  **Regola operativa**: un campo nuovo che il WEB legge va difeso nel punto
  di lettura (`?? []`, `?? false`), non solo nello schema; e la fixture del
  test che lo copre va lasciata SENZA quel campo apposta — è la prova che la
  difesa c'è, non una svista da sistemare.

  ⚠️ **E l'app ha il GEMELLO di questa trappola, per una causa diversa — nei
  TEST (21 set 2026).** In produzione l'app è coperta: parsa davvero, quindi
  i `.default()` girano. **Nei test no**: il client è un doppio
  (`makeClient()` con dei `jest.fn()`), quindi `readerSchema` non gira mai e
  una fixture incompleta arriva al componente **così com'è**. E siccome il
  codice dell'app può legittimamente fidarsi del parse — `message.reproposals`
  senza `?? []`, perché in produzione c'è sempre — una fixture a cui manca un
  campo non degrada: **fa saltare l'intera schermata**. Successo davvero
  aggiungendo `proposalOutcomes`: una sola fixture dimenticata in
  `ThreadDetailScreen.test.tsx` ha fatto fallire TUTTI i test di quel file,
  compresi quelli che con il campo nuovo non c'entravano niente — e il
  messaggio di errore parlava di un `testID` non trovato, non del campo
  mancante.
  **Regola operativa**: aggiungendo un campo a una risposta che l'app legge,
  **completa OGNI fixture dei test dell'app** (il compilatore ne trova molte,
  ma non quelle dietro un `as`), e quando i test di una schermata falliscono
  tutti insieme dopo un cambio di schema, il primo sospetto è una fixture
  incompleta — non il componente.
  Le due trappole non si deducono una dall'altra: sul web manca il parse **in
  produzione**, sull'app manca **solo nei test**. La difesa è diversa —
  `?? []` nel codice del web, fixture complete nei test dell'app — e
  applicare quella sbagliata non protegge da niente.
- **E c'è una TERZA trappola nella stessa famiglia, che non fa fallire niente
  affatto: il DOPPIO del client nei test dell'app (21 set 2026).** Le due qui
  sopra riguardano un campo che manca; questa riguarda un METODO che manca, e
  si comporta in modo peggiore — non rompe la schermata, la lascia intatta.
  `makeClient()` nei test delle schermate è un `as unknown as StubwiseClient`
  (`apps/mobile/src/screens/work/WorkScreen.test.tsx` e i suoi gemelli): il
  cast **afferma** che l'oggetto sia il client intero, quindi il compilatore
  non dice nulla se un metodo non c'è. La query che lo chiama fallisce a
  runtime, e se quella lettura sta fuori dai gate `isPending`/`isError` — come
  ci stanno per costruzione tutte le letture ACCESSORIE, apposta perché un
  loro guasto non costi la schermata — allora **il test passa**, e passa senza
  aver esercitato niente di ciò che diceva di provare.
  Successo davvero aggiungendo `tickets.comments`, `users.list` e
  `projects.milestones` a `WorkScreen`: 24 test verdi con tre query che in
  ogni singolo caso fallivano.
  **Regola operativa**: quando una schermata guadagna una chiamata nuova,
  **aggiungi il metodo al doppio prima di scrivere il test che lo usa**, e
  tratta un doppio parziale come codice da completare, non come una
  scorciatoia che il cast rende lecita. Il segnale d'allarme è l'assenza di
  segnale: un test che passa al primo colpo su una lettura appena aggiunta
  merita di essere fatto fallire apposta (togli il `mockResolvedValue`) prima
  di crederci.
  La differenza con le due qui sopra, e il motivo per cui non si deduce da
  loro: **una fixture incompleta fa saltare la schermata, un doppio incompleto
  no** — un cast che finge un'interfaccia intera è peggio di una fixture
  incompleta, perché non fallisce affatto.
- **Un campo nuovo non si "aggiunge": si aggiunge E si va a cercare chi
  diceva qualcosa che ora è INCOMPLETO (21 set 2026).** È la domanda da farsi
  ogni volta che un campo nuovo cambia il SIGNIFICATO di qualcosa che una
  schermata già mostrava: l'elenco dei posti da toccare non è «dove metto il
  nuovo», è «chi parlava di questa cosa prima, e adesso mente».
  **Due casi misurati, e non si deducono l'uno dall'altro.** (1)
  `searchSnippetSegments` (`packages/shared/src/search-snippet.ts`): la regola
  viveva solo nel web e all'app mancava del tutto — il classico «una
  superficie sola». (2) Il quarto secchio del polso: la regola è stata messa
  in DUE posti (il blocco «Fermo» c'è sia su web sia su app) ma la RIGA DI
  SINTESI accanto è stata aggiornata su una superficie sola. Risultato: nel
  dettaglio dell'app un progetto con zero job vivi e otto ticket fermi diceva
  «tutto tranquillo» **esattamente sopra l'elenco degli otto**, e sulla lista
  progetti non diceva niente affatto — cioè il buco che quel batch esisteva
  per chiudere, lasciato aperto proprio sulla schermata da cui si parte. Il
  secondo caso è più insidioso del primo: il pezzo nuovo era su entrambe le
  superfici, quindi «l'ho fatto da tutt'e due le parti» sembrava vero.
  **Regola operativa**: aggiunto un campo, cerca i suoi CONSUMATORI
  (`grep` sul nome del tipo di risposta, non solo sul campo) e per ognuno
  chiediti se quello che mostra è ancora completo. Nel caso del polso erano
  tre oltre al blocco nuovo — la riga di sintesi (due gemelli:
  `apps/{web,mobile}/src/lib/pulse-line.ts`), i conteggi
  (`CountsLine`/`PulseRow`, più l'intestazione di `ProjectsScreen`) e
  **l'ORDINAMENTO** (`pulseOrder` in `apps/server/src/routes/projects.ts`):
  anche un ordine afferma una priorità, e lasciarlo indietro l'avrebbe reso
  una terza verità diversa dalle altre due.
  ⚠️ **Dal 28 set 2026 l'ordine afferma MENO di prima, per scelta del
  maintainer**: `pulseOrder` è `[needsViewer ? 0 : 1, nome]`. La posizione
  dice solo «aspetta te sì o no», poi è alfabetica; tutto il resto lo dice
  la riga sotto il nome. Il confine è `needsViewer` di `@stubwise/shared`,
  la stessa funzione che i client usano per le intestazioni «Needs you» e
  «All projects»: chi cambia cosa conta come «aspetta te» lo cambia lì.
  ⚠️ **E una riga aggiunta a una fixture non è copertura.** Completare le
  fixture perché il compilatore smetta di lamentarsi (`stalled: []`,
  `waitingForMerge: []`) è compatibilità di TIPO: il test che avrebbe fermato
  il difetto è quello con lo scenario «SOLO i campi nuovi popolati», che
  nessuna fixture completata a zero produce mai. Chi aggiunge un campo
  aggiunga anche quel caso, su ogni superficie.
- **Trappola di routing Fastify — rotta parametrica registrata prima di una
  letterale sullo stesso prefisso.** `GET /api/projects/pulse` e
  `GET /api/projects/:projectId` condividono il prefisso `/api/projects`:
  se `:projectId` venisse registrata PRIMA di `/pulse`, "pulse" verrebbe
  letto come un `projectId` e fallirebbe la validazione UUID invece di
  colpire la rotta giusta. Oggi è già gestito correttamente — `/pulse` è
  registrata prima, con un commento esplicito in
  `apps/server/src/routes/projects.ts` — ma è una trappola da NON
  reintrodurre: qualunque nuova rotta letterale su un prefisso che ha già
  una `:id` va registrata PRIMA di quella parametrica. La fase 5 ha
  moltiplicato le occasioni di sbagliare: sotto `/api/projects` convivono
  ora `/pulse` (letterale nudo, il caso pericoloso davvero) e i suffissi
  `/:projectId/reviews`, `/:projectId/timeline`, `/:projectId/briefs`,
  `/:projectId/decisions`. **Regola operativa, senza distinguere i due
  casi: ogni rotta con una parte letterale va registrata PRIMA di `GET
  /:projectId`** — è la convenzione già seguita dal file, con un commento su
  ognuna, e tenerla uniforme costa nulla mentre ragionare caso per caso su
  quale segmento è ambiguo è come si reintroduce il bug.
- **Migrazioni Drizzle — il batch gira in UNA transazione.** Il migratore
  esegue tutte le migrazioni pendenti dentro una sola transazione, e Postgres
  **non permette di usare un valore di enum nella stessa transazione in cui
  è stato aggiunto**. Quindi un `ALTER TYPE ... ADD VALUE` va in uno
  **statement a sé** e il valore non può essere usato (insert, default,
  confronto) né lì né in una migrazione successiva dello stesso batch: il
  seed che ne ha bisogno va fatto **dopo**, in `runMigrations`. È il motivo
  per cui la 0068 aggiunge `project.brief` da sola e non lo tocca più.
- **Il registro decisioni non è MAI scritto dall'AI.** `project_decisions`
  raccoglie *fatti* — la risposta a una domanda dell'agente, un piano
  approvato o rifiutato con indicazioni, una proposta del pulse accettata,
  una voce registrata a mano — e ogni testo automatico viene da un
  **template i18n**, mai da un run del modello. La distinzione è la spina
  dorsale della fase 5: il brief e i riassunti "in breve" sono **narrativa**
  (generata, rigenerabile, sbagliabile), il registro è **fatto** (deve poter
  essere citato senza riverificarlo) — e il brief regge proprio perché il
  registro su cui si appoggia non è a sua volta prosa generata.
  `apps/server/src/services/decisions-never-ai.test.ts` la verifica su **due
  piani**, perché nessuno dei due basta da solo: **a runtime** (l'SDK
  Anthropic, unica superficie AI raggiungibile dal server, è mockato con
  delle spie mentre i writer automatici girano davvero contro un Postgres
  vero: le spie devono restare a zero) e **sul sorgente** (i moduli del
  percorso non nominano alcun esecutore di agenti — copre il caso che un
  domani `runAgentText` diventasse importabile da qui). Chi aggiunge
  un'origine nuova al registro la scriva con un template, non con un prompt;
  chi ci aggiunge "un riassunto migliore" fa fallire quel test, ed è il
  punto: la riga da cambiare non è il test, è la scelta.
- **`plan_summary` vive e muore con `plan_text`.** Il riassunto del piano si
  genera **prima** del parcheggio e si scrive nello **stesso UPDATE guardato**
  che salva il piano e porta il job in `awaiting_plan_approval`; il rifiuto
  del piano li azzera **insieme**. Non esiste — e non va introdotto — un
  poller che rilegge i job in `awaiting_plan_approval` per riassumerli dopo:
  competerebbe sul serializer per-progetto, e aprirebbe la finestra in cui un
  piano è visibile senza il suo riassunto (o, peggio, con il riassunto di una
  versione precedente). Stessa forma per `pr_summary`, scritto nella
  transazione della review. Chi tocca `parkForPlanApproval` o la scrittura
  della review tenga il riassunto dentro quella transazione.
- **Worker fail-on-restart:** un riavvio del worker fallisce le generazioni Docs
  in corso (lavoro perso). Riavvia il worker solo quando NON ci sono generazioni
  attive: `select id from doc_generations where status in ('running','paused');`
  deve essere vuoto. Le `paused` contano: una pausa per limite del provider è
  comunque una generazione viva (worktree registrato in-memoria) e può restarci
  per ore — o, se la causa è la soglia settimanale dello sfondo (reason «soglia
  del limite settimanale…»), fino al reset settimanale: come riconoscerla e
  farla fallire a mano sta nella voce «Quota degli account» di
  `docs/operations/deploy-log.md`. La fase **product** allunga la finestra di finalize (decine di run): un
  crash del worker DENTRO product/finalize lascia la generazione `running` per
  sempre (nessun nodo claimabile) → recovery manuale: `update doc_generations set
  status='failed', error='worker crash during finalize' where id=...`.
  Il **giro notturno** invece non perde lavoro a un riavvio (riprende dalla
  coda), ma un elemento reclamato da un worker morto resta bloccato fino a
  60′ (la lease): evita di riavviare a giro in corso — la query degli
  elementi reclamati è nel controllo d'inattività della voce «Giro notturno»
  di `docs/operations/deploy-log.md`.
- **Concorrenza:** `WORKER_CONCURRENCY` (default 2) e `DATABASE_POOL_MAX` (default
  10, alzalo in proporzione) sono env. In prod attuale: 5 e 20.
- **`WORKER_STALE_MINUTES`** va tenuto coerente in 3 punti (config.ts, compose,
  invariante verificata in index.ts) quando si allunga il tempo max di un fix.
- **Testcontainers:** `pnpm -r test` è flaky con troppi Postgres concorrenti →
  `maxForks` limitato nelle vitest.config di server/worker/db. Image pgvector
  (Debian) inizializzata con `--locale=C` per collation deterministica.
- **Install nel worktree del fix:** install/test del repo target NON con
  `NODE_ENV=production` (ometterebbe le devDeps → exit 127).
- **File `.env` per progetto:** cifrati, materializzati nel worktree prima di
  install/test; il safeguard anti-leak è l'esclusione da TUTTI i `git add`/`status`.
- **Lockfile creati dall'install: mai nel commit (8 ott 2026).** L'install nel
  worktree scrive un lockfile quando il repository non lo ha (in produzione
  una correzione su un repo senza lockfile ha committato il `package-lock.json`
  di `npm install`). Regola in UN posto, `stagePathspecs` →
  `untrackedLockfilePathspecs` (`apps/worker/src/pipeline/repo-steps.ts`),
  la stessa esclusione dei file d'ambiente e del report, quindi vale per fix
  e correzioni: un lockfile NON TRACCIATO (`package-lock.json`,
  `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`,
  `bun.lockb`, a ogni profondità) è escluso da ogni `git add`/`status`; uno
  già tracciato si committa come ogni file, anche modificato. Si esclude dal
  commit invece di cambiare il comando di install perché vale per ogni
  package manager e per un `npm install` lanciato dall'agente.
- **Il pulse tace se c'è una decisione umana pendente:** un progetto non è
  "fermo" solo perché nessun job gira. Il poller del pulse
  (`apps/worker/src/pulse/signals.ts`) resta zitto se c'è un job AI in volo **o
  parcheggiato in `held`** (limite/budget/gate dell'automazione), una domanda
  `ask_user` aperta, una PR aperta, un job di backlog attivo o una sessione di
  analisi in corso. Il motivo non è il carico: per ognuna di quelle situazioni
  la notifica esiste già in inbox, e proporre lavoro nuovo mentre quello
  esistente è bloccato è la spinta sbagliata. `held` in particolare **non** è in
  `IN_FLIGHT_JOB_STATUSES` (quella lista risponde a un'altra domanda), quindi è
  un controllo a sé: chi tocca i segnali non lo tolga per "semplificare".
- **Plugin — TOCTOU sulla potatura dello sha vecchio:** appena un plugin passa a
  `ready` il poller **rimuove subito** dallo slug ogni dir che non sia lo sha
  corrente. Un run che ha letto la riga del registro **prima** dell'UPDATE e sta
  copiando la dir vecchia può quindi prendere un `ENOENT` a metà copia. È una
  **scelta**, non una svista: il degrado è fail-open e documentato — quel plugin
  viene saltato **per quel run**, con una riga nel log, e il run prosegue. Chi
  tocca `pruneShaDirs`/`publishPluginDir` (`apps/worker/src/plugins/poller.ts`)
  sappia che l'alternativa (tenere gli sha vecchi) è un volume che cresce, e che
  la finestra è larga quanto una copia di poche centinaia di KB.
- **Plugin — il recovery degli orfani non è transazionale:**
  `recoverStalePluginJobs` fa prima l'UPDATE dei job stantii a `failed`, poi in
  un secondo giro `markPluginFailure` sul plugin. Un crash del worker **in
  mezzo** lascia un plugin in `materializing` **per sempre**: nessun job attivo
  lo sbloccherà, e nessun poller rimette a posto lo stato del plugin. Stessa
  famiglia della trappola di `doc_generations` qui sopra. Recovery manuale:
  riaccodare la materializzazione dalla UI ("Aggiorna a ref…" con lo stesso ref
  — l'indice unico parziale è sui soli job vivi, e quello vecchio è già
  `failed`, quindi il job nuovo passa) oppure `update plugins set
  status='failed', error='worker crash during recovery' where id=...`.
- **Plugin — limite noto v1: una sola persona per volta sulla sezione Plugin
  del progetto.** Il `PUT /api/projects/:id/plugins` sostituisce l'**insieme
  completo** delle abilitazioni **senza precondizione di versione**: se chi ha
  `project.settings.manage` spegne una skill e un altro — con la pagina aperta da prima — tocca una
  qualunque casella e salva, la skill torna accesa **in silenzio**. Accettato per
  la v1 (voce di backlog aperta). La UI ricarica e avvisa solo quando cambia
  l'*inventario* o il *registro*, non quando cambia la selezione altrui.
- **Mutation testing in questo monorepo — due trappole di metodo, emerse al
  Task 9 della fase 4, valide per chiunque ne faccia.** (a) Quando la
  mutazione è in un package **diverso** da quello dei test, un `dist/`
  stantio la nasconde: i test leggono `dist`, non i sorgenti, quindi la
  mutazione sembra «non catturata» mentre in realtà lo sarebbe (successo
  reale: togliere un titolo da `packages/i18n/src` lasciava verdi i test di
  `packages/notifications` finché non si rifaceva `pnpm --filter
  @stubwise/i18n build`). Innocuo in CI (`ci.yml` builda prima di testare),
  ma in locale porta alla conclusione opposta a quella vera. **Regola:
  ribuilda prima di eseguire, dopo ogni mutazione cross-package.** (b) Una
  mutazione che **crasha** non prova niente: se il test resta verde solo
  perché un `expect(...).toThrow()` intercetta un'eccezione diversa da
  quella attesa, la logica cambiata non è mai stata davvero esercitata.
  Successo reale: mutando un controllo in `KNOWN.has(status as string)`, un
  input numerico arrivava fino a `status.slice(...)` e **lanciava** — la
  `parse` falliva comunque e il test passava per il motivo sbagliato.
  **Regola: una mutazione deve produrre codice che GIRA e dà l'esito
  sbagliato, non codice che esplode** — prima di concludere «il test non
  discrimina» su una mutazione rimasta verde, verifica che non stia
  fallendo per conto suo.
  (c) **Il gemello, emerso il 18 set 2026: un test deve riprodurre la
  CONDIZIONE del difetto, non solo attraversare il codice che lo contiene.**
  Un test scritto per un difetto già MISURATO in produzione passava — e non
  perché il codice fosse corretto: l'helper `eventFor`
  (`apps/worker/src/google/proposal.test.ts`) genera un `proposalId`
  **casuale** quando non gliene si passa uno, mentre il poller vero ci mette
  l'id della riga. Le due notifiche del test non erano quindi mai ambigue, e
  il difetto — un `limit 1` che poteva scegliere la notifica sbagliata fra
  due con lo stesso `proposalId` — non aveva modo di presentarsi. Il verde
  non significava niente.
  **Regola: su un test scritto per riprodurre un difetto, guarda PERCHÉ è
  verde prima di credergli** — e in particolare controlla che i valori di
  contorno prodotti dagli helper (id casuali, `now()`, sequenze) non stiano
  sopprimendo proprio la condizione che serve. È la stessa famiglia del
  punto (b) — un test che passa per il motivo sbagliato — ma nessuno dei due
  si deduce dall'altro: là il codice mutato esplodeva prima di essere
  esercitato, qui non viene mai messo nelle condizioni di sbagliare.
- **Solo l'ambiente `test` entra in un worktree (fase 8).** Reso impossibile
  per COSTRUZIONE, non solo per convenzione: `loadProjectEnvFiles`
  (`apps/worker/src/pipeline/env-files.ts`) prende `environment` tipato sul
  solo letterale `"test"` — nessun chiamante scritto a mano può passargli
  altro senza un cast esplicito — e lo riverifica **a runtime**, lanciando
  su qualunque altro valore. Non è ridondante col safeguard anti-leak
  preesistente (l'esclusione dei file d'ambiente da ogni `git add`, "File
  `.env` per progetto" più sopra): quel safeguard protegge dal **commit** di
  una variabile, non dal resto — il giorno in cui una variabile di
  `staging`/`production` entrasse in un worktree, sarebbe già entrata in un
  log, in un prompt dell'agente o nell'ambiente di un sottoprocesso, prima
  ancora di un `git add`. Le variabili di `staging`/`production` esistono in
  Stubwise perché una persona le legga e le confronti (sezione ambienti del
  progetto), mai perché la pipeline le usi. Chi tocca questa funzione non
  allarghi il tipo del parametro "per generalità": un secondo chiamante che
  volesse un ambiente diverso da `test` starebbe chiedendo la cosa sbagliata.
- **Stubwise non fa deploy: il merge è il confine (fase 8).** Scritto perché
  non lo si superi "tanto manca poco". La coda di rilascio
  (`/release`, `apps/server/src/services/release.ts`) offre **un'unica
  azione**: il merge esplicito di una PR già aperta, con conferma a due
  click nella UI. Non esiste — e non va aggiunto senza che sia una
  decisione di prodotto nuova, non un dettaglio implementativo — nessun
  codice che esegua un `docker compose up`, un riavvio di servizio, uno
  script di deploy o qualunque azione sull'ambiente stesso: gli ambienti
  (`project_environments`) sono **pura anagrafica** — dove sta un ambiente,
  cosa ci gira secondo l'ultimo campione dell'agente di monitoraggio (Task
  4) — mai un bersaglio che Stubwise esegue. "Già su staging?"
  (`deployedOn` in `listReleaseQueue`) **legge**, non agisce: confronta
  l'head sha della PR col commit che l'agente riporta (`sameCommit`, vedi
  «Fase 8» più sopra), e un mancato match è
  "non risulta", mai un'affermazione che Stubwise avrebbe potuto rendere
  vera. Chi in futuro collega un ambiente a un'azione che lo TOCCA (un
  trigger di deploy, un rollout) rompe questa frase, non solo il codice.
- **Nei test del server una chiamata di rete reale FALLISCE il test (1 ott
  2026).** `apps/server/src/test/network-guard.ts` (`setupFiles` in
  `apps/server/vitest.config.ts`) avvolge `fetch`: verso un host non locale
  LANCIA e, soprattutto, REGISTRA la violazione, così `afterEach` fa fallire
  il test anche quando il codice sotto la ingoia — ed è il caso normale qui:
  `resolveProviderUserId` e il resto del ciclo sono fail-open/fail-closed per
  costruzione, catturano ogni errore, e senza la seconda metà un test che
  chiamava davvero GitHub restava verde. I doppi (`vi.stubGlobal`,
  `vi.spyOn(globalThis, "fetch")`, un `fetchImpl` iniettato) non sono
  toccati; loopback e gli host di `DOCKER_HOST`/`TESTCONTAINERS_HOST_OVERRIDE`
  restano ammessi. Chi scrive un test che «per comodità» parla col provider
  vero non spenga la guardia: doppi la chiamata.
- **Ogni schema di `@stubwise/shared` si deve caricare DA SOLO (1 ott 2026).**
  `packages/shared/src/schemas/load-isolated.test.ts` importa, uno per uno,
  ogni file di `src/schemas` (enumerati dal filesystem: un file nuovo è coperto
  senza toccare il test), su due livelli: in vitest sui sorgenti e in un
  processo `node` figlio sul `dist/`, perché solo il caricatore ESM vero
  riproduce il `ReferenceError … before initialization` di un import circolare
  (vitest lo vede solo se il binding viene dereferenziato). È nato da un giro
  reale — `ticket.ts` → `pr-correction.ts` → `project.ts`/`docs.ts` →
  `ticket.ts` — chiuso spostando `gitProviderKindSchema` e `heldReasonSchema`
  in `schemas/base-enums.ts` (foglia, ri-esportati dai file di prima: nessun
  import esistente è cambiato). ⚠️ Il test legge il `dist/`: va ribuildato
  prima (`pnpm --filter @stubwise/shared build`), e se è assente o stantio il
  test lo dice. Chi aggiunge un import fra schemi e vede quel test rosso non
  lo aggiri: sposti il pezzo condiviso in una foglia.
- **La storia del ticket non afferma ciò che Stubwise non sa (5 ott
  2026).** `buildTicketHistory`
  (`packages/notifications/src/ticket-history.ts`) è l'UNICO posto in cui le
  sorgenti diventano eventi della storia mostrata dall'app. `done`/`closed` →
  `ticket_closed`; `in_review → triaged` NON è «PR chiusa senza merge»,
  perché il triage (ramo HOLD) scrive la stessa riga; `actor: null` non è
  «automatico» — le colonne d'autore sono `ON DELETE SET NULL`, quindi un
  utente eliminato è indistinguibile dal sistema; `run_started` compare solo
  per un job PARTITO, perché `startRun` ricicla i job senza toccare
  `createdAt`; la numerazione «correzione K» è per PR, sulle non `cancelled`
  per `created_at`, e NON è `cycle.round` (test d'accordo
  `ticket-history.cycle.test.ts`). Limiti dichiarati nel design §3: un
  rifiuto senza istruzioni non lascia traccia, il merge non ha una data
  affidabile, il `pr_opened` si perde al riciclo del job, nei multi-repo solo
  la PR primaria, una pre-approvazione rifatta compare una volta sola. Chi
  aggiunge un evento lo aggiunga lì, e prima si chieda se il dato lo
  dimostra.
- **Un commento eliminato non ha più testo, in nessun posto (5 ott 2026).**
  Cancellare scrive `body = ''`, garantito da un CHECK (`deleted_at IS NULL
  OR body = ''`): ogni lettore di `body` smette da solo di vederlo, e nessuno
  deve ricordarsi un filtro per non far uscire il testo. Il filtro
  `isNull(deleted_at)` serve solo dove un corpo VUOTO fa danno: i due prompt
  del worker (prima del `limit`, o un eliminato occupa uno dei 10 posti) e
  `hasUserComment` su web e app. Chi aggiunge un lettore dei commenti si
  chieda quale dei due casi è. I permessi li calcola il server
  (`commentPermissions`) e un UPDATE con la stessa WHERE fa da autorità:
  l'admin cancella qualunque commento umano ma non lo modifica mai, e
  AI/sistema sono intoccabili. `inDecisionLog` lega un commento alla
  decisione `plan_review` (mode `fix`) perché `resolvePlan` scrive i due
  nella STESSA transazione con `now()` identico: chi separa quei due insert,
  o dà a uno dei due una data dal JS, rompe il legame in silenzio (docblock
  di `loadDecisionLogLinks`). Il registro decisioni non si riscrive:
  cancellare il commento lascia il testo lì, e la conferma di Elimina lo
  dice. Limiti: WAL, backup e cache persistita dei telefoni conservano il
  testo finché non vengono riscritti.
- **Ogni run AI del worker dichiara un `UsageTag`; modello e consumi passano
  dal `TrackingAgentRunner` (21 ott 2026).** Il decoratore risolve il modello
  (`ai_model_settings` → env → default di codice) e registra l'`agent_runs` a
  fine run: un consumo si registra in UN posto. I writer storici che già
  scrivevano la propria riga (fix, triage, review...) passano `record: false`,
  altrimenti il consumo si conta due volte. Una chiamata AI nuova nasce con il
  suo tag (`operation`, progetto), non con un modello cablato.

## Integrazione Claude Code (MCP)

Stubwise si integra con Claude Code via il **plugin `stubwise`** (8 ott 2026,
`docs/plans/2026-10-08-claude-plugin*.md`): server MCP `@stubwise/mcp`
(`packages/mcp`), skill e comandi `/stubwise:*` si installano e si aggiornano
INSIEME. Il marketplace è `.claude-plugin/marketplace.json` alla radice, il
plugin `plugins/stubwise/` (pacchetto privato del workspace
`@stubwise/claude-plugin`, mai pubblicato su npm). Installazione: `claude plugin
marketplace add Aleloca/stubwise --sparse .claude-plugin plugins` e `claude
plugin install stubwise@stubwise`. **Anche per chi sviluppa questo repo**: la
voce `stubwise` NON sta più nel `.mcp.json` della radice (resta `graphify`),
e skill e comandi NON stanno più in `.claude/` — si installa il plugin come
tutti.

- **Rilascio = mergiare una PR con changeset** (dal 20 ott 2026 non c'è più
  la PR di versioning): dopo la CI verde su `main`, il workflow Release
  (`.github/workflows/release.yml`, `workflow_run` della CI) versiona,
  pubblica su npm e pusha il commit di versione
  (`chore: versiona i package rilasciabili [skip ci]`) con i tag. Una
  modifica in `plugins/stubwise/` vuole un changeset che nomini
  `@stubwise/claude-plugin` **e** `@stubwise/mcp` (la CI lo pretende:
  `packages/mcp/scripts/check-plugin-changeset.mjs`): senza versione nuova
  Claude Code non vede l'aggiornamento (confronta la `version` del manifest),
  e senza `@stubwise/mcp` ripubblicato l'avviso «plugin vecchio» (che legge
  la `latest` di `@stubwise/mcp` su npm) non lo annuncia.
  **L'ordine del giro è deliberato: PRIMA npm, POI `main`.** Il commit di
  versione si fa in locale, si pubblica, e si pusha solo se la pubblicazione
  è riuscita: il marketplace serve `main` così com'è, e un plugin che fissa
  `@stubwise/mcp@<versione>` assente da npm (404 di `npx`) non fa partire il
  server MCP per NESSUNO dei client con l'aggiornamento automatico.
  ⚠️ **Un changeset esce SOLO con una CI verde su `main`** (o con «Run
  workflow» manuale su Release): una CI rossa o annullata dopo il merge non
  pubblica nulla, e il changeset aspetta il primo push verde successivo.
  **Prerequisito**: il push del commit di versione su `main` lo fa la
  **deploy key** `RELEASE_DEPLOY_KEY` (secret del repo, deploy key con
  scrittura «Release (push del commit di versione)»), perché il ruleset
  «protect-main» chiede una PR e su un repo personale GitHub Actions NON
  può stare fra i bypass actor (l'API risponde 422); «Deploy keys» sì, ed
  è nella lista dal 20 ott 2026. Quindi: nessun'altra deploy key con
  scrittura su questo repo, perché scavalcherebbe anch'essa protect-main.
  Release verifica il secret PRIMA di pubblicare; se il push viene
  comunque rifiutato (GH013) fallisce con un errore che lo dice: npm è già
  pubblicato, il commit di versione resta sul branch `release/versione-<sha>`
  (va portato su `main` con una PR) e i tag elencati nel log vanno ricreati
  a mano. Il commit di versione porta `[skip ci]`, ed è necessario: un push
  con la deploy key avvia i workflow.
  ⚠️ **Dopo il merge, quando Release ha finito, verifica la pubblicazione**:
  `npm view @stubwise/mcp version` deve dire la versione nuova, e su `main`
  deve esserci il commit di versione. Se Release fallisce **prima** di
  pubblicare (build, token, npm), non è uscito nulla: si corregge e il giro
  successivo (o «Run workflow» su Release) riprova. Se fallisce **dopo**
  (push su `main` rifiutato anche dopo il rebase), le versioni sono su npm ma
  il commit no: «Run workflow» su Release ricalcola le stesse versioni dai
  changeset ancora pendenti, salta la pubblicazione (già fatta) e pusha —
  vale finché non entrano changeset nuovi. Il primo push verde su `main`
  successivo fa comunque lo stesso da solo. Da qui in avanti il vecchio
  passo post-merge «ricopiare la skill in `~/.claude/skills/stubwise/SKILL.md`
  sulle macchine degli sviluppatori» (fasi 1, 2, 5, correzioni post-PR, qui
  sopra) **diventa «mergiare la PR col changeset»**: il plugin arriva con
  quella, quando Release ha finito.
- **La versione del plugin: una fonte, tre copie — più il pin dell'MCP.**
  Fonte `plugins/stubwise/package.json` (la alza Changesets); copie in
  `plugins/stubwise/.claude-plugin/plugin.json`, in
  `env.STUBWISE_PLUGIN_VERSION` di `plugins/stubwise/.mcp.json` e in
  `LATEST_PLUGIN_VERSION` di `packages/mcp/src/plugin-version.ts` (generato).
  Nello stesso `.mcp.json` gli `args` del server fissano
  `@stubwise/mcp@<versione>`, presa da `packages/mcp/package.json` (20 ott
  2026): senza versione `npx -y` può riusare una copia in cache. Le riscrive
  tutte `packages/mcp/scripts/sync-plugin-version.mjs`, lanciato da
  `pnpm version-packages` (= `changeset version` + sincronizzazione), che è il
  comando di versioning di `release.yml`: Changesets non esegue gli script
  `version` dei pacchetti. Il test di parità
  (`packages/mcp/src/plugin-version.test.ts`) fallisce se divergono: non si
  allinea a mano una copia sola, si rilancia lo script.
- **`@stubwise/mcp` e `@stubwise/claude-plugin` sono un gruppo `fixed`**
  (`.changeset/config.json`): escono sempre insieme, con la stessa versione —
  anche un changeset che nomina solo l'MCP alza il plugin. Serve perché un
  pin nuovo arriva agli utenti solo se sale la `version` del manifest, che è
  ciò che Claude Code confronta. Il test di parità controlla anche il gruppo.
- **Aggiornamento automatico**: `npx -y @stubwise/mcp@latest setup` (ultimo passo
  del comando di Impostazioni → Claude Code, DOPO `marketplace add`) mette
  `autoUpdate: true` sulla voce `extraKnownMarketplaces.stubwise` di
  `settings.json` di Claude Code (`CLAUDE_CONFIG_DIR` o `~/.claude`); non crea
  mai la voce, non tocca un JSON rotto, `--no-auto-update` lo salta. Un
  `marketplace add` rilanciato riscrive la voce e toglie `autoUpdate` (CLI
  2.1.304): per questo `setup` gira per ultimo.
- **Avvisi del server MCP** (`packages/mcp/src/notices.ts`): una volta per
  processo (= sessione), in coda alla PRIMA risposta di un tool, mai un
  errore — plugin più vecchio dell'ultima versione (la più alta fra
  `LATEST_PLUGIN_VERSION` compilata e la `latest` di `@stubwise/mcp` letta da
  npm all'avvio, timeout 1,5 s, in silenzio su errore, saltata con
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` non vuota: col pin e il gruppo
  `fixed` la sola costante sarebbe sempre uguale al plugin che avvia il
  server, quindi l'avviso non scatterebbe mai; dice di rifare il comando da
  Impostazioni → Claude Code, coi comandi da terminale come alternativa),
  server avviato senza plugin
  (`STUBWISE_PLUGIN_VERSION` assente), copie a mano in
  `~/.claude/skills/stubwise/` o `~/.claude/commands/stubwise/`.
- ⚠️ **Nel `.mcp.json` del plugin le variabili sono `${VAR:-}`, non `${VAR}`**:
  Claude Code passa LETTERALE una `${VAR}` non impostata (provato con la
  2.1.294), e `STUBWISE_URL="${STUBWISE_URL}"` faceva morire il server con
  «non è un URL valido». `loadConfig` tratta comunque `${…}` come assente.
- **Auto-update**: Claude Code lo fa per i marketplace con `autoUpdate`
  acceso, spento di default per quelli di terze parti come il nostro: lo
  accende `setup` (vedi sopra), a mano è `/plugin` → Marketplaces → Enable
  auto-update. L'aggiornamento in background vero non è provato da noi: la
  rete di sicurezza è l'avviso del server, che confronta col registro npm.
- Il plugin `stubwise-base` del worker (`apps/worker/plugins/`) è un'altra
  cosa (il contratto dei run sul worker) e non c'entra.
- Skill **`stubwise`** (`plugins/stubwise/skills/stubwise/`, nel plugin si
  chiama `stubwise:stubwise`): quando e come usare i tool
  per collegare design/piani a backlog e ticket (crea voci di backlog dai doc,
  converti in ticket, avanza gli stati `in_progress`/`in_review`; `done` solo
  on-demand).
- Comando **`/stubwise:init`**: collega una o più repo a un progetto Stubwise
  scrivendo `.stubwise.json` (`{ "project": "<slug>" }`) nella radice.
- Comando **`/stubwise:run`**: prepara il ticket (design + piano + `in_progress`)
  e lancia l'esecuzione SUL worker con il tool `run_ticket` — l'implementazione
  la fa la pipeline, non la sessione locale (`/stubwise:start` è l'opposto:
  implementa in locale).
- **Ruoli (fase 0, sui permessi dal 22 ott 2026)**: «maintainer» = chi ha
  `plans.approve` nel progetto, «operatore» = chi non ce l'ha. Un PAT agisce
  con i permessi del suo utente. Un run avviato senza `plans.approve` passa
  sempre dal gate di approvazione del piano (con piano salvato nasce
  `awaiting_plan_approval`, senza piano si ferma a piano pronto); solo chi ha
  `plans.approve` approva/rifiuta, e dopo l'approvazione l'esecuzione riparte
  da sola. Nessun tool MCP approva un piano.
- **Domande dell'agente (fase 1)**: il gate di approvazione non è l'unico punto
  in cui un run può fermarsi ad aspettare un umano. In un run che **pianifica**
  (nessun piano salvato, o `mode: "ai_plan"`) l'agente può usare il tool
  `ask_user` — un server MCP stdio bundlato nel worker, non in `@stubwise/mcp` —
  per fare una domanda a scelta multipla: il job va in `awaiting_input` e riparte
  da solo quando il richiedente o un maintainer risponde dall'inbox, dal DM Slack
  o dalla pagina del ticket. Nessun tool MCP risponde a una domanda, e dopo una
  domanda **non si rilancia `run_ticket`** (409).
- **Pulse proattivo (fase 2)**: il tool `list_proposals` elenca le proposte del
  pulse **aperte e indirizzate al titolare del token** (per ogni progetto fermo,
  le voci di backlog da cui ripartire, con urgenza, effort e id). Serve a
  SAPERE: nessun tool MCP risponde a una proposta — si sceglie dalla card in
  inbox o dal DM Slack, e ticket + run con approvazione del piano partono da
  soli.
- **Roadmap e memoria del progetto (fase 5)**: due tool di sola lettura, che
  servono a SAPERE prima di proporre. `get_project_brief` restituisce
  l'ultimo **brief settimanale** in markdown — dove sta il progetto, cosa è
  cambiato, cosa è fermo, cosa serve — ed è **narrativa generata**: si cita
  come tale. `list_decisions` restituisce il **registro decisioni** (risposte
  alle domande dell'agente, piani approvati o rifiutati con indicazioni,
  proposte del pulse accettate, voci registrate a mano) con origine, attore e
  ticket, e serve a non riproporre un'alternativa che il team ha già
  scartato: è **fatto**, mai scritto dall'AI (vedi l'invariante). Una
  decisione superata resta nell'elenco, marcata come tale. In entrambi i
  casi, "non c'è ancora nulla" è una risposta esplicita, non un errore.
- **Correzioni post-PR (1 ott 2026)**: nessun tool MCP lancia una
  correzione. Una PR aperta da Stubwise si corregge dal bottone «Chiedi
  modifiche» sotto la PR, su Stubwise (web e app), oppure con il «Request
  changes» della revisione sulla piattaforma — e, con la review accesa, il
  ciclo automatico ci prova da solo fino al tetto del progetto.
  **`run_ticket` non è quella strada**:
  ripartirebbe dal branch di default e non aggiornerebbe la PR. Né lo è per
  una correzione FERMA: `run_ticket` non dice quale correzione riprendere, e
  il server decide dallo stato del momento — se l'ultimo job è ancora il
  `held` della correzione la forza (col token di chi ha `plans.approve` nel
  progetto anche oltre il budget; senza, su una ferma per budget riceve
  `needs_maintainer`), se
  nel frattempo la correzione è terminale (PR mergiata, riconciliata) avvia
  un **fix nuovo** dal branch di default. Si riprende da «Riprendi la
  correzione» sul ticket, che manda `resumeCorrectionJobId`. La descrizione
  del tool e la skill lo dicono.
- **Modalità collaboratore (20 ott 2026,** `docs/plans/2026-10-19-mcp-collaboratori-design.md`**)**:
  un utente non tecnico (anche senza permessi di sviluppo, es. `Contributor`) usa Claude Code senza repo né
  `/stubwise:init`. Tool nuovi di `@stubwise/mcp`: `search_project_docs`,
  `read_doc_page` (tetto 30.000 caratteri) e `my_requests` (stati in
  linguaggio semplice; legge `mine=true` di `GET /api/tickets` e
  `GET /api/backlog`). Il server MCP ha `instructions` col flusso del
  collaboratore; la skill `stubwise` scatta solo per sviluppatori in un repo
  collegato. `create_backlog_item` apre un ticket `feature` se il backlog del
  progetto è spento e dice quando la richiesta è stata fusa
  (`requestCount > 1`). Autore: `tickets.requested_by_user_id` e
  `backlog_item_requesters` (una voce fusa ricorda tutti; il ticket
  convertito eredita il più vecchio).
- **Configurazione e installazione**: file `~/.config/stubwise/config.json`
  (override `STUBWISE_CONFIG`), precedenza env > file > default; `npx -y
  @stubwise/mcp setup --url … --token …` verifica il token con
  `/api/auth/me`, scrive il file 0600 e accende l'aggiornamento automatico
  del marketplace (vedi sopra). Il comando completo lo genera la web in
  Impostazioni → «Claude Code» (`/settings/claude-code`), che crea un PAT:
  `marketplace add` && `plugin install` && `setup`, in quest'ordine.
- **Avviso `request.created`**: card in inbox agli admin (con push) quando un
  MEMBER apre un bug/feature (non deviato) o una richiesta di backlog (la
  pubblica il worker dopo create/merge dell'intake, link da `PUBLIC_URL`). La
  pubblicazione non fa mai fallire la richiesta. Il webhook in uscita riusa
  `notifyTicketCreated`. Nuovo `notification_kind`: vedi il rollback nella
  voce di deploy-log.
- Serve un Personal Access Token (`stw_pat_...`, dalle impostazioni Stubwise) in
  `STUBWISE_TOKEN`; `STUBWISE_URL` punta all'istanza (default
  `http://localhost:3000`), nell'ambiente di Claude Code (shell o `env` dei
  settings utente). Il pacchetto è pubblicato su npm come
  `@stubwise/mcp`: il `.mcp.json` del plugin lo avvia via `npx -y @stubwise/mcp`
  (nessun build locale necessario). Il pacchetto è autonomo a runtime (bundle, nessuna dep
  `workspace:` residua). Pubblicazione di nuove versioni: **automatica via
  Changesets** — aggiungi un changeset (`.changeset/*.md`) alla PR e mergiala:
  quando la CI del push su `main` è verde, il workflow `release.yml` esegue
  `pnpm version-packages`, `pnpm changeset publish` (idempotente: salta le
  versioni già su npm) e pusha su `main` il commit di versione
  («chore: versiona i package rilasciabili [skip ci]») con i tag. NON usare `npm publish` a mano (non risolve i
  `workspace:` del monorepo pnpm). Il secret `NPM_TOKEN` è un granular token con
  bypass-2FA sullo scope `@stubwise`.

### Grafo locale del repo (`graphify-out/`)

Oltre ai grafi **per-repository** che il worker produce in
`/graphs/<repositoryId>/graphify-out/` per le chat (vedi "Architettura runtime"),
questo repo ha un grafo **proprio** in `graphify-out/`, committato, che serve
alla navigazione del codice da Claude Code. Sono due cose distinte: quando in
questo file leggi `graphify-out/` senza prefisso, è quello locale.

- È servito dal server MCP `graphify` di `.mcp.json` (`uvx`, stdio) e rigenerato
  dall'hook `post-commit` installato da `graphify hook install` (l'hook esce
  subito nei worktree collegati: lì il grafo non si aggiorna).
- La sezione `## graphify` in fondo a questo file è **generata** da `graphify
  claude install` (asset `graphify/always_on/claude-md.md`): non editarla a mano,
  viene rimpiazzata a ogni install.
- `graphify-out/graph.json` è un artefatto generato committato (~400 KB nel pack
  per versione, su un repo da ~3 MiB). In caso di **conflitto** non mergiarlo a
  mano: il merge driver `merge=graphify` di `.gitattributes` è configurazione
  locale in `git config` e **non gira sui merge lato GitHub**. Risolvi
  rigenerando: `graphify update . && git add graphify-out/`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
