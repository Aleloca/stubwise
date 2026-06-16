# Feature 3 — Ricerca full-text — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development.

**Goal:** La ricerca ticket (`q`) cerca in **titolo + body + commenti** con Postgres full-text (tsvector + GIN), invece del solo `ILIKE` sul titolo.

**Architecture:** Colonna generata `tickets.search_tsv tsvector` (`to_tsvector('english', title || body)`) + indice GIN; indice GIN espressivo sui commenti (`to_tsvector('english', body)`). Il list endpoint sostituisce il filtro `ILIKE` con `search_tsv @@ websearch_to_tsquery('english', q) OR EXISTS(comment match)`. **L'ordinamento cronologico e il cursor keyset `(createdAt,id)` restano invariati** (paginazione solida). L'ordinamento per rilevanza (`ts_rank`) è un follow-up documentato, NON in questa v1.

**Design:** `docs/plans/2026-06-16-stubwise-team-tracker-design.md`. **Convenzioni:** TDD, testcontainers, migrazione additiva, i18n en/it, E2E se si tocca il flusso, review spec+qualità. Dizionario `english`.

---

### Task 1: Schema/migrazione — tsvector + indici GIN

**Files:** `packages/db/src/schema.ts`, migrazione (probabilmente **hand-written**, vedi nota), `schema.test.ts`.

- **`tickets.search_tsv`**: colonna `tsvector` GENERATA STORED da `to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))` (il form 2-arg con regconfig costante è IMMUTABLE → ammesso in generated column) + indice GIN su `search_tsv`.
- **Commenti**: indice GIN espressivo `CREATE INDEX ... ON comments USING gin (to_tsvector('english', body))`.
- **Nota drizzle-kit + tsvector**: drizzle-kit spesso non genera/introspeziona bene tsvector e generated columns. Strategia: dichiara la colonna nello schema con un `customType` `tsvector` + `.generatedAlwaysAs(sql\`...\`, { mode: "stored" })` (drizzle ≥0.30 supporta generated). Esegui `drizzle-kit generate` e **VERIFICA il SQL**; se è corretto e idempotente (un secondo `generate` non produce diff), usalo. Se drizzle-kit lo gestisce male, scrivi la migrazione A MANO (ADD COLUMN ... GENERATED ... STORED + i due CREATE INDEX) e allinea lo snapshot perché un futuro `generate` non tenti di droppare/ricreare. L'indice GIN espressivo sui commenti quasi certamente va a mano (drizzle non modella le expression index). Documenta cosa hai fatto.
- Additiva e sicura (colonna generata + indici; nessun ALTER distruttivo). Su una tabella popolata, la generated column si calcola per le righe esistenti al momento dell'ADD COLUMN.

**Test (testcontainers):**
- inserisci ticket con title/body noti → query raw `select ... where search_tsv @@ websearch_to_tsquery('english', 'parola')` trova il ticket per parola nel body (non solo titolo);
- stemming: una query con la forma flessa (es. "logging" trova "log"/"logs") matcha;
- l'indice GIN sui commenti: `to_tsvector('english', body) @@ query` su un commento noto matcha.
(Asserzioni via query drizzle/sql sul DB reale.)

**Commit:** `feat(db): tsvector full-text su ticket + indici GIN (ticket, commenti)`

---

### Task 2: Server — `q` full-text su titolo+body+commenti

**Files:** `apps/server/src/routes/tickets.ts`, test `tickets.test.ts`.

- Nel list endpoint, sostituisci `if (q) conditions.push(ilike(tickets.title, ...))` con un filtro FTS:
  ```ts
  if (q) {
    const tsq = sql`websearch_to_tsquery('english', ${q})`;
    conditions.push(sql`(
      ${tickets.searchTsv} @@ ${tsq}
      OR EXISTS (
        SELECT 1 FROM ${comments} c
        WHERE c.ticket_id = ${tickets.id}
          AND to_tsvector('english', c.body) @@ ${tsq}
      )
    )`);
  }
  ```
  Usa `websearch_to_tsquery` (tollerante a input arbitrario dell'utente: niente errori di sintassi su caratteri speciali → NON serve escaping come per ILIKE; rimuovi `escapeLike` per il path q se non più usato altrove). Mantieni `and(...conditions)`, il cursor keyset `(createdAt,id)` e l'`orderBy(desc createdAt, desc id)` INVARIATI.
- (Opzionale, se semplice) se `q` è vuoto/whitespace dopo trim → nessun filtro FTS.

**Test (testcontainers):**
- `q` matcha una parola nel **body** (non nel titolo) → il ticket compare;
- `q` matcha una parola in un **commento** del ticket → il ticket compare;
- stemming (forma flessa matcha la radice);
- `q` con caratteri speciali (es. `"a & b"`, `:`, `!`) NON causa 500 (websearch_to_tsquery è tollerante) → 200, risultati coerenti;
- la **paginazione** col cursor continua a funzionare con q attivo (inserisci > limit ticket che matchano, verifica le due pagine);
- i filtri combinati (projectId/status + q) funzionano insieme;
- nessun match → array vuoto.

**Commit:** `feat(server): ricerca full-text su titolo+body+commenti`

---

### Task 3: Web — placeholder/etichetta ricerca

**Files:** `apps/web/src/components/ticket-filters.tsx`, i18n `en.json`/`it.json`, test se presente.

- Aggiorna `tickets:filters.searchPlaceholder` (e/o un piccolo hint) per riflettere che la ricerca ora copre titolo, descrizione e commenti (es. placeholder "Search title, description, comments…"). Nessun cambio di logica (il param `q` è già inviato). Parità i18n en/it.
- Se c'è un test sul placeholder, aggiornalo.

**Commit:** `feat(web): la ricerca copre titolo, descrizione e commenti (placeholder)`

---

### Task 4: Docs + verifica finale

**Files:** `apps/docs/.../getting-started/web-app.md` (sezione ricerca/lista ticket): documenta che la ricerca è full-text su titolo+body+commenti (Postgres, stemming inglese). In inglese. `pnpm --filter @stubwise/docs build`.

**Verifica finale:** `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @stubwise/web e2e`, `pnpm -r build`. Code review finale vs design. Deploy: backup DB, migrazione additiva, rebuild server+worker+caddy, verifica /health + colonna/indici + CI. Nessun cambio env/infra.

**Commit:** `docs: ricerca full-text`

---

## Follow-up documentato (NON in questa v1)
- **Ordinamento per rilevanza (`ts_rank`)**: ordinare i risultati di ricerca per punteggio invece che cronologicamente, con cursor esteso a `(rank, createdAt, id)`. Rimandato per non rielaborare la paginazione keyset; la v1 ship il *matching* full-text (il valore principale) con ordinamento cronologico invariato.
- **Stemming multilingua**: oggi dizionario `english`; i contenuti italiani sono cercabili per match esatto ma senza stemming italiano.
