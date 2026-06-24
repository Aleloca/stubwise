# Auto-aggiornamento Docs — Fase 2 (Rigenerazione mirata) — Piano

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Estendere l'auto-update (Fase 1, già live) così che, oltre a creare la
entry `releases`, **rigeneri in-place SOLO le pagine di documentazione toccate dal
push** (mappate dal diff via `sourcePath`), aggiornando corpo + commitSha +
re-embedding dei chunk; le aree NUOVE non mappate vengono **segnalate** nella entry.

**Design:** `docs/plans/2026-06-24-docs-auto-update-design.md` (sezione Fase 2).

**Punto d'innesto:** `apps/worker/src/docs/auto-update.ts` → `runAutoUpdate`. Oggi:
diff → gate rumore → provider → existingPages → agente release → insert entry →
avanza commitSha. La Fase 2 inserisce, PRIMA dell'insert della entry, lo step di
rigenerazione mirata, e arricchisce la entry con le pagine aggiornate + le aree nuove.

**Riuso:** `embedAndStoreChunks` (`apps/worker/src/docs/embed.ts`), `mirrors.withWorktree`
(`apps/worker/src/git/mirrors.ts`), il pattern dell'agente di explore/synthesize
(`apps/worker/src/docs/recursive/`), il contratto a marcatori del motore.

---

## Task 1: Mapping file cambiati → pagine impattate (+ aree nuove)

**Files:** nuovo `packages/docs-engine/src/affected-pages.ts` (pura) + test;
oppure, se preferisci tenerlo lato worker, `apps/worker/src/docs/affected-pages.ts`.
(Scegli docs-engine se la logica è pura e testabile senza DB — consigliato.)

**Logica (pura).** Dati `changedFiles: string[]` e
`pages: { id, slug, title, sourcePath: string|null, parentId: string|null }[]`:
- per ogni file cambiato, trova la pagina **più specifica** che lo "copre": la
  pagina il cui `sourcePath` (non null) è uguale al file OPPURE è una **directory
  antenata** del file (prefisso di path con `/`). "Più specifica" = `sourcePath` più
  lungo. (Normalizza i path: niente slash iniziale, confronto per segmenti per non
  far matchare `src/au` con `src/auth`.)
- L'insieme **affected** = unione, su tutti i file, di { pagina più specifica } ∪
  { la sua pagina-genitore via `parentId` } (un livello, per la coerenza
  dell'overview). Dedup per id.
- **newAreas** = i file cambiati per cui NESSUNA pagina li copre (né esatta né
  antenata) → aree non documentate.
- Applica un **tetto** `maxPages` (parametro): se `affected` lo supera, tieni le
  prime `maxPages` (priorità: pagine con match esatto/più profondo prima) e
  ritorna anche `truncated: number` (quante scartate).
Ritorna `{ affected: Page[], newAreas: string[], truncated: number }`.

**Test:** match esatto, match per directory antenata (più specifica vince),
inclusione del genitore, file non mappato → newArea, tetto/troncamento, pagine con
`sourcePath` null ignorate.

**Verifiche:** `pnpm --filter @stubwise/docs-engine typecheck && test && build`.
**Commit:** `feat(docs-engine): mapping file cambiati → pagine impattate (+ aree nuove)`.

---

## Task 2: Agente "refresh pagina"

**Files:** nuovo `packages/docs-engine/src/refresh-page.ts` (prompt + parser) + test;
estendere `index.ts` per l'export.

**Prompt (`buildRefreshPagePrompt`).** Input:
`{ title, sourcePath, currentBody, changedFiles (relativi a questa pagina), commitSubjects }`.
Istruzioni: l'agente gira nel **worktree al toSha** (cwd = worktree, read-only
`plan`), DEVE leggere il codice attuale sotto `sourcePath` e produrre il corpo
markdown AGGIORNATO della pagina, conservando struttura/stile della pagina esistente
e correggendo solo ciò che è cambiato. Contratto a marcatori come gli altri agenti:
- un marcatore di "no-op" (es. `===NO CHANGE===`) se la pagina è ancora corretta
  (così non si riscrive inutilmente né si ri-embedda);
- altrimenti `===UPDATED PAGE===` + il corpo markdown completo.

**Parser (`parseRefreshedPage`).** Ritorna `{ kind: "unchanged" } | { kind: "updated", body: string }`.
Default prudente: marcatori mancanti/output vuoto → `unchanged` (non si tocca la pagina).

**Test:** output con `UPDATED PAGE` → updated+body; `NO CHANGE` → unchanged; output
malformato/vuoto → unchanged.

**Verifiche:** `pnpm --filter @stubwise/docs-engine typecheck && test && build`.
**Commit:** `feat(docs-engine): agente refresh-pagina (prompt + parser)`.

---

## Task 3: Integrazione in `runAutoUpdate` (rigenerazione + re-embed + entry arricchita)

**Files:** `apps/worker/src/docs/auto-update.ts`, `apps/worker/src/config.ts`
(+`config.test.ts`), `apps/worker/src/index.ts` (passare `embeddingClient` e il cap
alle deps del poller/handler), `apps/worker/src/docs/auto-update-poller.ts` (propagare
le nuove deps), test `auto-update.test.ts`.

**Step 1 — deps & config.** Aggiungi a `RunAutoUpdateDeps`:
`embeddingClient` (il client di embedding, stesso usato in finalize),
`maxRefreshPages` (cap, da config). Nuova env `DOCS_AUTOUPDATE_MAX_PAGES` (default
10, 0 = disabilita la rigenerazione mirata lasciando solo la entry release). Wira
`embeddingClient` e il cap dal `index.ts`/poller (il worker ha già un
`embeddingClient`: cerca dove `finalize` lo riceve).

**Step 2 — carica pagine con id/parentId.** Estendi `loadExistingPages` (o aggiungi
una funzione) per restituire anche `id` e `parentId` (servono al mapping e
all'update). Mantieni `ExistingPage` (slug/title/sourcePath) per l'agente release.

**Step 3 — rigenerazione mirata (PRIMA dell'insert della entry).** Se
`maxRefreshPages > 0` e c'è una `currentDocGenerationId`:
- `mapping = mapAffectedPages(material, pagesWithIds, maxRefreshPages)` (Task 1).
- se `mapping.affected` non è vuoto: apri il worktree al toSha con
  `mirrors.withWorktree(ctx.mirrorProject, <branchName>, async (dir) => { ... })`
  (usa il defaultBranch / un branch effimero come fa l'orientamento; l'agente gira
  con `cwd: dir`). Per ogni pagina affected:
  - costruisci `buildRefreshPagePrompt({...})` con i file cambiati che la riguardano;
  - run dell'agente (stesso provider risolto, `permissionMode: "plan"`, model/timeout/maxTurns);
  - `parseRefreshedPage(output)`: se `updated` → `update(docPages).set({ body, commitSha: toSha }).where(id)`, poi **re-embed**: `delete(docChunks).where(eq(pageId, page.id))` e `embedAndStoreChunks(db, embeddingClient, { projectId, generationId: currentDocGenerationId, pages: [{ id, body: newBody, kind, sourcePath }], batchSize: EMBED_BATCH_SIZE })`. Se `unchanged` → niente.
  - best-effort per pagina: un refresh fallito (agente o embed) logga e prosegue con le altre, NON aborta l'intero auto-update.
  - raccogli `updatedSlugs` (le pagine effettivamente aggiornate).
- Nota: `commitSha` delle pagine aggiornate va a `toSha`; le pagine non toccate restano col loro commitSha.

**Step 4 — entry release arricchita.** Passa all'agente release (estendi
`buildReleasePrompt` in docs-engine, additivo) anche `refreshedPages` (slug+title
aggiornati) e `newAreas` (path), così il corpo del changelog li menziona
coerentemente. Inoltre, in modo DETERMINISTICO:
- i `links` related della entry = unione di `updatedSlugs` (Task 3) e degli
  `affectedSlugs` dell'agente (entrambi filtrati a slug esistenti);
- se `mapping.newAreas` non è vuoto, garantisci che la entry lo segnali: o
  l'agente lo scrive (perché glielo passi nel prompt), oppure appendi
  deterministicamente in coda al body una sezione "Aree nuove non documentate: …".
  Scegli l'approccio più robusto (consiglio: passarlo al prompt E appendere un
  fallback deterministico solo se l'agente lo omette — oppure semplicemente
  append deterministico, più prevedibile).

**Step 5 — test (`auto-update.test.ts`, fake runner + fake embed).**
- diff che tocca il sourcePath di una pagina esistente → quella pagina viene
  aggiornata in-place (body cambiato, commitSha=toSha) e i suoi chunk ri-embeddati
  (verifica delete+insert via un FakeEmbeddingClient o contando i doc_chunks);
- l'agente che ritorna `NO CHANGE` → pagina NON toccata, niente re-embed;
- pagine non impattate → invariate;
- file non mappato → compare in newAreas e nella entry release;
- `maxRefreshPages=0` → nessuna rigenerazione, solo la entry (comportamento Fase 1);
- tetto superato → solo le prime N aggiornate, `truncated` segnalato;
- un refresh che fallisce su una pagina non blocca le altre né la entry.
Riusa i fake esistenti dei test docs (FakeAgentRunner, FakeEmbeddingClient — cerca
come finalize/embed sono testati).

**Verifiche:** `pnpm --filter @stubwise/docs-engine build && pnpm --filter @stubwise/worker typecheck && pnpm --filter @stubwise/worker test && pnpm lint`.
**Commit:** `feat(worker): rigenerazione mirata delle pagine toccate + re-embed nell'auto-update`.

---

## Task 4: Verifica finale + deploy (Fase 2)

**Step 1.** Dalla radice del worktree: `pnpm typecheck && pnpm lint`, poi i test
per-package toccati (docs-engine, worker). `-r test` flaky con testcontainers → per-package.

**Step 2.** REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch (merge su main).

**Step 3.** Deploy: `worker` (logica auto-update) — niente migrazioni in Fase 2, niente
modifiche server/UI (le pagine aggiornate e la entry si renderizzano già). Worker
ricostruito a generazioni ferme (fail-on-restart). Verifica il log d'avvio.

---

## Note trasversali

- **Niente nuove migrazioni**: la Fase 2 è solo logica worker (riusa doc_pages/doc_chunks
  esistenti).
- **In-place sulla generazione corrente**: le pagine aggiornate restano nella
  generazione corrente (stesso id/generationId), solo `body`/`commitSha`/chunk cambiano.
- **Aree nuove NON create** (v1): solo segnalate nella entry (rigenerazione completa
  manuale per coprirle). YAGNI.
- **Best-effort/idempotente**: un refresh fallito non blocca gli altri né la entry;
  il pending è già stato reclamato (no loop). La serializzazione per-progetto
  (serializer) protegge l'apertura del worktree dal `fetch --prune` dei fix.
- **Cap**: `maxRefreshPages` limita costo/tempo per push; `0` = solo changelog.
