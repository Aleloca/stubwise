# Task: stati per progetto e enum derivato

## Lo stato vero è `status_id`; l'enum lo tiene coerente il trigger (9 nov 2026)

Design: `docs/plans/2026-11-09-integrazione-area2-task-design.md` («Stati per
progetto»). Piano: `docs/plans/2026-11-09-integrazione-area2-task-plan.md`,
Task 2. Migrazione: `packages/db/drizzle/0108_project_statuses.sql`. Test:
`packages/db/src/migration-0108.test.ts`.

- **Lo stato vero è `tickets.status_id`**, uno degli stati del progetto
  (`project_statuses`: nome, famiglia `todo`/`active`/`closed`, posizione).
  L'enum `tickets.status` resta come colonna di compatibilità perché web
  vecchio, app mobile, MCP, notifiche e pipeline la leggono e la scrivono.
- **L'enum lo tiene coerente il trigger `tickets_status_sync`, in UN posto.**
  Nessun codice scrive la mappatura a mano: chi scrive lo stato nuovo scrive
  `status_id`, chi conosce solo l'enum scrive `status`, e il trigger allinea
  l'altro nella stessa riga. Una copia della regola nel server o nel worker è
  la divergenza che questo trigger esiste per evitare.
- **`legacy_status` di uno stato** lo calcola chi scrive gli stati: «todo →
  `open`; active: il primo → `in_progress`, gli altri → `in_review`; closed:
  il primo → `done`, gli altri → `closed`». Cambiare `status_id` scrive
  `status := legacy_status`.
- **Uno scrittore vecchio che scrive solo `status`** sposta lo stato con
  `stubwise_status_for_legacy(progetto, enum, stato corrente)`:
  - se lo stato corrente ha già quel `legacy_status`, o (per `open`,
    `triaged`, `in_progress`) è già nella famiglia giusta, **resta dov'è** —
    il triage che scrive `triaged` non riporta una task dal suo todo al primo
    todo;
  - `open`/`triaged` → il primo `todo`;
  - `in_progress` → il primo `active`;
  - `in_review` → il primo `active` DOPO quello corrente con `legacy_status =
    'in_review'`, altrimenti l'ultimo `active`: **mai indietro** (la pipeline
    che scrive `in_review` su una task già in un «QA» successivo la lascia lì);
  - `done` → il primo `closed` con `legacy_status = 'done'`, altrimenti il
    primo `closed`;
  - `closed` → il primo `closed` con `legacy_status = 'closed'`, altrimenti
    l'ultimo `closed`.
  Il valore di `status` scritto resta quello scritto (così `triaged`
  sopravvive per chi lo legge).
- **Un UPDATE che cambia entrambi** è ammesso solo se le famiglie coincidono
  (`23514` altrimenti). Uno stato di un altro progetto è rifiutato (`23503`).
  Un ticket che cambia progetto senza `status_id` riceve lo stato dall'enum.
- **`closed_at`** lo scrive il trigger: `now()` quando la famiglia diventa
  `closed`, `null` quando la lascia.
- **Un progetto nuovo nasce con i cinque stati di default** (trigger
  `projects_default_statuses`): `To do` · `In progress` · `In review` ·
  `Done` · `Discarded`. Sono dati, non testi tradotti.
- **La FK `tickets.status_id` è `NO ACTION`, non `RESTRICT`**: uno stato con
  task non si elimina, ma eliminare un progetto porta via stati e task nello
  stesso statement (RESTRICT controllerebbe prima della cascata sulle task).
- **L'enum si toglie col ritiro del web vecchio**, non prima.

## Nessuno legge o scrive l'enum: ruolo e status derivato (R0, 28 nov 2026)

- **Uno scrittore dà un RUOLO, mai l'enum**: `.set({ ...roleUpdate("done") })`
  (`packages/db/src/ticket-status.ts`). `roleUpdate` dà `status_id` con la
  regola di 0108 (`stubwise_status_for_legacy`) e, per i ruoli di todo, il
  segno dello smistamento (`triaged` → `triaged_at = now()`, `open` → null).
  Il `PATCH /api/tickets/:id` traduce lo `status` ricevuto nello stesso modo
  (`patchTicket`). La colonna enum non è più nello schema drizzle: drizzle
  scarterebbe IN SILENZIO una chiave `status` passata a `.set()` o
  `.values()` con uno spread, che il compilatore non vede. È questo il punto
  da tenere d'occhio.
- **Un lettore legge lo status DERIVATO**: `ticketStatusSql`, cioè
  `stubwise_ticket_status(status_id, triaged_at)` = il `legacy_status` dello
  stato, `triaged` se è `open` e smistato. Una riga intera si legge con
  `ticketColumns` (il tipo `Ticket` ha `status` derivato). Le famiglie e gli
  stati del progetto restano la verità; lo status derivato è la loro
  traduzione per chi parla ancora coi sei valori (API, mobile, MCP).
- **«Smistato» vive in `triaged_at`**, non in uno stato: il trigger
  `tickets_triaged_reset` lo azzera quando il ticket esce dalla famiglia
  todo, quindi rientrando in todo è `open`. Uno scrittore che non tocca
  `triaged_at` lo lascia decidere all'enum che scrive (`triaged` lo mette,
  `open` lo toglie): è lo scrittore vecchio di una finestra di deploy o di un
  rollback, e anche uno spostamento fra due stati todo, per cui
  `tickets_status_sync` scrive `open`.
- **Vale lo stato RAGGIUNTO, non il ruolo chiesto**: in un progetto senza uno
  stato `in_review`, o con un solo stato chiuso, `roleUpdate("in_review")`
  finisce nell'unico active (status `in_progress`) e `roleUpdate("closed")`
  nello stato `done` (status `done`). Nessuna logica decide sullo status
  `in_review`: il webhook della PR chiusa senza merge riapre un ticket se è
  in uno stato active e ha una PR aperta (`awaitingPr` in
  `routes/webhooks.ts`). Chi scrive una regola nuova che dipende dal ruolo
  di un ticket la scriva sulla famiglia e sui fatti (la PR, il job), non su
  `in_review` o `closed`. Il test d'accordo copre anche un insieme di stati
  personalizzati.
- **Un filtro per status usa `ticketRoleIn` / `ticketRoleNotIn`**, non
  `inArray(ticketStatusSql, …)`: stesso esito, ma su `status_id`, quindi con
  gli indici.
- **Gli eventi di sistema dicono lo stato RAGGIUNTO**: gli scrittori di
  webhook e pipeline passano a `recordTicketStatusChange` lo status derivato
  restituito dall'UPDATE, non il ruolo chiesto. Un ruolo che lascia il
  ticket dov'è (un `in_progress` su una task in review) non lascia eventi.
- **La guardia sull'SQL grezzo** è `packages/db/src/ticket-status-guard.test.ts`,
  su sorgenti e script di server e worker, notifiche, db e mcp: in un
  template che nomina `tickets` (o in un `sql.raw`) conta ogni `status`
  nudo non qualificato da un'altra tabella. Gli usi dichiarati sono il
  riallineamento dell'enum in `routes/project-statuses.ts`, finché esiste la
  colonna (R3), e il testo del prompt di triage.
- **Nei test** si semina con `roleInsert(projectId, ruolo)` e si legge o
  scrive l'enum, quando serve, con `legacyTicketStatus` (`@stubwise/db/testing`):
  i test della 0108 provano ancora il trigger con gli scrittori vecchi.

## I follower ricevono solo ciò che vedono (9 nov 2026)

- **`ticket.activity` va ai follower che VEDONO la task**, con la regola di
  `canSeeTicket`: `tickets.view_all` nel progetto (full admin compresi),
  oppure chi l'ha chiesta. Il filtro sta nel routing
  (`packages/notifications/src/publish.ts`, ramo `ticket_followers`), quindi
  un follow scritto quando la vedeva non basta, e chi ha perso
  `tickets.view_all` smette di ricevere card a lettura del permesso.
- **Assegnare a chi non vede la task resta permesso** (il web lo dice con
  `assigneeWithoutAccess`), ma l'assegnatario ne diventa follower solo se la
  vede (`services/task-writes.ts`).
- **Il testo di un commento non entra mai nell'evento**: `ticket.activity`
  di un commento porta solo `commentId`, e l'estratto lo deriva a lettura
  l'inbox (un commento eliminato si legge «comment deleted»). Push e Slack
  dicono solo «New comment on <ref>».

## La settimana pianificata e lo slittamento (fetta 2, 9 nov 2026)

- **Nel DB il lunedì, sul filo `YYYY-Www`**: `tickets.planned_week date`
  (CHECK `isodow = 1`); le conversioni pure stanno in
  `packages/shared/src/tasks/weeks.ts`.
- **La settimana corrente è nel fuso Europe/Rome**, in UNA funzione SQL
  (`stubwise_current_monday()`) e UNA TS (`currentIsoWeek`); `serverToday` del
  server usa lo stesso fuso.
- **Lo slittamento si DERIVA a lettura, nessun job lo scrive.** Una task non
  chiusa con la settimana passata si legge nella settimana corrente
  (`stubwise_effective_week`), e `slipCount = slip_count +
  stubwise_slip_weeks(...)`. Una task chiusa smette di scivolare alla
  settimana in cui si è chiusa: chiusa nella sua settimana non è mai
  slittata. Una task RIAPERTA riprende a scivolare dalla sua settimana
  pianificata, non da quella di chiusura: il tempo in cui è stata chiusa
  conta (riaperta oggi, ha lo slittamento di tutte le settimane dalla
  pianificata a oggi). Un aggiornamento di massa toccherebbe `updated_at`,
  cioè le ferme per inattività: non va introdotto.
- **Una settimana passata non si scrive** (400 `past_week` in creazione,
  PATCH, bulk e pianificazione): gonfierebbe `slipCount`, che è un dato
  mostrato. Resta ammesso riscrivere la settimana EFFETTIVA attuale della
  task (la corrente di una slittata, quella di chiusura di una chiusa), che
  per chi guarda è un no-op; e una scrittura con gli stessi valori non fa
  l'UPDATE.
- **Il consolidamento è un trigger** (`tickets_consolidate_slip`): quando una
  scrittura cambia davvero `planned_week`, il derivato di prima si somma a
  `slip_count`. Ripianificare non perde né raddoppia il conteggio, e
  `slipCount` non si azzera mai.
- **Nei test la data la decide `stubwise.today`** (data ISO, impostata nella
  transazione): sostituisce `now()` in `stubwise_current_monday()`. Nessun
  codice di produzione la imposta.
- **Il feed registra la settimana EFFETTIVA**: `planned_week_changed` (solo
  dalle scritture umane, come `department_changed` ed `effort_changed`) parte
  dalla settimana in cui la task si legge, slittamento compreso; confermare
  una slittata nella settimana corrente non scrive niente, perché la
  settimana effettiva non cambia.
- **Le sistemazioni per giorno (`task_day_arrangements`) sono PERSONALI**:
  le legge (`GET /api/me/day-arrangements?week=`) e le scrive
  (`PUT /api/tasks/:id/day`, 403 a chi non è l'assegnatario) solo
  l'assegnatario, e solo sulle proprie task (`apps/server/src/routes/day-arrangements.ts`).
  Valgono per una settimana e un assegnatario: le cancella il trigger
  `tickets_reset_day_arrangements` quando cambiano davvero la settimana
  EFFETTIVA (slittamento e chiusura compresi, 0119) o l'assegnatario, da
  QUALUNQUE scrittura (anche del web vecchio o della pipeline): riscrivere
  la settimana corrente di una slittata non le tocca. Uno slittamento invece cambia la settimana senza scrivere
  niente, quindi la lettura filtra anche sulla settimana effettiva: una
  sistemazione di una task slittata non compare, e su una settimana che non
  è quella effettiva della task la scrittura risponde 409 `not_in_week`.

## Eliminare una task è VERO, e ciò che la nominava lo dice (10 nov 2026)

`DELETE /api/tasks/:id` (`apps/server/src/services/task-delete.ts`) toglie la
riga di `tickets`: non è un archivio, non si annulla, non chiede la
riconferma. Le regole:

- **Chi lo decide il server**: `tickets.moderate` nel progetto, o l'autore
  (`requested_by_user_id`) con `tickets.edit`. L'utente di sistema Claude non
  ha `tickets.moderate`. Il client legge `canDelete`/`whoAction`
  dall'anteprima, non li deduce.
- **Ordine**: invisibile = inesistente (404) → `forbidden` → `busy` (un job non
  concluso, una PR aperta, una correzione aperta) → la scrittura, nella
  transazione e col lock del ticket di `startRun`/`cancelRun`.
- **Il numero non si riusa**: `projects.next_ticket_number` non scende mai.
  Chi tocca l'assegnazione dei numeri non la ricavi da `max(number)`.
- **La lapide** (`deleted_tickets`) tiene solo codice, titolo, richiesta
  d'origine, chi, quando e il segno «via Claude»: MAI descrizione, commenti,
  allegati o storia. Serve a chi la nominava: la richiesta d'origine
  (`deletedTaskCodes`), le card d'inbox (`objectGone`, derivato a lettura e
  senza link), lo standup (`tasksDeleted`). Ogni altra lettura la vede come un
  codice mai esistito.
- **Le FK** verso `tickets` sono decise una per una (commento di
  `deletedTickets` in `packages/db/src/schema.ts`): chi ne aggiunge una nuova
  decide anche lei — CASCADE se è della task, SET NULL se è un fatto che
  resta — e la aggiunge al test `tasks.delete.test.ts`.

## Eliminare un progetto toglie anche gli oggetti degli allegati (11 nov 2026)

- **Le righe degli allegati dei ticket se ne vanno in cascata col progetto,
  gli oggetti dello storage no**: la cascata non li vede. La rotta
  `DELETE /api/projects/:projectId` legge PRIMA, nella stessa transazione
  della delete, le chiavi degli allegati dei ticket e della Chat del progetto
  (`storageKeysOfProject` in `apps/server/src/chat/attachments.ts`), e le
  toglie dallo storage DOPO il commit, senza far fallire l'eliminazione se
  lo storage è giù (lo dice il log). Nata nella review della fetta 4 della
  Chat; chi aggiunge un'altra tabella di allegati la aggiunga lì.

