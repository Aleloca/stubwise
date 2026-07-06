# Fase 3 auto-update — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** L'auto-update crea incrementalmente pagine docs per le aree NUOVE del repo (file non coperti da alcuna pagina), appendendole alla generazione corrente, entro un tetto configurabile.

**Architecture:** Aggregazione deterministica dei file nuovi in aree → mini-orient (1 run agente: fino a N proposte {titolo, kind, parentSlug, sourcePaths}) → un run explore-style per proposta (solo body) → insert per-pagina in transazione nella generazione corrente (slug dedupato, chunks embeddati) → update stats/cost → release note con "Pagine create" e residuo.

**Design:** `docs/plans/2026-07-06-docs-autoupdate-phase3-design.md` — leggi anche i fatti chiave sotto, presi da ricognizione verificata.

**Fatti chiave dal codice (verificati — usali, non re-derivarli):**
- `mapAffectedPages(changedFiles, pages, maxPages)` in `packages/docs-engine/src/affected-pages.ts:75` → `{affected, newAreas: string[], truncated}`; le newAreas sono FILE path dedupati/ordinati, SENZA tetto; copertura via `pathCovers` (`recursive/dag.ts:32`).
- Fase 2: `refreshAffectedPages` (`apps/worker/src/docs/auto-update.ts:402-513`) — worktree effimero `deps.mirrors.withWorktree(ctx.mirrorProject, REFRESH_BRANCH, cb)` (`:431`), run `deps.runner.run({cwd, prompt, model, permissionMode: "plan", maxTurns, timeoutMs, provider})`, update per-pagina in `db.transaction` con `DELETE doc_chunks` + `embedAndStoreChunks(tx, embeddingClient, {repositoryId, generationId, pages: [{id, body, kind, sourcePath}], batchSize: EMBED_BATCH_SIZE})`. Best-effort per pagina. ⚠️ Oggi `mapAffectedPages` gira SOLO se `maxRefreshPages > 0` (gate a `:600`).
- Prompt riusabile: `buildExplorePrompt` (`packages/docs-engine/src/recursive/explore.ts:109`, input `{tree, unitRef, title, parentContext, ancestorTitles?}`), parser `parseExploreOutput` (`:200`) → `{body, children, sourcePaths}` | `{reason}`. Marcatori/helper: `packages/docs-engine/src/markers.ts` (`parseDelimitedBody`, `baseSlug`, `makeUniqueSlug`, `isMetaSummary`), `slugForNode(title, used)` in `recursive/dag.ts:107`.
- Insert pagine (modello finalize, `apps/worker/src/docs/recursive/finalize.ts:227-241`): campi `{repositoryId, generationId, kind, slug, title, parentId, position, sourcePath, body, links}`. Unique `(generation_id, slug)` (`schema.ts:1209`). `position` è ordinale globale nella generazione; sidebar ordina `kind, position, title`.
- `doc_generations.stats` (`{nodes, doneNodes, failedNodes, maxDepth, pages, chunks}`) e `cost` sono scritti SOLO alla finalize → la Fase 3 deve aggiornarli con UPDATE espliciti.
- Retrieval/albero: pagina con `generationId` = generazione corrente è AUTOMATICAMENTE visibile (predicato `generation_id = current OR IS NULL`).
- Release: `ReleaseInput` (`packages/docs-engine/src/releases.ts:59-77`) ha già `refreshedPages?`/`newAreas?` opzionali con blocchi prompt; `buildRelatedLinks` in auto-update filtra sugli `existingPages` caricati PRIMA (le pagine create non passerebbero: va esteso il lookup). Sezione deterministica `newAreasSection(newAreas, truncated)` (`auto-update.ts:516-533`).
- Config worker: pattern `DOCS_AUTOUPDATE_MAX_PAGES` → `docsAutoUpdateMaxPages` (default 10) in `apps/worker/src/config.ts:277,441,509` → `index.ts:246` → `RunAutoUpdateDeps.maxRefreshPages`.
- Runner: `AgentRunResult.usage?.totalCostUsd` per il costo; exit non-zero è risultato valido; `AgentTimeoutError` con partialOutput.
- Test worker: cerca i test esistenti di auto-update (`apps/worker/src/docs/auto-update*.test.ts`) per il pattern (testcontainers + runner finto).

**Regole trasversali:** TDD; commit con `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; dopo modifiche a docs-engine: rebuild package + `pnpm typecheck` dalla RADICE del worktree; `pnpm lint` root nel task finale. NON toccare la superficie server/web.

---

### Task 1: docs-engine — aggregazione aree + contratto mini-orient + createdPages nel release

**Files:**
- Create: `packages/docs-engine/src/grow.ts` + `packages/docs-engine/src/grow.test.ts`
- Modify: `packages/docs-engine/src/releases.ts` (+ test esistente)
- Modify: `packages/docs-engine/src/index.ts` (export)

**1a. Aggregazione deterministica** (`grow.ts`):

```ts
export interface NewArea { path: string; files: string[] }
export function aggregateNewAreas(files: string[], opts?: { minGroup?: number; maxDepth?: number }): NewArea[]
```
Regola (dal design): raggruppa per cartella; risali accorpando finché il gruppo è < minGroup (default 2) E la profondità > maxDepth (default 2); file isolato → la sua cartella (o path del file se in radice). Deterministica (ordinamento lessicografico), dedup. TDD con casi: 30 file sotto `admin-app/src/**` → 1 area `admin-app` (o `admin-app/src` secondo la regola — fissa la scelta nei test); file isolato in cartella profonda; file in radice; due gruppi distinti; lista vuota → [].

**1b. Contratto mini-orient** (`grow.ts`):

```ts
export interface GrowProposal { title: string; kind: "technical" | "functional"; parentSlug: string | null; sourcePaths: string[] }
export function buildGrowOrientPrompt(input: {
  areas: NewArea[];
  existingPages: { slug: string; title: string; kind: string; depth?: number }[]; // overview/di primo livello
  maxPages: number;
  commitSubjects: string[];
}): string
export function parseGrowOrientOutput(output: string): GrowProposal[]  // best-effort, mai throw
```
Prompt in stile `releases.ts`/`refresh-page.ts` (leggi quelli): istruzioni + contratto a marcatori (es. `===PROPOSAL===` righe `title:`/`kind:`/`parent:`/`paths:` … `===END PROPOSALS===`), read-only, max `maxPages` proposte, kind obbligatorio technical|functional, parentSlug tra gli slug forniti o vuoto. Parser: righe malformate/kind invalido → proposta scartata; più di maxPages → tronca. TDD (output valido, malformato, vuoto, kind invalido, oltre il tetto).

**1c. Release**: `ReleaseInput` + `createdPages?: { slug: string; title: string }[]` con blocco prompt "DOCUMENTATION PAGES CREATED FOR NEW AREAS" (pattern esatto di `refreshedPages`, righe ~122-130). Test nel test esistente di releases.

**Verifiche:** `pnpm --filter @stubwise/docs-engine test` verde, build, `pnpm typecheck` root. Commit `feat(docs-engine): aggregazione aree nuove e contratto mini-orient`.

---

### Task 2: Worker — Fase 3 in auto-update

**Files:**
- Modify: `apps/worker/src/docs/auto-update.ts`
- Test: il/i test esistenti di auto-update (estendi; se serve, file dedicato `auto-update-grow.test.ts` accanto, stesso setup)

**2a. Gate/indipendenza:** `refreshAffectedPages` oggi salta tutto se `maxRefreshPages === 0`. Refactor: `mapAffectedPages` gira se `maxRefreshPages > 0 || maxNewPages > 0`; la parte refresh rispetta il suo tetto (0 = salta i refresh ma calcola comunque newAreas); il worktree si apre se almeno una fase deve girare.

**2b. `growNewAreaPages`** (stessa struttura best-effort di refresh, DENTRO lo stesso `withWorktree`):
1. `aggregateNewAreas(newAreas)`; se vuoto → return vuoto.
2. Carica il contesto albero: pagine della generazione corrente con depth implicita (usa parentId null / primo livello: `parentId IS NULL` o figli diretti delle radici — scegli il set più utile: radici + primo livello, slug/title/kind).
3. Mini-orient: 1 run col prompt 1b; parse → proposte (cap `maxNewPages`).
4. Per ogni proposta: run explore-style — usa `buildExplorePrompt({tree: kind, unitRef: sourcePaths[0], title, parentContext: <titolo+slug del parent o "root">})` (verifica firma reale e adatta); parse con `parseExploreOutput`; usa SOLO `body` (e `sourcePaths` raffinati se presenti); body vuoto/`isMetaSummary` → scarto.
5. Insert in `db.transaction` per pagina:
   - `used` = select slug della generazione (fresco a ogni pagina); `slug = slugForNode(title, used)`;
   - `parentId` = pageId del parentSlug (se non trovato → null);
   - `position` = `max(position)+1` della generazione (select for update non serve: auto-update è serializzato per-repo);
   - insert doc_pages + `embedAndStoreChunks(tx, ..., pages: [{id, body, kind, sourcePath}])`.
6. Accumula `createdPages: {slug,title}[]`, `growCost` (Σ usage.totalCostUsd), `residualAreas` (aree senza pagina: scartate/fallite/oltre tetto).
7. Dopo il ciclo: UPDATE `doc_generations` → `stats.pages += createdPages.length`, `stats.chunks += chunkCount totale`, `cost += growCost` (jsonb update leggendo stats correnti; attento a stats null).

**2c. Release note:** passa `createdPages` a `buildReleasePrompt`; estendi il lookup di `buildRelatedLinks` con le pagine create (slug+title); `newAreasSection(residualAreas, truncated)` — le aree documentate NON compaiono più; il suggerimento "rigenerazione completa" resta solo se residuo non vuoto (già così per costruzione della funzione: verifica).

**Test integrazione (runner finto che risponde a copione: 1ª chiamata = output mini-orient, successive = output explore):**
1. Push con area nuova → pagina creata nella generazione corrente: slug/kind/parentId/position/sourcePath giusti, chunks embeddati (count > 0), visibile da una query col predicato del retrieval.
2. Slug collidente col titolo esistente → suffisso `-2`.
3. Body vuoto dall'explore → nessuna pagina, area nel residuo, release note la elenca.
4. Tetto `maxNewPages: 1` con 2 proposte → 1 pagina, residuo 1.
5. `maxNewPages: 0` → Fase 3 spenta (nessun run oltre ai refresh).
6. Fase 3 attiva con `maxRefreshPages: 0` → newAreas calcolate e pagine create (gate fixato).
7. stats/cost della generazione aggiornati.
8. Release note: blocco pagine create presente, residuo corretto, cross-link della entry includono la pagina creata.
9. I test esistenti di auto-update restano TUTTI verdi.

**Verifiche:** test auto-update verdi, `pnpm --filter @stubwise/worker typecheck`, eslint. Commit `feat(worker): Fase 3 auto-update — pagine incrementali per aree nuove`.

---

### Task 3: Config + compose + guida

**Files:**
- Modify: `apps/worker/src/config.ts` (+ test config esistente), `apps/worker/src/index.ts`, `docker-compose.yml`
- Modify: `apps/docs/src/content/docs/` — la pagina che documenta l'auto-update docs (cercala; se esiste una sezione sulle release note/auto update, aggiorna lì; altrimenti aggiungi una sottosezione nella pagina docs più pertinente)

1. `DOCS_AUTOUPDATE_MAX_NEW_PAGES` (pattern esatto di `DOCS_AUTOUPDATE_MAX_PAGES`: schema Zod preprocess+coerce int min 0 default 5, campo `docsAutoUpdateMaxNewPages`, mapping) → `index.ts` → `RunAutoUpdateDeps.maxNewPages`. Test config: default + lettura env + 0 valido.
2. `docker-compose.yml`: env al servizio worker col default (pattern delle env widget/embedding).
3. Guida: paragrafo su cosa fa la Fase 3 (pagine automatiche per aree nuove, tetto, residuo nella release note). Build docs verde.

**Verifiche:** config test, docs build, typecheck root. Commit `feat(worker): tetto configurabile Fase 3 e guida`.

---

### Task 4: Verifica finale

`pnpm build && pnpm typecheck && pnpm test && pnpm lint` dalla radice del worktree, tutti verdi. Poi review finale complessiva.

**Fuori scope:** ricalcolo related esistenti, children delle proposte, bottone on-demand.
