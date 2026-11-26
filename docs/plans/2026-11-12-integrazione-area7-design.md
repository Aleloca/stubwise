# Integrazione area 7: Automations nell'app nuova (design)

> BOZZA di stubwise-94, 12 nov 2026, su richiesta di stubwise-46. Esecutori
> previsti: stubwise-72 (server e worker), stubwise-94 (renderer).
> Orchestratrice: stubwise-46. Branch del design: `docs/area7-inventario`.
> **Specifica**: il design del prototipo
> `docs/plans/2026-10-26-desktop-area7-automations-design.md` (le decisioni
> *(maintainer)* lì sono già prese e qui non si ridecidono), la mappa spec →
> codice → test `apps/desktop/docs/area7-notes.md` (ruling R-J1…R-J24), le
> shape `apps/desktop/.impeccable/shape/{automations,automation-builder,automation-test,automation-sources,claude-automations}.md`,
> i dati finti `apps/desktop/src/renderer/data/seed/automations/`.
> **Inventario**: `docs/plans/2026-11-12-integrazione-area7-inventario.md`
> (§1–4 il prototipo e il server, §5 le 13 decisioni del 12 nov 2026).
> **Rimandi in arrivo** (registro, «Area 7»): il blocco della Home, i segnali
> alla chiusura di un traguardo e alla creazione/conversione di una
> richiesta, le azioni di Claude (bozza, salva/elimina bozza, prova).
> **Invarianti toccate**: `docs/invariants/mail-calendar.md` (le serie non
> avviano lavoro: qui un'eccezione dichiarata, Q8), `permissions.md`,
> `providers.md` (la scelta dell'account), `vault.md` (nessuna credenziale
> raggiungibile), `agent-sessions.md` (le azioni di Claude).

## Cosa c'è già e cosa no

Il prototipo ha un motore completo (~19.000 righe fra `data/automations`,
`domain/automations` e `pages/automations`; ~1.400 stringhe); il server non
ha NIENTE del motore: nessuna tabella, rotta, schema, permesso, poller, e
nessun bus d'eventi (inventario §1, §3).

| Il prototipo | Il server oggi |
|---|---|
| Automazioni, versioni, codici `<PRJ>-A<n>`/`AUT-<n>`, bozze, pausa | **No** |
| Il motore (albero di passi, condizioni, «per ogni», «ripeti finché», attese) e la validazione | **No**; ma `dom/*` è PURO e può stare in `@stubwise/shared` |
| Le esecuzioni che durano giorni e riprendono da sole | **No** motore; ci sono code durevoli con lease (`nightly_items`, `ai_jobs`) da cui copiare il modello |
| Inizi di Stubwise (task creata/chiusa, richiesta, traguardo, email) | **No** bus: `ticket_events` copre i cambi di stato ma non la creazione; traguardo chiuso e conversione non lasciano righe |
| Sorgenti esterne (Audin, HubSpot, webhook in arrivo) | Webhook a forma fissa (git, SDK, `/api/inbound/:slug/ticket`); nessun connettore CRM |
| Passi crea task / traguardo / richiesta, avvisa | I servizi ci sono (`createTask`, `createMilestone`, `createTicket`, `publishNotification`) |
| Passo manda email | L'invio della Posta (area 6, F3: bozze Gmail, invio trattenuto 10 s) |
| Passo di Claude con uscite e campi dichiarati | `TrackingAgentRunner` e `UsageTag`; nessuna operazione «automazione» |
| `automations.manage` | **No**; esistono `integrations.manage`, `settings.manage` |
| Stesso nome, altra cosa | `automation_rules` (il gate dell'auto-fix) e Progetto → Settings → Automations (area 9c) |

## Perimetro (dal prototipo)

Tutto ciò che il design del prototipo mette *(maintainer)*: il motore con un
inizio e un albero di passi; il costruttore comprensibile a chi non è
tecnico; la prova senza effetti su un evento d'esempio; l'approvazione per
passo; le esecuzioni visibili (pagina, progetto, traguardo e task creati,
Home, ⌘K); le sorgenti esterne collegate da chi ha il permesso. Le tre regole
dell'anti-obiettivo valgono così come sono:

1. **Un'approvazione blocca davvero**: nessun percorso la scavalca (né un
   riavvio, né un'altra automazione, né la prova).
2. **Claude sceglie solo fra le strade disegnate**: restituisce un'uscita
   dichiarata e/o i campi dichiarati col loro tipo; fuori elenco è un errore
   del passo. Non esegue azioni.
3. **Tutto tracciato**: il registro di ogni esecuzione dice cosa ha fatto
   ogni passo, con quali dati, perché, chi ha approvato e quando.

Fuori, come nel prototipo: Claude che costruisce o prova le automazioni da
sé (è l'area 10, qui solo le azioni di catalogo del registro); i webhook in
uscita (area 9); il codice scritto dall'utente. Fuori anche **Audin e
HubSpot come connettori veri** *(M, Q2)*: in questa area c'è il webhook in
arrivo per automazione, che Audin e HubSpot possono già chiamare.

## Decisioni (12 nov 2026)

*(M)* = del maintainer, *(O)* = dell'orchestratrice con la consigliata.

- **Q1 = a** *(O)*: a fette, nell'ordine del rischio (sotto).
- **Q2 = a** *(M)*: prima il webhook in arrivo per automazione; Audin e
  HubSpot dopo, fuori da questa area.
- **Q3 = a** *(O)*: una coda con lease, come il giro notturno, e una chiave
  d'idempotenza per effetto scritta nella stessa transazione che avanza il
  cursore.
- **Q4 = b** *(M)*: **come il prototipo**, chi crea l'automazione sceglie
  passo per passo se un'email parte da sola o va approvata. Non è la
  consigliata: restano i tetti (20 email per esecuzione, sulla catena) e la
  casella del proprietario.
- **Q5 = a** *(M)*: gli inizi «richiesta creata» E «richiesta convertita»;
  una task nata da una conversione vale anche come «task creata».
- **Q6 = a** *(O)*: tutti gli scrittori pubblicano gli eventi, da un punto
  unico nella stessa transazione della scrittura, con un elenco chiuso
  verificato da un test.
- **Q7 = a** *(O)*: `automations.manage` di progetto (preset Project Lead) e
  d'istanza (preset admin); sorgenti e tabella cliente → progetto con
  `integrations.manage`.
- **Q8 = a** *(M)*: i passi di Claude possono partire senza un umano, come
  **eccezione dichiarata** all'invariante delle serie, con un tetto di costo
  per esecuzione (testo d'invariante sotto).
- **Q9 = a** *(O)*: sul budget mensile dell'istanza, un tetto per
  esecuzione, un'operazione nuova in `AI_OPERATIONS` (Usage la mostra); la
  prova chiama Claude vero.
- **Q10 = a** *(O)*: una richiesta d'approvazione è una notifica come le
  altre decisioni (inbox, push, Slack DM), più il «Da decidere» della Home.
- **Q11 = a** *(O)*: solo l'app nuova (desktop e `/app`).
- **Q12 = a** *(O)*: «Automations» è il motore; le vecchie `automation_rules`
  (il gate dell'auto-fix) diventano «AI rules» nell'interfaccia dell'area 9
  (la tabella resta com'è).
- **Q13 = a** *(O)*: la ricorrenza mensile si porta e scatta.

### Le risposte alle domande del design (12 nov 2026)

- **D1** *(M, NON la consigliata)*: **nessun tetto di costo per
  esecuzione**; vale solo il budget mensile dell'istanza, controllato
  **prima di ogni passo di Claude** (non solo all'avvio dell'esecuzione).
- **D2** *(M, NON la consigliata)*: **nessun limite in più** per le email che
  partono da sole, come il prototipo (resta il suo tetto di 20 email per
  esecuzione, sulla catena; niente tetto giornaliero).
- **D3 = a** *(M)*: il webhook in arrivo ha un URL segreto per automazione,
  rigenerabile, più un limite di frequenza.
- **D4 = a** *(M)*: la prova con Claude vero la lancia chi gestisce
  l'automazione, col costo stimato detto prima di partire.
- **D5 = a** *(O, 46)*: se il proprietario perde il permesso, l'automazione
  si mette in pausa da sola, con un avviso a chi ha `automations.manage`.

Siccome D1 e D2 tolgono due freni, **la difesa contro un'automazione
impazzita** è: l'idempotenza (Q3: un effetto non si scrive due volte) e il
**limite anti-loop sulla PROFONDITÀ della catena degli eventi** (una catena
di avvii si ferma a 3, e un evento prodotto da un'esecuzione non riavvia
un'automazione già nella sua catena: è del prototipo, `CHAIN_MAX`), che NON
è un limite di quantità. Restano anche i limiti del prototipo dentro
un'esecuzione (200 effetti, 50 giri, 20 email, 100 esecuzioni non finite per
automazione).

## Fette

Ogni fetta si usa da sola, ha il suo piano, la sua review, la sua parità.

- **F1, il motore e le automazioni di progetto.** Automazioni di progetto con
  versioni, bozze, pausa, codici; inizi di Stubwise (task creata e chiusa,
  richiesta creata e convertita, traguardo raggiunto) e a mano; passi crea
  task, crea traguardo, crea richiesta, avvisa, condizione, «per ogni»;
  approvazione per passo; il registro; la prova senza effetti; le esecuzioni
  nel progetto, su task e traguardi creati, nel blocco della Home e in «Da
  decidere»; `automations.manage` di progetto. Il punto unico di
  pubblicazione degli eventi nasce qui (Q6).
- **F2, email e attese.** Passo manda email (dalla casella del proprietario,
  scelta all'accensione; approvazione per passo, Q4); attese di un tempo,
  della risposta a un'email del flusso e di una task chiusa; «ripeti
  finché»; inizi a orario (giorno, settimana, mese, Q13); inizio «email in
  arrivo» (solo le caselle del proprietario).
- **F3, i passi di Claude.** Istruzione, input, uscite e campi dichiarati
  (regola 2), il tetto di costo per esecuzione, l'operazione nuova, la prova
  con Claude vero, l'eccezione all'invariante (Q8).
- **F4, generali e sorgenti.** Automazioni generali (`automations.manage`
  d'istanza), la tabella cliente → progetto, «scegli il progetto»; il webhook
  in arrivo per automazione (indirizzo, esempio → campi, rigenerazione);
  «avvia un'altra automazione» (la catena a 3).
- **Poi, fuori dall'area**: Audin e HubSpot (connettori), le azioni di
  Claude sulle automazioni (area 10, dal registro), i webhook in uscita
  (area 9).

## Il modello dei dati (proposta, da rifinire nel piano della F1)

- `automations`: `id`, `code` (`<PRJ>-A<n>` o `AUT-<n>`, sequenze mai
  riusate per progetto e per l'istanza), `name`, `description`,
  `project_id` (null = generale), `owner_id` (chi l'ha accesa o pubblicata),
  `status` (`draft` | `active` | `paused`), `paused_by`, `paused_at`,
  `mailbox_account_id` (F2), `created_by`, `created_at`, `created_via`
  (`claude` | null).
- `automation_versions`: `automation_id`, `n`, `flow` jsonb (il documento
  dichiarativo del prototipo, validato da `validateFlow`), `published_at`,
  `published_by`, `saved_at`, `saved_by`, `rev` (concorrenza ottimista),
  `tested_rev`.
- `automation_runs`: `automation_id`, `n`, `version`, `title`, `status`
  (`running` | `waiting_approval` | `waiting_event` | `waiting_project` |
  `suspended` | `done` | `failed` | `cancelled`), `event` jsonb, `vars`
  jsonb, `cursor`, `waiting_until`, `pending` jsonb, `project_ids`,
  `parent_run_id`, `origin`, `error`, `started_at`, `ended_at`; per la coda
  (Q3): `due_at`, `claimed_at`, `claimed_by`.
- `automation_run_log`: una riga per passo e giro, come `RunLogEntry`
  (`path`, `kind`, `outcome`, `input`, `output`, `reason`, `why`, `by_id`,
  `effects`).
- `automation_effects`: `run_id`, `path`, `round`, `idempotency_key`
  UNIQUE, `kind`, `object_id`, `created_at` — la prova che un effetto è
  stato scritto (Q3).
- `automation_events` (l'outbox degli eventi, Q6): `kind`, `project_id`,
  `object_id`, `payload` jsonb, `chain` (gli id delle automazioni della
  catena, per il limite a 3), `created_at`, `consumed_at`.
- F4: `automation_sources` (webhook: indirizzo segreto rigenerabile, campi
  dall'esempio), `client_project_links`.

Il motore puro (`domain/automations/{engine,engineLoop,engineInputs,validate,fields,claudeStep,conditions,restore,triggerFields}.ts`)
si sposta in `@stubwise/shared` (come `calendar-grid.ts`): server, worker e
app usano la STESSA regola, e la prova del renderer gira sullo stesso codice
del worker. Chi lo sposta non lo riscrive: è uno spostamento puro, coi suoi
test.

## Il motore nel worker (Q3)

- Un **poller con lease**, come `nightly_items`: reclama le esecuzioni
  dovute (`due_at <= now`, non reclamate o con la lease scaduta) con `FOR
  UPDATE SKIP LOCKED`, avanza di UN input alla volta per esecuzione (come
  `inTurn` del prototipo), rilascia.
- **Un effetto, una transazione**: l'effetto (la task, il traguardo, la
  richiesta, l'avviso) si scrive con la sua chiave d'idempotenza
  (`run_id:path:round`) NELLA STESSA transazione che avanza il cursore. Un
  crash prima del commit non lascia né l'effetto né l'avanzamento; uno dopo
  li lascia tutti e due. Una ripresa che trova la chiave non rifà l'effetto.
- **L'email** (F2) non è una scrittura locale: la chiave d'idempotenza è
  l'invio trattenuto della Posta (`mail_outgoing`, area 6 F3), creato nella
  transazione del cursore; il worker della Posta lo manda come ogni altro.
- **Un passo di Claude** (F3) non è un effetto: il suo risultato (uscita e
  campi) si salva nel registro prima di scegliere il ramo; una ripresa dopo
  il commit non richiama il modello.
- **Pausa**: nessun nuovo inizio; un'esecuzione in attesa si sospende
  subito, una con un effetto in volo al confine del passo; un evento
  arrivato in pausa si perde (prototipo).
- **Permessi del proprietario A OGNI EFFETTO**: `projectPermissionsFor` del
  proprietario adesso; perso → il passo fallisce con `permission_lost`,
  riprovabile.
- **Limiti** (`AUTOMATION_LIMITS` del prototipo): 20 email per esecuzione
  (sulla catena), 50 giri di un «per ogni», «ripeti» al massimo 10, 200
  effetti per esecuzione, catena a 3, 5 livelli, 100 esecuzioni non finite
  per automazione.
- **Fail-on-restart**: con la lease, un riavvio del worker NON perde
  esecuzioni (riprendono dopo la lease), come il giro notturno.

## Gli eventi: un punto unico di pubblicazione (Q5, Q6)

- `publishAutomationEvent(tx, { kind, projectId, objectId, payload, chain })`
  in UN modulo condiviso (`packages/notifications` o `packages/db`, come
  `project-timeline.ts`), che scrive in `automation_events` nella STESSA
  transazione della scrittura che lo genera.
- **Gli eventi di Stubwise**: `task_created`, `task_closed`,
  `request_created`, `request_converted` (Q5), `milestone_reached`; la F2
  aggiunge `mail_received` (dal poller Google, solo per le automazioni il cui
  proprietario possiede la casella).
- **Una task nata da una conversione** pubblica `request_converted` E
  `task_created` (Q5).
- **Gli scrittori, elenco chiuso** (Q6), verificato da un test che cerca nel
  sorgente ogni scrittura di `tickets` (insert e cambi di stato verso la
  famiglia chiusa), `backlog_items` (insert e conversione) e `milestones`
  (chiusura) e controlla che passi da un chiamante di
  `publishAutomationEvent` — come l'elenco chiuso della cassaforte
  (`vault-isolation.test.ts`). Oggi sono, dall'inventario: le rotte e i
  servizi del server (`task-writes.ts`, `tickets.ts`, `backlog.ts`,
  `milestones.ts`, `routes/webhooks.ts` per il merge di una PR), il catalogo
  di Claude, il worker (`pipeline/triage.ts`, `pipeline/fix.ts`,
  `backlog/intake.ts`, `google/calendar-auto.ts`), l'ingestione SDK
  (`ingest/processor.ts`), il widget, `POST /api/inbound/:slug/ticket`.
- **Un evento prodotto da un'esecuzione** porta la sua catena: non riavvia
  un'automazione già nella catena, e la catena si ferma a 3.
- **Il consumatore**: il poller del motore legge `automation_events` non
  consumati, trova le automazioni attive il cui inizio corrisponde
  (`startsOn` del prototipo: il proprietario vede il progetto; una di
  progetto solo per il suo; il filtro passa) e crea le esecuzioni, poi segna
  `consumed_at`; sveglia anche le attese (risposta nella stessa
  conversazione, task del flusso chiusa).

## Permessi (Q7)

- `automations.manage` **di progetto** (preset Project Lead): creare,
  modificare, accendere, mettere in pausa, provare, avviare a mano, annullare,
  riprovare, saltare le automazioni del progetto e le loro esecuzioni.
- `automations.manage` **d'istanza** (preset admin): lo stesso per le
  generali (F4).
- **Vedere**: le automazioni di un progetto le vedono i membri; le generali
  chi ha il permesso d'istanza; un'esecuzione segue la sua automazione, più
  chi deve decidere. Nascosto = inesistente (R-G5), anche DENTRO
  un'esecuzione (R-J12: progetti e codici che non vedo senza id né nome).
- `integrations.manage` (già esistente): le sorgenti e la tabella cliente →
  progetto (F4).
- **Il proprietario è chi l'ha accesa o pubblicata**: l'automazione agisce
  coi SUOI permessi e la SUA casella; il dialogo lo dice.
- La posta: l'inizio «email in arrivo» legge solo le caselle del
  proprietario; mittente, oggetto e testo li vede solo lui (R-J13, R-J16);
  chi approva vede l'anteprima (R-J14).
- Ogni rotta dichiara `config.access` (test del registro); i ruoli
  personalizzati nascono senza `automations.manage`.

## Costi (Q9)

- Un'operazione nuova in `AI_OPERATIONS`, `automation_step` (gruppo nuovo
  `automations`), con la migrazione dei CHECK di `agent_runs` e
  `ai_model_settings`; Impostazioni → AI e Usage la mostrano con la sua
  etichetta.
- Ogni passo di Claude passa dal `TrackingAgentRunner` con un `UsageTag`
  (`operation: "automation_step"`, `projectId`, il run dell'automazione).
- **Il budget mensile dell'istanza** vale anche qui; il blocco d'istanza
  tiene l'esecuzione al confine del passo (il prototipo: `holdForAi`) e la
  riprende quando si sblocca.
- **Nessun tetto per esecuzione** *(D1, M)*: vale il budget mensile
  dell'istanza, controllato PRIMA di ogni passo di Claude (non solo
  all'avvio): esaurito, l'esecuzione resta al confine del passo (`holdForAi`
  del prototipo) e riprende da sola quando il budget torna, come gli altri
  lavori AI; il proprietario lo vede nel registro.
- **La prova chiama Claude vero** (Q9, D4): la lancia chi gestisce
  l'automazione, col costo STIMATO detto prima di partire, e conta sul
  budget mensile.
- Il passo di Claude non ha strumenti, non esegue azioni, legge i suoi input
  fra delimitatori come contenuto NON fidato (un'email, una risposta del
  cliente, un documento).

## Approvazioni e notifiche (Q10)

- Un passo «chiede approvazione» crea una decisione: una notifica nuova
  (`automation.approval`) in inbox, push e Slack DM come le altre decisioni,
  più il «Da decidere» della Home (Approva, Rifiuta, Correggi per le email).
- Altri `notification_kind` nuovi: `automation.failed` (al proprietario),
  `automation.notify` (il passo «Avvisa»). Un kind nuovo rende NON sicuro
  scendere d'immagine sul server finché ne esistono righe (CLAUDE.md): la
  voce di deploy-log lo dice.
- I campi che un client legge sulla card si DERIVANO a lettura (la regola
  delle card d'inbox): approvatori, stato dell'esecuzione, anteprima.
- La decisione rimandata (con le correzioni) non cade su un passo nuovo
  (`expectedPath`, R-J8).

## «AI rules» per le vecchie `automation_rules` (Q12)

Nell'interfaccia dell'area 9 la sezione «Automation» delle impostazioni
d'istanza (il gate dell'auto-fix per tipo di ticket, la review delle PR) si
chiama «AI rules», e Progetto → Settings → Automations (area 9c: gli
interruttori di Claude, il pulse, il tetto delle correzioni) si chiama «AI
switches» (o simile, nel piano dell'area 9). Tabelle e rotte restano quelle
di oggi: è un cambio di parole, non di dati. «Automations» resta il motore.

## La ricorrenza mensile (Q13)

L'inizio a orario capisce `FREQ=DAILY`, `WEEKLY` e `MONTHLY;BYMONTHDAY=n`
(il costruttore la offre già, il prototipo non la faceva scattare: corretto
anche lì), nel fuso Europe/Rome, una volta al giorno per automazione. Un
giorno che il mese non ha (il 31 di aprile) cade all'ultimo giorno del mese.

## L'eccezione all'invariante delle serie (Q8)

Da aggiungere a `docs/invariants/mail-calendar.md` (accanto a «Una serie
ricorrente è spenta di default, e la sua azione automatica non avvia MAI
lavoro»), e da richiamare in un file nuovo `docs/invariants/automations.md`:

> **Un'automazione PUÒ avviare un passo di Claude senza un umano — ed è
> l'unica eccezione.** L'invariante delle serie del calendario resta intera:
> `calendar-auto.ts` non avvia mai lavoro. Un'automazione (area 7) invece può
> far partire un passo di Claude da un inizio automatico (un evento, un
> orario, un'email), perché è il suo scopo dichiarato («Claude legge il
> contratto e ne ricava le task»), alle condizioni che lo rendono
> accettabile:
> 1. il passo di Claude **non esegue azioni**: restituisce un'uscita fra
>    quelle disegnate e/o i campi dichiarati col loro tipo, e le azioni sono
>    solo i passi del flusso, coi permessi del proprietario (regola 2);
> 2. **il budget mensile dell'istanza, controllato prima di OGNI passo di
>    Claude** (non solo all'avvio): esaurito, l'esecuzione si ferma al
>    confine del passo e non chiama il modello (D1 del maintainer: nessun
>    tetto per esecuzione);
> 3. ogni passo di Claude passa dal `TrackingAgentRunner` con l'operazione
>    `automation_step`, e Usage lo mostra;
> 4. l'input è contenuto NON fidato (delimitato, senza strumenti);
> 5. nessun altro percorso automatico (serie del calendario, pulse, brief,
>    giro notturno) prende questa eccezione: chi ne vuole una nuova la
>    dichiara qui.
> Verificato con un test negativo: con il budget mensile esaurito un passo
> di Claude non chiama il modello, anche a metà di un'esecuzione partita
> quando il budget c'era;
> `decisions-never-ai.test.ts` resta verde (il registro decisioni non è mai
> scritto dall'AI, neanche da un passo di Claude).

## Global Constraints

- Le tre regole dell'anti-obiettivo: un'approvazione blocca davvero; Claude
  sceglie solo fra le strade disegnate; tutto tracciato.
- Un'automazione agisce coi permessi del PROPRIETARIO, ricontrollati a ogni
  effetto; nessuna credenziale della cassaforte è raggiungibile.
- Nessun effetto senza la sua chiave d'idempotenza nella transazione del
  cursore; una ripresa non rifà un effetto.
- Ogni scrittore di task, richieste e traguardi pubblica l'evento dal punto
  unico (elenco chiuso, test).
- La posta resta del proprietario della casella (`mailbox_owner`).
- Nascosto = inesistente, anche dentro un'esecuzione.
- Verso i client solo campi additivi con default; test filtrati;
  mutazioni sui controlli di permesso e sull'idempotenza.
- Il registro decisioni non è mai scritto dall'AI.

## Review Focus (per le fette)

- **F1**: l'approvazione non si scavalca (riavvio, altra automazione, prova,
  una decisione rimandata su un passo nuovo); la ripresa dopo un crash fra
  effetto e cursore non duplica una task; un permesso perso a metà ferma il
  passo con `permission_lost`; l'elenco chiuso degli scrittori non ha buchi
  (il merge di una PR, l'SDK, il widget, il catalogo di Claude); un evento
  prodotto da un'esecuzione non riavvia la sua catena; R-G5 dentro
  un'esecuzione.
- **F2**: un'email di un passo «parte da sola» rispetta il tetto per
  esecuzione e la casella del proprietario; **un'automazione impazzita**
  (D2: nessun limite in più) — un evento che si autoalimenta (una task
  creata che fa ripartire la stessa automazione, due automazioni che si
  avviano a vicenda) si ferma alla profondità della catena, e migliaia di
  eventi in ingresso non producono MAI due volte la stessa email (la
  chiave d'idempotenza) né superano 20 email per esecuzione; un'email «da approvare» non parte prima dell'Approva
  (nemmeno dopo un riavvio); l'attesa della risposta si sveglia solo nella
  stessa conversazione; un'automazione non legge mai la posta di un altro;
  la mensile scatta una volta, nel fuso giusto, anche a fine mese.
- **F3**: un'uscita fuori elenco o un campo del tipo sbagliato è un errore
  del passo, mai un ramo; **il budget si controlla prima di OGNI passo di
  Claude** (D1: nessun tetto per esecuzione), anche dentro un «per ogni» di
  50 giri e in un loop di eventi fermato solo dalla catena; una ripresa
  non richiama il modello; l'input non fidato non diventa un'istruzione;
  la prova con Claude vero conta sul budget.
- **F4**: una generale ricava il progetto solo dalla tabella (o lo chiede);
  il webhook in arrivo ha un indirizzo segreto, rigenerabile, e un payload
  dei tipi sbagliati non avvia niente; la catena di «avvia un'altra» si
  ferma a 3 e non fa cicli.

## Domande del maintainer (risposte: vedi «Le risposte alle domande del design»)

D1. **Il tetto di costo per esecuzione** (Q8, Q9).
- (a) *(consigliata)* Un default d'istanza (proposta: 1 USD), modificabile
  per automazione da chi ha `automations.manage`.
- (b) Solo d'istanza, uguale per tutte.
- (c) Solo per automazione, senza default (chi crea deve sceglierlo).

D2. **Un'email che «parte da sola»** (Q4 = come il prototipo): serve un
limite in più rispetto ai 20 per esecuzione?
- (a) *(consigliata)* Un tetto giornaliero per automazione (proposta: 50),
  oltre il quale le email chiedono l'approvazione del proprietario.
- (b) Nessun limite in più: bastano i 20 per esecuzione.
- (c) Le email ai destinatari ESTERNI al team chiedono sempre
  l'approvazione, quelle interne seguono il passo.

D3. **Il webhook in arrivo** (Q2): chi lo può chiamare?
- (a) *(consigliata)* Chiunque abbia l'indirizzo segreto (rigenerabile), con
  un limite di frequenza, come `/api/inbound/:slug/ticket`.
- (b) Anche una firma HMAC con un segreto per sorgente.

D4. **La prova con Claude vero** (Q9): chi la può lanciare?
- (a) *(consigliata)* Chi gestisce l'automazione, con il costo detto prima di
  partire.
- (b) Solo chi ha anche `usage.view` o `project.usage.view`.

D5. **Le automazioni nate prima di un permesso perso**: se il proprietario
lascia il progetto o l'istanza?
- (a) *(consigliata)* L'automazione si mette in pausa da sé e chi ha
  `automations.manage` lo sa (una notifica); le esecuzioni in corso falliscono
  con `permission_lost` al passo successivo.
- (b) Resta attiva e ogni effetto fallisce, finché qualcuno la ripubblica.
