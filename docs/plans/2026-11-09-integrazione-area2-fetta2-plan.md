# Integrazione area 2, fetta 2 (Planning e La mia settimana) — piano

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** settimana pianificata, slittamento, La mia settimana, Planning (progetto e trasversale), Timeline e `planning.others` funzionano contro il server vero, identici al prototipo, su desktop e `/app`; il prototipo resta invariato.

**Spec:** `docs/plans/2026-11-09-integrazione-area2-fetta2-design.md` (e quello della fetta 1 per architettura e regole generali).

## Global Constraints

Tutti quelli del piano della fetta 1 (`docs/plans/2026-11-09-integrazione-area2-task-plan.md`), più:
- Branch: `feat/integrazione-area2-fetta2` (parte dalla fetta 1). Prossima migrazione: **0113**.
- Settimana sul filo: stringa `YYYY-Www` (ISO, es. `2026-W46`); nel DB `date` del lunedì.
- Fuso della settimana corrente: `Europe/Rome`, in una funzione SQL e una TS.
- Pesi delle taglie: `XS=1, S=2, M=3, L=5, XL=8`, mai mostrati come numero.
- `planning.others`: Project Lead e full admin; **non** Developer, Legacy Member, Contributor, Viewer.
- Test solo filtrati (`pnpm --filter <pkg> test <pattern>`, senza `--`).

## Review Focus

1. **Cambio d'anno ISO** (W52/W53 → W01): settimana corrente, slittamento e `addWeeks` corretti → test nel Task A.
2. **Una task slittata ripianificata a mano**: `slipCount` non perde le settimane già contate e non le conta due volte → test nel Task A.
3. **Senza `planning.others`, spostare una task altrui dal Planning** (rotta plan): 403 e riga invariata → test nel Task B.
4. **Sistemazione per giorno di un'altra persona**: mai leggibile né scrivibile → test nel Task C.
5. **Una task chiusa con settimana passata**: mai slittata né in «To plan» → test nel Task A.

---

### Task A (backend): settimana, slittamento derivato, sistemazioni nel DB

**Files:** `packages/db/drizzle/0113_planned_week.sql` (+ journal, `schema.ts`, `testing.ts`), `packages/shared/src/tasks/weeks.ts` + test, `apps/server/src/services/task-view.ts`, `services/task-writes.ts`, `routes/tasks.ts`, `packages/shared/src/schemas/task-view.ts`, test `tasks.read`/`tasks.write`/`migration-0113`.

**Interfaces:**
- DB: `tickets.planned_week date null check (extract(isodow from planned_week) = 1)`, `tickets.slip_count int not null default 0 check >= 0`, indice parziale `(assignee_id, planned_week) where closed_at is null`; `stubwise_current_monday() → date` (fuso `Europe/Rome`), `stubwise_effective_week(planned date, closed_at timestamptz) → date`, `stubwise_slip_weeks(planned date, closed_at timestamptz) → int`; `task_day_arrangements(ticket_id fk cascade, user_id fk cascade, week date not null, day smallint null check between 1 and 5, pk(ticket_id, user_id, week))`; trigger AFTER UPDATE OF `planned_week`, `assignee_id` su `tickets` che cancella le sistemazioni del ticket se cambiano davvero.
- Shared: `isoWeekToMonday(w: string): string` (data ISO), `mondayToIsoWeek(d: string): string`, `addWeeks(w, n)`, `compareWeeks(a, b)`, `weekDays(w)`, `currentIsoWeek(now: Date): string` (Europe/Rome), `slipOf({plannedWeek, slipCount, closed}, currentWeek) → {plannedWeek, slipCount}` — le funzioni senza «oggi» spostate da `apps/desktop/src/renderer/domain/weeks.ts`, che le riesporta.
- TaskView: `plannedWeek` = settimana effettiva, `slipCount` = consolidato + derivato. Filtro di periodo `plannedWeek` = intervallo sulla settimana effettiva. `plannedWeek` scrivibile in POST/PATCH/bulk (consolida lo slittamento, come detto nel design).
- [ ] Test: «una task aperta della settimana scorsa è nella corrente con slipCount 1», «due settimane fa → 2», «chiusa: mai slittata», «ripianificare una slittata tiene il conteggio e non lo raddoppia», «W53 → W01 dell'anno dopo», «cambiare settimana o assegnatario cancella le sistemazioni», «il filtro settimana trova la task slittata nella corrente». Poi implementa; commit `feat(db,server): settimana pianificata e slittamento derivato`.

### Task B (backend): `planning.others`, regole di pianificazione e rotta `plan`

**Files:** `packages/shared/src/permissions.ts` (+ test dei preset), `apps/web/src/lib/permission-groups.ts` + i18n, `apps/desktop/src/renderer/domain/access/actions.ts`, `data/access/catalog.ts`, `data/types.ts`; `packages/db/drizzle/0114_planning_permission.sql` (preset `project_lead`, `distinct unnest`, + `roles-migration.test`); `packages/shared/src/tasks/{load,planning}.ts` + test (spostati da `apps/desktop/src/renderer/domain/{load,planning}.ts`, che diventano adattatori); `apps/server/src/services/task-writes.ts`, `routes/tasks.ts`, `services/task-view.ts`.

**Interfaces:**
- Permesso di progetto `planning.others` nel registro; escluso esplicitamente da Developer e Legacy Member; label en «Plan other people's tasks» / it «Pianificare le task altrui»; tolto dai permessi locali del prototipo.
- Shared: `SIZE_WEIGHT`, `load`, `progress`, `usualWeekWeight`, `isToPlan`, `peopleLoad`, `busiestCell`, `planBlock(rights, task, plan) → null | "forbidden" | "invalid_assignee"`, `canMove`, `planRecipientsOf` — stesse firme del prototipo, rese pure (oggi e diritti passati come argomenti).
- `POST /api/tasks/:ticketId/plan` (`project member`, `ticketVisible`) body `{assigneeId: uuid|null, week: string|null}` → `TaskView`; decide `planBlock` con i diritti calcolati dal server. PATCH e bulk restano a `tickets.edit` anche per `plannedWeek` e `assigneeId`, come `prepareTaskPatch` del prototipo.
- `TaskView.canPlan: boolean` (`.optional()`), derivato per chi guarda.
- [ ] Test: sulla rotta plan, «Developer sposta una task altrui → 403 e riga invariata»; «PATCH plannedWeek con tickets.edit resta permesso (come il prototipo)», «Developer prende per sé una non assegnata con tickets.edit → ok», «Project Lead sposta chiunque», «assegnatario non membro → 400 invalid_assignee», «canPlan falso sulle task altrui per il Developer», preset: «Legacy Member e Developer non hanno planning.others». Commit `feat(server): planning.others e pianificazione dal server`.

### Task C (backend): sistemazioni per giorno e avvisi di pianificazione

**Files:** `apps/server/src/routes/day-arrangements.ts` + test, `packages/db/drizzle/0115_planning_notification_kinds.sql` (solo `ADD VALUE`), `packages/notifications/*`, `packages/shared/src/schemas/notification.ts`, `packages/i18n/src/catalog.ts`, card web/mobile, `apps/desktop/src/renderer/data/seed/notifications.ts` (kind nel registro condiviso), `services/task-writes.ts`.

**Interfaces:**
- `GET /api/me/day-arrangements?week=YYYY-Www` (`user`) → `{taskId, week, day}[]` solo delle task visibili assegnate a chi guarda e ancora in quella settimana; `PUT /api/tasks/:ticketId/day` body `{week, day: 1..5|null}` (solo l'assegnatario, task in quella settimana, altrimenti 403/409).
- Kind `planning.changed` (audience: la persona che aveva la task, se spostata o tolta da altri; mai l'attore; solo se vede la task) e `task.assigned` (a chi la riceve da altri) — prima verifica se esiste un avviso di assegnazione equivalente e riusalo; eventi con le settimane prima/dopo come dati.
- [ ] Test: «la sistemazione di un altro non si legge né si scrive», «una sistemazione di una settimana diversa da quella della task non compare», «spostata da un Project Lead → planning.changed a chi l'aveva, non all'attore», «presa per sé → nessun avviso». Commit `feat(server): sistemazioni per giorno e avvisi di pianificazione`.

### Task D (backend): api-client

`tasks.plan(id, body)`, `me.dayArrangements(week)`, `tasks.setDay(id, body)`, `plannedWeek` nei tipi di filtri e patch. Test in `client.test.ts`. Commit `feat(api-client): pianificazione`.

### Task E (renderer): navigazione e superfici della fetta 2 nella build app

**Files:** `data/integration.ts`, `router.tsx`, `layout/*` (colonna della Home), `pages/week/*`, `pages/planning/*`, `pages/tasks/{TasksPage,TaskTimeline}.tsx`, `pages/task/*`, `tasks-ui/*`, i18n.

- Integrati in `app`: `/home?view=week`, `/planning` (con la regola del prototipo: solo con `planning.others` in almeno un progetto), sezione di progetto `planning`, vista `timeline`, `featureIntegrated("planning-week")`. `/home` senza `view=week` resta «in arrivo»; dopo il login si atterra su La mia settimana; la colonna della Home mostra «My week» e «Planning», il resto «in arrivo». Claude escluso dalle righe del Planning in `app`.
- Il carico avverte quando la lista è troncata.
- [ ] Test (build app, `vi.stubEnv`): «dopo il login si atterra su La mia settimana», «/home senza view resta Coming soon», «/planning senza planning.others torna a My week», «la Timeline è disponibile», «nessuna chiamata fuori elenco» (estendi l'elenco del test del Task 12 della fetta 1). Commit `feat(desktop): superfici della fetta 2 nella build app`.

### Task F (renderer): implementazione vera della pianificazione

Dopo l'unione di A–D. **Files:** `data/backend/real/{planning,tasks}.ts` + test.
- `planTask` → `tasks.plan`; `setDay` → `tasks.setDay`; `listDayArrangements` → `me.dayArrangements`; `plannedWeek` in `updateTask`/`bulkUpdateTasks`/`createTask`; `toTask` legge `plannedWeek`, `slipCount`, `canPlan`; il Planning e le righe in sola lettura usano `canPlan` della vista (in `app`) invece di dedurlo.
- [ ] Test: «planTask 403 riporta indietro l'ottimistico con il messaggio», «setDay di una task non mia non parte», «canPlan del server decide la sola lettura», «troncato: l'avviso compare». Commit `feat(desktop): pianificazione dal server`.

### Task G (chiusura)

`apps/desktop/docs/integration-slice2.md` (parità e scelte), voce del deploy-log «Integrazione area 2, fetta 2» (migrazioni 0113–0115, ordine, rollback: i kind nuovi, `task_day_arrangements` inerte, un server vecchio non legge `planned_week`), `CLAUDE.md` se cambia qualcosa di trasversale. Commit `docs: integrazione area 2 fetta 2`.
