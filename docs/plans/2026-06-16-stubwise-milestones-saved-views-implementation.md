# Feature 6 — Milestone + viste salvate — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development.

**Goal:** Aggiungere **milestone** per-progetto (nome + scadenza opzionale + stato open/closed + avanzamento) a cui assegnare i ticket, con filtro nella lista/board e voce nell'activity feed; e **viste salvate** (saved views) per-utente — un set di filtri con un nome, private e opzionalmente condivisibili col team.

**Architecture:** Tabella `milestones` (projectId FK, name, dueDate nullable, status open/closed); `tickets.milestoneId` (FK nullable, ON DELETE set null). CRUD milestone via route `requireAuth` (entità operativa, ogni membro le gestisce). L'avanzamento è calcolato a read-time con un'aggregazione `GROUP BY status` sui ticket della milestone (nessun contatore denormalizzato). L'assegnazione milestone è una normale `PATCH /tickets/:id` (campo `milestoneId`) che registra un `ticket_event` `milestone_changed`. Le `saved_views` (ownerId FK users cascade, name, filters jsonb, shared bool) sono globali per-utente; la lista ne mostra le proprie + quelle `shared` altrui. Applicare una vista = scrivere i suoi filtri negli URL search params esistenti.

**Decisioni (validate 2026-06-16):** milestone = name + dueDate(opz) + status(open/closed) + avanzamento (conteggi); permessi milestone = qualsiasi utente autenticato; saved views = private + flag `shared`.

**Design:** `docs/plans/2026-06-16-stubwise-team-tracker-design.md`. **Convenzioni:** TDD, testcontainers per DB/route, migrazione additiva, i18n en/it (parità — c'è un test ricorsivo), E2E se si tocca un flusso coperto, review spec+qualità. **Pre-merge:** `pnpm lint` (root) + `pnpm -r typecheck` + `pnpm -r test` + `pnpm --filter @stubwise/web e2e`. Nessun nuovo workspace package (niente nuove COPY nei Dockerfile).

---

### Task 1: Schema — milestones + tickets.milestoneId + saved_views + enum

**Files:** `packages/db/src/schema.ts`, migrazione (`drizzle-kit generate`, verifica SQL; NB: `ALTER TYPE ... ADD VALUE` per l'enum potrebbe richiedere una migrazione hand-tuned — vedi nota), `packages/db/src/schema.test.ts`.

- **Enum**: aggiungi `milestone_changed` al pgEnum `ticket_event_kind` (additivo). **Nota Postgres**: `ALTER TYPE ... ADD VALUE` non può girare nella stessa transazione in cui il valore è poi usato; drizzle-kit di norma lo gestisce in una migrazione separata. Verifica il SQL generato; se necessario isola l'`ADD VALUE`.
- **pgEnum `milestone_status`**: `open`, `closed`.
- **`milestones` pgTable**: `id uuid pk defaultRandom`; `projectId uuid notNull FK→projects onDelete cascade`; `name text notNull`; `dueDate` (usa `date` o `timestamptz` nullable — scegli `timestamp({withTimezone:true})` nullable per coerenza col resto, oppure `date`; documenta); `status milestone_status notNull default 'open'`; `createdAt timestamptz notNull defaultNow`. Indice su `projectId`. **Unique** su `(projectId, name)` (no due milestone omonime nello stesso progetto).
- **`tickets.milestoneId`**: `uuid` nullable, FK→`milestones.id` onDelete **set null**. Indice su `milestoneId`.
- **`saved_views` pgTable**: `id uuid pk defaultRandom`; `ownerId uuid notNull FK→users onDelete cascade`; `name text notNull`; `filters jsonb notNull` (oggetto: `{ projectId?, status?, type?, priority?, assigneeId?, milestoneId?, q? }`); `shared boolean notNull default false`; `createdAt timestamptz notNull defaultNow`. Indice su `ownerId`. Unique su `(ownerId, name)`.
- Migrazione additiva. Esegui `drizzle-kit generate`, **VERIFICA** il SQL (probabilmente `0019_*.sql`), e che un secondo `generate` non produca diff. Se l'`ADD VALUE` dell'enum crea problemi, correggi a mano e allinea lo snapshot.

**Test (testcontainers):** insert/read milestone; unique `(projectId, name)`; FK cascade dal progetto (cancellando il progetto spariscono le sue milestone); assegnare `tickets.milestoneId` e poi cancellare la milestone → il ticket resta con `milestoneId = null` (set null); insert/read saved_view con filters jsonb (round-trip dell'oggetto); unique `(ownerId, name)`; FK cascade dall'utente.

**Commit:** `feat(db): milestones + tickets.milestoneId + saved_views + enum milestone_changed`

---

### Task 2: Server — CRUD milestones + avanzamento + filtro + assegnazione (evento)

**Files:** `apps/server/src/routes/milestones.ts` (nuovo, registrato in app), `apps/server/src/routes/tickets.ts` (filtro `milestoneId` nella list + `milestoneId` nel PATCH + `milestone_changed` in `diffTicketEvents`), `apps/web/src/lib/api.ts`, test.

- **Route milestones** (tutte `requireAuth`), imita lo stile di `git-accounts.ts` (proiezione esplicita, 404, check update non vuoto):
  - **POST `/api/milestones`** body `{ projectId: uuid, name, dueDate?: string|null, status?: 'open'|'closed' }`: 404 se progetto inesistente; 409 (`milestone_exists`) se `(projectId,name)` duplicato; 201 col milestone.
  - **GET `/api/milestones?projectId=:id`** (requireAuth): lista le milestone del progetto, ognuna con **avanzamento**: `{ id, projectId, name, dueDate, status, createdAt, counts: { total, completed, byStatus: Record<status,number> } }`. `completed` = ticket nello stato terminale del progetto (usa lo stato "done"/finale reale — controlla `ticketStatusSchema`; documenta quale consideri "completed"). L'aggregazione: una query `GROUP BY milestoneId, status` sui ticket del progetto, mappata sulle milestone (evita N+1). Ordina le milestone per (status open prima), dueDate asc nulls last, name.
  - **GET `/api/milestones/:id`** (requireAuth): dettaglio con counts; 404.
  - **PATCH `/api/milestones/:id`** (requireAuth) `{ name?, dueDate?, status? }`: aggiorna; 409 su collisione name; 404; risposta col milestone aggiornato.
  - **DELETE `/api/milestones/:id`** (requireAuth): 404; DELETE (i ticket vanno a `milestoneId=null` via FK set null); 204.
- **tickets.ts — list**: aggiungi `milestoneId: z.uuid().optional()` a `listTicketsQuerySchema` e `if (milestoneId) conditions.push(eq(tickets.milestoneId, milestoneId))`. Cursor keyset INVARIATO.
- **tickets.ts — PATCH**: aggiungi `milestoneId: z.uuid().nullable().optional()` a `updateTicketBodySchema`; in `diffTicketEvents` aggiungi il caso milestone (`updates.milestoneId !== undefined && updates.milestoneId !== current.milestoneId` → evento `milestone_changed`, payload `{ from, to }` con gli UUID, o null). Valida (opzionale ma consigliato): se `milestoneId` non-null, la milestone deve esistere ed essere **dello stesso progetto** del ticket → altrimenti 400 (`milestone_cross_project`). Registra l'evento nella stessa transazione esistente.
- Client `api.ts`: tipi `Milestone`/`MilestoneWithCounts`, `listMilestones(projectId)`, `createMilestone(...)`, `updateMilestone(...)`, `deleteMilestone(...)`; aggiungi `milestoneId` a `TicketFilters` e a `TicketPatch`.

**Test (testcontainers):** CRUD milestone (create/list-con-counts/patch/delete); unique name → 409; cross-project assign → 400; list ticket filtrata per `milestoneId`; PATCH ticket che setta/cambia/azzera milestone → evento `milestone_changed` con from/to corretti (e nessun evento se invariato); counts corretti (crea ticket in vari stati, verifica total/completed/byStatus); auth (401).

**Commit:** `feat(server): CRUD milestones + avanzamento + filtro e assegnazione ticket`

---

### Task 3: Server — CRUD saved views (private + shared)

**Files:** `apps/server/src/routes/saved-views.ts` (nuovo, registrato in app), `apps/web/src/lib/api.ts`, test.

- Schema zod dei `filters` (riusa/condividi con la query della lista): `{ projectId?, status?, type?, priority?, assigneeId?, milestoneId?, q? }` (tutti opzionali). Valida i valori enum.
- **POST `/api/saved-views`** (requireAuth) `{ name, filters, shared?: boolean }`: crea con `ownerId = request.user.id`; 409 (`view_exists`) se `(ownerId,name)` duplicato; 201.
- **GET `/api/saved-views`** (requireAuth): ritorna le viste **dell'utente** + quelle con `shared=true` di **altri** utenti; ogni item con `{ id, name, filters, shared, ownerId, isOwn: boolean }` (la UI distingue le proprie). Ordina: proprie prima, poi per name.
- **PATCH `/api/saved-views/:id`** (requireAuth) `{ name?, filters?, shared? }`: solo il **proprietario** può modificare (403 altrimenti); 404; 409 su collisione name.
- **DELETE `/api/saved-views/:id`** (requireAuth): solo il proprietario (403); 404; 204.
- Client `api.ts`: tipi `SavedView`, `listSavedViews()`, `createSavedView(...)`, `updateSavedView(...)`, `deleteSavedView(...)`.

**Test (testcontainers):** create → 201; list ritorna le proprie + le shared altrui ma NON le private altrui; isOwn corretto; patch/delete da non-proprietario → 403; unique name per owner → 409; round-trip dei filters jsonb; auth (401).

**Commit:** `feat(server): CRUD saved views (private + condivise)`

---

### Task 4: Web — milestone UI (gestione, filtro, badge, assegnazione, feed)

**Files:** nuovo `apps/web/src/components/milestone-*.tsx` (es. `milestone-manager.tsx` per CRUD + `milestone-badge.tsx`), `apps/web/src/components/ticket-filters.tsx`, `apps/web/src/routes/tickets/index.tsx` (+ `board.tsx` se presente), `apps/web/src/routes/tickets/$id.tsx` (assegnazione), `apps/web/src/components/activity-feed.tsx` (describeEvent), `apps/web/src/lib/queries.ts`, i18n, test (+ E2E se serve).

- **Gestione milestone**: una UI per creare/rinominare/chiudere/eliminare le milestone di un progetto (dove ha senso: una sezione nelle impostazioni progetto, o un piccolo manager accessibile dalla lista/board filtrata per progetto). Mostra dueDate e l'avanzamento (es. `3/10 done`, barra). Chiudere una milestone = PATCH status. Scegli la collocazione più coerente con la nav esistente e documentala.
- **Filtro milestone** nella lista/board: aggiungi un select "Milestone" in `ticket-filters.tsx` popolato da `listMilestones(projectId)` (abilitato solo quando un progetto è selezionato, dato che le milestone sono per-progetto); aggiungi `milestoneId` a `ticketSearchSchema` (`.optional().catch(undefined)`) e al navigate. Includi un'opzione "All".
- **Assegnazione nel ticket detail** (`$id.tsx`): un select Milestone nel pannello azioni laterale (come status/priority/assignee) che fa `patchTicket(id, { milestoneId })`; opzione per togliere (null). Popola con le milestone del progetto del ticket. Invalida le query del ticket + activity.
- **Badge milestone**: mostra la milestone del ticket (nome) nel dettaglio e, se sensato, nelle card di board/lista.
- **Activity feed**: in `describeEvent` aggiungi `case "milestone_changed"` → testo i18n con `from`/`to` risolti a nome milestone (serve una mappa id→nome; caricala via `listMilestones` del progetto del ticket, oppure mostra "set/removed milestone"). Gestisci i null (assegnata / rimossa).
- i18n en/it (parità): tutte le stringhe nuove (namespace `milestones`, voci filtro/detail, evento `milestone_changed`).
- Invalidazioni corrette (milestone CRUD invalida la lista milestone; assegnazione invalida ticket+activity+lista).

**Test web:** il manager crea/chiude/elimina (mock API); il filtro milestone naviga col param giusto; l'assegnazione nel detail chiama patchTicket; il feed rende `milestone_changed`. **E2E**: mantieni verdi gli esistenti; se aggiungi milestone a un flusso coperto, aggiorna `core-flows.spec.ts` ed eseguilo.

**Commit:** `feat(web): milestone (gestione, filtro, assegnazione, badge, feed)`

---

### Task 5: Web — viste salvate (salva/applica/lista/condividi)

**Files:** nuovo `apps/web/src/components/saved-views.tsx` (+ eventuale dialog salva), `apps/web/src/routes/tickets/index.tsx` (+ board), `apps/web/src/lib/queries.ts`, i18n, test.

- Nella lista/board ticket, una barra/menu "Saved views":
  - **Salva vista corrente**: prende i filtri attuali (dagli URL search params), chiede un nome + checkbox "Share with team" → `createSavedView({ name, filters, shared })`.
  - **Lista**: mostra le viste (proprie + shared altrui, con un indicatore "shared"/owner); clic su una vista → applica i suoi filtri (scrive gli URL search params → la lista si aggiorna). 
  - **Gestione**: rinomina/elimina/cambia shared sulle proprie (le altrui shared sono sola applicazione).
- Invalidazioni: create/patch/delete invalidano `savedViewsQueryOptions`.
- i18n en/it (parità): namespace `savedViews`.

**Test web:** salva la vista corrente coi filtri dell'URL (mock create); applicare una vista scrive i search params/naviga; le viste altrui shared sono applicabili ma non modificabili; lista rende proprie vs shared. Mocka l'API.

**Commit:** `feat(web): viste salvate (salva, applica, condividi)`

---

### Task 6: Docs + verifica finale

**Files:** `apps/docs/.../getting-started/web-app.md` (sezione: milestone per-progetto con scadenza/stato/avanzamento e assegnazione; filtro milestone; viste salvate private/condivise), in inglese. `pnpm --filter @stubwise/docs build`.

**Verifica finale:** `pnpm lint` (root), `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @stubwise/web e2e`, `pnpm -r build`. Code review finale vs design. **Deploy:** backup DB, migrazione additiva 0019 (incl. `ALTER TYPE ADD VALUE` per l'enum — verifica che si applichi pulito al boot), rebuild server+worker+caddy, verifica `/health` + tabelle/colonne/enum + CI verde. Nessun cambio env/infra.

**Commit:** `docs: milestone e viste salvate`

---

## Follow-up documentato (NON in questa v1)
- **Filtro "senza milestone"** (ticket non assegnati a nessuna milestone): valore speciale nel filtro. Rimandato.
- **Avanzamento per status terminale configurabile**: oggi "completed" = stato done/finale fisso.
- **Milestone su board come swimlane/colonna**: oggi solo filtro/badge.
- **Riordino/preferenze viste salvate**: non in v1.
