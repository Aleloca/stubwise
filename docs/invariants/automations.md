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
  `request_converted` prima di `task_created`.
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
  esecuzione (`claimed_at`, 60′, `SKIP LOCKED`); un worker morto la libera
  alla scadenza, un riavvio non perde niente.
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
