# Appartenenza ai progetti, ruoli e permessi granulari — piano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** sostituire i ruoli d'istanza `admin`/`member` con membri di progetto, ruoli personalizzabili e permessi granulari, applicati dal server su ogni superficie.

**Architecture:** catalogo dei permessi nel codice (`packages/shared`), ruoli e membri nel DB, un unico risolutore lato server (`can`) alimentato da una dichiarazione `config.access` su OGNI rotta, imposta da un hook globale e verificata da un test che enumera le rotte. I client leggono i permessi effettivi calcolati dal server. `users.role` resta come colonna derivata (trigger) finché tutti i lettori non sono migrati.

**Tech Stack:** Fastify + Zod, Drizzle/Postgres (migrazione SQL a mano), Vitest + testcontainers, React/TanStack (web), React Native (app).

**Spec:** `docs/plans/2026-10-22-permessi-progetto-design.md`

## Global Constraints

- Nomi dei ruoli preset in inglese: `Admin`, `User`, `Project Lead`, `Developer`, `Contributor`, `Viewer`, `Legacy Member`.
- Chiavi dei permessi in inglese, stabili; etichette via i18n (`it`, `en`).
- Un progetto non visibile risponde **404** `not_found`, mai 403.
- Il client non deduce permessi: legge quelli calcolati dal server.
- Deve sempre esistere ≥1 utente col permesso `instance.full_admin`.
- Nessuna escalation: si assegna (o si rende effettivo modificando un ruolo) solo un ruolo i cui permessi sono inclusi in quelli di chi agisce (un full admin passa sempre).
- I full admin sono membri impliciti di ogni progetto (accesso, assegnatari, menzioni, notifiche ai membri).
- Revoca = filtro a lettura; nessuna riga riscritta.
- Conversione: `admin` → `Admin`; `member` → `User` + `Legacy Member` su tutti i progetti esistenti. Nessuno perde né guadagna nulla.
- `users.role` resta (derivata) in questo rilascio; nessun lettore nuovo la usa.
- Prossima migrazione: **0097**. Il batch Drizzle gira in una transazione (vedi `CLAUDE.md`).
- Campi nuovi nelle risposte lette dall'app nascono `.default()`/`.optional()`; sul web si difendono a lettura (`?? []`).
- `pnpm lint` verde prima del merge.

## Review Focus

1. **Una rotta o una lettura che sfugge al filtro** (ricerca, chat RAG, conteggi del polso, timeline, attività, `GET /api/users`, Slack `/docs`, tool MCP): un non membro deve ottenere 404 o un elenco senza quel progetto. → test a due utenti in T8, test di registro in T3/T16.
2. **Escalation tramite modifica del proprio ruolo** (un `Project Lead` che aggiunge `release.merge` al ruolo che ha già, o un `roles.manage` che si aggiunge `instance.full_admin`). → test in T9.
3. **Perdita dell'ultimo full admin** per eliminazione di un ruolo, modifica dei suoi permessi, cambio del ruolo d'istanza, eliminazione dell'utente. → test in T9.
4. **Conversione su dati reali**: un utente senza progetti, un progetto creato fra migrazione e worker vecchio, un invito pendente. → test in T2.
5. **Una card d'inbox già consegnata a chi poi perde l'accesso** resta visibile o azionabile. → test in T10.

---

### Task 1: Catalogo dei permessi e dei preset

**Files:**
- Create: `packages/shared/src/permissions.ts`, `packages/shared/src/permissions.test.ts`
- Modify: `packages/shared/src/index.ts`, `packages/i18n/src/locales/{it,en}.json` (etichette)

**Interfaces — Produces:**
- `INSTANCE_PERMISSIONS` (readonly tuple): `instance.full_admin`, `projects.create`, `users.invite`, `users.manage`, `roles.manage`, `settings.manage`, `ai_providers.manage`, `git_accounts.manage`, `plugins.manage`, `integrations.manage`, `monitor.view`, `monitor.manage`, `usage.view`, `users.view_all`.
- `PROJECT_PERMISSIONS`: `project.settings.manage`, `project.members.manage`, `tickets.view_all`, `tickets.create`, `tickets.edit`, `tickets.comment`, `runs.start`, `plans.approve`, `release.merge`, `corrections.request`, `backlog.view_all`, `backlog.create` (aprire una richiesta), `backlog.edit`, `docs.view`, `docs.edit`, `repos.view`, `repos.manage`, `agent_sessions.intervene`, `decisions.record`, `environments.manage`, `widget.manage`, `project.usage.view`. (Essere membri implica vedere il progetto: nessuna chiave `project.view`.)
- `type InstancePermission`, `type ProjectPermission`, `type RoleScope = "instance" | "project"`.
- `PRESET_ROLES: readonly { key: string; name: string; scope: RoleScope; permissions: readonly string[] }[]` con i 7 preset della spec. `Legacy Member` = quello che un `member` fa oggi (vedi Step 3). `User` = `monitor.view` (lettura che un member ha oggi) e nient'altro.
- `effectiveInstancePermissions(rolePerms: readonly string[]): Set<InstancePermission>` — con `instance.full_admin` restituisce tutto.
- `effectiveProjectPermissions(instancePerms: Set<InstancePermission>, memberRolePerms: readonly string[] | null): Set<ProjectPermission> | null` — `null` = non membro e non full admin (progetto invisibile); full admin → tutte.
- `isSubsetOf(granted: Iterable<string>, held: Set<string>): boolean`.

- [ ] **Step 1: test** — `permissions.test.ts`: (a) nessuna chiave duplicata fra i due livelli; (b) ogni preset usa solo chiavi del proprio livello; (c) `effectiveInstancePermissions(["instance.full_admin"])` contiene ogni `INSTANCE_PERMISSIONS`; (d) `effectiveProjectPermissions(new Set(), null) === null`; (e) full admin + `null` → tutte le `PROJECT_PERMISSIONS`; (f) `Developer` non contiene `plans.approve`, `release.merge`, `project.members.manage`, `project.settings.manage`; (g) `Contributor` = esattamente `docs.view`, `tickets.create`, `tickets.comment`, `backlog.create`; (h) `Viewer` contiene ogni chiave che finisce in `.view`/`.view_all` di progetto e nessun'altra; (i) ogni chiave ha un'etichetta in `it` e `en`.
- [ ] **Step 2:** `pnpm --filter @stubwise/shared test` → FAIL (modulo assente).
- [ ] **Step 3: implementa.** Per `Legacy Member` ricava i permessi da cosa un `member` può fare oggi: tutto il lavoro di progetto **tranne** `plans.approve`, `release.merge`, `project.settings.manage`, `project.members.manage`, `repos.manage`, `environments.manage`, `widget.manage`, e con `tickets.view_all` + `backlog.view_all`. Verifica la lista contro le rotte oggi `requireAdmin` sotto prefissi di progetto (`grep -n requireAdmin apps/server/src/routes/{projects,tickets,backlog,repositories,environments,widget-admin,project-plugins,env-files}.ts`) e scrivi nel commento del preset quale rotta giustifica ogni esclusione.
- [ ] **Step 4:** test verdi; `pnpm --filter @stubwise/shared build`.
- [ ] **Step 5: commit** `feat(shared): catalogo dei permessi e ruoli preset`.

### Task 2: Migrazione 0097 — ruoli, membri, conversione

**Files:**
- Create: `packages/db/drizzle/0097_roles_and_members.sql`, `packages/db/src/roles-migration.test.ts`
- Modify: `packages/db/src/schema.ts`, `packages/db/drizzle/meta/_journal.json`

**Interfaces — Produces (schema):**
- `roles(id uuid pk, name text not null, scope text not null check in ('instance','project'), permissions text[] not null default '{}', preset_key text null unique, created_at, updated_at)`, unique `(scope, lower(name))`. `preset_key` serve solo al seed/idempotenza; i preset restano modificabili ed eliminabili.
- `users.instance_role_id uuid not null references roles(id)` (ON DELETE RESTRICT).
- `project_members(project_id → projects ON DELETE CASCADE, user_id → users ON DELETE CASCADE, role_id → roles ON DELETE RESTRICT, created_at)`, pk `(project_id, user_id)`, index `(user_id)`.
- `invites.instance_role_id uuid null references roles(id) ON DELETE SET NULL` (null = preset `User` all'accettazione).
- Trigger `users_role_derived`: su insert/update di `users.instance_role_id` imposta `users.role = 'admin'` se il ruolo contiene `instance.full_admin`, altrimenti `'member'`. Trigger su `roles` (update di `permissions`) che ricalcola `users.role` degli utenti con quel ruolo.
- CHECK via trigger: un ruolo `project` non può essere `instance_role_id`; `project_members.role_id` deve essere `scope='project'`.

- [ ] **Step 1: test** (`roles-migration.test.ts`, Postgres vero, migra fino a 0096, inserisce dati, applica 0097): (a) 2 admin + 2 member + 3 progetti → gli admin hanno `Admin`, i member `User`, e ogni member è in `project_members` su tutti e 3 con `Legacy Member`; (b) gli admin NON hanno righe in `project_members`; (c) un invito pendente ha `instance_role_id` null; (d) `users.role` invariato dopo la migrazione; (e) cambiare `instance_role_id` di un member ad `Admin` porta `role` a `admin`; (f) togliere `instance.full_admin` dai permessi di `Admin` riporta `role` a `member` per i suoi utenti; (g) assegnare un ruolo `project` come `instance_role_id` fallisce; (h) i preset hanno i nomi inglesi e le stesse chiavi di `PRESET_ROLES` (importa da `@stubwise/shared`).
- [ ] **Step 2:** `pnpm --filter @stubwise/db test roles-migration` → FAIL.
- [ ] **Step 3:** scrivi la 0097 (seed dei 7 preset con le chiavi letterali di T1 — la parità è il test (h) —, colonne, backfill, trigger), aggiorna `schema.ts` e il journal. Niente `ALTER TYPE`.
- [ ] **Step 4:** test verdi; `pnpm --filter @stubwise/db build`.
- [ ] **Step 5: commit** `feat(db): ruoli, membri di progetto e conversione (0097)`.

### Task 3: Nucleo dell'accesso sul server

**Files:**
- Create: `apps/server/src/auth/access.ts`, `apps/server/src/auth/access.test.ts`, `apps/server/src/auth/route-access.test.ts`, `apps/server/src/auth/project-resolvers.ts`
- Modify: `apps/server/src/auth/session.ts` (SessionUser), `apps/server/src/app.ts` (hook globale)

**Interfaces — Produces:**
- `SessionUser` guadagna `instancePermissions: ReadonlySet<InstancePermission>`; `role` resta (derivata) solo per i lettori non ancora migrati.
- `type RouteAccess = { kind: "public" } | { kind: "user" } | { kind: "instance"; permission: InstancePermission } | { kind: "project"; permission: ProjectPermission | "member"; project: ProjectResolver }`, dichiarato come `config: { access }` nella rotta. `"member"` = basta essere membro.
- `type ProjectResolver = (req: FastifyRequest, db: Db) => Promise<string | null>`; in `project-resolvers.ts`: `fromParam(name)`, `fromTicket(param)`, `fromBacklogItem(param)`, `fromRepository(param)`, `fromAgentSession(param)`, `fromJob(param)`, `fromMilestone(param)`, `fromDocPage(param)` (ognuno: `null` se l'entità non esiste).
- `projectPermissionsFor(db, user: SessionUser, projectId: string): Promise<ReadonlySet<ProjectPermission> | null>` (null = invisibile).
- `can(db, user, permission, projectId?): Promise<boolean>`.
- `visibleProjectIds(db, user): Promise<"all" | string[]>` — `"all"` per i full admin.
- `request.access?: { projectId: string; permissions: ReadonlySet<ProjectPermission> }` impostato dall'hook per le rotte `project`.
- Hook globale `preHandler` registrato in `app.ts`: legge `routeOptions.config.access`; `public` passa; gli altri autenticano (PAT poi cookie, come `requireAuth`); `instance` senza permesso → 403 `forbidden`; `project` con resolver `null` o progetto invisibile → 404 `not_found`; membro senza il permesso → 403 `forbidden`. Le rotte che hanno ancora `preHandler: requireAuth/requireAdmin` e nessun `config.access` continuano a funzionare (transizione).

- [ ] **Step 1: test** `access.test.ts` (Postgres vero, utenti e ruoli creati via DB): (a) full admin vede un progetto senza esserne membro e ha ogni permesso; (b) membro `Developer` ha `runs.start` e non `plans.approve`; (c) non membro → `projectPermissionsFor` null e `visibleProjectIds` senza quel progetto; (d) una rotta di prova `project`/`plans.approve` con `fromTicket`: non membro → 404, `Developer` → 403, `Project Lead` → 200; ticket inesistente → 404; (e) rotta `instance`/`users.manage`: `User` → 403, `Admin` → 200; (f) PAT eredita i permessi dell'utente.
- [ ] **Step 2: test** `route-access.test.ts`: costruisce l'app, raccoglie le rotte con `onRoute`, e fallisce per ogni rotta senza `config.access` che NON compare in `LEGACY_ROUTES` (elenco esplicito `METHOD path`, generato ora con tutte le rotte attuali). Fallisce anche se una voce di `LEGACY_ROUTES` ha ormai `config.access` (l'elenco deve solo scendere).
- [ ] **Step 3:** FAIL → implementa → verdi. `pnpm --filter @stubwise/server test auth/`.
- [ ] **Step 4: commit** `feat(server): permessi risolti dal server e dichiarati per rotta`.

### Task 4: Rotte d'istanza

**Files:** `apps/server/src/routes/{settings,model-settings,google-workspaces,ai-providers,plugins,git-accounts,git-identity,servers,servers-checks,usage-costs,usage-snapshots,users,activity}.ts`, `apps/server/src/slack/identity-routes.ts`, `apps/server/src/routes/auth.ts` (inviti), i loro test; `route-access.test.ts` (`LEGACY_ROUTES` scende).

**Interfaces — Consumes:** `RouteAccess` (T3). Mappa: impostazioni/notifiche/budget → `settings.manage`; modelli → `settings.manage`; account AI → `ai_providers.manage`; account git → `git_accounts.manage`; plugin d'istanza → `plugins.manage`; Slack/Google Workspace → `integrations.manage`; server monitor letture → `monitor.view` OPPURE visibilità tramite progetto collegato (filtro nella query), scritture → `monitor.manage`; consumi d'istanza → `usage.view`; inviti → `users.invite`; cambio ruolo/reset password utente → `users.manage`; `/api/me/*`, PAT, viste salvate → `user`.

- [ ] **Step 1:** per ogni file, aggiungi ai test esistenti un caso negativo: utente con ruolo d'istanza `User` → 403 sulla scrittura e stato invariato; dove oggi c'era `requireAuth`, `User` passa ancora (nessuno perde nulla).
- [ ] **Step 2:** sostituisci `preHandler: requireAdmin|requireAuth` con `config: { access }`; togli le voci da `LEGACY_ROUTES`.
- [ ] **Step 3:** server monitor: test a due utenti — `User` vede un server collegato a un progetto di cui è membro anche dopo che a `User` si toglie `monitor.view`, non quello di un progetto altrui.
- [ ] **Step 4:** `pnpm --filter @stubwise/server test` verde; commit `feat(server): rotte d'istanza sui permessi`.

### Task 5: Ticket, job, correzioni, rilascio, sessioni — e i due divieti

**Files:** `apps/server/src/routes/{tickets,comments,jobs,attachments,corrections,release,agent-sessions,milestones}.ts`, `apps/server/src/services/{jobs,release,pr-adoption,comments,agent-sessions}.ts`, `packages/notifications/src/project-pulse-summary.ts`, test relativi (`jobs.test.ts`, `tickets.test.ts`, `release.test.ts`, `project-pulse-summary.test.ts`, `comments.test.ts`, `agent-sessions.test.ts`).

**Interfaces — Consumes:** `RouteAccess`, `request.access.permissions`, `can`. I servizi ricevono `actor: { id; permissions: ReadonlySet<ProjectPermission> }` al posto di `actor.role`.

- [ ] **Step 1: test** — riscrivi i test negativi dei due divieti sui permessi, mantenendo la doppia asserzione (risposta E stato invariato): `resolvePlan`/`preApprovePlan`/`revokePlanApproval` senza `plans.approve` → `forbidden`; `releasePullRequest` senza `release.merge` → 403 e nessun merge partito; `canMerge` nel polso è `true` per `Project Lead` e `false` per `Developer` sugli stessi dati. Gate: un run avviato da chi non ha `plans.approve` nasce `awaiting_plan_approval` (riscrive la riga `needsApproval` di `services/jobs.ts`). Commenti: modifica/eliminazione del commento altrui richiede `tickets.edit` e resta vietata sui commenti AI/sistema. `tickets.view_all` assente: elenco e dettaglio mostrano solo ticket con `requested_by_user_id` o `reporter` = utente, gli altri → 404.
- [ ] **Step 2:** FAIL → migra rotte e servizi (ogni `role === "admin"` del perimetro sostituito dal permesso; mantieni la difesa doppia rotta+servizio). `MEMBER_WRITABLE_SESSION_KINDS` diventa: scrivere in una sessione richiede `agent_sessions.intervene`.
- [ ] **Step 3:** verdi; `LEGACY_ROUTES` scende; commit `feat(server): ticket, run e rilascio sui permessi di progetto`.

### Task 6: Progetto, backlog, decisioni, impostazioni di progetto

**Files:** `apps/server/src/routes/{projects,backlog,briefs,environments,widget-admin,project-plugins}.ts`, `apps/server/src/services/{project-timeline,project-decisions}.ts`, test.

- [ ] **Step 1: test** — `canViewProject` (oggi admin-o-follower) è sostituita da `projectPermissionsFor !== null`; un follower non membro → 404 su timeline/decisioni/brief. Backlog senza `backlog.view_all`: solo voci di cui è richiedente (`backlog_item_requesters`). Registrare una decisione → `decisions.record`; impostazioni del progetto → `project.settings.manage`; ambienti → `environments.manage`; widget → `widget.manage`; plugin del progetto → `project.settings.manage`.
- [ ] **Step 2:** FAIL → implementa → verdi; commit `feat(server): progetto e backlog sui permessi`.

### Task 7: Docs, repository, grafo, chat

**Files:** `apps/server/src/routes/{docs,project-docs,repositories,env-files,repo-graph,docs-chat}.ts`, `apps/server/src/graph-chat/*` (solo se legge il progetto), test.

- [ ] **Step 1: test** — documentazione: lettura `docs.view`, scrittura `docs.edit`; repository e grafo: `repos.view`/`repos.manage`; file d'ambiente: `repos.manage`. Chat RAG di un repo di un progetto invisibile → 404; la chat di progetto non recupera passaggi di progetti invisibili (test con due progetti e una domanda che li tocca entrambi).
- [ ] **Step 2:** FAIL → implementa → verdi; commit `feat(server): docs e repository sui permessi`.

### Task 8: Elenchi, ricerca, utenti, inbox

**Files:** `apps/server/src/routes/{projects,tickets,backlog,search,activity,usage-costs,users,inbox}.ts`, `apps/server/src/services/inbox.ts`, test.

**Interfaces — Consumes:** `visibleProjectIds`, `projectPermissionsFor`.

- [ ] **Step 1: test a due utenti sugli stessi dati** (membro di A, non di B) per: `GET /api/projects`, `/api/projects/pulse`, elenco ticket (anche con filtri e conteggi), elenco backlog, `GET /api/search` (ticket, backlog, docs, progetti — la posta resta per proprietario), attività, consumi per progetto (`project.usage.view`), `GET /api/users` (senza `users.view_all`: solo chi condivide un progetto + i full admin), inbox (card di B già consegnate non compaiono e le loro azioni → 404).
- [ ] **Step 2:** FAIL → filtra nelle query (WHERE su `visibleProjectIds`, mai a valle in JS sul risultato paginato) → verdi.
- [ ] **Step 3: commit** `feat(server): elenchi e ricerca filtrati per progetto`.

### Task 9: Gestione di ruoli e membri

**Files:**
- Create: `apps/server/src/routes/roles.ts`, `apps/server/src/routes/project-members.ts`, `apps/server/src/services/roles.ts`, test; `packages/shared/src/schemas/roles.ts`
- Modify: `apps/server/src/routes/{users,auth,projects}.ts`, `apps/server/src/app.ts`

**Interfaces — Produces:**
- `GET/POST /api/roles`, `PATCH/DELETE /api/roles/:id`, `POST /api/roles/:id/duplicate` (`roles.manage`; `GET` anche a chi ha `project.members.manage` in qualche progetto, per scegliere il ruolo).
- `GET/PUT/DELETE /api/projects/:projectId/members[/:userId]` (`project.members.manage`; `GET` a ogni membro).
- `PATCH /api/users/:id/instance-role` (`users.manage`).
- `POST /api/auth/invites` accetta `instanceRoleId?` e `projects?: { projectId; roleId }[]` (aggiunti all'accettazione).
- Creare un progetto (`projects.create`) rende il creatore membro `Project Lead` (se il preset non esiste più: il primo ruolo di progetto con tutti i permessi, altrimenti nessuna riga e il creatore resta senza accesso se non è full admin → la rotta lo impedisce con 409 `no_lead_role`).
- `services/roles.ts`: `assertNoEscalation(actor, permissions)`, `assertFullAdminRemains(tx)` chiamata in ogni transazione che tocca ruoli d'istanza, permessi di ruoli, eliminazione di ruoli o utenti.

- [ ] **Step 1: test** — escalation: un membro con un ruolo personalizzato che ha `project.members.manage` ma non `release.merge` prova ad assegnare `Project Lead` a qualcuno → 403 e membri invariati; chi ha `roles.manage` ma non `instance.full_admin` non può aggiungere `instance.full_admin` né permessi che non ha a nessun ruolo, né modificare il ruolo che possiede per allargarlo → 403 e ruolo invariato. Ultimo full admin: eliminare il ruolo `Admin`, togliergli `instance.full_admin`, cambiare il ruolo d'istanza dell'unico admin, eliminarlo → 409 `last_full_admin` e stato invariato. Ruolo in uso: eliminare un ruolo assegnato → 409 `role_in_use` con il conteggio. Nome duplicato nello stesso scope → 409. Invito con progetti → all'accettazione l'utente è membro con quei ruoli.
- [ ] **Step 2:** FAIL → implementa → verdi; commit `feat(server): gestione di ruoli e membri`.

### Task 10: Notifiche e inbox per permessi

**Files:** `packages/notifications/src/{routing,publish}.ts` e test, `apps/worker/src/**` dove si costruisce il `RoutingContext`, `apps/server/src/services/inbox.ts`.

**Interfaces:** `RoutingContext.admins` è sostituito da `deciders: string[]` (chi ha il permesso pertinente nel progetto dell'evento + full admin) e `members: string[]`; `audienceFor` resta; nuova mappa `PERMISSION_FOR_KIND` (`job.plan_review` → `plans.approve`, `job.held`/`job.budget_held` → `runs.start`, `request.created` → `project.members.manage`, `monitor.*` → `monitor.manage` (istanza), `docs.*` → `settings.manage` (istanza)). `broadcast` = (deciders ∪ persone del ticket ∪ follower) ∩ membri visibili. `requester` = richiedente se ancora membro ∪ deciders. `mailbox_owner` invariato.

- [ ] **Step 1: test** — un follower non membro non riceve `ticket.created`; un `Developer` non riceve `job.plan_review`, un `Project Lead` sì; il richiedente rimosso dal progetto non riceve `job.awaiting_input` ma i deciders sì (la domanda non resta orfana); un full admin non membro riceve le notifiche ai membri; `google.proposal` va solo al proprietario. Lettura: card consegnate prima della revoca non compaiono e le azioni → 404 (riusa il test di T8).
- [ ] **Step 2:** FAIL → implementa → verdi; commit `feat(notifications): destinatari per permesso di progetto`.

### Task 11: Proposte di posta verso progetti non visibili

**Files:** `apps/server/src/services/{google-proposal,email-routes}.ts`, `packages/notifications/src/actions.ts`, `apps/worker/src/google/proposal.ts`, i18n, test; rileggi `docs/invariants/mail-calendar.md`.

**Interfaces — Produces:** azione `hand_to_project` sulla card del proprietario: crea una card nuova (kind `google.proposal_handed`, audience nuova `project_deciders` = chi ha `tickets.create`/`backlog.edit` nel progetto + full admin) col contenuto della proposta; la card del proprietario mostra l'esito. Confermare una proposta (dal proprietario o dai deciders) richiede `tickets.create` (ticket) o `backlog.edit` (voce) nel progetto.

- [ ] **Step 1: test** — proprietario senza permesso nel progetto: `confirm` → 403 e nessun ticket; `hand_to_project` → card ai deciders, non al proprietario né ad altri; un decider conferma → ticket creato; `reassign_project` verso un progetto visibile funziona. Invariante: la card del proprietario NON va agli admin (test esistente invariato). `notification_kind` nuovo: seguire la regola di migrazione degli enum (statement a sé, nessun uso nello stesso batch) e annotare il rollback in T16.
- [ ] **Step 2:** FAIL → implementa → verdi; commit `feat(mail): passare una proposta al progetto`.

### Task 12: Worker e Slack

**Files:** `apps/worker/src/backlog/intake.ts`, `apps/worker/src/backlog/refine/turn.ts`, `apps/worker/src/**/deliveries-poller.ts`, ogni altro lettore di `users.role` nel worker (`grep -rn "\.role\b\|users.role" apps/worker/src`), `apps/server/src/slack/routes.ts`, test.

- [ ] **Step 1: test** — intake: «richiesta da un collaboratore» = richiedente senza `tickets.view_all` nel progetto (era `role === "member"`); refine: chi può scrivere nella sessione = `backlog.edit`. Slack: `/docs` e il modale del ticket elencano solo i progetti visibili all'utente collegato; un utente Slack non collegato non apre ticket (oggi può: è un cambio voluto, documentarlo in T16); le azioni inbox da Slack passano dai permessi.
- [ ] **Step 2:** FAIL → implementa → verdi; nessun lettore di `users.role` resta nel worker; commit `feat(worker,slack): permessi al posto del ruolo`.

### Task 13: Permessi verso i client e uso nel web

**Files:** `apps/server/src/routes/auth.ts` (`/api/auth/me`), `packages/shared/src/schemas/*` (me), `packages/api-client`, `apps/web/src/lib/permissions.ts` (nuovo), `apps/web/src/router.tsx`, i 23 file web che leggono `role` (`grep -rln "role" apps/web/src`).

**Interfaces — Produces:** `/api/auth/me` aggiunge `instancePermissions: string[]` (`.default([])`) e `projectPermissions: Record<projectId, string[]>` (`.default({})`); il dettaglio progetto porta `myPermissions: string[]` (`.default([])`). Web: `useCan(permission, projectId?)`.

- [ ] **Step 1: test** — schema: parse di una risposta `me` senza i campi nuovi; web: un componente che usava `isAdmin` mostra il pulsante con il permesso e lo nasconde senza (fixture senza i campi = nascosto, non crash).
- [ ] **Step 2:** sostituisci ogni `role === "admin"` del web con `useCan`; le guardie `beforeLoad` di `router.tsx` usano i permessi d'istanza. Nessun `role` resta nel web (`grep` nel test di Step 1 o in lint rule).
- [ ] **Step 3:** verdi (`pnpm --filter @stubwise/web test`; i 2 test del calendario sono rossi anche su `main`); commit `feat(web): interfaccia guidata dai permessi`.

### Task 14: Interfaccia di gestione (web)

**Files:** `apps/web/src/routes/settings/roles.tsx` (nuova), tab «Members» nel progetto, `apps/web/src/routes/team.tsx`, i18n, test; E2E Playwright in `apps/web/e2e/` per il flusso ruoli.

- [ ] **Step 1:** Ruoli: elenco per tipo, crea/duplica/rinomina/modifica permessi (checkbox raggruppate con etichette i18n)/elimina, con gli errori `role_in_use`, `last_full_admin`, escalation mostrati in chiaro. Membri del progetto: aggiungi/rimuovi/cambia ruolo. Team: ruolo d'istanza e invito con ruolo e progetti. Ticket: badge «assegnatario senza accesso».
- [ ] **Step 2:** test di componente per ciascuna vista + un E2E: crea ruolo → assegna in un progetto → l'utente vede solo quel progetto.
- [ ] **Step 3:** commit `feat(web): gestione di ruoli e membri`.

### Task 15: App mobile

**Files:** i 9 file di `apps/mobile/src` che leggono `role` (SettingsScreen, ProjectSettingsScreen, WorkScreen, InboxScreen, PlanSection, `lib/inbox-sections.ts`, `lib/work-mutations.ts`, …), test.

- [ ] **Step 1:** sostituisci con i permessi di `me`/`myPermissions`; completa OGNI fixture e il doppio `makeClient()` (vedi le trappole del `CLAUDE.md`).
- [ ] **Step 2:** `pnpm --filter @stubwise/mobile test` verde; commit `feat(mobile): permessi al posto del ruolo`.

### Task 16: Documentazione, invarianti, chiusura del registro

**Files:** `CLAUDE.md`, `docs/invariants/permissions.md` (nuovo), `docs/operations/deploy-log.md`, `apps/docs/src/content/docs/**` (guida admin: ruoli e membri), `apps/server/src/auth/route-access.test.ts`.

- [ ] **Step 1:** `LEGACY_ROUTES` vuoto e rimosso; `requireAdmin` eliminato; `requireAuth` usato solo dall'hook.
- [ ] **Step 2:** `CLAUDE.md`: riscrivi «I due divieti dell'operatore» sui permessi `plans.approve`/`release.merge`; voce indice per `docs/invariants/permissions.md` con: ogni rotta dichiara `config.access`; 404 per progetti invisibili; filtri nelle query; il client legge; nessuna escalation; ultimo full admin; revoca a lettura; full admin membri impliciti.
- [ ] **Step 3:** deploy-log «Ruoli e membri di progetto»: migrazione 0097 (prima il server; il trigger tiene `users.role` per il worker vecchio), `notification_kind` nuovo (rollback del server non sicuro finché esistono righe), Slack non collegato non apre più ticket, verifica post-deploy (`select u.email, r.name from users u join roles r on r.id = u.instance_role_id;` e conteggio `project_members`), rollback.
- [ ] **Step 4:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test`; commit `docs: ruoli e membri di progetto`.
