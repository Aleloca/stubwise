# Integrazione area 2, fetta 1 (ossatura vera e Tasks) — piano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** le pagine della fetta 1 del prototipo desktop (shell, Tasks elenco/board, dettaglio, nuova task, stati e soglie del progetto, Reparti) funzionano contro il server vero, identiche al prototipo, nell'app desktop e nel browser su `/app`, mentre il prototipo resta avviabile coi dati finti.

**Architecture:** il renderer di `apps/desktop/src/renderer` resta l'unico codice dell'interfaccia. Il livello dati passa da due specificatori (`@backend/api`, `@backend/clock`) che un alias di Vite risolve sull'implementazione finta di oggi (build «prototype», e i test) o su un'implementazione vera su `@stubwise/api-client` (build «app»). Il server espone un gruppo di rotte nuovo, `/api/tasks`, che restituisce le viste nella forma del prototipo; la coerenza col modello vecchio (enum `tickets.status`, `effort`, tipi) è garantita nel DB da un trigger, così web vecchio, mobile, MCP e pipeline non cambiano.

**Tech Stack:** Fastify + Zod, Drizzle + Postgres 17 (migrazioni SQL a mano), Vitest + testcontainers, React 19 + TanStack Query/Router, Vite/electron-vite, Electron 45 (`safeStorage`, IPC), caddy.

**Spec:** `docs/plans/2026-11-09-integrazione-area2-task-design.md` (design approvato il 9 nov 2026). Il comportamento di ogni pagina è quello del prototipo: `apps/desktop/.impeccable/shape/{tasks,task-delete,task-claude,project-settings,admin-roles-members}.md` e `docs/plans/2026-10-23-desktop-area2-task-design.md`. Leggere prima `CLAUDE.md` (radice) e `apps/desktop/README.md`.

## Global Constraints

- Node >= 22, pnpm 10.9; nessuna dipendenza nuova oltre a `electron-builder` (Task 15) e `@stubwise/api-client` in `apps/desktop`.
- Migrazioni scritte a mano in `packages/db/drizzle/` (prossima: `0107`), voce aggiunta a mano in `meta/_journal.json`; `drizzle-kit generate` NON funziona (snapshot ferme a 0060). Lo schema TS in `packages/db/src/schema.ts` va aggiornato in parallelo.
- Un `ALTER TYPE … ADD VALUE` sta in una migrazione propria e nessuna migrazione dello stesso batch usa il valore (`CLAUDE.md`, «Migrazioni Drizzle»).
- Ogni rotta nuova dichiara `config.access` (`apps/server/src/auth/access.ts`); progetto o task invisibile → 404 `not_found`; elenchi filtrati nella WHERE prima di paginare/contare.
- Cambi alle risposte lette da mobile/web vecchio solo additivi; campi nuovi `.optional()`/`.default()`/`.nullable()` con test che parsa una risposta senza.
- Ogni testo dell'interfaccia esiste in `en` e `it` (`apps/desktop/src/renderer/i18n/locales/`); i permessi nuovi hanno gruppo e frase (`apps/web/src/lib/permission-groups.ts`, `apps/desktop/src/renderer/domain/access/actions.ts`, `permissions.label.<chiave>` in `apps/web/src/i18n/locales/{en,it}.json`).
- Nelle build «app» nessun dato del seed è nel bundle (verificato dal Task 14).
- Il token del desktop non arriva mai al renderer; il preload espone solo funzioni strette, mai `ipcRenderer`.
- Taglie: `XS=1, S=2, M=3, L=4, XL=5` sulla colonna `tickets.effort` esistente (nessuna colonna nuova; gate e triage invariati).
- Tipi nell'app nuova: `bug`, `feature`, `activity`; DB: `activity ↔ task`, `feedback → feature`, `review → activity` in lettura; l'app nuova scrive solo `bug|feature|task`, e solo se il tipo mostrato cambia.
- Stati di default di ogni progetto (modello «Software» del prototipo), in ordine: `To do` (todo) · `In progress` (active) · `In review` (active) · `Done` (closed) · `Discarded` (closed). Sono dati, non testi tradotti: la lingua di default del prodotto è l'inglese, e si rinominano dalle impostazioni del progetto.
- Soglie «ferma» di default: `activeDays = 7`, `todoDays = 14`.
- Reparto di ripiego: «General» (`is_default = true`), si rinomina ma non si elimina.
- Codice di progetto: `^[A-Z][A-Z0-9]{1,5}$`, unico.
- Allegati: le rotte e i limiti di oggi (10 MB, allowlist MIME di `apps/server/src/routes/attachments.ts`), nessuna implementazione nuova.
- Commit frequenti sul branch `feat/integrazione-area2-fetta1`; prima di ogni push `pnpm lint`, `pnpm typecheck`, test dei package toccati.

## Review Focus

1. **Scrittore vecchio dell'enum dopo una scrittura nuova** (la pipeline porta a `in_review` una task che l'app nuova ha messo in uno stato `active` personalizzato): lo stato vero deve restare coerente con la famiglia e non tornare indietro → test nel Task 2 («in_review su una task già in uno stato active successivo non la sposta indietro»).
2. **Eliminare l'unico stato di una famiglia, o uno stato con task, senza riassegnazione**: rifiutato dal server con 400 e stato invariato → test nel Task 6.
3. **Persona cambiata o sessione scaduta a metà**: nessun dato della sessione precedente resta in cache; un 401 a metà porta al login senza schermate rotte → test nel Task 16.
4. **Task di un progetto in cui chi guarda non è più membro, aperta da link `?task=CODE`**: stessa pagina di «non esiste», nessun campo trapela → test nel Task 7 (404) e nel Task 17 (pannello «not found»).
5. **Card d'inbox di un kind sconosciuto all'app nuova** (kind aggiunto dopo, o di un'area non integrata): si mostra con titolo e «Apri nel web», non rompe il pannello → test nel Task 16.

---

## Mappa dei file

**DB (`packages/db`)**
- `drizzle/0107_project_codes_departments.sql`, `drizzle/0108_project_statuses.sql`, `drizzle/0109_task_extras.sql`, `drizzle/0110_task_notification_kinds.sql` (+ `meta/_journal.json`)
- `src/schema.ts` (tabelle e colonne nuove), `src/testing.ts` (helper nuovi)
- `src/migration-0107.test.ts` … `src/migration-0109.test.ts`

**Condiviso (`packages/shared`)**
- `src/tasks/sizes.ts`, `src/tasks/types.ts`, `src/tasks/stall.ts` (regole pure) + test
- `src/schemas/task-view.ts` (contratto delle viste nuove) + test
- `src/permissions.ts` (`departments.manage`)

**Server (`apps/server/src`)**
- `routes/departments.ts`, `routes/people.ts`, `routes/project-statuses.ts`, `routes/tasks.ts`, `routes/decisions.ts` (+ test)
- `services/task-view.ts` (assemblaggio delle viste), `services/task-writes.ts`, `services/decisions.ts`, `services/task-notify.ts`
- `app.ts` (registrazione), `routes/projects.ts` (`code`), `routes/auth.ts` (`displayName` su `/me`)

**Notifiche (`packages/notifications`)**: `format.ts`, `routing.ts`, `actions.ts`, `push/payload.ts`, `index.ts`; `packages/i18n/src/catalog.ts`; `packages/shared/src/schemas/notification.ts`.

**Client (`packages/api-client`)**: `src/endpoints/{tasks,departments,people,projectStatuses,decisions}.ts`, `src/client.ts`.

**Renderer (`apps/desktop`)**
- `src/renderer/data/backend/real/*` (implementazione vera, per gruppo), `src/renderer/data/backend/real/stubs.generated.ts`, `scripts/gen-backend-stubs.mjs`
- `src/renderer/data/integration.ts` (cosa è integrato in questa build)
- `src/renderer/data/queries.ts`, `src/renderer/data/queries/*.ts` (import da `@backend/api`)
- `src/renderer/data/viewer.ts` (viewer dalla query)
- `vite.backend.ts` (plugin/alias condiviso), `electron.vite.config.ts`, `vite.web.config.ts`, `vite.app-web.config.ts`, `vitest.config.ts`, `tsconfig*.json`
- `src/main/{instance,session,apiProxy}.ts`, `src/main/index.ts`, `src/main/security.ts`, `src/preload/index.ts`, `src/renderer/env.d.ts`
- `electron-builder.yml`

**Deploy/doc**: `Caddyfile`, `Dockerfile.caddy`, `docs/operations/deploy-log.md`, `docs/invariants/tasks.md`, `CLAUDE.md`, `apps/desktop/README.md`, `apps/desktop/docs/integration-slice1.md`.

---

### Task 1: Codici di progetto, reparti, nome visualizzato, permesso `departments.manage`

**Files:**
- Create: `packages/db/drizzle/0107_project_codes_departments.sql`, `packages/db/src/migration-0107.test.ts`
- Modify: `packages/db/drizzle/meta/_journal.json`, `packages/db/src/schema.ts`, `packages/db/src/testing.ts`, `packages/shared/src/permissions.ts`, `packages/shared/src/permissions.test.ts`, `apps/web/src/lib/permission-groups.ts`, `apps/web/src/i18n/locales/{en,it}.json`, `apps/desktop/src/renderer/domain/access/actions.ts`

**Interfaces:**
- Produces (DB): `projects.code text NOT NULL UNIQUE` (CHECK `code ~ '^[A-Z][A-Z0-9]{1,5}$'`); `departments(id uuid pk, name text not null, color_token text not null check in ('--dept-1'…'--dept-8'), is_default boolean not null default false, created_at)` con indice unico parziale su `is_default` where true; `department_members(department_id fk cascade, user_id fk cascade, position int not null, pk(department_id,user_id))` (`position` = ordine dei reparti della persona: «primo reparto» = `min(position)`); `users.display_name text null`.
- Produces (TS): `departments`, `departmentMembers` in `schema.ts`; `seedDepartment(db, {name?, isDefault?}) → {id}` e `addDepartmentMember(db, departmentId, userId, position?)` in `testing.ts`; permesso d'istanza `departments.manage` in `INSTANCE_PERMISSIONS`.

- [ ] **Step 1: Test della migrazione** in `migration-0107.test.ts` (pattern dei `migration-0NNN.test.ts`): `startTestDb()`, poi
  - `it("dà un codice unico a ogni progetto esistente, ricavato dallo slug")`: chiama la funzione SQL di backfill esposta dalla migrazione (`stubwise_assign_project_codes()`, idempotente: tocca solo i progetti con `code` null) su progetti inseriti con slug `audin-ai`, `stubwise`, `stubwise-2`, `x` in quest'ordine di `created_at`; attesi `AUD`, `STU`, `STU2`, `XXX`.
  - `it("crea il reparto General di ripiego con tutte le persone")`: un solo `is_default`, ogni utente esistente ne è membro con `position = 0`.
  - `it("rifiuta un secondo reparto di ripiego")`: `expectSqlState(…, '23505')`.
  - `it("rifiuta un codice fuori formato")`: `'stw'` → `23514`.
- [ ] **Step 2:** `pnpm --filter @stubwise/db test -- migration-0107` → FAIL (migrazione assente).
- [ ] **Step 3: Scrivi la migrazione.** Regola del codice, in una funzione SQL `stubwise_project_code(slug text) returns text` (resta nel DB, la riusa il server per i progetti nuovi): `upper(left(regexp_replace(slug, '[^a-z]', '', 'g'), 3))`, completato a 3 con `X` se più corto (`x` → `XXX`); collisioni risolte da `stubwise_assign_project_codes()` aggiungendo `2`, `3`, … nell'ordine `created_at`. Colonna aggiunta nullable, backfill con quella funzione, poi `SET NOT NULL` + UNIQUE + CHECK. Inserisci il reparto `General` (`--dept-1`, `is_default = true`) e tutte le persone come membri. Aggiungi `departments.manage` al preset d'istanza `admin` con il pattern `distinct unnest` di `0103_credentials_permissions.sql`.
- [ ] **Step 4: Permesso nel registro.** `departments.manage` in `INSTANCE_PERMISSIONS`; gruppo d'istanza esistente più vicino alla gestione persone/ruoli in `INSTANCE_PERMISSION_GROUPS` e nel gemello `groupsFor` del desktop (che oggi lo dichiara locale in `data/types.ts` `LocalInstancePermission`: toglilo da lì); label `permissions.label.departments.manage` in en («Manage departments») e it («Gestire i reparti»).
- [ ] **Step 5:** `pnpm --filter @stubwise/db test -- migration-0107`, `pnpm --filter @stubwise/shared test`, `pnpm --filter @stubwise/web test -- permission-groups`, `pnpm --filter @stubwise/desktop test -- access` → PASS.
- [ ] **Step 6:** Commit `feat(db): codici di progetto, reparti e permesso departments.manage`.

### Task 2: Stati per progetto e sincronizzazione con l'enum

**Files:**
- Create: `packages/db/drizzle/0108_project_statuses.sql`, `packages/db/src/migration-0108.test.ts`, `docs/invariants/tasks.md`
- Modify: `packages/db/drizzle/meta/_journal.json`, `packages/db/src/schema.ts`, `packages/db/src/testing.ts`

**Interfaces:**
- Produces (DB): `project_statuses(id uuid pk, project_id fk cascade, name text not null, family text not null check in ('todo','active','closed'), position int not null, legacy_status ticket_status not null, unique(project_id, position) deferrable initially deferred)`; `tickets.status_id uuid NOT NULL fk project_statuses on delete restrict`; `tickets.closed_at timestamptz null`.
- Produces (DB funzioni): `stubwise_legacy_family(ticket_status) → text` (`open|triaged → todo`, `in_progress|in_review → active`, `done|closed → closed`); `stubwise_status_for_legacy(project_id uuid, legacy ticket_status, current_status_id uuid) → uuid`; trigger `tickets_status_sync` BEFORE INSERT OR UPDATE OF `status`, `status_id` ON `tickets`; trigger `projects_default_statuses` AFTER INSERT ON `projects`.
- Produces (TS): `projectStatuses` in `schema.ts`; `firstStatusOf(db, projectId, family) → id` in `testing.ts`.

Regole del trigger (le scrive questo task, sono la decisione «enum derivato» del design):
- `legacy_status` di uno stato: lo calcola chi scrive gli stati (Task 6) con la regola «todo → `open`; active: il primo → `in_progress`, gli altri → `in_review`; closed: il primo → `done`, gli altri → `closed`».
- INSERT con `status_id` null → `status_id := stubwise_status_for_legacy(project_id, status, null)`. INSERT con `status_id` → `status := legacy_status` dello stato.
- UPDATE che cambia solo `status_id` → `status := legacy_status` del nuovo stato.
- UPDATE che cambia solo `status` → `status_id := stubwise_status_for_legacy(project_id, new.status, old.status_id)`, e il valore di `status` scritto resta (così `triaged` sopravvive per chi lo legge).
- UPDATE che cambia entrambi → se le famiglie non coincidono `RAISE EXCEPTION` (SQLSTATE `23514`).
- Uno stato di un altro progetto → `RAISE` (`23503`).
- `closed_at := now()` quando la famiglia diventa `closed`, `null` quando lascia `closed`.
- `stubwise_status_for_legacy`: famiglia todo → primo `todo` per `position`; `in_progress` → se lo stato corrente è già `active` lo tiene, altrimenti il primo `active`; `in_review` → se lo stato corrente è `active` con `legacy_status = 'in_review'` lo tiene, altrimenti il primo `active` dopo quello corrente con `legacy_status = 'in_review'`, altrimenti l'ultimo `active`; `done` → il primo `closed` con `legacy_status = 'done'`, altrimenti il primo `closed`; `closed` → il primo `closed` con `legacy_status = 'closed'`, altrimenti l'ultimo `closed`.
- `projects_default_statuses`: crea i 5 stati di default (Global Constraints) con `legacy_status` `open, in_progress, in_review, done, closed`.

- [ ] **Step 1: Test** in `migration-0108.test.ts` (usa `seedRepository`, `seedTicket`):
  - `it("un progetto nuovo nasce con i cinque stati di default")`.
  - `it("backfill: ogni ticket esistente ha lo stato che corrisponde al suo enum")` — per `open,triaged,in_progress,in_review,done,closed` attesi `To do,To do,In progress,In review,Done,Discarded`.
  - `it("la pipeline che scrive in_review sposta in In review")`, `it("il webhook che scrive done sposta in Done e valorizza closed_at")`, `it("in_review → triaged torna nel primo todo, lo status resta triaged e closed_at torna null")`.
  - `it("cambiare status_id riscrive l'enum dal legacy_status")`.
  - `it("in_review su una task già in uno stato active successivo non la sposta indietro")`: aggiungi uno stato `QA` (active, `legacy_status = in_review`, dopo `In review`), metti la task in `QA`, scrivi `status = 'in_review'` → resta in `QA`.
  - `it("famiglie discordanti nello stesso UPDATE sono rifiutate")` → `23514`; `it("uno stato di un altro progetto è rifiutato")` → `23503`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** scrivi migrazione (tabella, funzioni, trigger dei progetti, stati per i progetti esistenti, colonna `status_id` nullable, backfill con la stessa funzione, `SET NOT NULL`, trigger dei ticket per ultimo, `closed_at` backfill dall'ultimo evento `status_changed` verso `done|closed` o `updated_at`), schema TS, helper.
- [ ] **Step 4:** run → PASS; poi `pnpm --filter @stubwise/server test` e `pnpm --filter @stubwise/worker test` → PASS invariati (prova che nessun scrittore vecchio si è rotto).
- [ ] **Step 5:** `docs/invariants/tasks.md`: «Lo stato vero è `status_id`; l'enum lo tiene coerente il trigger `tickets_status_sync`, in UN posto; nessun codice scrive la mappatura a mano», le regole sopra, e «l'enum si toglie col ritiro del web vecchio». Aggiungi la voce all'elenco «Invarianti e trappole» di `CLAUDE.md`.
- [ ] **Step 6:** Commit `feat(db): stati per progetto con enum derivato da trigger`.

### Task 3: Ferme a mano, soglie, follower, richieste di decisione

**Files:**
- Create: `packages/db/drizzle/0109_task_extras.sql`, `packages/db/src/migration-0109.test.ts`
- Modify: `meta/_journal.json`, `packages/db/src/schema.ts`, `packages/db/src/testing.ts`

**Interfaces:**
- Produces (DB): `projects.stall_active_days int not null default 7 check between 1 and 90`, `projects.stall_todo_days int not null default 14 check between 1 and 90`; `tickets.department_id uuid NOT NULL fk departments on delete restrict` (backfill: il reparto di ripiego; BEFORE INSERT: se null → reparto di ripiego); `tickets.manual_stall_reason text null`, `manual_stall_note text null`, `manual_stall_since timestamptz null`, `manual_stall_by_user_id uuid null fk users set null` (CHECK: reason e since entrambi null o entrambi valorizzati); `ticket_followers(ticket_id fk cascade, user_id fk cascade, created_at, pk)`; `decision_requests(id, ticket_id fk cascade, asked_by_user_id fk set null, asked_of_user_id fk cascade not null, question text not null check length 1..2000, options text[] not null default '{}' check cardinality <= 8, created_at, withdrawn_at, answer_option_index int null, answer_text text null, answered_at, answered_by_user_id fk set null)` con CHECK «al più uno fra risposta e ritiro» e «risposta = indice oppure testo».
- Produces (TS): `ticketFollowers`, `decisionRequests` in `schema.ts`; `seedDecisionRequest(db, {ticketId, askedOfUserId, askedByUserId?, options?})` in `testing.ts`.

- [ ] **Step 1: Test** `migration-0109.test.ts`: `it("i ticket esistenti finiscono nel reparto di ripiego")`, `it("un ticket inserito senza reparto prende quello di ripiego")`, `it("eliminare il reparto di ripiego con task è rifiutato")` (`23503`), `it("una decisione non può essere sia risposta sia ritirata")` (`23514`), `it("eliminare il ticket elimina follower e decisioni")`.
- [ ] **Step 2:** FAIL. **Step 3:** migrazione + schema + helper. **Step 4:** PASS (+ server e worker invariati).
- [ ] **Step 5:** Commit `feat(db): ferme a mano, soglie, follower e richieste di decisione`.

### Task 4: Tre `notification_kind` nuovi

**Files:**
- Create: `packages/db/drizzle/0110_task_notification_kinds.sql`
- Modify: `meta/_journal.json`, `packages/db/src/schema.ts`, `packages/db/src/migration-0089.test.ts` (l'elenco dei kind), `packages/notifications/src/{format.ts,routing.ts,actions.ts,dispatch.ts,push/payload.ts,index.ts}`, `packages/shared/src/schemas/notification.ts`, `packages/i18n/src/catalog.ts`, `apps/web/src/components/inbox-item.tsx` + i18n web, `apps/mobile/src/components/inbox/InfoCard.tsx` + i18n mobile, `apps/desktop/src/renderer/data/seed/notifications.ts`

**Interfaces:**
- Produces: kind `decision.requested` (audience nuova `decision_target` = `asked_of_user_id`; azione `open`), `decision.answered` (audience nuova `decision_asker` = `asked_by_user_id`; `open`), `ticket.activity` (audience nuova `ticket_followers`, escluso l'attore; `open`). Eventi tipizzati in `format.ts`:
  - `{ kind: "decision.requested", ticketId, ticketNumber, projectId, projectCode, decisionId, question, askedByUserId }`
  - `{ kind: "decision.answered", ticketId, ticketNumber, projectId, projectCode, decisionId, question, answerSummary, answeredByUserId }`
  - `{ kind: "ticket.activity", ticketId, ticketNumber, projectId, projectCode, change: "status"|"assignee"|"comment", summary, actorUserId }`
  - Nessuno dei tre è in `MANDATORY_KINDS`; tutti e tre con push.
  - Seguendo la regola «si derivano a lettura»: nell'evento solo ciò che è vero al momento (domanda, sintesi della risposta, sintesi del cambio); titolo e codice correnti si leggono dal DB in `readTicket`/simili se la card li mostra.

- [ ] **Step 1:** aggiungi i tre `sampleEvents`; `pnpm --filter @stubwise/server test -- notification-kinds` → FAIL (enum DB senza i valori).
- [ ] **Step 2:** migrazione con tre `ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS …` separati da `--> statement-breakpoint` e nient'altro; schema, routing, format, payload push, i18n (titoli/corpi en+it), card web e mobile (resa generica con «Apri», sul modello di `security.alert`).
- [ ] **Step 3:** `pnpm --filter @stubwise/server test -- notification-kinds`, `pnpm --filter @stubwise/notifications test`, `pnpm --filter @stubwise/mobile test -- inbox`, `pnpm --filter @stubwise/web test -- inbox` → PASS.
- [ ] **Step 4:** Commit `feat(notifications): decisione chiesta, decisione risposta, attività della task`.

### Task 5: Regole pure e contratto delle viste in `@stubwise/shared`

**Files:**
- Create: `packages/shared/src/tasks/{sizes.ts,types.ts,stall.ts,index.ts}` + `*.test.ts`, `packages/shared/src/schemas/task-view.ts` + `task-view.test.ts`
- Modify: `packages/shared/src/index.ts`, `apps/desktop/src/renderer/domain/stalled.ts` (diventa un adattatore sottile)

**Interfaces:**
- Produces:
  - `type TaskSize = "XS"|"S"|"M"|"L"|"XL"`; `sizeFromEffort(effort: number|null): TaskSize|null`; `effortFromSize(size: TaskSize|null): number|null`.
  - `type UiTaskType = "bug"|"feature"|"activity"`; `uiTypeOf(t: TicketType): UiTaskType`; `ticketTypeFor(ui: UiTaskType): "bug"|"feature"|"task"`.
  - `type StatusFamily = "todo"|"active"|"closed"`; `legacyFamilyOf(s: TicketStatus): StatusFamily` (stessa tabella della funzione SQL del Task 2).
  - `stallOf(task: StallTaskInput, ctx: StallInputContext, today: string): Stall|null` con `StallTaskInput = { id, assigneeId: string|null, manualStall: {reason, note, since}|null, links: {kind, taskId}[], lastActivityAt: string, plannedWeek: string|null }` e `StallInputContext = { family, openDecisions: {askedOfId, createdAt}[], claudeQuestionSince: string|null, blockers: {id, family, since}[], thresholds: {activeDays, todoDays} }`; `Stall` e `StallReason` con la stessa forma di `apps/desktop/src/renderer/data/model.ts` (spostati qui, il model li ri-esporta). Precedenza e soglie identiche a `domain/stalled.ts` di oggi.
  - Schemi Zod in `task-view.ts` (contratto server → app; ogni campo che il prototipo ha e il server non manda ancora è `.optional()`/`.nullable()`):
    - `departmentViewSchema {id, name, colorToken, isDefault}`
    - `personViewSchema {id, name, initials, departmentIds, email, deactivated}`
    - `projectStatusViewSchema {id, projectId, name, family, position}`
    - `taskViewSchema` = i campi di `Task` del prototipo (`data/model.ts:324`) meno `plannedWeek`/`slipCount` (`.nullable().default(null)`/`.default(0)`, fetta 2), più `ticketId` (uuid) e `number`; `assigneeId` mai Claude in questa fetta.
    - `taskStallViewSchema {taskId, stall}`; `decisionRequestViewSchema` = `DecisionRequest` del prototipo; `taskActivityEntryViewSchema` = `ActivityEntry` del prototipo; `taskWorkViewSchema` = il sottoinsieme di `TaskWork` che la sezione Claude usa (stato, PR con url/stato, `webHref`).
    - `taskPatchSchema` (tutti opzionali: `title, description, statusId, departmentId, assigneeId|null, size|null, dueDate|null, milestoneId|null, labels, type, priority`), `newTaskBodySchema` (`projectId, title, description?, departmentId?, assigneeId?, size?, statusId?, milestoneId?, type, priority?, requestId?`), `taskListQuerySchema` (= `FilterCriteria` del prototipo, `data/model.ts:696`, con array come stringhe separate da virgola).

- [ ] **Step 1: Test** `sizes.test.ts` (`1→XS…5→XL`, `null↔null`, andata-ritorno), `types.test.ts` (`feedback→feature`, `review→activity`, `task→activity`, `activity→task`), `stall.test.ts` (porta qui i casi di `apps/desktop/src/renderer/domain/stalled.test.ts` adattandoli alla firma con `today` esplicito; più `it("una todo senza settimana pianificata non scatta per inattività")`), `task-view.test.ts` (`it("una taskView senza plannedWeek né slipCount parsa con i default")`).
- [ ] **Step 2:** FAIL. **Step 3:** implementa; `domain/stalled.ts` del desktop costruisce `StallTaskInput`/contesto dal suo `Task` e chiama `stallOf(…, TODAY)` (una regola, un posto).
- [ ] **Step 4:** `pnpm --filter @stubwise/shared build && pnpm --filter @stubwise/shared test`, `pnpm --filter @stubwise/desktop test -- stalled` → PASS (i test del prototipo restano verdi senza modifiche).
- [ ] **Step 5:** Commit `feat(shared): taglie, tipi, ferme e contratto delle viste task`.

### Task 6: Rotte di reparti, persone, stati e soglie

**Files:**
- Create: `apps/server/src/routes/{departments,people,project-statuses}.ts` + `.test.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/routes/projects.ts` (`code` nella risposta e nella PATCH), `apps/server/src/routes/auth.ts` (`displayName` nella PATCH `/me` e nella risposta), `packages/shared/src/schemas/project.ts` (`code` `.optional()`), `apps/server/src/auth/route-access.test.ts` se gli elenchi chiusi lo richiedono

**Interfaces:**
- Produces:
  - `GET /api/departments` (`user`) → `departmentViewSchema[]`; `POST /api/departments` (`instance departments.manage`, body `{name, colorToken}`); `PATCH /api/departments/:id` (`{name?, colorToken?, memberIds?}`, `memberIds` sostituisce l'insieme e mette il reparto per ultimo fra quelli della persona); `DELETE /api/departments/:id?moveTasksTo=<id>` (400 `department_is_default` sul ripiego; con task e senza `moveTasksTo` 400 `department_has_tasks`).
  - `GET /api/people` (`user`) → `personViewSchema[]`: le persone che condividono almeno un progetto visibile con chi guarda, più sé stesso; full admin: tutte. `name = display_name ?? parte locale dell'email`; `initials` = due iniziali del nome.
  - `GET /api/projects/:projectId/statuses` (`project member`) → `projectStatusViewSchema[]`; `PUT /api/projects/:projectId/statuses` (`project project.settings.manage`, body `{statuses: {id?, name, family}[], reassign: Record<statusId, statusId>}`) — riscrive posizioni e `legacy_status` (regola del Task 2), elimina gli assenti spostando le loro task secondo `reassign`, tutto in una transazione.
  - `PUT /api/projects/:projectId/stall-thresholds` (`project.settings.manage`, `{activeDays, todoDays}` interi 1–90).
  - `POST /api/projects` assegna `code` con `stubwise_project_code` (disambiguato come nel backfill) se il body non lo dà; `PATCH /api/projects/:projectId` accetta `code` (409 `code_taken`).
  - Registrate in `app.ts` rispettando la trappola di routing (letterali prima di `/:projectId`).

- [ ] **Step 1: Test** (pattern `routes/milestones.test.ts`, `seedUsers`, `addMember`):
  - reparti: un member senza `departments.manage` → 403 **e** reparto invariato; eliminare il ripiego → 400 e invariato; eliminare con task senza `moveTasksTo` → 400; con `moveTasksTo` → task spostate.
  - persone: `it("non vede chi non condivide un progetto")`.
  - stati: `it("PUT senza uno stato closed è rifiutato")` → 400 `status_family_missing` e stati invariati; `it("eliminare uno stato con task senza reassign è rifiutato")` → 400 `status_reassign_missing`; `it("rinomina e riordina ricalcolano legacy_status")`; un Developer → 403; un progetto invisibile → 404.
  - progetti: `it("un progetto nuovo ha un codice")`, `it("PATCH code già usato → 409")`; `it("la risposta di GET /api/projects senza code parsa")` (test schema).
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** `pnpm --filter @stubwise/server test -- departments people project-statuses projects route-access` → PASS.
- [ ] **Step 5:** Commit `feat(server): reparti, persone, stati e soglie del progetto`.

### Task 7: `/api/tasks` — letture

**Files:**
- Create: `apps/server/src/services/task-view.ts`, `apps/server/src/routes/tasks.ts`, `apps/server/src/routes/tasks.read.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: Task 1–5.
- Produces:
  - `loadTaskViews(tx, viewer, where): Promise<TaskView[]>` in `task-view.ts` (batch: stati, follower, link, allegati, ultimo job; UNA query per relazione, non per task).
  - `GET /api/tasks?<taskListQuerySchema>` (`user`) → `TaskView[]` dei progetti visibili (con la stessa regola `tickets.view_all` di `GET /api/tickets`), elenco intero (nessuna paginazione: il prototipo non ne ha; tetto 2000 righe con `truncated: true` nella risposta `{items, truncated}`).
  - `GET /api/tasks/by-code/:code` (`user`, 404 se invisibile) → `TaskView`.
  - `GET /api/tasks/stalled?<taskListQuerySchema>` (`user`) → `{task: TaskView, stall: Stall}[]`, calcolato con `stallOf` del Task 5 e `today` = data UTC del server; `claudeQuestionSince` = `created_at` della domanda `ask_user` aperta del job della task (stessa sorgente di `GET /api/tickets/:id/questions`); ordinato per `stall.since` crescente.
  - `GET /api/tasks/:ticketId/activity` (`project member`, `fromTicket`) → `TaskActivityEntryView[]` (commenti di oggi con risposte/modifica/eliminazione, `ticket_events` umani e di sistema come `field_change`, decisioni come `decision`).
  - `GET /api/tasks/:ticketId/work` → `TaskWorkView`: `claude` da ultimo job (`running|queued → working`, `awaiting_input → awaiting_answer`, `awaiting_plan_approval → awaiting_approval`, `held|failed → stopped`, `completed` con PR → `done`, nessun job → `none`), PR da `ticket_repositories`, `webHref = /tickets/<ticketId>`.
  - `TaskView.lastActivityAt = greatest(updated_at, ultimo commento, ultimo evento)`; `claude` come sopra; `type` via `uiTypeOf`; `size` via `sizeFromEffort`; `code = <projects.code>-<number>`.

- [ ] **Step 1: Test** `tasks.read.test.ts`:
  - `it("filtra per famiglia, reparto, assegnatario, taglia, testo")`.
  - `it("una task di un progetto non visibile per codice → 404 not_found")` e `it("non compare nell'elenco né nel conteggio")`.
  - `it("feedback si legge come feature, review come activity")`.
  - `it("stalled: manuale, decisione aperta, bloccata, senza assegnatario, inattiva da 8 giorni su active")` (cinque task, motivo atteso per ognuna; `vi.useFakeTimers` per la data).
  - `it("activity contiene commento, cambio di stato e decisione in ordine")`.
  - `it("work: awaiting_plan_approval → awaiting_approval con webHref")`.
  - `it("ogni risposta parsa con lo schema condiviso")` (`taskViewSchema.array().parse`).
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS + `route-access`.
- [ ] **Step 5:** Commit `feat(server): letture delle task nella forma del prototipo`.

### Task 8: `/api/tasks` — scritture

**Files:**
- Create: `apps/server/src/services/task-writes.ts`, `apps/server/src/routes/tasks.write.test.ts`
- Modify: `apps/server/src/routes/tasks.ts`

**Interfaces:**
- Produces:
  - `POST /api/tasks` (`project tickets.create`, `fromBody("projectId")`, body `newTaskBodySchema`) → `TaskView`: usa `createTicket` di `apps/server/src/db/tickets.ts` con `source: "manual"`, `requestedByUserId` = chi crea, `department_id` = quello del body o il primo reparto di chi crea (o il ripiego), `status_id` = quello del body o il primo `todo`; **non** chiama `maybeEnqueueBacklogIntake`; chi crea e l'assegnatario diventano follower; con `requestId` collega la voce di backlog come fa la conversione di oggi (`backlog_item_tickets`).
  - `PATCH /api/tasks/:ticketId` (`tickets.edit`, `onTicket`) body `taskPatchSchema` → `TaskView`; scrive gli eventi con `diffTicketEvents` (nessun `ticket_event_kind` nuovo: i cambi di reparto e di taglia in questa fetta non entrano nel feed, scelta annotata in `integration-slice1.md`; `statusId` produce lo `status_changed` di oggi); il tipo si scrive con `ticketTypeFor` solo se `uiTypeOf(attuale) !== patch.type`; un nuovo assegnatario diventa follower.
  - `PATCH /api/tasks/bulk` (body `{ids: uuid[] (≤200), patch: {statusId?, assigneeId?, milestoneId?, size?, departmentId?}}`) → `TaskView[]`; permesso `tickets.edit` verificato **per task** nel servizio, tutto o niente (403 `forbidden` con l'elenco dei codici rifiutati, nessuna scrittura). `statusId` nel bulk ammesso solo se tutte le task sono dello stesso progetto (400 `status_cross_project`). Registrata prima di `/:ticketId`.
  - `PUT /api/tasks/:ticketId/manual-stall` (`tickets.edit`, `{reason: string 1..200, note?: string ≤2000}`) e `DELETE` stessa rotta.
  - `PUT|DELETE /api/tasks/:ticketId/follow` (`project member` + `ticketVisible`): segue/smette per chi chiama.
  - Link e allegati: il client usa le rotte esistenti (`/api/tickets/:id/links`, `/api/tickets/:ticketId/attachments`, `/api/attachments/:id[/download]`); nessuna rotta nuova.

- [ ] **Step 1: Test** `tasks.write.test.ts`:
  - `it("una feature creata da /api/tasks su un progetto col backlog acceso NON va all'intake")` (nessuna riga in `backlog_jobs`).
  - `it("nasce nel primo reparto di chi crea e nel primo todo")`.
  - `it("Developer senza tickets.create → 403 e nessun ticket")`.
  - `it("PATCH statusId riscrive l'enum (via trigger) e scrive status_changed")`.
  - `it("PATCH type feature su un feedback non lo riscrive")`.
  - `it("bulk con una task non modificabile → 403 e nessuna task cambiata")`.
  - `it("manual-stall si imposta e si toglie, e compare in /stalled")`.
  - `it("follow e unfollow sono idempotenti")`.
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(server): scritture delle task dall'app nuova`.

### Task 9: Richieste di decisione e notifiche ai follower

**Files:**
- Create: `apps/server/src/services/{decisions.ts,task-notify.ts}`, `apps/server/src/routes/decisions.ts` + `decisions.test.ts`, `apps/server/src/services/task-notify.test.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/routes/tasks.ts`, `apps/server/src/services/comments.ts` (o la rotta dei commenti)

**Interfaces:**
- Produces:
  - `GET /api/decisions?taskId=&askedOfId=me&open=true` (`user`, solo decisioni di task visibili) → `DecisionRequestView[]`.
  - `POST /api/tasks/:ticketId/decisions` (`tickets.comment`, body `{askedOfId, question, options: string[] ≤8}`; `askedOfId` deve poter vedere la task, altrimenti 400 `decision_target_cannot_see`).
  - `POST /api/decisions/:id/answer` (solo `asked_of_user_id`; body `{optionIndex}` o `{text}`; 409 se già chiusa).
  - `POST /api/decisions/:id/withdraw` (solo `asked_by_user_id`; 409 se già chiusa).
  - `notifyTaskActivity(tx, {ticketId, actorUserId, change, summary})` in `task-notify.ts`: pubblica `ticket.activity` ai follower meno l'attore, chiamata dalle scritture **umane** del Task 8 (stato, assegnatario) e dalla creazione di un commento (`POST /api/tickets/:ticketId/comments`); mai dagli scrittori di sistema (pipeline, webhook, triage, intake).
  - Le pubblicazioni passano da `publishNotification` dentro la transazione della scrittura (non lancia mai: la scrittura non fallisce per una notifica).

- [ ] **Step 1: Test**: `it("chiedere pubblica decision.requested al destinatario")`, `it("rispondere pubblica decision.answered a chi ha chiesto e chiude la richiesta")`, `it("un terzo non può rispondere → 403 e richiesta aperta")`, `it("ritirare due volte → 409")`, `it("un commento notifica i follower tranne l'autore")`, `it("la pipeline che porta a in_review non notifica i follower")` (aggiorna `status` con `recordTicketStatusChange` e controlla zero notifiche `ticket.activity`).
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS (+ `notification-kinds`, `route-access`).
- [ ] **Step 5:** Commit `feat(server): richieste di decisione e notifiche ai follower`.

### Task 10: Gruppi nuovi di `@stubwise/api-client`

**Files:**
- Create: `packages/api-client/src/endpoints/{tasks,departments,people,projectStatuses,decisions}.ts`
- Modify: `packages/api-client/src/client.ts` (`createEndpoints`), `packages/api-client/src/index.ts`, `packages/api-client/src/client.test.ts`

**Interfaces:**
- Produces (tutti con schema, quindi `Reader<T>`): `tasks.list(q)`, `tasks.byCode(code)`, `tasks.stalled(q)`, `tasks.activity(id)`, `tasks.work(id)`, `tasks.create(body)`, `tasks.update(id, patch)`, `tasks.bulkUpdate(ids, patch)`, `tasks.setManualStall(id, body)`, `tasks.clearManualStall(id)`, `tasks.follow(id)`, `tasks.unfollow(id)`, `tasks.askDecision(id, body)`; `decisions.list(q)`, `decisions.answer(id, body)`, `decisions.withdraw(id)`; `departments.list()`, `.create`, `.update`, `.remove(id, moveTasksTo?)`; `people.list()`; `projectStatuses.list(projectId)`, `.set(projectId, body)`, `.setStallThresholds(projectId, body)`.

- [ ] **Step 1:** test in `client.test.ts` con `fetch` iniettato: path, metodo, query (array separati da virgola) e body per `tasks.list` con `{families:["todo"], sizes:["XS"]}`, `tasks.bulkUpdate`, `departments.remove(id, "x")`; `reader.test.ts` copre i gruppi da sé.
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** `pnpm --filter @stubwise/api-client test` → PASS.
- [ ] **Step 5:** Commit `feat(api-client): task, decisioni, reparti, persone e stati`.

### Task 11: Il punto di scambio del livello dati

**Files:**
- Create: `apps/desktop/vite.backend.ts`, `apps/desktop/src/renderer/data/backend/real/index.ts`, `apps/desktop/src/renderer/data/backend/real/stubs.generated.ts`, `apps/desktop/scripts/gen-backend-stubs.mjs`, `apps/desktop/src/renderer/data/backend/real/clock.ts`, `apps/desktop/src/renderer/data/backend/seam.test.ts`
- Modify: `apps/desktop/src/renderer/data/queries.ts` e `data/queries/*.ts` (`import * as api from "@backend/api"`), `apps/desktop/src/renderer/data/dates.ts` e `domain/{filters,weeks,stalled}.ts` (orologio da `@backend/clock`), `apps/desktop/src/renderer/data/viewer.ts`, `apps/desktop/electron.vite.config.ts`, `vite.web.config.ts`, `vitest.config.ts`, `tsconfig*.json`, `package.json`, `apps/desktop/src/renderer/data/architecture.test.ts`

**Interfaces:**
- Produces:
  - `backendAliases(mode: "prototype"|"app"): Alias[]` in `vite.backend.ts`: `@backend/api` → `src/renderer/data/api.ts` (prototype) o `src/renderer/data/backend/real/index.ts` (app); `@backend/clock` → `src/renderer/data/seed/dates.ts` o `…/real/clock.ts`. Il modo è `process.env.STUBWISE_BUILD` (default `prototype`); `vitest.config.ts` e `preview:web` usano sempre `prototype`. `tsconfig` `paths` puntano al finto (il tipo vero è quello).
  - `import.meta.env.VITE_STUBWISE_BUILD: "prototype"|"app"` definito da `define`.
  - `real/index.ts`: `export * from "./stubs.generated"` più le esportazioni implementate dai Task 16–17 (un'esportazione locale prevale sulla stella); ogni esportazione tipata `typeof import("../../api").<nome>` con `import type`.
  - `stubs.generated.ts`: per ogni nome esportato da `data/api.ts` una costante `notIntegrated("<nome>")` (una funzione che rifiuta con `NotIntegratedError`; per i namespace `chat`, `docs`, `admin`, `auth`, `releases`… un `Proxy` che fa lo stesso per ogni chiave). Lo genera `node apps/desktop/scripts/gen-backend-stubs.mjs` (legge i nomi con l'API del compilatore TypeScript); script `gen:stubs` in `package.json`.
  - `real/clock.ts`: `TODAY` (data locale di oggi, ISO), `CLOCK_START`, `daysFromToday`, `isoWeek` con le firme di `seed/dates.ts`.
  - `api.getViewer(): Promise<Viewer>` e `api.getSessionPerson(): Promise<string|null>` aggiunte al finto (`viewerFor(getSessionPersonId())`) e usate da `ViewerProvider` tramite una query `["viewer", personId]`; il «vedi come» resta solo con `VITE_STUBWISE_BUILD === "prototype"`.

- [ ] **Step 1: Test** `seam.test.ts`: `it("gli stub coprono ogni esportazione del finto")` (`Object.keys` dei due moduli, con lo stub importato direttamente), `it("uno stub rifiuta con NotIntegratedError")`. Aggiorna `architecture.test.ts`: `it("nessun file fuori da data/ importa data/api o data/seed")` resta; nuovo `it("queries importa l'api solo da @backend/api")`.
- [ ] **Step 2:** FAIL. **Step 3:** implementa; nessuna pagina cambia.
- [ ] **Step 4:** `pnpm --filter @stubwise/desktop typecheck && pnpm --filter @stubwise/desktop test` → PASS, gli ~6700 test del prototipo verdi; `pnpm --filter @stubwise/desktop dev` apre il prototipo come prima.
- [ ] **Step 5:** Commit `refactor(desktop): punto di scambio fra dati finti e server vero`.

### Task 12: «In arrivo» per le aree non integrate

**Files:**
- Create: `apps/desktop/src/renderer/data/integration.ts` + `integration.test.ts`, `apps/desktop/src/renderer/pages/ComingSoon.test.tsx`
- Modify: `apps/desktop/src/renderer/router.tsx` (`pageOf`, `ProjectSectionPage`, `ProjectSettingsRoutePage`, `AdminSectionPage`, `projectIndexRoute`), `apps/desktop/src/renderer/pages/Placeholder.tsx`, `layout/Rail.tsx`, `layout/ProjectColumn.tsx`, `layout/ProjectTile.tsx`, `layout/ProjectAlerts.tsx`, `palette/CommandPalette.tsx`, `palette/commands.ts`, `pages/tasks/TasksPage.tsx` (vista Timeline), `pages/task/*` (sezioni di aree future), i18n `en`/`it`

**Interfaces:**
- Produces: `isIntegrated(target: IntegrationTarget): boolean` con `IntegrationTarget = {kind: "destination", name} | {kind: "projectSection", name} | {kind: "projectSettings", name} | {kind: "admin", name} | {kind: "taskView", name} | {kind: "feature", name}`. In `prototype` sempre `true`. In `app` `true` solo per: destinazione `projects` (colonna), sezione di progetto `tasks`, impostazioni `statuses` (stati e soglie), admin `departments`, viste `list` e `board`, feature `notifications`, `search`, `task-detail`, `new-task`. `projectIndexRoute` reindirizza a `tasks` quando `overview` non è integrata. Chiavi `placeholder.comingSoon.title` («Coming soon» / «In arrivo») e `placeholder.comingSoon.body`.
- Gli hook di aree future letti dalla shell (`useChatSignal`, `useChatChannels`, `useMailProposalDecisions`, `useMyAutomationApprovals`, `useOpenPrs`, `useReleases`, `useProjectServers`, `useDocSpaces`, `useQueuePause`, `useAlertSubscriptions`) ricevono `enabled: isIntegrated(...)`; i componenti trattano `undefined` come vuoto. Nel dettaglio della task: «Assegna a Claude», sessione dal vivo e azioni dell'area 3 nascoste in `app`; i selettori di assegnatario escludono Claude in `app`.

- [ ] **Step 1: Test** `integration.test.ts` (in `prototype` tutto vero; con `vi.stubEnv("VITE_STUBWISE_BUILD","app")` vero solo per l'elenco sopra) e `ComingSoon.test.tsx` (con `app`: aprire `chat` mostra «Coming soon» e nessuna chiamata all'api; aprire un progetto atterra su Tasks; il rail non chiama `useChatSignal`).
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** test del desktop interi → PASS.
- [ ] **Step 5:** Commit `feat(desktop): aree non integrate «in arrivo» nelle build app`.

### Task 13: Electron vero — istanza, login, token, proxy delle richieste

**Files:**
- Create: `apps/desktop/src/main/{instance.ts,session.ts,apiProxy.ts}` + `.test.ts`
- Modify: `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/security.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/env.d.ts`

**Interfaces:**
- Produces:
  - `instance.ts`: `readInstanceUrl(): string|null`, `writeInstanceUrl(url: string): void` (file `instance.json` in `app.getPath("userData")`; solo `https:` o `http://localhost`; normalizzato senza slash finale).
  - `session.ts`: `saveToken(token: string)`, `readToken(): string|null`, `clearToken()` con `safeStorage.encryptString`/`decryptString` su `session.bin` in userData (`safeStorage.isEncryptionAvailable()` falso → nessun salvataggio, l'utente rifà il login a ogni avvio).
  - `apiProxy.ts`: `handleApiRequest(req: ApiProxyRequest): Promise<ApiProxyResponse>` con `ApiProxyRequest = {method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE", path: string, headers?: Record<string,string>, body?: string|ArrayBuffer}` e `ApiProxyResponse = {status, headers: Record<string,string>, body: string|ArrayBuffer}`; rifiuta un `path` che non inizi con `/api/` o che contenga `..`/`//`/schema; aggiunge `Authorization: Bearer <token>`; un 401 cancella il token.
  - IPC (registrati in `index.ts`, mittente verificato come per `file:save`): `api:request`, `instance:get`, `instance:set`, `session:login` (`{email, password, code?}` → chiama `POST /api/auth/mobile-login` con `deviceName = "Desktop · <hostname>"`, salva il token, restituisce `{ok: true, user}` o `{ok: false, code}` senza mai il token), `session:logout` (revoca il PAT con la rotta esistente e cancella), `session:status`, `open:web` (`path` relativo → `shell.openExternal(instanceUrl + path)`).
  - Preload: `window.stubwise.api.request(req)`, `window.stubwise.instance.{get,set}`, `window.stubwise.session.{login,logout,status}`, `window.stubwise.openWeb(path)`; tipi in `env.d.ts`. La CSP resta `connect-src 'self'` (il renderer non fa rete).
- [ ] **Step 1: Test** (Vitest su `node`, `electron` mockato): `apiProxy.test.ts` (`it("rifiuta /webhooks e ../")`, `it("aggiunge il bearer")`, `it("un 401 cancella il token")`), `session.test.ts` (`it("senza cifratura disponibile non scrive su disco")`), `instance.test.ts` (`it("rifiuta http su host remoto")`), `security.test.ts` esistente invariato.
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS; `pnpm --filter @stubwise/desktop dev` col prototipo invariato.
- [ ] **Step 5:** Commit `feat(desktop): istanza, login col secondo fattore e proxy delle richieste`.

### Task 14: Build web su `/app` e caddy

**Files:**
- Create: `apps/desktop/vite.app-web.config.ts`, `apps/desktop/scripts/check-no-seed.mjs`
- Modify: `apps/desktop/package.json` (`build:web`: `STUBWISE_BUILD=app vite build --config vite.app-web.config.ts`, output `dist-web/`; `build` resta `electron-vite build` del prototipo e aggiunge `build:app` con `STUBWISE_BUILD=app`), `Caddyfile`, `Dockerfile.caddy`, `.github/workflows/ci.yml` (job «Lint e typecheck»: `pnpm --filter @stubwise/desktop build:web && node apps/desktop/scripts/check-no-seed.mjs apps/desktop/dist-web`)

**Interfaces:**
- Produces: bundle `apps/desktop/dist-web` con `base: "/app/"` e CSP `<meta>` con `connect-src 'self'`; `check-no-seed.mjs <dir>` esce con 1 se trova nel bundle una delle stringhe `Giulia Ferri`, `Laura Costa`, `p-giulia` (nomi del seed).
- Caddy: `redir /app /app/ 308` e `handle_path /app/* { root * /srv/app; try_files {path} /index.html; file_server }` **prima** del `handle` finale; `Dockerfile.caddy`: manifest `apps/desktop/package.json` nel layer dei manifest, `ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1` prima dell'install, `COPY apps/desktop`, `pnpm --filter @stubwise/desktop... build:web` (dopo il build delle dipendenze), `COPY --from=web-build /repo/apps/desktop/dist-web /srv/app`.
- In `app` sul web il client è `createStubwiseClient({ baseUrl: "", credentials: "include", getAuthHeader: () => null })`; sul desktop `createStubwiseClient({ baseUrl: "", fetch: ipcFetch, getAuthHeader: () => null })` dove `ipcFetch(input, init): Promise<Response>` (in `data/backend/real/transport.ts`, creato qui) passa da `window.stubwise.api.request` e costruisce una `Response`. La scelta fra i due: `window.stubwise?.api` presente.

- [ ] **Step 1:** `check-no-seed.mjs` su un dir con un file che contiene `Giulia Ferri` → exit 1; senza → 0 (test in `apps/desktop/scripts/check-no-seed.test.mjs` girato da vitest).
- [ ] **Step 2:** `pnpm --filter @stubwise/desktop build:web && node apps/desktop/scripts/check-no-seed.mjs apps/desktop/dist-web` → exit 0; `grep -c '/app/assets/' apps/desktop/dist-web/index.html` ≥ 1.
- [ ] **Step 3:** `docker build -f Dockerfile.caddy -t stubwise-caddy-test .` riesce; `docker run --rm stubwise-caddy-test ls /srv/app/index.html` esiste (poi ferma e rimuovi l'immagine; regola «Docker solo per i test»).
- [ ] **Step 4:** Commit `build: SPA dell'app nuova su /app servita da caddy`.

### Task 15: Pacchetto locale non firmato del desktop

**Files:**
- Create: `apps/desktop/electron-builder.yml`
- Modify: `apps/desktop/package.json` (devDependency `electron-builder`; script `package:mac`: `STUBWISE_BUILD=app electron-vite build && electron-builder --mac dmg --config electron-builder.yml`), `.gitignore` (`apps/desktop/release/`)

**Interfaces:**
- Produces: `apps/desktop/release/Stubwise-<versione>.dmg`; `mac.identity: null`, `appId: dev.aleloca.stubwise`, `productName: Stubwise`, nessun `publish`.
- [ ] **Step 1:** `pnpm --filter @stubwise/desktop package:mac` → dmg creato; `node apps/desktop/scripts/check-no-seed.mjs apps/desktop/out/renderer` → exit 0.
- [ ] **Step 2:** Commit `build(desktop): dmg locale non firmato`.

### Task 16: Implementazione vera — sessione, persone, progetti, notifiche, ricerca

**Files:**
- Create: `apps/desktop/src/renderer/data/backend/real/{client.ts,session.ts,people.ts,projects.ts,notifications.ts,search.ts,departments.ts}` + `.test.ts`
- Modify: `apps/desktop/src/renderer/data/backend/real/index.ts`, `apps/desktop/src/renderer/data/queries/entry.ts` (se servono rami per build), pagine `pages/entry/*` solo dove il prototipo non ha il passo «indirizzo dell'istanza» (desktop) — vedi `.impeccable/shape/entry.md`; se manca, il passo usa i componenti dell'ingresso esistenti e si annota in `integration-slice1.md`.

**Interfaces:**
- Consumes: Task 10, 11, 13, 14.
- Produces (esportazioni con i nomi e i tipi di `data/api.ts`): `getViewer` (da `/api/auth/me`: `instancePermissions`, `projectPermissions`, `departmentPermissions: {}`), `getSessionPerson`, `auth.readEntry`/`auth.login`/`auth.logout` (web: `/api/auth/login` + secondo fattore; desktop: `window.stubwise.session.*`), `listPeople`, `listDepartments`, `listProjects` (da `/api/projects` + `code` + `stallThresholds`; `template: "software"`, `modules` vuoti, `signals` neutri), `getProjectByCode`, `listPinnedProjectIds`/`setPinned` (su `/api/me/follows`), `listWaitingOnMeProjectIds` (progetti con decisioni aperte rivolte a me: `/api/decisions?askedOfId=me&open=true`), `listNotifications`/`markNotification` (da `/api/inbox` e `/:id/read|snooze|handled`), `search` (`/api/search`, solo task e progetti), `admin.listDepartments`/`createDepartment`/`updateDepartment`/`saveDepartment`/`deleteDepartment`.
  - `presentInboxItem(item, ctx): AppNotification` in `notifications.ts`: kind integrati (`decision.*`, `ticket.activity`) → `link` = `#/p/<code>/tasks?task=<CODE>`; ogni altro kind (anche sconosciuto) → titolo e corpo dell'item, `link: null`, `linkAccessHref: webHrefFor(item)` (pagina del web vecchio; desktop: `window.stubwise.openWeb`, web: `location.assign`). «Apri nel web» è l'azione mostrata.
  - Cambio di sessione: `queryClient.clear()` prima di montare la nuova persona; un `ApiError` 401 → `auth.readEntry` torna `login`.
- [ ] **Step 1: Test** con client finto (`fetch` iniettato) e fixture parsate dagli schemi condivisi: `it("una card di un kind sconosciuto ha Apri nel web e non rompe")`, `it("decision.requested apre il pannello della task")`, `it("un 401 a metà porta al login e svuota la cache")`, `it("i permessi del viewer vengono dal server, non dedotti")`, `it("listPeople usa display_name o la parte locale dell'email")`.
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** `pnpm --filter @stubwise/desktop test -- backend/real` → PASS.
- [ ] **Step 5:** Commit `feat(desktop): sessione, persone, progetti e notifiche dal server`.

### Task 17: Implementazione vera — Tasks, dettaglio, nuova task, stati

**Files:**
- Create: `apps/desktop/src/renderer/data/backend/real/{tasks.ts,taskDetail.ts,statuses.ts,attachments.ts}` + `.test.ts`
- Modify: `apps/desktop/src/renderer/data/backend/real/index.ts`, `apps/desktop/src/renderer/pages/task/LinksSection.tsx` e `StallControl.tsx`, `TaskHeader.tsx` (solo dove oggi passano da `updateTask` con `followerIds`/`manualStall`/`attachments`/`links`: chiamano mutazioni dedicate già presenti o nuove nel finto — `followTask`, `setManualStall`, `clearManualStall`, `addAttachment`, `removeAttachment`, `addLink`, `removeLink` — implementate nel finto sopra `updateTask` così il prototipo resta identico)

**Interfaces:**
- Produces (nomi di `data/api.ts`): `listTasks`, `listStalled`, `getTaskByCode`, `listActivity`, `addComment`/`editComment`/`deleteComment` (rotte commenti di oggi), `listDecisionRequests`/`askDecision`/`answerDecision`/`withdrawDecision`, `updateTask`, `bulkUpdateTasks`, `createTask`, `followTask`, `setManualStall`, `clearManualStall`, `addAttachment` (multipart sulle rotte di oggi; un `400 storage_not_configured` diventa il messaggio «Attachments are off on this instance» / «Gli allegati sono spenti su questa istanza»), `removeAttachment`, `addLink`/`removeLink` (`relates` ↔ `relates_to`), `getTaskWork` (la sezione Claude mostra lo stato e «Open in web» con `webHref`), `listProjectStatuses`, `setProjectStatuses`, `setStallThresholds`, `listMilestones` (sola lettura, `/api/milestones?projectId`), `getRequest` (sola lettura, la rotta di dettaglio della voce di backlog esistente in `apps/server/src/routes/backlog.ts`).
  - `toTask(view: TaskView): Task` in `tasks.ts` (mappa 1:1; `plannedWeek: null`, `slipCount: 0`).
- [ ] **Step 1: Test** con client finto: `it("listTasks passa i criteri come query")`, `it("updateTask con followerIds non esiste più nelle pagine")` (grep nel test di architettura: nessuna pagina passa `followerIds|manualStall|attachments|links` a `updateTask`), `it("allegati spenti mostrano il messaggio")`, `it("una task invisibile dà il pannello not found")`, `it("relates diventa relates_to e ritorno")`.
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** `pnpm --filter @stubwise/desktop test` (tutto) → PASS.
- [ ] **Step 5:** Commit `feat(desktop): Tasks, dettaglio, nuova task e stati dal server`.

### Task 18: Documentazione, parità, deploy

**Files:**
- Create: `apps/desktop/docs/integration-slice1.md`
- Modify: `docs/operations/deploy-log.md`, `CLAUDE.md` (sezione `apps/desktop` e «Architettura runtime»: `/app`, le tre build, `@backend/*`), `apps/desktop/README.md` (avvio delle build app, `package:mac`), `apps/docs` solo se una pagina della guida parla di stati/sforzo (no: annotato come seguito)

- [ ] **Step 1:** `integration-slice1.md`: una riga per ogni voce di `apps/desktop/docs/area2-parity.md` che entra in questa fetta — dove vive, quale rotta, quale test — e le voci rimandate con la fetta che le prende; più le scelte fatte qui (nessun evento per reparto/taglia, `truncated` a 2000 righe, Claude non assegnabile).
- [ ] **Step 2:** voce deploy-log «Integrazione area 2, fetta 1 (gg mmm 2026)» nella forma delle voci esistenti: migrazioni **0107–0110**; **backup**; ORDINE (1) backup (2) `server` (applica le migrazioni; verifica `select count(*) from tickets where status_id is null` = 0 e `select code from projects`) (3) `worker` (nessun cambio di codice, ma conferma che i job girano: la pipeline scrive l'enum e il trigger muove lo stato) (4) `caddy` (`/app`); verifica bundle `docker exec stubwise-caddy-1 sh -c 'ls /srv/app/index.html'`; **Rollback**: le migrazioni sono additive ma i tre `notification_kind` nuovi rendono NON sicuro scendere d'immagine sul server finché ne esistono righe (`delete from notifications where kind in ('decision.requested','decision.answered','ticket.activity')` prima); il trigger resta e non disturba un server vecchio (che non scrive `status_id`; l'INSERT lo valorizza da solo); caddy scende insieme al server.
- [ ] **Step 3:** `pnpm lint && pnpm typecheck && pnpm test` dalla radice → verdi.
- [ ] **Step 4:** Prova a mano del maintainer: desktop (`package:mac`, istanza di produzione) e browser (`/app`) — login col secondo fattore, elenco e board, trascinamento, dettaglio, nuova task, ferma, decisione chiesta e risposta da due account, allegato, Segui, stati del progetto, reparti; web vecchio e app mobile ancora corretti sullo stesso ticket.
- [ ] **Step 5:** Commit `docs: integrazione area 2 fetta 1 (parità, deploy, invarianti)`.
