# App desktop, area 2: il nucleo delle task — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Costruire nel prototipo `apps/desktop` l'area 2 completa — livello
dati consapevole di chi guarda, Home a blocchi con la mia settimana, Tasks
(elenco, board, timeline, dettaglio), filtri salvati, Planning, Requests,
Overview, Tutti i progetti, stati per progetto — con dati finti.

**Architecture:** Il modello dati cresce in `src/renderer/data/` (tipi, seed,
api finta con sessione per persona) e la logica pura (settimane, ferme,
carico, filtri, Home) vive in un nuovo `src/renderer/domain/`, testata a
parte. Le pagine stanno in `src/renderer/pages/<area>/`, costruite su un
piccolo kit comune (`src/renderer/tasks-ui/`). Ogni pagina legge solo via
hook di `data/queries.ts`, mai il seed.

**Tech Stack:** quello dell'ossatura (Electron + electron-vite, React 19,
TanStack Router/Query, Tailwind v4 sui token, i18next, Vitest + happy-dom +
Testing Library). Nessuna dipendenza nuova salvo `@dnd-kit/core` +
`@dnd-kit/sortable` per board e planning (trascinamento con mouse **e
tastiera**), versione stabile corrente.

**Spec:** `docs/plans/2026-10-23-desktop-area2-task-design.md` (approvato).
Contesto: `docs/plans/2026-10-23-desktop-ossatura-design.md`,
`apps/desktop/DESIGN.md`, `apps/desktop/docs/ossatura-follow-ups.md`,
`apps/desktop/docs/web-inventory.md`.

## Global Constraints

- Tutte le regole dell'ossatura restano: nessuna rete, dati solo da `src/renderer/data/`; inglese di default e italiano (parità di chiavi verificata da `i18n/parity.test.ts`); temi chiaro e scuro completi; niente monospace salvo il logo; codice sempre affiancato dal nome; il colore mai unico segnale; movimento 150–250 ms con `prefers-reduced-motion`; testo funzionale ≥ 11 px.
- `pnpm lint`, `pnpm --filter @stubwise/desktop typecheck` e `pnpm --filter @stubwise/desktop test` verdi a ogni commit. Lockfile solo via pnpm.
- Le pagine non importano MAI da `data/seed/*`: solo da `data/queries.ts` (hook) e `data/types.ts`. Un test di architettura lo verifica (Task 2).
- Stati di ogni pagina: caricamento (scheletri della forma vera), vuoto (con l'azione se il permesso c'è, altrimenti la frase su chi può), errore con «Riprova» (simulabile con `failNext`), pieno, e la versione senza permessi.
- Azioni ottimistiche (board, planning, Home, stato/assegnatario in elenco) tornano indietro su errore con un messaggio che lo dice.
- Taglie: `XS S M L XL`, pesi 1 2 3 5 8; il peso non compare mai come numero nella UI.
- Famiglie di stato: `todo`, `active`, `closed`. Aperta = non `closed`.
- Ferme: soglie di default 7 giorni (`active`) e 14 (`todo` già slittate), impostazioni del progetto.
- Permessi: si leggono con `can(viewer, perm, projectId)`; i permessi locali del prototipo sono `planning.others` (progetto) e `department.home.manage` (reparto).
- «Oggi» del prototipo resta `TODAY = "2026-10-23"` (settimana `2026-W43`); nessuna logica legge l'orologio.
- Lo stile segue `apps/desktop/DESIGN.md`; la striscia del reparto compare solo sulle righe/carte che sono task.

## Review Focus

1. **Cambio di persona con un pannello aperto o un filtro aperto**: nessun dato della persona precedente resta a schermo; una task non più visibile mostra «non trovata o non visibile», non i dati vecchi. → test in Task 2 e Task 7.
2. **Filtro pubblico di un autore con più visibilità**: chi lo apre vede solo le task che può vedere, e i conteggi (titolo, blocco Home) sono quelli suoi, non dell'autore. → test in Task 3 e Task 8.
3. **Settimane a cavallo d'anno**: il 2026 ha 53 settimane ISO; slittamento e «prossima settimana» da `2026-W53` vanno a `2027-W01`, e l'ordinamento fra settimane è cronologico, non alfabetico. → test in Task 1 (`weeks.test.ts`).
4. **Task senza stima nel carico**: mai contate come zero in silenzio; ogni barra di carico dichiara «+N senza stima» e l'avanzamento dei traguardi lo dice. → test in Task 1 (`load.test.ts`) e Task 10.
5. **Etichette lunghe e italiano** in colonne della board (stati come «In approvazione», nomi progetto lunghi), blocchi della Home e righe del planning: si troncano con ellissi e il testo intero resta leggibile (tooltip o `title`). → test in Task 6 e Task 10.

---

### Task 1: Modello dati e logica pura del dominio

**Files:**
- Create: `apps/desktop/src/renderer/data/model.ts` (i tipi nuovi; `types.ts` resta com'è fino al Task 2)
- Create: `apps/desktop/src/renderer/domain/weeks.ts`, `domain/stalled.ts`, `domain/load.ts`, `domain/filters.ts`, `domain/templates.ts`
- Test: `apps/desktop/src/renderer/domain/weeks.test.ts`, `stalled.test.ts`, `load.test.ts`, `filters.test.ts`, `templates.test.ts`

(percorsi relativi a `apps/desktop/src/renderer/`, qui e in seguito)

**Interfaces:**
- Produces in `data/model.ts` (i moduli di `domain/` importano da qui; nel Task 2 `types.ts` diventa `export * from "./model"` più i tipi dell'ossatura che restano, e il `Task`/`TaskStatus` di oggi spariscono; `Project.signals.waitingOnViewer` sparisce — si deriva in Task 2):

```ts
export type StatusFamily = "todo" | "active" | "closed";
export interface ProjectStatus { id: string; projectId: string; name: string; family: StatusFamily; order: number }
export type TaskSize = "XS" | "S" | "M" | "L" | "XL";
export type TaskType = "bug" | "feature" | "activity";
export type TaskPriority = TicketPriority; // da @stubwise/shared
export type ClaudeWorkState = "none" | "working" | "awaiting_answer" | "awaiting_approval" | "stopped" | "done";
export type TaskLinkKind = "blocks" | "blocked_by" | "relates" | "parent" | "child";
export interface ManualStall { reason: string; note: string; since: string; byId: string }
export interface Task {
  id: string; code: string; projectId: string; title: string; description: string;
  statusId: string; departmentId: string; assigneeId: string | null; createdById: string;
  followerIds: string[]; size: TaskSize | null; dueDate: string | null;
  plannedWeek: string | null; slipCount: number; milestoneId: string | null;
  labels: string[]; type: TaskType; priority: TaskPriority; requestId: string | null;
  links: { kind: TaskLinkKind; taskId: string }[];
  attachments: { id: string; name: string; sizeBytes: number }[];
  manualStall: ManualStall | null; claude: ClaudeWorkState;
  createdAt: string; closedAt: string | null; lastActivityAt: string;
}
export interface Milestone { id: string; projectId: string; name: string; description: string; dueDate: string | null; closed: boolean }
export interface ActivityEntry {
  id: string; taskId: string; kind: "comment" | "field_change" | "decision";
  authorId: string | null; at: string; body?: string; replyToId?: string;
  editedAt?: string; deletedAt?: string; deletedById?: string;
  field?: string; from?: string | null; to?: string | null; decisionRequestId?: string;
}
export interface DecisionRequest {
  id: string; taskId: string; askedById: string; askedOfId: string; question: string;
  options: string[]; createdAt: string; withdrawnAt: string | null;
  answer: { optionIndex: number | null; text: string | null; at: string; byId: string } | null;
}
export type RequestStatus = "new" | "refining" | "ready" | "converted" | "archived";
export interface ProjectRequest {
  id: string; projectId: string; title: string; description: string; requesterIds: string[];
  status: RequestStatus; urgency: "low" | "medium" | "high"; similarToId: string | null;
  mergedIntoId: string | null; taskIds: string[]; createdAt: string;
}
export type PeriodField = "created" | "closed" | "plannedWeek" | "due";
export type RelativePeriod = "last7" | "last30" | "thisWeek" | "nextWeek" | "thisMonth" | "lastMonth";
export interface FilterCriteria {
  projectIds?: string[]; departmentIds?: string[]; assigneeIds?: (string | "none")[];
  families?: StatusFamily[]; statusIds?: string[]; sizes?: (TaskSize | "none")[];
  milestoneIds?: string[]; stalled?: boolean; text?: string;
  period?: { field: PeriodField } & ({ kind: "relative"; preset: RelativePeriod } | { kind: "absolute"; from: string; to: string });
}
export type TaskView = "list" | "board" | "timeline";
export type GroupBy = "none" | "status" | "assignee" | "department" | "milestone" | "week";
export interface SavedFilter { id: string; name: string; ownerId: string; visibility: "private" | "public"; criteria: FilterCriteria; view: TaskView; groupBy: GroupBy }
export type HomeBlockKind = "decide" | "myWeek" | "myTasks" | "claudeForMe" | "stalledInMyProjects" | "newRequests" | "upcomingMilestones" | "filter";
export interface HomeBlockRef { kind: HomeBlockKind; filterId?: string }
export interface DepartmentHome { departmentId: string; blocks: HomeBlockRef[]; updatedAt: string }
export interface PersonalHome { personId: string; blocks: HomeBlockRef[]; seenDepartmentUpdates: Record<string, string> }
export type DepartmentPermission = "department.home.manage";
export interface DepartmentRole { personId: string; departmentId: string; permissions: DepartmentPermission[] }
export interface DayArrangement { personId: string; taskId: string; week: string; day: 1 | 2 | 3 | 4 | 5 | null }
```

  `model.ts` ridichiara anche `Project` con `stallThresholds: { activeDays: number; todoDays: number }` e `signals: { claudeWorking: boolean }` (gli altri campi come oggi), e `AppNotification` con `recipientIds: string[]`.
- Produces in `domain/`:
  - `weeks.ts`: `currentWeek(): string` (= `isoWeek(TODAY)`), `addWeeks(week: string, n: number): string`, `compareWeeks(a, b): number`, `weekDays(week): string[]` (lun–ven ISO), `weekLabel(week, locale): string` («27 ott – 31 ott»).
  - `stalled.ts`: `type StallReason = { kind: "manual"; reason: string; note: string } | { kind: "decision"; personId: string } | { kind: "claude_question" } | { kind: "blocked_by"; taskId: string } | { kind: "unassigned" } | { kind: "idle" }`; `interface Stall { reason: StallReason; since: string; days: number }`; `stallOf(task: Task, ctx: StallContext): Stall | null` con `StallContext = { family: StatusFamily; openDecisions: DecisionRequest[]; tasksById: Map<string, Task>; familyOf(task: Task): StatusFamily; thresholds: Project["stallThresholds"] }`.
  - `load.ts`: `SIZE_WEIGHT: Record<TaskSize, number>` = `{ XS: 1, S: 2, M: 3, L: 5, XL: 8 }`; `load(tasks: Task[]): { weight: number; count: number; unsized: number }`; `progress(tasks: Task[], familyOf): { doneWeight: number; totalWeight: number; unsized: number }`.
  - `filters.ts`: `matches(task: Task, c: FilterCriteria, ctx: FilterContext): boolean` con `FilterContext = { familyOf(task): StatusFamily; isStalled(task): boolean; projectName(id): string }`; `periodRange(p, today = TODAY): { from: string; to: string }`; `canUseStatusIds(c: FilterCriteria): boolean` (vero solo con esattamente un `projectIds`).
  - `templates.ts`: `TEMPLATE_STATUSES: Record<ProjectTemplate, { name: string; family: StatusFamily }[]>` e `TEMPLATE_MODULES: Record<ProjectTemplate, ProjectModule[]>` con i valori della tabella «Modelli di progetto» dello spec (Software: docs, releases, support, servers; Marketing: nessuno; Commessa cliente: docs; Vuoto: nessuno). I nomi degli stati sono dati inglesi del seed (`To do`, `In progress`, `In review`, `Done`, `Dropped`; `Idea`, `Draft`, `In approval`, `Published`, `Dropped`; `To do`, `In progress`, `Waiting on client`, `Delivered`, `Dropped`; `To do`, `In progress`, `Done`).

- [ ] **Step 1: Test che falliscono.**
  - `weeks.test.ts`: `addWeeks("2026-W43", 1) === "2026-W44"`; `addWeeks("2026-W53", 1) === "2027-W01"`; `addWeeks("2027-W01", -1) === "2026-W53"`; `compareWeeks("2026-W53", "2027-W01") < 0`; `["2027-W01","2026-W09","2026-W10"].sort(compareWeeks)` → `["2026-W09","2026-W10","2027-W01"]`; `weekDays("2026-W43")[0] === "2026-10-19"`.
  - `stalled.test.ts`: precedenza `manual` > `decision` > `claude_question` (`claude === "awaiting_answer"`) > `blocked_by` (solo se la bloccante è aperta) > `unassigned` (solo per task `active` o con `plannedWeek` ≤ settimana corrente) > `idle`; `idle` per `active` con `lastActivityAt` più vecchio di `activeDays`, per `todo` solo se `slipCount ≥ 1` e più vecchio di `todoDays`; una task `closed` non è mai ferma; `since` = inizio della causa (data della richiesta di decisione, `manualStall.since`, `lastActivityAt` per idle) e `days` contati da `TODAY`; una decisione ritirata o risposta non ferma.
  - `load.test.ts`: `load([M, L, null, null])` → `{ weight: 8, count: 4, unsized: 2 }`; `load([])` → zeri.
  - `filters.test.ts`: ogni criterio da solo e in combinazione (AND fra criteri, OR dentro un elenco); `assigneeIds: ["none"]` prende le non assegnate; `sizes: ["none"]` le senza stima; `periodRange({field:"closed",kind:"relative",preset:"thisMonth"})` → `2026-10-01…2026-10-31`; `last7` → `2026-10-17…2026-10-23`; `canUseStatusIds` falso con 0 o 2 progetti; testo case-insensitive su codice e titolo.
  - `templates.test.ts`: ogni modello ha almeno uno stato per famiglia e il primo `todo` viene prima di ogni `active`.
- [ ] **Step 2:** `pnpm --filter @stubwise/desktop test -- domain` → FAIL.
- [ ] **Step 3:** Implementa i tipi e i moduli. Nessun modulo di `domain/` importa React o `data/api`.
- [ ] **Step 4:** test, typecheck, lint → verdi (il codice esistente non usa ancora `model.ts`).
- [ ] **Step 5: Commit** — `feat(desktop): modello dati e logica pura dell'area 2`.

### Task 2: Seed nuovo e livello dati consapevole di chi guarda

**Files:**
- Modify: `data/types.ts` (diventa `export * from "./model"` + i tipi dell'ossatura non ridichiarati), `data/seed/*.ts` (tasks, projects, notifications), `data/api.ts`, `data/queries.ts`, `data/viewer.ts`, `data/seed.test.ts`, `data/api.test.ts`, `data/viewer.test.ts`
- Create: `data/seed/statuses.ts`, `seed/milestones.ts`, `seed/requests.ts`, `seed/decisions.ts`, `seed/activity.ts`, `seed/filters.ts`, `seed/homes.ts`, `seed/departmentRoles.ts`
- Create: `data/session.ts`, `data/architecture.test.ts`
- Modify: `layout/DeptStrip.tsx`, `layout/ProfileMenu.tsx`, `layout/Rail.tsx`, `layout/ProjectTile.tsx`, `palette/*`, `notifications/*` (solo per leggere via hook) e i loro test

**Interfaces:**
- Consumes: Task 1 (tipi, `templates.ts`, `stalled.ts`).
- Produces:
  - `data/session.ts`: `getSessionPersonId(): string`, `setSessionPersonId(id: string): void`. `ViewerProvider` chiama `setSessionPersonId` **prima** del render dei figli quando cambia persona (sincrono, nello stesso aggiornamento).
  - Ogni chiave di `queryKeys` inizia con `["as", personId, …]`; hook `useSessionPersonId()`. Cambiare persona non lascia dati vecchi: le query della persona precedente non vengono mostrate (chiave diversa, nessun `placeholderData` fra persone).
  - Visibilità in `api.ts`: `visibleProjectIds(personId): Set<string>` (membri, o tutti per full admin). Ogni funzione che restituisce progetti, task, richieste, notifiche, risultati di ricerca filtra per visibilità **prima** di contare/paginare. `getProjectByCode` di un progetto invisibile → `null` (come inesistente).
  - Letture (oltre a quelle esistenti): `listProjectStatuses(projectId)`, `listMilestones(projectId?)`, `listTasks(criteria?: FilterCriteria)`, `getTaskByCode(code): Task | null`, `listActivity(taskId)`, `listDecisionRequests({ taskId?, askedOfId?, open? })`, `listRequests(projectId)`, `getRequest(id)`, `listSavedFilters()` (i miei + i pubblici), `getSavedFilter(id)` (null se privato di altri), `getHome()` (blocchi risolti per la persona, vedi Task 9), `listDepartmentHomes()`, `listDepartmentRoles(personId?)`, `listDayArrangements(week)`, `listStalled(criteria?)` → `{ task: Task; stall: Stall }[]`, `projectPulse(projectId)` (Task 11 lo usa), `listTimeline(projectId)`.
  - Pinned per persona: `pinned: Map<personId, string[]>`; i fissati iniziali di Giulia restano `GIULIA_PINNED_CODES`, gli altri personaggi hanno i propri (6–12 codici fra i loro progetti).
  - Notifiche per destinatario: ogni `AppNotification` ha `recipientIds: string[]`; `listNotifications` restituisce solo quelle della persona.
  - `Project.signals` non ha più `waitingOnViewer`: hook `useWaitingOnMe(): Set<projectId>` derivato da decisioni aperte rivolte alla persona + richieste `new` nei progetti dove ha `tickets.create`.
  - `viewer.ts`: `type LocalProjectPermission = "planning.others"`; `type Permission = InstancePermission | ProjectPermission | LocalProjectPermission | DepartmentPermission`; `planning.others` aggiunto ai permessi del preset `project_lead` (e implicito per full admin); `canInDepartment(viewer, "department.home.manage", departmentId): boolean`; `Viewer` aggiunge `departmentPermissions: Record<string, DepartmentPermission[]>`.
  - Personaggi «vedi come» (5): Giulia Ferri (Marketing, project lead sui suoi progetti, `department.home.manage` su Marketing), Marco Bellini (Development, developer), Laura Costa (Development, project lead, `department.home.manage` su Development), Sara Montanari (Support, contributor: niente `planning.others`, niente `tickets.edit`), Roberta Fontana (Administration, full admin).
  - Seed: stati per progetto dai modelli; template dei progetti allineati a `TEMPLATE_MODULES` (il test «moduli coerenti col template» usa `TEMPLATE_MODULES`); 8–15 task per progetto di riferimento (AUD, STW, MKX) e 5 negli altri; taglie su ~80% delle task; settimane da `2026-W41` a `2026-W46` con slittamenti (`slipCount` 1–3) su alcune; 2–3 traguardi per AUD/STW/MKX e 1 su metà degli altri; almeno una task ferma per ogni `StallReason.kind` nei progetti di Giulia; 6+ richieste di decisione aperte (almeno 3 rivolte a Giulia, 1 a Sara), 2 risposte, 1 ritirata; richieste di progetto in ogni stato con 2 fuse; filtri pubblici «Open», «Closed this month», «Stalled for more than 7 days», «No estimate», «Unassigned» (nomi dati in inglese) e 2 privati di Giulia; Home predefinite per tutti e 5 i reparti, una Home personalizzata per Marco; attività (commenti e cambi di campo) sulle task dei progetti di riferimento; `createdAt`/`closedAt`/`lastActivityAt` coerenti con stati e soglie.

- [ ] **Step 1: Test che falliscono.**
  - `api.test.ts`: `setSessionPersonId("p-sara")` → `listProjects()` contiene solo progetti con Sara fra i membri; `getProjectByCode` di un progetto dove Sara non è membro → `null`; `listTasks()` non contiene task di progetti invisibili; `search("Audin")` per una persona non membro di AUD non restituisce né il progetto né le sue task; `listNotifications()` contiene solo notifiche con Sara fra i destinatari; `listPinnedProjectIds()` cambia con la persona e `setPinned` per Sara non tocca i fissati di Giulia; `getSavedFilter(<privato di Giulia>)` per Sara → `null`; `listTasks(<criteri del filtro pubblico "Open">)` per Sara restituisce solo task visibili a Sara (**Review Focus 2**).
  - `viewer.test.ts`: `can(sara, "planning.others", <progetto>) === false`; `can(giulia, "planning.others", <progetto dove è lead>) === true`; full admin ha tutto; `canInDepartment(giulia, "department.home.manage", "dep-marketing") === true` e su `dep-sales` falso.
  - `seed.test.ts`: aggiorna i test esistenti al nuovo modello e aggiungi: ogni task ha uno `statusId` del suo progetto; ogni progetto ha ≥ 1 stato per famiglia; esiste almeno una task per ogni `StallReason.kind` (calcolata con `stallOf`); ogni richiesta fusa punta a una richiesta esistente dello stesso progetto; ogni `DecisionRequest` punta a una task esistente e a una persona membro del progetto.
  - `architecture.test.ts`: nessun file sotto `pages/`, `tasks-ui/`, `layout/`, `palette/`, `notifications/` importa da `data/seed` (lettura dei sorgenti con `import.meta.glob(..., { as: "raw" })` o `fs`).
  - Un test di integrazione in `router.test.tsx`: con il pannello di una task aperto (`?task=MKX-2`), passare a una persona che non vede MKX mostra la pagina «progetto non trovato» e nessun testo della task (**Review Focus 1**).
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** Implementa seed, sessione, visibilità, query con chiavi per persona, permessi locali, personaggi. `DeptStrip` e `ProfileMenu` leggono reparti e persone con `useDepartments()`/`usePeople()`. Il punto «ti aspetta» delle tessere usa `useWaitingOnMe()`.
- [ ] **Step 4:** test, typecheck, lint → verdi.
- [ ] **Step 5: Commit** — `feat(desktop): seed dell'area 2 e dati consapevoli di chi guarda`.

### Task 3: Mutazioni finte e hook

**Files:**
- Modify: `data/api.ts`, `data/queries.ts`, `data/api.test.ts`
- Create: `data/mutations.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces (tutte passano da `gate()` con un `ApiFnName` nuovo, quindi `failNext` le può far fallire; tutte verificano il permesso come farebbe il server e rifiutano con `Error("forbidden")`):
  - `createTask(input: NewTaskInput): Task` (`tickets.create`; codice = `<CODE>-<max+1>`; stato = primo `todo` se assente; reparto proposto = primo reparto di chi crea).
  - `updateTask(id, patch: Partial<Pick<Task, "title" | "description" | "statusId" | "departmentId" | "assigneeId" | "size" | "dueDate" | "plannedWeek" | "milestoneId" | "labels" | "type" | "priority" | "followerIds" | "links" | "manualStall">>)`: `tickets.edit`, tranne `followerIds` (chiunque veda la task segue/smette di seguire sé stesso) e `plannedWeek`/`assigneeId` dentro il Planning (vedi `planTask`). Scrive una `ActivityEntry` `field_change` per ogni campo cambiato; aggiorna `lastActivityAt`; passare a una famiglia `closed` imposta `closedAt`, uscirne lo azzera. Cambiare settimana o assegnatario azzera le `DayArrangement` della task.
  - `bulkUpdateTasks(ids, patch)` → stessa regola, tutto o niente.
  - `planTask(id, { assigneeId, week })`: consentito se `planning.others` nel progetto, o se chi pianifica è (o diventa) l'assegnatario e la task era sua o non assegnata. Notifica `planning.changed` all'interessato se diverso da chi agisce (nuovo kind locale nel seed delle notifiche).
  - `setDay(taskId, week, day)` solo per l'assegnatario.
  - `addComment`, `editComment` (solo autore), `deleteComment` (autore o `tickets.moderate`; cancella il testo: `body = ""`, `deletedAt`, `deletedById`).
  - `askDecision({ taskId, askedOfId, question, options })` (`tickets.comment`), `answerDecision(id, { optionIndex | text })` (solo `askedOfId`), `withdrawDecision(id)` (solo `askedById`). La risposta scrive un'attività `decision` e una notifica a chi l'ha chiesta.
  - `createRequest` (`backlog.create`), `updateRequest`, `mergeRequest(id, intoId)` (`backlog.edit`; unisce i richiedenti), `archiveRequest`, `reopenRequest`, `startRefine(id)` (stato `refining`), `convertRequest(id, NewTaskInput)` (`tickets.create`; collega task e richiesta, stato `converted`).
  - `saveFilter`, `updateFilter`, `deleteFilter` (solo autore o full admin), `setFilterPinned(filterId, pinned)` (per persona).
  - `setPersonalHome(blocks)`, `resetPersonalHome()`, `setDepartmentHome(departmentId, blocks)` (`department.home.manage`), `markDepartmentHomeSeen(departmentId)`.
  - `createProject(input)` (`projects.create`; stati e moduli dal modello; la persona diventa membro come project lead), `setProjectStatuses(projectId, statuses, reassign: Record<removedId, targetId>)` (`project.settings.manage`; rifiuta se manca una famiglia), `setStallThresholds(projectId, t)`.
  - `slipWeeks()`: chiamata all'avvio della sessione finta (in `resetApi` e al primo accesso): ogni task aperta con `plannedWeek` < settimana corrente passa alla settimana corrente con `slipCount + 1`. Idempotente.
  - In `queries.ts` un hook per ogni lettura e mutazione; le mutazioni che toccano board, planning, Home ed elenco sono **ottimistiche** (`onMutate` + rollback in `onError` + `invalidateQueries` in `onSettled`) e espongono l'errore per il messaggio.

- [ ] **Step 1: Test che falliscono** (`mutations.test.ts`): per ogni mutazione il caso permesso e il caso `forbidden` (con Sara o un viewer senza il permesso), con stato invariato dopo il rifiuto; `updateTask` scrive le attività e azzera le disposizioni del giorno; `planTask` di Giulia su una task altrui in un progetto dove è lead → ok e notifica all'assegnatario; di Sara → `forbidden`; `slipWeeks` due volte → `slipCount` incrementato una volta sola; `setProjectStatuses` che toglie l'unico `closed` → rifiutata; `mergeRequest` unisce i richiedenti senza duplicati; `deleteComment` lascia `body === ""`.
- [ ] **Step 2:** FAIL → **Step 3:** implementa → **Step 4:** PASS, typecheck, lint.
- [ ] **Step 5: Commit** — `feat(desktop): mutazioni finte dell'area 2`.

### Task 4: Kit comune delle task e chiusura dei follow-up dell'ossatura

**Files:**
- Create: `tasks-ui/TaskRow.tsx`, `tasks-ui/StatusLabel.tsx`, `tasks-ui/SizeMark.tsx`, `tasks-ui/PersonChip.tsx`, `tasks-ui/LoadBar.tsx`, `tasks-ui/StallMark.tsx`, `tasks-ui/PageStates.tsx` (`PageSkeleton`, `PageError`, `PageEmpty`), `tasks-ui/FilterBar.tsx`, `tasks-ui/Toast.tsx` (messaggi di errore delle azioni ottimistiche)
- Test: `tasks-ui/*.test.tsx`
- Modify: `layout/useDetailPanel.ts` (+ test), `layout/AppLayout.tsx`, `styles/tokens.css`

**Interfaces:**
- Consumes: Task 1–3.
- Produces:
  - `TaskRow({ task, density?: "compact" | "regular", selected?, onOpen })`: striscia del reparto, codice, titolo (troncato, intero in `title`), `StatusLabel`, `PersonChip` dell'assegnatario, `SizeMark`, scadenza, `StallMark` se ferma.
  - `StatusLabel({ status })`: nome dello stato + segno della famiglia (forma, non solo tono).
  - `SizeMark({ size })`: la lettera; `null` → «—» con etichetta accessibile «no estimate».
  - `PersonChip({ personId })`: iniziali + nome; Claude con il segno dell'ossatura (anello tratteggiato), senza colore proprio.
  - `LoadBar({ weight, max, unsized })`: barra proporzionale, «+N no estimate» accanto se `unsized > 0`; nessun numero di peso.
  - `StallMark({ stall })` e `stallText(stall, t): string` (frase del motivo: «Waiting for Elena's decision · 4 days»).
  - `FilterBar({ value: FilterCriteria, onChange, lockedProjectId?: string })`: chip per criterio con menu; `statusIds` offerto solo se `canUseStatusIds`.
  - `useToast()` + `<ToastRegion>` montata in `AppLayout`.
  - `DetailPanel`: Esc chiude solo se `!e.defaultPrevented` e nessun dialogo modale è aperto; in modalità `overlay` il fuoco va nel pannello all'apertura e torna all'elemento d'origine alla chiusura (follow-up dell'ossatura). Il pannello è ridimensionabile trascinando il bordo (larghezza 320–640 px, salvata per persona in `localStorage` con try/catch).
  - Windows: su `platform === "win32"` le testate delle pagine riservano `env(titlebar-area-height, 32px)` in alto e 140 px a destra (classe `page-header` in `tokens.css`).

- [ ] **Step 1: Test che falliscono:** `TaskRow` mostra codice **e** titolo, `title` col titolo intero, striscia con il nome del reparto accessibile; `SizeMark` di `null` ha l'etichetta accessibile; `LoadBar` con `unsized: 3` mostra «+3»; `DetailPanel` non chiude con un Esc già gestito (`defaultPrevented`) e restituisce il fuoco al bottone d'origine in overlay; `FilterBar` non offre gli stati precisi con due progetti.
- [ ] **Step 2–4:** FAIL → implementa → PASS, typecheck, lint.
- [ ] **Step 5: Commit** — `feat(desktop): kit comune delle task e follow-up dell'ossatura`.

### Task 5: Rotte dell'area 2

**Files:**
- Modify: `data/routes.ts`, `data/routes.test.ts`, `router.tsx`, `router.test.tsx`, `layout/PersonalColumn.tsx`, `layout/Column.test.tsx`, `palette/commands.ts`, `palette/CommandPalette.test.tsx`

**Interfaces:**
- Produces:
  - `APP_ROUTES` aggiunge `"filters"` e `"planning"`; rotta `#/filters/<id>`.
  - Ricerca `?task=<CODE-n>` valida su ogni rotta (apre il pannello del dettaglio, Task 7); `?request=<id>` su `#/p/<CODE>/requests`; `?view=week` su `#/home`.
  - `isAppRoute` accetta queste forme; `#/p/aud` (minuscolo) reindirizza a `#/p/AUD` (follow-up).
  - Colonna della Home: Home, My week, poi i filtri fissati della persona, poi «All filters»; «Planning» (trasversale) compare solo se la persona ha `planning.others` in almeno un progetto.
  - Risultati di ricerca task in ⌘K portano a `#/p/<CODE>/tasks?task=<CODE-n>`; azioni nuove in ⌘K: «New task», «New request», «Open filter…».
- [ ] **Step 1: Test che falliscono** in `routes.test.ts` (forme valide e non valide), `router.test.tsx` (`#/p/aud/tasks` → `#/p/AUD/tasks`; `#/filters/<privato altrui>` → stato «filtro non trovato»), `Column.test.tsx` (voce Planning solo con il permesso; filtri fissati in ordine), `CommandPalette.test.tsx` (le tre azioni; «New task» assente per chi non ha `tickets.create` in nessun progetto).
- [ ] **Step 2–4:** FAIL → implementa (le pagine nuove montano per ora `Placeholder`) → PASS.
- [ ] **Step 5: Commit** — `feat(desktop): rotte dell'area 2`.

### Task 6: Tasks di progetto — elenco, board, timeline

**Files:**
- Create: `pages/tasks/TasksPage.tsx`, `pages/tasks/TaskList.tsx`, `pages/tasks/TaskBoard.tsx`, `pages/tasks/TaskTimeline.tsx`, `pages/tasks/BulkBar.tsx`, `pages/tasks/grouping.ts`
- Test: `pages/tasks/*.test.tsx`, `pages/tasks/grouping.test.ts`
- Modify: `router.tsx` (sezione `tasks`), `package.json` (`@dnd-kit/core`, `@dnd-kit/sortable` via `pnpm add`)

**Interfaces:**
- Consumes: Task 3 (hook), Task 4 (kit), Task 5 (rotte).
- Produces: `TasksPage({ projectCode?: string; savedFilter?: SavedFilter })` — la stessa pagina serve il progetto e un filtro salvato (Task 8). Stato della vista in ricerca URL: `view`, `group`, criteri serializzati (`filters=` JSON compatto). `groupTasks(tasks, by: GroupBy, ctx): { key: string; label: string; tasks: Task[] }[]` in `grouping.ts`.
- Comportamenti (dallo spec, §3): barra Elenco · Board · Timeline, `FilterBar`, «Save as filter», «New task» (solo con `tickets.create`).
  - Elenco: raggruppamento, ordinamento per colonna, selezione multipla (clic, Maiusc+clic, ⌘/Ctrl+clic, ⌘A) con `BulkBar` (stato, assegnatario, settimana, traguardo, taglia) solo con `tickets.edit`.
  - Board: colonne = stati del progetto in ordine; per un filtro multi-progetto colonne = famiglie; corsie opzionali per assegnatario o reparto; trascinamento con `@dnd-kit` (puntatore e tastiera: Spazio prende, frecce spostano, Invio apre, Esc annulla) ottimistico con rollback e toast; senza `tickets.edit` le carte non si trascinano.
  - Timeline: asse per settimane (da 2 settimane prima di oggi a 8 dopo, scorrevole), traguardi come linee verticali con nome, task come barre da `plannedWeek` a `dueDate` (punto se una sola data), sezione «No dates».
  - Clic su una riga/carta → `?task=<CODE>`.
- [ ] **Step 1: Test che falliscono:** `grouping.test.ts` (per stato in ordine di progetto, per settimana in ordine cronologico con `2027-W01` dopo `2026-W53`, «No assignee» ultimo); `TaskList.test.tsx` (selezione multipla e bulk visibili solo con `tickets.edit`; persona Sara non vede la `BulkBar`); `TaskBoard.test.tsx` (colonne nell'ordine del progetto; tastiera: Spazio + freccia destra + Spazio cambia stato; `failNext("updateTask")` riporta la carta e mostra il toast; colonna «In approval» con nome lungo ha `title` intero — **Review Focus 5**); `TaskTimeline.test.tsx` (una task con sola scadenza è un punto; senza date finisce in «No dates»); stati pagina (scheletro, errore + Riprova, vuoto con «New task» o con frase su chi può).
- [ ] **Step 2–4:** FAIL → implementa → PASS, typecheck, lint.
- [ ] **Step 5: Commit** — `feat(desktop): Tasks di progetto, elenco board e timeline`.

### Task 7: Dettaglio della task, nuova task, richieste di decisione

**Files:**
- Create: `pages/task/TaskDetail.tsx`, `pages/task/TaskHeader.tsx`, `pages/task/DecisionSection.tsx`, `pages/task/ClaudeSection.tsx`, `pages/task/ActivityFeed.tsx`, `pages/task/LinksSection.tsx`, `pages/task/NewTaskDialog.tsx`, `pages/task/AskDecisionDialog.tsx`, `pages/task/StallControl.tsx`
- Test: `pages/task/*.test.tsx`
- Modify: `layout/AppLayout.tsx` (monta il pannello quando c'è `?task=`), `palette/commands.ts` («New task» apre `NewTaskDialog`)

**Interfaces:**
- Consumes: Task 3, 4, 5.
- Produces: `NewTaskDialog({ projectId?: string; fromRequestId?: string; onCreated(task: Task): void })` (riusato da Task 12 e Home/⌘K: senza `projectId` mostra la scelta del progetto fra quelli con `tickets.create`).
- Contenuto, nell'ordine dello spec §3: testata (codice, titolo modificabile, stato, assegnatario incluso Claude, reparto, taglia, scadenza, settimana, traguardo, tipo, priorità, etichette, «Follow»); `StallControl` (motivo e giorni; «Mark as stalled» con motivo e nota; «Not stalled anymore» per il manuale); `DecisionSection` (aperte e chiuse; «Ask for a decision» → `AskDecisionDialog`: persona fra i membri del progetto, domanda, opzioni facoltative; chi è interpellato risponde qui; chi ha chiesto ritira); descrizione (markdown in sola lettura + modifica); `ClaudeSection` (stato del lavoro di Claude con frase e «Assign to Claude»; link «Open session» verso `#/claude` con una riga che dice che la sessione arriva con l'area 3); richiesta d'origine, task collegate (aggiungi/togli con ricerca), allegati (elenco, aggiungi finto, togli con conferma); `ActivityFeed` (commenti markdown con risposta, modifica propria, eliminazione con conferma che dice che il testo sparisce; cambi di campo in riga compatta; risposte alle decisioni).
- Senza `tickets.edit` i campi sono in sola lettura; senza `tickets.comment` niente commenti né «Ask for a decision».
- Task inesistente o invisibile: il pannello mostra «This task doesn't exist or you can't see it».
- [ ] **Step 1: Test che falliscono:** modifica dello stato scrive una riga nell'attività; `AskDecisionDialog` crea la richiesta e la task mostra «Waiting for <nome>'s decision»; la persona interpellata (cambio persona) vede «Answer» e la risposta chiude la richiesta; chi non ha chiesto non vede «Withdraw»; Sara vede i campi in sola lettura; eliminare un commento mostra «Comment deleted · by <nome>» senza il testo; `NewTaskDialog` senza progetto elenca solo progetti con `tickets.create`; pannello su task invisibile mostra il messaggio (**Review Focus 1**).
- [ ] **Step 2–4:** FAIL → implementa → PASS, typecheck, lint.
- [ ] **Step 5: Commit** — `feat(desktop): dettaglio della task e richieste di decisione`.

### Task 8: Filtri salvati

**Files:**
- Create: `pages/filters/FilterPage.tsx`, `pages/filters/AllFiltersPage.tsx`, `pages/filters/SaveFilterDialog.tsx`
- Test: `pages/filters/*.test.tsx`
- Modify: `router.tsx` (`/filters`, `/filters/$id`), `pages/tasks/TasksPage.tsx` («Save as filter»)

**Interfaces:**
- Consumes: Task 3, 6.
- Comportamenti (spec §4): `FilterPage` = `TasksPage` con `savedFilter` (multi-progetto: board per famiglie); testata con nome, «Private»/«Public», autore, azioni «Edit», «Pin to column», «Add to Home» (blocco filtro), «Delete» (solo autore o full admin). `SaveFilterDialog`: nome, privato/pubblico (spiega che pubblico = tutti, ciascuno vede solo le sue task), salva criteri + vista + raggruppamento correnti; dentro un progetto salva con quel progetto. `AllFiltersPage`: «Mine» e «Public», con conteggio delle task **per chi guarda**.
- [ ] **Step 1: Test che falliscono:** salvare dal progetto conserva `projectIds: [progetto]`; un filtro pubblico di Giulia aperto da Sara mostra solo task visibili a Sara e il conteggio in `AllFiltersPage` è quello di Sara (**Review Focus 2**); Sara non vede «Delete» su un filtro pubblico di Giulia; Roberta (full admin) sì; «Pin to column» aggiunge la voce nella colonna della Home.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5: Commit** — `feat(desktop): filtri salvati privati e pubblici`.

### Task 9: Home a blocchi

**Files:**
- Create: `domain/home.ts` (+ test), `pages/home/HomePage.tsx`, `pages/home/HomeEditor.tsx`, `pages/home/blocks/DecideBlock.tsx`, `blocks/MyTasksBlock.tsx`, `blocks/ClaudeForMeBlock.tsx`, `blocks/StalledBlock.tsx`, `blocks/NewRequestsBlock.tsx`, `blocks/MilestonesBlock.tsx`, `blocks/FilterBlock.tsx`, `blocks/registry.ts`
- Test: `pages/home/*.test.tsx`, `blocks/*.test.tsx`
- Modify: `router.tsx` (`/home`)

**Interfaces:**
- Consumes: Task 3, 4, 7, 8. Il blocco `myWeek` è del Task 10: qui il registro lo prevede e monta `MyWeekBlock` importato da `pages/week/MyWeekBlock.tsx` (Task 10 lo crea; fino ad allora un componente vuoto con il titolo, sostituito in Task 10 — l'ordine dei task garantisce che non resti).
- Produces:
  - `domain/home.ts`: `FIXED_BLOCKS: HomeBlockKind[] = ["decide", "myWeek"]`; `resolveHome(person: Person, departmentHomes: DepartmentHome[], personal: PersonalHome | null): { blocks: HomeBlockRef[]; departmentChanged: string[] }` — senza personale: unione dei blocchi dei reparti della persona nell'ordine del primo reparto, doppioni una volta sola (un `filter` è doppio solo con lo stesso `filterId`), fissi sempre presenti in testa se mancanti; con personale: i suoi blocchi + fissi garantiti; `departmentChanged` = reparti la cui Home ha `updatedAt` più recente di `seenDepartmentUpdates`.
  - `blocks/registry.ts`: `BLOCKS: Record<HomeBlockKind, { titleKey: string; component: ComponentType<{ block: HomeBlockRef }>; available(viewer): boolean }>` (es. `newRequests` disponibile solo con `tickets.create` in almeno un progetto).
- Comportamenti (spec §2): `HomePage` mostra i blocchi risolti, la riga «Your department's Home has changed · See what's new» se `departmentChanged` non è vuoto; «Customize» apre `HomeEditor` (chi ha `department.home.manage` sceglie prima «My Home» o «<reparto> Home»): riordino col trascinamento (mouse e tastiera), nascondi (non per i fissi), «Add block» dal catalogo filtrato con `available`, «Reset to department Home». Ogni blocco ha i suoi stati (caricamento, vuoto con frase propria, errore con Riprova locale: l'errore di un blocco non abbatte la Home).
  - `DecideBlock`: richieste di decisione rivolte a me (risposta sul posto con le opzioni o testo) e richieste `new` da trasformare dove posso creare task («Turn into task» apre `NewTaskDialog` con `fromRequestId`); vuoto «Nothing to decide».
  - `MyTasksBlock`: tre schede «Assigned to me», «Delegated» (create da me, assegnate ad altri), «Following»; gruppi per scadenza (Overdue, Today, This week, Later, No date).
- [ ] **Step 1: Test che falliscono:** `home.test.ts` (unione di due reparti senza doppioni e nell'ordine del primo; fissi garantiti anche se il personale li ha tolti; `departmentChanged` dopo `setDepartmentHome`); `HomePage.test.tsx` (Giulia vede le sue decisioni; dopo `answerDecision` la voce sparisce; `failNext` su un blocco mostra l'errore solo in quel blocco; Sara non trova «New requests» nel catalogo se non ha `tickets.create` dove ci sono richieste — verifica col seed; Laura modifica la Home di Development e Marco, che ha una Home personale, vede la riga «has changed»).
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5: Commit** — `feat(desktop): Home a blocchi per reparto e personale`.

### Task 10: La mia settimana

**Files:**
- Create: `pages/week/MyWeekBlock.tsx`, `pages/week/MyWeekPage.tsx`, `pages/week/WeekBoard.tsx`
- Test: `pages/week/*.test.tsx`
- Modify: `router.tsx` (`/home?view=week`)

**Interfaces:**
- Consumes: Task 3 (`setDay`, `planTask`, `useDayArrangements`), Task 4 (`LoadBar`), `domain/weeks.ts`.
- Comportamenti (spec §2 «La mia settimana»): colonne Mon–Fri + «This week» (senza giorno); le mie task con `plannedWeek` = settimana mostrata; trascinamento fra giorni (`setDay`, ottimistico); le slittate con il segno «Slipped ×N»; `LoadBar` del mio carico con «+N no estimate»; navigazione «Previous / This week / Next week» (la settimana precedente in sola lettura); «Plan next week» = vai alla prossima. Il blocco della Home è la versione compatta (solo settimana corrente, conteggi per giorno, «Open my week»); la pagina è la versione intera.
- [ ] **Step 1: Test che falliscono:** una task spostata su mercoledì resta lì dopo il ricaricamento della query; cambiarle settimana dal dettaglio la riporta senza giorno; una task slittata due volte mostra «×2»; con 2 task senza stima la barra dice «+2» (**Review Focus 4**); nome di task lungo troncato con `title` (**Review Focus 5**).
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5: Commit** — `feat(desktop): la mia settimana`.

### Task 11: Planning di progetto e trasversale

**Files:**
- Create: `pages/planning/PlanningPage.tsx`, `pages/planning/Unplanned.tsx`, `pages/planning/PeopleGrid.tsx`, `pages/planning/PlanMenu.tsx`, `domain/planning.ts` (+ test)
- Test: `pages/planning/*.test.tsx`
- Modify: `router.tsx` (sezione `planning` e `/planning`)

**Interfaces:**
- Consumes: Task 3 (`planTask`), Task 4, `domain/load.ts`, `domain/weeks.ts`.
- Produces: `domain/planning.ts`: `peopleLoad(tasks: Task[], people: Person[], weeks: string[], scope: { projectId?: string }): Map<personId, { openHere: number; openEverywhere: number; byWeek: Record<string, { weight; count; unsized; slipped }> }>`.
- Comportamenti (spec §5): `PlanningPage({ projectCode?: string })`. Sinistra `Unplanned` (aperte senza settimana o slittate, `FilterBar`, raggruppabile per reparto o traguardo). Destra `PeopleGrid`: righe = membri del progetto (Claude incluso), colonne = 3 settimane da quella corrente con «Later →»; cella = task di quella persona/settimana + `LoadBar`; intestazione di riga con «N open here · N everywhere · N slipped». Trascinare una task su una cella = `planTask`; fra celle = ripianifica; tastiera: seleziona la task, `PlanMenu` (persona + settimana). Senza `planning.others` le righe altrui sono in sola lettura (con `title` che spiega perché), la propria si muove. Trasversale (`/planning`): selettore di reparto in testa (default primo reparto di chi guarda), righe = persone del reparto, task di tutti i progetti visibili, permesso valutato **per task**.
- [ ] **Step 1: Test che falliscono:** `planning.test.ts` (conteggi qui/ovunque, slittate, unsized); Giulia trascina (via tastiera) una task su Paolo questa settimana → la cella si aggiorna e Paolo riceve la notifica (cambio persona e pannello notifiche); Sara vede le righe altrui in sola lettura; nella vista trasversale una task di un progetto dove Giulia non ha `planning.others` non si sposta; `failNext("planTask")` riporta la task e mostra il toast.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5: Commit** — `feat(desktop): planning di progetto e trasversale`.

### Task 12: Requests

**Files:**
- Create: `pages/requests/RequestsPage.tsx`, `pages/requests/RequestDetail.tsx`, `pages/requests/NewRequestDialog.tsx`, `pages/requests/MergeDialog.tsx`
- Test: `pages/requests/*.test.tsx`
- Modify: `router.tsx` (sezione `requests`)

**Interfaces:**
- Consumes: Task 3, 4, 7 (`NewTaskDialog` con `fromRequestId`).
- Comportamenti (spec §6): elenco (titolo, richiedenti e «Requested N times», stato, urgenza, task collegate; filtri per stato e testo); «New request» con `backlog.create` (titolo, descrizione; dopo l'invio, se esiste una simile, la riga dice «Similar to …»); dettaglio come pannello (`?request=`): descrizione, richiedenti, simili, task nate da questa con il loro stato; azioni «Turn into task» (`tickets.create`), «Refine with Claude» (porta lo stato a `refining`; la riga spiega che la conversazione arriva con l'area 3), «Merge into…» (`backlog.edit`, ricerca fra le richieste del progetto con le simili per prime), «Archive», «Reopen». Convertita o archiviata: banner di sola lettura.
- [ ] **Step 1: Test che falliscono:** conversione crea la task, la collega e porta la richiesta a `converted` con il link alla task; fondere unisce i richiedenti e la fusa mostra «Merged into …»; Sara (contributor) vede «New request» ma non «Turn into task» né «Merge»; elenco vuoto con e senza permesso di creare.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5: Commit** — `feat(desktop): Requests`.

### Task 13: Overview di progetto

**Files:**
- Create: `pages/overview/OverviewPage.tsx`, `overview/StalledSection.tsx`, `overview/ProgressSection.tsx`, `overview/OpenSection.tsx`, `overview/ProjectTimeline.tsx`, `overview/DecisionLog.tsx`, `overview/BriefCard.tsx`
- Create: `data/seed/timeline.ts`, `data/seed/briefs.ts`, `data/seed/decisionLog.ts` (se non già coperti da Task 2)
- Test: `pages/overview/*.test.tsx`
- Modify: `router.tsx` (sezione `overview`)

**Interfaces:**
- Consumes: Task 3 (`listStalled`, `projectPulse`, `listTimeline`), Task 4, `domain/load.ts` (`progress`).
- Comportamenti (spec §7): in cima `StalledSection` se ci sono ferme (dalla più vecchia; motivo con `stallText`; clic apre la task); `ProgressSection`: traguardi aperti con data e avanzamento (taglie chiuse/totali, «N without estimate»), chiuse nelle ultime 2 settimane, `BriefCard` (ultimo brief, etichettato come testo generato); `OpenSection`: aperte per famiglia e per persona come numeri che aprono `TasksPage` filtrata; `ProjectTimeline` (oggi Roadmap: per settimana, tipi task aperta/chiusa, traguardo, decisione, brief, report giornaliero, PR; filtro per tipo); `DecisionLog` (voci con titolo, decisione, contesto, chi, superata da; «Record a decision» con `decisions.record`; mai testo dell'AI). Traguardi: crea/modifica/chiudi/riapri/elimina con `tickets.edit` (gestione dalla `ProgressSection`).
- [ ] **Step 1: Test che falliscono:** un progetto senza ferme non mostra la sezione; con ferme sono ordinate dalla più vecchia e la frase del motivo è corretta per ogni `kind`; l'avanzamento di un traguardo con task senza stima lo dichiara; clic su «3 in progress» apre l'elenco filtrato per famiglia `active`; «Record a decision» assente senza permesso.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5: Commit** — `feat(desktop): Overview di progetto`.

### Task 14: Tutti i progetti e impostazioni degli stati

**Files:**
- Create: `pages/projects/AllProjectsPage.tsx`, `projects/NewProjectDialog.tsx`, `projects/ActivityFeed.tsx`, `pages/settings/ProjectStatusesSettings.tsx`, `pages/settings/ProjectSettingsPage.tsx`
- Test: `pages/projects/*.test.tsx`, `pages/settings/*.test.tsx`
- Modify: `router.tsx` (`/projects`, sezione `settings`)

**Interfaces:**
- Consumes: Task 3 (`createProject`, `setProjectStatuses`, `setStallThresholds`, `setPinned`), Task 4.
- Comportamenti (spec §8): elenco dei progetti visibili (codice, nome, cliente, modello, riga di polso «Waiting on you · Claude working · N stalled · next milestone <nome, data>», fissa/sgancia); ordine: prima quelli che aspettano chi guarda, poi alfabetico; filtri interni/commesse, reparto, cliente, fissati, testo; schede «Projects», «Stalled» (ferme trasversali), «Activity» (attività per data). «New project» con `projects.create`: nome, codice proposto dalle iniziali (2–4 maiuscole, univoco, modificabile, validato), tipo, cliente, modello; si atterra sulla Overview.
- `ProjectSettingsPage` (in questa area contiene solo la sezione «Statuses and stalled tasks»; le altre sezioni sono dell'area 9 e restano con lo stato neutro dell'ossatura): elenco stati riordinabile con famiglia, aggiungi, rinomina, elimina con dialogo che chiede dove spostare le task; soglie «Stalled after N days» per `active` e `todo`. Solo con `project.settings.manage`, altrimenti sola lettura.
- [ ] **Step 1: Test che falliscono:** ordine «aspetta te» poi alfabetico; Sara non vede «New project»; codice proposto per «Brennero Logistics» = «BRL» o simile valido e univoco, un codice già usato è rifiutato con messaggio; eliminare uno stato con task chiede la destinazione e le task si spostano; togliere l'ultimo stato `closed` è impedito con spiegazione.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5: Commit** — `feat(desktop): Tutti i progetti e stati del progetto`.

### Task 15: Parità, screenshot e chiusura dei follow-up

**Files:**
- Modify: `apps/desktop/docs/web-inventory.md` (segna ogni voce dell'area 2 con dove vive ora o «area N»), `apps/desktop/docs/ossatura-follow-ups.md` (spunta ciò che è chiuso), `apps/desktop/scripts/capture.mjs` (rotte nuove; uccide il gruppo di processi di vite — follow-up)
- Create: `apps/desktop/docs/area2-parity.md` — tabella con una riga per ogni voce dell'inventario coperta dall'area 2 (Tickets, dettaglio ticket non-AI, Board, Backlog, Projects, traguardi, Roadmap, brief, registro decisioni, Activity): voce → dove vive → test che la copre.

- [ ] **Step 1:** Compila `area2-parity.md` leggendo l'inventario; ogni voce senza posto è un buco: aggiungila al task che la possiede e torna indietro (non chiudere il task con buchi).
- [ ] **Step 2:** `node apps/desktop/scripts/capture.mjs` produce gli screenshot di Home, My week, Tasks (tre viste), dettaglio, Planning, Requests, Overview, All projects, un filtro, in chiaro e scuro, inglese e italiano; nessun processo resta vivo dopo (`pgrep -f vite` vuoto).
- [ ] **Step 3:** Suite completa del desktop, typecheck, `pnpm lint`, `pnpm --filter @stubwise/desktop build` → verdi.
- [ ] **Step 4: Commit** — `docs(desktop): parità dell'area 2 e follow-up chiusi`.

Dopo il Task 15 (fuori dal piano, nel flusso SDD): revisione finale dell'intero branch e revisione visiva di Impeccable sugli screenshot, come per l'ossatura.
