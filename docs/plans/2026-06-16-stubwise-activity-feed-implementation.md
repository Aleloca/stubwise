# Feature 1 — Activity feed + audit — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (o subagent-driven-development).

**Goal:** Registrare le azioni umane sui ticket in una tabella `ticket_events` e mostrare nel dettaglio ticket un'unica timeline cronologica che fonde commenti, eventi dei job AI e voci di audit — preservando i controlli/azioni dei job AI esistenti.

**Architecture:** Tabella generica `ticket_events` scritta nella stessa transazione delle mutazioni umane (PATCH ticket). Endpoint `GET /tickets/:id/activity` che fonde a read-time `comments` + `ai_jobs` (marker di lifecycle) + `ticket_events`, ordinati per `createdAt`, ogni item con `kind` discriminante. La UI `$id.tsx` sostituisce i due componenti separati (timeline job + thread commenti) con un `ActivityFeed`, mantenendo composer commenti e bottoni azione job.

**Design:** `docs/plans/2026-06-16-stubwise-team-tracker-design.md`. **Convenzioni:** TDD, testcontainers, migrazione additiva, i18n en/it (parità), E2E Playwright se si tocca il flusso ticket (NON in `pnpm -r test`), review spec+qualità.

---

### Task 1: Schema `ticket_events`

**Files:** `packages/db/src/schema.ts` (+ enum in `packages/shared` se si segue il pattern), migrazione, `packages/db/src/schema.test.ts`.

- pgEnum `ticket_event_kind`: `status_changed, assignee_changed, priority_changed, type_changed, labels_changed, title_changed, body_changed`. (milestone_changed/relation_* arriveranno con le feature 6/2 — aggiungerli ai rispettivi task; qui solo i campi PATCH attuali.)
- `ticketEvents` pgTable: `id uuid pk`, `ticketId uuid notNull FK→tickets onDelete cascade`, `actorId uuid FK→users onDelete set null` (null = sistema/AI), `kind ticket_event_kind notNull`, `payload jsonb` (es. `{ from, to }`), `createdAt timestamptz notNull default now()`. Indice su `(ticketId, createdAt)`.
- Migrazione additiva. Test: insert/read di un evento con payload, FK cascade dal ticket.

**Commit:** `feat(db): tabella ticket_events (audit)`

---

### Task 2: Registrare gli eventi sul PATCH ticket

**Files:** `apps/server/src/routes/tickets.ts`, helper opzionale; test `tickets.test.ts`.

- Nel PATCH `/:id` (handler esistente): avvolgi in una transazione: SELECT della riga corrente → calcola i diff per ogni campo cambiato (title/body/type/priority/status/assignee/labels) → UPDATE → per ogni campo effettivamente cambiato INSERT in `ticket_events` con `actorId = request.user.id`, `kind` corrispondente, `payload {from,to}` (per labels: from/to array; per body/title: ometti il testo lungo dal payload o troncalo — registra solo che è cambiato). Niente evento se il valore non cambia (PATCH idempotente).
- Test: PATCH che cambia status+assignee → 2 righe `ticket_events` con from/to e actorId corretti; PATCH che non cambia nulla → 0 eventi; PATCH vuoto → 0 eventi.

**Commit:** `feat(server): registra ticket_events sulle modifiche umane del ticket`

---

### Task 3: Endpoint `GET /tickets/:id/activity`

**Files:** `apps/server/src/routes/tickets.ts` (o un nuovo file route), `apps/web/src/lib/api.ts`, test.

- `GET /api/tickets/:id/activity` (requireAuth): ritorna un array ordinato per `createdAt` asc, ogni item discriminato da `kind`:
  - `{ kind: "comment", id, authorType, authorId, body, createdAt }` (da `comments`);
  - `{ kind: "event", id, eventKind, actorId, payload, createdAt }` (da `ticket_events`);
  - `{ kind: "ai_job", id, status, prUrl, createdAt, finishedAt }` (da `ai_jobs` — un marker per job; il dettaglio log/cost resta nell'endpoint job esistente).
  - Includi gli `actorId`/autori risolti a nome/email dove serve (o lascia che la UI risolva via usersQuery). Schema di risposta zod come union discriminata.
- Caricamento: tre query (comments, ticket_events, ai_jobs) + merge+sort in memoria (volumi per-ticket piccoli). 404 se ticket inesistente.
- Client `api.ts`: `getTicketActivity(id)` + tipo.
- Test: ticket con commenti + eventi + job → l'endpoint li fonde nell'ordine cronologico corretto coi kind giusti; 404 ticket assente; auth.

**Commit:** `feat(server): endpoint /tickets/:id/activity (feed unificato)`

---

### Task 4: UI — ActivityFeed nel dettaglio ticket

**Files:** nuovo `apps/web/src/components/activity-feed.tsx`, `apps/web/src/routes/tickets/$id.tsx`, `apps/web/src/lib/queries.ts` (activityQueryOptions), i18n en/it, test (+ E2E).

- `ActivityFeed`: consuma `getTicketActivity`; rende ogni item per kind:
  - `comment`: come l'attuale comment-thread (autore, body markdown sanitizzato, timestamp);
  - `event`: riga di audit ("{actor} changed status: open → in_progress", "assigned to {user}", "changed priority …", "added labels …") via i18n con interpolazione; risolvi i nomi utente dalla users query;
  - `ai_job`: riga compatta con stato (riusa le label `jobStatus`) + link PR; espandibile/collegata al dettaglio job esistente.
- `$id.tsx`: sostituisci il rendering separato di `AIJobTimeline` + `CommentThread` con l'`ActivityFeed` come stream principale. **PRESERVA**: il composer dei commenti (il POST commento esistente, che invalida ora la activity query), e TUTTI i bottoni azione job (Avvia fix AI / Rilancia con istruzioni / Approva / Rifiuta) keyati su `latestJob` — restano dove sono. Il dettaglio per-job (log/cost/agent runs) resta accessibile (mantieni il componente o rendilo espandibile dall'item `ai_job`).
- Le mutazioni (commento, PATCH stato/assegnatario, run-ai/approve/reject) invalidano `activityQueryOptions(id)` oltre alle query esistenti.
- i18n: tutte le stringhe nuove (etichette audit) in en/it (parità verde).
- Test web: l'ActivityFeed rende i tre kind; un cambio stato compare come voce di audit; il composer commenti funziona. **E2E**: il flusso `core-flows.spec.ts` tocca commenti + cambio stato + timeline — adegua i selettori al nuovo feed e mantienilo verde (`pnpm --filter @stubwise/web e2e`).

**Commit:** `feat(web): activity feed unificato nel dettaglio ticket`

---

### Task 5: Docs + verifica finale

**Files:** `apps/docs/src/content/docs/getting-started/web-app.md` (o la pagina che descrive il dettaglio ticket) — documenta la timeline di attività e l'audit, in inglese. `pnpm --filter @stubwise/docs build`.

**Verifica finale:** `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @stubwise/web e2e`, `pnpm -r build`. Code review finale vs design. Deploy: backup DB, migrazione additiva, rebuild server+worker+caddy, verifica /health + tabella + CI.

**Commit:** `docs: activity feed e audit`
