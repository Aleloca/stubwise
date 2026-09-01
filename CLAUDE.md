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
- `packages/*` — `db` (Drizzle + Postgres/pgvector), `docs-engine`, `embeddings`,
  `git`, `i18n`, `notifications`, `sdk`, `shared`, `widget` (bundle embeddabile
  del customer service, servito come `/widget.js` da caddy).

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
- Verifica il bundle servito cercando una stringa nuova:
  `docker exec stubwise-caddy-1 sh -c 'grep -rl "<stringa>" /srv/web'`.
- Backup del DB prima di operazioni rischiose.

## Invarianti e trappole

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
