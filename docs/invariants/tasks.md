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

