# Deploy: voci per fase e per rilascio

> Estratto da `CLAUDE.md` (14 ott 2026) per tenerlo sotto il limite di
> dimensione: il contenuto è invariato. I rimandi «sopra»/«sotto», «qui sopra»
> e «vedi la voce …» si riferiscono alla struttura originale: le voci di
> deploy stanno in `docs/operations/deploy-log.md`, le invarianti trasversali
> in `CLAUDE.md` (sezione «Invarianti e trappole»), quelle per area in
> `docs/invariants/*.md`.

Ogni voce dice cosa ribuildare, in che ordine, migrazioni, env, passi
manuali post-deploy e **rollback**. Leggi la voce pertinente PRIMA di un
deploy o di un rollback che la tocca.

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
  ⚠️ **Fino al fix del 2 ott 2026 la funzione non ha mai funzionato**: tutti i
  run che offrono `ask_user` (pianificazione, ripresa del piano, chat del
  backlog in modalità CODE) girano in `--permission-mode plan`, e in plan mode
  il CLI `claude` rifiuta ogni tool MCP che non si dichiari read-only, anche se
  è in `--allowedTools` («Cannot call mcp__stubwise_ask__ask_user while in
  plan mode.»). L'agente ripiegava decidendo da solo e nessuno se ne
  accorgeva: `agent_questions` in prod aveva zero righe. La correzione è
  `annotations: { readOnlyHint: true }` sul tool
  (`apps/worker/src/ask-user-mcp/server.ts`). Servono entrambe: l'allowlist da
  sola non basta in plan mode, e l'annotazione da sola fa chiedere al CLI un
  permesso che in `-p` nessuno concede. Rebuild del solo worker. Chi aggiunge
  un tool MCP a un run in plan mode lo annoti read-only, o non verrà mai
  chiamato.
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
  **non cambia**, quindi da lì la trappola della fase 4 sull'app mobile non
  passa — ci passava però da un'altra porta, `weeklyBriefEnabled` in
  `projectSchema`, che la review ha colto obbligatorio e che ora è
  `.default(false)`: vedi la regola generale in "Invarianti e trappole"), un
  `DROP NOT NULL` su
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
- **Fase 6 (Gmail e Calendar)**: rebuild **server+worker+caddy insieme**
  (migrazione 0069 all'avvio del server — nuovo valore `google.proposal`
  sull'enum `notification_kind` **in uno statement a sé**, come
  `project.pulse` in fase 2 e `project.brief` in fase 5 (vedi la trappola
  delle migrazioni batch qui sotto), sei tabelle NUOVE (`google_workspaces`,
  `google_accounts`, `oauth_states`, `project_email_routes`,
  `email_messages`, `calendar_events`), colonna
  `notification_settings.notify_google_proposal` (default `true`), colonna
  `agent_runs.email_message_id` col check allargato a
  `num_nonnulls(job_id, pr_review_id, email_message_id) = 1`, e il CHECK di
  `project_decisions.source` allargato a `email`; il worker nuovo è l'unico
  che ha il poller per-casella che sincronizza Gmail e Calendar, classifica i
  segnali e pubblica le proposte, il server nuovo l'unico che espone il
  registro Workspace, l'OAuth delle caselle, il routing per progetto e la
  pagina Posta, il bundle nuovo l'unico che disegna Impostazioni → Google,
  Account → Caselle Google, la sezione «Posta» del progetto e `/mail`). Env
  nuove sul worker: `GMAIL_POLL_MINUTES` (default 5, **0 = spento — è il
  rollback innocuo**: nessuna casella viene più sincronizzata),
  `GMAIL_MODEL` (default `haiku` — la classificazione è un run di solo
  testo, senza tool, su una directory vuota: il modello piccolo basta),
  `GMAIL_RETENTION_DAYS` (default 90, giorni di conservazione dei messaggi in
  stato TERMINALE — `actioned`/`ignored`/`failed` — oltre i quali il poller
  li cancella; `proposed` non si tocca mai, è una card ancora aperta in una
  inbox; 0 = nessuna potatura) e `GMAIL_MAX_PER_TICK` (default 20, tetto di
  messaggi classificati per casella per giro — il tetto di spesa). **Nessun
  toggle per progetto per Google in sé**: un admin deve registrare almeno un
  Google Workspace (Impostazioni → Google) prima che chiunque possa
  collegare una casella; le regole di routing per progetto (sezione «Posta»
  nel dettaglio progetto) sono opt-in per costruzione — **nessuna regola =
  nessun messaggio in perimetro per quel progetto**, il pre-filtro scarta il
  messaggio prima ancora di scaricarne il corpo. **Rollback — due livelli,
  come le fasi 2 e 5**: (1) `GMAIL_POLL_MINUTES=0` ferma la sincronizzazione
  senza toccare schema né immagini — è la strada innocua, e le caselle
  restano collegate, pronte a ripartire da dove erano; (2) *scendere di
  immagine sul server* **NON è sicuro** finché in `notifications` esiste
  anche UNA riga con `kind='google.proposal'`, **incluse quelle già
  gestite**: stesso identico problema di `project.pulse` in fase 2 e
  `project.brief` in fase 5 — `notificationKindSchema` è un enum chiuso, il
  binario vecchio non conosce quel valore, `inboxPageSchema` fa fallire la
  serializzazione e salta **tutta `/api/inbox` con un 500**, non una card
  degradata. Va eliminata prima (`delete from notifications where
  kind='google.proposal';`, o spostata in una tabella d'appoggio — segnarla
  gestita NON basta, la tab "Gestite" le rilegge tutte). **Post-deploy
  (maintainer)**: creare l'app OAuth interna in ogni Google Workspace
  dell'organizzazione (guida utente in `apps/docs`, «Integrations → Google
  Workspace»), registrarla in Impostazioni → Google, poi ogni utente collega
  la propria casella da Account → Caselle Google e un maintainer di progetto
  configura le regole di routing sui progetti che devono ricevere posta.
- **Fase 6b (un'email, più progetti)**: rebuild **server+worker+caddy
  insieme** (migrazione 0070 all'avvio del server — una tabella NUOVA
  `email_proposals` (stato e claim PER RIGA, unique `(email_message_id,
  project_id)`), colonna `email_messages.scope_project_ids uuid[]` NOT NULL
  default `{}` (il perimetro completo dei progetti che combaciano, non solo
  il vincitore), backfill nella stessa migrazione delle righe esistenti in
  `classified`/`proposed` con `project_id` non nullo verso una riga figlia
  equivalente — in prod oggi zero messaggi ingeriti, ma la migrazione resta
  corretta per il caso con dati; nessun enum nuovo, un solo batch. Il worker
  nuovo è l'unico che scrive/legge i figli e applica il tetto sul fan-out, il
  server nuovo l'unico che sa eseguire una proposta per riga figlia (claim
  indipendente) e servire la pagina Posta per proposta). **Modello
  cambiato**: un'email che tocca N progetti (il PERIMETRO completo del
  routing — `scopeProjectIds` in
  `packages/notifications/src/email-routing.ts`, tutti i progetti con
  `matchedRuleCount > 0`, non solo il vincitore né solo i pari merito) genera
  N proposte INDIPENDENTI, una per progetto (`email_proposals`), ciascuna col
  proprio ciclo di conferma — non più una sola proposta sul "vincitore", con
  tutto il resto perso in silenzio. Il **calendario resta uno a uno**: un
  evento produce sempre e solo una proposta (`calendar_events`, non toccata
  da questa fase, ancora vincitore/parità → progetto ambiguo). Env nuova sul
  worker: `GMAIL_MAX_PROJECTS_PER_MESSAGE` (default **5**,
  `apps/worker/src/config.ts`, tetto sul fan-out applicato DOPO la
  partizione per progetto — senza, una mail in copia a dieci progetti
  genererebbe dieci card; sopravvivono i progetti con più proposte valide).
  **Retention consapevole dei figli** (`pruneOldEmails`,
  `apps/worker/src/google/poller.ts`): un messaggio è potabile solo quando
  (1) è stato almeno classificato (`status <> 'new'`: un messaggio mai
  guardato non ha mai potuto avere figli), (2) OGNI figlio è terminale
  (`actioned`/`ignored`/`failed`, e l'insieme vuoto — nessun figlio —
  soddisfa banalmente la condizione) e (3) NESSUN figlio ha una notifica
  ancora aperta (`status <> 'handled'`) — quest'ultima è difesa in
  profondità, non un controllo ridondante: non si fida dell'ordine con cui
  `dispatchAction` chiude la notifica prima di scrivere lo stato terminale
  sul figlio, lo riverifica riga per riga. La soglia resta su `updated_at`
  DEL PADRE (toccato a ogni chiusura di un figlio); la cascata (`ON DELETE
  CASCADE` su `email_proposals.email_message_id`) pota i figli insieme al
  padre, nessuna azione applicativa in più. **`choose_project` deprecata in
  generazione**: il fan-out risponde già alla domanda "di quale progetto è
  questa mail", quindi non è più prodotta per le proposte nuove; resta
  ESEGUIBILE solo sulle card pubblicate PRIMA di questa fase
  (`apps/server/src/services/google-proposal.ts`, caso `"choose_project"` in
  `dispatchAction`) — confermarla chiude il figlio corrente (quello del
  progetto ambiguo/sbagliato) con un outcome `reassigned_project`, ma
  **deliberatamente NON sposta** `email_proposals.project_id` sul progetto
  scelto (violerebbe l'unique `(email_message_id, project_id)` se il fan-out
  ha già creato quella riga) e **deliberatamente NON tocca più**
  `email_messages.status`: la versione pre-6b lo rimetteva a `'new'`,
  riclassificando l'intero messaggio e azzerando le proposte sorelle ancora
  aperte — esattamente ciò che questa fase impedisce a tutte le altre azioni
  terminali. **Rollback**: nessun kind di notifica nuovo, nessun valore
  aggiunto a un enum esistente — la 6b non aggrava il problema già noto di
  `google.proposal` (fase 6 qui sopra: la riga va sempre svuotata prima di
  scendere di immagine sul server). C'è però un problema NUOVO e specifico
  alla 6b, verificato leggendo `findSourceRow` in entrambe le versioni (prima
  e dopo il commit che introduce `email_proposals`): per una proposta EMAIL
  pubblicata DOPO il deploy della 6b, il binario vecchio cerca la notifica su
  `email_messages.proposal_notification_id` — colonna che il codice nuovo
  lascia NULL per un messaggio con figli (la scrive solo su
  `email_proposals.proposal_notification_id`, sul figlio) — non trova nulla,
  e `answerGoogleProposal` risponde `proposal_stale`, la stessa risposta di
  una proposta già presa da qualcun altro: nessun crash, nessun 500, solo una
  card che il binario vecchio non sa più confermare finché non si torna
  avanti (vanno chiuse a mano o si accetta di perderle). La lista/lettura
  (`GET /api/inbox`, `/mail`) non ne risente: lo schema dell'evento non è
  `.strict()`, il campo `projectId` in più che la 6b aggiunge al payload
  viene semplicemente ignorato dal binario vecchio. Il **calendario non è
  toccato** da questo problema: `calendar_events` scrive ancora
  `proposalNotificationId` direttamente sulla riga, identico prima e dopo la
  6b.
- **Fase 6c (ammissione della posta separata dall'attribuzione)**: rebuild
  **server+worker+caddy insieme** (migrazione 0071 all'avvio del server —
  TRE colonne nuove sul singleton `instance_settings`, tutte con default,
  nessun enum e nessuna tabella, un solo batch:
  `email_admit_workspace_domains boolean` default `true`,
  `email_admission_deny_labels text[]` default
  `{CATEGORY_PROMOTIONS,CATEGORY_SOCIAL,SPAM}`,
  `email_admission_deny_automated boolean` default `true`; il worker nuovo è
  l'unico che chiama `admit()` nel poller e passa il perimetro vuoto a tutti
  i progetti in classificazione, il server nuovo l'unico che espone `GET`/
  `PATCH /api/settings/mail-admission`, il bundle nuovo l'unico che disegna
  la sezione «Posta ammessa» in Impostazioni → Google e la copy corretta
  nella sezione Posta del progetto). **Modello cambiato**: l'ingresso di
  un'email nel sistema (**ammissione**, a livello di istanza — «è lavoro?»)
  è ora separato da dove va (**attribuzione**, a livello di progetto — «di
  quale progetto parla?»). `admit()` è una funzione pura nuova
  (`packages/notifications/src/email-routing.ts`); `matchRoutes` è
  **invariata** e resta la sola attribuzione. `inScope` (il campo che prima
  faceva da ammissione, `EmailRoutingResult.inScope`) è marcato
  `@deprecated` nel docblock ma **non rimosso**: lo usa ancora il
  **calendario** (`apps/worker/src/google/poller.ts`, che non ha
  ammissione, solo attribuzione) — verificato leggendo il sorgente, non
  assunto. Nel poller, il pre-filtro sui metadati chiama `admit(...)` invece
  di guardare `matchRoutes(...).inScope`; `matchRoutes` resta dov'era, dopo
  il download del corpo. **L'ordine di `admit()`, corretto il 17 set 2026 —
  scavalca il cancello solo chi ha nominato QUALCUNO**: (1) una regola che
  nomina un INTERLOCUTORE (`sender_address`, `sender_domain`, `gmail_label`)
  ammette SUBITO, esclusioni comprese — è la decisione dell'8 set, e per un
  mittente regge: un cliente che scrive dal suo ticketing, `List-Unsubscribe`
  incluso, deve arrivare; (2) le esclusioni (etichetta in `denyLabels`, poi —
  se `denyAutomated` — gli header `List-Unsubscribe`/`List-Id`/`Precedence:
  bulk|list|junk`/`Auto-Submitted` diverso da `no`); (3) superate quelle,
  ammettono le `keyword` e il dominio di lavoro (il mittente O un destinatario
  in `to`/`cc` su un Workspace registrato, escluso il dominio della casella
  ricevente); altrimenti `no_match`.
  ⚠️ **Una `keyword` NON è più fra quelle che scavalcano**, e la riga di prima
  («qualunque regola di progetto ammette subito») è falsa dal 17 set. Il
  motivo è misurato, non teorico: una keyword non nomina un interlocutore,
  descrive un CONTENUTO, e il contenuto lo scrive chiunque. In produzione 21
  delle 41 regole erano `keyword`, e l'oggetto di ogni notifica GitHub porta
  il nome del repository (`[Aleloca/stubwise] Run failed: CI`) — risultato: 23
  delle 37 proposte aperte erano notifiche automatiche, col cancello
  anti-automatico ACCESO e `looksAutomated` che riconosceva gli header giusti
  ma non li guardava mai per quei messaggi. `admit` gira sui soli METADATI,
  quindi una keyword può combaciare solo nell'OGGETTO: esattamente dove una
  macchina scrive il nome del progetto.
  Due dettagli di implementazione da non «semplificare»: il filtro esclude la
  sola `keyword` (`route.kind !== "keyword"`) e **non elenca i tipi ammessi**,
  così un tipo nuovo scavalca per default — il comportamento storico — e chi
  lo aggiunge deve declassarlo di proposito; e `matchRoutes` **non è stata
  toccata** né `EmailRoutingResult` ha un campo nuovo: la distinzione si fa
  filtrando le regole PRIMA di chiamarla, perché il calendario la usa con
  TUTTE le regole per la sua attribuzione e non deve accorgersi di niente.
  **Il caso nuovo — proposta di smistamento** (Task 5, il più delicato):
  quando un messaggio è ammesso ma il perimetro derivato da `matchRoutes`
  è VUOTO, `classify.ts`/`loadContext` non degrada più a "niente da
  proporre": i candidati diventano TUTTI i progetti dell'istanza (col
  contesto capato alle stesse righe per progetto di sempre) e la
  classificazione decide. Verificato leggendo `writeClassification`: **non
  sono due esiti, sono TRE, e la biforcazione non è semplicemente "perimetro
  vuoto"** — è una DEVIAZIONE deliberata dal testo del piano originale,
  documentata nel codice stesso:
  1. `classification.signal === 'none'` → `ignored`, invariato;
  2. `signal !== 'none'` ma un progetto era GIÀ risolto da `matchRoutes`
     senza ambiguità (`resolvedProjectId !== null`) e zero proposte
     sopravvivono alla rivalidazione → **`ignored`, non smistamento**: la
     proposta di smistamento chiederebbe "a quale progetto appartiene?"
     quando la risposta è già certa, il che non avrebbe senso — è lo stesso
     esito di prima della fase, solo la motivazione a valle è diversa (un
     ticket citato inesistente, una data già passata…);
  3. `signal !== 'none'` E nessun vincitore (`resolvedProjectId === null`:
     perimetro vuoto da ammissione senza regole, O regole in parità) →
     **nuovo**: il padre resta `classified` **senza creare nessun figlio**
     (`email_proposals`), con `email_messages.classification` in una forma
     DIVERSA — un'unione discriminata sullo stesso campo jsonb — marcata dal
     campo `triage: true` (`EmailTriageClassification` in `classify.ts`,
     verbatim: non è un valore di enum né uno stato nuovo, solo una forma
     diversa dello stesso jsonb, letta in modo tollerante da chi la
     rilegge). Porta `suggestedProjectIds` (fino a 3, i progetti che le
     proposte SCARTATE nominavano — può essere vuoto). Il poller
     (`runProposePhase`) seleziona questi padri al giro successivo e
     costruisce la proposta di smistamento (`buildTriageProposalEvent` in
     `apps/worker/src/google/proposal.ts`) **sul messaggio padre**, riusando
     `email_messages.proposal_notification_id` (rimasto libero per la posta
     dopo il fan-out della 6b): fino a 3 progetti suggeriti più «nessuno di
     questi». Scegliere «nessuno di questi» non è un `ignored` generico:
     l'`outcome` del padre porta `{ type: "triage_dismissed" }`, distinguibile
     in lettura da un `ignored` per mancanza di segnale (`outcome: null`).
  **`choose_project` — due semantiche DIVERSE, verificate leggendo
  `apps/server/src/services/google-proposal.ts` (il case `choose_project`
  in `dispatchAction`, e `ProposalSource.source`, un'unione a tre valori
  `"email" | "calendar" | "email_triage"`, non due)**:
  - `source.source === "email_triage"` (la proposta di smistamento, il
    PADRE) — **VIVA**: attribuisce il messaggio (`projectId` **e**
    `scopeProjectIds = [projectId]`, un perimetro di UN solo progetto) e lo
    **rimette in coda** (`status: "new"`, `proposal_notification_id: null`),
    NON lo chiude con `markSourceOutcome` — il prossimo tick lo riclassifica
    con un vincitore risolto, e da lì nascono le proposte vere (fase 6b);
  - `source.source === "email"` (una proposta FIGLIA, fase 6b, storica) —
    resta **DEPRECATA in generazione** come deciso in 6b: comportamento
    INVARIATO, chiude solo il figlio corrente con l'esito
    `reassigned_project`, non sposta `email_proposals.project_id`, non
    tocca `email_messages.status`. Eseguibile solo su card pubblicate PRIMA
    della 6b.
  - `source.source === "calendar"` non genera mai questa azione: lanciare
    lì sarebbe un'anomalia, non un `target_gone`.
  **Le tre difese di costo** (Task 6, `apps/worker/src/google/classify.ts`,
  funzione `classifyNewMessages`, in quest'ordine): (1) **`GMAIL_MAX_PER_DAY`**
  (default 200, per casella, 0 = nessun tetto) — contato dai run
  `agent_runs` (`email_classify`) delle ultime 24 ore per quella casella,
  un controllo UNA VOLTA prima di guardare qualunque messaggio: raggiunto,
  la classificazione si ferma per quella casella con una riga di log, i
  messaggi `new` restano `new` e sono ripresi il giorno dopo; (2) il **gate di budget
  mensile** — la STESSA verifica già usata dai fix
  (`instance_settings.monthly_budget_usd`, `monthlyCostUsd` di
  `@stubwise/db`), applicata ORA anche alla classificazione email: chiude un
  difetto preesistente per cui la posta erodeva il budget dei fix senza
  esserne mai frenata; (3) **`GMAIL_THREAD_COOLDOWN_MINUTES`** (default 60,
  0 = disattivato) — un controllo PER MESSAGGIO dentro il loop: un thread
  già classificato nella finestra viene saltato (resta `new`) e il ciclo
  passa al successivo, così un thread attivo non blocca la coda.
  **Rollback**: `PATCH /api/settings/mail-admission` (admin) con
  `admitWorkspaceDomains: false` riporta l'ammissione al comportamento
  della fase 6/6b (solo le regole di progetto ammettono) senza toccare
  schema né immagini — è la strada innocua, verificata in
  `admit()`/`settings.test.ts` ("interruttore spento"). **Scendere di
  immagine sul server ha un rischio NUOVO e specifico alla 6c**, verificato
  leggendo `findSourceRow` prima e dopo il commit che introduce il Task 5
  (non assunto): quella funzione, per una proposta di smistamento
  (`source: "email_triage"`) pubblicata DOPO il deploy della 6c, aggiunge
  una SECONDA query — assente in ogni binario precedente, 6b incluso — che
  cerca la riga su `email_messages.proposal_notification_id`. Un binario
  pre-6c prova solo `email_proposals` (vuota: il padre di uno smistamento
  non ha figli) e poi `calendar_events` (vuota), non trova nulla, e
  `answerGoogleProposal` risponde `proposal_stale` — la stessa risposta di
  una proposta già presa da qualcun altro: nessun crash, nessun 500, solo
  una card di smistamento che il binario vecchio non sa più confermare
  finché non si torna avanti. È la STESSA famiglia di trappola della
  `proposal_stale` già documentata in fase 6b, con la stessa causa di fondo
  (una query nuova che il binario vecchio non ha) ma un punto di innesco
  diverso (qui è la SECONDA query di `findSourceRow`, non la prima). Il
  **calendario non è toccato**: `calendar_events` scrive ancora
  `proposalNotificationId` direttamente sulla riga, identico a prima della
  6c.
- **Fase 7 (workflow guidato web per non-tecnici)**: rebuild
  **server+worker+caddy insieme** (migrazione 0072 all'avvio del server —
  additiva, **nessun enum nuovo**, un solo batch: tre colonne su `tickets`
  (`plan_approved_at`, `plan_approved_by_user_id` FK→users ON DELETE SET
  NULL, `plan_approved_digest`), una colonna nullable su `ai_jobs`
  (`failure_summary`), una tabella NUOVA `backlog_questions` con indice
  unico parziale sulla domanda APERTA per voce (`answered_at IS NULL AND
  dismissed_at IS NULL`) e un CHECK che lega `answer`/`answered_at`; il
  worker nuovo è l'unico che sa parcheggiare/riprendere un turno di chat sul
  backlog fermo su una domanda `ask_user` e generare il riassunto di un job
  fallito, il server nuovo l'unico che espone le rotte di pre-approvazione e
  le domande di backlog — e l'unico a cui sei rotte del backlog (viste,
  refresh, deep dive, merge, suggeriti) rispondono per un `member`, non solo
  per un admin —, il bundle nuovo l'unico che disegna il bottone
  "Approva in anticipo", il pannello a bottoni nella chat del backlog, la
  riga "passo successivo" e la vista polso in `/projects`). **Nessuna env
  nuova**: il riassunto del fallimento riusa `SUMMARIES_ENABLED`/
  `SUMMARY_MODEL` (stesso interruttore di `plan_summary`), e il tetto di
  domande per turno riusa `AGENT_QUESTION_MAX_ROUNDS` (fase 1) — contato
  però sulle domande della VOCE di backlog, non del job (qui il job cambia a
  ogni turno di chat, contarci sopra darebbe sempre 1).
  **Pre-approvazione del piano**: un maintainer approva in anticipo il piano
  CORRENTE di un ticket (`POST`/`DELETE /api/tickets/:id/pre-approve-plan`),
  così un operatore può far partire il fix senza fermarsi sul gate. **Non è
  un interruttore**: `plan_approved_digest` è lo SHA-256 del piano al
  momento dell'approvazione (`planDigest`, `packages/db/src/plan-digest.ts`)
  e il gate (`jobs.ts`, `needsApproval = (actor.role === "member" &&
  !planPreApproved) || input.requirePlanApproval === true`) confronta quel
  digest col piano ATTUALE — qualunque riscrittura del piano (rifiuto,
  rilancio con istruzioni, ripianificazione) fa decadere l'approvazione da
  sola, senza bisogno di azzerarla esplicitamente. `requirePlanApproval`
  (i run nati da una proposta pulse) vince SEMPRE, anche su un piano
  pre-approvato: chi clicca "Procedi" non ha letto un piano specifico.
  **Domande a bottoni ancorate alla voce di backlog**: `backlog_questions`
  è un GEMELLO deliberato di `agent_questions` (fase 1), non condiviso —
  niente `job_id`/`ticket_id` NOT NULL, perché una voce non convertita non
  ha né l'uno né l'altro — con un'uscita in PIÙ: `dismissed_at` ("non ora"),
  perché qui una domanda può chiudersi SENZA risposta, cosa che
  `agent_questions` non prevede. Solo la modalità **CODE** della chat del
  backlog pone domande a bottoni (ha già l'infrastruttura MCP `ask_user`);
  la modalità DOCS resta testo libero — richiederebbe di cambiare il
  trasporto SSE, rinviato. Le domande si chiudono automaticamente (nessuna
  resta aperta a orfana) alla conversione in ticket e all'archiviazione
  della voce.
  **Il passo successivo è DETERMINISTICO, mai generato**: la riga "cosa fare
  adesso" sotto la voce di backlog convertita (`work-next-step.tsx`,
  `deriveNextStep`) è una funzione pura sullo stato di item/job — un
  `Record` esaustivo, non un prompt. Una frase sbagliata su cosa fare dopo è
  peggio di nessuna frase.
  **Navigazione filtrata per ruolo**: Monitor e Repository sono fuori dal
  MENU per un `member` (`app-layout.tsx`, `NAV_ITEMS[].memberVisible`) —
  contenuto d'infrastruttura che un operatore non tecnico non usa mai.
  **Nascosto dal menu ≠ inaccessibile**: nessuna guardia `beforeLoad` sulle
  due rotte indice — un member che ci arriva per URL diretto (un link
  mandato da un collega, quello che le notifiche di monitoraggio emettono
  verso `/monitor/servers/:id`) le vede ancora, in sola lettura, come prima
  di questa fase. Il problema che questa fase risolve è rumore visivo (non
  far inciampare in una voce che è un vicolo cieco), non un problema di
  superficie — solo le AZIONI di scrittura restano guardate
  (`/repositories/new`, preesistente). **Impostazioni resta visibile a un
  member**, apposta: la sua sotto-nav (`routes/settings/layout.tsx`) filtra
  già per ruolo (un member vede solo Account/Access tokens/Google, tre
  pagine PERSONALI — preferenze di notifica, PAT, casella Google), e non
  esiste un altro punto d'accesso nella UI (l'Avatar in sidebar è
  decorativo). Toglierla avrebbe reso irraggiungibile roba che serve a un
  member quanto a un admin: il criterio non era "meno voci ai member", era
  "niente porte chiuse".
  **Rollback — sicuro**: nessun `notification_kind` nuovo e nessun valore
  aggiunto a un enum esistente (a differenza di `project.pulse`,
  `project.brief`, `google.proposal` nelle fasi 2/5/6), quindi scendere di
  immagine sul server non richiede di ripulire righe prima. Una domanda di
  backlog rimasta aperta (`backlog_questions`) su un binario vecchio
  semplicemente non verrebbe più mostrata né risposta — inerte, non un 500
  — finché non si torna avanti; un piano pre-approvato resta tale in
  colonna, ma un binario vecchio non lo consulta né lo mostra.
- **Fase 7b (Posta e Calendario dentro la piattaforma)**: rebuild
  **server+worker+caddy insieme** (migrazione 0073 all'avvio del server —
  additiva, **nessun `ALTER TYPE`**, un solo batch: colonna
  `calendar_events.recurring_event_id` nullable e tabella NUOVA
  `calendar_series`, chiave `(account_id, recurring_event_id)`, `enabled`
  default `false`; il worker nuovo è l'unico che riconosce le serie
  (`recurringEventId`/`originalStartTime` ora nella normalizzazione di
  `@stubwise/google`), applica anche in SCRITTURA la finestra dei 60 giorni
  (non solo in lettura — è il fix dell'incidente), fa rispettare la
  configurazione della serie a `isReadyForProposal` e — per una serie
  `auto: true` — esegue l'azione subito dopo la publish
  (`apps/worker/src/google/calendar-auto.ts`); il server nuovo l'unico che
  espone `/api/me/calendar` (appuntamenti visti, serie, PUT/DELETE di
  configurazione) e le due rotte nuove di `/api/me/mail`
  (`GET /:source/:id` per il dettaglio dall'estratto, `GET
  /:source/:id/original` per la rilettura da Gmail); il bundle nuovo l'unico
  che disegna `/calendar` e `/mail/:source/:id`. **Nessuna env nuova**.
  **Nessun kind di notifica nuovo e nessun valore nuovo in
  `ProposalSource.source`** (le proposte di serie riusano `google.proposal`
  con `source: "calendar"`, l'azione la dice `calendar_series.action` letta
  dalla riga): a differenza delle fasi 2/5/6, scendere di immagine sul
  server non richiede di ripulire righe prima, nessuna trappola del 500 su
  `/api/inbox`. **Rollback**: la strada innocua per fermare le serie è
  spegnerle dalla UI — sono comunque spente di default al deploy, quindi
  nessuna serie esistente si accende da sola scendendo o salendo
  d'immagine. `GET /api/me/mail/:source/:id/original` che fallisce
  (token scaduto, messaggio cancellato, Google irraggiungibile) non tocca
  mai l'estratto già in database: resta leggibile in ogni caso. ⚠️ Questo
  non significa che nessun enum sia cambiato: `acknowledge_reminder` è un
  valore NUOVO su due enum chiusi minori, gemelli fra loro —
  `inboxGoogleActionTypeSchema` (`packages/shared/src/schemas/
  notification.ts:213`) e `storedActionSchema`
  (`apps/server/src/services/google-proposal.ts:178`) — stessa famiglia di
  trappola di `choose_project`/`triage_dismissed` nelle fasi 6b/6c, ma **non**
  la classe del 500 su `/api/inbox`: entrambi i punti di lettura degradano
  con `safeParse`. Una proposta di serie con `action: "reminder"` pubblicata
  DOPO il deploy, letta da un binario PRE-7b: `readGoogle`
  (`apps/server/src/services/inbox.ts`) torna `undefined` sul blocco di
  dettaglio (la card resta visibile, solo senza contorno) e
  `answerGoogleProposal` risponde `proposal_stale` alla conferma — nessun
  crash, ma quelle card vanno chiuse a mano o si accetta di perderle finché
  non si torna avanti.
- **Fase 8 (ambienti e coda di rilascio)**: rebuild **server+worker+caddy
  insieme** (migrazione 0074 all'avvio del server — additiva, **nessun
  `ALTER TYPE`**, un solo batch, ma **CON BACKFILL**, non cosmetica: tabella
  NUOVA `project_environments` (`kind` CHECK `test|staging|production`, un
  CHECK e non un pgEnum per restare in un solo batch — stesso pattern di
  `calendar_series.action` in fase 7b) più un ambiente `test` inserito per
  OGNI progetto esistente; colonna `project_env_files.environment_id`
  (FK cascade, NOT NULL dopo un secondo backfill che collega ogni riga
  esistente all'ambiente `test` del progetto del proprio repository — sono
  le 20 repository con `.env` già popolati che la pipeline di fix legge a
  ogni run: senza il backfill resterebbero orfane e i fix inizierebbero a
  fallire per variabili mancanti), unique index cambiato in
  `(repository_id, environment_id, path)`; due colonne nullable su
  `ticket_repositories` — `test_status` (CHECK `passed|failed|skipped`) e
  `risk`/`risk_reason` (CHECK `low|medium|high`). Il worker nuovo è l'unico
  che sa scrivere `test_status`/`risk` all'apertura di una PR e l'unico il
  cui `loadProjectEnvFiles` accetta un ambiente (tipato sul solo letterale
  `"test"`, e riverificato a runtime); il server nuovo l'unico che espone
  `/api/projects/:id/environments` (CRUD, letture per ogni utente
  autenticato — non sono un segreto, a differenza dei valori dei file
  d'ambiente — scritture `requireAdmin`), `GET /api/release-queue` e
  `POST /api/tickets/:id/repositories/:repositoryId/release`; il bundle
  nuovo l'unico che disegna la sezione ambienti del progetto e `/release`.
  **Nessuna env nuova**. **Nessun kind di notifica nuovo**: `/release` non è
  raggiunta da inbox — vedi il Task 10 più sotto — quindi non esiste
  l'equivalente del 500 su `/api/inbox` delle fasi 2/5/6/6c.
  **Questa fase costruisce la capacità di mergiare, che prima non esisteva**:
  vedi "I due divieti dell'operatore" più sotto, punto 2 — non è più vero
  per ASSENZA di funzionalità, ora è un cancello vero (`requireAdmin` sulla
  rotta di rilascio E ricontrollato dentro `releasePullRequest`, difesa in
  profondità come `preApprovePlan`). **Stubwise non fa deploy, in nessun
  caso**: l'unica azione è il merge della PR; ambienti e "già su staging"
  restano pura anagrafica, mai eseguita (vedi l'invariante nuova più sotto).
  Dopo un merge, `releasePullRequest` **non tocca `ticket_repositories`**:
  il webhook del provider (fase 3, preesistente) chiude già il ticket e
  pubblica `job.pr_closed`, la stessa strada di un merge fatto a mano —
  scriverlo anche qui aprirebbe una corsa fra due writer indipendenti.
  **"Già su staging?" (`deployedOn`) è una euristica volutamente
  conservativa**: confronta la head della PR letta dal provider (la stessa
  lettura dei check) col commit che l'agente di monitoraggio riporta come in
  esecuzione sull'ambiente, con `sameCommit`
  (`apps/server/src/services/release.ts`). ⚠️ **Corretto il 1 ott 2026**
  (correzioni post-PR): prima era `headSha.startsWith(commitSha)` — un verso
  solo, maiuscole distinte, nessuna lunghezza minima, e un `commitSha` vuoto
  combaciava con TUTTO. Ora il confronto è per prefisso **in entrambi i
  versi** (Bitbucket salva head abbreviate, GitHub complete, l'agente quello
  che il deploy gli dice), **senza distinguere maiuscole**, con **almeno 7
  caratteri** per parte (`MIN_SHA_PREFIX`), e un valore assente o troppo
  corto **non combacia**: chi chiama non afferma niente. È la stessa regola
  di `reviewStale` (verdetto su codice superato): UNA per la coda di
  rilascio. Un mancato match significa
  "non risulta", mai "sicuramente non rilasciato" — l'assenza è un array
  vuoto, mai un booleano che afferma un negativo che Stubwise non può
  verificare. **Post-deploy**: nessun passo obbligatorio — al deploy ogni
  progetto esistente riceve solo il suo ambiente `test` (dal backfill), e la
  coda parte vuota finché non ci sono PR aperte; un admin aggiunge
  `staging`/`production` dalla sezione ambienti del progetto quando vuole
  che Stubwise sappia dove sono (mai che li esegua). **Rollback — sicuro sul
  server, ATTENZIONE sul worker**: (1) scendere di immagine sul server è
  innocuo per `/api/inbox` (nessun kind nuovo) ma **rompe `/release` e la
  sezione ambienti** (404 sulle rotte nuove) — va sceso insieme al caddy,
  come sempre; le righe di `project_environments`/`ticket_repositories.risk`/
  `.test_status` sopravvivono, innocue, e il migratore ignora la 0074 già
  applicata. (2) scendere di immagine sul **worker** è più delicato di una
  fase additiva qualunque: un worker vecchio non conosce l'ambiente come
  parametro di `loadProjectEnvFiles` e la sua build precedente non ha
  l'invariante "solo `test`" — ma dato che quell'invariante è imposta dal
  TIPO più un controllo a runtime nello stesso file, e la funzione non è
  mai stata chiamata con altro che `"test"` prima di questa fase, un worker
  precedente continua semplicemente a comportarsi come prima (nessuna
  regressione, solo assenza della funzionalità nuova).
- **Fase 9 (Posta e Calendario che si guardano volentieri)**: rebuild
  **server+worker+caddy insieme** (migrazione 0075 all'avvio del server —
  additiva, **nessun `ALTER TYPE`**, un solo batch, ma **CON BACKFILL e con
  un vero cambio di tipo** su una colonna esistente, non solo un'aggiunta:
  `calendar_events.attendees` passa da `text[]` (sole email) a `jsonb`
  (`{email, responseStatus}[]`) sulle 1553 righe di produzione — stesso
  modello nullable→backfill→NOT NULL della 0074, ma con drop della colonna
  vecchia e rename della nuova alla fine, perché qui la FORMA cambia, non
  solo il vincolo; `responseStatus` backfillato a `NULL` per ogni riga
  storica (mai stato conservato, non ricostruibile); più una colonna nuova
  nullable `html_link`, additiva). Il worker nuovo è l'unico che riconosce
  `responseStatus`/`htmlLink` nella normalizzazione di `@stubwise/google` e
  li scrive nell'upsert di `calendar_events`
  (`apps/worker/src/google/poller.ts`), guarda **anche 30 giorni indietro**
  oltre ai 60 avanti (`CALENDAR_LOOKBACK_DAYS`, `apps/worker/src/google/
  calendar.ts`) sia in lettura sia nel calcolo della finestra di poll; il
  server nuovo l'unico che espone `GET /api/me/calendar/range` (un
  intervallo `[from,to)` con tetto `MAX_RANGE_DAYS=100`,
  `apps/server/src/routes/me-calendar.ts`) e che sanifica lato server il
  corpo HTML di un'estratto email (`sanitizeEmailHtml`, `@stubwise/google`,
  su `GET /api/me/mail/:source/:id/original` — **calcolato per quella sola
  risposta e mai scritto su una riga**, verificato leggendo la rotta: nessun
  `UPDATE`/`INSERT` lo tocca); il bundle nuovo l'unico che disegna la posta
  a tre colonne e la griglia giorno/settimana/mese di `/calendar`, col
  pannello di dettaglio (partecipanti con stato di risposta, link
  all'evento, e — se l'appuntamento appartiene a una serie — la
  configurazione della serie, spostata lì dall'elenco separato della 7b).
  **Nessuna env nuova**. **Nessun kind di notifica nuovo e nessun valore
  nuovo in un enum esistente**: le proposte di serie continuano a riusare
  `google.proposal`/`source: "calendar"` come dalla 7b, quindi — a
  differenza delle fasi 2/5/6/6c — non c'è l'equivalente del 500 su
  `/api/inbox`. **Il task che avrebbe spostato `inScope` dall'ingestione
  alla proposta è stato RITIRATO in corso di progettazione** (era il task
  più rischioso: avrebbe potuto trasformare ogni appuntamento personale in
  una proposta, la stessa famiglia dell'incidente del 9 settembre 2026) —
  l'ingestione del calendario resta quella della 7b, non toccata da questa
  fase.
  **Rollback — un rischio NUOVO rispetto a ogni fase additiva precedente,
  proprio per il cambio di tipo su `attendees`, e per la PRIMA VOLTA nel
  programma una migrazione che DROPPA una colonna**: scendere di immagine
  sul **worker** dopo la 0075 non è sicuro come nelle fasi puramente
  additive — un worker precedente dichiara ancora `attendees` come
  `text().array()` (via drizzle), e quella colonna ora è `jsonb`. **In
  SCRITTURA il fallimento è RUMOROSO, ed è la notizia buona**: l'upsert su
  `calendar_events` (`apps/worker/src/google/poller.ts`) fallisce con un
  errore Postgres esplicito (`column "attendees" is of type jsonb but
  expression is of type text[]`) — Postgres non offre un cast implicito fra
  array e jsonb — quindi la sincronizzazione del calendario si ferma con un
  errore in log, non scrive mai dati nel formato sbagliato. **In LETTURA**
  la descrizione precedente resta esatta: un binario vecchio che LEGGA la
  colonna (`apps/worker/src/google/calendar.ts`,
  `apps/server/src/routes/me-calendar.ts`) riceve oggetti `{email,
  responseStatus}` dove il suo codice si aspetta stringhe — un uso scorretto
  del dato (routing calcolato su un valore che non è più l'indirizzo email),
  non un crash. Non è la stessa classe di rischio delle fasi 2/5/6/6c
  (nessun 500 su `/api/inbox`), ma resta un motivo per **non** scendere di
  immagine sul worker dopo questa fase: la sincronizzazione del calendario
  si ferma (rumorosamente) finché non si torna avanti. **Deploy PARZIALE —
  per la prima volta nel programma, non è solo incompletezza, è
  correttezza**: "server+worker+caddy insieme" nelle fasi additive
  precedenti significava "funzionalità nuova incompleta se dispari"; QUI
  significa che un deploy del **solo server** lascia il worker VECCHIO in
  esecuzione contro uno schema che quel worker non sa più scrivere — lo
  rompe attivamente, rumorosamente, dal momento in cui la 0075 viene
  applicata, non da un futuro rollback. Scendere di immagine sul **server**
  resta sicuro per `/api/inbox` (nessun enum toccato) ma perde `/calendar`
  e `/mail` nuove (rotte 404) — va sceso insieme al caddy, come sempre. La
  colonna `html_link` e il campo `bodyHtml` (aggiunto a
  `mailOriginalSchema`, `.nullable().default(null)`) sono invece
  puramente additivi, nessun rischio.
- **«La posta si legge per conversazione» (14 set 2026)**: rebuild
  **server + worker + caddy insieme** (migrazioni 0076 e 0077 all'avvio del
  server — additive, **nessun `ALTER TYPE`**, un solo batch ciascuna e
  nessun backfill: `email_bodies` (la cache del corpo originale, `ON DELETE
  CASCADE` dal messaggio) e `email_messages.admitted boolean not null
  default true`, dove il default È il backfill corretto perché prima ogni
  riga passava dal cancello. Il worker nuovo è l'unico che tira dentro il
  thread e classifica per conversazione, il server nuovo l'unico che espone
  `/api/me/mail/threads*` e serve l'originale dalla cache, il bundle nuovo
  l'unico che disegna la posta per conversazione). **Nessuna env nuova.**
  **Nessun kind di notifica nuovo e nessun valore aggiunto a un enum
  esistente**: a differenza delle fasi 2/5/6/6c non c'è l'equivalente del
  500 su `/api/inbox`, e scendere di immagine sul server non richiede di
  ripulire righe prima. **Parte A deployabile da sola** (la sola cache): è
  stata mergiata e deployata il 14 set, prima della parte B.
  ⚠️ **Sul web `/mail` elenca SOLO conversazioni** (decisione del maintainer,
  14 set): la vista per messaggio non c'è più, e con lei i filtri per stato
  e per progetto e la lista fusa col calendario (gli appuntamenti hanno
  `/calendar`). **La rotta `GET /api/me/mail` per messaggi NON si tocca**:
  non ha più un chiamante nel bundle web, ma la legge l'app mobile già
  installata — è la solita asimmetria «l'app si aggiorna dagli store, non
  dai nostri deploy». Chi ripulisce codice morto lato web si fermi al
  confine di `packages/api-client`. Resta viva anche `/mail/:source/:id`,
  dove atterrano una card di notifica e un link condiviso.
  ⚠️ **«Riproponi» vive sul singolo MESSAGGIO dentro la conversazione
  aperta** (web e app), ed è l'UNICA via di recupero da una proposta
  `failed`, da una ignorata per sbaglio e da uno smistamento chiuso con
  «nessuno di questi»: non esiste da nessun'altra parte nella UI — in
  particolare **non** sulla card in inbox, dove non c'è mai stata. Chi la
  toglie da lì non sposta un bottone: lascia quelle proposte raggiungibili
  solo con una chiamata HTTP a mano. Sta sul messaggio e non sulla riga
  della conversazione perché dal fan-out della 6b un messaggio può avere più
  proposte, una per progetto, e l'azione deve sapere quale.
  **Quali siano possibili lo decide il SERVER**, in
  `mailThreadMessageSchema.reproposals` (`GET /api/me/mail/threads/:id`),
  con le STESSE condizioni del cancello di `POST
  /:source/:id/repropose` — un client che le rideducesse da `status`
  produrrebbe bottoni da 409 al primo scostamento fra le due copie.
  **Rollback**: scendere di immagine sul server perde le rotte per thread
  (404) — va sceso col caddy, come sempre — e l'originale torna a chiedersi
  a Gmail ogni volta, ignorando `email_bodies`, che resta innocua. Scendere
  di immagine sul **worker** riporta la classificazione per messaggio: le
  righe `admitted = false` già scritte non verrebbero più classificate
  (l'`admitted` non lo conosce, ma quelle righe hanno `status = 'new'` e
  nessun figlio, quindi un worker vecchio le CLASSIFICHEREBBE come messaggi
  normali, producendo le proposte in più che questa fase esiste per
  togliere). Non è distruttivo, ma è il motivo per non scendere di immagine
  sul solo worker dopo questa fase.
- **«Righe di ricerca per tipologia» (16 set 2026)**: rebuild **server +
  worker + caddy insieme** (migrazione 0079 all'avvio del server — additiva,
  **nessun `ALTER TYPE`**, un solo batch, nessun backfill nella migrazione:
  una sola colonna `email_messages.cc_addresses text[]`, **nullable**. Il
  worker nuovo è l'unico che scrive il `cc` sulle righe nuove, il server nuovo
  l'unico che espone `to`/`cc` nel gruppo `mail` di `/api/search`, il bundle
  nuovo… non serve, in realtà: **la palette web non cambia** — riceve i due
  campi e li ignora, che è ciò che deve fare un client che non li usa. Il
  caddy si ribuilda comunque per non lasciare il bundle indietro rispetto al
  server). **Nessuna env nuova. Nessun kind di notifica nuovo e nessun valore
  aggiunto a un enum esistente**, quindi niente della famiglia del 500 su
  `/api/inbox` delle fasi 2/5/6.
  **Nessuna chiamata nuova a Gmail**: l'header `Cc` era GIÀ in
  `DEFAULT_METADATA_HEADERS` e arrivava nella stessa risposta
  `format=metadata` — l'ammissione della 6c lo guardava già. Il worker
  smetteva solo di scriverlo, per mancanza di una colonna.
  **⚠️ Passo manuale post-deploy — il recupero delle righe storiche.** Il
  `cc` dei messaggi già ingeriti (163 in prod al 16 set, dal 4 agosto) non è
  ricostruibile dal database: sta solo su Gmail. Sul VPS, **dentro il
  container server**, prima in prova e poi davvero:
  `docker compose exec server node dist/scripts/backfill-email-cc.js
  --dry-run`, poi lo stesso senza `--dry-run`. Come il backfill della fase 5
  si lancia col **`node` compilato** e non con `pnpm` (l'immagine è un `pnpm
  deploy --prod`: niente `tsx`, niente pnpm, e il Postgres del compose non
  pubblica porte sull'host). ⚠️ Serve anche `ENCRYPTION_KEY` nell'ambiente
  del container — c'è già, ma a differenza degli altri script questo decifra
  i refresh token delle caselle.
  **Rollback — simmetrico e innocuo**: scendere di immagine sul server perde
  `to`/`cc` dalla risposta (i client li ricevono assenti e mostrano le righe
  come prima); scendere sul worker smette di scrivere il `cc` sulle righe
  nuove, che restano `null` — cioè esattamente il valore che significa «non
  lo sappiamo», e che un lancio futuro del recupero riempirà. La colonna
  sopravvive a tutto.
- **«Una keyword non scavalca il cancello» (17 set 2026)**: rebuild del **solo
  worker** — `admit()` gira lì, il server non la chiama (unico chiamante:
  `apps/worker/src/google/poller.ts`). **Nessuna migrazione, nessuno schema
  toccato, nessuna env nuova, nessun interruttore nuovo in UI**: è un cambio
  di ORDINE dentro una funzione pura, più i test che lo fissano.
  **Rollback = l'immagine precedente**, e non c'è nient'altro da fare: nessuna
  riga da ripulire, nessun flag da spegnere. Un worker precedente torna ad
  ammettere troppo, senza rompere niente.
  **Le proposte già aperte non sono toccate dal codice**: la modifica vale da
  qui in avanti. L'arretrato del 17 set (20 notifiche da `github.com`,
  `*.atlassian.net`, `vercel.com`) è stato chiuso a mano sui dati di
  produzione con `outcome.type = 'bulk_closed_automated'` — leggibile fra le
  gestite, nessuna riga cancellata, e sul padre solo `updated_at` (invariante
  della 6b). Le 3 commerciali NON sono state chiuse: le ha scritte una
  persona, e quella è una decisione sul contenuto che prende chi legge.
  **Come si verifica che sia servito** — non «i test passano», ma il conteggio
  rifatto dopo **qualche giorno di posta NUOVA** (l'arretrato è già stato
  spazzato a mano, quindi oggi quei domini sono a zero per un altro motivo):

      select split_part(m.from_address,'@',2) dominio, count(*)
      from email_messages m
      join email_proposals p on p.email_message_id = m.id
      where p.status not in ('actioned','ignored','failed')
      group by 1 order by 2 desc;

  Atteso: `github.com`, `*.atlassian.net` e `vercel.com` a **zero**; i domini
  dei clienti **invariati**. Il primo numero dice che il cancello morde, il
  secondo che non morde troppo. Controllo incrociato utile: `netdata.cloud` e
  `twilio.com` erano rimasti aperti perché fuori dall'elenco chiuso a mano —
  se il cancello funziona, smettono di produrne di nuovi da soli.
- **«Spostare una proposta sul progetto giusto» (17 set 2026)**: rebuild
  **server + worker + caddy insieme** — il server esegue l'azione, il worker
  riclassifica prima di pubblicare la proposta nuova, il bundle disegna la
  scelta del progetto. **Nessuna migrazione, nessuna colonna, nessuna env
  nuova, nessun toggle**: l'unica cosa nuova è un'AZIONE, più un marcatore
  dentro un jsonb che esisteva già (`email_proposals.classification`).
  **Cosa fa**: una mail che il routing ha attribuito al progetto sbagliato si
  sposta dalla card in inbox. La proposta corrente si chiude `ignored` con
  `outcome.type = 'reassigned_to'` (mai un `ignored` nudo: fra le gestite deve
  restare leggibile DOVE è andata) e sul progetto scelto nasce una riga
  `email_proposals` nuova, `classified` e senza notifica, con
  `{ reassignedFrom, needsReclassification: true }` nella classificazione. Al
  giro dopo il poller vede il marcatore, rifà i suggerimenti col contesto del
  **solo progetto nuovo** e poi pubblica. **Le sorelle e il padre non si
  toccano** (invariante della 6b): sul padre solo `updated_at`, mai `status`,
  `project_id`, `scope_project_ids` o `proposal_notification_id` — quei due
  ultimi sono ciò che il ROUTING aveva dedotto, e restano anche dopo che una
  persona ha corretto UNA proposta.
  ⚠️ **Il conflitto è RIFIUTATO, non risolto.** Se sul progetto scelto una
  proposta aperta c'è già, la risposta è `already_proposed` (409) e **niente
  viene scritto**: l'insert ha un `onConflictDoUpdate` su `(email_message_id,
  project_id)` che altrimenti sovrascriverebbe in silenzio una card legittima.
  Il controllo sta in DUE punti e non è ridondanza: quello in transazione è
  l'autorità, il **pre-check prima del claim** esiste perché senza,
  `propagateHandled` avrebbe già chiuso la card e `markSourceFailed` l'avrebbe
  marcata `failed` per un gesto che non cambia niente. L'errore va **mostrato**
  a chi ha confermato, non ingoiato: è un'informazione utile.
  ⚠️ **Il progetto scelto viaggia dal CLIENT, e l'invariante «solo l'indice
  viaggia» non è aggirata — è letta per il suo scopo.** Vedi il docblock di
  `inboxGoogleActionSchema` (`packages/shared/src/schemas/notification.ts`),
  riscritto nello stesso commit: quell'invariante protegge dal client che
  rimanda MODIFICATO un campo della proposta letta, e qui è il contrario —
  l'utente sceglie deliberatamente qualcosa che nella proposta non c'è.
  L'azione persistita **non porta il `projectId`** (al momento della publish il
  progetto non è conoscibile): è un marcatore di CAPACITÀ come
  `acknowledge_reminder`, e il progetto arriva in
  `AnswerGoogleProposalInput.projectId` alle tre condizioni che il server fa
  rispettare — `optionIndex` obbligatorio, `projectId` **rifiutato e non
  ignorato** su ogni altra azione, progetto validato.
  ⚠️ **Su Slack l'opzione si LEGGE ma non si preme**, ed è deliberato: un
  bottone non sa chiedere quale progetto, quindi darebbe SEMPRE
  `invalid_answer` — il "bottone che dà sempre errore" da cui il docblock di
  `KINDS_WITH_OPTIONS` mette in guardia. `buildQuestionBlocks`
  (`packages/notifications/src/slack-blocks.ts`) omette quel bottone **senza
  ricompattare gli indici** (`inbox:answer:<i>` porta ancora l'indice VERO) e
  tiene la riga nella sezione, numerata, con scritto dove si fa. Toglierla del
  tutto nasconderebbe l'unica via per correggere un'attribuzione sbagliata.
  **Rollback — innocuo, e nulla da ripulire**: nessun kind di notifica nuovo e
  nessun valore aggiunto a un enum che entri in una risposta di rotta
  esistente, quindi niente della famiglia del 500 su `/api/inbox` delle fasi
  2/5/6. `reassign_project` è un valore nuovo sui due enum chiusi MINORI e
  gemelli (`inboxGoogleActionTypeSchema` e `storedActionSchema`), stessa
  famiglia di `acknowledge_reminder` in 7b: entrambi i punti di lettura
  degradano con `safeParse`, quindi su un binario vecchio una card già
  pubblicata resta visibile e `answerGoogleProposal` risponde `proposal_stale`
  alla conferma — nessun crash, ma quelle card vanno chiuse a mano finché non
  si torna avanti. Scendere di immagine sul **worker** lascia le righe col
  marcatore `needsReclassification` senza nessuno che lo guardi: verrebbero
  pubblicate con la classificazione del progetto VECCHIO — è il motivo per non
  scendere di immagine sul solo worker dopo questo deploy.
- **«Far vedere cosa ha generato una proposta» (18 set 2026)**: rebuild
  **server + caddy** — il server DERIVA il campo nuovo, il bundle disegna il
  blocco. **Il worker non c'entra**: non pubblica niente di diverso, ed è il
  punto di tutta la funzione (vedi l'invariante «derivati a lettura» più
  sotto). **Nessuna migrazione, nessuna colonna, nessuna rotta nuova, nessuna
  env**: l'estratto era già in `email_messages.text_excerpt` e la rotta
  (`GET /api/me/mail/:source/:id`) esisteva dalla 7b.
  **Cosa fa**: il dettaglio di una proposta di POSTA mostra l'estratto che la
  classificazione ha letto — non l'email come si vede in Gmail. La distinzione
  è il valore della funzione, non un dettaglio: l'estratto è troncato a
  `CLASSIFY_TEXT_MAX_CHARS` e di un thread si guarda **l'ultimo messaggio
  ammesso**, quindi quando i suggerimenti sembrano fuori bersaglio è spesso la
  fonte a spiegarlo — il modello ha letto meno di quanto c'è. È la stessa
  distinzione fra `text_excerpt` ed `email_bodies` già scritta più sotto:
  questa schermata vuole il PRIMO.
  **Il calendario resta fuori, e si dice perché**: una proposta di calendario
  non ha una classificazione AI (nasce da regole su titolo e partecipanti),
  quindi «cosa ha letto il modello» lì non vuol dire niente. Il campo è `null`
  anche per lo SMISTAMENTO, che vive sul padre senza riga `email_proposals`.
  ⚠️ **Le due superfici si comportano DIVERSAMENTE, e non è un'incoerenza da
  uniformare.** Sull'app il blocco si carica subito, perché lì il dettaglio è
  una SCHERMATA — una proposta alla volta. Sul web la card d'inbox è già
  espansa DENTRO l'elenco, quindi un caricamento automatico farebbe una
  richiesta per ogni proposta di posta visibile: lì l'estratto si chiede al
  click. È lo stesso conto che il design fa per non mettere l'estratto nella
  risposta della lista, applicato al client.
  **Degrado, uguale su entrambe**: id assente, rotta che fallisce o estratto
  vuoto ⇒ il blocco non compare (o dice che non c'è) e **le scelte restano
  premibili**. Non sapere cosa ha letto il modello è un peccato; non poter
  decidere è un guasto.
  **Rollback — innocuo**: nessun kind di notifica nuovo e nessun valore
  aggiunto a un enum, quindi niente della famiglia del 500 su `/api/inbox`
  delle fasi 2/5/6. Scendere di immagine sul server fa sparire il campo dalla
  risposta: l'app (che parsa) legge `null` dal `.default`, il web legge
  `undefined` e lo difende con `?? null` — in entrambi i casi il blocco non
  compare e la card resta intera. Va sceso col caddy come sempre.
- **«Far vedere ciò che è fermo» (21 set 2026)**: rebuild **server + caddy** —
  il server DERIVA i due campi nuovi del polso, il bundle li disegna. **Il
  worker non c'entra**: nessun poller nuovo e **nessuna notifica nuova** (il
  pulse proattivo della fase 2 avvisa già quando un PROGETTO è fermo; questo è
  a livello di TICKET e vive in una vista, non in inbox — che stiamo cercando
  di alleggerire, non di riempire). **Nessuna migrazione, nessuna colonna,
  nessuna rotta nuova, nessuna env, nessun toggle**: «fermo» si calcola a
  lettura da dati che ci sono già (`tickets`, `ai_jobs`,
  `ticket_repositories`, `agent_questions`), a ogni `GET /api/projects/pulse`.
  **Cosa fa**: il polso di un progetto guadagna DUE campi additivi, entrambi
  `.default([])` — `stalled` (i ticket che non si muovono, dal più vecchio, con
  la data dell'ultimo movimento e il MOTIVO) e `waitingForMerge` (le PR aperte,
  che NON sono ferme: aspettano una decisione umana precisa, il merge).
  Prima di questa aggiunta i tre secchi del polso erano TUTTI basati su un job
  in volo: dieci ticket non chiusi in produzione, zero con un job vivo, quindi
  zero nel polso — e il più vecchio fermo da 21 giorni.
  ⚠️ **Il criterio del «fermo» sta in UN posto solo**,
  `packages/notifications/src/project-pulse-summary.ts` (NON
  `project-signals.ts`, che sono i segnali del pulse proattivo): non chiuso,
  nessun job vivo, nessuna PR aperta, nessuna domanda dell'agente in sospeso.
  Chi ne ha bisogno altrove chiami quella funzione invece di ricopiarlo in SQL:
  il repo ha già due regole scritte in due lingue (`isReadyForProposal` e la
  query del propose phase) e reggono solo perché documentate con insistenza.
  La condizione sulla PR aperta è la STESSA della coda di rilascio
  (`prState = 'open'` E `prUrl` valorizzato), così `stalled` e
  `waitingForMerge` non possono né sovrapporsi né lasciare un ticket fuori da
  entrambi.
  ⚠️ **Il MOTIVO si deriva dai JOB, non dallo STATO** — lo stato è una
  DICHIARAZIONE di qualcuno, i job sono un FATTO, e una vista che legge solo lo
  stato manda un operatore a cercare lavoro che non esiste. Il caso che l'ha
  insegnato è il ticket #25 in produzione: `in_progress` con ZERO job,
  `created_at` e `updated_at` a tre secondi di distanza, e il suo contenuto
  (fase 7) già in produzione dal 9 settembre. Per questo esiste
  `declared_no_work` («nessun lavoro registrato», dove l'azione giusta è spesso
  «chiudilo») distinto da `interrupted` («cominciato e mai arrivato ad aprire
  una PR»), che in produzione al 21 set non ha NESSUNA occorrenza: non è il
  caso normale e non va trattato come tale.
  ⚠️ **I GIORNI li conta il CLIENT, dalla data**: il server manda
  `stalledSince` (l'ultimo MOVIMENTO, non la creazione) e mai un numero — un
  conteggio calcolato a monte invecchia dentro una risposta in cache e dice «da
  3 giorni» su una pagina aperta da una settimana. Gli helper sono
  `apps/{mobile,web}/src/lib/stalled.ts`, gemelli deliberati come i due
  `pulse-line.ts` accanto.
  ⚠️ **`canMerge` lo calcola il SERVER, col ruolo — mai il client**: vedi «I due
  divieti dell'operatore» più sotto, punto 2, che da questa data vale anche in
  lettura.
  **L'app mobile NON fa parte di questo rebuild**: si aggiorna dagli store, non
  dai nostri deploy — è la premessa dell'invariante «solo cambi additivi», ed è
  il motivo per cui entrambi i campi nascono `.default([])`.
  **Costo, dichiarato**: `summarizeProject` passa da 4 a 7 query per progetto.
  Non introduce il «limite noto v1» già scritto nel commento di quella funzione
  (un admin apre questa vista su OGNI progetto dell'istanza, senza cap né
  paginazione), ma ne alza il coefficiente: se un'istanza crescesse a centinaia
  di progetti, è lì che si guarda.
  **Rollback — innocuo, e niente da ripulire**: nessun kind di notifica nuovo e
  nessun valore aggiunto a un enum che entri in una risposta di rotta esistente,
  quindi niente della famiglia del 500 su `/api/inbox` delle fasi 2/5/6.
  Scendere di immagine sul server fa sparire i due campi dalla risposta: l'app
  (che parsa davvero, via `readerSchema`) legge `[]` dal `.default`, il web —
  che NON parsa, `lib/api.ts` fa un cast — li difende con `?? []` nel punto di
  lettura. In entrambi i casi il blocco non compare e il resto del polso resta
  intero. Va sceso col caddy come sempre.
- **«Hub di progetto, tappa 3: monitor e impostazioni» (23 set 2026)**:
  rebuild **server + caddy**. **Il worker non c'entra.** Nessuna migrazione,
  nessuna rotta nuova, nessuna env, nessun kind di notifica né valore di enum.
  Due cose distinte, in due commit, da non confondere: (1) **SPOSTAMENTO** di
  `serverViewSchema`/`serverDetailSchema` da `apps/server/src/routes/servers.ts`
  a `packages/shared/src/schemas/server.ts` — nessuna forma cambiata, i test
  esistenti di `servers.test.ts` sono passati senza essere toccati, e il web
  ha smesso di tenerne una terza copia a mano in `lib/api.ts`; (2) **CAMBIO DI
  RISPOSTA additivo**: `GET /api/servers/:id` aggiunge `memUsedBytes`/
  `memTotalBytes` dell'ultimo campione (stessa query di `services`/`disks`),
  `.nullable().default(null)` nello schema. Serviva perché la memoria il web
  la prende da `/metrics`, un'unione che `readerSchema` non attraversa.
  ⚠️ `null` lì ha DUE significati — nessun campione mai ricevuto, oppure
  server più vecchio che il campo non lo manda — e l'app li distingue
  (`memoryReading`, `apps/mobile/src/lib/server-health.ts`): in nessuno dei
  due casi è «0». Il web oggi non legge quei due campi; se lo facesse, `??
  null` nel punto di lettura (fa un cast, non un parse).
  **L'app mobile NON fa parte di questo rebuild** (si aggiorna dagli store).
  **Rollback — innocuo**: scendere di immagine sul server fa sparire i due
  campi, e l'app li legge `null` dal `.default` («non disponibile»). Va sceso
  col caddy come sempre.
- **«Le mail tenute fuori» (25 set 2026)**: rebuild **server + worker**. Il
  caddy no: il web non cambia (la rotta c'è, la legge solo l'app). Migrazione
  **0080** all'avvio del server — additiva, **nessun `ALTER TYPE`**, un solo
  batch, nessun backfill: una tabella NUOVA `email_rejections`, una riga per
  mail scartata dal cancello di ammissione (`admit()`), con il solo MOTIVO e
  il DOMINIO del mittente — mai oggetto né indirizzo completo. Il motivo è un
  CHECK, non un pgEnum. **Nessuna env, nessun kind di notifica, nessun valore
  aggiunto a un enum esistente, nessuna risposta esistente toccata**: per
  l'app è una rotta NUOVA, `GET /api/me/mail/rejections?days=7`.
  ⚠️ **Il worker scrive gli scarti FAIL-OPEN** (`recordRejection`/
  `forgetRejections`, `apps/worker/src/google/poller.ts`): un errore si logga
  e non sale, perché un'eccezione dal ciclo di sync verrebbe letta come guasto
  della CASELLA (backoff, poi `sync_failed`). È anche ciò che rende innocuo
  l'ordine di deploy: un worker nuovo davanti a uno schema senza la 0080
  prosegue. L'unique `(account_id, gmail_message_id)` è l'idempotenza — una
  mail scartata viene riletta a ogni resync, e non deve contare due volte —, e
  una mail che poi ENTRA (ammessa, o come contesto del thread) smette di
  essere uno scarto. Potatura a 30 giorni nel tick (`REJECTIONS_RETENTION_DAYS`,
  costante), indipendente da `GMAIL_RETENTION_DAYS`.
  ⚠️ **`mailbox_owner` senza eccezioni per gli admin**: la rotta filtra su
  `google_accounts.user_id = utente corrente` e non ha un ramo per ruolo — i
  domini da cui scrive la gente a un collega non sono affare di un admin.
  Test negativo in entrambi i versi, col verso positivo accanto
  (`apps/server/src/routes/me-mail.test.ts`).
  **L'app mobile NON fa parte di questo rebuild** (si aggiorna dagli store).
  **Rollback — innocuo in ogni direzione**: server vecchio → 404 → l'app non
  mostra la riga; worker vecchio → nessuno scrive né pota più, le righe già
  scritte restano ferme finché non torna il nuovo. La tabella sopravvive.
- **«Una mail, più azioni e più progetti» (26 set 2026)**: rebuild **server +
  worker + caddy**; l'app si aggiorna dagli store. **Nessuna migrazione,
  nessuna env, nessun kind di notifica, nessun valore aggiunto a un enum che
  entri in una risposta esistente.** Due cose: (1) le azioni del MODELLO di
  una proposta di posta (`multiSelectableIndices`,
  `packages/shared/src/multi-select.ts`, almeno due) si confermano insieme —
  caselle su web e app, «Crea tutte (N)» su Slack — con `optionIndices`, in
  UNA transazione (o tutte o nessuna) e l'esito `multiple`; gli indici li
  deriva il server a lettura (`multiSelectIndices`, mai scritto
  nell'evento) e Slack li ricalcola dal payload persistito; (2) il worker
  ammette in classificazione TUTTI i progetti, col perimetro del routing solo
  come ordinamento (primo nel prompt, vince sul tetto del fan-out). Su Slack
  `MAX_OPTIONS` è salito a 6: col 4 «Non fare nulla» spariva dalle card piene.
  **Rollback**: server vecchio → `multiSelectIndices` sparisce e i client
  tornano alla scelta singola (app dal `.default`, web dal `?? []`); solo una
  card già aperta al momento del rollback può mandare `optionIndices` e
  prendersi `invalid_answer` (accettato), e un «Crea tutte» premuto su un DM
  vecchio non fa niente. Worker vecchio → il perimetro torna un confine; le
  card già nate su altri progetti restano valide.
  **Come si verifica che serva** (dopo qualche giorno di posta NUOVA,
  guardando, non automatizzando): quante mail hanno card su più progetti
  (erano 2 su 48), e le card nate su un progetto FUORI dal perimetro —
  confermate o ignorate — dicono se il modello attribuisce bene.
- **«Una proposta decisa mostra la decisione» (27 set 2026)**: rebuild
  **server + caddy**; l'app si aggiorna dagli store, il worker non c'entra.
  **Nessuna migrazione, nessuna env, nessun kind né valore di enum nuovo.**
  Alla conferma, `markSourceOutcome`/`markSourceFailed` scrivono gli indici
  scelti in `outcome.chosenIndices` (posta, smistamento, calendario, anche se
  fallisce); `InboxGoogle.decision` (stato, etichette scelte, errore) si
  DERIVA a lettura in `readGoogle`, con una query per tabella e per pagina, e
  non è mai scritto nell'evento. Nell'app, una proposta appena decisa non è
  più fra le aperte: la schermata la cerca fra le gestite con una richiesta in
  più (solo la prima pagina, limite dichiarato nel docblock).
  **Rollback innocuo**: senza il campo, l'app lo legge `null` dal `.default` e
  il web con `?? null`, e tornano alla sola riga chi/quando; gli indici già
  scritti negli esiti restano, innocui (`closed-reason.ts` guarda solo `type`).
- **«Dettaglio progetto v3, a tre tab» (28 set 2026)**: rebuild del **solo
  server**; il web non cambia, il worker non c'entra, l'app si aggiorna dagli
  store. **Nessuna migrazione, nessuna env, nessuna rotta nuova, nessun kind né
  valore di enum.** Il polso aggiunge due campi additivi alla voce di merge,
  `repositoryId`/`repositoryName` in `pulseWaitingForMergeItemSchema`, entrambi
  **`.optional()`** (letti con un join su `repositories` in
  `project-pulse-summary.ts`), perché l'app ora **mergia**: il bottone Mergia
  del dettaglio progetto chiama `tickets.release` (`api-client`), cioè la
  STESSA rotta della coda di rilascio del web
  (`POST /api/tickets/:id/repositories/:repositoryId/release`) con lo stesso
  cancello — `requireAdmin` più il controllo dentro `releasePullRequest`. Il
  bottone compare solo con `canMerge` (letto dal server, mai dedotto dal ruolo)
  **e** `repositoryId`: il divieto dell'operatore non si sposta nell'app.
  **Rollback innocuo**: un server senza i due campi fa sparire il bottone
  Mergia e la riga resta premibile verso il ticket.
- **«I progetti in ordine alfabetico» (28 set 2026)**: rebuild **server +
  caddy**. Nessuna migrazione, env, rotta, kind né valore di enum. Cambia
  solo l'ORDINE di `GET /api/projects` (alfabetico, `compareProjectNames` di
  `@stubwise/shared`: Collator `it`, maiuscole e accenti ignorati, numeri
  letti come numeri) e di `GET /api/projects/pulse` («aspetta te» prima, poi
  alfabetico). Nessun campo cambia, quindi è sicuro per le app installate.
  ⚠️ L'ordine si fa in TypeScript e non con `ORDER BY name`: il Postgres del
  compose è `--locale=C`, e ordinerebbe per byte («Zeta» prima di «alfa»).
  Effetto collaterale noto: i selettori che preselezionano il primo progetto
  (web: nuovo ticket e nuova voce di backlog; app: nuova idea al primo uso)
  ora partono dal primo in ordine alfabetico invece che dal più vecchio.
  **Rollback innocuo**: torna l'ordine di prima.
- **«Correzioni post-PR: il ciclo review → correzione» (1 ott 2026)**:
  rebuild **server + worker + caddy insieme**; l'app si aggiorna dagli store.
  Migrazione **0081** (`packages/db/drizzle/0081_pr_corrections.sql`)
  all'avvio del server — additiva, **nessun `ALTER TYPE`**, un solo batch, con
  **DUE backfill**: tabella NUOVA `pr_corrections` (`trigger` e `status` sono
  CHECK, non pgEnum; `feedback_complete` dice se la fotografia dei commenti è
  stata letta davvero dal provider; due indici unici parziali per PR, uno
  sulle `pending` e uno sulle `queued`, più l'indice per
  `(repository_id, pr_number, created_at)`); colonne nullable
  `ai_jobs.correction_id` (UNIQUE — è l'unico legame job↔correzione,
  `pr_corrections` non ha `ai_job_id`), `repositories.review_git_account_id`
  (col CHECK `repositories_review_not_main_chk`: il revisore non può essere
  l'account principale), `git_accounts.provider_user_id`,
  `ticket_repositories.pr_number` (**backfill** dal `pr_url`; un URL che non
  combacia resta NULL) e, su `pr_reviews`, `started_at` (**backfill** `=
  created_at`: ogni review storica è PARTITA — senza, all'avvio il worker
  nuovo scambierebbe una `running` del vecchio per una in attesa e, non
  trovandoci i metadati del job, la chiuderebbe `failed`) più
  `pr_body`/`source_branch`/`target_branch` (per rimettere in coda una
  review in attesa al riavvio senza richiamare il provider). A parte, NON
  nullable: `projects.pr_correction_max_rounds` `integer DEFAULT 3 NOT NULL`
  con CHECK 0..10 (`projects_pr_correction_max_rounds_chk`), **0 = ciclo
  automatico spento**. Il worker nuovo è l'unico che accoda la review subito dopo
  l'apertura della PR (`enqueuePrReviewNow`), crea la riga della review al
  claim, apre un worktree sul branch della PR, esegue `runCorrection`, decide
  dopo ogni review (`afterReviewCompleted`: correzione automatica, stop al
  tetto, approvata) e scrive lo status di commit `stubwise-review`; il server
  nuovo l'unico che espone
  `POST /api/tickets/:id/repositories/:repositoryId/corrections`, ascolta
  «Request changes» nel webhook, annulla le correzioni alla chiusura della PR
  e deriva `cycle` sulla voce PR del dettaglio ticket; il bundle nuovo l'unico
  che disegna la riga del ciclo con «Chiedi modifiche» e «Riprendi»,
  l'account revisore nel form della repository, il tetto nel form del
  progetto e «superata» nella coda di rilascio. **Nessuna env nuova. Nessun
  kind di notifica nuovo** («approvata», «fermo al tetto» e «ciclo fermo per
  una review fallita» riusano `review.completed` col campo additivo `cycle`;
  una correzione fallita riusa `job.failed`) **e nessun valore aggiunto a un
  enum esistente**: niente della famiglia del 500 su `/api/inbox` delle fasi
  2/5/6. Sono ENUM NUOVI, non valori nuovi, `inboxReviewOutcomeSchema` e lo
  stato di `prCycleSchema`, ed entrano in risposte già esistenti solo come
  campi `.nullable().default(null)` letti via `readerSchema`.
  **⚠️ Passo manuale post-deploy — risincronizzare i webhook.** I webhook già
  registrati non conoscono l'evento nuovo (Bitbucket
  `pullrequest:changes_request_created`, GitHub `pull_request_review`):
  finché non si rilancia `ensureWebhook`, «Request changes» sulla piattaforma
  non arriva a Stubwise (il bottone funziona comunque). Sul VPS, **dentro il
  container server**, prima in prova e poi davvero:
  `docker compose exec server node dist/scripts/resync-webhooks.js --dry-run`,
  poi lo stesso senza `--dry-run`. **Riallinea, non crea**: prende SOLO i
  repository con `webhook_configured_at` valorizzato; i mai configurati
  entrano solo con `--include-unconfigured`, esplicito, perché creare un hook
  fa arrivare eventi che possono far partire review e correzioni. I
  repository con `webhook_secret` vuoto (legacy) restano fuori SEMPRE, anche
  con `--include-unconfigured`: senza segreto l'hook non è verificabile.
  Riscrive
  l'hook per intero come «Configura webhook» dalla UI (torna `active` se
  qualcuno l'aveva spento a mano). È **idempotente**, esce con 1 se un
  repository fallisce, vuole `DATABASE_URL`, `ENCRYPTION_KEY` e `PUBLIC_URL`
  (ci sono già nel container), e — come gli altri script operativi — si lancia
  col **`node` compilato**, non con `pnpm` (l'immagine è un `pnpm deploy
  --prod`).
  **Facoltativo, DOPO il resync — allineare le PR già chiuse.** Fino a questo
  deploy il webhook di chiusura lasciava `ticket_repositories.pr_state =
  'open'` quando il ticket non era più in review; da ora la riga si allinea
  alla chiusura in ogni caso (`markPrRowsClosed`), ma una PR chiusa PRIMA non
  manda più eventi: resterebbe `open`, nella coda di rilascio e col bottone
  della correzione acceso. Prima in prova, che chiama il provider e conta
  senza scrivere:
  `docker compose exec server node dist/scripts/backfill-pr-states.js --dry-run`,
  poi lo stesso senza `--dry-run`. Scrive SOLO `pr_state` e annulla le
  correzioni aperte di quelle PR (`cancelOpenCorrections`: `pending`/`queued`
  → `cancelled`, e i loro job `queued`/`held` → `skipped`); non tocca lo stato
  dei ticket, non notifica, non crea job (le `pending` sbloccate le prende il
  tick del worker). Dove non può verificare (errore, timeout, PR non trovata,
  credenziali, numero mancante) **lascia la riga com'è** e la conta «non
  verificata» per categoria — mai uno stato dedotto —, ed esce con 1:
  rilanciarlo è innocuo. Alla fine elenca, senza toccarli, i ticket ancora
  `in_review` con tutte le PR chiuse: da guardare a mano.
  **⚠️ Bitbucket: i token (principale e revisore) devono avere anche lo scope
  `read:user:bitbucket` — rigenerarli al deploy.** Senza, Stubwise non sa
  chi è l'account e ogni «Request changes» dalla piattaforma è scartato
  (fail-closed). Lo scarto non è muto: sul ticket compare un commento di
  sistema che dice chi ha chiesto, su quale PR e perché non è partito (uno per
  PR finché la condizione persiste), e il form della repository avvisa alla
  creazione e a ogni salvataggio se l'identità del principale non si legge.
  **⚠️ GitHub: il token dell'account principale deve avere anche «Commit
  statuses: Read and write»** — senza, lo status `stubwise-review` fallisce
  (best-effort: una riga nel log con il permesso mancante, il ciclo prosegue)
  e la review non si può rendere obbligatoria per il merge. Su Bitbucket per
  gli status basta lo scope già richiesto `write:repository:bitbucket`.
  **Account revisore — facoltativo.** Senza, la review commenta con l'account
  principale come prima e lo stato vero della PR (approvata / modifiche
  richieste) non si scrive: GitHub vieta all'autore `APPROVE`/
  `REQUEST_CHANGES` sulla propria PR. Chi lo vuole crea l'account sulla
  piattaforma, gli dà scrittura sulle repository, lo registra fra gli account
  git (stesso provider e, su Bitbucket, stesso workspace del principale) e lo
  sceglie nel form della repository; il salvataggio lo valida (permesso di
  scrittura, identità leggibile e diversa dal principale) e ne registra
  l'identità (`provider_user_id`). Permessi del suo token: **GitHub** Contents
  e Pull requests in scrittura; **Bitbucket** (API token, la credenziale che
  Stubwise si aspetta) `read:repository:bitbucket`,
  `write:repository:bitbucket`, `read:pullrequest:bitbucket`,
  `write:pullrequest:bitbucket` e `read:user:bitbucket` — i `read:` accanto
  ai `write:` finché non è verificato che un `write:` includa il suo `read:`
  (T43 del B14): fino ad allora si danno entrambi. ⚠️ Due nomenclature
  da non mescolare: quelli sono gli scope degli **API token**;
  `repository:write`/`pullrequest:write` sono i nomi di OAuth, e una **app
  password** legacy (che Stubwise accetta ancora, autenticando con lo
  username invece dell'email) li chiama *Repositories: Write*, *Pull
  requests: Write* e *Account: Read* — quest'ultimo è l'equivalente di
  `read:user:bitbucket`.
  **Comportamenti che cambiano anche senza toccare niente**: (1) le righe
  `ticket_repositories` si allineano alla chiusura della PR anche con il
  ticket non più in review (sopra); (2) «Già su staging?» (`deployedOn`)
  confronta con `sameCommit` — vedi la voce della fase 8, corretta — e la coda
  di rilascio dice se il verdetto è su codice superato (`reviewStale`, cast
  sul web con `?? false`); (3) `/api/inbox` porta `reviewOutcome` sulle card
  `review.completed`, che ne decide il tono (web e app); (4) su Bitbucket la
  coda di rilascio **non conta `stubwise-review` fra i check**
  (`BitbucketProvider.getPullRequestChecks` lo filtra per key; su GitHub lo
  status di commit non è mai stato fra i check-run letti): la coda mostra già
  il verdetto nella sua colonna, e contarlo due volte avrebbe bloccato la
  stessa PR su Bitbucket e non su GitHub — mergiare contro una review
  negativa resta una scelta del maintainer, che la vede; (5) il ciclo
  automatico, il «Request changes» della piattaforma e il bottone di un
  `member` **rispettano il budget**: lo scavalca solo un admin
  (`correctionManualTrigger`), e una correzione ferma per budget la riprende
  un maintainer.
  **Review obbligatoria per il merge — facoltativa**: dalle regole del branch
  sulla piattaforma, richiedendo lo status `stubwise-review`. L'obbligo vale
  SOLO lì (punto 4 qui sopra).
  **Golden**: cambia un prompt (`buildCorrectionPrompt`) e c'è uno scenario
  nuovo (`correction`), quindi vanno rilanciati gli scenari golden dei plugin
  (`pnpm --filter @stubwise/worker golden -- --plugin <dir>`).
  **Post-merge**: (a) mergiare la PR di versioning Changesets che pubblica
  `@stubwise/mcp` in **patch** (`.changeset/mcp-run-ticket-corrections.md`:
  la descrizione di `run_ticket` dice che una PR aperta non si corregge
  rilanciando, e di non rilanciarlo alla cieca su una correzione ferma) e
  `@stubwise/shared` in **minor** (`.changeset/shared-pr-correction-loop.md`:
  gli schemi del ciclo) — arrivano agli utenti a quel merge, non al deploy
  —; (b) ricopiare la skill aggiornata in
  `~/.claude/skills/stubwise/SKILL.md` sulle macchine degli sviluppatori.
  **L'app mobile NON fa parte di questo rebuild**: legge `cycle` dal
  `.default(null)` finché il server non lo manda, e senza ciclo la PR non ha
  né riga né bottone.
  **Rollback — il server è quasi innocuo, il worker NO** (verificato
  leggendo il codice delle due versioni, non assunto). Scendere di immagine
  sul **server** fa sparire la rotta nuova (404), `cycle`, `reviewStale` e
  `reviewOutcome` (l'app li legge dal `.default`, il web li difende con `??`):
  va sceso col caddy, come sempre. Due effetti da sapere: il webhook vecchio
  non annulla più le correzioni alla chiusura della PR (il worker ricontrolla
  lo stato prima del push: niente danno, solo un giro a vuoto); e lo
  `startRun` vecchio non conosce `correction_id`, quindi «Rilancia» su un
  ticket il cui ultimo job è di una correzione **ricicla quel job** — se la
  correzione è ancora aperta la riesegue con `manualTrigger` true (oltre il
  budget, anche per un member; un member con un piano salvato la manda invece
  in `awaiting_plan_approval`), se è chiusa il worker chiude il job `skipped`
  e il fix chiesto non parte. Scendere sul **solo worker** con correzioni in
  coda **non è sicuro**: un worker vecchio prende quei job come fix normali —
  ripartono dal branch di default, fanno lavoro inutile e falliscono al push.
  Prima di scendere, in quest'ordine: (1) togliere dalla coda i job delle
  correzioni, così il worker nuovo non ne prende altri — `update ai_jobs set
  status='skipped' where correction_id is not null and status in
  ('queued','held');`; (2) aspettare che finiscano quelle già in esecuzione:
  `select id from ai_jobs where correction_id is not null and status in
  ('triaging','fixing','awaiting_input');` deve essere vuota; (3) fermare il
  worker; (4) a worker fermo, rilanciare l'update del punto 1 — nel
  frattempo il ciclo automatico o la promozione di una `pending` possono aver
  creato job nuovi — e annullare le richieste: `update pr_corrections set
  status='cancelled' where status in ('pending','queued');`. Solo dopo, il
  worker vecchio. ⚠️ E un worker vecchio scrive le review **senza
  `started_at`**, con due conseguenze anche dopo essere tornati avanti: la
  coda di rilascio del server nuovo non vede il loro verdetto (filtra le
  sole PARTITE), e il controllo anti-doppione di `runPrReview`
  (`apps/worker/src/review/run-review.ts`), che tratta una riga senza
  `started_at` più vecchia della soglia di staleness come un'attesa orfana,
  non le conta più — la review della stessa head si rifarebbe al webhook
  successivo. Si ripara a mano con `update pr_reviews set started_at =
  created_at where started_at is null and status <> 'running';` (le
  `running` sono escluse: le gestisce il worker nuovo all'avvio, che rimette
  in coda le review in attesa con `source_branch`/`target_branch` e chiude
  `failed` — «metadati del job assenti» — quelle senza, cioè proprio le
  `running` lasciate dal worker vecchio). Le tabelle e le colonne sopravvivono, e il migratore ignora
  la 0081 già applicata. Per **spegnere solo il ciclo automatico** senza
  toccare immagini: `pr_correction_max_rounds = 0` sui progetti (le correzioni
  manuali restano).
  ⚠️ **Card di una review fallita dopo un rollback del server**: le
  `review.completed` con `verdict: null` (review fallita dentro una serie
  automatica) su un server sceso d'immagine si leggono «Review della PR
  completata per …: modifiche richieste» — il binario vecchio non conosce `notify.reviewStopped` — e ci
  viene allegato il riassunto di una review PRECEDENTE della PR. Nessun 500,
  nessun crash: solo testo sbagliato su quelle card. Pulizia facoltativa:
  `delete from notifications where kind='review.completed' and
  event->>'verdict' is null;`.
- **«Revisore predefinito e scope di Validate» (1 ott 2026)**: **ORDINE, da
  seguire alla lettera — prima il server, poi il resto**:
  (1) `docker compose up -d --build server`;
  (2) aspetta che sia healthy — `docker inspect -f '{{.State.Health.Status}}'
  "$(docker compose ps -q server)"` deve stampare `healthy` (l'`HEALTHCHECK`
  di `apps/server/Dockerfile` interroga `/health`, e il server applica le
  migrazioni PRIMA di mettersi in ascolto, `apps/server/src/index.ts`) — e
  verifica che la **0082** sia applicata: `docker compose exec postgres sh -c
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d git_accounts"'` deve
  mostrare la colonna `is_default_reviewer` e l'indice
  `git_accounts_default_reviewer_scope_uq` (in alternativa: `docker compose
  exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select
  max(created_at) from drizzle.__drizzle_migrations"'` deve stampare
  `1790841600000`, il `when` della 0082 in `_journal.json`);
  (3) solo allora `docker compose up -d --build worker caddy`.
  **Perché quest'ordine — il danno di invertirlo è GRANDE, non marginale**:
  lo schema drizzle del worker nuovo ha la colonna
  `git_accounts.is_default_reviewer`, e drizzle NOMINA tutte le colonne quando
  una query seleziona la riga intera di `git_accounts` — cosa che il worker fa
  in quasi ogni job che tocca un repository (`select({ …, account: gitAccounts
  })` in `apps/worker/src/pipeline/fix.ts`, `pipeline/correction.ts`,
  `review/run-review.ts`, `backlog/deep-dive.ts`, `backlog/chat-turn.ts`,
  `graph/build.ts`, `docs/auto-update.ts`,
  `docs/recursive/orient-handler.ts`, `reports/daily-report-poller.ts`, oltre
  a `resolveReviewAccountWithCredentials`). Contro uno schema senza la 0082 il
  worker non crasha, ma **fallisce OGNI job di quei tipi**, fix compresi
  (`column "is_default_reviewer" does not exist`). Nel compose il worker ha già
  `depends_on: server: condition: service_healthy`, quindi un `up` di tutti i
  servizi aspetta da sé il server sano; il caddy invece dipende dal server col
  solo `- server` (avviato, non sano), ma non tocca il database. La voce resta
  comunque più prudente del compose di proposito: qualcuno può ricreare il solo
  worker, e allora l'attesa del compose non c'è. Il worker
  VECCHIO davanti allo schema nuovo invece è innocuo — la colonna è additiva e
  lui non la legge —, ed è ciò che rende sicuro il passo (1) da solo. L'app si
  aggiorna dagli store e non legge niente di nuovo (`repositorySchema` sì, ma
  i due campi nuovi nascono `.default(null)` e l'app non mostra il revisore).
  Migrazione **0082** (`packages/db/drizzle/0082_default_reviewer.sql`) —
  additiva, **nessun `ALTER TYPE`**, un solo batch, **nessun backfill**:
  colonna `git_accounts.is_default_reviewer boolean DEFAULT false NOT NULL`
  (il default È il backfill corretto: al deploy nessun account è predefinito,
  quindi **nessun comportamento cambia finché un admin non ne imposta uno**) e
  l'indice unico PARZIALE `git_accounts_default_reviewer_scope_uq` su
  `("provider", (CASE WHEN "provider" = 'bitbucket' THEN COALESCE("workspace",
  '') ELSE '' END)) WHERE "is_default_reviewer"` — al più UN predefinito per
  ambito, dove l'ambito è provider + workspace su Bitbucket e il solo provider
  altrove (vedi l'invariante «Il revisore effettivo si risolve in UN posto»).
  Il CHECK `repositories_review_not_main_chk` della 0081 resta sulla sola
  colonna esplicita. **Rotte nuove** (solo admin):
  `PUT /api/git-accounts/:id/default-reviewer` (imposta; risposta `{ account,
  replaced, warnings }`: `replaced` è il predefinito precedente dello stesso
  ambito, tolto nella STESSA transazione, e `warnings` sono avvisi per
  repository `{ repositoryId, repositoryName, code }`, con `code` =
  `default_is_main` o un codice di `checkReviewAccount` — che per il revisore
  guarda SOLO la REST delle PR, l'identità e, su Bitbucket, gli scope del
  TOKEN («non verificabili», quindi non bloccanti, se l'header manca), mai
  push/merge/webhook; il permesso di scrittura sul repository non è verificabile su Bitbucket dopo CHANGE-2770; un revisore in sola lettura si scopre al primo verdetto, con "Verdetto non apposto"; vedi la voce «I controlli del revisore:
  REST delle PR e scope del token») e
  `DELETE /api/git-accounts/:id/default-reviewer` (toglie, idempotente, 204).
  **Codici d'errore nuovi**: `default_reviewer_workspace_missing` (422,
  Bitbucket senza workspace), `default_reviewer_invalid` (422, un check di
  `validateAccount` con gli scope del revisore è ko; il messaggio porta i
  dettagli), `default_reviewer_conflict` (409, due admin in corsa: lo ferma
  l'indice), `default_reviewer_account_changed` (409, il workspace è cambiato
  mentre il PUT verificava) e `default_reviewer_workspace_locked` (409 sul
  `PATCH /api/git-accounts/:id` che cambia il workspace di un predefinito: va
  tolto prima). Il PUT riusa `review_account_identity_unresolved` (422) e
  `credentials_undecryptable` (400), già esistenti. **Campi additivi**:
  `gitAccountSchema.isDefaultReviewer` (`.default(false)`),
  `repositorySchema.effectiveReviewAccount` (`{ id, name, source: "explicit" |
  "default" }`) e `.skippedDefaultReviewAccount` (`{ id, name }`), entrambi
  `.nullable().default(null)` e DERIVATI dal server a ogni lettura (il web li
  legge con `?? null`); un valore nuovo, `default_review_account_invalid`, in
  `repositoryWarningSchema` (avviso NON bloccante del form della repository
  quando il predefinito che diventa effettivo non passa le verifiche su quella
  repository: lo legge solo il web). **Validate** (`POST
  /api/git-accounts/:id/validate`) non cambia forma: su Bitbucket aggiunge
  check a `checks`, uno per gruppo di scope che il RUOLO dell'account chiede
  («Scope repository e pull request», «Scope identità (read:user)», «Scope
  webhook» — quest'ultimo solo a un principale, o a un account non ancora
  usato), letti dall'header `x-oauth-scopes` della chiamata che già faceva;
  quando la credenziale non dichiara gli scope (header `x-oauth-scopes` assente
  o VUOTO, o `x-credential-type` diverso da `api_token`: tipicamente un'app
  password) un solo check «Scope del
  token» `ok: true` che dice che non sono verificabili. GitHub invariato.
  **Nessuna env nuova, nessun kind di notifica, nessun valore aggiunto a un
  enum che entri in una risposta letta dall'app**: niente della famiglia del
  500 su `/api/inbox`. **Nessun passo manuale obbligatorio.** Facoltativi,
  post-deploy: impostare il predefinito (Impostazioni → Account Git, casella
  «Default reviewer»/«Revisore predefinito») e rilanciare Validate sugli
  account Bitbucket, che ora segnala gli scope mancanti. **Post-merge**:
  mergiare la PR di versioning Changesets che pubblica `@stubwise/shared` in
  **minor** (`.changeset/shared-default-reviewer.md`).
  **Rollback — il SERVER NON è innocuo, il worker sì** (verificato leggendo le
  due versioni, `8ad52eb0` e questa). **Scendere col solo server**, con un
  predefinito impostato, riapre l'auto-innesco: il worker nuovo continua a
  pubblicare il verdetto con le credenziali del predefinito, ma il webhook
  vecchio considera «propri» solo il principale e la colonna esplicita
  (`accountIds = [gitAccountId, reviewGitAccountId?]`) — il «Request changes»
  del predefinito passa per una richiesta UMANA (ha scrittura, quindi supera
  anche il permesso), azzera la serie e il ciclo riparte: il tetto non lo
  ferma, perché `autoRoundsInCurrentSeries` conta i giri DOPO l'ultima
  richiesta umana; resta solo il budget, se configurato. ⚠️ La firma delle
  review di Stubwise (`hasStubwiseReviewSignature`) **non aiuta qui**: il
  controllo nel webhook è di QUESTO rilascio (97b594ce) e il server vecchio
  non ce l'ha — e comunque varrebbe solo su GitHub, perché l'evento Bitbucket
  non porta il testo della review (`reviewBody: null` in
  `packages/git/src/bitbucket.ts`). Prima di scendere col server, una delle
  due:
  (a) **materializzare** il predefinito come revisore esplicito e POI togliere
  il flag, così il worker nuovo e il server vecchio dicono la stessa cosa:
  ```sql
  update repositories r set review_git_account_id = d.id
  from git_accounts m, git_accounts d
  where r.git_account_id = m.id and r.review_git_account_id is null
    and d.is_default_reviewer and d.provider = m.provider
    and (m.provider <> 'bitbucket' or coalesce(d.workspace,'') = coalesce(m.workspace,''))
    and d.id <> m.id;
  update git_accounts set is_default_reviewer = false;
  ```
  Il secondo `update` non è facoltativo: senza, una repository creata (o il
  cui esplicito viene tolto) dal server vecchio tornerebbe a ricadere sul
  predefinito nel worker nuovo, e il ciclo ripartirebbe proprio lì. Le
  repository mantengono il revisore, ma da quel momento è esplicito: tornati
  avanti, cambiare il predefinito non le tocca più;
  (b) **togliere il predefinito** (dalla UI, o `update git_accounts set
  is_default_reviewer = false;`) e poi scendere — **anche col solo server**:
  senza nessun predefinito, worker nuovo e worker vecchio dicono la stessa
  cosa (solo la colonna esplicita conta), quindi scendere anche col worker è
  facoltativo. Le repository che lo usavano restano senza revisore (la review
  commenta col principale).
  In entrambi i casi il caddy scende col server, come sempre (il bundle nuovo
  chiama le rotte del predefinito, che sul server vecchio sono 404). La
  colonna e l'indice sopravvivono; il migratore ignora la 0082 già applicata.
  **Scendere col solo worker è innocuo**: il worker vecchio legge solo la
  colonna esplicita, quindi il predefinito non pubblica niente — nessun ciclo,
  le repository che lo usavano restano solo senza revisore (commento del
  principale). Unico effetto collaterale: la fotografia dei commenti del
  worker vecchio non esclude né il predefinito né la firma, quindi una review
  GIÀ pubblicata dal predefinito può entrare nel prompt della prima correzione
  di quella PR come feedback (un doppione della review che l'AI riceve già dal
  DB, non un innesco). Per **spegnere la funzione senza toccare immagini**:
  togliere il predefinito dalla UI.
- **«I controlli del revisore: REST delle PR e scope del token» (1 ott
  2026)**: rebuild **server + caddy**; il **worker resta fuori, verificato**:
  l'unico codice runtime toccato in `packages/git` è `validateCredentials`,
  che il worker non chiama mai (lo nomina solo il doppio di
  `apps/worker/src/review/correction-cycle.integration.test.ts`; i suoi
  chiamanti sono `checkReviewAccount` e Validate del server) — un'immagine
  worker col `packages/git` vecchio non si comporta diversamente. Caddy per
  il testo degli avvisi (web) e la guida (`apps/docs`). **Nessuna migrazione,
  env, rotta, kind né valore di enum; `packages/shared` non toccato, nessun
  changeset.** **Il difetto**, in prod dopo la #70: impostato un revisore
  predefinito Bitbucket, l'avviso diceva «won't review» su TUTTE le 22
  repository, e un revisore ESPLICITO prendeva 422 `review_account_invalid`.
  Due cause insieme: (1) dopo **CHANGE-2770** l'endpoint globale
  `/2.0/user/permissions/repositories` del check `merge` di Bitbucket risponde
  404/410 per QUALUNQUE account, quindi quel check era SEMPRE KO; (2)
  `checkReviewAccount` escludeva solo `purpose: "webhook"`, così anche `push`
  (KO per un revisore senza username Bitbucket — con un API token l'identità
  REST è l'email) e `merge` facevano fallire il revisore. **Correzione**:
  `checkReviewAccount` tiene una **ALLOW-LIST** (`REVIEWER_CHECK_PURPOSES`:
  `rest` e `scopes`), non una lista di esclusioni — un check nuovo NON entra
  per default fra quelli che bocciano il revisore. **I controlli del
  revisore, gli stessi in docblock, guida e avvisi**: (a) la REST delle PR
  (`rest`; su GitHub porta ancora `failure: "no_write_permission"` da
  `permissions.push`, il controllo giusto: approvare vuole la scrittura); (b)
  l'identità sulla piattaforma, diversa da quella del principale; (c) solo su
  Bitbucket gli **scope del TOKEN** (`BITBUCKET_REVIEWER_SCOPES`), letti
  dall'`x-oauth-scopes` della stessa risposta 200 della REST — nessuna
  chiamata in più — con la regola di Validate (`bitbucketScopeChecks`):
  header assente o vuoto, o credenziale non `api_token` (app password) = ok
  «non verificabile», mai un blocco. Ci arrivano con l'opzione
  `requiredScopes` di `validateCredentials` (gemella di quella di
  `validateAccount`) e `purpose: "scopes"`: **senza l'opzione nessun check in
  più**, quindi il principale e Validate (`validate-repo`, che non la passa)
  vedono esattamente i quattro check di prima — scelta preferita a un
  `purpose` sempre presente, che avrebbe aggiunto check alla validazione del
  principale. ⚠️ Sono gli scope del TOKEN, non il permesso dell'utente: il permesso di scrittura sul repository non è verificabile su Bitbucket dopo CHANGE-2770; un revisore in sola lettura si scopre al primo verdetto, con "Verdetto non apposto". Un utente in sola lettura con un token che ha
  `write:pullrequest` passa comunque. Prima lo fermavano push e merge, che
  però bocciavano anche chi poteva. Il check `merge` di Bitbucket con 404/410
  è un ok «non verificabile» (anche per l'account PRINCIPALE nella
  validazione della repository: mai un KO falso); gli altri status (401,
  403, 500…) restano KO. Non esiste un sostituto affidabile per un account in
  sola scrittura: gli endpoint per-repository dei permessi
  (`permissions-config`) vogliono Admin. Gli avvisi dicono cosa succede
  davvero: la review prova comunque col revisore effettivo, e se il verdetto
  non passa il commento esce dal principale con una riga che lo dice
  (`publishReview`, `apps/worker/src/review/cycle.ts`, nella lingua
  dell'istanza). Eccezione: con `review_credentials_undecryptable` il worker
  non prova affatto (`loadReviewerProject` ritorna null) e commenta col
  principale SENZA quella riga — la frase sul ripiego non compare per quel
  codice né per `default_is_main`. **Rollback innocuo**: tornano i KO falsi,
  niente da ripulire.
- **«La storia vera del ticket e le risposte ai commenti» (5 ott 2026)**:
  **ORDINE, alla lettera — prima il server**: (1) `docker compose up -d
  --build server`; (2) aspetta healthy e verifica la **0083** (`\d comments`
  mostra `reply_to_comment_id`, o `max(created_at)` di
  `drizzle.__drizzle_migrations` = `1791158400000`); (3) solo allora caddy e,
  quando lo si ribuilda, il worker. Perché: lo schema drizzle del worker nuovo
  nomina la colonna in ognuno dei 14 `insert(comments)` (triage, fix,
  correzione, review, intake, riprese…); contro un DB senza la 0083
  falliscono tutti. Il worker vecchio davanti allo schema nuovo è innocuo.
  Migrazione **0083** additiva, nessun `ALTER TYPE`, nessun backfill:
  `comments.reply_to_comment_id` nullable, FK self `ON DELETE SET NULL` (solo
  nello SQL) + indice. Rotta nuova `GET /api/tickets/:id/history` (registrata
  prima di `/:id`), calcolata dal modulo puro `buildTicketHistory`
  (`packages/notifications`); `replyToCommentId` opzionale nel POST dei
  commenti (422 `reply_target_invalid` se di un altro ticket, nessuna riga
  scritta); `replyTo` DERIVATO a lettura su `/comments`, POST e `/activity`,
  mai scritto. Campi additivi `.default`; il web li difende con `?? null`.
  Nessuna env, nessun kind, nessun valore di enum. Deployata server + caddy il
  5 ott 2026 (worker non ribuildato). Post-merge: changeset `@stubwise/shared`
  minor. Rollback innocuo: server vecchio → `/history` 404 («Storia non
  disponibile» nell'app), `replyTo` dal default, campo del body ignorato.
- **«Modificare e cancellare i commenti» (5 ott 2026)**: **ORDINE, alla
  lettera — prima il server**: (1) `docker compose up -d --build server`; (2)
  healthy, poi verifica la **0084**: `docker compose exec postgres sh -c 'psql
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d comments"'` mostra
  `edited_at`, `deleted_at`, `deleted_by_user_id` e i CHECK
  `comments_deleted_body_empty_chk`/`comments_deleted_by_requires_deleted_chk`
  (oppure `max(created_at)` di `drizzle.__drizzle_migrations` =
  `1791244800000`); (3) solo allora `docker compose up -d --build caddy
  worker`. Perché: il worker nuovo nomina le tre colonne nei 14
  `insert(comments)` e nella WHERE dei due prompt (`fix.ts`,
  `correction.ts`); senza la 0084 falliscono tutti. Il worker vecchio davanti
  allo schema nuovo è innocuo, ma un eliminato occupa un posto vuoto nel
  prompt: per questo il worker fa parte del deploy. Migrazione additiva,
  nessun `ALTER TYPE`, nessun backfill. Rotte nuove `PATCH`/`DELETE
  /api/tickets/:ticketId/comments/:commentId` (404 `comment_not_found`, 409
  `comment_deleted`, 403). Campi additivi `editedAt`, `deletedAt`,
  `deletedBy`, `canEdit`, `canDelete`, `inDecisionLog` (e
  `replyTo.deleted`), tutti `.default`. Nessuna env, kind o valore di enum.
  Deployata server + caddy + worker il 6 ott 2026. Rollback innocuo per lo
  schema: il server vecchio mostra gli eliminati come commenti vuoti, e il
  testo non ricompare perché non esiste più. Post-merge: `@stubwise/shared`
  minor.
- **«Adozione delle PR aperte da altri» (6 ott 2026)**: **ORDINE, alla
  lettera — prima il server**: (1) `docker compose up -d --build server`; (2)
  healthy, poi verifica la **0085**: `docker compose exec postgres sh -c 'psql
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d ticket_repositories"'` mostra
  `adopted_at`, `adopted_by_user_id`, `adoption_released_at`,
  `adoption_released_by_user_id` e il CHECK
  `ticket_repositories_adoption_release_chk` (oppure `max(created_at)` di
  `drizzle.__drizzle_migrations` = `1791331200000`); (3) solo allora `docker
  compose up -d --build worker caddy`. ⚠️ **Non adottare nessuna PR finché
  anche il worker non è aggiornato**: server nuovo + worker vecchio = il
  worker vecchio prende la prima correzione, non riconosce la riga adottata
  («non è una PR aperta da Stubwise») e la chiude fallita a vuoto. Perché
  l'ordine: lo schema drizzle del worker
  nuovo nomina le colonne nuove di `ticket_repositories` e `from_fork` di
  `pr_review_jobs`/`pr_reviews` in ogni select della riga intera (fix,
  correzione, review, poller delle review); contro un DB senza la 0085
  falliscono tutti. Il worker vecchio davanti allo schema nuovo è innocuo.
  Migrazione additiva, nessun `ALTER TYPE`, nessun backfill: le righe di
  prima restano mai adottate e senza verdetto sul fork (NULL = non si sa); la
  stessa 0085 aggiunge `repositories.protected_branches text[] DEFAULT '{}'
  NOT NULL` (branch protetti, lista vuota = nessuno: il comportamento di
  prima), con `protectedBranches` additivo (`.default([])`) nella risposta
  della repository e opzionale nel body di POST/PATCH (patch: assente =
  invariato).
  **Cosa fa**: un maintainer preme «Fai correggere a Stubwise» sul ticket
  `review` di una PR che Stubwise non ha aperto (`POST
  /api/tickets/:id/repositories/:repositoryId/adoption`, nota facoltativa);
  da lì le correzioni finiscono sul branch di QUELLA PR col ciclo solito, e
  «Smetti di correggere» (`DELETE` stessa rotta) la restituisce. L'adozione è
  una riga `ticket_repositories` del ticket review con `adopted_at`: il resto
  del ciclo lavora già per `(repository, numero PR)` e non ha bisogno d'altro.
  Campo nuovo `ticketDetailSchema.prAdoption` (`.nullable().default(null)`,
  derivato a lettura col ruolo di chi guarda: `canManage`), sul web letto con
  `?? null`. Codici d'errore nuovi: `not_review_ticket`, `already_adopted`,
  `not_adopted`, `pr_unverifiable`, `pr_from_fork`, `pr_fork_unverifiable`,
  `stubwise_pr`, `base_branch`, `protected_branch` (adozione),
  `adopted_pr_admin_only` (403 di «Chiedi modifiche» di un member su una PR
  adottata) e `review_ticket_not_runnable` (run-ai su un ticket review). Nessuna env, nessun kind di notifica, nessun
  valore aggiunto a un enum esistente (gli enum `prAdoptionStateSchema` e il
  motivo sono NUOVI, letti via `readerSchema`). Il prompt della correzione ha
  una prima frase diversa SOLO per una PR adottata: quello delle PR di
  Stubwise è identico, quindi gli scenari golden esistenti restano validi; uno
  scenario `correction` su un branch adottato va lanciato a mano. Webhook:
  nessun resync necessario (`from_fork` arriva dagli eventi già sottoscritti).
  Post-merge: changeset `@stubwise/shared` minor
  (`.changeset/shared-pr-adoption.md`). L'app si aggiorna dagli store.
  **Rollback — non innocuo finché c'è un'adozione attiva**: prima di scendere
  con QUALUNQUE immagine, «Smetti di correggere» su ogni PR adottata (o `update
  ticket_repositories set adoption_released_at = now() where adopted_at is not
  null and adoption_released_at is null;` più `update pr_corrections set
  status='cancelled' where status in ('pending','queued') and ticket_id in
  (select id from tickets where type='review');` e i loro job `queued`/`held`
  → `skipped`). Perché: il server vecchio non ha la guardia di `startRun`, e
  «Rilancia» da un `job.failed` di una correzione avvierebbe un FIX dal
  default su un ticket review; il worker vecchio rifiuta le correzioni su un
  branch adottato (job falliti, nessun push: non distruttivo, ma rumoroso).
  Le colonne sopravvivono, il migratore ignora la 0085 già applicata. Server
  vecchio → rotte 404, `prAdoption` dal default (app) o `?? null` (web): va
  sceso col caddy come sempre.
- **«Sessioni degli agenti dal vivo» (8 ott 2026, piano A: il backend)**:
  **ORDINE, alla lettera — prima il server**: (1) `docker compose up -d
  --build server`; (2) healthy, poi verifica la **0086**: `docker compose exec
  postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d
  agent_sessions"'` mostra `live_segment_ids`, `capabilities`, `owner_key`,
  `email_message_id` e i CHECK `agent_sessions_email_owner_chk` e
  `agent_sessions_email_message_chk` (oppure `max(created_at)` di
  `drizzle.__drizzle_migrations` = `1791417600000`); (3) solo allora `docker
  compose up -d --build worker caddy`, **senza lavoro dell'agente in
  corso**: cambia il RUNNER di ogni run, e all'avvio il worker azzera i
  segmenti rimasti aperti (`resetLiveSegmentsAtStartup`). Un riavvio non
  tratta tutti i run allo stesso modo, quindi prima si guarda:
  (a) **generazioni Docs** — `select id from doc_generations where status in
  ('running','paused');` deve essere vuota: un riavvio le FALLISCE, lavoro
  perso (vedi «Worker fail-on-restart» più sotto); (b) **fix e correzioni** —
  `select id from ai_jobs where status in ('triaging','fixing');` vuota: un
  job interrotto torna in coda solo dopo `WORKER_STALE_MINUTES` (150') e
  rifà il run da capo; (c) **review partite** — `select id from pr_reviews
  where status = 'running' and started_at is not null;` vuota: diventano
  `failed` («review interrotta: worker riavviato o run stantio») passata la
  soglia di staleness, e la review si rifà al webhook successivo (quelle
  ancora in ATTESA, `started_at` NULL, le riaccoda da sé
  `requeueWaitingReviews` all'avvio); (d) **job di backlog** —
  `select id from backlog_jobs where status = 'running';` vuota: deep dive,
  intake e stime tornano `queued` dopo la soglia (fino a 3 tentativi), ma un
  turno di chat (`chat_turn`) NON si ritenta e fallisce. Gli altri lavori
  dell'agente non hanno una query da guardare perché un riavvio non li
  perde, o li perde in modo innocuo: i **brief** `running` li riprende da sé
  il recovery degli stantii — ma il tentativo interrotto CONTA fra i
  `BRIEF_MAX_ATTEMPTS` (3), quindi un brief già al terzo tentativo resta
  fallito; la **classificazione della posta** scrive lo stato del messaggio
  solo DOPO il run, quindi un messaggio interrotto resta `new` e si
  riclassifica al giro dopo; il **report giornaliero** rimasto `running` è
  un orfano che il poller rigenera da sé; i **riassunti** del piano e della
  PR stanno dentro il job e la review di (b) e (c), mentre il riassunto di
  un FALLIMENTO si genera dopo che il job è già `failed`: un riavvio lì lo
  perde (`failure_summary` resta NULL, la card mostra il solo errore).
  Niente di questo è nuovo: è il prezzo di ogni riavvio del worker, qui
  scritto perché questo deploy lo richiede. Perché l'ordine: lo
  schema drizzle del worker nuovo nomina le tabelle nuove a ogni run; contro
  un DB senza la 0086 nessun job fallisce — la creazione della sessione è
  fail-open (`sessionOption`, `apps/worker/src/sessions/owners.ts`): quel
  run parte SENZA sessione, con lo STESSO runner in streaming e lo stesso
  argv, solo senza eventi registrati e senza interventi possibili, con una
  riga nel log — ma non nasce nessuna sessione, e azzeramento all'avvio,
  relay e potatura falliscono (fail-open, con una riga di log): la potatura
  a ogni tick, il poll del relay ogni 3 s. Solo `AGENT_STREAMING=false`
  riporta il runner classico — e anche lì la potatura
  (`pruneAgentSessions`) continua a girare nel tick: non è legata al flag,
  e potare le sessioni vecchie dopo un rollback è quello che si vuole. Il worker vecchio
  davanti allo schema nuovo è innocuo. Dal piano B (web, 9 ott 2026) il
  caddy PORTA la UI: la sezione **Agenti** (`/agents`, visibile anche ai
  `member`), la vista di una sessione dal vivo, il link «Guarda/Rivedi la
  sessione» sul ticket e l'«Apri» della card d'inbox di una domanda
  dell'agente (apre la sessione alla domanda); la guida utente è
  `ai-pipeline/agent-sessions` in `apps/docs` (anche questa nel caddy). Quindi
  ribuilda il caddy per averla, non solo per non lasciare il bundle indietro.
  **Il piano B tocca anche il backend, in modo additivo e nello stesso
  ramo**: (1) server — le domande di una sessione portano le `options` e
  `canAnswer`, e gli interventi del dettaglio `interrupt`
  («Ferma e scrivi»), tutti campi `.default`; nessuna migrazione (la colonna
  `agent_session_inputs.interrupt` c'è dalla 0086); (2) worker (P6) — una
  riga in `apps/worker/src/sessions/store.ts` (`onEvents`): il parziale in
  attesa di invio si scarta quando arriva `assistant_text` o `turn_end`,
  altrimenti partiva DOPO il messaggio completo e il client mostrava un
  frammento duplicato. Server prima, come sopra; il worker nuovo non
  cambia lo schema.
  Migrazione **0086** (`packages/db/drizzle/0086_agent_sessions.sql`)
  additiva, **nessun `ALTER TYPE`**, nessun backfill, un solo batch: TRE
  tabelle NUOVE, `agent_sessions` (una riga per LAVORO, non per processo:
  `owner_key` UNIQUE è l'idempotenza fra i punti che la creano; `kind` è un
  CHECK, non un pgEnum; FK facoltative verso job, review, generazione Docs,
  job di backlog — `ON DELETE SET NULL` quelle che servono solo a derivare
  l'esito — e `email_message_id` verso il messaggio classificato, ⚠️ in
  **CASCADE di proposito**: la sessione contiene il testo dell'email e
  sparisce con lei quando `pruneOldEmails` la pota o Gmail la cancella, come
  `email_bodies`; obbligatoria per `kind = 'email_message'`, CHECK
  `agent_sessions_email_message_chk`; il server legge l'oggetto da lì, per
  chiave primaria), `agent_session_events` (la trascrizione, `type` CHECK,
  con due indici PARZIALI `(session_id, id)` — `type = 'segment_end'` e
  `type in ('tool_use','assistant_text')` — per le sottoquery correlate
  dell'esito e dell'ultima azione, che senza scorrerebbero una sessione viva
  da decine di migliaia di eventi a ogni lettura: i predicati delle query e
  degli indici sono gli stessi letterali, e vanno cambiati insieme) e
  `agent_session_inputs` (gli interventi, `status`
  `pending|delivered|undelivered`). Nessuna colonna toccata su tabelle
  esistenti. **Env nuova sul worker `AGENT_STREAMING`** (default `true`:
  runner in streaming bidirezionale, `StreamingClaudeRunner`; `false` = argv
  e parsing storici, `ClaudeCliRunner`, nessuna sessione nuova). ⚠️ È passata
  dal compose (`- AGENT_STREAMING=${AGENT_STREAMING:-true}` nel blocco del
  worker) e documentata in `.env.example`: il compose elenca le env del
  worker una per una, e senza quella riga il rollback non arriverebbe mai al
  processo (preflight H1). **Rotte nuove** (`/api/agent-sessions`, lettura
  per ogni utente autenticato): `GET /` (`live` + `recent`, filtri
  `?projectId=&ticketId=&aiJobId=` in AND), `GET /:id`, `GET /:id/events`
  (cursore `before`/`after`), `GET /:id/stream` (SSE) e `POST /:id/messages`
  (`{ text, interrupt }`, **solo admin**: `requireAdmin` sulla rotta E
  `actor.role !== "admin"` nel servizio; 409 `session_ended`,
  `not_interactive`, `interrupt_unsupported`; la posta altrui è 404
  `not_found`, mai 403). **Nessun kind di notifica, nessun valore aggiunto a
  un enum esistente, nessuna risposta esistente toccata**: niente della
  famiglia del 500 su `/api/inbox`. Retention **14 giorni**
  (`AGENT_SESSION_RETENTION_DAYS`, costante, non env) sull'ULTIMA attività
  (`coalesce(last_event_at, started_at)`), potata nel tick del worker
  (`pruneAgentSessions`), eventi e interventi compresi. **Il client**:
  gruppo `agentSessions` di `packages/api-client` (`list`, `get`, `events`,
  `send`, `streamPath`) e `isAgentSessionsUnavailable` (il 404 SENZA `code`
  di una rotta che non esiste = server più vecchio: l'app dirà «non
  disponibile su questa istanza», né vuota né rotta).
  **Golden OBBLIGATORI**, perché cambia l'argv di OGNI run (`--input-format
  stream-json`, stdin aperto): i golden ora girano col runner di produzione
  (`StreamingClaudeRunner`; `--classic` per il rollback) e con la versione
  pinnata del CLI (`--claude <path>`, vedi il README dei golden), più lo
  scenario nuovo **`intervene`** (un messaggio a metà turno assorbito nello
  stesso turno; «Ferma e scrivi» che dà un `result` `error_during_execution`
  e poi cambia direzione) e **`intervene-plan`** (un intervento non
  sostituisce il piano), da lanciare 3 volte ciascuno. Vanno rilanciati
  anche quando cambia `apps/worker/src/agent/streaming-cli.ts`.
  **Post-merge**: mergiare la PR di versioning Changesets che pubblica
  `@stubwise/shared` in **minor** (`.changeset/shared-agent-sessions.md`).
  L'app si aggiorna dagli store.
  **Rollback — innocuo in ogni direzione, e c'è la strada senza immagini**:
  (1) `AGENT_STREAMING=false` in `.env` più `docker compose up -d worker` (il
  restart, con le stesse cautele: niente job né generazioni in corso) — argv
  e parsing storici, nessuna sessione nuova, quelle salvate restano
  leggibili; (2) worker vecchio → stesso effetto; (3) server vecchio → rotte
  404 (l'app lo legge come «non disponibile»), va sceso col caddy come
  sempre; sul web `/agents` dice «non disponibile su questa istanza» e il
  ticket non mostra il link (`isAgentSessionsUnavailable`), mentre un server
  senza i campi del piano B (`options`, `canAnswer`, `interrupt`) li manda
  assenti e il web li difende nel punto di lettura (`?? []`, `?? false`):
  la sessione resta leggibile, senza i bottoni delle domande. Un intervento rimasto `pending` al
  momento del rollback non arriva a nessuno e resta `pending` finché non torna un worker in streaming, il cui
  relay al primo giro lo marca `undelivered` (`session_not_live`): mai
  consegnato in ritardo a un run diverso, mai perso in silenzio. Le tabelle
  sopravvivono a tutto e il migratore ignora la 0086 già applicata.
- **«Sessioni degli agenti nell'app» (9 ott 2026, piano C)**: nessun rebuild
  dell'istanza — l'app si aggiorna dagli store, non dai nostri deploy, ed è
  UNA per tutte le istanze. Contro un server senza le rotte delle sessioni
  (404 SENZA `code`: `isAgentSessionsUnavailable`) la tab AGT dice «non
  disponibile su questa istanza», il ticket non mostra il link e la push di
  una domanda (`job.awaiting_input`) apre comunque la card, come prima.
  **Nessuna migrazione, env, rotta, kind né valore di enum.** Le schermate
  della posta e del calendario si aprono ora dal profilo (Impostazioni);
  `stubwise://mail/…` e `stubwise://calendar/…` non cambiano. Rollback:
  innocuo, vale quello della voce «Sessioni degli agenti dal vivo» sopra.
  **Prima del rilascio dell'app, a mano sul telefono** (non coperto dai
  test, che usano un XHR finto e un true-sheet finto): lo stream arriva a
  parziali attraverso Caddy (`encode zstd gzip` potrebbe bufferizzare
  `text/event-stream`), la posta dal profilo su iOS e Android con la
  tastiera, il tap su una push di domanda, background e ritorno senza
  doppioni.
- **«Sessioni di refinement del backlog» (14 ott 2026, piano A: il
  backend)**: design `docs/plans/2026-10-14-backlog-refine-sessions-design.md`,
  invarianti in `docs/invariants/backlog-refine.md`. **ORDINE, alla
  lettera**: (1) **server** — applica la migrazione **0087**
  (`packages/db/drizzle/0087_backlog_refine_sessions.sql`); prima di andare
  avanti verifica che sia applicata e che il server sia healthy:
  `select count(*) from backlog_refine_sessions;` risponde (0), e
  `select pg_get_constraintdef(oid) from pg_constraint where conname =
  'agent_sessions_kind_chk';` contiene `backlog_refine`; (2) **worker e
  caddy**, col worker SENZA lavoro dell'agente in corso: il controllo
  d'inattività di sempre (job, generazioni Docs `running`/`paused`, job di
  backlog) **più le sessioni vive**, in più campioni a distanza di qualche
  minuto, perché l'auto-aggiornamento delle Docs e le chat non compaiono
  nelle tabelle dei job: `select count(*) from agent_sessions where
  cardinality(live_segment_ids) > 0 and heartbeat_at > now() - interval
  '90 seconds';` deve dare 0 in ogni campione.
  Migrazione **0087** additiva, **nessun `ALTER TYPE`**, nessun backfill:
  due tabelle nuove, `backlog_refine_sessions` (una per voce, `UNIQUE` su
  `item_id` e su `agent_session_id`, FK verso `agent_sessions` in
  **CASCADE**; `status` e `closed_reason` sono CHECK) e
  `backlog_item_revisions` (il valore precedente di design, piano o metadati
  a ogni sovrascrittura dell'agente), più il CHECK `agent_sessions_kind_chk`
  ricreato con `backlog_refine`. I motivi nuovi degli input
  (`turn_failed`, `budget_exceeded`) e l'etichetta di segmento `refine` sono
  colonne `text` senza CHECK: bastano gli enum Zod.
  **Rotte nuove** (`requireAuth`, chiunque lavori sul backlog):
  `POST /api/backlog/:id/refine-session` (`{ message? }`, apre o riprende la
  sessione della voce e col messaggio accoda il primo turno; 409
  `item_closed` su una voce convertita o archiviata) e
  `DELETE /api/backlog/:id/refine-session` (204, idempotente). Il dettaglio
  della voce porta `refineSession` (`.nullable().default(null)`), quello di
  una sessione `canClose` (`.default(false)`) e lo stato nuovo `idle`.
  ⚠️ **`POST /api/agent-sessions/:id/messages` non ha più `requireAdmin`
  sulla rotta**: il ruolo si decide nel servizio (`sendAgentMessage`), per
  kind — fuori da `MEMBER_WRITABLE_SESSION_KINDS` (= `backlog_refine`) resta
  da maintainer, con test negativi a due ruoli. Client: gruppo
  `backlogRefine` di `packages/api-client` (`start`, `close`); la UI arriva
  col piano B.
  **Env nuove del worker, tutte con default** (nel compose come
  `${VAR:-default}`, vuote in `.env.example`): `BACKLOG_REFINE_MAX_CONCURRENT`
  (2, turni contemporanei d'istanza; gli altri restano `queued`),
  `BACKLOG_REFINE_IDLE_MINUTES` (30, poi la sessione si chiude per
  inattività e si riprende scrivendo), `BACKLOG_REFINE_TURN_TIMEOUT_MS`
  (900000). I turni massimi riusano `BACKLOG_CHAT_TURN_MAX_TURNS`.
  ⚠️ **Le sessioni di refinement richiedono `AGENT_STREAMING` attivo (il
  default, `true` in `apps/worker/src/config.ts`); con lo streaming spento i
  messaggi restano in coda e nessun turno parte**: senza streaming il worker
  non crea né il relay né lo scheduler dei turni, quindi gli input restano
  `pending` e la sessione si mostra `queued` per sempre. Il log d'avvio del
  worker lo dice (`backlog-refine disabilitato (AGENT_STREAMING=false)`).
  Lo stesso succede, fail-open, se il ponte su loopback del worker non parte
  (riga `ponte del refinement non avviato` nel log, e nel log d'avvio
  `backlog-refine disabilitato (ponte non avviato)`; il resto del worker
  gira): dopo il deploy, controlla che il log d'avvio dica
  `backlog-refine max …`.
  **Golden**: scenario nuovo **`refine`** (3 lanci, col plugin
  `superpowers`: una chiamata a `Skill` in errore è rossa, e almeno 1 run su
  3 deve esercitarla, altrimenti il lotto è inconcludente e si ri-lancia), da
  rilanciare anche quando cambia `apps/worker/src/backlog/refine/` o
  `apps/worker/src/refine-mcp/`. Il contratto del plugin base ha una riga in
  più (`apps/worker/plugins/stubwise-base/hooks/session-start.sh`): rilanciare
  anche gli scenari di sempre.
  **Post-merge**: mergiare la PR di versioning Changesets che pubblica
  `@stubwise/shared` in **minor** (`.changeset/shared-backlog-refine-sessions.md`).
  **Limiti noti**: (1) il costo dei turni di refinement **non entra nel
  budget mensile** (`monthlyCostUsd`): i run di backlog non scrivono
  `agent_runs`. Il budget sforato FERMA i turni il cui messaggio è di un
  non admin (`undelivered`/`budget_exceeded`; un admin passa), ma non li conta.
  (2) **Retention**: `pruneAgentSessions` (14 giorni sull'ultima attività)
  cancella la sessione e, in cascata, la riga di `backlog_refine_sessions`
  col `cli_session_id`: un «riprendi» successivo riparte vuoto, col prompt
  d'avvio (design §5.5, accettato). Design e piano restano sulla voce.
  **Rollback — il server NON è innocuo**: (1) **server vecchio**: risponde
  **500 sull'INTERO `GET /api/agent-sessions`** appena incontra una riga
  `backlog_refine` (la risposta passa dallo schema Zod con l'enum CHIUSO dei
  kind: stessa famiglia di `project.pulse` in fase 2). **Prima di
  scendere**: `delete from agent_sessions where kind = 'backlog_refine';`
  (eventi, input e righe `backlog_refine_sessions` vanno in cascata; design,
  piano e revisioni restano sulla voce). Il caddy scende **insieme** al
  server; nell'app il bottone sparisce da solo (la rotta d'avvio è un 404
  senza `code`: `isAgentSessionsUnavailable`). Senza `requireAdmin` sulla
  rotta il server nuovo è l'unico a far scrivere un member: scendendo, torna
  admin-only. (2) **worker vecchio**: il relay vecchio marca `undelivered`
  (`session_not_live`) gli input delle sessioni di refinement — rumoroso ma
  innocuo. **Prima di scendere** conviene chiuderle: `update
  backlog_refine_sessions set status='closed', closed_reason='user',
  closed_at=now() where status='active';`. Le tabelle sopravvivono a tutto e
  il migratore ignora la 0087 già applicata.
- **«Daily report su Haiku» (15 ott 2026)**: solo `worker` (nessuna
  migrazione, nessun cambio di server o caddy). Il daily report lancia UN run
  `claude` per commit più i riassunti: il 14/10 Audin AI (142 commit) e Trion
  Labs (69) hanno fatto 213 run Sonnet, ~15 $ equivalenti. Il modello ora è
  `DAILY_REPORT_MODEL`, default `haiku`, e non segue più `PR_REVIEW_MODEL`.
  Env nuova (con default, in compose): `DAILY_REPORT_MODEL`. Rebuild del
  worker col controllo d'inattività di sempre. **Rollback**: innocuo
  (`DAILY_REPORT_MODEL=sonnet` nel `.env`, oppure l'immagine precedente).
  Nota: la stessa indagine ha trovato la causa del consumo dell'abbonamento —
  gli **aggiornamenti automatici dei Docs** (tetti a 100000 in compose, diff
  bloccato sul commit vecchio, limite dell'account non riconosciuto) — e
  `doc_auto_update` è stato spento su tutti i progetti il 15 ott 2026 alle
  16:41, in attesa del ridisegno della pipeline. NON riaccenderlo prima.
- **«Quota degli account» (15 ott 2026)**: `server`, poi `worker`, poi
  `caddy`. Ogni run `claude` del worker sceglie l'account in UN posto
  (`apps/worker/src/providers/select.ts`): l'account del progetto è
  **preferito** (non più rigido), poi gli abbonamenti in ordine; un account
  «al limite» (`ai_providers.limited_until`) non è scelto da nessun lavoro.
  **Ordine**: (1) `server` — migrazione **0088** (`0088_provider_quota`,
  additiva: colonne `ai_providers.limited_until` e
  `projects.ai_provider_exclusive`; `doc_generations.pinned_provider_id`
  esiste dalla 0030/0032, cambia solo che ora si scrive soltanto per i
  progetti con «solo questo»), aspetta healthy e migrazione
  applicata; (2) `worker`, col controllo d'inattività di sempre; (3)
  `caddy`, per i testi della form web («solo questo») e per la guida utente
  (`apps/docs`, sezione «Failover» di `claude-setup.md`). **A4 (failover di
  fix e correzione) non va MAI in produzione senza A6 (la ripresa che legge
  `limited_until`)**: stanno nello stesso deploy del worker, mai separati.
  Env nuove (con default, in compose): `BACKGROUND_WEEKLY_THRESHOLD`
  (default 90, 1–100) e `DOCS_BACKGROUND_PAUSE_MAX_HOURS` (default 6, intero
  ≥ 1: dopo quante ore una generazione Docs ferma per la soglia riparte come
  interattiva). (A4 = failover di fix e correzione, A6 = la ripresa
  che legge `limited_until`.)
  **Cambi di comportamento da sapere prima del deploy**:
  - Il provider fissato su un progetto passa da **rigido a preferito**: chi
    vuole il comportamento di prima accende «solo questo» sul progetto
    (`ai_provider_exclusive`, vale solo con un provider valorizzato; il
    server lo azzera se il provider viene tolto o cancellato).
  - **La chiave API non si usa MAI nel passaggio automatico finché c'è
    almeno un abbonamento abilitato, nemmeno con tutti gli abbonamenti al
    limite** (decisione D3, il conteggio è fatto prima dei filtri). Oggi in
    produzione la chiave è in catena in posizione 4, come ultimo ripiego:
    dopo il deploy un lavoro aspetta il reset invece di spendere a consumo.
    Resta usata se è il provider esplicito del progetto, o se l'istanza non
    ha nessun abbonamento abilitato (self-hosted con sola chiave).
  - La generazione Docs **completa** e il brief settimanale sono lavori di
    sfondo: non scelgono un abbonamento con lettura settimanale fresca
    (≤ 15 minuti) ≥ `BACKGROUND_WEEKLY_THRESHOLD`; una generazione senza
    margine va `paused` e riprende.
    ⚠️ **Una pausa per la soglia dura al più circa
    `DOCS_BACKGROUND_PAUSE_MAX_HOURS` ore** (env nuova, default 6, intero
    ≥ 1; follow-up F2a): oltre, il resume poller la riprende come lavoro
    **interattivo** (account fino al limite vero) e lo resta fino alla fine
    (`doc_generations.stats.interactiveSince`). Prima di F2a durava fino al
    reset settimanale (giorni). Finché è in pausa la generazione resta
    `paused` con il worktree registrato in memoria, quindi **blocca i
    riavvii del worker** (vedi «Worker fail-on-restart» in CLAUDE.md) —
    ora per qualche ora, non per giorni. L'admin «Riprendi ora» riprende una
    generazione come lavoro di SFONDO: può rimettersi in pausa per la soglia
    e scalare a interattiva N ore dopo la NUOVA pausa (caso peggiore ~2N ore
    dalla prima); una generazione che porta già `interactiveSince` resta
    interattiva anche dopo «Riprendi ora»; resta ferma oltre le N ore solo se
    anche gli account fino al limite vero sono esauriti, come una pausa per
    il limite (che F2a non tocca). Si riconosce dalla reason:
    `select id, pause_reason, paused_at from doc_generations where
    status='paused';` — `background_threshold` è la soglia,
    `provider_limit` il limite vero (F2b: codici stabili; una generazione in
    pausa da prima del deploy può ancora portare la frase storica,
    «soglia del limite settimanale (lavoro di sfondo)…» per la soglia,
    «limite di rate/usage…» per il limite, e il poller le legge entrambe).
    **Cambio visibile per chi consuma il webhook generico**: il `reason` del
    payload `generic` di `docs.limit_paused` porta da F2b un codice stabile
    (`provider_limit` / `background_threshold`) al posto della frase in
    italiano, anche per gli eventi pubblicati prima del deploy (l'export li
    mappa). Chi filtra o legge quella frase va aggiornato. Rollback del worker sotto F2b:
    innocuo, il worker vecchio legge `background_threshold` come «limite»
    (non scala a interattivo dopo le N ore, come prima di F2a). Se un deploy non
    può aspettare, falla fallire a mano: `update doc_generations set
    status='failed', error='paused over background threshold, failed before
    worker deploy' where id=...;` (il lavoro della generazione è perso). Le generazioni Docs **già in corso** con
    un pin al momento del deploy restano rigide fino alla fine;
    `pinned_provider_id` si scrive solo per i progetti con «solo questo».
  - «Nessun account disponibile» non fallisce il lavoro: la coda rimette
    l'elemento in attesa restituendo il tentativo. Eccezioni: il deep dive
    senza account fallisce senza i 3 tentativi di prima; la review senza
    account prima dell'avvio si riaccoda col cooldown di 30′, senza riga
    `failed`; il daily report resta `queued` (anche in un giorno senza
    commit).
  - Fase **product** dei Docs: è **interattiva** (usa gli account fino al
    limite vero, non la soglia del 90% settimanale dello sfondo, che vale per
    il resto della generazione); al limite cambia account; se non ce n'è
    nessuno viene saltata e il salto sta in
    `doc_generations.stats.productSkipped` (visibile da API, non ancora
    nella UI web) — la generazione finisce comunque `succeeded`.
    L'orientamento invece, al limite, tiene il trigger invece di cambiare
    account (un run brief+orient sprecato).
  - Lo stato «al limite» dell'**auth storica** (nessun provider abilitato)
    è IN MEMORIA: un riavvio del worker lo perde, costo al più un run in più.
  - `auto-update.ts` risolve ancora il provider alla vecchia maniera (si
    ferma al primo limite): eccezione dichiarata finché il Piano B non la
    toglie (`doc_auto_update` resta spento, vedi la voce precedente)
    (tolto nello stesso rilascio, vedi «Giro notturno»).
  **Rollback**: innocuo per il server (colonne additive, il migratore ignora
  la 0088 già applicata). Il worker vecchio torna al provider rigido e alla
  chiave API in catena, ignorando `limited_until`. Un worker più
  vecchio ignora anche `doc_generations.stats.interactiveSince` (innocuo: il
  riavvio del rollback fa comunque fallire le generazioni `paused`/`running`).
  Il rilascio esce insieme a «Giro notturno» (sotto): per l'ordine dei
  passi, compreso lo spegnimento dei daily report prima del worker, vale
  quella voce.
- **«Giro notturno» (16 ott 2026, piano B)**: `server` (0089 e 0090), poi
  `worker`, poi `caddy`. Esce nello **stesso rilascio** della voce «Quota
  degli account» qui sopra (piano A, stesso branch): le due voci si leggono
  insieme e non si separano. Il giro notturno sceglie l'account con
  `select.ts` del piano A, quindi A4+A6 vanno comunque insieme nello stesso
  worker, e il piano B non può andare in produzione senza il piano A. **Un
  solo avvio del server** applica 0088, 0089 e 0090 nello stesso batch: è
  lecito perché la 0090 (`ALTER TYPE notification_kind ADD VALUE
  'docs.nightly_attention'`, da sola) non usa il valore in nessuna
  migrazione — lo usa solo il worker, a runtime. Cosa cambia: un giro a
  `NIGHTLY_START` (default `02:00`, ora di Roma) riassume ogni commit nuovo
  una volta sola (Haiku, `commit_summaries`), accoda i daily report del
  giorno UTC chiuso (li scrive il poller di sempre, dai riassunti), poi per
  i progetti con **«Docs aggiornati ogni notte»** (la colonna
  `doc_auto_update` di sempre, significato nuovo) scrive la nota di
  rilascio e aggiorna/crea le pagine dei Docs, a turno fra i repository,
  fermandosi alla quota e riprendendo dalla coda (`nightly_items`). **Il
  webhook push NON accoda più lavoro Docs** (restano recount dei report e
  build del grafo); `auto-update.ts`/`auto-update-poller.ts` sono rimossi.
  La tabella `doc_auto_update_jobs` RESTA (la sua rimozione è una migrazione
  a parte, dopo che il giro notturno è in produzione): le righe che ci sono
  non le legge più nessuno.
  **Primo deploy con i daily report SPENTI** (decisione del maintainer, 16
  ott 2026). La fase 1 gira se almeno uno dei due interruttori («Daily
  report», «Docs aggiornati ogni notte») è acceso, e il primo giro NON
  aspetta la notte: un worker che si avvia dopo `NIGHTLY_START` senza nessun
  elemento con la notte di oggi parte SUBITO, al primo tick
  (`initialSchedulerState`, `nightly/orchestrator.ts`). Con un daily report
  acceso, il primo avvio del worker dopo `NIGHTLY_START` riassumerebbe in un
  colpo solo fino a `COMMIT_SUMMARY_WINDOW_DAYS` (30) giorni di commit di
  ogni repository di quei progetti (il 14/10 Audin AI ne ha fatti 142 in un
  giorno: migliaia di run Haiku sull'abbonamento, frenati solo dalla soglia
  del 90%). Per questo il worker nuovo parte quando NESSUN progetto ha un
  interruttore acceso: il giro non trova niente da fare. I «Docs aggiornati
  ogni notte» sono già spenti dal 15 ott (`doc_auto_update`); i daily report
  si spengono nel passo 3 e si riaccendono a mano nel passo 5. La finestra
  resta 30 (si può abbassare con `COMMIT_SUMMARY_WINDOW_DAYS` e un worker
  ricreato, ma non fa parte della procedura).
  **Ordine** (tutti i comandi dalla radice `/opt/stubwise`, `psql` dentro
  `postgres` come nelle altre voci):
  1. **Salva l'elenco** dei progetti col daily report acceso — è l'elenco da
     riaccendere, e dopo il passo 3 non lo si ricostruisce più:
     `docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d
     "$POSTGRES_DB" -c "select id, name from projects where
     daily_report_enabled = true order by name"' | tee
     ~/daily-report-enabled-2026-10-16.txt`. Verifica che il file non sia
     vuoto (se lo è, i passi 3 e 5 non servono).
  2. **`server`**: `docker compose up -d --build server`, aspetta healthy.
     Applica 0088, 0089 e 0090 in un solo avvio (lecito: la 0090,
     `ALTER TYPE notification_kind ADD VALUE 'docs.nightly_attention'` da
     sola, non usa il valore in nessuna migrazione, lo usa solo il worker a
     runtime). **Verifica** (stesso wrapper `psql` del passo 1):
     - `docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d
       "$POSTGRES_DB" -tAc "select max(created_at) from
       drizzle.__drizzle_migrations"'` deve stampare `1792195200000` (il
       `when` della 0090 in `_journal.json`);
     - 0088: `docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER"
       -d "$POSTGRES_DB" -tAc "select count(*) from
       information_schema.columns where table_schema = '"'"'public'"'"' and
       table_name = '"'"'projects'"'"' and column_name =
       '"'"'ai_provider_exclusive'"'"'"'` = 1;
     - 0089: stesso wrapper, `select count(*) from
       information_schema.tables where table_schema = 'public' and
       table_name in ('commit_summaries','nightly_items',
       'doc_page_pending_commits')` = 3;
     - 0090: stesso wrapper, `select count(*) from pg_enum e join pg_type t
       on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public' and t.typname = 'notification_kind' and
       e.enumlabel = 'docs.nightly_attention'` = 1.
     (Dentro `sh -c '...'` gli apici della query vanno scritti `'"'"'`, o
     più semplice: apri `docker compose exec postgres sh -c 'psql -U
     "$POSTGRES_USER" -d "$POSTGRES_DB"'` e incolla le query a mano.) Il
     server nuovo non accoda più lavoro Docs al push, quindi spegnere i
     daily report al passo 3 non ha controindicazioni.
  3. **Spegni i daily report**: `docker compose exec postgres sh -c 'psql -U
     "$POSTGRES_USER" -d "$POSTGRES_DB" -c "update projects set
     daily_report_enabled = false where daily_report_enabled = true"'`
     (deve riportare tanti `UPDATE n` quante le righe salvate al passo 1).
     Verifica: `select count(*) from projects where daily_report_enabled or
     doc_auto_update;` = 0. Il vecchio worker, ancora in esecuzione fino al
     passo 4, non genera più report per quei progetti: è voluto.
  4. **`worker` e `caddy`, col worker FERMO prima della ricostruzione.**
     Sequenza esatta: (a) controlli d'inattività, tutti a 0 / vuoti, in più
     campioni a distanza di qualche minuto: `select id from doc_generations
     where status in ('running','paused');` vuoto; job e job di backlog
     fermi; `select count(*) from agent_sessions where
     cardinality(live_segment_ids) > 0 and heartbeat_at > now() - interval
     '90 seconds';` = 0; `select count(*) from activity_reports where
     status = 'running';` = 0; `select count(*) from nightly_items where
     status = 'pending' and claimed_at > now() - interval '60 minutes';` =
     0. (b) Passati i controlli: `docker compose stop worker`. (c) Solo ora
     `docker compose up -d --build worker caddy` (il worker si ricrea per
     ultimo, già con i daily report spenti: il giro che parte al primo tick
     non trova progetti con un interruttore acceso e non fa niente).
     Controlla con `docker compose logs worker --since 10m`.
  5. **Riaccendere è MANUALE, un progetto alla volta**, dall'elenco salvato
     al passo 1: dalla UI (Progetto → Impostazioni → «Daily report») oppure
     `update projects set daily_report_enabled = true where id = '<id>';`.
     Il cancello del golden (sotto) si applica SOLO a «Docs aggiornati ogni
     notte» (`doc_auto_update`), non al daily report: i daily report si
     possono riaccendere SUBITO dopo il passo 4, un progetto alla volta, e
     senza aspettare il golden. Non in blocco: la prima notte utile di un
     progetto riassume fino a 30 giorni dei suoi commit SU TUTTI I RAMI, e
     per questo si parte dai progetti PICCOLI e non se ne riaccende un altro
     prima di aver letto il costo del precedente.
  Il caddy serve l'avviso «il codice è cambiato dopo questa pagina», i testi
  del toggle e la card `docs.nightly_attention` sul web, e la guida utente
  (`apps/docs`, «Nightly updates» in `autogenerated.md`, variabili in
  `configuration.md`, la landing). L'app mobile non va ricompilata:
  `staleSince` nasce `.nullable().default(null)` e il kind nuovo passa da
  `readerSchema`. Env nuove (con default, in compose): `NIGHTLY_START`
  (`02:00`), `NIGHTLY_ALERT_RUNS` (50), `COMMIT_SUMMARY_WINDOW_DAYS` (30),
  `COMMIT_DIFF_MAX_CHARS` (20000), `COMMIT_SUMMARY_MODEL` (`haiku`),
  `RELEASE_NOTES_MODEL` (`sonnet`), `DOCS_NIGHTLY_MODEL` (`sonnet`). Env
  TOLTE: `DOCS_AUTOUPDATE_POLL_SECONDS`, `DOCS_AUTOUPDATE_MAX_PAGES`,
  `DOCS_AUTOUPDATE_MAX_NEW_PAGES` (e i loro 100000 in compose): se sono
  ancora in `/opt/stubwise/.env` il worker le ignora, si possono togliere.
  ⛔ **CANCELLO DEL ROLLOUT, senza eccezioni: NESSUN progetto riceve
  «Docs aggiornati ogni notte» acceso finché `golden:nightly` (la sonda
  dell'allowlist per file) non è VERDE sul CLI pinnato 2.1.287.** L'allowlist
  per file è il confine di sicurezza della fase delle pagine (l'agente legge
  SOLO i file del payload) e al merge non è mai stata misurata su quella
  versione del CLI: finché il golden non la misura, non si accende nulla —
  nemmeno «per provare» su un progetto piccolo. Il cancello copre «Docs aggiornati
  ogni notte» (`doc_auto_update`), NON il daily report (riassunti e report non
  leggono file con l'agente): quello si riaccende col passo 5.
  **Rollout** (dopo il deploy, un progetto alla volta): (a) il golden
  `pnpm --filter @stubwise/worker golden:nightly -- --claude <CLI 2.1.287>`
  da un checkout con Docker (`apps/worker/scripts/golden/README.md`, «Il
  golden `nightly`»): il check dell'**allowlist per file** sul CLI pinnato
  DEVE essere verde prima di accendere le pagine notturne su un progetto
  vero (le regole per file su 2.1.287 non erano mai state misurate); rosso o
  non lanciato = il rollout si ferma qui; (b)
  con la query degli elementi reclamati del passo 4 a 0, accendi «Docs aggiornati ogni
  notte» su un progetto PICCOLO e lancia il giro a mano sul suo repository:
  `docker compose exec worker node dist/nightly/once.js --repository <id>`
  (in locale `pnpm --filter @stubwise/worker nightly:once -- --repository
  <id>`, dopo il build). Stampa il `NightResult`, il costo per modello di
  OGNI run e i riassunti scritti. È un processo a parte dal worker, col suo
  serializer: lancialo quando su quel progetto non gira nient'altro (fix,
  generazione Docs, review) e mai durante il giro delle 02:00; lancialo
  **dopo** `NIGHTLY_START` (gli elementi che scrive portano la notte di
  oggi, e prima delle 02:00 un worker riavviato dopo le 02:00 crederebbe la
  notte già partita) e sul **primo** repository del progetto (il giro
  accoda lì il daily report del progetto; lanciato su un altro, l'elemento
  finisce su quello). ⚠️ **La prima notte di un progetto
  costa in proporzione ai commit dal segnalibro** della sua generazione
  corrente, non alla finestra dei riassunti: i commit fuori finestra li
  accoda `planDocs` (un run Haiku ciascuno). Per un progetto che aveva il
  vecchio aggiornamento acceso fino al 15 ott il salto è piccolo, per uno mai
  acceso possono essere mesi: controllalo PRIMA di accendere con `select
  r.name, g.commit_sha from repositories r join doc_generations g on g.id =
  r.current_doc_generation_id where r.project_id = '<id>';` (e
  `git rev-list --count <commit_sha>..origin/<default>` sul mirror); (c) letto il
  costo reale, accendi gli altri progetti: da lì li prende il giro delle
  02:00.
  **Rollback** (invariato dall'ordine nuovo; in più, se avevi spento i daily
  report al passo 3 e scendi col worker, riaccendili dall'elenco salvato: il
  worker vecchio li genera col poller di sempre): (1) il kind nuovo rende **NON sicuro** scendere col server
  finché ne esistono righe (500 su `/api/inbox`): **prima** `delete from
  notifications where kind = 'docs.nightly_attention';`. (2) Il worker
  vecchio riprende l'aggiornamento dei Docs a ogni push e il server vecchio
  torna ad accodarlo, ma solo coi progetti a interruttore acceso: **spegni
  «Docs aggiornati ogni notte» su tutti i progetti prima di scendere** (era
  la condizione del 15 ott, e il vecchio aggiornamento è quello che
  consumava l'abbonamento) e svuota la sua coda (`delete from
  doc_auto_update_jobs;`, è solo un debounce). (3) Il caddy scende insieme
  al server. (4) Le tabelle nuove restano (il migratore ignora 0089/0090 già
  applicate) e il server vecchio non le legge; il valore d'enum non si
  toglie. Scendere col solo worker (server nuovo) lascia i Docs fermi
  finché il worker nuovo non torna: il server nuovo non accoda più nulla.
- **«Backlog solo sessioni» (19 ott 2026)**: piano
  `docs/plans/2026-10-19-backlog-solo-sessioni.md`. Su una voce di backlog
  resta UNA strada, la **sessione di refinement**: tolti ovunque (server
  compreso) la chat della voce in modalità DOCS (`POST /api/backlog/:id/chat`),
  la modalità CODE / sessione di analisi (rotte `code-session`, job
  `chat_turn`), le domande a bottoni del backlog, il **deep dive** (job
  `deep_dive`) e «Aggiorna documento» (`POST /:id/refresh-document`).
  `hasAnalysis` sparisce dal payload del polso (`project.pulse`: notifiche,
  webhook, MCP). Una voce passa da `new` a `refining` da sola al **primo
  messaggio** di una sessione di refinement. Pagina web della voce a due
  colonne (documento | card della sessione e stato). Nessuna compatibilità
  con app vecchie (decisione del maintainer: l'app non è sugli store).
  ⚠️ **Migrazione 0091 IRREVERSIBILE**
  (`packages/db/drizzle/0091_backlog_solo_sessioni.sql`): cancella i job
  `deep_dive`/`chat_turn` (anche `queued`/`running`), azzera il segmento
  attivo delle sessioni rimaste su quelle etichette, marca `undelivered`
  gli interventi `pending` delle sessioni `backlog_item` (non più
  interattive), **DROPpa** `backlog_questions`, `backlog_code_sessions`,
  `backlog_chat_messages` e il tipo `backlog_code_session_status`, e
  **ricrea** `backlog_job_kind` coi soli `intake`, `estimate` (rename del
  vecchio, `ALTER COLUMN … USING kind::text::backlog_job_kind`, drop). Lo
  storico delle chat, delle sessioni di analisi e delle domande è perso:
  **backup del DB PRIMA del deploy**, è l'unico modo per riaverlo.
  **Prima del deploy** (controllo d'inattività, in più campioni a distanza
  di qualche minuto): nessun job di backlog dismesso in volo — `select id,
  kind, status from backlog_jobs where kind::text in ('deep_dive',
  'chat_turn') and status in ('queued','running');` vuoto (la 0091 li
  cancellerebbe comunque: è lavoro perso, non un errore) —, nessuna
  sessione di refinement viva — `select count(*) from backlog_refine_sessions
  where status = 'active';` e `select count(*) from agent_sessions where
  cardinality(live_segment_ids) > 0 and heartbeat_at > now() - interval
  '90 seconds';` a 0 —, più il controllo di sempre del worker (job,
  generazioni Docs `running`/`paused`, elementi del giro notturno reclamati,
  vedi «Giro notturno»).
  **ORDINE**: (1) **backup**; (2) **`server`** — applica la 0091 all'avvio;
  aspetta healthy e verifica: `select count(*) from information_schema.tables
  where table_schema = 'public' and table_name in ('backlog_questions',
  'backlog_code_sessions', 'backlog_chat_messages');` = 0, e `select
  enum_range(null::backlog_job_kind);` = `{intake,estimate}`; (3)
  **`worker`** (col controllo d'inattività qui sopra); (4) **`caddy`** (SPA
  e guida); (5) l'**app mobile** la reinstalla il maintainer dalla build
  nuova (build manuale, `apps/mobile/README.md`): l'app vecchia chiama
  rotte che non esistono più.
  **Env**: TOLTE `BACKLOG_CHAT_TURN_POLL_SECONDS`,
  `BACKLOG_CHAT_SESSION_TTL_MINUTES`, `BACKLOG_CHAT_TURN_TIMEOUT_MS` (se
  restano in `/opt/stubwise/.env` il worker le ignora: toglile).
  **RINOMINATA** `BACKLOG_CHAT_TURN_MAX_TURNS` → `BACKLOG_REFINE_MAX_TURNS`
  (default 15, turni massimi di un turno di refinement): il worker legge
  ancora il nome vecchio come ripiego, con un avviso nel log, e il compose
  lo risolve già lui (`${BACKLOG_REFINE_MAX_TURNS:-${BACKLOG_CHAT_TURN_MAX_TURNS:-15}}`);
  rinominala comunque nel `.env`.
  **Correzioni nello stesso rilascio** (stesso branch): l'intake non scambia
  più il titolo segnaposto dell'app (i primi 300 caratteri del testo) per
  una richiesta troncata (worker); la voce catturata dall'app compare in
  lista quando l'intake finisce, senza riaprire l'app (l'app segue il job
  con `GET /api/backlog/jobs/:jobId`); nella sessione dell'agente
  nell'app: riquadro della voce compatto con foglio di dettaglio, markdown
  anche dal vivo (testo semplice solo oltre `LONG_TEXT_CHARS`), autoscroll
  che si ferma quando non sei in fondo, con «nuovi messaggi» sul bottone ↓.
  **Golden**: tolto lo scenario `refine-read-plan` (esisteva solo per chat
  CODE e deep dive); `refine`, `refine-read` e `refine-read-bash` restano.
  **Post-merge**: mergiare la PR di versioning Changesets
  (`@stubwise/shared` in **major**, export rimossi; `@stubwise/mcp` e
  `@stubwise/claude-plugin` in patch).
  **Rollback — dopo la 0091 scendere d'immagine NON è sicuro**, né per il
  server né per il worker: le immagini vecchie interrogano le tabelle
  DROPpate (dettaglio della voce, rotte della chat e delle domande, poller
  dei turni di chat) e conoscono un `backlog_job_kind` che non ha più
  `deep_dive`/`chat_turn`. Il migratore non torna indietro. L'unico
  rollback completo è **ripristinare il backup** preso prima del deploy
  (perdendo quanto scritto dopo) e poi scendere con server, worker e caddy
  **insieme**. Per un difetto dopo il deploy, si corregge in avanti.
- **«MCP per i collaboratori» (20 ott 2026)**: piano
  `docs/plans/2026-10-19-mcp-collaboratori-design.md`. Migrazioni **0092**
  (`tickets.requested_by_user_id`, tabella `backlog_item_requesters`) e
  **0093** (valore `request.created` di `notification_kind`, DA SOLO nella sua
  migrazione: non si usa nello stesso batch).
  **ORDINE**: (1) **`server`** — applica 0092 e 0093 all'avvio; aspetta
  healthy e migrazioni applicate (`select enum_range(null::notification_kind)`
  contiene `request.created`); (2) **`worker`** (pubblica le card delle
  richieste di backlog; solito controllo d'inattività, niente riavvii con
  lavoro dell'agente in corso) **SUBITO dopo il server**: da questo rilascio
  `POST /api/backlog` mette SEMPRE `requestedByUserId` nel payload del job
  di intake, e lo schema del payload manuale del worker VECCHIO è `.strict()`
  — lo rifiuta con `MalformedBacklogPayloadError` e il job fallisce in modo
  PERMANENTE (nessun retry: la richiesta è persa e va riaperta a mano). Fra
  i due rebuild non deve nascere nessuna voce di backlog (nessuno che apra
  richieste dalla web, dall'app o dal MCP); controllo dopo:
  `select id, error from backlog_jobs where status = 'failed' and error like
  '%payload intake non valido%' and created_at > now() - interval '1 hour';`
  deve essere vuoto; (3) **`caddy`** (SPA: Impostazioni → Claude
  Code, e guida). **Env**: nessuna nuova; il worker usa `PUBLIC_URL`, già
  nel compose, per il link alla voce di backlog nella card (vuoto = solo il
  path).
  **App mobile**: la reinstalla il maintainer dalla build nuova (build
  manuale, `apps/mobile/README.md`): mostra il nuovo tipo di card.
  **Post-merge**: `@stubwise/mcp` e `@stubwise/claude-plugin` (minor) escono
  mergiando la PR di versioning Changesets; poi i collaboratori installano
  dalla sezione web «Claude Code».
  **Rollback**: la 0092 è additiva e le colonne nuove sono ignorate dalle
  immagini vecchie. Ma un `notification_kind` nuovo rende **NON sicuro
  scendere d'immagine sul server finché esistono righe `request.created`**
  (500 su `/api/inbox`): prima `select count(*) from notifications where
  kind = 'request.created';` e, se > 0, cancellale (o correggi in avanti).
  Il caddy scende insieme al server, e **il worker NON scende mai da solo**:
  scende INSIEME al server (stessa finestra, nessuna voce di backlog creata
  in mezzo) — un worker vecchio dietro un server nuovo fallisce in modo
  permanente ogni intake, per la stessa ragione dell'ordine di salita.
- **«Aggiornamento automatico del plugin» (20 ott 2026)**: nessuna
  migrazione, nessuna env. **Rebuild**: solo **`caddy`** (SPA: in
  Impostazioni → Claude Code il comando ora lancia `marketplace add`,
  `plugin install` e per ultimo `setup`; e guida). **Post-merge**: mergiare
  la PR di versioning Changesets e **verificare SUBITO la pubblicazione**:
  `npm view @stubwise/mcp version` deve dire la versione nuova (0.10.0). Il
  plugin nuovo fissa `@stubwise/mcp@0.10.0` e i client con l'aggiornamento
  automatico lo prendono da `main` appena mergiato: se `changeset publish` è
  fallito, `npx` dà 404 e il server MCP non parte per nessuno di loro —
  rilancia subito il workflow Release o reverta il commit di versioning. Da
  qui `@stubwise/mcp` e
  `@stubwise/claude-plugin` sono nel gruppo `fixed` ed escono con la STESSA
  versione (il plugin salta da 0.2.0 a 0.10.0, insieme all'MCP), e il
  `.mcp.json` del plugin fissa `@stubwise/mcp@<versione>`. `setup` accende
  `autoUpdate: true` sulla voce `extraKnownMarketplaces.stubwise` delle
  impostazioni utente di Claude Code. **Chi ha già il plugin** (installato
  prima di questo rilascio) ha l'aggiornamento automatico SPENTO: rigenera il
  comando dalla pagina web e lo rilancia UNA volta (rilanciarlo è sicuro:
  `marketplace add` e `plugin install` già fatti escono con 0; ma ogni
  comando generato crea un token «Claude Code» nuovo, e quello vecchio va
  revocato in Impostazioni → Token di accesso). Nota: un
  `claude plugin marketplace add` rilanciato da solo riscrive la voce e
  toglie `autoUpdate` (CLI 2.1.304): il comando completo lo riaccende alla
  fine. **Rollback**: caddy indietro senza conseguenze (torna il comando
  vecchio); le versioni npm già pubblicate non si ritirano, si corregge in
  avanti.

- **«Rilascio senza PR di versioning» (20 ott 2026)**: solo CI, nessun
  servizio da ribuildare, nessuna migrazione, nessuna env. Il workflow
  Release non apre più la PR «Version Packages»: parte con `workflow_run`
  quando la CI del push su `main` è verde, versiona, pubblica su npm e
  **poi** pusha su `main` il commit di versione con i tag (se la
  pubblicazione fallisce non pusha nulla). La CI delle PR è divisa in job
  paralleli (check, plan, un gruppo di test per macchina) con le stesse due
  reti di sicurezza.
  **Prerequisito**: `main` ha il ruleset «protect-main» (PR obbligatoria,
  niente force-push né cancellazione). GitHub Actions non può stare fra i
  suoi `bypass_actors` su un repo personale (API: 422 «must be part of the
  ruleset source or owner organization»), quindi il push del commit di
  versione lo fa una **deploy key** dedicata: secret `RELEASE_DEPLOY_KEY`,
  deploy key con scrittura «Release (push del commit di versione)», e
  «Deploy keys» aggiunto ai bypass di protect-main (fatto il 20 ott 2026,
  accanto al bypass admin). Release verifica il secret PRIMA di pubblicare.
  Se il push venisse comunque rifiutato (GH013) il workflow fallisce con un
  `::error::` che lo dice: le versioni sono già su npm, il commit di
  versione resta sul branch `release/versione-<sha>` da cui aprire una PR, e
  i tag della pubblicazione (elencati nel log) vanno ricreati a mano.
  Revoca: togliere la deploy key (Settings → Deploy keys) e la voce «Deploy
  keys» dai bypass del ruleset.
  **Ordine del rilascio**: (1) la PR di versioning del vecchio flusso
  (#113) è mergiata PRIMA di questa, col flusso vecchio, e pubblica
  `@stubwise/mcp@0.10.0`: verificare `npm view @stubwise/mcp version` =
  0.10.0; (2) poi si mergia questa PR, ribasata su `main` dopo la #113;
  (3) il primo Release nuovo (alla CI verde del merge) deve essere un
  **no-op**: nel log del passo «Cosa c'è da fare» devono comparire
  «Changeset pendenti: nessuno» e «Non ancora su npm: nessuno», e i passi
  successivi saltati; (4) cancellare il branch remoto
  `changeset-release/main`. **Rollback**: revert dei due workflow (e degli
  script in `.github/scripts/`); le versioni npm già pubblicate non si
  ritirano.

- **«Reset e cambio della password» (21 ott 2026)**: migrazioni **0094**
  (tabella `password_reset_tokens`) e **0095** (colonna
  `personal_access_tokens.kind`, `manual`|`mobile`, testo + CHECK, default
  `manual`, con backfill a `mobile` dei token il cui nome è `Mobile · …`),
  entrambe additive, nessun enum, nessuna env nuova. **Ordine**: prima
  **`server`** (healthy e migrazioni applicate), poi **`caddy`** (Team →
  «Reimposta password», pagina pubblica `/reset-password/<token>`,
  Impostazioni → Account → «Cambia password»). Il worker non c'entra.
  Nessun passo manuale: `PUBLIC_URL` è già configurato, ed è da lì che il
  server compone il link che l'admin copia (vale 24 ore, monouso, nel DB
  solo lo sha256 come per i PAT). Cosa fa: usare il link chiude TUTTE le
  sessioni a cookie dell'utente; il cambio dal profilo chiude le ALTRE (non
  quella corrente), è rifiutato con un PAT (403 `session_required`) e
  annulla un link di reset ancora aperto. **Entrambi revocano i token
  dell'app mobile** (`kind = 'mobile'`, quelli di `/mobile-login`) e ne
  spengono i device push (`pat_revoked`): l'app torna al login e **si
  rientra con la password nuova**. I PAT creati a mano (MCP, Claude Code)
  restano validi. Limite del backfill: un PAT creato A MANO prima del
  rilascio con un nome che inizia per `Mobile · ` viene classificato
  `mobile` (e quindi revocato al prossimo reset); da qui in poi il tipo lo
  scrive solo `/mobile-login`. **Dopo il deploy** controllare cosa ha
  classificato il backfill (ogni riga dovrebbe essere davvero un telefono;
  un PAT manuale finito qui si riporta con `update personal_access_tokens
  set kind = 'manual' where id = '…';`):
  ```sql
  select p.id, p.name, u.email, p.created_at, p.last_used_at
  from personal_access_tokens p join users u on u.id = p.user_id
  where p.kind = 'mobile' order by u.email, p.created_at;
  ```
  Il link di reset si crea solo dalla sessione del browser (un PAT, anche
  di un admin, riceve 403 `session_required`), e i token nel path di
  `/api/auth/password-reset/:token` e `/api/auth/invites/:token` sono
  oscurati (`[redacted]`) nel log delle richieste del server. **Rollback**: caddy scende insieme al server;
  il server vecchio ignora la tabella nuova e la colonna `kind` (che ha un
  default, quindi i suoi insert restano validi: un token mobile emesso dal
  server vecchio nasce però `manual`), quindi scendere d'immagine è sicuro.
  I link emessi restano in tabella senza consumatore: `delete from
  password_reset_tokens where used_at is null;` se si vuole ripulire.

- **«Modelli per operazione e consumi» (21 ott 2026)**: migrazione **0096**
  (`packages/db/drizzle/0096_ai_models_and_usage.sql`): tabella
  `ai_model_settings`; `agent_runs` guadagna `operation` (NOT NULL, backfill
  dalle righe esistenti), `project_id`, `provider_id`, `run_id`,
  `cache_creation_tokens`, `phase` diventa nullable, CHECK sul proprietario
  (al più uno); `instance_settings.worker_model_defaults`. Env invariate:
  `FIX_PLAN_MODEL` e le altre restano come default. **Ordine**: prima
  **`server`** (healthy e migrazione applicata), poi **`worker`**, poi
  **`caddy`** — e fra server e worker c'è un passo SQL obbligato, sotto
  («La finestra fra server e worker»). Rotte nuove (admin): `GET/PATCH /api/settings/models`,
  `GET /api/ai-usage/breakdown`. Precedenza del modello: `ai_model_settings`
  → env del worker → default di codice; vale dal run successivo, senza
  riavvio; la generazione Docs lo fissa all'avvio (`doc_generations.model`).
  **PRIMA del deploy, il budget**: il budget mensile
  (`instance_settings.monthly_budget_usd`) ora conta OGNI consumo AI con un
  costo (Docs, giro notturno, report, backlog...), non più solo i job. Stima
  il consumo del mese corrente delle operazioni nuove e rivedi il budget. La
  query copre SOLO le due che un costo lo salvavano già (generazioni Docs e
  riassunti dei commit): note di rilascio, pagine notturne, daily report, run
  del backlog e brief settimanali prima della 0096 non lasciavano nessun
  costo da nessuna parte, quindi **non si possono stimare**. Il numero qui
  sotto è un pavimento, non una stima: lascia margine nel budget (e
  ricontrolla Utilizzo dopo qualche giorno, quando quei consumi compaiono):
  ```sql
  select
    (select coalesce(sum(cost), 0) from doc_generations
      where created_at >= date_trunc('month', now())) as docs_usd,
    (select coalesce(sum(cost_usd), 0) from commit_summaries
      where created_at >= date_trunc('month', now())) as commit_summaries_usd;
  select monthly_budget_usd from instance_settings;
  ```
  Se la somma — più il margine per ciò che non si vede — si avvicina al
  budget, i job di fix si fermerebbero (`held`) subito dopo il deploy.
  **La finestra fra server e worker**: dalla 0096 applicata al worker nuovo
  in piedi, il worker VECCHIO inserisce in `agent_runs` senza `operation`
  (NOT NULL): l'insert fallisce e viene ingoiato (best-effort). Non è solo
  spesa che manca da Utilizzo e dal budget: il tetto giornaliero della
  classificazione della posta (`countClassifyRunsSince`, che conta le righe
  `phase = 'email_classify'`) non conta più niente, quindi **il tetto per
  casella non scatta**. E la finestra può essere lunga, perché il worker non
  si riavvia con generazioni Docs `running`/`paused`. Quindi: (1) deploy del
  `server`; (2) **SUBITO** dopo che la migrazione è applicata, un default
  provvisorio, così le righe del worker vecchio entrano (etichettate
  `fix_execute`, si rietichettano al passo 4), e annota l'ora come `T0`:
  ```sql
  ALTER TABLE agent_runs ALTER COLUMN operation SET DEFAULT 'fix_execute';
  select now();  -- T0
  ```
  (3) deploy del `worker` **appena** nessuna generazione Docs è
  `running`/`paused` (tieni la finestra più corta che puoi), e quando il
  worker nuovo è in piedi annota `T1` (`select now();`); (4) togli il
  default e rietichetta le righe della finestra dalla `phase`, con lo
  STESSO `CASE` della migrazione 0096 (sulle righe di prima della 0096 è un
  no-op: hanno già quell'etichetta), più il progetto come lo backfilla la
  migrazione:
  ```sql
  ALTER TABLE agent_runs ALTER COLUMN operation DROP DEFAULT;
  BEGIN;
  UPDATE agent_runs SET operation = CASE phase::text
    WHEN 'triage' THEN 'triage'
    WHEN 'review' THEN 'pr_review'
    WHEN 'email_classify' THEN 'mail_classify'
    WHEN 'fix' THEN CASE WHEN model LIKE '%opus%' THEN 'fix_plan' ELSE 'fix_execute' END
  END
  WHERE operation = 'fix_execute' AND phase IS NOT NULL
    AND created_at >= '<T0>' AND created_at < '<T1>';
  UPDATE agent_runs ar SET project_id = t.project_id
    FROM ai_jobs j JOIN tickets t ON t.id = j.ticket_id
    WHERE ar.job_id = j.id AND ar.project_id IS NULL
      AND ar.created_at >= '<T0>' AND ar.created_at < '<T1>';
  UPDATE agent_runs ar SET project_id = r.project_id
    FROM pr_reviews pr JOIN repositories r ON r.id = pr.repository_id
    WHERE ar.pr_review_id = pr.id AND ar.project_id IS NULL
      AND ar.created_at >= '<T0>' AND ar.created_at < '<T1>';
  COMMIT;
  ```
  Una riga del worker NUOVO fra il suo avvio e `T1` con `phase = 'fix'`,
  `operation = 'fix_execute'` e un modello opus verrebbe rietichettata
  `fix_plan`: succede solo se nel frattempo un admin ha messo un opus su
  «esecuzione del fix», quindi non toccare le impostazioni dei modelli
  finché il passo 4 non è fatto. Le righe ingoiate fra la migrazione e il
  passo 2 sono perse (pochi secondi). **Prima del deploy, scenari golden**: il runner è
  cambiato (`TrackingAgentRunner` avvolge ogni run) e NON sono stati lanciati
  in sviluppo: lancia `plan-only`, `execute`, `refine` e `nightly` col CLI
  pinnato (vedi «Scenari golden»). **Worker**: niente riavvio con generazioni
  Docs `running`/`paused` o con il giro notturno in corso (query in
  `CLAUDE.md`). **Dopo il deploy**: in Utilizzo il conteggio «Esecuzioni»/job
  conta run distinti; i job storici precedenti alla 0096 che usarono due
  modelli ora contano 2 (nessun backfill di `run_id`), quindi i conteggi
  storici salgono un poco. **Rollback**: il worker vecchio inserisce in
  `agent_runs` senza `operation` (NOT NULL): l'insert fallisce e viene
  ingoiato (best-effort), quindi nessun crash ma consumi persi — e tetto
  giornaliero della posta spento, come nella finestra del deploy — finché
  si resta giù. Per non perderli è la stessa ricetta della finestra: PRIMA
  di scendere `ALTER TABLE agent_runs ALTER COLUMN operation SET DEFAULT
  'fix_execute';` e annota `T0` (`select now();`); al ritorno, col worker
  nuovo in piedi, annota `T1` e lancia il passo 4 qui sopra (`DROP DEFAULT`
  e rietichettatura con lo stesso `CASE`, nella finestra `[T0, T1)`).
  Senza il passo 4 le righe di triage, review e posta scritte da giù
  resterebbero etichettate `fix_execute`. Il server vecchio legge soltanto
  (`byProject` con inner join sui job): scendere è sicuro. Caddy scende
  insieme al server.

- **«Ruoli e membri di progetto» (22 ott 2026)**: design
  `docs/plans/2026-10-22-permessi-progetto-design.md`, invarianti
  `docs/invariants/permissions.md`. Migrazioni **0097**
  (`packages/db/drizzle/0097_roles_and_members.sql`: tabelle `roles` coi
  sette preset, `project_members`, `invite_projects`; colonne
  `users.instance_role_id` NOT NULL e `invites.instance_role_id`; la
  **conversione** — ogni `admin` → ruolo d'istanza `Admin`, ogni `member` →
  `User` + membro di **tutti** i progetti esistenti con `Legacy Member`, gli
  inviti pendenti → `User` senza progetti; i **trigger** `users_role_derived`
  — `users.role` diventa DERIVATA dal ruolo d'istanza, sincronizzata nei due
  versi per gli scrittori vecchi —, `roles_sync_users` e
  `project_members_role_scope`) e **0098** (`ALTER TYPE notification_kind ADD
  VALUE 'google.proposal_handed'`, da sola: stesso batch della 0097, valore
  mai usato nel batch, vedi la trappola delle migrazioni in `CLAUDE.md`) e
  **0099** (`invites.invited_by_user_id`, FK `ON DELETE SET NULL`: chi ha
  creato l'invito, per riverificare i progetti all'accettazione — ruling
  R51). Nessuna env nuova. **Prima di tutto un backup del DB** (`pg_dump`): la
  conversione riscrive i ruoli di tutti e l'unico modo di tornare
  esattamente a prima è il backup.
  **Controllo PRIMA del deploy** — le card d'inbox pubblicate prima della
  colonna `project_id` ma legate a un ticket:
  ```sql
  select count(*) from notifications where project_id is null and ticket_id is not null;
  ```
  Non vanno riscritte: il filtro di revoca ricava il loro progetto dal ticket
  (`coalesce(project_id, progetto del ticket)` in
  `notificationVisibleToRecipient`), quindi chi non vede quel progetto smette
  di vederle in elenco, conteggio, badge, azioni e consegne. Il numero serve a
  sapere quante card, dopo la conversione, spariranno agli utenti tolti dai
  progetti (con `Legacy Member` ovunque, al deploy: nessuna).
  **ORDINE**: (1) **backup**; (2) **`server`** — applica 0097 e 0098
  all'avvio, attendi healthy e verifica la conversione (sotto); (3)
  **`worker`** — quello nuovo legge `roles`/`project_members` per audience,
  inbox e badge, quindi vuole le tabelle; senza job né generazioni Docs in
  corso (`select id from doc_generations where status in
  ('running','paused');` vuota) e fuori dal giro notturno; (4) **`caddy`**
  (Impostazioni → Ruoli, sezione Membri del progetto, ruolo d'istanza e
  progetti nell'invito, interfaccia guidata dai permessi). Fra (2) e (3) il
  worker VECCHIO funziona: legge `users.role`, che il trigger tiene
  aggiornata; le card che pubblica senza `project_id` restano azionabili (il
  progetto si ricava dal ticket, ruling R34) e sono filtrate a lettura per
  appartenenza. L'app mobile (utente singolo, fuori dagli store) va
  ricompilata quando comoda: i campi nuovi nascono con default.
  **Verifica dopo il server**:
  ```sql
  select u.email, r.name from users u join roles r on r.id = u.instance_role_id;
  -- ogni ex admin → Admin, ogni ex member → User
  select p.name, count(pm.user_id) as membri
  from projects p left join project_members pm on pm.project_id = p.id
  group by p.name order by p.name;
  -- ogni progetto ha tanti membri quanti erano i member (gli admin NON ci
  -- sono: sono membri impliciti di ogni progetto)
  select count(*) from users where role = 'member';
  ```
  Poi, dalla UI: un ex member vede gli stessi progetti e fa le stesse cose di
  prima (è `Legacy Member` ovunque); da lì il maintainer toglie le persone
  dai progetti dove non servono, sceglie per ognuno un preset più adatto
  (`Developer`, `Contributor`, `Viewer`) ed elimina `Legacy Member` quando
  non lo usa più nessuno. **Cambi che gli utenti noteranno**: (a) un
  **progetto creato dopo il deploy non ha membri** salvo il creatore
  (`Project Lead`): gli ex member non lo vedono finché qualcuno non li
  aggiunge — prima ogni utente vedeva ogni progetto; (b) **Slack: un utente
  non collegato non apre più ticket** dal modale (ruling R42: «collegato» =
  `slackUserId` o email del profilo Slack che corrisponde a un utente; il
  modale elenca solo i progetti in cui l'utente ha `tickets.create`, e un
  progetto assente, invisibile o vietato danno lo stesso errore); anche
  `/docs` risponde solo sui progetti visibili; (c) la **cronologia di
  ricerca** nasconde le voci di entità cancellate o non più visibili
  (prima restavano, e aprirle dava errore); (d) i **404** delle risorse di
  progetto hanno il codice generico `not_found` invece di
  `ticket_not_found`/`project_not_found`/`milestone_not_found` (web e app
  aggiornati; un client esterno che distingueva quei codici va adattato);
  (e) le **card d'inbox di prima**, pubblicate senza progetto, restano
  azionabili col progetto ricavato dal ticket (R34); (f) le card di
  `job.held`/`job.budget_held` vanno a chi ha `plans.approve` nel progetto
  (più i full admin), non più a tutti gli admin d'istanza come «ruolo»;
  (g) `request.created` resta per le richieste di chi NON ha
  `project.members.manage` (quindi anche dei `Legacy Member`, come prima);
  (h) le **rotte narrative** del progetto seguono i permessi di lettura
  (ruling R49): nella timeline le voci di ticket altrui servono
  `tickets.view_all`, PR e report `repos.view`, i brief `tickets.view_all`;
  `/reviews` e `/api/activity` vogliono `repos.view`, i brief
  `tickets.view_all` (403 a un `Contributor`), e il registro decisioni
  toglie il riferimento a un ticket che chi legge non vede — un `Legacy
  Member` ha tutti questi permessi e non perde nulla; (i) un **invito senza
  ruolo d'istanza** verifica il preset `User` come un ruolo scelto (403
  `escalation` a chi ha solo `users.invite` senza i permessi di `User`), e
  all'accettazione i progetti dell'invito si riverificano coi permessi
  ATTUALI di chi ha invitato: quelli non più validi si scartano con una riga
  di log `invite: progetto dell'invito scartato all'accettazione` (ruling
  R51); (j) chi gestisce utenti senza essere full admin non agisce (reset
  password, identità, ruolo) su chi ha in un progetto più permessi di lui lì
  (403 `target_above`, ruling R50).
  **Rollback**: caddy scende **insieme** al server. **Scendere d'immagine
  sul server NON è sicuro finché esistono righe `google.proposal_handed`**
  (`select count(*) from notifications where kind = 'google.proposal_handed';`):
  il server vecchio non conosce il kind e risponde 500 su `/api/inbox` (la
  classe di problemi delle fasi 2/5/6). Cancellarle (`delete from
  notifications where kind = 'google.proposal_handed';`) sblocca il
  rollback, ma le proposte passate e non ancora decise restano aperte senza
  nessuna card che le offra: decidile prima, o accetta di perderle. Senza
  quelle righe, la colonna derivata tiene in piedi le immagini vecchie, e
  cosa vede un server vecchio è questo: **ognuno è `member` o `admin`
  secondo `users.role`** (admin = ruolo d'istanza con `instance.full_admin`,
  tutti gli altri — `User` e ogni ruolo personalizzato — member), e
  **nessuna appartenenza è applicata**: ogni member torna a vedere e fare
  tutto ciò che un member faceva su OGNI progetto, compresi quelli da cui è
  stato tolto, e i ruoli di progetto (`Contributor`, `Viewer`...) non
  contano più. Gli scrittori vecchi restano coerenti: un cambio di ruolo dal
  Team vecchio scrive `role` e il trigger sposta il ruolo d'istanza sul
  preset `Admin`/`User`; un invito creato dal server vecchio nasce senza
  ruolo d'istanza (→ `User` senza progetti all'accettazione); un progetto
  creato dal server vecchio NON ha righe in `project_members`, quindi al
  ritorno lo vedono solo i full admin finché non si aggiungono i membri. Il
  worker vecchio è compatibile (legge `role`). Le tabelle nuove restano in
  DB e non vanno toccate: al ritorno valgono come prima del rollback. Un
  ritorno pieno allo stato di prima della conversione è solo il backup.

- **«Secondo fattore sul login» (23 ott 2026)**: design
  `docs/plans/2026-10-23-secondo-fattore-design.md`, invarianti in
  `docs/invariants/second-factor.md`. Migrazioni **0100** (tabelle
  `user_totp`, `user_passkeys`, `user_backup_codes`, `security_events`;
  colonne di sessione `stage`, `second_factor_at`, challenge; contatori del
  blocco su `users`), **0101** (SOLO `ALTER TYPE notification_kind ADD VALUE
  'security.alert'`, mai usato nel batch) e **0102**
  (`users.second_factor_reserved_at`, la prenotazione del tentativo). Env
  nuove: nessuna (usa `ENCRYPTION_KEY` e `PUBLIC_URL`, che esistono già;
  `PUBLIC_URL` deve essere l'URL VERO da cui si raggiunge la web, perché
  `rpID` e `origin` delle passkey ne derivano e perché il link «Apri» degli
  avvisi si costruisce da lì anche nel worker). **PRIMA del deploy,
  backup del DB.**
  **ORDINE**: (1) **backup**; (2) **`server`** — applica 0100–0102
  all'avvio; aspetta healthy e verifica: `select count(*) from user_totp;`
  risponde (0) e `select enum_range(null::notification_kind);` contiene
  `security.alert`; (3) **`worker`** — il worker vecchio non conosce il kind
  `security.alert` (non costruirebbe il DM Slack né il push, e senza
  `publicUrl` non saprebbe il link): va ricostruito dopo il server, col
  controllo d'inattività di sempre, in più campioni a distanza di qualche
  minuto, tutti a 0 / vuoti: `select id from doc_generations where status in
  ('running','paused');`; job e job di backlog fermi; `select count(*) from
  agent_sessions where cardinality(live_segment_ids) > 0 and heartbeat_at >
  now() - interval '90 seconds';`; `select count(*) from activity_reports
  where status = 'running';`; `select count(*) from nightly_items where
  status = 'pending' and claimed_at > now() - interval '60 minutes';` (vedi
  «Worker fail-on-restart» in CLAUDE.md e «Giro notturno»); (4) **`caddy`**
  (schermate di login, configurazione obbligatoria, Impostazioni →
  Sicurezza, dialogo di riconferma, guida). Server e caddy non vanno
  tenuti sfasati a lungo: un server nuovo con la web vecchia lascia chi fa
  login senza la schermata del codice. L'**app mobile** va ricompilata
  (build manuale, `apps/mobile/README.md`; utente singolo, fuori dagli
  store): il login chiede il codice (TOTP o di riserva), e chi non ha il 2FA
  è mandato a configurarlo dalla web. I token dell'app già emessi
  continuano a funzionare.
  **Cosa vedranno gli utenti**: sessioni e token personali esistenti restano
  validi; **al primo login web successivo ognuno passa dalla
  configurazione obbligatoria** (QR, primo codice, 10 codici di riserva da
  salvare), e una sessione di prima del rilascio che fa un'azione sensibile
  (token, password, ruoli, membri, identità) viene mandata alla stessa
  configurazione. Avvisa il team PRIMA del rilascio, e che ognuno tenga
  il telefono a portata di mano.
  **Recupero** (ultimo admin chiuso fuori, o chi non ha più né app né
  codici): un altro con `users.manage` lo azzera da Team (riconferma
  richiesta); se non c'è nessuno, sul server:
  `docker compose exec server node dist/scripts/reset-second-factor.js
  --email <email>` — azzera app, passkey, codici e contatori del blocco,
  chiude le sessioni della persona (i token restano); al login successivo
  riconfigura. Blocco da codici sbagliati (423 `second_factor_locked`): passa
  da solo in 15 minuti; subito, lo stesso script.
  **Rollback**: caddy scende **insieme** al server. **Scendere d'immagine
  sul server NON è sicuro finché esistono righe `security.alert`**
  (`select count(*) from notifications where kind = 'security.alert';`): il
  server vecchio non conosce il kind e risponde 500 su `/api/inbox` (la
  classe di problemi delle fasi 2/5/6). Cancellarle (`delete from
  notifications where kind = 'security.alert';`) sblocca il rollback e perde
  solo gli avvisi di sicurezza passati: il registro `security_events`
  resta. **Prima di scendere cancella le sessioni parziali**: `delete from
  sessions where stage <> 'full';` — un server vecchio non conosce la colonna
  `stage` e le leggerebbe come COMPLETE, cioè password giusta senza secondo
  fattore. Fatto questo, un server vecchio torna al login con la sola
  password e ignora le tabelle e le colonne nuove (restano in DB, non vanno
  toccate: al ritorno valgono come prima); il worker vecchio è compatibile
  salvo che non consegna più gli avvisi di sicurezza. L'app ricompilata
  chiede un campo `code` che il server vecchio ignora. Un ritorno pieno allo
  stato di prima è solo il backup.
