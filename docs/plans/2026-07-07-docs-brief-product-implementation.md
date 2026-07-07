# Brief + classe product + segreti — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Orientamento a due step con project brief persistito; classe di documentazione `product` pubblica per-superficie con percorsi di navigazione obbligatori; segreti a rilevamento automatico con verificatore fail-closed; widget di default sul kind product.

**Design:** `docs/plans/2026-07-07-docs-brief-product-design.md` — leggerlo SEMPRE prima di ogni task.

**Architecture (sintesi):** Fase A: `orient` produce il brief (contratto a marcatori → jsonb su doc_generations) e poi semina gli alberi col brief nel contesto; glossario/invarianti propagati a explore/synthesize. Fase B: dopo la finalize dei due alberi, un handler `product` genera per ogni superficie pubblica del brief una verticale (radice+guide journey+FAQ) con ancoraggi di navigazione validati. Fase C: verificatore segreti per pagina product (riscrittura una volta → esclusione fail-closed). Fase D: widget default product + warning, refresh Fase 2 con verifica, tab brief SPA, guida.

**Fatti chiave dal codice (da analisi verificata — usali):**
- Orient: `apps/worker/src/docs/recursive/orient-handler.ts` — semina radici hard-coded (`:277-279`), `commitSha` al worktree open (`:458-461`); prompt in `packages/docs-engine/src/recursive/orient.ts` (esclude docs/ come noise, `:65-71` — da CAMBIARE: le fonti esistenti entrano nel brief).
- Explore: prompt `packages/docs-engine/src/recursive/explore.ts:109-181` (varianti technical/functional; regole funzionali `:154-161`); handler `explore-handler.ts` (budget nodi `:199-233`, contesto verticale `:96-128`).
- Synthesize: `synthesize.ts:66-84` (indice); `synthesize-handler.ts` (summary troncati).
- Finalize: `finalize.ts` (projectPages `:213-264`, kind = node.tree `:236`, stats `:367-401`, swap `:404`).
- DocNode: `nodes.ts` (`tree` è text nel db? verifica: `doc_nodes.tree` — se enum/check, va esteso per 'product'); `createChildren` (`:162`).
- Kind enum: `doc_page_kind` derivato da `docPageKindSchema` (`packages/shared/src/schemas/docs.ts:11-16`) — aggiungere 'product' lì E migrazione ADD VALUE (MAI DML stesso batch).
- Auto-update Fase 2: `auto-update.ts` `refreshAffectedPagesInWorktree`; il refresh di pagine product dovrà passare dal verificatore.
- Widget kinds filter: `widgetRepositoryFilterSchema.kinds` (shared), retrieval `docs-retrieval.ts` gamba kinds; default nuovi widget in `widget-admin.ts` POST.
- Config worker: pattern env in `apps/worker/src/config.ts` + `index.ts` + compose.
- Test worker: pattern runner a copione in `auto-update.test.ts`; test generazione ricorsiva in `apps/worker/src/docs/recursive/*.test.ts` (leggili per il pattern orient/explore fake).

**Regole trasversali:** TDD; ogni task = un commit con `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; dopo modifiche shared/db/docs-engine: rebuild + `pnpm typecheck` dalla RADICE del worktree; stringhe SPA in en+it (parity); `pnpm lint` root nel task finale; NON rompere i test esistenti della pipeline (sono la rete di sicurezza della generazione che oggi funziona).

---

## FASE A — Project brief

### Task A1: docs-engine — contratto del brief

**Files:** Create `packages/docs-engine/src/brief.ts` + test; Modify `index.ts` (export).

- Tipi: `ProjectBrief { identity: string; actors: {name, description, internal}[]; surfaces: {name, type, rootPath, audience, internal}[]; glossary: {term, definition}[]; invariants: string[]; confidentialFacts: {fact, reason, source, avoid}[]; journeys: {actor, title, summary}[]; existingSources: string[] }`.
- `buildBriefPrompt(input: { repoSummary?: string })`: le "domande del documentarista" (identità, attori, superfici con path radice REALI, glossario 10-30 termini, invarianti, fatti riservati con euristiche esplicite — margini/markup/pricing/costi/tassi/fornitori/competitor/superfici-admin — e "come non deve apparire", journey per attore, fonti esistenti README/ADR/schema/contratti). Read-only, contratto a marcatori per sezione (pattern grow.ts/releases.ts).
- `parseBriefOutput(output): ProjectBrief | { reason: string }` — best-effort per-sezione (una sezione malformata → vuota, non tutto perso), mai throw; superfici senza rootPath → scartate; glossario cap 40; facts cap 30; journeys cap 15.
- `briefPromptContext(brief, opts?: { includeSecrets?: boolean }): string` — la porzione compatta da iniettare nei prompt downstream (glossario+invarianti+attori; +segreti solo se opts).
- TDD completo su parser (valido, sezioni mancanti, marcatori rotti) e su `briefPromptContext` (con/senza segreti).

Commit `feat(docs-engine): contratto project brief`.

### Task A2: DB + worker — brief nell'orientamento

**Files:** Modify `packages/db/src/schema.ts` (+ migrazione), `apps/worker/src/docs/recursive/orient-handler.ts`, test worker.

- Colonna `doc_generations.brief` jsonb nullable (migrazione additiva sola-ADD).
- Orient a due step: PRIMA della semina, run brief (`buildBriefPrompt` → `parseBriefOutput`); fallito/malformato → log warn e si prosegue SENZA brief (nullable, la pipeline non si rompe mai per il brief); ok → update `doc_generations.brief` e brief passato alla semina.
- Il prompt di orient (semina) riceve `briefPromptContext(brief)` come contesto aggiuntivo; RIMUOVERE l'esclusione delle cartelle docs/ dal prompt orient (le fonti sono nel brief, l'orient può citarle).
- Costo del run brief sommato al costo generazione.
- Test integrazione (pattern test recursive esistenti, runner a copione): brief parsato e persistito; brief fallito → generazione procede con brief null; costo aggiornato.

Commit `feat(worker): project brief nell'orientamento`.

### Task A3: propagazione a explore/synthesize + tab SPA

**Files:** Modify `packages/docs-engine/src/recursive/explore.ts` + `synthesize.ts` (+ test), `apps/worker/src/docs/recursive/explore-handler.ts` + `synthesize-handler.ts`, server route (GET brief), SPA.

- `buildExplorePrompt`/`buildSynthesizePrompt` accettano `briefContext?: string` (sezione "PROJECT CONTEXT — use this glossary and terminology consistently"); handler lo passano (da `doc_generations.brief` caricato una volta per generazione). SENZA brief → prompt identici a oggi (test di regressione).
- Server: `GET /api/repositories/:repositoryId/docs/brief` (requireAuth) → brief della generazione corrente + (Fase C aggiungerà le esclusioni) — 404 se assente.
- SPA: tab/sezione "Brief" nello spazio Docs del repo (sola lettura: identità, attori, superfici, glossario, invarianti, journey, fatti riservati). i18n en+it.
- Test: prompt con/senza contesto; route 200/404; component test SPA.

Commit `feat(docs): brief propagato ai prompt e visibile in SPA`.

---

## FASE B — Classe product

### Task B1: kind `product` + schema nodi

**Files:** shared `docs.ts` (enum +'product'), db migrazione ADD VALUE (SOLO DDL), verifica `doc_nodes.tree` (se vincolato, estendi), badge/label SPA per il kind (i18n — cerca dove i kind sono mappati a label, es. docs-tree GROUP_ORDER: aggiungi il gruppo), test schema.

Commit `feat(shared,db): kind product`.

### Task B2: docs-engine — contratti verticali product

**Files:** Create `packages/docs-engine/src/product.ts` + test; export.

- `buildProductRootPrompt({ surface, brief, functionalSummaries })` → radice verticale con getting-started; `buildProductGuidePrompt({ surface, journey, brief, functionalSummaries, navigationHint })` → guida con struttura IMPOSTA (Obiettivo/Prerequisiti/Passi numerati/Risultato/Problemi comuni); `buildProductFaqPrompt(...)` → FAQ dai "limiti" functional.
- Registro: seconda persona, zero interni, nomi UI/URL obbligatori. Sezione "NEVER disclose" placeholder (Fase C la riempie).
- `parseProductGuideOutput(output)`: valida che OGNI passo numerato contenga un **ancoraggio di navigazione** (pattern: `**percorso**` marcato col contratto, es. riga `NAV: Menu → Voce → Bottone [/url]` per passo — scegli un formato parsabile e documentalo); guida senza ancoraggi completi → `{ reason }` (il chiamante rigenera una volta poi scarta).
- TDD sui parser (ancoraggi presenti/mancanti/parziali, struttura sezioni).

Commit `feat(docs-engine): contratti verticali product con ancoraggi di navigazione`.

### Task B3: worker — handler product

**Files:** Create `apps/worker/src/docs/recursive/product-handler.ts`; Modify finalize/dispatch per includerlo DOPO la chiusura dei due alberi; config `DOC_PRODUCT_MAX_PAGES` (default 12/verticale) env+compose; test integrazione.

- Per ogni superficie del brief con `internal === false`: crea nodi product (radice + guida per journey pertinente — match journey→superficie per actor/audience — + FAQ), run sequenziali col worktree della generazione, parse, retry una volta su `{reason}`, scarto definitivo → conteggiato nelle stats.
- I nodi product entrano nella finalize come gli altri (kind 'product', slug dedupati, chunks embeddati, parentId di verticale). Budget SEPARATO (non consuma DOC_MAX_NODES).
- Niente brief o zero superfici pubbliche → fase saltata (log), generazione ok (retrocompatibilità).
- Fonti: `functionalSummaries` = titolo+primo paragrafo delle pagine functional pertinenti alla superficie (match per sourcePath sotto il rootPath della superficie); pagine con fonte in superfici interne ESCLUSE (difesa passiva).
- Test: verticale completa generata (radice+2 guide+faq) con ancoraggi; guida senza ancoraggi → retry → scarto; zero superfici → salto pulito; budget rispettato; stats.

Commit `feat(worker): generazione verticali product`.

---

## FASE C — Segreti

### Task C1: docs-engine — verificatore

**Files:** Create `packages/docs-engine/src/secrets.ts` + test; Modify `product.ts` (iniezione NEVER disclose reale da confidentialFacts).

- `buildSecretsAuditPrompt({ pageTitle, body, confidentialFacts })` — red-teamer: "pagina pubblica: contiene o lascia dedurre uno di questi fatti?" — contratto `===VERDICT=== CLEAN|VIOLATION` + `===DETAIL===` (fatto + passaggio incriminato).
- `parseSecretsAuditOutput` best-effort: ambiguo → VIOLATION (fail-closed).
- `buildProductGuidePrompt` e gli altri prompt product ricevono `confidentialFacts` e li rendono come sezione NEVER-disclose (con "non negare né confermare").
- TDD: verdetti, ambiguo→violation, iniezione presente nei prompt.

Commit `feat(docs-engine): verificatore segreti e iniezione NEVER-disclose`.

### Task C2: worker — pipeline di verifica fail-closed

**Files:** Modify `product-handler.ts` (o modulo dedicato), stats/brief; Modify server GET brief (esclusioni); SPA tab brief (sezione esclusioni); test.

- Dopo ogni pagina product: run audit → CLEAN → prosegui; VIOLATION → UNA rigenerazione con il passaggio incriminato come istruzione di rimozione → secondo audit → VIOLATION → pagina ESCLUSA (non inserita), registrata in `doc_generations.stats.productExclusions: {title, fact}[]` (e log warn).
- `confidentialFacts` vuoto/brief assente → l'audit gira comunque con euristiche generiche? NO — senza facts l'audit è saltato (niente lista = niente violazioni definibili; fail-open dichiarato SOLO in questo caso limite, documentato).
- Esclusioni esposte nel GET brief e nella tab SPA.
- Test integrazione: violazione→riscrittura pulita→pubblicata; violazione persistente→esclusa+stats; audit ambiguo→violation; facts vuoto→salto.

Commit `feat(worker): verifica segreti fail-closed sulle pagine product`.

---

## FASE D — Consumo

### Task D1: widget default product + warning

**Files:** `widget-admin.ts` (default kinds nuovi widget = ["product"]), `widgets-section.tsx` (warning quando kinds/selezione espongono technical|functional: "documentazione interna"), i18n, test server+SPA.

Commit `feat(widget): default product e warning documentazione interna`.

### Task D2: refresh Fase 2 con verifica + guida

**Files:** `auto-update.ts` (refresh di pagina kind product → dopo il body nuovo, audit segreti col brief della generazione; VIOLATION → pagina NON aggiornata, log), guida Starlight (pagina docs autogenerated: brief, classi, product, segreti), test auto-update.

Commit `feat(worker,docs): refresh product verificato e guida aggiornata`.

### Task D3: verifica finale

`pnpm build && pnpm typecheck && pnpm test && pnpm lint` dalla radice — tutti verdi. Review finale complessiva. NOTA DEPLOY: migrazioni additive; ribuild worker+server+caddy; riavvio worker senza generazioni attive; le nuove classi appaiono alla prima rigenerazione completa.

**Fuori scope (non implementare):** lista segreti manuale, verticali modificabili, grow product in Fase 3, migrazione automatica widget esistenti.
