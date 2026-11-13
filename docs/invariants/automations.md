# Automations (area 7)

Le regole che reggono le Automations di progetto (fetta 1, migrazione 0169).
Il piano è `docs/plans/2026-11-12-integrazione-area7-fetta1-plan.md`; la
specifica è il prototipo (`apps/desktop/src/renderer/data/automations/`) e il
motore condiviso (`packages/shared/src/automations/`).

## Gli eventi nascono nel DATABASE, non nel codice (C1, 13 nov 2026)

- `automation_events` (l'outbox) la scrivono SOLO i trigger della 0169, nella
  transazione della scrittura che li genera: un rollback non lascia l'evento,
  un evento non esiste senza la sua scrittura. Nessun codice applicativo
  inserisce in quella tabella; chi pensa di doverlo fare sta aggiungendo uno
  scrittore che i trigger coprono già.
- I trigger e il loro evento:
  - `tickets` AFTER INSERT → `task_created`;
  - `tickets` AFTER UPDATE quando `status_id` ENTRA nella famiglia `closed`
    (`project_statuses.family`) → `task_closed`. Fra due stati chiusi no;
    riaperta e richiusa sì. Vale anche per chi scrive l'enum vecchio
    `tickets.status`: lo traduce `tickets_status_sync`, e il filtro sta nel
    WHEN del trigger, non in `UPDATE OF` (un BEFORE trigger non conta per
    `UPDATE OF`);
  - `backlog_items` AFTER INSERT con `merged_into_id IS NULL` →
    `request_created` (la fusione dell'intake aggiorna una voce che c'è: non
    pubblica);
  - `backlog_item_tickets` AFTER INSERT con `role = 'converted_to'` →
    `request_converted` (la conversione di `convertBacklogItem`);
  - `milestones` AFTER UPDATE `open → closed` → `milestone_reached`.
- **L'ordine nella stessa transazione** (Q5: prima la conversione, poi la task
  che ne nasce) lo dà il CONSUMATORE: gli eventi hanno `txid`
  (`txid_current()`), e quelli di una stessa transazione si leggono con
  `request_converted` prima di `task_created`. Il consumatore è UNO alla
  volta (`pg_try_advisory_xact_lock(CONSUMER_LOCK_KEY)`, chi non lo prende
  salta il giro): due consumatori con SKIP LOCKED si dividevano gli eventi
  di una stessa transazione, e l'ordine diventava un caso.
- **Il payload è una fotografia della riga** al momento della scrittura
  (numero, titolo, stato, incaricato; per una richiesta l'urgenza; per un
  traguardo nome e data). I campi completi dell'inizio (`triggerFields.ts`:
  codice, progetto, richiedente, «dal supporto»…) li compone il consumatore,
  perché alcuni (i richiedenti di una voce) si scrivono DOPO la riga, nella
  stessa transazione, e il trigger non li vedrebbe.

## Le due GUC locali alla transazione

- **`stubwise.automation_run_id`** è l'esecuzione che sta scrivendo. La
  imposta SOLO il motore, con `set_config('stubwise.automation_run_id', <id>,
  true)` prima dei suoi effetti; il trigger la copia in `origin_run_id`, e la
  catena (`chainAllows`, `CHAIN_MAX = 3`) si ferma da lì. Una persona o un
  altro processo non la impostano, quindi i loro eventi hanno
  `origin_run_id = null` e non hanno catena. Mai `set_config(…, false)`: una
  sessione del pool la porterebbe nelle transazioni successive di altri.
- **`stubwise.automation_events = 'off'`** spegne la pubblicazione, solo per
  la sua transazione. **Va usata da ogni operazione di massa** che crea o
  chiude task, richieste o traguardi senza essere un gesto di qualcuno: una
  migrazione, un backfill, un import, il riciclo degli stati, un job di
  manutenzione. Senza, ognuna sfornerebbe un evento per riga e le
  automazioni accese partirebbero a migliaia. Nelle migrazioni:
  `SELECT set_config('stubwise.automation_events', 'off', true);` come primo
  statement (il batch è UNA transazione, quindi vale fino alla fine).
  Gli scrittori di massa noti (oggi il trasloco e il cambio di famiglia
  degli stati, `routes/project-statuses.ts`) stanno nell'elenco
  `MASS_WRITERS` di `packages/db/src/automation-triggers-bypass.test.ts`,
  che controlla che aprano con la GUC: chi ne aggiunge uno lo mette lì.
  Le migrazioni di PRIMA della 0169 girano prima che i trigger esistano: una
  base appena migrata non ha eventi (`migration-0169.test.ts`, «nessuna
  valanga»).
- **Nessuno aggira i trigger.** La GUC qui sopra è l'unico interruttore:
  nessun codice di app, worker, package o migrazione imposta
  `session_replication_role` né fa `DISABLE TRIGGER` (un evento perso non
  lo ritrova nessuno). L'unica eccezione è il passo di rollback scritto
  nella voce del deploy-log, lanciato a mano. Lo verifica un test sul
  sorgente, `packages/db/src/automation-triggers-bypass.test.ts`.

## Il consumatore

- **Nessun recupero retroattivo**: un evento nato prima che un'automazione
  fosse pubblicata (accesa) non la avvia. Il confronto è fra
  `automation_events.created_at` e la pubblicazione della versione attiva;
  accendere un'automazione non riprende gli eventi vecchi.
- Gli eventi consumati si marcano `consumed_at`; un evento senza automazioni
  che lo ascoltano si consuma lo stesso.

## L'esecutore (`apps/worker/src/automations/executor.ts`)

- **Il server non fa mai avanzare il motore.** Approvazioni, rifiuti, il
  progetto scelto, «Riprova», «Salta», la riaccensione entrano come righe di
  `automation_run_inputs`; le consuma l'esecutore, in ordine, uno alla volta.
- Lo stato vero è la riga `automation_runs` più il suo registro: a ogni giro
  il motore lo riprende con `restoreState`, come il prototipo. Un LEASE per
  esecuzione (`claimed_at`, 5′ rinnovati a ogni input, `SKIP LOCKED`, la
  presa con un gettone che solo chi l'ha presa rilascia); un worker morto la
  libera alla scadenza, un riavvio non perde niente. Gli input consumati si
  tolgono dopo 7 giorni (`pruneConsumedInputs`); il registro resta con la
  sua esecuzione. Coi passi di Claude
  (F3) la lease va ripensata: un passo lungo deve rinnovarla.
- **Gli effetti** (`effects.ts`) sono l'UNICO punto che scrive per
  un'automazione, con le scritture di oggi (`createTicket`, `createMilestone`,
  `createRequestItem` di `@stubwise/db`, le stesse delle persone; e
  `publishNotification`), a nome del proprietario. I piani sono quelli
  condivisi (`plans.ts` di `@stubwise/shared`, gli stessi della prova), col
  mondo (`world.ts`) letto dal DB prima di ogni effetto: i permessi del
  proprietario si ricontrollano a OGNI effetto.
- **Idempotenza**: un effetto per passo e giro (`automation_effects`, chiave
  `<run>:<path>:<round>`), scritto nella transazione della scrittura. Un passo
  rifatto ritrova l'effetto e risponde come la prima volta. Nella fetta 1 il
  giro è sempre 0 (`repeatUntil` è della F2: chi lo porta deve dare al giro
  il suo numero, o un passo ripetuto non scriverebbe più).
- La transazione di un effetto imposta `stubwise.automation_run_id`: gli
  eventi che genera portano l'esecuzione, e la catena si ferma da lì.
- **Pausa**: mai con un effetto in volo; si sospende al confine del passo. Il
  passo appena deciso (approvato, progetto scelto) si esegue lo stesso.
- **Chi approva** si risolve ORA (R-J8): la persona indicata, chi ha il ruolo
  nel progetto (la chiave del preset, o l'id di un ruolo fatto a mano), il
  proprietario di adesso — e solo chi vede il progetto. Nessuno → l'esecuzione
  fallisce con `no_approver` e il proprietario riceve `automation.failed`
  (R-J11).

## Le rotte del server (`apps/server/src/automations/`)

- Leggere vuole il progetto dell'automazione (membro, o full admin);
  scrivere vuole `automations.manage` lì. Nascosto e inesistente rispondono
  uguale: 404. Un'esecuzione la vede anche chi deve decidere su di lei ADESSO.
- La bozza si salva con `expectedRev`: un'altra persona l'ha cambiata dopo →
  409 `stale` col rev attuale (niente fusione silenziosa).
- Pubblicare e accendere: zero errori di configurazione (`configErrorsOf`,
  con la disponibilità della fetta 1: un passo fuori fetta è `not_available`
  e non si pubblica), i permessi del NUOVO proprietario dove il flusso crea;
  chi pubblica o accende diventa il proprietario, e `active_since` dice da
  quando l'automazione ascolta.
- Una decisione vale per il passo che aspetta (`expectedPath`,
  `expectedRound`): un altro passo, un altro giro o una decisione già in coda
  → 409 `stale`; un'esecuzione sospesa → 409 `suspended`. Chi decide si
  risolve ora.
- R-G5 nei flussi (un progetto fisso che chi guarda non vede resta senza id,
  e salvando si riprende dalla versione di prima), R-J12 nel registro.
- La prova (`/examples`) usa gli stessi campi dell'inizio del consumatore
  (`automationEventFields`) e gli stessi piani dell'esecutore: fallisce dove
  fallirebbe la vera. Il contesto non nomina nessuno di un progetto che chi
  prova non vede.

## Le card d'inbox

- I quattro `notification_kind` (`automation.approval`, `automation.failed`,
  `automation.notify`, `automation.paused`) sono `account_owner`: UNA persona
  per pubblicazione, scelta dal motore. Stato, approvatori, anteprima e link
  si DERIVANO dall'esecuzione a lettura (la regola delle card d'inbox, in
  CLAUDE.md), mai dal jsonb dell'evento: il campo `automation` della card
  (`automationCardsFor`, `apps/server/src/services/inbox.ts`) dice se
  l'esecuzione aspetta ancora chi legge (chi decide si risolve ORA) e se
  qualcuno ha già deciso. Nel jsonb restano solo gli id e il passo che
  aspettava alla pubblicazione (`path`).
- ⚠️ Esistendone righe, scendere d'immagine sul server NON è sicuro (500 su
  `/api/inbox`): la voce del deploy-log dice come pulire prima.

## I permessi

- `automations.manage` è di progetto: lo ha il preset Project Lead (e i full
  admin); gli altri preset e i ruoli personalizzati nascono senza.
- I permessi del PROPRIETARIO si ricontrollano a ogni effetto: `createTask` →
  `tickets.create`, `createMilestone` → `tickets.edit`, `createRequest` →
  `backlog.create`; `notify` non scrive, ma i destinatari devono vedere il
  progetto.

## Le tabelle

- `automation_run_log` è append-only: un trigger rifiuta ogni UPDATE.
- `automation_effects.idempotency_key` (`<run>:<path>:<round>`) è unica: un
  passo rifatto (riavvio, ritentativo) non duplica l'effetto.
- Al più UNA bozza per automazione (indice unico parziale su
  `automation_versions` `WHERE published_at IS NULL`).
- Le righe create da un'esecuzione portano `automation_run_id` (task,
  traguardi, voci di backlog; `ON DELETE SET NULL`): l'origine si DERIVA a
  lettura da lì, mai un nome di automazione scritto nella riga.

## L'inizio «email in arrivo» (F2, decisioni del maintainer del 13 nov 2026)

- **Tutte le email ricevute** dalla casella scelta all'accensione fanno
  partire l'inizio, anche quelle che il cancello dell'ammissione rifiuta;
  non quelle MANDATE dalla casella. Si pubblica dal poller Google, prima
  dell'ammissione (un trigger su `email_messages` perderebbe i rifiutati),
  e solo se la casella ha un'automazione accesa con quell'inizio.
- **Mai il botta e risposta**: un messaggio ricevuto in una conversazione
  in cui l'automazione stessa ha mandato un'email (una riga `mail_outgoing`
  con un suo `automation_run_id`, stessa casella, stesso `gmail_thread_id`)
  NON fa partire quell'automazione: sveglia solo le sue attese su quella
  conversazione. Senza questa regola un risponditore automatico o un
  rimbalzo la farebbero ripartire all'infinito, perché un evento della
  posta non ha origine e la catena non lo vede. Piano della F2, C-F2-5.
- **Le nostre email sono marcate, e una marcata non fa partire niente**
  (review F2, C2, decisione del maintainer *(M)*, 13 nov 2026). Ogni email
  di un'automazione porta `Auto-Submitted: auto-generated` (RFC 3834) e
  `X-Stubwise-Automation: <run>`. Un'email in arrivo con `Auto-Submitted`
  diverso da `no`, o da mailer-daemon/postmaster (i rimbalzi), NON fa
  partire automazioni (`isAutomatedMail`), ma sveglia le attese della
  risposta nella sua conversazione. È ciò che ferma due automazioni su due
  caselle che si rispondono: si fermano al primo giro. Le email delle
  persone partono tutte (F2-1): nessun filtro su `Precedence: bulk` o
  `List-Id`, e nessun tetto giornaliero (D2).

## L'email di un passo (F2)

- **L'eccezione dichiarata al mittente della Posta.** Fino all'area 7 il
  worker mandava un'email SOLO perché una persona aveva premuto Invia. Dalla
  F2 (Q4 = b) un'automazione accesa da una persona manda email da sola: il
  consenso è l'accensione (la casella scelta lì, `mailbox_account_id`) più
  l'approvazione del passo, se c'è. **Una riga di `mail_outgoing` nasce
  dall'Invia di una persona (con la sua bozza) O da un passo di
  un'automazione accesa da lei, dalla sua casella (senza bozza, con
  `automation_run_id`); nessun altro percorso automatico ne scrive.** Lo
  verifica l'elenco chiuso di `packages/db/src/mail-outgoing-writers.test.ts`
  (chi inserisce, chi cambia lo stato): un file nuovo lì è un modo nuovo di
  mandare posta, e va deciso.
- **La chiave è nella transazione del cursore.** L'esecutore scrive la riga
  (`queued`, `send_at` adesso: nessun «Annulla» dei 10 secondi, F2-2) e
  l'effetto `email` con la chiave `<run>:<path>:0` insieme. Il mittente la
  manda senza bozza (`users.messages.send`); il passo aspetta l'esito
  (`inFlight` nel cursore). `sent` → ok col messaggio nel registro;
  `failed` (anche `interrupted`) → il passo fallisce, e NESSUNO la rimanda
  da solo: solo «Riprova» del passo, che toglie la chiave dell'invio fallito.
  La Posta non annulla, riprova né elimina una riga d'automazione (409
  `automation_email`).
- **La posta di un'esecuzione è della SUA casella** (review F2, C1):
  `automation_runs.mailbox_account_id`, scritta quando la run nasce. Da
  quella manda, su quella si sveglia (e solo se l'automazione è ancora del
  proprietario della casella), e il contenuto della posta (R-J13, R-J16) lo
  legge il proprietario di QUELLA casella (`google_accounts.user_id`), non
  chi possiede l'automazione adesso: ripubblicare con un'altra casella non
  passa a un altro la posta di prima. `automations.listens_mail` dice se
  l'automazione ascolta la posta: una che manda soltanto non fa leggere
  niente.
- **Sempre e solo dalla casella del proprietario** (`automationMailboxOf`,
  la stessa regola per l'accensione, la prova e l'esecutore): una casella
  non più sua, disabilitata o senza `gmail.modify` fa fallire il passo
  (`mailbox_*`) e mette l'automazione in pausa (`mailbox_lost`, F2-4 = a).
- **Il tetto**: 20 email per esecuzione, contate sulla CATENA intera; la
  stessa conversazione per le email allo stesso indirizzo nella stessa
  esecuzione.
- **Le attese** (`waiting_event`): la scadenza è `due_at`; la risposta la
  sveglia SOLO un messaggio ricevuto nella stessa conversazione e nella
  stessa casella (`waiting_thread`), la task chiusa SOLO quella creata dal
  passo nella stessa esecuzione (`waiting_ticket_id`). Un input arrivato in
  pausa resta in coda e vale alla ripresa (F2-6 = a). Il testo della
  risposta lo vede solo il proprietario (`hideReplies`, R-J16); di
  un'esecuzione partita da un'email, mittente, oggetto e testo pure (R-J13).
- **Gli inizi a orario** scattano una volta per automazione e giorno locale
  (Europe/Rome) per il vincolo di `automation_schedule_fires`, e non
  recuperano i giorni persi.

## I passi di Claude (F3) e l'eccezione Q8

- **L'unica eccezione all'invariante delle serie (Q8 = a *(M)*).**
  Un'automazione PUÒ avviare un passo di Claude senza un umano (da un
  evento, a orario, da un'email). Alle condizioni, tutte in
  `apps/worker/src/automations/claude-step.ts`: il passo non esegue azioni
  (nessuno strumento, nessun MCP, un turno; le azioni sono i passi del
  flusso coi permessi del proprietario); il budget mensile si controlla
  prima di OGNI passo (D1, `aiBudgetState`, anche dentro un «per ogni» e a
  metà di un'esecuzione partita col budget); ogni passo passa dal runner che
  traccia con `automation_step`; l'input di fuori è non fidato e delimitato.
  Nessun altro percorso automatico (serie del calendario, pulse, brief, giro
  notturno) prende questa eccezione: lo controllano
  `apps/worker/src/automations/q8-exception.test.ts` (il passo lo importa
  solo l'esecutore; `calendar-auto.ts` non nomina esecutori di agenti) e
  `decisions-never-ai.test.ts` (il registro decisioni resta fuori).
- **Il budget in un posto** (`aiBudgetState`, `@stubwise/notifications`):
  esaurito, il passo non chiama il modello e l'esecuzione resta `running`
  con `aiWaiting: monthly_budget`, ripassa ogni 15′ e riparte dal passo; un
  errore del provider aspetta allo stesso modo. Solo una risposta arrivata e
  fuori forma fa fallire (`unknown_outcome`/`bad_field`/`too_many` del
  motore, `claude_invalid` se non è JSON); mai un ramo.
- **Il risultato si salva prima del ramo**, col cursore: una ripresa dopo il
  commit non richiama il modello (un crash prima del commit sì: costo
  accettato).
- **La prova** (`POST …/test/claude`) la lancia solo chi gestisce, rifà il
  budget, usa lo STESSO prompt (`buildClaudePrompt` di shared) e scrive solo
  la riga dei consumi (owner `automation_id`, senza run). La stima
  (`…/test/estimate`) è gratuita.
- **Chi legge la motivazione**: per chi non è il proprietario della posta,
  una riga di Claude su un dato tinto perde `reason` e i campi di testo
  (`reasonHidden`, C-F3-7), oltre a R-J13 e R-J16.


## Le generali, il webhook in arrivo e la catena (F4, 13 nov 2026)

- **Una generale è nascosta = inesistente** a chi non ha
  `automations.general.manage` d'istanza (la chiave è distinta da
  `automations.manage`, che resta di progetto: il catalogo vieta una chiave a
  due livelli). La regola sta in `seesAutomation`/`canManage`
  (`apps/server/src/automations/model.ts`) e la usano elenco, dettaglio,
  esecuzioni, «Da decidere», inbox, ricerca. Una generale ascolta gli eventi
  di Stubwise di ogni progetto che il proprietario vede, e OGNI effetto
  ricontrolla il permesso d'istanza del proprietario (`generalLost` →
  `permission_lost` → pausa, D5). Nella sezione di un progetto le sue
  esecuzioni aperte arrivano a ogni membro solo con codice e stato.
- **Il webhook è una porta pubblica.** Il segreto si salva come sha256 ed
  esce in chiaro solo da creazione e rigenerazione; rigenerare invalida
  subito il vecchio. Il tetto (scelto per automazione da chi la gestisce,
  F4-2 = c) non supera MAI il massimo d'istanza
  (`AUTOMATION_WEBHOOK_MAX_PER_*`), e si conta in Postgres
  (`automation_source_hits`), non in memoria. Il corpo è controllato coi
  campi della sorgente (`checkEventFields` di shared, la stessa regola della
  prova e del prototipo) e nell'outbox entra solo la PROIEZIONE sui campi
  dichiarati: le chiavi in più non arrivano ai passi. I campi restano non
  fidati (`taint.ts`, F3-1). 404, 413 e 429 non scrivono negli eventi
  recenti (un 429 aggiorna solo il contatore della sua finestra, che si
  conta in una transazione a sé prima del parse, così un errore dopo non lo
  annulla). Le chiavi `__proto__`, `constructor`, `prototype` non diventano
  MAI campi né percorsi (`sourceFields.ts`), e un esempio che le contiene si
  rifiuta: il corpo è pubblico, e seguirle scriverebbe su `Object.prototype`
  del processo. Il segreto è redatto nei log delle richieste
  (`PATH_TOKEN_PREFIXES` in `app.ts`). «Un webhook per automazione» si
  controlla sotto il lock della riga della sorgente.
- **Il cliente sceglie solo fra le righe della tabella.** La chiave è
  `clientKeyOf` di shared (trim + minuscole) in scrittura E in ricerca (un
  CHECK la tiene così nel DB). Una riga verso un progetto che il
  proprietario non vede vale come fuori tabella (R-G5), e chi gestisce le
  integrazioni non tocca (né reindirizza, né toglie) una riga verso un
  progetto che non vede: 404. «Remember for
  <client>» scrive la tabella solo con `integrations.manage`: senza, 403 e
  non si sceglie niente.
- **«Avvia un'altra» passa da `planStartAutomation` di shared**, a ogni
  effetto: esiste e il proprietario la vede, la può gestire (R-J21), è
  accesa, non è nella catena, la catena non è a `CHAIN_MAX`. La figlia
  riceve l'evento della madre e porta `parent_run_id`; un passo rifatto non
  crea una seconda figlia (effetto `run`).
- **R-J13 lungo la catena**: una figlia di un'esecuzione partita da
  un'email porta la casella d'ORIGINE in `mail_origin_account_id`, e la posta
  la legge solo il proprietario di quella casella, anche se la figlia è di
  un altro. Non si unifica con `mailbox_account_id`: quella è la casella da
  cui l'esecuzione MANDA (C1 della F2), questa quella di cui l'evento PORTA
  la posta.
- **La tinta segue l'evento lungo la catena**: la figlia di una madre il cui
  inizio porta dati di fuori (sorgente, email, richiesta dal supporto) — o
  che era a sua volta non fidata — nasce con `event_untrusted`. Ogni campo
  del suo inizio è allora un ingresso da fuori (`TaintOptions.eventUntrusted`):
  l'esecutore gira col flusso di `forceApprovalForUntrusted` e la vista
  nasconde ciò che Claude ne ricava. Origine della posta e segno si decidono
  dall'INIZIO della madre, mai dalla forma dell'evento (un webhook può avere
  un campo `email`).
