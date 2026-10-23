# Invarianti e trappole — Sessioni degli agenti

> Estratto da `CLAUDE.md` (14 ott 2026) per tenerlo sotto il limite di
> dimensione: il contenuto è invariato. I rimandi «sopra»/«sotto», «qui sopra»
> e «vedi la voce …» si riferiscono alla struttura originale: le voci di
> deploy stanno in `docs/operations/deploy-log.md`, le invarianti trasversali
> in `CLAUDE.md` (sezione «Invarianti e trappole»), quelle per area in
> `docs/invariants/*.md`.

- **Chi può scrivere, fermare o rispondere in una sessione lo decide il
  SERVER (9 ott 2026, sui permessi dal 22 ott 2026).** `canWrite`,
  `canInterrupt` e `canAnswer` del dettaglio di `/api/agent-sessions` sono
  calcolati dal server (permesso nel progetto della sessione, passo
  interattivo, sessione viva, domanda aperta), e web e app li LEGGONO: il
  campo di scrittura compare solo con `canWrite`, «Ferma e scrivi» solo con
  `canInterrupt`, i bottoni della domanda solo con `canAnswer`. Nessun client
  deduce quei permessi (stesso criterio di `canMerge`): la copia della regola
  starebbe dalla parte che si aggiorna dagli store. Rispondere a una domanda
  NON è intervenire: usa le rotte e il componente di sempre ed è aperto al
  richiedente e a chi ha `plans.approve` nel progetto. Scrivere (e fermare)
  chiede il permesso del KIND, deciso in UN posto, `writePermissionFor`
  (`apps/server/src/services/agent-sessions.ts`): `backlog.edit` nel
  refinement del backlog (`backlog_refine`, i member di prima scrivevano già,
  e `Legacy Member` ce l'ha), `agent_sessions.intervene` in ogni altro kind
  (prima: solo admin; il permesso è escluso da `Legacy Member`, ruling R13).
  `MEMBER_WRITABLE_SESSION_KINDS`, l'eccezione per ruolo del 14 ott 2026, non
  esiste più: il permesso del kind la sostituisce. Lo usano sia il dettaglio
  sia `sendAgentMessage`, prima di qualunque riga; la rotta dichiara solo
  l'accesso alla sessione. Vedere la sessione chiede già `repos.view` nel suo
  progetto (ruling R26, `docs/invariants/permissions.md`), o `backlog.edit`
  per il refinement (23 ott 2026: chi ci scrive la legge sempre). Vedi
  `docs/invariants/backlog-refine.md`. Il test web è a due utenti sugli
  stessi dati, in entrambi i versi (chi ha `canWrite: true` vede il campo).
  `canIntervene` (9 ott 2026) è la sola parte dell'ATTORE di `canWrite` —
  tipo di sessione in `INTERVENABLE_SESSION_KINDS` (job AI e refinement;
  review, Docs, la voce di backlog — stime e merge dell'intake, dal 19 ott
  2026 — e il resto mai) e il permesso del kind nel progetto della sessione
  — senza lo stato del segmento: con lui e la sessione `working`
  il campo resta MONTATO in sola lettura fra un segmento e l'altro (web
  `readOnly`; app con `editable` acceso, le modifiche ignorate e
  `accessibilityState.disabled`), così non perde il focus; senza, su un passo
  interattivo vivo, la riga «solo un maintainer». Nell'app `editable` resta
  acceso perché ci ASPETTIAMO che spegnerlo tolga il focus e chiuda la
  tastiera (comportamento di UIKit/Android, ragionato e non ancora
  verificato): va controllato sul telefono insieme agli altri controlli a
  mano del piano C.
- **Sessioni degli agenti — le regole che reggono la vista dal vivo (8 ott
  2026).** Tutte nel worker o nel server, nessuna nel client:
  - **Lo stdin di un run si chiude dopo `RESULT_GRACE_MS` di silenzio, non
    contando i turni** (`apps/worker/src/agent/streaming-cli.ts`): un
    messaggio scritto a metà turno viene ASSORBITO nello stesso turno (CLI
    2.1.287, verificato e rifissato dallo scenario golden `intervene`), quindi
    i `result` non sono uno per messaggio. Chi «semplifica» contando i
    `result` fa restare appesi i run fino al timeout. I segmenti NON
    interattivi chiudono subito (grazia 0).
  - **Una sessione è viva se ha almeno un segmento aperto con heartbeat
    fresco** (`live_segment_ids` non vuoto E `heartbeat_at` ≤ 90 s,
    `apps/worker/src/sessions/store.ts` in scrittura,
    `apps/server/src/services/agent-sessions.ts` in lettura): ogni segmento
    toglie solo sé stesso, il segmento attivo si svuota solo a elenco vuoto,
    e il worker azzera gli elenchi all'avvio (`resetLiveSegments`). Mai
    fidarsi di `active_segment_*` da solo. La generazione Docs è in **sola
    lettura** in v1 (`docs` fuori da `INTERACTIVE_SEGMENTS`): i suoi nodi
    girano in parallelo nella stessa sessione, e un intervento non saprebbe a
    quale processo andare. In **sola lettura** anche la **review della PR**
    (`review` fuori da `INTERACTIVE_SEGMENTS`): gira senza il plugin base e
    il suo deliverable è il verdetto JSON nell'output — un intervento ne
    farebbe una risposta al maintainer e la review fallirebbe.
  - **Un intervento non sostituisce MAI il deliverable del run** (l'output è
    l'ULTIMO `result`, e un turno aperto da un messaggio finisce con la
    risposta al maintainer). Tre difese, in `apps/worker/src/agent/
    streaming-cli.ts` salvo la terza: (1) al testo scritto su stdin — SOLO
    lì, non all'evento `input` né al commento sul ticket — si accoda
    `DELIVERABLE_REMINDER`; (2) i segmenti interattivi sono classificati in
    `SEGMENT_DELIVERABLE` (un test vuole una voce per ognuno): in quelli col
    deliverable nell'OUTPUT (`plan`, `plan_resume`; fino al 19 ott 2026 anche
    `deep_dive` e `chat_turn`, dismessi) l'handle smette di accettare interventi al primo `result` RIUSCITO (non a un `error_during_execution` da interrupt),
    `deliver` risponde false e il relay marca l'input `undelivered`
    (`stdin_closed`), visibile a chi l'ha scritto — e subito dopo quel
    `result` il recorder, in modo asincrono, abbassa
    `active_segment_interactive` e notifica la sessione (`onInputsClosed`,
    `sessions/store.ts`; no-op se quel segmento non è più l'attivo), così
    `canWrite` diventa false senza aspettare la fine della grazia; in quelli
    coi FILE
    (`execute`, `self_repair`, `correction`, `correction_self_repair`)
    l'intervento entra finché stdin è aperto, e alla sua chiusura a fine
    grazia parte lo stesso segnale (una volta sola per segmento, qualunque
    sia la causa), così `canWrite` cade senza aspettare l'uscita del
    processo; (3) il risultato del run porta
    `inputsDelivered`, e se alla pianificazione è arrivato almeno un
    intervento e l'output non ha la forma del piano (`planHasRequiredShape`,
    `apps/worker/src/pipeline/prompts.ts`: la sezione delle decisioni, lo
    stesso controllo dei golden) il job FALLISCE col template
    `fix.planReplacedByIntervention` invece di parcheggiarsi o di eseguire
    quel testo (`plan_text` non si scrive). Chi rende interattivo un
    segmento nuovo decide dove sta il suo deliverable.
  - **Un intervento si reclama PRIMA di consegnarlo**
    (`SessionInputRelay.deliverPending`, `apps/worker/src/sessions/relay.ts`:
    `UPDATE … WHERE status = 'pending' RETURNING`, poi stdin): le sveglie sono
    più d'una e concorrenti (`LISTEN`, poll, registrazione del processo); chi
    sposta il claim dopo `deliver` riapre la doppia consegna. Come il
    serializer, presuppone un worker a processo SINGOLO.
  - **Le sessioni di posta sono del solo proprietario della casella**:
    `visibleTo` (`apps/server/src/services/agent-sessions.ts`) senza ramo per
    ruolo né per permesso (un full admin non le vede), su elenco, dettaglio, eventi e stream; `emailMessageSession`
    (`apps/worker/src/sessions/owners.ts`) non crea la sessione se il
    proprietario non si risolve, e il CHECK `agent_sessions_email_owner_chk`
    della 0086 la rifiuta comunque. È l'invariante `mailbox_owner` qui sopra:
    gli eventi contengono il testo dell'email — ed è per questo che
    `email_message_id` è in CASCADE: la sessione sparisce col messaggio.
  - **I segreti oscurati sono l'unione di tutti i `.env` del run più la
    chiave del provider e `extraEnv`**: `envSecretsOf` per i primi (ogni
    segmento di un run con worktree, piano e riassunti compresi), il runner
    per gli altri, da sé. Un segreto spezzato fra due eventi PARZIALI non è
    coperto (i parziali non si salvano: lo vede solo chi guarda in quel
    momento).
  - **Stato ed esito di una sessione si DERIVANO a lettura**
    (`deriveAgentSessionState`/`deriveAgentSessionOutcome`,
    `apps/server/src/services/agent-sessions.ts`) dal lavoro proprietario e
    dai segmenti: nessuna colonna li salva, il worker non li scrive. Così
    anche `paused` (10 ott 2026, `deriveAgentSessionPaused`): «Ferma» senza
    testo (`POST /:id/messages` con `interrupt: true` e testo vuoto o
    assente, stessi cancelli di «Ferma e scrivi») è una riga di
    `agent_session_inputs` col testo `''`, e la sessione è in pausa finché è
    viva col segmento che accetta interventi (un result riuscito di un
    deliverable nell'output li chiude, e chiude la pausa), quella è l'ultima
    consegnata, non c'è un intervento successivo in attesa o consegnato, né
    un `segment_end` dopo la consegna, né attività di un turno NUOVO (dopo il
    `turn_end` del turno interrotto). È monotona dalla consegna: la coda di
    quel turno, scritta dopo la consegna, non la fa lampeggiare. In pausa, e
    mentre uno «Ferma» senza testo aspetta la consegna, `canInterrupt` è
    FALSO (server): i client non hanno una regola loro per nascondere
    «Ferma», e un secondo stop è 409 `interrupt_unsupported`.
  - **Un intervento entra quando il CLI lo PRENDE, non quando è scritto**
    (10 ott 2026, `apps/worker/src/agent/streaming-cli.ts`): l'argv ha
    `--replay-user-messages`, ogni intervento va su stdin con `uuid` = id
    della riga `agent_session_inputs`, e l'evento `input` nasce all'ECO con
    quell'uuid (assorbito a metà turno, o all'inizio del turno dopo); un'eco
    senza uno dei nostri uuid (il prompt iniziale) si ignora. Fino all'eco
    l'input è `delivered` senza evento: è ciò che i client mostrano «In
    coda», in fondo, con la regola in UN posto (`buildTranscript`, regola 8,
    `packages/shared/src/agent-transcript.ts`): solo a sessione viva, mai per
    lo «Ferma» senza testo, e mai per il messaggio che RIPRENDE una pausa (il
    CLI fermo lo prende al turno dopo, circa un secondo: sarebbe un lampo).
    Lo stop prende anche il posto della riga generica del turno che
    interrompe (il primo `turn_end` dopo di lui è suo). Scritto e mai
    ripreso a fine segmento → `undelivered`
    (`stdin_closed`, `SessionHooks.inputsNotEchoed` del relay). Lo «Ferma»
    senza testo non scrive righe utente, quindi non ha eco e NON va mai in
    quello sweep: resta `delivered` per tutta la pausa (è l'ancora di
    `paused`); il suo commento sul ticket è un template
    (`comment.agentStopped*`), mai un corpo vuoto. ⚠️ Il commento
    dell'intervento si scrive ancora alla CONSEGNA: uno spazzato dopo resta
    commentato.
  - **La pausa ha un tetto TOTALE per run, e scaduta ANNULLA il run**
    (`AGENT_PAUSE_BUDGET_MS`, 10', `apps/worker/src/agent/pause-budget.ts`;
    configurabile SOLO nei test, mai da env). In pausa la grazia non chiude
    stdin e il timeout dell'agente è sospeso; un messaggio la chiude e il run
    continua. Il budget è la somma delle pause dei segmenti con la stessa
    `pauseKey`, che è del CLAIM, non della riga: `ai_job:<jobId>:<startedAt>`
    (piano, ripresa, esecuzione, self-repair e failover lo condividono; un
    «Rilancia», che ricicla la stessa riga, riparte con 10' pieni) e
    `backlog_refine:<agentSessionId>:<turnId>` per un turno di refinement (fino
    al 19 ott 2026 `backlog_job:<jobId>:<attempts>` per deep dive e chat,
    dismessi). In memoria del
    runner (worker a processo singolo). Scaduto: stdin chiuso,
    `AgentRunCancelledError`. Tre casi limite voluti: a tetto GIÀ esaurito un
    nuovo «Ferma» annulla SUBITO (`budgetExhaustedAtStop`, e il commento lo
    dice); uno «Ferma» nella grazia dopo il result finale di un segmento coi
    FILE mette in pausa un CLI fermo, e se scade il lavoro fatto si butta; in
    un segmento col deliverable nell'OUTPUT un result RIUSCITO arrivato prima
    dell'interrupt chiude la pausa SENZA annullare (il deliverable c'è).
    Fix e correzione chiudono il job `skipped` (nessun valore di enum nuovo)
    con un commento di sistema da template (`comment.agentStopCancelled.*`,
    `recordAgentStopExpired` in `pipeline/job-outcomes.ts`: chi, perché, e
    «nessuna PR aperta» per il fix / «niente pushato sulla PR, i commit già lì
    restano» per la correzione), nessun `job.failed`, niente commit/push/PR (il
    worktree si smonta col throw). ⚠️ **Lo stato del ticket NON si scrive**:
    fix e correzione lo cambiano solo alla loro fine, quindi un «ripristino»
    potrebbe solo annullare la scelta di una persona fatta durante la pausa.
    La correzione chiude `done` come ogni altra chiusura (conta come giro:
    `cancelled` restituirebbe un giro al ciclo automatico subito dopo uno
    «Ferma»), con promozione e review della head attuale. (Deep dive e turno
    di chat, che qui avevano un esito proprio, sono stati dismessi il 19 ott
    2026.) Il tetto entra UNA volta in `assertStaleInvariant` (149' < 150'):
    chi lo rende per-segmento rifà quel conto.
  - **Il recorder è fail-open**: `safeSink` nel runner e gli `attempt(...)`
    del recorder ingoiano ogni errore — compreso un logger che lancia
    (`safeLogger`, `apps/worker/src/sessions/store.ts`, usato anche dal
    relay): senza, lo scrittore restava fermo con `running` a true e una
    promise rifiutata senza gestore faceva uscire il worker —, e una
    sessione che non si crea (`sessionOption` → `{}`) fa partire quel run
    SENZA sessione: stesso
    runner in streaming, stesso argv, nessun evento registrato (il sink è
    `NOOP_SINK`) e nessun intervento possibile. Il runner classico lo dà
    SOLO `AGENT_STREAMING=false`. Le sessioni non fanno MAI fallire un job.
  - **I nomi dei canali `NOTIFY` stanno in `@stubwise/shared`**
    (`AGENT_SESSION_EVENTS_CHANNEL`, `AGENT_SESSION_PARTIAL_CHANNEL`,
    `AGENT_SESSION_INPUT_CHANNEL`), importati da worker e server: mai un
    letterale, né nel codice né nei test.
- **Le sessioni degli agenti nell'app: privacy, fuoco, confini (9 ott 2026,
  piano C).** (1) **Mai su AsyncStorage**: una sessione contiene il testo
  delle email e l'output dei tool. `shouldPersistQuery`
  (`apps/mobile/src/app/providers.tsx`, passata a `persistQueryClient` come
  `dehydrateOptions.shouldDehydrateQuery`, chiavi in `lib/query-keys.ts`)
  esclude le query `agentSessions`, e `shouldPersistMutation`
  (`dehydrateOptions.shouldDehydrateMutation`) l'invio fermo offline, la cui
  `mutationKey` (`agentSessionKeys.send`) sta sotto lo stesso prefisso. È
  difesa in profondità: la mutazione dell'invio (`AgentComposer`) ha come
  variabile solo la modalità («invia», «ferma e scrivi», «ferma»), il testo
  scritto lo legge dalla closure e non finisce fra le variabili; ma un
  invio ripetuto dopo un riavvio agirebbe su una sessione ormai cambiata, e
  una mutazione futura che portasse il testo non deve poter finire su
  AsyncStorage. Chi aggiunge
  una query o una mutazione che porta quel contenuto la escluda lì, e il test
  (`providers.persist.test.ts`) lo verifica sul client vero, leggendo ciò
  che `persistQueryClient` scrive su AsyncStorage. (2) **Lo stream è vivo
  solo a schermata a fuoco E app in primo piano**: si chiude al blur e
  quando l'app va in `background` (non in `inactive`, che scatta anche per
  un pannello di sistema; lo stato iniziale si legge da
  `AppState.currentState`), e si riapre dal cursore al ritorno, senza
  doppioni. (3) **Lo stream dal vivo usa `XMLHttpRequest`** (nessuna
  dipendenza nuova; le chiamate REST restano sul `fetch` del client):
  401/403/404 sono fatali (`onFatal(ApiError)`), il backoff si azzera solo
  su un frame `data:` vero (non su un ping o sull'HTML di un proxy, come sul
  web), oltre 1 MB la connessione si riapre dal cursore. (4) La tab AGT ha i
  filtri per progetto ed esito come il web (spec §8.2). `AgentSession` sta
  sul ROOT stack (`RootStackParamList`, 9 ott 2026), come la posta: si apre
  sopra le schede, SENZA la barra, da Inbox, Progetti, AGT, ticket e push, e
  indietro torna da dove si era venuti; a freddo `agents/:id` mette `Main`
  sotto (`initialRouteName: "Main"`). Il ticket aperto dalla sessione sta
  anche lui sul root stack, sopra di lei. ⚠️ Chi la apre AL POSTO della
  schermata corrente (la card, `AgentSessionByJob`) non usa `replace`: lo
  stack della schermata non ha la rotta, l'azione sale al root e
  sostituirebbe `Main`. Si usa `replaceWithAgentSession`
  (`lib/open-agent-session.ts`: `navigate` al root, poi un POP col
  `target` sullo stack della schermata — senza bersaglio, un POP che lì non
  trova niente salirebbe al root e chiuderebbe la sessione appena aperta), e
  `AgentSessionByJob` decide solo a schermata a fuoco, come la card. Ogni
  apertura passa da `openAgentSession` (`pop: true`) e la rotta ha `getId`
  = id della sessione: la stessa sessione già nello stack si riprende invece
  di impilarne un doppione, una diversa si spinge sopra. E una schermata registrata sul root stack non chiama
  `useBottomTabBarHeight` (lancia fuori dalle schede, e il mock della suite a
  0 lo nasconde): usa `useBottomTabBarHeightSafe`. (5) **La push di una
  domanda** (`job.awaiting_input`, azione «open») porta alla card con
  `session=1`, che cerca la sessione del job: se c'è apre la sessione sulla
  domanda (e la card esce dal suo stack), altrimenti RESTA sulla card.
  Il deep link `inbox/:id` ha sotto la lista dell'Inbox
  (`initialRouteName: "List"`). (6) `canWrite`/`canInterrupt`/`canAnswer`
  li calcola il server; l'app li legge.
