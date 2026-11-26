# Area 7, fetta 1 — il motore e le automazioni di progetto

> BOZZA di stubwise-94 (13 nov 2026), su richiesta di stubwise-46, presa da
> stubwise-72 il 13 nov 2026 con le «Correzioni di 72» (prima dei task del
> server, che le seguono dove divergono). I task del SERVER sono
> scritti come interfacce e test: l'implementazione e le scelte interne
> restano a 72. I task del RENDERER sono dettagliati. Design:
> `docs/plans/2026-11-12-integrazione-area7-design.md` (f319f6ec, con le
> risposte D1–D5 in 1942361e). Inventario:
> `docs/plans/2026-11-12-integrazione-area7-inventario.md` (§2 il prototipo,
> §3 il server, §5 le decisioni Q1–Q13). Specifica: il design del prototipo
> `docs/plans/2026-10-26-desktop-area7-automations-design.md`, la mappa
> `apps/desktop/docs/area7-notes.md` (R-J1…R-J24), le shape
> `apps/desktop/.impeccable/shape/{automations,automation-builder,automation-test}.md`.
> Branch proposti: `feat/integrazione-area7` (l'integrazione, da `main`),
> `feat/area7-f1` (server, 72) e `feat/area7-f1-renderer` (94) sopra.

## Cosa cambia

Oggi il server non ha niente del motore: nessuna tabella, rotta, schema,
permesso, poller, e nessun bus d'eventi (inventario §3). Dopo questa fetta,
come nel prototipo, per le **automazioni di progetto**:

- si creano (bozza), si costruiscono, si salvano da sole (`rev` ottimista),
  si pubblicano e si accendono, si mettono in pausa, si duplicano, si
  rinominano; i codici `<PRJ>-A<n>` non si riusano mai;
- partono da un **inizio di Stubwise** — task creata, task chiusa, richiesta
  creata, richiesta convertita, traguardo raggiunto — o **a mano** («Run
  now»), con un filtro facoltativo;
- eseguono i passi **crea task, crea traguardo, crea richiesta, avvisa,
  condizione, «per ogni»**, ognuno con l'approvazione automatica o «chiede a»;
- le **esecuzioni** girano nel worker, durano quanto serve (un'approvazione
  può aspettare giorni) e sopravvivono a un riavvio senza rifare un effetto;
- ogni esecuzione ha il suo **registro** (cosa, con quali dati, perché, chi
  ha approvato e quando);
- la **prova senza effetti** su un evento d'esempio;
- le esecuzioni si vedono nella pagina dell'automazione, nel progetto
  (`/p/<CODE>/automations`), sulla task e sul traguardo creati (la riga
  d'origine), nel **blocco «Automations» della Home** e nel **«Da decidere»**
  (le approvazioni);
- il permesso `automations.manage` di progetto (preset Project Lead);
- **il punto unico di pubblicazione degli eventi** (Q6): ogni scrittore di
  task, richieste e traguardi pubblica l'evento nella STESSA transazione, da
  un elenco chiuso verificato da un test.

Restano alle fette dopo: email e attese, inizi a orario e «email in arrivo»
(F2); i passi di Claude (F3); le automazioni generali, la tabella cliente →
progetto, le sorgenti e il webhook in arrivo, «avvia un'altra automazione»
(F4). Nel costruttore della build app quei passi e quegli inizi sono «in
arrivo» (sotto, «Perimetro»).

## Decisioni già prese

Dal design (le *(M)* del maintainer, le *(O)* dell'orchestratrice con la
consigliata). Qui solo quelle che toccano la F1:

- **Q1 = a** *(O)*: a fette nell'ordine del rischio; questa è la F1.
- **Q3 = a** *(O)*: una coda con lease (come `nightly_items`) e una chiave
  d'idempotenza per effetto, scritta nella STESSA transazione che avanza il
  cursore.
- **Q5 = a** *(M)*: gli inizi «richiesta creata» E «richiesta convertita»;
  una task nata da una conversione vale anche come «task creata». ⚠️ Con la
  correzione del registro (area 7): il prototipo segnala la creazione, NON
  la conversione, e la sua task convertita non fa partire «task creata»
  (`convertRequestAs` usa `addTask`). La F1 corregge anche il prototipo
  (task R6 sotto): la specifica è Q5, non il comportamento di oggi.
- **Q6 = a** *(O)*: tutti gli scrittori pubblicano gli eventi da un punto
  unico, nella stessa transazione, con un elenco chiuso verificato da un test.
- **Q7 = a** *(O)*: `automations.manage` di progetto (preset Project Lead);
  quello d'istanza (preset admin) nasce qui nel catalogo ma serve dalla F4.
- **Q10 = a** *(O)*: un'approvazione è una notifica come le altre decisioni
  (inbox, push, Slack DM), più il «Da decidere» della Home.
- **Q11 = a** *(O)*: solo l'app nuova (desktop e `/app`): né il web vecchio
  né il mobile.
- **Q12 = a** *(O)*: «Automations» è il motore; le vecchie `automation_rules`
  restano come sono (diventano «AI rules» nell'area 9, non qui).
- **D5 = a** *(O, 46)*: il proprietario che perde il permesso mette
  l'automazione in pausa da sola, con un avviso a chi ha `automations.manage`;
  le esecuzioni in corso falliscono con `permission_lost` al passo dopo.
- **La difesa contro un'automazione impazzita** (D1 e D2 tolgono i tetti di
  costo e di email): l'**idempotenza** (un effetto non si scrive due volte) e
  la **profondità della catena** degli eventi (3, `CHAIN_MAX` del
  prototipo), che NON è un limite di quantità; più i limiti del prototipo
  dentro un'esecuzione (`AUTOMATION_LIMITS`: 200 effetti, 50 giri, 5 livelli,
  100 esecuzioni non finite per automazione). Le email (20) sono della F2.

## Perimetro della F1

| Dentro | Fuori (fetta) |
|---|---|
| Automazioni di PROGETTO, con versioni, bozze, pausa, codici | Generali `AUT-<n>` (F4) |
| Inizi: `task_created`, `task_closed`, `request_created`, `request_converted`, `milestone_reached`, `manual` | `schedule`, `mail_received` (F2); `source`/webhook (F4) |
| Passi: `createTask`, `createMilestone`, `createRequest`, `notify`, `condition`, `forEach` | `sendEmail`, `wait`, `repeatUntil` (F2); `claude` (F3); `startAutomation` (F4) |
| Approvazione per passo (auto, o «chiede a» persona / ruolo nel progetto / proprietario) | La correzione di un'email prima dell'invio (F2) |
| Progetto del passo: proprio, fisso | «Dal cliente» (tabella, F4) |
| Prova senza effetti | La prova con Claude vero (F3, D4) |
| Esecuzioni: pagina, progetto, origine su task e traguardo, Home, «Da decidere», ⌘K | Instance status (le esecuzioni ferme sul blocco AI, F3) |

Un flusso che contiene un passo o un inizio «fuori» non si pubblica nella
build app: è un errore di configurazione `not_available` (nuovo, accanto a
`incomplete` & co. di `validate.ts`), e il costruttore li mostra come «in
arrivo» (`ComingSoon`), mai come scelte che poi falliscono. La regola sta
nel motore condiviso (un elenco dei tipi disponibili passato a
`validateFlow`), così server e app non divergono.

## Il modello dei dati (dal design, rifinito per la F1)

Migrazione **0166** (o il primo numero libero su tutti i branch remoti al
momento: da controllare, come la 0165 della F5a), con i valori d'enum nuovi
in statement a sé (CLAUDE.md: il batch è UNA transazione):

- `automations`: `id`, `code` (unico), `seq` (per progetto), `name`,
  `description`, `project_id` (NOT NULL in F1; nullable dalla F4), `owner_id`
  (nullable: una bozza mai accesa non ne ha), `status` (`draft` | `active` |
  `paused`), `paused_by`, `paused_at`, `paused_reason` (`manual` |
  `owner_lost_permission`, D5), `created_by`, `created_at`, `created_via`
  (`claude` | null: le azioni di Claude sono dell'area 10, la colonna nasce
  qui). La sequenza dei codici per progetto: una riga `automation_code_seqs
  (project_id, next)` aggiornata con `UPDATE … RETURNING` nella transazione
  della creazione; un codice non torna mai (una bozza eliminata lo consuma).
- `automation_versions`: `automation_id`, `n`, `flow` jsonb (il documento
  del prototipo, `AutomationFlow`), `published_at`, `published_by`,
  `saved_at`, `saved_by`, `rev` integer, `tested_rev` integer null (R-J19:
  «non l'hai ancora provata»). Unico `(automation_id, n)`; al più UNA bozza
  per automazione (indice unico parziale `WHERE published_at IS NULL`).
- `automation_runs`: `id`, `automation_id`, `n` (per automazione), `version`,
  `title`, `status` (`running` | `waiting_approval` | `waiting_project` |
  `suspended` | `done` | `failed` | `cancelled`; `waiting_event` nasce con le
  attese della F2), `event` jsonb, `vars` jsonb, `cursor` jsonb (lo stato del
  motore, `RunCursor`), `pending` jsonb (l'approvazione pendente con
  l'anteprima e il passo/giro attesi, R-J8), `project_ids` uuid[] (i progetti
  toccati), `parent_run_id` (la catena), `origin` (`event` | `manual`),
  `started_by` (chi ha avviato a mano), `error` (codice), `started_at`,
  `ended_at`; per la coda: `due_at`, `claimed_at`, `claimed_by`.
- `automation_run_log`: `run_id`, `seq`, `path`, `round`, `kind`, `outcome`,
  `input` jsonb, `output` jsonb, `reason` text, `why` jsonb (`{ code, params
  }`, tradotto dal client), `by_id`, `effects` jsonb, `at`. Mai riscritte
  (append-only).
- `automation_effects`: `run_id`, `path`, `round`, `idempotency_key` UNIQUE
  (`<run_id>:<path>:<round>`), `kind` (`task` | `milestone` | `request` |
  `notification`), `object_id`, `created_at`.
- `automation_events` (l'outbox, Q6): `id`, `kind`, `project_id`,
  `object_id`, `payload` jsonb (i campi dell'inizio, `triggerFields.ts`),
  `origin_run_id` (null se l'ha scritta una persona o un altro processo),
  `created_at`, `consumed_at`.
- `tickets.source`: valore nuovo `automation` (statement a sé); la task e il
  traguardo creati portano il riferimento all'esecuzione:
  `tickets.automation_run_id` e `milestones.automation_run_id`, nullable,
  `ON DELETE SET NULL` (la riga d'origine si DERIVA a lettura: la regola delle
  card d'inbox vale anche qui — mai un nome di automazione scritto nella
  task). Lo stesso per le voci di backlog (`backlog_items.automation_run_id`).
- Permessi: `automations.manage` in `packages/shared/src/permissions.ts`, di
  progetto e d'istanza; nei preset Project Lead (progetto) e admin
  (istanza); i ruoli personalizzati nascono SENZA.
- `notification_kind` nuovi: `automation.approval`, `automation.failed`,
  `automation.notify`, `automation.paused` (D5). ⚠️ Rendono NON sicuro
  scendere d'immagine sul server finché ne esistono righe (500 su
  `/api/inbox`): la voce di deploy-log lo dice, col pulito prima del
  rollback.

## Il punto unico degli eventi (Q5, Q6)

È il pezzo che la F1 aggiunge al resto del sistema, e quello con più posti
da toccare. **Un modulo, una funzione**:

```ts
// packages/db/src/automation-events.ts (o packages/notifications, come
// project-timeline.ts: lo usano server e worker)
publishAutomationEvent(tx, {
  kind: "task_created" | "task_closed" | "request_created"
      | "request_converted" | "milestone_reached",
  projectId, objectId,
  payload,            // i campi dell'inizio (`triggerFields.ts`), letti nella tx
  originRunId: string | null,  // l'esecuzione che l'ha prodotto, se c'è
})
```

- Scrive in `automation_events` nella **stessa transazione** della scrittura
  che lo genera: un rollback della scrittura non lascia l'evento, un evento
  non esiste senza la sua scrittura.
- **Non sa nulla delle automazioni** (non legge `automations`): la
  corrispondenza la fa il consumatore nel worker. Così uno scrittore non
  paga una lettura in più e il punto unico non diventa un posto dove la
  logica del motore cresce.
- I **campi dell'inizio** (`payload`) sono quelli di `triggerFields.ts` del
  prototipo per ogni tipo (titolo, tipo, incaricato, reparto, scadenza,
  priorità, progetto, codice; per la richiesta il richiedente e l'origine;
  per il traguardo nome e data), letti nella transazione: l'esecuzione parte
  coi dati del momento, non con quelli di quando il poller arriva.
- **Una task nata da una conversione** pubblica `request_converted` E
  `task_created` (Q5), in quest'ordine, nella stessa transazione.
- **«Task chiusa»** = il passaggio di `status_id` verso la famiglia chiusa
  (`docs/invariants/tasks.md`: lo stato vero è `status_id`, la famiglia la
  dice `project_statuses`), non un valore dell'enum `tickets.status`. Un
  passaggio fra due stati chiusi non ripubblica; una riapertura e una nuova
  chiusura sì.
- **«Traguardo raggiunto»** = la chiusura di un traguardo (il gesto che oggi
  non lascia righe, registro area 7).

**L'elenco chiuso degli scrittori** (dall'inventario e dal design; 72 lo
completa dal codice):

| Dove | Scrittura | Eventi |
|---|---|---|
| `apps/server/src/services/task-writes.ts`, `routes/tickets.ts` | creare una task, cambiarne lo stato | `task_created`, `task_closed` |
| `services/backlog.ts` (`convertBacklogItem`) e le rotte del backlog | creare una richiesta, convertirla | `request_created`, `request_converted` + `task_created` |
| `services/milestones.ts` | chiudere un traguardo | `milestone_reached` |
| `routes/webhooks.ts` (il merge di una PR → done) | chiudere | `task_closed` |
| il catalogo delle azioni di Claude (server) | creare, chiudere, convertire | come sopra |
| `apps/worker/src/pipeline/triage.ts`, `pipeline/fix.ts` | lo stato di una task | `task_closed` |
| `apps/worker/src/backlog/intake.ts` | creare/fondere una richiesta | `request_created` (solo alla creazione, non alla fusione) |
| `apps/worker/src/google/calendar-auto.ts`, la conferma delle proposte della posta | creare una task/richiesta | `task_created`, `request_created` |
| `apps/server/src/ingest/processor.ts` (SDK), il widget, `POST /api/inbound/:slug/ticket` | creare una task | `task_created` |
| il motore stesso (i passi `createTask`, `createMilestone`, `createRequest`) | creare | come sopra, con `originRunId` |

**Il test dell'elenco chiuso** (come `vault-isolation.test.ts`): cerca nel
sorgente di `apps/server/src` e `apps/worker/src` ogni `insert` in
`tickets`, `backlog_items` e ogni `update` di `tickets.status_id`,
`milestones` (chiusura) e `backlog_items` (conversione), e verifica che il
file stia nell'elenco dichiarato DEI chiamanti di `publishAutomationEvent`
(o in un elenco esplicito di eccezioni motivate, es. un seed o un test). Un
file nuovo che scrive una task senza pubblicare fa fallire il test: la
riga da cambiare è la scelta, non il test. Accanto, un test per scrittore
che la scrittura vera lascia la riga dell'evento (non basta che il file
nomini la funzione).

**La catena** (la regola del prototipo, `chainAllows` in
`data/automations/sources.ts`): un evento con `originRunId` NON avvia
un'automazione se quella è già fra gli antenati dell'esecuzione d'origine
(lei, la madre, la madre della madre… per `parent_run_id`), né se la catena
ha già 3 esecuzioni (`CHAIN_MAX = 3`). L'esecuzione nuova ha
`parent_run_id = originRunId`. Un evento scritto da una persona (o da un
processo che non è il motore) ha `originRunId = null` e non ha catena.

## Il motore nel worker (F1)

- **Il motore puro si sposta in `@stubwise/shared`** (task 0): `engine.ts`,
  `engineLoop.ts`, `engineInputs.ts`, `validate.ts`, `fields.ts`,
  `conditions.ts`, `triggerFields.ts`, `restore.ts`, `preview.ts`,
  `draftFlow.ts`, `claudeStep.ts` (questo serve dalla F3, ma è puro e i
  tipi lo citano). Uno spostamento puro, coi suoi test: chi lo sposta non lo
  riscrive. Il prototipo lo importa da lì (come `calendar-grid.ts`).
- **I piani degli effetti** (`data/automations/plans.ts`: il passo diventa
  un effetto pianificato, con i permessi e l'anteprima) sono la parte del
  prototipo legata allo store: sul server si riscrivono contro il DB con la
  STESSA forma (`Planned<…>`) e gli stessi codici di motivo
  (`automations.reasons.*`), così il registro si legge uguale.
- **Il consumatore degli eventi**: un poller (`AUTOMATION_POLL_SECONDS`)
  legge `automation_events` non consumati in ordine, per ognuno trova le
  automazioni ATTIVE del progetto il cui inizio corrisponde (tipo, filtro,
  la catena), crea le esecuzioni (`due_at = now`) e segna `consumed_at`
  nella stessa transazione. Un evento arrivato con l'automazione in pausa o
  in bozza non la avvia, né dopo (il prototipo: «gli eventi in pausa si
  perdono»).
- **L'esecutore**: reclama le esecuzioni dovute con `FOR UPDATE SKIP LOCKED`
  e una lease (come `nightly_items`, 60′), avanza di UN input alla volta per
  esecuzione, rilascia. Fuori dal serializer per-progetto dei job di
  Claude: il motore non tocca mirror né worktree.
- **Un effetto, una transazione**: la task (il traguardo, la richiesta,
  l'avviso) si scrive con la sua riga di `automation_effects` e l'avanzamento
  del cursore NELLA STESSA transazione, che pubblica anche l'evento della
  task creata (col suo `originRunId`). Un crash prima del commit non lascia
  niente; dopo, tutto. Una ripresa che trova la chiave non rifà l'effetto e
  ne rilegge l'`object_id`.
- **«Crea richiesta» NON passa da `enqueueBacklogIntake`** (inventario §3):
  crea la voce di backlog direttamente, senza job AI (le automazioni della
  F1 non avviano lavoro AI; vedi la domanda P3).
- **Permessi del proprietario A OGNI EFFETTO**: `projectPermissionsFor` del
  proprietario al momento dell'effetto (`tickets.create`, `tickets.edit`,
  `backlog.create`, `milestones.manage` — i nomi veri del catalogo); perso →
  il passo fallisce con `permission_lost`, riprovabile; e D5: l'automazione
  va in pausa (`paused_reason = owner_lost_permission`) con
  `automation.paused` a chi ha `automations.manage` nel progetto.
- **Gli approvatori si risolvono ADESSO** (R-J8): al passo «chiede a»
  l'esecuzione va in `waiting_approval` con `pending = { path, round,
  preview, approverIds }`; nessun approvatore possibile → `no_approver`
  (R-J11). Approva/Rifiuta portano `expectedPath`+`expectedRound`: una
  decisione su un passo che non è più quello in attesa è rifiutata
  (`stale`).
- **Pausa**: nessun nuovo inizio; le esecuzioni in attesa si sospendono
  subito, una con un effetto in volo al confine del passo; riaccendere
  riprende le sospese.
- **Archiviare un progetto** annulla le esecuzioni aperte delle sue
  automazioni (prototipo).
- **Limiti** (`AUTOMATION_LIMITS`, dal modulo condiviso): 200 effetti per
  esecuzione, 50 giri di un «per ogni», 5 livelli, catena a 3, 100
  esecuzioni non finite per automazione (oltre, l'evento non avvia e il
  registro dell'automazione lo dice: `limit`).
- **Fail-on-restart**: con la lease, un riavvio NON perde esecuzioni. Un
  effetto è o tutto scritto o niente.

## La prova senza effetti

Il prototipo la fa in memoria, sullo stesso motore e sugli stessi piani
(`data/automations/simulate*.ts`). Nella F1 nessun passo costa (Claude è
della F3) e nessuno scrive: la proposta *(P1, sotto)* è farla **nel client**,
sul motore condiviso, con le letture vere già filtrate dal server
(l'esempio, gli approvatori, le persone, i ruoli): una sola regola, niente
stato sul server, e la prova «non tocca niente» per costruzione. Il server
dà solo gli **esempi** (`GET /api/automations/:id/examples`: gli ultimi
eventi del tipo dell'inizio nel progetto, coi soli campi dell'inizio che chi
guarda vede) e registra l'esito per R-J19 (`POST …/tested`, con la `rev`
provata: «Turn on / Publish» solo dopo una prova finita bene). Dalla F3, coi
passi di Claude, la prova passa dal server (costa, D4): la domanda P1 lo
tiene presente.

## Le rotte (forme in `@stubwise/shared`, metodi in `@stubwise/api-client`)

Ogni rotta dichiara `config.access`. Lettura = membro del progetto
dell'automazione; scrittura = `automations.manage` nel progetto; un'automazione
di un progetto invisibile risponde 404 (`docs/invariants/permissions.md`).

| Rotta | Cosa |
|---|---|
| `GET /api/automations?project&status&owner&mine` | l'elenco (righe col codice, lo stato, il proprietario, l'inizio, i passi, le esecuzioni, «N problems») |
| `GET /api/automations/:code` | il dettaglio: versioni, bozza, problemi (`configErrorsOf`), esecuzioni recenti |
| `POST /api/automations` | crea una bozza (nome, progetto, flusso iniziale) |
| `PUT /api/automations/:code/draft` | salva la bozza con `expectedRev` (409 `stale` col rev attuale) |
| `PATCH /api/automations/:code` | rinomina, descrizione (non crea bozza) |
| `POST /api/automations/:code/publish` · `/activate` | pubblica la bozza / accende: zero errori di configurazione, `ownerChecks` del nuovo proprietario (chi chiama), `expectedRev`; il proprietario diventa chi chiama |
| `POST /api/automations/:code/pause` | pausa |
| `POST /api/automations/:code/duplicate` | duplica una versione (anche per tornare a una vecchia) |
| `DELETE /api/automations/:code/draft` | elimina la bozza (un'automazione mai pubblicata sparisce, il codice resta consumato) |
| `POST /api/automations/:code/runs` | «Run now»: i dati dell'inizio a mano (i campi tipizzati dell'inizio `manual`) |
| `GET /api/automations/:code/runs?status` · `GET …/runs/:n` | le esecuzioni, una con il registro |
| `POST …/runs/:n/approve` · `/reject` | con `expectedPath`, `expectedRound`; approva SOLO chi è fra gli approvatori risolti ADESSO |
| `POST …/runs/:n/cancel` · `/retry` · `/skip` | annulla (ciò che è creato resta), riprova il passo fallito, salta |
| `POST …/runs/:n/project` | «scegli il progetto» (dalla F4 con la tabella; nella F1 risponde solo per un passo a progetto fisso diventato `unavailable`) |
| `GET /api/automations/:code/examples` · `POST …/tested` | la prova (sopra) |
| `GET /api/projects/:projectId/automations` | la sezione del progetto |
| `GET /api/me/automation-runs` | il blocco della Home e «le mie esecuzioni» |
| `GET /api/me/automation-approvals` | le approvazioni che aspettano me («Da decidere») |
| `GET /api/automation-origin?task=…\|milestone=…` | la riga d'origine («Created by automation X · run Y»), derivata a lettura |

`searchAutomations` (⌘K) entra nella ricerca esistente come tipologia nuova
(automazioni ed esecuzioni che chi guarda vede), non una rotta a sé.

## Correzioni di 72 (13 nov 2026)

Dal codice (`feat/area7-f1`, sopra `feat/area7-f1-engine`).

**C1. Il punto unico degli eventi è nel DATABASE: trigger, non chiamate**
*(O, da confermare con 46: è la forma di Q6, non la sua sostanza)*. Le
scritture che contano sono molte più di quelle dell'elenco: `update(tickets)`
compare in 10 file (triage, fix, webhook, jobs, ingest, le rotte…), e lo
stato cambia anche per la colonna vecchia `tickets.status`, che il trigger
`tickets_status_sync` traduce in `status_id`. Un elenco chiuso verificato
cercando nel sorgente avrebbe buchi per costruzione (una `sql` grezza, un
helper nuovo, l'enum vecchio). Proposta: **trigger `AFTER` sulle tabelle**
che scrivono in `automation_events` nella STESSA transazione:
- `tickets` `AFTER INSERT` → `task_created`; `AFTER UPDATE OF status_id`
  quando la famiglia (`project_statuses.family`) PASSA a `closed` →
  `task_closed` (fra due chiusi no; riaperta e richiusa sì);
- `backlog_items` `AFTER INSERT` → `request_created` (la FUSIONE dell'intake
  aggiorna una voce che c'è: non è un insert, quindi non pubblica, come
  vuole il piano); `AFTER UPDATE` quando nasce la conversione → 
  `request_converted`;
- `milestones` `AFTER UPDATE OF status` `open → closed` → `milestone_reached`.
L'**origine** (la catena): il motore, prima dei suoi effetti, fa
`set_config('stubwise.automation_run_id', <run>, true)` (locale alla
transazione) e il trigger la legge (`current_setting(…, true)`); una
persona o un altro processo non la impostano, quindi `origin_run_id` è
null. Il **payload** (i campi di `triggerFields.ts`) lo compone il trigger
dalla riga e dalle sue tabelle collegate, nel momento della scrittura.
L'ordine «`request_converted` poi `task_created`» (Q5) lo dà il
consumatore: gli eventi della stessa transazione (`txid_current()`, una
colonna) si leggono con la conversione prima. Il test diventa: per ogni
SCRITTORE vero (le rotte, la pipeline, l'SDK, il widget, l'intake, il
motore) la scrittura lascia l'evento, e un rollback no — più un test che
nessun ramo scrive sulle tre tabelle aggirando i trigger (`session_replication_role`).

**C2. La migrazione è la 0168** (0165/0166 della F5a sono già in
`feat/integrazione-area6`, la 0167 è della F5b, ancora sul suo branch).

**C3. I permessi del proprietario a ogni effetto, coi nomi veri**:
`createTask` → `tickets.create`; `createMilestone` → `tickets.edit` (non
esiste `milestones.manage`: le rotte dei traguardi vogliono `tickets.edit`);
`createRequest` → `backlog.create`; `notify` → nessun permesso di
scrittura, ma i destinatari devono vedere il progetto (`projectViewerIds`).

**C4. I `notification_kind` nuovi** (`automation.approval`,
`automation.failed`, `automation.notify`, `automation.paused`) ognuno in uno
statement a sé e MAI usato nello stesso batch (CLAUDE.md); idem per
`ticket_source` `automation`. Le card delle approvazioni leggono stato,
approvatori e anteprima DERIVATI dall'esecuzione (la regola delle card
d'inbox), non dal jsonb dell'evento.

**C5. Le forme delle rotte sono i tipi già in `@stubwise/shared`**
(`Automation` con le versioni, `AutomationRun` col registro e `pending`, la
riga d'elenco `AutomationListRow` = l'`AutomationSummary` del prototipo
spostata in shared): decisione di 46 sulla proposta di 94. I `pending` e il
`cursor` del motore li scrive il worker così come il motore condiviso li
produce (`RunCursor`), senza una forma intermedia.

**C6. L'esecutore e il consumatore stanno nel worker**, fuori dal serializer
per-progetto (il motore non tocca mirror né worktree), con la lease sulle
esecuzioni (`claimed_at`, 60′, `SKIP LOCKED`) come `nightly_items`; un
riavvio non perde niente (nessun «fail-on-restart»).

## Task del SERVER (interfacce e test; l'implementazione è di 72)

0. **Il motore condiviso** (72 o 94, da decidere fra loro: è codice del
   prototipo). Lo spostamento puro dei moduli di `domain/automations` in
   `packages/shared/src/automations/`, coi test che girano lì; il prototipo
   li reimporta. *Test*: gli stessi di oggi, verdi da `@stubwise/shared`; il
   carico isolato di ogni schema (`load-isolated.test.ts`) resta verde.
   L'elenco dei tipi disponibili per fetta (`not_available`).
1. **Lo schema** (migrazione, tabelle sopra, enum in statement a sé),
   `automations.manage` nel catalogo e nei preset. *Test*: la migrazione su
   un DB vuoto e su uno con dati; i preset Project Lead e admin lo hanno, un
   ruolo personalizzato nuovo no; l'indice «una bozza per automazione».
2. **Il punto unico degli eventi** e TUTTI gli scrittori dell'elenco.
   *Test*:
   - l'elenco chiuso (sopra), che fallisce aggiungendo un `insert` in
     `tickets` in un file non dichiarato;
   - per ogni scrittore, la scrittura vera lascia l'evento coi campi
     dell'inizio; un rollback della scrittura non lo lascia;
   - la conversione: `request_converted` E `task_created`;
   - una chiusura fra due stati chiusi non ripubblica; una riapertura e una
     nuova chiusura sì;
   - la fusione di una richiesta nell'intake NON pubblica `request_created`.
3. **Le rotte delle automazioni** (creare, salvare, rinominare, duplicare,
   pubblicare, accendere, pausa, eliminare la bozza). *Test*:
   - ogni rotta nel registro con `config.access`; senza `automations.manage`
     403 e nessuna riga cambiata (negativo, con un Developer e un Contributor);
   - un'automazione di un progetto che chi chiede non vede risponde 404
     `not_found`, come una che non esiste; un full admin la vede (è membro
     implicito di ogni progetto, `permissions.md`) — il test fissa i due casi;
   - `expectedRev` vecchio → 409 `stale` col rev attuale;
   - pubblicare con un errore di configurazione (anche `not_available`) →
     400 con gli errori; `ownerChecks` falliti → 400 col permesso mancante;
   - il proprietario diventa chi pubblica, e lo dice la risposta;
   - i codici: due creazioni concorrenti non prendono lo stesso; una bozza
     eliminata non libera il suo.
4. **Il consumatore degli eventi e l'esecutore** (worker). *Test*:
   - un evento avvia le automazioni attive che corrispondono, una per
     automazione; una in pausa o in bozza no, né dopo la riaccensione;
   - il filtro dell'inizio (i confronti di `conditions.ts`);
   - **l'idempotenza**: un crash simulato fra l'effetto e il commit non lascia
     né la task né l'avanzamento; uno dopo il commit, alla ripresa, non crea
     una seconda task (la chiave); due worker sulla stessa esecuzione: uno
     solo la reclama;
   - **la catena**: un'automazione su `task_created` che crea una task non
     riparte da sé; A (task creata → crea richiesta) e B (richiesta creata →
     crea task) si fermano alla profondità 3; un evento scritto da una
     persona non ha catena;
   - i permessi del proprietario a ogni effetto: tolto `tickets.create` a
     metà, il passo dopo fallisce con `permission_lost` E l'automazione va in
     pausa con l'avviso (D5); nessuna task scritta;
   - i limiti: il 201° effetto → `limit`; il 51° giro di un «per ogni» →
     `limit`; la 101ª esecuzione non finita non parte;
   - pausa: le esecuzioni in attesa diventano `suspended`, riaccendere le
     riprende; archiviare il progetto annulla le aperte.
5. **Le approvazioni.** *Test*:
   - un passo «chiede a» ferma l'esecuzione PRIMA dell'effetto, e nessun
     percorso lo scavalca: un riavvio del worker (l'esecuzione resta
     `waiting_approval`), un'altra esecuzione della stessa automazione, la
     prova (`/tested` non approva niente), un `retry`/`skip` su un'esecuzione
     in attesa (409);
   - approva solo chi è fra gli approvatori ADESSO (un ex approvatore 403);
   - `expectedPath`/`expectedRound` diversi da quelli in attesa → 409
     `stale` (R-J8);
   - nessun approvatore possibile → `no_approver` (R-J11);
   - Rifiuta = annullata (R-J7), col motivo nel registro;
   - la notifica `automation.approval` agli approvatori (inbox, push, Slack
     DM), coi campi che la card legge DERIVATI a lettura (approvatori, stato,
     anteprima); decisa da uno, la card degli altri lo dice.
6. **Il registro e la visibilità dentro un'esecuzione.** *Test*:
   - ogni passo lascia la sua riga (ok, skipped, failed, waiting, approved,
     rejected, limit, suspended, resumed, cancelled, retried) con input,
     output, `why`, chi;
   - R-G5/R-J12: un progetto o un codice che chi guarda non vede, dentro
     un'esecuzione, è senza id né nome (test negativo con un membro di un
     solo progetto);
   - il registro decisioni non è mai scritto da un'automazione
     (`decisions-never-ai.test.ts` resta verde; nessun modulo del motore vi
     scrive).
7. **Le letture per le altre superfici**: la sezione del progetto, il blocco
   della Home, «Da decidere», la riga d'origine, la ricerca (⌘K), gli
   esempi della prova. *Test*: ognuna filtra nella WHERE prima della
   paginazione (`permissions.md`); la riga d'origine di una task creata da
   un'automazione che chi guarda non vede dice solo «Created by an
   automation» (senza nome né link); i campi nuovi delle risposte che il
   desktop legge nascono con default (test di parse SENZA).
8. **Chiusura**: `docs/invariants/automations.md` (nuovo: le tre regole
   dell'anti-obiettivo, l'idempotenza, il punto unico e il suo elenco
   chiuso, la catena, i permessi del proprietario a ogni effetto, «crea
   richiesta» senza intake), la voce di deploy-log (ordine: server, poi
   worker, poi caddy; i `notification_kind` nuovi e il rollback NON sicuro
   finché ne esistono righe; `AUTOMATION_POLL_SECONDS`), l'indice di
   CLAUDE.md, `@stubwise/api-client` (`client.automations.*`).

## Task del RENDERER (94)

Tutti su `feat/area7-f1-renderer`, TDD con un test rosso prima,
`ComingSoon.test.tsx` nel giro (la destinazione `automations` si accende),
il server finto che risponde come quello vero; i test filtrati.

R1. **Il motore condiviso nel prototipo.** Dopo il task 0, `domain/automations/*`
   reimporta da `@stubwise/shared` (o ne è un rinvio): nessun comportamento
   cambia. *File*: `domain/automations/*.ts`, gli import di `data/automations`
   e `pages/automations`. *Test*: tutti quelli dell'area 7 del prototipo
   verdi (`data/automations/*.test.ts`, `pages/automations/*.test.tsx`,
   `domain/automations/*.test.ts` spostati o rinviati).

R2. **Il livello dati** (`data/backend/real/automations.ts`, nuovo, sopra
   `client.automations`), con la firma del prototipo (`data/automations/index.ts`):
   `listAutomations`, `getAutomation`, `checkDraft`, `validateAutomationFlow`
   (locale, sul motore condiviso), `canManageAutomations`, `createAutomation`,
   `saveDraft` (con `expected` = `rev`; un 409 → l'errore `stale` che
   `useAutosave.ts` già capisce), `renameAutomation`, `duplicateAutomation`,
   `publish`, `activate`, `pause`, `deleteDraft`, `listRuns`, `getRun`,
   `startManual`, `approve`, `reject`, `cancelRun`, `retryStep`, `skipStep`,
   `chooseProject`, `listMyRuns`, `listMyApprovals`, `getProjectAutomations`,
   `automationOrigin`, `searchAutomations`, `listSimulationExamples`. Gli
   errori nelle parole del prototipo (`stale`, `forbidden`, `not_found`,
   `invalid: config` con gli errori). *File*: `automations.ts`,
   `automations.test.ts`, `fakeServer.ts` (le rotte). *Test*: il corpo
   esatto di ogni richiesta; ogni errore mappato; un'automazione invisibile
   `not_found`; la riga d'origine senza nome per chi non la vede.
   ⚠️ Le due trappole di CLAUDE.md: i campi nuovi letti dal web si difendono
   nel punto di lettura (`?? []`), e le funzioni del prototipo che la build
   app NON ha (sotto, R5) restano lo stub `notIntegrated` — mai una funzione
   finta che risponde.

R3. **La prova nel client** (se P1 = a). `startSimulation`,
   `simulationStep`, `getSimulation`, `endSimulation` sul motore condiviso,
   con le letture vere (l'esempio da `listSimulationExamples`, gli
   approvatori dal server: `pending.approverIds` calcolati dalle stesse
   regole, esposti da `GET …/examples` insieme all'esempio, così il client
   non deduce chi può approvare) e i piani in modalità «prova» (nessuna
   scrittura: i piani restituiscono l'anteprima, non l'effetto). A prova
   finita bene, `POST …/tested` con la `rev`. *File*:
   `data/backend/real/automationSimulate.ts` (nuovo); i moduli
   `data/automations/simulate*.ts` del prototipo si dividono nella parte pura
   (in `@stubwise/shared` o in `domain/automations`) e in quella legata allo
   store. *Test*: una prova completa sull'esempio non chiama nessuna rotta di
   scrittura (il server finto lo controlla: solo GET e `/tested`); una prova
   su un flusso con un passo «chiede a» si ferma e mostra l'approvatore vero;
   «Wouldn't start» col filtro che non passa; `/tested` solo a prova finita
   bene.

R4. **Le pagine** (`featureIntegrated`/la destinazione `automations` accesa
   nella build app, `data/integration.ts`): elenco e viste («Runs»,
   «Needs attention», «Drafts»), colonna (senza «Sources» né «General»:
   F4), creazione (`CreateAutomationDialog.tsx`: solo i progetti che
   gestisco, senza General; i modelli secondo P2), dettaglio con le azioni per
   stato e i dialoghi, costruttore (`builder/*`), prova (`test/*`),
   esecuzione (`RunDetail.tsx`, senza «Pass time» né «Simulate reply»: solo
   prototipo), progetto (`ProjectAutomations.tsx`), la riga d'origine su
   task e traguardo (`AutomationOrigin.tsx`), il segno «Automazione» fra le
   origini (`tasks-ui/SourceMark.tsx`), ⌘K. *Test* (`automationsPage.test.tsx`,
   nella cartella del livello dati vero, come `calendarPage.test.tsx`): ogni
   gesto dalla pagina fino alla richiesta esatta; senza `automations.manage`
   niente «New automation», Edit, Turn on, Run now; il salvataggio automatico
   e il 409 «cambiata da un altro»; un'esecuzione col registro e l'approva
   con `expectedPath`.

R5. **«In arrivo» nel costruttore** (il perimetro). Nella build app il
   menu dei passi e quello degli inizi mostrano `sendEmail`, `wait`,
   `repeatUntil`, `claude`, `startAutomation`, `schedule`, `mail_received`,
   `source` come «in arrivo» (`ComingSoon`, non selezionabili); un flusso che
   li contiene (una bozza duplicata da una vecchia, un modello) dice il
   problema `not_available` e non si pubblica. Le funzioni del prototipo per
   sorgenti, tabella e webhook (`listSources`, `connectSource`,
   `setClientLink`, `createWebhookSource`, …) restano stub. *Test*:
   `ComingSoon.test.tsx` — aprire l'elenco, un'automazione, il costruttore,
   la prova e un'esecuzione chiama solo funzioni integrate (`outside() ==
   []`), con un test per pagina; il menu dei passi senza i tipi «fuori».

R6. **Q5 nel prototipo** (la correzione del registro). Il prototipo segnala
   `request_converted` (inizio nuovo nel costruttore, con i suoi campi in
   `triggerFields.ts`) e la task nata da `convertRequestAs` fa partire
   anche `task_created` (oggi `addTask` no). *File*: `data/store.ts`
   (`signalAutomations`), `data/requests*` (la conversione),
   `domain/automations/triggerFields.ts`, `pages/automations/builder/StartPanel.tsx`
   (+ i testi en/it). *Test*: convertire una richiesta avvia un'automazione
   su «richiesta convertita» E una su «task creata»; i campi dell'inizio
   (richiesta d'origine, task nata).

R7. **Home e «Da decidere».** Il blocco «Automations» della Home (dal
   registro, area 7: «Blocco della Home delle automazioni») su
   `listMyRuns`, e le approvazioni in «Da decidere» su `listMyApprovals`
   (Approva, Rifiuta; «Correggi» è delle email, F2), con l'anteprima e la
   decisione stantia («this step has moved on»). *File*:
   `pages/home/blocks/*` (il blocco esiste nel prototipo), il registro dei
   blocchi della build app. *Test*: il blocco si mostra e legge solo con la
   destinazione integrata; un'approvazione decisa da un altro sparisce con il
   suo esito; `expectedPath` vecchio → il messaggio, nessuna decisione.

R8. **Parità** (`apps/desktop/docs/integration-area7-f1.md`) e registro.

## Global Constraints

- **Le tre regole dell'anti-obiettivo**: un'approvazione blocca davvero
  (nessun percorso la scavalca: riavvio, altra automazione, prova, una
  decisione stantia); Claude sceglie solo fra le strade disegnate (nella F1
  non ci sono passi di Claude: nessun percorso li introduce); tutto tracciato.
- **Un'automazione agisce coi permessi del PROPRIETARIO**, ricontrollati a
  ogni effetto; nessuna credenziale della cassaforte è raggiungibile
  (`vault-isolation.test.ts` resta chiuso: il motore non tocca le sue
  tabelle).
- **Nessun effetto senza la sua chiave d'idempotenza** nella transazione del
  cursore; una ripresa non rifà un effetto.
- **Ogni scrittore di task, richieste e traguardi pubblica l'evento dal punto
  unico**, nella stessa transazione (elenco chiuso, test).
- **Nessun lavoro AI** parte da un'automazione della F1: niente intake su
  «crea richiesta», nessuna operazione nuova in `AI_OPERATIONS` (è della F3).
- **Nascosto = inesistente**, anche dentro un'esecuzione e sulla riga
  d'origine.
- **Il registro decisioni non è mai scritto da un'automazione**.
- **Verso i client solo campi additivi con default**; il web vecchio non ha
  il motore (Q11), il mobile nemmeno.
- Test filtrati; mutazioni sui controlli di permesso, sull'idempotenza e
  sulla catena.

## Review Focus

- **L'automazione impazzita.** D1 e D2 tolgono i tetti di quantità: la
  difesa è idempotenza + catena. Da verificare di proposito:
  - un'automazione su «task creata» che crea una task: la task nuova
    pubblica l'evento con `originRunId`, e la stessa automazione NON
    riparte (è nella catena);
  - due automazioni che si avviano a vicenda (A: task creata → crea
    richiesta; B: richiesta creata → crea task): la catena si ferma a 3
    esecuzioni, MAI un ciclo;
  - una conversione (che pubblica DUE eventi) dentro una catena: i due
    eventi portano la stessa origine, e nessuno dei due allunga la catena
    oltre 3;
  - migliaia di eventi in ingresso (un import, un SDK che crea 5.000 task):
    nessuna esecuzione oltre le 100 non finite per automazione, nessun
    effetto doppio (la chiave), il poller non si blocca su un evento che non
    corrisponde a niente (`consumed_at` anche senza esecuzioni);
  - un evento che il motore stesso produce mentre l'automazione viene messa
    in pausa: non la riavvia dopo.
- **La profondità della catena** è una profondità, non una quantità: un
  «per ogni» di 50 giri che crea 50 task produce 50 eventi con la STESSA
  origine, e ognuno è valutato contro la catena di quell'esecuzione (non
  contro un contatore globale); nessuno di loro avvia di nuovo la stessa
  automazione.
- **L'idempotenza**: un crash fra l'effetto e il cursore (prima e dopo il
  commit) non duplica una task; due worker non eseguono la stessa
  esecuzione; un `retry` dopo un effetto riuscito non lo rifà.
- **L'elenco chiuso degli scrittori** non ha buchi: il merge di una PR,
  l'SDK, il widget, l'inbound, il catalogo di Claude, la conferma di una
  proposta della posta, l'intake (creazione sì, fusione no), il motore
  stesso. Un file che scrive una task senza pubblicare fa fallire il test.
- **L'approvazione non si scavalca**: riavvio, un'altra esecuzione, la prova,
  `retry`/`skip` su un'esecuzione in attesa, una decisione stantia, un ex
  approvatore.
- **Un permesso perso a metà** ferma il passo con `permission_lost`, mette in
  pausa (D5) e non scrive niente.
- **R-G5 dentro un'esecuzione**: progetti, codici e persone che chi guarda
  non vede, nel registro e nella riga d'origine.
- **«Crea richiesta» non avvia l'intake** (nessun job AI da un'automazione
  della F1).

## Domande per il maintainer (risposte: vedi «Le risposte alle domande»)

### Le risposte alle domande (13 nov 2026)

Tutte *(O, 46)*, con la consigliata:

- **P1 = a**: nella F1 la prova gira nel CLIENT, sul motore condiviso, con le
  letture vere (esempi e approvatori dal server); dalla F3 la prova dei passi
  di Claude passa dal server.
- **P2 = a**: nella build app la creazione offre solo «da zero»; i due
  modelli tornano quando sono usabili (F3/F4).
- **P3 = a**: «Crea richiesta» di un'automazione crea la voce diretta, senza
  intake né fusione: nessun lavoro AI parte da un'automazione della F1.
- **P4 = a**: gli eventi consumati si potano dopo 30 giorni (il giro
  notturno); la prova legge gli esempi degli ultimi 30 giorni.
- **P5 = a**: nel web vecchio e nel mobile una task creata da
  un'automazione è una task normale con l'origine «Automation» (il valore
  nuovo di `source`, `UNKNOWN` per i client vecchi), senza link.

### Le opzioni poste

P1. **Dove gira la prova nella F1** (nessun passo costa e nessuno scrive)?
- (a) *(consigliata)* Nel client, sul motore condiviso, con le letture vere
  (esempi e approvatori dal server): una regola sola, niente stato sul
  server, «non tocca niente» per costruzione. Dalla F3 (Claude vero, D4) la
  prova dei passi di Claude passa dal server.
- (b) Sul server fin da subito, una sessione di prova senza effetti: una sola
  strada anche per la F3, ma un sistema in più già ora.

P2. **I due modelli del prototipo** («Nuovo contratto», «Richiesta dati al
cliente») partono da una sorgente esterna e hanno un passo di Claude: nella
F1 non si possono pubblicare.
- (a) *(consigliata)* Nella build app la creazione offre solo «da zero»
  finché i modelli non sono usabili (tornano con la F3/F4).
- (b) Si mostrano, e il costruttore dice i passi «in arrivo» (`not_available`).
- (c) Un modello nuovo, fatto coi soli pezzi della F1 (es. «Richiesta
  convertita → task di avvio»).

P3. **«Crea richiesta» di un'automazione e l'intake** (stima e fusione col
modello).
- (a) *(consigliata)* La voce nasce diretta, senza intake né fusione, come nel
  prototipo: nessun lavoro AI parte da un'automazione della F1.
- (b) Passa dall'intake come una richiesta di una persona (stima e fusione):
  è un lavoro AI avviato senza un umano, quindi un'altra eccezione da
  dichiarare (Q8 la prevede solo per i passi di Claude).

P4. **Gli eventi consumati** (`automation_events`).
- (a) *(consigliata)* Si potano dopo 30 giorni dal consumo (il poller del
  giro notturno), come gli altri log; la prova legge gli esempi dagli ultimi
  30 giorni.
- (b) Restano per sempre (servono a una storia degli inizi).

P5. **Le automazioni nel web vecchio** (Q11 = solo l'app nuova): una task
creata da un'automazione si vede anche nel web vecchio e nel mobile.
- (a) *(consigliata)* Lì è una task normale, con l'origine «Automation» (il
  valore nuovo di `source`, letto da `readerSchema` come `UNKNOWN` dai client
  vecchi), senza link.
- (b) Anche la riga d'origine col nome dell'automazione (una lettura in più
  sul web e sul mobile).

## Rimandi (dal registro, area 7)

- **«Blocco della Home delle automazioni»**: DENTRO la F1 (R7).
- **I segnali alla chiusura di un traguardo e alla creazione e conversione
  di una richiesta** (Q5, con la correzione «creata e convertita»): DENTRO
  la F1 (il punto unico, task 2; il prototipo, R6).
- **Le azioni di Claude** (crea automazione in bozza, salva/elimina bozza,
  prova): fuori, area 10 (la colonna `created_via` nasce qui; il test
  «never» dovrà vietare accendere e pubblicare).
- **Le automazioni generali, la tabella cliente → progetto, le sorgenti e il
  webhook in arrivo, «avvia un'altra automazione»**: F4.
- **Email, attese, «ripeti finché», inizi a orario ed «email in arrivo»**:
  F2. **I passi di Claude**, l'operazione `automation_step`, la prova con
  Claude vero e l'eccezione all'invariante delle serie: F3.
- **Instance status** (le esecuzioni ferme sul blocco AI): F3.
- **«AI rules» / «AI switches»** (Q12): area 9, solo parole.
