# Ricerca globale (spotlight Cmd/K) — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Spotlight Cmd/K globale che cerca in Ticket, Progetti, Repository e
Documentazione, con due velocità (full-text istantaneo + semantica Docs sul debounce
lungo), cronologia unificata e palette scope-aware (dentro i Docs parte ristretta a quella
documentazione). Design: `docs/plans/2026-07-01-global-search-design.md` (decisioni D1–D6).

**Tech Stack:** Drizzle/Postgres (tsvector full-text + pgvector), Fastify+Zod,
React+TanStack, Vitest.

**Scelte confermate:** cronologia UNIFICATA (`doc_search_history` → `search_history` con
migrazione dati); snippet via `ts_headline` per ticket/docs, evidenziazione client per
progetti/repo.

**Deploy finale:** solo `server` + `caddy` (il worker NON è coinvolto). Backup DB per la
migrazione 0036.

---

## Sotto-fase 1 — Backend full-text federato + cronologia unificata (migrazione 0036)

### Task 1: modello + migrazione 0036 + endpoint `/api/search` + cronologia

**Files:** `packages/db/src/schema.ts`, migrazione `0036_*` (a mano), `packages/shared`,
`apps/server/src/routes/search.ts` (nuovo), `app.ts`, `apps/server/src/routes/docs.ts`
(cronologia Docs esistente → generalizzata), test.

**Modello (migrazione 0036, data-preserving):**
- Generalizza `doc_search_history` in **`search_history`**: `id`, `userId` (FK users
  cascade), `type` enum `search_entity` (`ticket|project|repository|doc`), `entityId`
  text, `title` text, `subtitle` text (nullable), `route` text, `repositoryId` uuid
  (nullable, FK repositories set null — per filtrare i recenti in scope Docs),
  `clickedAt` timestamptz default now. UNIQUE `(userId, type, entityId)`; indici
  `(userId, clickedAt desc)` e `(userId, repositoryId, clickedAt desc)`.
- Migrazione dati: le righe di `doc_search_history` → `search_history` con `type='doc'`,
  `entityId = repositoryId || ':' || slug`, `title` dalla vecchia, `subtitle = kind`,
  `route = '/docs/' || repositoryId || '/' || slug`, `repositoryId` conservato,
  `clickedAt`. Poi DROP `doc_search_history`. VERIFICA i nomi reali di colonne/indici
  della vecchia tabella; allinea snapshot/journal (drizzle-kit generate → No schema changes).

**Endpoint `GET /api/search` (corsia veloce, federata):** query `q` (required), `scope`
opzionale (`repositoryId` per lo scope Docs). Esegue in parallelo e ritorna raggruppato:
- **ticket**: `websearch_to_tsquery('english', q)` sull'indice esistente (titolo+body+
  commenti — verifica com'è fatto l'indice in migrazione 0017 e la query di ricerca ticket
  già presente); top-N, `ts_rank`, `ts_headline` per lo snippet, numero/stato/progetto.
- **project**: match su nome/slug/descrizione (ILIKE o tsvector minimo); top-N.
- **repository**: match su nome/slug/repoUrl; top-N.
- **doc**: full-text su `doc_pages.searchTsv` (riusa il pattern di docs-retrieval gamba
  full-text), su TUTTI i repo con generazione corrente OPPURE sul `repositoryId` dello
  scope; slug/titolo/kind/snippet (`ts_headline`) + repository.
Risposta: `{ tickets: [...], projects: [...], repositories: [...], docs: [...] }` con
top-N (es. 8) per gruppo + `hasMore` per gruppo. Auth: utente autenticato (tutto visibile).

**Cronologia:** `GET /api/search/history?scope=` (recenti dell'utente, filtrati per
`repositoryId` se scope Docs, limit N), `POST /api/search/history` (upsert su
(userId,type,entityId), prune oltre N), `DELETE /api/search/history/:type/:entityId` e
`DELETE /api/search/history` (clear). Sposta/generalizza gli endpoint history dei Docs
esistenti (in `docs.ts`) verso questo modello; mantieni funzionante la palette Docs.

**Shared:** schemi Zod per i risultati (`SearchResultGroup`, `SearchHistoryItem`) e i tipi.

**Verifiche:** `pnpm --filter @stubwise/shared build && pnpm --filter @stubwise/db typecheck && test && pnpm --filter @stubwise/server typecheck && test && eslint`; `drizzle-kit generate` → No schema changes.
**Test:** ricerca per tipo (ticket per titolo/body/commento; progetto per nome/slug; repo;
doc full-text), scope Docs limita ai doc di quel repo; cronologia CRUD/prune/filtro scope;
migrazione 0036 preserva i dati Docs.
**Commit:** `feat(search): ricerca globale full-text + cronologia unificata (0036)`.

---

## Sotto-fase 2 — Backend semantico Docs (globale + per-repo)

### Task 2: `retrieveChunksAll` + `GET /api/search/docs-semantic`

**Files:** `apps/server/src/routes/docs-retrieval.ts`, `apps/server/src/routes/search.ts`,
test.

- Aggiungi `retrieveChunksAll(db, embeddingClient, query, options)`: come
  `retrieveChunksForProject` ma su **tutti** i repo con generazione corrente (carica
  `{id, currentDocGenerationId}` di tutti i repository; stesso predicato OR-di-coppie
  per-repo, arricchimento citazioni con repository). `[]` se nessun repo documentato.
- **Endpoint `GET /api/search/docs-semantic?q=&repositoryId=`** (corsia lenta): se
  `repositoryId` presente → `retrieveChunks(repositoryId)`; altrimenti `retrieveChunksAll`.
  Ritorna i risultati Docs (slug/titolo/kind/snippet + repository + score) per fondersi nel
  gruppo Docs lato client. Auth utente.

**Verifiche:** `pnpm --filter @stubwise/server typecheck && test && eslint`.
**Test:** `retrieveChunksAll` recupera da più repo (filtro generazione per-repo, no leak);
endpoint globale e per-repo; nessun repo documentato → [].
**Commit:** `feat(search): retrieval semantico Docs globale per la ricerca`.

---

## Sotto-fase 3 — Web: palette globale scope-aware

### Task 3: `GlobalSearchPalette` + trigger Cmd/K globale + due velocità + cronologia

**Files:** `apps/web/src/components/` (generalizza `docs-command-palette.tsx` →
`global-search-palette.tsx`; adatta `docs-search-trigger.tsx`), `app-layout.tsx` (trigger
Cmd/K globale), `routes/docs/$projectId.tsx` (usa la stessa palette in scope repo),
`lib/api.ts`/`queries.ts`, i18n, test.

- **`GlobalSearchPalette`**: generalizza la palette Docs. Prop `scope: "global" | { repositoryId, repositoryName }`.
  - **Due debounce**: corto (~150 ms) → `getSearch(q, scope)`; lungo (~600 ms) →
    `getDocsSemantic(q, scope)` che rimpiazza/arricchisce il gruppo Docs (dedup per
    (repositoryId, slug), semantica prima). Annulla le richieste stantie (AbortController).
  - **Gruppi per tipo** (TKT/PRJ/REP/DOC), ~5 per gruppo + "mostra altri"; riga con sigla
    + titolo + contesto/snippet evidenziato; navigazione tastiera (frecce, Invio, Esc).
  - **Scope switch** `[ Questa documentazione ] · [ Tutto ]` (Tab), visibile solo con
    scope repo; default "questa documentazione" quando aperta dai Docs.
  - **Cronologia**: a query vuota mostra i recenti (`getSearchHistory(scope)`); click su un
    risultato → naviga + `postSearchHistory(item)`.
  - stati loading (solo skeleton sul gruppo Docs mentre gira la semantica) / empty.
- **Trigger globale**: registra Cmd/K (e Ctrl/K) in `app-layout` → apre in scope "global".
  Dentro `/docs/<repo>` il Cmd/K esistente apre la stessa palette in scope repo. Aggiungi
  un affordance visibile (icona/scorciatoia) nell'header/sidebar.
- **Navigazione risultati**: ticket → `/tickets/$id` (o la route reale), progetto →
  `/projects/$projectId`, repository → `/repositories/$slug`, doc → `/docs/$repositoryId/$slug`.
- i18n it/en (placeholder, gruppi, scope, empty, "mostra altri", cronologia).

**Verifiche:** `pnpm -r build && pnpm --filter @stubwise/web typecheck && test && eslint`;
full-repo `pnpm typecheck && pnpm lint`.
**Test:** Cmd/K globale apre; due velocità (full-text subito, semantica dopo debounce
lungo con retrieval mockato → il gruppo Docs si arricchisce); gruppi + navigazione
tastiera; scope switch dentro i Docs (default repo, Tab → Tutto); cronologia (recenti a
vuoto, click registra); la ricerca **interna ai Docs non regredisce** (i test della palette
Docs esistente restano verdi, adattati al nuovo componente).
**Commit:** `feat(web): spotlight Cmd/K di ricerca globale scope-aware`.

---

## Sotto-fase 4 — Verifica finale + review + consegna

### Task 4: verifica full-repo + review olistico

- `pnpm -r build && pnpm typecheck && pnpm lint && pnpm test`.
- Review olistico cross-layer: coerenza `/api/search` ↔ palette; due velocità corretta
  (nessun leak di richieste stantie); scope Docs preserva il comportamento attuale;
  migrazione 0036 senza drift e dati preservati; cronologia unificata coerente.
- REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch. Deploy: `server` +
  `caddy` (worker non coinvolto); backup DB per la migrazione. Merge su main.

---

## Note

- La palette Docs esistente e la sua UX NON devono regredire: la nuova componente la
  sostituisce mantenendo comportamento identico in scope repo.
- Due velocità: attenzione a cancellare le richieste stantie (query che cambia mentre la
  semantica è in volo) — AbortController + guardia sull'ultima query.
- Migrazione cronologia: se la migrazione dati risultasse rischiosa/complessa, fallback
  documentato = affiancare `search_history` e lasciare `doc_search_history` (ma l'obiettivo
  è unificare).
