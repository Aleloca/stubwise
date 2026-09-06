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
  `Dockerfile.caddy` — e da `apps/mobile`), `db` (Drizzle + Postgres/pgvector),
  `docs-engine`, `embeddings`, `git`, `i18n`, `notifications`, `sdk`, `shared`,
  `widget` (bundle embeddabile del customer service, servito come `/widget.js`
  da caddy).
  `notifications` ospita anche i moduli **puri e condivisi fra server e
  worker** che leggono lo stato di un progetto: `project-signals.ts` (i
  segnali del pulse) e, dalla fase 5, `project-timeline.ts` — l'unione degli
  eventi di un progetto in una finestra temporale. La timeline serve sia alla
  rotta `GET /api/projects/:projectId/timeline` (server) sia al brief
  settimanale (worker): sta in un package che entrambi hanno già come
  dipendenza proprio per non duplicarne le query in due posti che poi
  divergono.

## Comandi (dalla radice)

- `pnpm test` — tutti i test (Vitest; server/worker/db usano testcontainers).
- `pnpm typecheck` — `tsc --noEmit` su tutti i package.
- `pnpm lint` — ESLint. **La CI fallisce su lint anche con typecheck+test verdi:
  lancialo SEMPRE prima del merge.**
- `pnpm build` — build di tutti i package.
- Per un singolo package: `pnpm --filter @stubwise/<nome> <script>`.
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
progetto, refinement del backlog, `/docs` di Slack — il widget NO) gli chiedono
via MCP il sottografo della domanda e allegano gli snippet di codice letti dai
mirror git, che il server monta `:ro` (`apps/server/src/graph-chat`, fail-open:
spegnibile con `GRAPHIFY_MCP_URL=` vuota).
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

Fase 3. Un **registro d'istanza** (`plugins`, solo admin, Impostazioni → Plugin)
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
- **Abilitazioni per progetto** (Progetto → Plugin, solo admin): per
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
  self-repair), deep dive del backlog, chat di analisi del backlog. **Esclusi**:
  triage, intake/stima, docs, review PR, daily report, test credenziali.
- **INVARIANTE — il `.mcp.json` di un plugin non è mai caricato.** I server MCP
  di un run passano SOLO da `--mcp-config` + `--strict-mcp-config`; la copia
  filtrata omette quel file per costruzione (il CLI lo caricherebbe con
  `--plugin-dir`). Chi tocca la copia non lo reintroduca «per completezza».
- **`--setting-sources ""` va insieme ai plugin** (c'è solo quando c'è almeno un
  `--plugin-dir`): spegne plugin dell'utente, `.claude/` e `.mcp.json` intorno
  alla cwd, così l'insieme di skill e hook è deterministico. **Asimmetria da
  ricordare**: nei run di fix la cwd è SEMPRE la parent dir dei worktree (anche
  con un repo solo), quindi le `.claude/settings.json` dei repo target non erano
  mai state caricate e non cambia nulla; nel **deep dive** e nella **chat di
  analisi** la cwd è la radice del worktree, quindi lì il flag le disattiva
  davvero. La UI lo avvisa (`projects:plugins.settingSourcesWarning`).
- Tutto il percorso è **fail-open ma mai silenzioso**: un plugin non preparabile
  viene saltato per quel run con una riga nel log (log del job per il fix,
  logger per i job di backlog) e il run prosegue.
- **Scenari golden (manuali, mai in CI)**: `pnpm --filter @stubwise/worker
  golden -- --plugin <dir>` (`apps/worker/scripts/golden/`, README accanto) fa
  tre run veri col CLI su un repo fixture — piano read-only, bivio materiale con
  `ask_user`, esecuzione — e verifica che l'agente rispetti ancora il contratto
  (nessun commit/branch/worktree, sezione delle decisioni, report nella radice
  della working dir). **Lanciali quando aggiorni un plugin, un prompt o il CLI
  `claude`**: sono l'unica verifica che copre il comportamento del modello con i
  plugin caricati (la copia filtrata è già coperta dai test unitari).

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
- Modifica al **retrieval dal grafo nelle chat** (`apps/server/src/graph-chat`) →
  ribuilda `server`.
- **Fase 0 (inbox/notifiche)**: rebuild **server+worker+caddy insieme**
  (migrazione 0063 all'avvio del server; senza il worker nuovo le notifiche
  restano in outbox); env opzionale `NOTIFY_POLL_SECONDS` (default 5, 0 = spegne
  la consegna, webhook incluso); app Slack: aggiungere gli scope `chat:write` e
  `im:write`, reinstallarla nel workspace e risalvare il bot token in
  Impostazioni → Slack; poi collegare gli account Slack in /team (chi è collegato
  inizia a ricevere DM subito, preferenza disattivabile dall'Account).
- **Fase 1 (domande dell'agente, `ask_user`)**: rebuild **server+worker+caddy
  insieme** (migrazione 0064 all'avvio del server; il worker nuovo è l'unico che
  sa parcheggiare e riprendere i job in `awaiting_input`, il server nuovo l'unico
  che accetta le risposte, il bundle nuovo l'unico che le mostra). Env opzionale
  `AGENT_QUESTION_MAX_ROUNDS` (default 5, **minimo 1**: `0` è rifiutato all'avvio
  del worker — non esiste un interruttore per disattivare le domande). ⚠️ La
  ripresa del piano può lanciare due run di pianificazione (un `--resume`
  fallito più il fallback pieno), quindi **l'invariante di staleness sale da
  129' a 139'**: se in `.env` c'è un `WORKER_STALE_MINUTES` esplicito ≤ 139 il
  worker si rifiuta di partire (il default 150 va bene). **Nessun
  passo Slack manuale**: i bottoni delle domande usano gli scope già installati
  con la fase 0. Post-merge: ricopiare la skill aggiornata in
  `~/.claude/skills/stubwise/SKILL.md` (finché non lo fai, le sessioni Claude
  Code locali girano con la skill vecchia, senza la guardia che vieta di
  rilanciare `run_ticket` su un job fermo su una domanda) e mergiare la PR di
  versioning Changesets che pubblica `@stubwise/mcp` con la nuova descrizione di
  `run_ticket`. **Rollback**: la fase è additiva (schema e kind nuovi, niente
  rimosso), ma su un'immagine vecchia i job rimasti in `awaiting_input` non
  hanno più un consumatore e restano fermi in silenzio → vanno rilanciati a mano
  con run-ai sui ticket coinvolti.
- **Fase 2 (pulse proattivo)**: rebuild **server+worker+caddy insieme**
  (migrazione 0065 all'avvio del server; il worker nuovo è l'unico che ha il
  poller che rileva i progetti fermi e pubblica il `project.pulse`, il server
  nuovo l'unico che sa eseguire «Procedi» — convert della voce di backlog + run
  con approvazione obbligatoria del piano —, il bundle nuovo l'unico che sa
  disegnare la card delle proposte e il toggle sul progetto). Env opzionali:
  `PULSE_POLL_MINUTES` (default 15, **0 = spegne la feature**, ed è il
  rollback), `PULSE_TIMEZONE` (fuso IANA della finestra d'invio, default `UTC`,
  **in prod `Europe/Rome`**; ⚠️ un valore non valido fa **fallire l'avvio del
  worker**, di proposito: meglio un worker che non parte di un pulse mandato
  all'ora sbagliata), `PULSE_SEND_HOUR` (0..23, default 9: il pulse parte solo
  nella finestra `[ora, ora+1)` locale) e `PULSE_WEEKDAYS_ONLY` (default true,
  tace sabato e domenica). **Attivazione per progetto** dal dettaglio progetto
  in /team, **solo se il backlog di discovery è già acceso** (il pulse propone
  voci di backlog: senza backlog non ha nulla da dire — la UI tiene il toggle
  disabilitato e il poller pesca solo i progetti con **entrambi** i flag);
  default off, quindi al deploy nessun progetto riceve pulse.
  Cadenza per progetto (`pulseEveryDays`, 1..30, default 3) nello stesso form.
  **Nessun passo Slack manuale**: la card e i bottoni riusano scope e superficie
  interattiva delle fasi 0/1. Post-merge: (a) mergiare la PR di versioning
  Changesets che pubblica `@stubwise/mcp` con il tool `list_proposals` — il tool
  arriva agli utenti a quel merge, **non** al deploy dell'istanza; (b) ricopiare
  la skill aggiornata in `~/.claude/skills/stubwise/SKILL.md` **sulle macchine
  degli altri sviluppatori** (questa è già allineata). **Rollback — due strade
  che NON si equivalgono**: (1) *spegnere la feature* è la strada innocua:
  `PULSE_POLL_MINUTES=0` (o i toggle per progetto) e il pulse tace subito, senza
  toccare lo schema né le immagini, con le notifiche già in inbox che restano
  usabili; (2) *tornare all'immagine server precedente* **NON è sicuro** finché
  in `notifications` esiste anche UNA riga `project.pulse`, **incluse quelle già
  gestite** (che il binario vecchio incontra nella tab "Gestite"): il kind non
  esiste in quell'immagine, `inboxPageSchema` fa fallire la serializzazione e
  salta **tutta `/api/inbox` con un 500** — non una card degradata. È la lezione
  della fase 1 in forma nuova. Chi deve davvero scendere di immagine deve prima
  **eliminare quelle righe** da `notifications` (o metterle da parte in una
  tabella d'appoggio): segnarle gestite NON basta — non esiste uno stato che le
  nasconda, la tab "Gestite" le rilegge tutte.
- **Fase 3 (registro plugin/skill)**: rebuild **server+worker+caddy insieme**
  (migrazione 0066 all'avvio del server — 3 tabelle NUOVE, `plugins`,
  `plugin_jobs`, `project_plugins`; il worker nuovo è l'unico che materializza,
  fa lo smoke e carica i plugin nei run, il server nuovo l'unico che espone il
  registro e le abilitazioni, il bundle nuovo l'unico che disegna Impostazioni →
  Plugin e la sezione Plugin del progetto). Serve il **volume `claude-plugins`
  montato in `/plugins` SOLO sul worker** (il server legge l'inventario dal DB e
  non deve vedere i file): è già in `docker-compose.yml`, ma su un host che
  ricrea i servizi a mano va verificato. Env opzionali: `PLUGIN_POLL_SECONDS`
  (default 20, **0 = nessuna materializzazione parte**) e `PLUGINS_DIR` (default
  `/plugins`, **deve coincidere col mount**). **Nessun passo manuale
  obbligatorio**, e al deploy nessun plugin esiste: il registro nasce vuoto e i
  run hanno l'argv di sempre. Post-deploy: da Impostazioni → Plugin aggiungere
  `https://github.com/obra/superpowers.git` @ `v4.0.3`, attendere `ready` +
  smoke `passed`, poi abilitarlo sui progetti applicando il **preset
  consigliato**; e lanciare una volta gli **scenari golden** (vedi sopra).
  **Rollback — tre livelli, e solo il primo è pieno**: (1) *togliere i plugin
  dai run* si fa **dalla UI**, disabilitandoli sui progetti o rimuovendoli dal
  registro; è l'unica strada che li fa uscire davvero dai run. ⚠️
  `PLUGIN_POLL_SECONDS=0` **non** è quella strada: congela il registro (nessun
  fetch, nessuno smoke, nessun plugin *nuovo*) ma i plugin **già materializzati
  restano nei run**, perché la copia per-run legge DB e volume, non il poller.
  (2) *scendere di immagine sul worker* riporta l'argv storico (niente
  `--plugin-dir`, niente `--setting-sources`): innocuo per i run, ma i
  `plugin_jobs` restano senza consumatore e un plugin preso a metà resta
  `materializing` in silenzio finché non torna il worker nuovo (che poi lo
  recupera da sé con il recovery degli orfani). (3) *scendere di immagine sul
  server* **è sicuro qui**, al contrario della fase 2: la fase è davvero
  additiva — tre tabelle nuove, **nessun valore aggiunto a un enum esistente e
  nessun kind nuovo che entri nella risposta di una rotta già esistente**,
  quindi non esiste l'equivalente del `project.pulse` che faceva saltare tutta
  `/api/inbox`. Le rotte `/api/plugins` e `/api/projects/:id/plugins`
  semplicemente non esistono più (404) e il migratore ignora la 0066 già
  applicata; ma **il caddy va sceso insieme**, altrimenti il bundle nuovo chiama
  rotte che non ci sono. Il volume `claude-plugins` e le righe del registro
  sopravvivono a tutto: non c'è niente da ripulire.
- **Fase 4 (app mobile + notifiche push)**: rebuild **server+worker+caddy
  insieme** (migrazione 0067 all'avvio del server — nuova tabella
  `device_tokens`, nuova colonna `users.notify_push`, nuovo valore `push`
  sull'enum `delivery_channel`; il worker nuovo è l'unico che sa consegnare
  su quel canale tramite il relay, il server nuovo l'unico che espone
  `/api/auth/mobile-login`, `/api/me/devices*` e il campo `push` in
  `/api/me/notification-prefs`, il bundle caddy nuovo l'unico che disegna il
  toggle push in Impostazioni → Account). **L'app mobile stessa NON fa parte
  di questo rebuild**: si distribuisce a parte via TestFlight/Play (vedi
  `apps/mobile/README.md`) e si aggiorna dagli store, non dai nostri deploy —
  è la premessa dell'invariante "solo cambi additivi" qui sotto. Env
  opzionale sul worker: `PUSH_RELAY_URL` (assente = punta di default al relay
  pubblico che operiamo noi, `https://push.stubwise.aleloca.dev`; stringa
  vuota = push spente, **è il rollback della sola consegna** senza toccare
  schema o immagini; un URL https = quel relay — ⚠️ nel compose la sintassi è
  `${VAR-default}` col trattino nudo, non `:-`: coi due punti una stringa
  vuota in `.env` verrebbe rimpiazzata dal default). **Deploy del relay**
  (solo sul nostro VPS, mai sulle istanze self-hosted): `cp
  caddy.d/relay.caddy.example caddy.d/relay.caddy`, DNS `push.<dominio>` →
  VPS, `PUSH_RELAY_HOST=<dominio>` + credenziali APNs/FCM in `.env`, poi
  `docker compose --profile relay up -d --build push-relay caddy` (senza
  `--profile relay` il servizio non si builda né si avvia: vedi
  `apps/mobile/README.md`, sezione "Il relay push", per il dettaglio
  di ogni credenziale). **Rollback — non è simmetrico fra i due valori nuovi
  in `packages/shared`, verificato leggendo schemi e route, non assunto**:
  (1) il valore enum `push` di `delivery_channel` **non compare in nessuna
  risposta di rotta esistente** (né `deliveryChannel` né `channel` sono letti
  fuori da `packages/db` e dal poller del worker) — scendere di immagine sul
  server è sicuro quanto lo era in fase 3: un poller vecchio marca ogni riga
  `push` `skipped / channel_not_implemented` e non la ripesca più (innocuo se
  il rollback è anche del worker), ma nessuna rotta smette di rispondere.
  (2) **`notificationPrefsViewSchema` è diverso, ed è il rischio vero**: ha
  `push: z.boolean()` **obbligatorio** ed è la risposta di
  `GET /api/me/notification-prefs`, una rotta **preesistente** (dalla fase 0).
  Scendere di immagine sul server qui non fa **crashare il server** (il
  binario vecchio non sa di `push` e non lo produce, quindi non c'è
  l'equivalente del 500 di `inboxPageSchema` in fase 2) — ma l'app mobile
  **già installata** valida quella stessa risposta con lo schema `push`
  obbligatorio compilato al suo interno, e un rollback del server gliela
  fa arrivare **senza quel campo**: esattamente il caso "rimuovere un campo
  da una risposta che un client mobile già installato si aspetta", la prima
  voce della sezione "Invarianti e trappole" qui sotto. Il rollback del
  server in fase 4 è quindi sicuro per il server e per il web (rifatto
  insieme al caddy), ma **rompe l'app mobile già in mano agli utenti** finché
  non si torna avanti.
- **Fase 5 (roadmap, brief settimanale, registro decisioni)**: rebuild
  **server+worker+caddy insieme** (migrazione 0068 all'avvio del server —
  nuovo valore `project.brief` sull'enum `notification_kind` **in uno
  statement a sé** e mai usato nella stessa migrazione (vedi la trappola
  delle migrazioni batch qui sotto), colonne **nullable** su `ai_jobs`
  (`plan_summary`), `pr_reviews` (`pr_summary`) e `milestones`
  (`description`, `closed_at`), colonne con default su `projects`
  (`weekly_brief_enabled`, default `false`) e `notification_settings`
  (`notify_brief`, default `true` — è il toggle d'istanza del kind, in
  Impostazioni → Notifiche, non una preferenza per utente: `notificationPrefs`
  **non cambia**, quindi qui non si ripresenta la trappola della fase 4
  sull'app mobile già installata), un `DROP NOT NULL` su
  `milestones.repository_id` (la milestone è di progetto: il repo d'origine è
  un dettaglio, e la creazione dalla UI non lo manda più) e due tabelle NUOVE
  `project_briefs` e `project_decisions`; il worker nuovo è
  l'unico che genera i riassunti "in breve" e che ha il poller del brief, il
  server nuovo l'unico che espone timeline, review, brief e decisioni — e
  l'unico che sa serializzare un'inbox che contiene `project.brief` —, il
  bundle nuovo l'unico che disegna la Roadmap, il brief e il registro
  decisioni). Env opzionali sul worker: `SUMMARIES_ENABLED` (default `true`;
  `false` spegne **solo** la generazione dei riassunti — `plan_summary` e
  `pr_summary` restano `NULL` e le card tornano a mostrare quello che
  mostravano prima), `SUMMARY_MODEL` (vuoto/assente = **lo stesso di
  `PR_REVIEW_MODEL`**: stesso profilo di run, solo testo e read-only, non ha
  senso tenerne allineati due), `BRIEF_POLL_MINUTES` (default 15, **0 =
  spegne la feature**, ed è il rollback: non nasce più nemmeno un brief
  richiesto a mano dalla UI), `BRIEF_WEEKDAY` (1 = lunedì … 7 = domenica,
  default 1 — e il **periodo segue il giorno**: spostandolo al venerdì il
  brief copre venerdì→giovedì, senza altra configurazione) e
  `BRIEF_SEND_HOUR` (0..23, default 9, finestra `[ora, ora+1)`). ⚠️ Il fuso è
  **`PULSE_TIMEZONE`, riusato e non duplicato**: è l'unico fuso
  dell'istanza — chi sposta il pulse sposta anche il brief, di proposito.
  **Attivazione per progetto** (`weeklyBriefEnabled`) dal dettaglio progetto,
  **default off**: al deploy nessun progetto riceve brief. **Passo manuale
  post-deploy — backfill una tantum degli eventi di chiusura**: fino a questa
  fase solo `PATCH /api/tickets/:id` scriveva uno `status_changed`, quindi le
  chiusure fatte dal webhook git (PR mergiata → `done`) non hanno lasciato
  traccia e la timeline mostrerebbe come chiusi i soli ticket chiusi a mano.
  Sul VPS, **dentro il container server**, prima in prova e poi davvero:
  `docker compose exec server node
  dist/scripts/backfill-ticket-done-events.js --dry-run`, poi lo stesso senza
  `--dry-run`. È **idempotente** (salta i ticket che hanno già uno
  `status_changed` verso `done`) e **non** è una migrazione di proposito:
  tocca molte righe storiche e va lanciato quando si vuole. ⚠️ In prod si
  lancia col **`node` compilato**, non con `pnpm --filter @stubwise/server
  backfill:ticket-events` (quello è la forma di sviluppo): l'immagine di
  runtime è un `pnpm deploy --prod` e **non contiene né `tsx` né pnpm**, e il
  Postgres del compose non pubblica porte sull'host, quindi non è nemmeno
  raggiungibile dal checkout in `/opt/stubwise`. Per questo il build del
  server emette anche `dist/scripts/` (`apps/server/tsconfig.scripts-build.json`):
  chi aggiunge uno script operativo lo tenga sulle sole dipendenze di
  produzione. Altri post-merge: mergiare la PR di
  versioning Changesets che pubblica `@stubwise/shared` e `@stubwise/mcp`
  (tool `get_project_brief` e `list_decisions` — arrivano agli utenti a quel
  merge, **non** al deploy dell'istanza) e ricopiare la skill aggiornata in
  `~/.claude/skills/stubwise/SKILL.md` sulle macchine degli altri
  sviluppatori. **Nessun passo Slack manuale**: la card del brief riusa scope
  e superficie interattiva delle fasi 0/1/2. **Rollback — tre strade, e solo
  le prime due sono innocue**: (1) *spegnere le feature*:
  `BRIEF_POLL_MINUTES=0` (o il toggle per progetto) e nessun brief nasce più;
  `SUMMARIES_ENABLED=false` e nessun riassunto viene generato. Nessuna delle
  due tocca schema o immagini, e quello che è già stato prodotto resta
  leggibile. (2) *scendere di immagine sul worker* è innocuo per i run: i
  brief rimasti `running` restano orfani **in silenzio** finché non torna il
  worker nuovo, che poi li recupera da sé col recovery degli stantii — nessun
  intervento manuale. (3) *scendere di immagine sul server* **NON è sicuro**
  finché in `notifications` esiste anche UNA riga `project.brief`, **incluse
  quelle già gestite**: `notificationKindSchema` è un enum **chiuso**, il
  binario vecchio non conosce quel valore, `inboxPageSchema` fa fallire la
  serializzazione e salta **tutta `/api/inbox` con un 500** — non una card
  degradata. È esattamente la lezione di `project.pulse` in fase 2, e vale
  qui identica: chi deve davvero scendere di immagine deve prima **eliminare
  quelle righe** (`delete from notifications where kind = 'project.brief';`,
  o spostarle in una tabella d'appoggio). Segnarle gestite NON basta: la tab
  "Gestite" le rilegge tutte. Le colonne e le due tabelle nuove sopravvivono
  a tutto e il migratore ignora la 0068 già applicata; ma **il caddy va sceso
  insieme al server**, altrimenti il bundle nuovo chiama rotte che non ci
  sono — e non solo: il body di creazione delle milestone dell'immagine
  vecchia esige `repositoryId`, che la UI nuova non manda più. (Le milestone
  già create senza repo, invece, non sono un problema: `repositoryId` non è
  mai stato nella *risposta*, nemmeno prima, quindi nessuna rotta smette di
  serializzare — verificato leggendo lo schema di risposta su `main`, non
  assunto.)
- Verifica il bundle servito cercando una stringa nuova:
  `docker exec stubwise-caddy-1 sh -c 'grep -rl "<stringa>" /srv/web'`.
- Backup del DB prima di operazioni rischiose.

## Invarianti e trappole

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
  per ore. La fase **product** allunga la finestra di finalize (decine di run): un
  crash del worker DENTRO product/finalize lascia la generazione `running` per
  sempre (nessun nodo claimabile) → recovery manuale: `update doc_generations set
  status='failed', error='worker crash during finalize' where id=...`.
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
- **Plugin — limite noto v1: un solo admin per volta sulla sezione Plugin del
  progetto.** Il `PUT /api/projects/:id/plugins` sostituisce l'**insieme
  completo** delle abilitazioni **senza precondizione di versione**: se un admin
  spegne una skill e un altro — con la pagina aperta da prima — tocca una
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

## Integrazione Claude Code (MCP)

Stubwise si integra con Claude Code via il server MCP `@stubwise/mcp`
(`packages/mcp`, configurato in `.mcp.json`): espone backlog e ticket come tool.

- Skill **`stubwise`** (`.claude/skills/stubwise/`): quando e come usare i tool
  per collegare design/piani a backlog e ticket (crea voci di backlog dai doc,
  converti in ticket, avanza gli stati `in_progress`/`in_review`; `done` solo
  on-demand).
- Comando **`/stubwise:init`**: collega una o più repo a un progetto Stubwise
  scrivendo `.stubwise.json` (`{ "project": "<slug>" }`) nella radice.
- Comando **`/stubwise:run`**: prepara il ticket (design + piano + `in_progress`)
  e lancia l'esecuzione SUL worker con il tool `run_ticket` — l'implementazione
  la fa la pipeline, non la sessione locale (`/stubwise:start` è l'opposto:
  implementa in locale).
- **Ruoli (fase 0)**: `admin` = maintainer, `member` = operatore. Un run avviato
  da un operatore passa sempre dal gate di approvazione del piano (con piano
  salvato nasce `awaiting_plan_approval`, senza piano si ferma a piano pronto);
  solo un maintainer approva/rifiuta, e dopo l'approvazione l'esecuzione riparte
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
- Serve un Personal Access Token (`stw_pat_...`, dalle impostazioni Stubwise) in
  `STUBWISE_TOKEN`; `STUBWISE_URL` punta all'istanza (default
  `http://localhost:3000`). Il pacchetto è pubblicato su npm come
  `@stubwise/mcp`: `.mcp.json` lo avvia via `npx -y @stubwise/mcp` (nessun build
  locale necessario). Il pacchetto è autonomo a runtime (bundle, nessuna dep
  `workspace:` residua). Pubblicazione di nuove versioni: **automatica via
  Changesets** — aggiungi un changeset (`.changeset/*.md`), pusha, poi mergia la
  PR di versioning che il workflow `release.yml` apre/aggiorna (changesets/action,
  "chore: versiona i package rilasciabili") → al merge la CI esegue `pnpm
  changeset publish`. NON usare `npm publish` a mano (non risolve i
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
