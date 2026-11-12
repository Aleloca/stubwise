# Integrazione area 7 «Automations»: inventario (12 nov 2026)

Prima carta dell'integrazione dell'area 7: cosa fa il prototipo
(`apps/desktop`, aree 1–11), cosa c'è già sul server, cosa manca, e le
domande di prodotto da chiudere col maintainer prima del design. Solo
documento: nessun codice.

Fonti: il design del prototipo
(`docs/plans/2026-10-26-desktop-area7-automations-design.md`, decisioni
*(maintainer)* e *(scelta del costruttore)*), il suo piano
(`…-area7-automations-plan.md`), la mappa spec → codice → test
(`apps/desktop/docs/area7-notes.md`, ruling R-J1…R-J24), gli shape
(`apps/desktop/.impeccable/shape/automation*.md`, `claude-automations.md`), il
registro dei rimandi (`docs/plans/integrazione-registro-rimandi.md` §«Area 7»)
e una lettura di `apps/server`, `apps/worker`, `packages/db`, `packages/shared`
al ramo `feat/integrazione-area6` (b27c4cad).

Percorsi del renderer relativi a `apps/desktop/src/renderer/`: `d/` =
`data/automations/`, `p/` = `pages/automations/`, `dom/` =
`domain/automations/`.

## In una riga

Il prototipo ha un **motore di automazioni completo** (~19.000 righe fra
dati, motore puro e pagine; ~1.400 stringhe `automations.*`); il server **non
ha niente**: nessuna tabella, rotta, schema, permesso o poller. È l'area con
il buco più grande fra prototipo e server: non un'integrazione ma un
sottosistema nuovo, con un motore che deve girare nel **worker** (attese di
giorni, ripresa da sola, effetti con i permessi del proprietario).

## 0. Due cose diverse con lo stesso nome — fuori da questo inventario

- **`automation_rules`** del server (`GET`/`PUT /api/settings/automation`,
  `settings.manage`): il gate dell'auto-fix per tipo di ticket (`auto_fix`,
  `max_effort`, `plan_approval_min_effort`, `max_cost_usd`) e la review delle
  PR. È area 9 (amministrazione, sezione «Automation»).
- **Progetto → Settings → Automations** del prototipo
  (`data/projectSettings/automations.ts`, area 9c): interruttori di Claude,
  giorni del pulse, tetto delle correzioni. Anche questo è area 9.

Il nome è lo stesso, la cosa no: chi legge «automazioni» nel server oggi
trova queste due, e nessuna delle due è il motore. Va tenuto presente nei
nomi del design (tabelle, rotte, permessi).

## 1. Le voci del registro (area 7)

| Voce del registro | Cosa fa il prototipo | Sul server | Note |
|---|---|---|---|
| Blocco della Home «Automations» | `pages/home/blocks/AutomationsBlock.tsx`, dati `d/entry.ts` `listMyRuns()`: le esecuzioni che mi riguardano (aspettano me → fallite che gestisco → non finite di cui sono il proprietario, poi dalla più recente), 5 righe, «Show all» → `#/automations?view=runs&mine=1`; c'è solo se chi guarda vede almeno un'automazione; non nelle Home di default | il tipo di blocco `automations` esiste già in `HOME_BLOCK_KINDS` di `@stubwise/shared` (e la Home della build app lo conosce, `real/home.ts`); **nessuna lettura** dietro | oggi il blocco è fuori catalogo e fuori dalle Home nella build app (`ofArea`, `ComingSoon.test.tsx`). Anche le approvazioni nel «Da decidere» (`AutomationDecisionItem.tsx`) sono spente |
| Segnali alla chiusura di un traguardo | `updateMilestone` con `closed: true` → `signalAutomations({ kind: "milestone_reached" })` (`data/api-mutations.ts` ~1720) | la chiusura è solo un cambio di stato in `PATCH /api/milestones/:id`: **nessuna riga di evento, nessuna notifica** | la build app non manda il segnale perché non c'è chi lo ascolti |
| Segnali alla conversione di una richiesta | **il prototipo non ne ha uno**: segnala la **creazione** (`request_created`, ~1073, anche da Support); `convertRequestAs` crea la task con `addTask`, non con `createTaskAs`, quindi nemmeno `task_created` parte | `convertBacklogItem` scrive solo il link `backlog_item_tickets` (`role = converted_to`); nessun evento | **la voce del registro non corrisponde al prototipo**: vedi la domanda Q5 |
| Azioni di Claude: crea automazione in bozza, salva/elimina bozza, prova | `data/claude/catalogMore.ts`: `createAutomation` (A, annullabile, **solo bozze di progetto**), `saveAutomationDraft` (A, annullabile), `deleteAutomationDraft` (B); «Who?» = `manageProjectAutomations`. Intento `domain/claude/intents/automation.ts` (solo inizio `request_created` con i filtri «dal supporto»/«urgente», passi crea task a un reparto e avvisa un reparto; email, Slack, chiamate rifiutate). Prova: `data/claude/trial.ts` → `d/simulate.ts` `trialAs`, fino al primo stop, mai oltre un passo di Claude, mai un'approvazione. Claude non accende né pubblica mai (`neverInCatalog.test.ts`) | il catalogo chiuso esiste (`apps/server/src/claude-actions/`, `CLAUDE_ACTION_FNS`); **nessuna funzione** sulle automazioni | dipende da tutto il resto: viene per ultima |

## 2. Cosa fa il prototipo

### 2.1 Schermate

Grammatica delle rotte in `p/automationParams.ts`, montate in `router.tsx`.

- **Elenco `#/automations`** (`AutomationsPage.tsx`, `AutomationList.tsx`):
  per progetto (General in testa); riga = codice · nome · stato in parola ·
  proprietario, sotto inizio, passi, esecuzioni, «N problems». Filtri
  nell'indirizzo: `project`, `general=1`, `status`
  (active/paused/draft/problems), `owner`, `automation`, `mine=1`.
  `?view=runs` (esecuzioni, `RunList.tsx`: running/waiting/suspended/failed/
  finished), `?view=attention` («Needs attention»: problemi di ciò che
  gestisco, fallite che gestisco, esecuzioni che aspettano me). Vuoto: con il
  permesso i due modelli + «da zero», senza una frase.
- **Colonna** (`AutomationsColumn.tsx`): «New automation», viste (All, Runs in
  progress, Needs attention col punto, Drafts), Sources (solo
  `integrations.manage`), scorciatoie per progetto, General solo col permesso
  d'istanza.
- **Creazione** (`CreateAutomationDialog.tsx`, anche da ⌘K via
  `NewAutomationHost.tsx`): nome, dove lavora (un progetto che gestisco, o
  General), punto di partenza (vuota, «Nuovo contratto», «Richiesta dati al
  cliente»); crea una bozza e apre il costruttore.
- **Dettaglio `#/automations/<CODE>`** (`AutomationDetail.tsx`,
  `DetailHeader.tsx`, `DetailSections.tsx`): testata in prosa («Paused by …»,
  «Created by Claude on behalf of …»), azioni per stato (Turn on, Pause,
  Publish vN, Edit, Test, Open draft, Run now, Duplicate, Copy link, Delete
  draft); sezioni Problems, Runs (in corso prima, 20, «Show all»), How it works
  (`FlowSummary.tsx`), Versions, About (proprietario, «agisce come» con la
  casella, progetto, limiti). Dialoghi (`AutomationDialogs.tsx`): accendere/
  pubblicare (dice SEMPRE il cambio di proprietario, sceglie la casella,
  controlla i permessi del nuovo proprietario, «non l'hai ancora provata» con
  «Test first»), pausa, elimina bozza, Run now (i dati dell'inizio a mano),
  duplica una versione (è anche il modo di tornare a una vecchia).
- **Costruttore `…/<CODE>/edit`** (`builder/*`): albero numerato 1…N
  (`role="tree"`, tastiera, trascinamento dnd-kit, «+ Add a step» su ogni
  corsia), pannello del passo («What it does → Where → Before it runs»),
  pannello dell'inizio (`StartPanel.tsx`: tipi d'inizio, filtro, ricorrenza,
  modello del titolo, «DATA YOU CAN USE»), campi con gettoni `{{dato}}`
  (`DataText.tsx`), salvataggio automatico a 400 ms con `rev` ottimista
  (`useAutosave.ts`: un `stale` ferma e chiede di ricaricare), problemi in
  parole (`issues.ts`), fasce «bozza di un'attiva», «sola lettura», «cambiata
  da un altro».
- **Prova `…/<CODE>/test?sim=<id>`** (`test/*`): scelta dell'esempio (eventi
  recenti o «Write one»), fascia fissa «TEST · Nothing here is real», flusso
  coi segni del percorso, anteprime al condizionale, fermate (approvazione,
  evento con «Next» o risposta scritta, progetto) con accanto l'approvatore
  vero, giri dei cicli, «So far / If this were real», «Turn on / Publish» solo
  dopo una prova finita bene, `Blocked.tsx` per gli errori di configurazione.
- **Esecuzione `…/<CODE>/runs/<n>`** (`RunDetail.tsx`): testata (chi l'ha
  avviata, madre e figlie), riquadro «Now» (approva/correggi, scegli il
  progetto, riprova, salta), registro (`RunLog.tsx`, `LogGroups.tsx`: giri
  comprimibili, rami non presi attenuati, «Jump to now», filtro), annulla
  («ciò che è stato creato resta») e salta («i passi dopo possono fallire»).
  Solo prototipo: «Pass time» e «Simulate reply».
- **Sorgenti `#/automations/sources`** (solo `integrations.manage`):
  `SourcesPage.tsx`, `SourcePanel.tsx` (stato, chi l'ha collegata, campi, chi
  la usa, eventi recenti, «Simulate»), webhook (`WebhookSections.tsx`:
  indirizzo da copiare e rigenerare, JSON d'esempio con avviso se spariscono
  campi usati, etichetta e tipo dei campi, «Edit and send»), dialoghi
  (collega, ricollega, scollega dicendo chi si ferma, nuovo webhook, rinomina),
  tabella **cliente → progetto** (`ClientLinks.tsx`, suggerimenti dagli eventi
  recenti; un progetto nascosto è «A project you can't see»).
- **Progetto `#/p/<CODE>/automations`** (`ProjectAutomations.tsx`): esecuzioni
  in corso (proprie e delle generali che hanno agito qui), automazioni del
  progetto, generali che hanno agito qui; voce nella colonna del progetto con
  il conteggio, solo se c'è qualcosa da vedere o chi guarda può crearne.
- **Altrove**: la riga d'origine su task e traguardi («Creata
  dall'automazione X · esecuzione Y», `AutomationOrigin.tsx`), il segno
  «Automazione» fra le origini della task (`tasks-ui/SourceMark.tsx`), ⌘K
  (cerca automazioni ed esecuzioni, «New automation»), Home (§1), la pagina
  Instance status (esecuzioni ferme sul blocco AI, `data/instance/status.ts`).

### 2.2 Il modello

Tipi in `data/model.ts` (~2911–3450).

- **Automazione**: `code` (`<PRJ>-A<n>` di progetto, `AUT-<n>` generale, mai
  riusati), nome, descrizione, `projectId` (null = generale), `ownerId` (chi
  l'ha accesa o pubblicata per ultimo), `status` draft/active/paused (con chi e
  quando l'ha messa in pausa), `mailbox` (la casella scelta all'accensione),
  `versions`, `createdVia: "claude"`.
- **Versione**: `n`, `flow`, `publishedAt/ById` (null = bozza), `savedAt/ById`,
  `rev` (concorrenza ottimista), `testedRev` (R-J19). Modificare un'attiva crea
  la bozza n+1; le esecuzioni finiscono con la versione con cui sono partite.
- **Flusso**: documento dichiarativo `{ trigger, steps, titleTemplate }`, un
  **albero** (nessun salto indietro; cicli solo `forEach` e `repeatUntil`),
  percorsi con la grammatica R-J5 (`"2/forEach[1]/0/then/0"`).
- **Inizi**: `source` (Audin/HubSpot `deal_won`, `webhook`, con i campi della
  sorgente); `stubwise` `task_created`/`task_closed`/`request_created`/
  `milestone_reached`/`mail_received` con filtro facoltativo (campi in
  `dom/triggerFields.ts`); `schedule` (RRULE semplice); `manual`.
- **Condizioni**: gruppi `all`/`any`, confronti `is`, `is_not`, `contains`,
  `empty`, `not_empty`, `gt`, `lt`; i booleani solo con is/is_not (R-J6).
  Niente espressioni libere.
- **Passi**: `createTask` (incaricato persona / dato persona / ruolo nel
  progetto / reparto / nessuno; scadenza relativa; progetto; traguardo di un
  passo precedente), `createMilestone`, `createRequest`, `sendEmail` (a, oggetto,
  testo con campi, allegati da campi file), `notify`, `startAutomation`, `wait`
  (giorni, risposta a un'email del flusso con massimo, task del flusso chiusa
  con massimo), `claude` (istruzione, input, 0–6 uscite, campi tipizzati, rami
  per uscita), `condition`, `forEach`, `repeatUntil` (massimo 1–10, uscita
  «limite»). Ogni passo con un effetto ha `approval` auto o «chiede a» persona /
  ruolo nel progetto / proprietario. Progetto del passo: proprio, fisso, o dal
  cliente (tabella).
- **Esecuzione**: `n` per automazione, versione fissata all'avvio, titolo dal
  modello, stato (running, waiting_approval, waiting_event, waiting_project,
  suspended, done, failed, cancelled), evento, variabili, cursore, scadenza,
  approvazione pendente con anteprima, registro, progetti toccati, madre
  (catena), origine, errore come codice.
- **Riga del registro**: passo, percorso, esito (ok, skipped, failed, waiting,
  approved, rejected, limit, suspended, resumed, cancelled, retried), input,
  output, `reason` in prosa, `why` come codice tradotto
  (`automations.reasons.*`, 61 codici con la variante al condizionale per la
  prova), chi, effetti creati.
- **Sorgente**: audin/hubspot/webhook, stato connected/expired/disconnected,
  chi e quando, eventi d'esempio, campi, indirizzo. **Tabella cliente →
  progetto**: chiave (dominio o id), nome, progetto, chi e quando.
- **Modelli**: «Nuovo contratto» e «Richiesta dati al cliente»
  (`d/templates.ts`), con le scelte personali vuote (diventano problemi).

### 2.3 Ciclo di vita e regole

- **Scritture** (`d/writes.ts`, `runWrites.ts`, `sourceWrites.ts`): creare
  (sempre bozza senza proprietario), salvare la bozza (con `expected` = `rev`),
  rinominare (non crea bozza), duplicare, pubblicare/accendere (zero errori di
  configurazione, poi `ownerChecks`: il nuovo proprietario deve avere
  `tickets.create` / `tickets.edit` / `backlog.create` dove il flusso crea, e una
  casella sua non scaduta se manda email), pausa (sospende subito le esecuzioni
  in attesa; un effetto in volo si sospende al confine del passo; gli eventi in
  pausa si perdono), eliminare la bozza; avvio a mano, approva (con correzioni
  ammesse solo sui campi dell'anteprima), rifiuta (= annullata, R-J7), scegli il
  progetto (con «ricorda» se `integrations.manage`), annulla, riprova, salta.
- **Esecutore** (`d/runner.ts`, `d/effects.ts`): un input per esecuzione alla
  volta; ogni effetto con i permessi del proprietario (perso → `permission_lost`,
  riprovabile); approvatori risolti ADESSO (R-J8) e un'approvazione legata al
  passo e al giro visti; nessun approvatore possibile → `no_approver` (R-J11);
  un fallimento avvisa il proprietario (`automation.failed`).
- **Le tre regole dell'anti-obiettivo** *(maintainer)*: un'approvazione blocca
  davvero (né riavvio, né altra automazione, né prova, né «Pass time»); Claude
  sceglie solo fra le uscite disegnate e restituisce esattamente i campi
  dichiarati (`unknown_outcome`, `bad_field`, `too_many`); tutto tracciato.
- **Limiti** (`dom/fields.ts` `AUTOMATION_LIMITS`): 20 email per esecuzione
  (sulla catena intera), 50 giri di un «per ogni» (anche gli elenchi di
  Claude), «ripeti» al massimo 10, 200 effetti per esecuzione, catena di avvii a
  3, 5 livelli di rami, 100 esecuzioni non finite per automazione.
- **Validazione** (`dom/validate.ts`, `d/reads.ts` `configErrorsOf`):
  `incomplete`, `unknown_ref`, `type_mismatch`, `approver_cant_see`,
  `department_cant_see`, `source_disconnected`, `limit`; cicli di avvio sulle
  versioni pubblicate; avviare un'automazione che il proprietario non gestisce
  (R-J21).
- **Prova** (`d/simulate*.ts`): stesso motore e stessi piani delle esecuzioni
  vere, mai nello store, in memoria per persona; il filtro d'inizio vale anche
  qui («Wouldn't start»); solo chi gestisce prova.
- **Archiviare un progetto** annulla le esecuzioni aperte; **eliminarlo**
  svuota i passi a progetto fisso (`unavailable`) e toglie le esecuzioni; una
  persona disattivata non è mai incaricata, approvatrice o destinataria.

### 2.4 Permessi

Fonte unica `d/visibility.ts`; `automations.manage` esiste solo nel catalogo
LOCALE (`data/access/catalog.ts`), non in `@stubwise/shared`.

- **Vedere**: di progetto i membri; generali chi ha `automations.manage`
  d'istanza. Le esecuzioni seguono la loro automazione, più chi deve decidere.
- **Gestire** (tutto: crea, modifica, accendi, pausa, prova, avvia, annulla,
  riprova, salta): `automations.manage` nel progetto (preset Project Lead) o
  d'istanza per le generali (preset admin).
- **Sorgenti e tabella cliente → progetto**: `integrations.manage`.
- **Nascosto = inesistente** (R-G5) anche dentro un'esecuzione: progetti e
  codici che non vedo senza id né nome (R-J12); l'evento di un'email lo vede solo
  il proprietario, lungo la catena (R-J13); l'approvatore vede l'anteprima
  intera (R-J14); il testo della risposta del cliente solo il proprietario
  (R-J16).
- **Posta**: l'inizio «email in arrivo» legge solo le caselle del proprietario;
  le email partono dalla casella scelta all'accensione.

### 2.5 Effetti verso le altre aree e segnali dalle altre aree

- **Effetti** (`d/effects.ts`): task (`source: "automation"`, con
  `automationRef`; fa partire l'avviso `task.created_by_automation` e a sua
  volta il segnale `task_created`), traguardo, richiesta, email (la Posta
  dell'area 6, stessa conversazione per lo stesso indirizzo nella stessa
  esecuzione, un rimbalzo è `address_not_found`), avviso nell'app
  (`automation.notify`, a un reparto = ogni membro attivo che vede il
  progetto), esecuzione figlia.
- **Segnali** (`store.ts` `signalAutomations`): `task_created`,
  `task_closed`, `request_created`, `milestone_reached`, `mail_received`.
  Tenuti o scartati dentro i gruppi tutto-o-niente di Claude
  (`holdAutomationSignals`). Svegliano anche le attese (`wakeWaits`: risposta
  nella stessa conversazione, task del flusso chiusa).
- **Claude (area 10a)** riusa `automationsStartingOn` per dire «questa azione
  farebbe partire un'automazione» (classe B col motivo, `data/claude/classes.ts`).

### 2.6 Quanto è finto (solo prototipo)

Audin, HubSpot e webhook (con «Simulate an event»), i passi di Claude
(`d/claudeFake.ts`, deterministici), «Pass time», «Simulate reply», le email
che «partono» nella Posta finta. `runDueSchedules()` esiste ma nessuno lo
chiama; il costruttore offre la ricorrenza MENSILE che `scheduleDue` non fa mai
scattare (capisce solo DAILY e WEEKLY): un buco del prototipo, da non portare.

## 3. Cosa c'è sul server, voce per voce

| Pezzo del prototipo | Sul server oggi | Buco |
|---|---|---|
| Automazioni, versioni, codici | niente (nessuna delle ~145 tabelle; ultima migrazione 0150) | tabelle `automations`, `automation_versions` (flusso jsonb + `rev`), sequenze dei codici per progetto e generali; rotte CRUD, schemi in `@stubwise/shared`, metodi in `@stubwise/api-client` |
| Validazione del flusso | niente | `dom/validate.ts`, `conditions.ts`, `fields.ts`, `triggerFields.ts`, `claudeStep.ts` sono PURI: candidati a `@stubwise/shared` (come `calendar-grid.ts`, `resolveHome`), così server e app usano la stessa regola — è la stessa ragione dell'invariante «due numeri scritti in due posti divergono» |
| Motore (`dom/engine*.ts`) ed esecutore | nessun motore; nessuno scheduler generico, nessuna primitiva «aspetta fino a» oltre le colonne `not_before`; code durevoli con `FOR UPDATE SKIP LOCKED` sì (`ai_jobs`, `graph_jobs`, `nightly_items` con lease, outbox `notification_deliveries` con backoff) | tabella `automation_runs` (stato, cursore, variabili, scadenza, pendente) + `automation_run_log`; un poller del worker che reclama esecuzioni dovute (lease come `nightly_items`); ripresa dopo un riavvio senza ripetere un effetto (il prototipo lo regge con «sospendi al confine del passo»: sul server serve un'idempotenza vera per effetto) |
| Inizi «di Stubwise» | **nessun bus d'eventi**. `ticket_events` copre i cambi di stato di una task (`recordTicketStatusChange`, anche dal worker: triage, fix, intake, e il merge di una PR → done) ma **non la creazione**; `notifications` è l'inbox, non un evento di dominio; la chiusura di un traguardo e la conversione di una richiesta non lasciano nessuna riga | un punto unico che pubblichi l'evento nella STESSA transazione della scrittura (outbox `automation_events`), da ogni scrittore: server (rotte, servizi, catalogo di Claude) e worker (pipeline). Elenco chiuso degli scrittori, come per la cassaforte |
| Inizio «email in arrivo» | il poller Google ingerisce la posta (`apps/worker/src/google/`), con l'invariante `mailbox_owner` | un aggancio nel poller, solo sulle caselle del proprietario; va d'accordo con `docs/invariants/mail-calendar.md` (la classificazione segue la dottrina dell'intake) |
| Inizio a orario | i poller con finestra (pulse, brief, notturno) hanno ognuno la propria logica di fuso | ricorrenze nel fuso Europe/Rome (come la settimana delle task, `docs/invariants/tasks.md`) |
| Sorgenti esterne (Audin, HubSpot, webhook in arrivo) | webhook in arrivo esistono ma a forma fissa: git (`/webhooks/git/:slug`), SDK (`/ingest/:slug`), `POST /api/inbound/:slug/ticket` (crea un ticket); nessun connettore CRM | un indirizzo per automazione (segreto, rigenerabile), esempio → campi; Audin e HubSpot sono connettori nuovi (OAuth o chiave), con la tabella cliente → progetto |
| Passi crea task / traguardo / richiesta | servizi `createTask`, `createMilestone`, `createTicket`; `convertBacklogItem`; tutti con `RouteAccess` | chiamarli con i permessi del PROPRIETARIO a runtime (`projectPermissionsFor`), con `source = automation` e il riferimento all'esecuzione (oggi `tickets.source` non ha un valore «automation»: valore d'enum nuovo → migrazione in uno statement a sé). **«Crea richiesta» non deve passare da `enqueueBacklogIntake`**, che avvia un job AI |
| Passo manda email | area 6 F3 (in corso, stubwise-72): bozze Gmail e invio trattenuto 10 s dal server (`sendDraft`, `outgoing`), solo dalla casella di chi scrive | invio dal worker a nome del proprietario, dalla casella scelta; un'approvazione con correzioni prima dell'invio; risposta nella stessa conversazione (per l'attesa della risposta) |
| Passo avvisa | `publishNotification` (inbox, push, Slack DM, webhook d'istanza) | `notification_kind` nuovi (`automation.notify`, `automation.failed`, `automation.approval`) → rollback NON sicuro finché ne esistono righe (CLAUDE.md, deploy); i campi letti dai client si DERIVANO a lettura |
| Passo di Claude | `TrackingAgentRunner` con `UsageTag` obbligatorio; `AI_OPERATIONS` è un elenco chiuso (nessuna operazione «automazione»); budget mensile e per tipo in `job-outcomes.ts` | operazione nuova in `AI_OPERATIONS` + i CHECK di `agent_runs` e `ai_model_settings`; uscita strutturata validata (regola 2) prima di scegliere il ramo; il blocco AI d'istanza tiene l'esecuzione ferma al confine del passo (il prototipo lo fa già: `holdForAi`) |
| Approvazioni nel «Da decidere» | l'inbox ha azioni (`POST /api/inbox/:id/actions/:action`) e `decision.requested`; il «Da decidere» della build app legge già più fonti | una fonte nuova con Approva / Rifiuta / Correggi, `expectedPath` per la decisione stantia, approvatori ricalcolati a lettura |
| Permessi | catalogo in `packages/shared/src/permissions.ts`; **nessun `automations.*`**; `integrations.manage` esiste (Slack, Google Workspaces) | `automations.manage` di progetto e d'istanza, nei preset (Project Lead, admin); ogni rotta col suo `config.access` (test del registro) |
| Blocco della Home | `automations` in `HOME_BLOCK_KINDS` | la lettura «le mie esecuzioni» |
| Azioni di Claude | catalogo chiuso, classi A/B, `claude-actions-never.test.ts` | `createAutomation`, `saveAutomationDraft`, `deleteAutomationDraft` + la prova; il test «never» deve vietare accendere e pubblicare |
| Prova (simulazione) | niente | il motore deve girare SENZA effetti con gli stessi piani (nel prototipo è in memoria): sul server una prova è una richiesta stateless o una sessione breve; i passi di Claude in prova costano (vedi Q9) |

## 4. Vincoli già scritti che toccano il motore

- **Una serie ricorrente non avvia MAI lavoro AI**
  (`docs/invariants/mail-calendar.md`, `decisions-never-ai.test.ts`): vale
  per `calendar_series`; un'automazione con un passo di Claude che parte da
  un orario o da un'email è esattamente la cosa che quell'invariante vieta
  per le serie. Va deciso se il motore è un'eccezione dichiarata o se
  eredita il divieto (Q8).
- **Il registro decisioni non è mai scritto dall'AI**: un'automazione non vi
  scrive (o lo fa con un template).
- **Nessun deploy**: nessun passo esegue un ambiente o un merge
  (`claude-actions-never.test.ts`, invariante della fase 8).
- **Credenziali**: la cassaforte non è raggiungibile da un'automazione
  (`docs/invariants/vault.md`).
- **Il server non manda mai posta da solo** oggi: il primo invio non umano
  sarebbe di un'automazione (Q4).
- **Cambi additivi verso l'app**: ogni schema nuovo nasce coi campi
  `.default()`/`.optional()`.

## 5. Domande di prodotto per il maintainer

1. **Quanto del motore nella prima integrazione?** Proposta: a fette —
   (a) automazioni di progetto con inizi di Stubwise e passi crea/avvisa,
   approvazioni, registro, prova; (b) email e attese della risposta; (c) passi
   di Claude; (d) generali, sorgenti esterne, tabella cliente → progetto.
   Oppure il motore intero insieme?
2. **Audin e HubSpot**: connettori veri in questa area, o restano fuori (la
   build app nasconde le sorgenti finché non ci sono)? Il webhook in arrivo
   per automazione basta come prima sorgente esterna?
3. **Il motore nel worker**: un'esecuzione può durare giorni e un riavvio del
   worker non deve né perderla né ripetere un effetto. Va bene un poller con
   lease (come il giro notturno), con la regola «un effetto si scrive con la
   sua chiave d'idempotenza nella stessa transazione in cui avanza il
   cursore»?
4. **Email mandate da un'automazione**: sono le prime email che Stubwise
   manda senza che una persona prema «Invia». Il prototipo le fa partire da
   sole se il passo è «parte da solo» (il modello «Nuovo contratto» chiede
   l'approvazione solo per il benvenuto). Si tiene, o **ogni email di
   un'automazione chiede sempre l'approvazione** (almeno nella prima fetta)?
5. **Il registro dice «segnale alla conversione di una richiesta», il
   prototipo no**: segnala la *creazione* (`request_created`) e la
   conversione non fa partire nulla (nemmeno `task_created`, perché la task
   nasce con `addTask`). Quale serve: «richiesta creata», «richiesta
   convertita in task», o entrambi? E una task nata da una conversione deve
   valere come «task creata»?
6. **Quali scrittori pubblicano gli eventi**: anche il worker (una task chiusa
   dal merge di una PR, un ticket creato dall'intake o dall'SDK) e il catalogo
   di Claude? Proposta: sì, tutti, da un punto unico; un evento perso è
   un'automazione che «non è partita» senza un perché.
7. **Permessi**: `automations.manage` di progetto e d'istanza come nel
   prototipo, nei preset Project Lead e admin? E le sorgenti con
   `integrations.manage` (il prototipo lo richiede anche per «ricorda il
   cliente»)?
8. **Passi di Claude e l'invariante delle serie**: un'automazione a orario o
   da un'email può avviare un passo di Claude (lavoro AI senza un umano che
   preme)? Se sì, è un'eccezione da scrivere in `docs/invariants/`; il passo
   di Claude non esegue azioni (regola 2) ma costa.
9. **Costi**: i passi di Claude contano sul budget mensile dell'istanza? Serve
   un tetto per automazione o per esecuzione? La **prova** con un passo di
   Claude chiama il modello vero (costa) o resta finta?
10. **Approvazioni e inbox**: oltre al «Da decidere» della Home, una richiesta
    d'approvazione diventa una notifica (inbox, push, Slack DM come le altre
    decisioni)? Il prototipo ha solo l'avviso al fallimento e «Avvisa».
11. **Le automazioni nel web e nel mobile**: solo l'app nuova (desktop e
    `/app`), o anche approvazioni dal mobile? (Il mobile ha un solo utente,
    nessun rollout a fasi.)
12. **Il nome**: `automation_rules` e Settings → Automations esistono già con
    un altro significato. Si rinomina qualcosa (per esempio le regole
    dell'auto-fix diventano «AI rules») o il motore prende un altro nome
    interno (`workflows`)?
13. **La ricorrenza mensile** che il costruttore offre e il prototipo non fa
    scattare: si porta (e si fa scattare) o si toglie?

## 6. Cosa resta fuori in ogni caso

- Webhook in uscita per automazione: area 9 (oggi c'è solo il webhook
  d'istanza).
- Le «Automations» di progetto dell'area 9c (interruttori di Claude) e le
  `automation_rules` dell'auto-fix: area 9.
- Codice scritto dall'utente (script, espressioni libere): fuori dal design
  originale.
