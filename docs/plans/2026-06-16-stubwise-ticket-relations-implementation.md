# Feature 2 — Relazioni tra ticket — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development.

**Goal:** Collegare i ticket tra loro (blocca / relativo / sotto-task), mostrarli nel dettaglio ticket ("Linked tickets") e registrare le aggiunte/rimozioni nell'activity feed.

**Architecture:** Tabella `ticket_links` con kind canonici (`blocks`, `relates_to`, `parent`); le inverse (`blocked_by`, `child`) si derivano interrogando i link dove il ticket è target. Add/remove registrano `ticket_events` (`relation_added`/`relation_removed`) su entrambi i ticket coinvolti, così la voce compare nel feed di entrambi (feature 1). Picker che cerca per numero/titolo via l'endpoint lista ticket esistente (FTS arriverà con la feature 3).

**Design:** `docs/plans/2026-06-16-stubwise-team-tracker-design.md`. **Convenzioni:** TDD, testcontainers, migrazione additiva, i18n en/it (parità), E2E se si tocca il flusso ticket, review spec+qualità.

---

### Task 1: Schema `ticket_links` + eventi relazione

**Files:** `packages/db/src/schema.ts` (+ eventuale zod in `packages/shared`), migrazione, `schema.test.ts`.

- Aggiungi i valori `relation_added`, `relation_removed` al pgEnum `ticket_event_kind` (ALTER TYPE ADD VALUE, additivo — drizzle lo gestisce; verifica che non sia combinato in transazione con un uso immediato).
- pgEnum `ticket_link_kind`: `blocks`, `relates_to`, `parent`.
- Tabella `ticketLinks`: `id uuid pk`, `sourceTicketId uuid notNull FK→tickets onDelete cascade`, `targetTicketId uuid notNull FK→tickets onDelete cascade`, `kind ticket_link_kind notNull`, `createdAt timestamptz notNull default now`. Indici su `sourceTicketId` e `targetTicketId`. **Unique** su `(sourceTicketId, targetTicketId, kind)` (dedup della stessa relazione).
- Test: insert/read di un link; FK cascade dal ticket (cancellando un ticket spariscono i suoi link in entrambe le direzioni); unique impedisce il duplicato (sourceTicketId,targetTicketId,kind).

**Commit:** `feat(db): tabella ticket_links + eventi relation_added/removed`

---

### Task 2: Server — endpoint relazioni

**Files:** `apps/server/src/routes/tickets.ts` (o nuovo file), `apps/web/src/lib/api.ts`, test.

- **POST `/api/tickets/:id/links`** (requireAuth), body `{ targetTicketId: uuid, kind: ticketLinkKind }`:
  - 404 se il ticket `:id` o il target non esistono;
  - 400 se `targetTicketId === id` (no self-link, code `self_link`);
  - 400/409 se il target è di un PROGETTO diverso (le relazioni hanno senso intra-progetto; code `cross_project_link`) — verifica che source e target abbiano lo stesso `projectId`;
  - dedup: se esiste già `(source=id, target, kind)` → 409 (`link_exists`) oppure no-op idempotente (scegli 409 per chiarezza);
  - in transazione: INSERT del link + INSERT di DUE `ticket_events` `relation_added` — uno sul ticket `:id` (payload `{ kind, direction:"outgoing", otherTicketId, otherNumber }`) e uno sul target (payload `{ kind, direction:"incoming", otherTicketId:id, otherNumber }`), `actorId = request.user.id`. Così la relazione compare nel feed di entrambi.
  - risposta 201 col link creato (id, source, target, kind).
- **DELETE `/api/tickets/:id/links/:linkId`** (requireAuth): 404 se il link non esiste o non coinvolge `:id`; in transazione DELETE + DUE `ticket_events` `relation_removed` (sui due ticket coinvolti). 204.
- **GET `/api/tickets/:id/links`** (requireAuth): ritorna i link che coinvolgono `:id` (sia come source sia come target), risolti col ticket "altro" (`otherTicketId, otherNumber, otherTitle, otherStatus`) e una **`relation` dal punto di vista di `:id`**: se `:id` è source → la kind canonica (`blocks`/`relates_to`/`parent`); se `:id` è target → la inversa (`blocked_by`/`relates_to`/`child`). Così la UI mostra "blocked by #N", "blocks #N", "relates to #N", "parent of #N", "child of #N".
- Client `api.ts`: `getTicketLinks(id)`, `createTicketLink(id, {targetTicketId, kind})`, `deleteTicketLink(id, linkId)` + tipi.
- Test (testcontainers): create link → 201 + link presente + 2 ticket_events relation_added (uno per ticket, direction giusta); self-link → 400; cross-project → 400; duplicato → 409; GET links risolve la relazione dal punto di vista del ticket (source→canonica, target→inversa) coi dati dell'altro ticket; DELETE → 204 + 2 relation_removed + link sparito; 404/401.

**Commit:** `feat(server): endpoint relazioni tra ticket (create/list/delete) + eventi`

---

### Task 3: Web — "Linked tickets" + picker + feed

**Files:** nuovo `apps/web/src/components/ticket-links.tsx`, `apps/web/src/routes/tickets/$id.tsx`, `apps/web/src/components/activity-feed.tsx` (relation_*), `apps/web/src/lib/queries.ts`, i18n, test (+ E2E se serve).

- Sezione **"Linked tickets"** nel dettaglio ticket: lista i link (`getTicketLinks`) raggruppati/etichettati per relazione ("Blocks", "Blocked by", "Relates to", "Parent of", "Child of") con link al ticket collegato (numero + titolo + badge stato). Bottone "Link ticket" che apre un picker.
- **Picker**: input di ricerca che interroga l'endpoint lista ticket esistente (`q` su titolo, filtrato per projectId del ticket corrente) + select della relazione (Blocks/Relates to/Parent) → `createTicketLink`. Escludi il ticket stesso e i già collegati. (FTS migliorerà la ricerca con la feature 3; per ora `q` ILIKE basta.)
- Rimozione: bottone "remove" su ogni link → `deleteTicketLink`, con conferma leggera.
- **Activity feed**: in `describeEvent` aggiungi i case `relation_added`/`relation_removed` → testo i18n (es. "{actor} linked this ticket: blocks #{n}" / "removed link: …") usando `payload.kind`/`direction`/`otherNumber`. (Le label delle relazioni vanno in i18n.)
- Invalidazioni: create/delete link invalidano `getTicketLinks(id)` E `activityQueryOptions(id)` (e idealmente quella del ticket collegato se in cache).
- i18n: tutte le stringhe (label relazioni, "Linked tickets", "Link ticket", eventi relation_*) in en/it (parità).
- Test web: TicketLinks rende i link con le label giuste; il picker crea un link; la rimozione; il feed mostra l'evento relazione. Mocka gli endpoint. **E2E**: opzionale — se aggiungi un flusso relazioni a core-flows, esegui `pnpm --filter @stubwise/web e2e`; altrimenti assicurati che gli E2E esistenti restino verdi (il dettaglio ticket cambia).

**Commit:** `feat(web): relazioni tra ticket (Linked tickets + picker + feed)`

---

### Task 4: Docs + verifica finale

**Files:** `apps/docs/.../getting-started/web-app.md` (sezione dettaglio ticket): documenta i Linked tickets e i tipi di relazione, in inglese. `pnpm --filter @stubwise/docs build`.

**Verifica finale:** `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @stubwise/web e2e`, `pnpm -r build`. Code review finale vs design. Deploy: backup DB, migrazione additiva, rebuild server+worker+caddy, verifica /health + tabella + CI. Nessun cambio env/infra.

**Commit:** `docs: relazioni tra ticket`
