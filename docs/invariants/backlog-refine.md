# Invarianti e trappole — Sessioni di refinement del backlog (14 ott 2026)

> Design: `docs/plans/2026-10-14-backlog-refine-sessions-design.md`. Voce di
> deploy e rollback: «Sessioni di refinement del backlog» in
> `docs/operations/deploy-log.md`. Le regole generali delle sessioni degli
> agenti stanno in `docs/invariants/agent-sessions.md`: qui solo ciò che il
> kind `backlog_refine` cambia o aggiunge.

- **Le regole a turni del relay valgono SOLO per
  `TURN_BASED_SESSION_KINDS`, e la scrittura dei member SOLO per
  `MEMBER_WRITABLE_SESSION_KINDS`.** Sono elenchi espliciti in
  `@stubwise/shared` (`packages/shared/src/schemas/agent-session.ts`), oggi
  entrambi `{ "backlog_refine" }`: un kind nuovo non li eredita, va aggiunto
  a mano e con una ragione. Il ruolo si controlla in UN posto,
  `sendAgentMessage` (`apps/server/src/services/agent-sessions.ts`), prima di
  qualunque riga: fuori dai kind aperti ai member scrive solo un maintainer,
  e la rotta ha solo `requireAuth` (non c'è più un `requireAdmin` da tenere
  allineato). Il dettaglio deriva `canWrite`, `canInterrupt` e `canClose`
  dalla STESSA regola (`intervenable` in `loadAgentSession`), quindi un
  member può anche fermare («Ferma», «Ferma e scrivi») un turno di refinement
  vivo: `canInterrupt` segue chi può scrivere. I test sono negativi a due
  ruoli e asseriscono sulle righe di `agent_session_inputs`, non solo sullo
  status: un member su una sessione `ai_job` riceve 403 e nessuna riga nasce,
  sulla `backlog_refine` dello stesso progetto la riga nasce.
- **Un messaggio di una sessione a turni non diventa MAI `undelivered` per
  tempismo.** Arrivato a turno finito, a processo uscito o mentre il turno
  aspetta, diventa il turno successivo (il relay lo passa allo scheduler,
  `TurnStarter.requestTurn`). Gli unici motivi di `undelivered` sono:
  `turn_failed` (il turno è fallito e il CLI non ha MAI fatto l'eco del
  messaggio: marcato dal turno stesso, prima di restituire, o lo scheduler ne
  farebbe il turno dopo all'infinito), `budget_exceeded` (budget mensile
  sforato e autore del messaggio non admin: il controllo sta PRIMA del
  serializer), `session_not_live` (la sessione è stata chiusa: «Chiudi»,
  inattività o voce chiusa marcano così gli input ancora `pending`) e
  `stdin_closed` (uno «Ferma» arrivato prima dell'eco del messaggio
  d'apertura: mai rimesso in coda, o ripartirebbe da solo). Il messaggio
  d'apertura si reclama (`pending → delivered`) solo DOPO serializer e
  worktree, subito prima del run: fino ad allora la sessione si mostra
  `queued`, non `working`.
- **Sola lettura per COSTRUZIONE.** Il turno (`runRefineTurn`,
  `apps/worker/src/backlog/refine/turn.ts`) gira con `permissionMode:
  "default"` e un `allowedTools` CHIUSO: `Read`, `Grep`, `Glob` RISTRETTI
  alla parent dir dei worktree della sessione (vedi la voce sotto), `Skill`
  (le skill dei plugin, brainstorming e writing-plans), i tool del grafo
  (`GRAPHIFY_AGENT_ALLOWED_TOOLS`, solo se c'è almeno un grafo: sono gli
  unici `Bash(`) e i tre tool di `REFINE_TOOL_NAMES` (`set_design`,
  `set_plan`, `update_item`). Mai `Edit`, `Write`, `MultiEdit`, `Bash` nudo,
  `WebFetch`, `NotebookEdit`. **Chi aggiunge un tool all'elenco lo dichiara
  qui**, con la ragione. Mai la plan mode: bloccherebbe i tool MCP di
  scrittura. Che in `-p` con `default` un tool fuori elenco non resti appeso
  su una richiesta e non scriva lo verifica lo scenario golden `refine` (repo
  pulito, nessun timeout), insieme a `Skill` non negato (una chiamata in
  errore è rossa; almeno 1 run su 3 deve esercitarla).
  ⚠️ **«Fuori elenco» non vuol dire «negato» per `Bash` — misurato** col CLI
  2.1.287 (golden R3 e `refine-read-bash`, 15 ott 2026, spec §4.2): un `Bash`
  di SOLA LETTURA dentro la cwd (`find`, `cat` di file del repo) è approvato
  dal CLI da sé, ≈ un `Read` della cartella, e il maintainer ha deciso di
  lasciarlo così; un `Bash` che ESCE dalla cwd è bloccato — file fuori dalla
  cartella, i percorsi delle deny rule di `Read` (che il CLI applica anche al
  `cat` di `Bash`), `/proc/*/environ`, e `printenv` chiede l'approvazione (in
  `-p` un no). Lo scenario `refine` lo giudica così: `Bash` di lettura dentro
  = verde, `Bash` riuscito fuori = rosso. **Limiti noti della misura**: (1)
  `/proc` è misurato solo per analogia — i golden girano su macOS, che non ha
  `/proc`: il blocco osservato è un controllo TESTUALE del CLI e dovrebbe
  valere anche sull'immagine Linux del worker, ma lì non è stato eseguito;
  (2) un dump dell'ambiente lanciato da DENTRO la cwd (un `env` senza
  percorsi) non è misurato: si sa solo che `printenv` chiede l'approvazione,
  e l'ambiente del figlio porta la credenziale del CLI; (3) è un
  comportamento del CLI, non nostro: **`refine-read` e `refine-read-bash` vanno
  rilanciati a ogni aggiornamento del CLI** (`refine-read-bash` è opt-in:
  va nominato).
- **La lettura si ferma alla cartella di lavoro (15 ott 2026, voce
  ab9bb5b2).** Nell'allowlist del turno `Read`/`Grep`/`Glob` non sono MAI
  nudi: sono `Read(//<parentDir>/**)` (e `Grep`/`Glob` uguali), con
  `<parentDir>` = `refineParentDir(sessione)`, più la sua forma reale se la
  tmp è dietro un symlink, e le stesse tre regole per OGNI dir di
  `plugins.options.pluginDirs` di QUEL turno (la tmp di `openRunPlugins` e il
  plugin base: le skill rimandano ai file accanto al loro `SKILL.md`). Mai un
  glob su tutte le `stubwise-plugins-*`, che sono le copie degli altri run;
  il volume `PLUGINS_DIR` resta negato. Il doppio slash è la sintassi
  ASSOLUTA delle regole di percorso del CLI (una `/` sola vuol dire
  «relativo al file di settings»). Il motivo è misurato: con `Read` nudo il
  CLI 2.1.287 in `default` concede anche le letture FUORI dalla cwd, e un
  member, scrivendo in una sessione, poteva far leggere all'agente qualunque
  file del container del worker (config e credenziali del CLI,
  `/proc/*/environ`, le config MCP degli altri turni coi segreti del ponte,
  il volume dei plugin). Le letture DENTRO la cwd il CLI le concede da sé in
  `default` anche senza una regola: la protezione misurata viene dall'aver
  tolto i tool nudi più quel default sulla cwd, e la regola ristretta conta
  se cwd ≠ parentDir — quindi la cwd del turno resta ESATTAMENTE la
  parentDir. Sopra, come difesa in profondità, le deny rule di
  `sensitiveReadDenyRules` (`apps/worker/src/agent/read-scope.ts`) su
  `/proc`, `CLAUDE_CONFIG_DIR` (e `~/.claude`), le `stubwise-mcp-*` in tmp e
  `PLUGINS_DIR`, UNITE (mai sostituite) alle `Skill(<plugin>:<skill>)` dei
  plugin: la deny vince sull'allow. La prova è lo scenario golden
  `refine-read`, con due canarini: il #1 in una tmp sorella (negato per
  richiesta non concessa: «Claude requested permissions to read from …») e
  il #2 in un finto `PLUGINS_DIR` (negato DALLA RULE: «File is in a
  directory that is denied by your permission settings.»). 3/3 rosso prima
  (misurato col solo canarino #1: il #2 è arrivato dopo), 3/3 verde dopo coi
  due canarini; `refine` verde con `Skill` esercitato e le letture dentro
  i worktree che funzionano. Chi aggiunge un percorso sensibile al worker
  (un volume, una tmp con segreti) lo aggiunga a `sensitiveReadPaths`. I run
  di fix restano fuori (servono `Bash` ed `Edit` sui worktree).
- **Chat CODE e deep dive: dismessi, e con loro il buco della plan mode
  (19 ott 2026).** Fino al 19 ott 2026 la chat CODE (`chat-turn.ts`) e il
  deep dive (`deep-dive.ts`) giravano in `permissionMode: "plan"`, dove il
  CLI 2.1.287 concede `Read` FUORI dalla cwd anche con una regola
  `Read(//<cwd>/**)` in allowlist (misurato col golden `refine-read-plan`,
  rosso noto). Sono stati tolti entrambi (piano
  `docs/plans/2026-10-19-backlog-solo-sessioni.md`), e con loro lo scenario:
  oggi nessun run di backlog che un member possa pilotare gira in plan mode.
  Chi reintroducesse un run in plan mode con input di un member riapre il
  buco: la restrizione delle letture vale solo fuori dalla plan mode.
- **`permissions.blockReadsOutsideWorkingDirectories`: valutata e scartata
  per ora.** È un'impostazione del CLI 2.1.287 (passabile con `--settings`)
  che, dai testi del binario, CHIEDE per le letture esterne alle working
  directory, in ogni modalità e anche sui percorsi dei comandi `Bash` (da
  verificare se in plan mode sotto `-p` equivale a un no). Non è usata perché
  il `Bash(graphify … --graph /graphs/…)` dei run col grafo legge fuori dalla
  cwd e vorrebbe un `--add-dir` sul volume dei grafi, e perché non è provata
  insieme a `--setting-sources ""`.
- **Il server MCP dei tool non vede il DB né i segreti di Stubwise.** Non
  riceve MAI `DATABASE_URL`, `ENCRYPTION_KEY`, `SESSION_SECRET` né le
  credenziali git (la denylist di `buildAgentEnv`,
  `apps/worker/src/agent/claude-cli.ts`); come `ask-user-mcp`, può invece
  ereditare dal CLI l'env di auth del PROVIDER (`ANTHROPIC_*`/`CLAUDE_*`), che
  non è un segreto di Stubwise. Di suo,
  `apps/worker/src/refine-mcp/` riceve solo `REFINE_BRIDGE_URL` e
  `REFINE_BRIDGE_SECRET` e inoltra al ponte HTTP su loopback del worker
  (`apps/worker/src/backlog/refine/bridge.ts`), che valida e scrive. Il
  segreto vale UN turno: revocato nel `finally` del turno e, alla chiusura
  della sessione, PRIMA dell'abort del turno — nessuna scrittura dell'agente
  è accettata dopo la richiesta di chiusura.
- **Le regole di scrittura di design, piano e metadati stanno in
  `packages/notifications/src/backlog-item-writes.ts`**, condivise fra le
  rotte del server e il ponte del worker: mai una seconda copia. Ogni
  sovrascrittura dell'agente salva il valore precedente in
  `backlog_item_revisions` (con l'`agent_session_id`); le scritture umane
  dalle rotte no. `update_item` non tocca lo stato della voce.
- **Ordine dei lock: prima la voce (`backlog_items`), poi la sessione
  (`backlog_refine_sessions`), in OGNI percorso**: avvio, chiusura e
  riapertura (`apps/server/src/services/backlog-refine.ts`), il ponte del
  worker, conversione, archiviazione e fusione (aggiornano la voce, poi
  chiamano `closeRefineSessionForItem` nella stessa transazione), e
  `sendAgentMessage` (che non blocca la sessione prima di
  `reopenRefineSessionIfClosed`). L'ordine inverso in un punto solo basta per
  un deadlock.
- **Una voce chiusa chiude la sessione con `item_closed`, anche se era già
  chiusa.** Conversione o archiviazione su una sessione chiusa per `user` o
  `idle` riscrivono il motivo in `item_closed` (senza NOTIFY: non c'è niente
  da fermare): il motivo dice che la sessione non si riprende più, e un
  messaggio successivo riceve 409 `item_closed`.
- **Un piano scritto in una sessione di refinement NON è approvato.**
  Conversione e run passano dal gate di sempre (`needsApproval` in
  `apps/server/src/services/jobs.ts`): un member che raffina un piano non lo
  approva, nemmeno indirettamente. Nessun file di questa funzione tocca
  `resolvePlan`, `preApprovePlan`, `revokePlanApproval` o la riga del gate.
- **`agent_sessions.backlog_item_id` non vuol dire più «chat della voce».**
  Lo valorizzano sia `backlog_item` sia `backlog_refine`. Dal 19 ott 2026
  (dismissione della chat della voce) il kind `backlog_item` è solo la
  sessione delle **stime e del merge dell'intake** (`backlogItemSession`,
  `apps/worker/src/sessions/owners.ts`): NON interattiva, fuori da
  `INTERVENABLE_SESSION_KINDS`. La sessione di refinement è `backlog_refine`.
  Chi cerca «la sessione in cui si lavora sulla voce» filtri
  `kind = 'backlog_refine'`; chi legge `backlog_item_id` senza filtrare il
  kind mescola le due.
- **Lo scheduler esiste solo col runner in streaming.** `RefineScheduler`
  (`apps/worker/src/backlog/refine/scheduler.ts`) è cablato in
  `apps/worker/src/index.ts` solo con `AGENT_STREAMING` attivo (il default):
  col runner classico non c'è relay né scheduler, i messaggi restano
  `pending` e la sessione resta `queued` per sempre. Stesso effetto,
  fail-open, se il ponte su loopback non parte all'avvio: una riga
  `ponte del refinement non avviato` nel log, il worker resta su. Il worker è UN processo:
  scheduler, registro dei worktree e segreti del ponte sono in memoria.
- **Limiti noti, accettati.** (1) Il costo dei turni NON entra in
  `monthlyCostUsd`: i run di backlog non scrivono `agent_runs`, e una fase
  nuova vorrebbe un `ALTER TYPE` (`agent_run_phase`). Il budget mensile
  FERMA i turni dei member quando è sforato, ma non li conta. (2) Retention:
  `pruneAgentSessions` (14 giorni sull'ultima attività) cancella la sessione
  e, in cascata, la riga di `backlog_refine_sessions` col `cli_session_id`:
  un «riprendi» successivo riparte da una sessione nuova e vuota, col prompt
  d'avvio (design §5.5). Design e piano restano sulla voce.
