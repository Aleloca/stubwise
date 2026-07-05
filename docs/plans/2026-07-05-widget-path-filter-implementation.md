# Filtro per percorso sui widget — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Per ogni repo abilitato su un widget, filtro opzionale `{paths, slugs}` che restringe le doc_pages esposte al RAG (monorepo: esporre solo `apps/webapp`), fail-closed, con selezione ad albero nell'editor.

**Architecture:** Colonna jsonb `repository_filters` su `widgets` (mappa repoId → {paths, slugs}). Il retrieval cross-repo estende lo scope predicate: repo filtrato → `AND pageId IN (subquery su doc_pages con match sourcePath-prefix o slug)`. La chat interna Docs non passa l'opzione. UI: albero docs con checkbox nell'editor widget, salva paths/slugs (mai pageId).

**Tech Stack:** Fastify+Zod, Drizzle/Postgres (testcontainers), React SPA, i18next.

**Design:** `docs/plans/2026-07-05-widget-path-filter-design.md`. Base: multi-widget (`widgets` table, `widget-admin.ts` CRUD, `widget.ts` superficie pubblica, editor in `apps/web/src/components/widgets-section.tsx`).

**Regole trasversali:** TDD; commit con `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; dopo modifiche a shared/db: rebuild package + `pnpm typecheck` dalla RADICE del worktree; stringhe SPA in en.json E it.json (parity); `pnpm lint` root nel task finale.

---

### Task 1: Schema shared `repositoryFilters`

**Files:**
- Modify: `packages/shared/src/schemas/widget.ts`
- Test: `packages/shared/src/schemas/widget.test.ts`

**Step 1: test fallente**

```ts
it("repositoryFilters valida paths e slugs", () => {
  // default: mappa vuota
  expect(widgetUpsertBodySchema.parse({ name: "x" }).repositoryFilters).toEqual({});
  const repoId = "0b7e5b7e-0000-4000-8000-000000000001";
  const ok = widgetUpsertBodySchema.parse({
    name: "x",
    repositoryFilters: { [repoId]: { paths: ["apps/webapp"], slugs: ["faq"] } },
  });
  expect(ok.repositoryFilters[repoId]).toEqual({ paths: ["apps/webapp"], slugs: ["faq"] });
  // chiave non uuid → throw
  expect(() => widgetUpsertBodySchema.parse({ name: "x", repositoryFilters: { nope: { paths: [], slugs: [] } } })).toThrow();
  // path traversal → throw
  expect(() => widgetUpsertBodySchema.parse({ name: "x", repositoryFilters: { [repoId]: { paths: ["../secrets"], slugs: [] } } })).toThrow();
  // slash iniziale/finale → throw (path non normalizzato)
  expect(() => widgetUpsertBodySchema.parse({ name: "x", repositoryFilters: { [repoId]: { paths: ["/apps/"], slugs: [] } } })).toThrow();
  // path vuoto → throw
  expect(() => widgetUpsertBodySchema.parse({ name: "x", repositoryFilters: { [repoId]: { paths: [""], slugs: [] } } })).toThrow();
});
```

**Step 2:** run → FAIL. **Step 3: implementazione** in `widget.ts` shared:

```ts
/**
 * Percorso relativo normalizzato dentro il repo: niente slash iniziale/finale,
 * niente `..` (fail-closed: un path malformato è un errore, non un filtro vuoto).
 */
const repoPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((p) => !p.startsWith("/") && !p.endsWith("/"), "path non normalizzato")
  .refine((p) => !p.split("/").includes("..") && !p.split("/").includes("."), "path traversal");

/** Filtro per-repo: prefissi di sourcePath e/o slug espliciti (pagine senza percorso). */
export const widgetRepositoryFilterSchema = z.object({
  paths: z.array(repoPathSchema).max(50).default([]),
  slugs: z.array(z.string().min(1).max(300)).max(100).default([]),
});
export type WidgetRepositoryFilter = z.infer<typeof widgetRepositoryFilterSchema>;

export const widgetRepositoryFiltersSchema = z
  .record(z.uuid(), widgetRepositoryFilterSchema)
  .default({});
export type WidgetRepositoryFilters = z.infer<typeof widgetRepositoryFiltersSchema>;
```

e in `widgetUpsertBodySchema` aggiungi `repositoryFilters: widgetRepositoryFiltersSchema`. (Zod v4: `z.record(z.uuid(), ...)` — verifica la firma reale nel repo; stile z.uuid() top-level.)

**Step 4:** PASS (tutti). **Step 5:** `pnpm --filter @stubwise/shared build && pnpm typecheck` (radice worktree — ⚠️ apps/web potrebbe rompersi se `WidgetUpsertBody` è usato con oggetti literal senza il campo nuovo: il default lo rende opzionale in input, quindi dovrebbe restare verde; verifica). Commit `feat(shared): schema repositoryFilters per widget`.

---

### Task 2: DB — colonna `repository_filters` + migrazione 0042

**Files:**
- Modify: `packages/db/src/schema.ts` (tabella `widgets`)
- Create: `packages/db/drizzle/0042_widget_path_filter.sql` (generata)
- Test: `packages/db/src/widget-schema.test.ts` (estendi)

**Step 1: test fallente** — insert widget con `repositoryFilters: { [repoId]: { paths: ["apps/webapp"], slugs: [] } }` e round-trip; insert senza il campo → default `{}`.

**Step 2:** FAIL. **Step 3:** in `widgets` (dopo `dailyTicketCap`):

```ts
repositoryFilters: jsonb("repository_filters")
  .$type<Record<string, { paths: string[]; slugs: string[] }>>()
  .notNull()
  .default({}),
```

JSDoc nello stile del file: raffinamento opzionale di enabled_repository_ids, fail-closed, chiavi = repositoryId. **Step 4:** `cd packages/db && npx drizzle-kit generate --name widget_path_filter` → verifica che il file sia SOLO `ALTER TABLE "widgets" ADD COLUMN "repository_filters" jsonb DEFAULT '{}'::jsonb NOT NULL;` (additiva, niente data migration, niente trappole). **Step 5:** test db verdi (`vitest run src/widget-schema.test.ts src/schema.test.ts`), build db, `pnpm typecheck` root. Commit `feat(db): colonna repository_filters sui widget`.

---

### Task 3: Retrieval — scope con filtro pageId

**Files:**
- Modify: `apps/server/src/routes/docs-retrieval.ts`
- Test: `apps/server/src/routes/docs-retrieval-project.test.ts` (estendi — è il file che testa retrieveChunksForProject; verifica il nome reale)

**Step 1: leggi PRIMA** `docs-retrieval.ts`: `RetrieveChunksOptions` (~:119-140), `crossRepoScopePredicate` (~:101-112), `retrieveChunksForProject` (~:225+), `ScopableTable` (~:67), come le due gambe applicano `scope(docChunks)`/`scope(docPages)` in `retrieveWithScope`.

**Step 2: test fallenti** (nel test esistente c'è già il seeding di doc_pages/doc_chunks su più repo — riusa gli helper):
1. Filtro `paths: ["apps/webapp"]` su repo A: chunk di pagina con `sourcePath: "apps/webapp/router.ts"` ritorna; pagina con `sourcePath: "apps/admin/index.ts"` no; pagina con `sourcePath: "apps/webapp-admin/x.ts"` NO (confine `/`).
2. Filtro `slugs: ["faq"]`: la pagina manuale con slug `faq` (sourcePath null) ritorna; altra manuale no.
3. Filtro `{paths: [], slugs: []}` (entry presente ma vuota) → NIENTE dal repo (fail-closed).
4. Repo B senza entry nel filtro → tutto come prima.
5. Assenza dell'opzione → comportamento identico a oggi (i test esistenti restano verdi).

**Step 3: implementazione.**
- `RetrieveChunksOptions` + `repositoryFilters?: Record<string, { paths: string[]; slugs: string[] }>`.
- In `retrieveChunksForProject`, costruisci lo scope: per ogni repo della whitelist, se `repositoryFilters[repo.id]` esiste, la condizione del repo diventa `and(repoCondition, pageIdIn(filtro))` dove:

```ts
function pageFilterSubquery(db: Db, repositoryId: string, generationId: string | null, filter: {paths: string[]; slugs: string[]}) {
  // subquery: SELECT id FROM doc_pages WHERE repository_id = X AND (generazione corrente o manuale)
  //   AND (source_path = p OR source_path LIKE p || '/%'  [per ogni p]  OR slug IN (slugs))
  // Se paths e slugs sono entrambi vuoti → subquery impossibile (WHERE false) = fail-closed.
}
```

  Applicata come `inArray(docChunks.pageId, subquery)` sulla gamba chunks e `inArray(docPages.id, subquery)` sulla gamba pages — il predicato riceve già `table`, distingui lì. ⚠️ `LIKE`: escapa `%`/`_` nel prefisso (`p.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")` o usa il helper drizzle se esiste). ⚠️ Le pagine manuali hanno `generationId` null: la subquery deve includerle (stessa logica di visibilità dello scope esistente — guarda come lo scope attuale tratta le manuali).
- La chat interna e `answerProjectDocsQuestion` NON passano l'opzione → invariate.

**Step 4:** PASS (nuovi + esistenti). **Step 5:** typecheck server, eslint. Commit `feat(server): filtro paths/slugs per repo nel retrieval progetto`.

---

### Task 4: Server — validazione CRUD + passaggio del filtro alla chat

**Files:**
- Modify: `apps/server/src/routes/widget-admin.ts` (POST/PUT: validazione repositoryFilters)
- Modify: `apps/server/src/routes/widget.ts` (endpoint messages: passa il filtro)
- Test: `apps/server/src/routes/widget-admin.test.ts` + `apps/server/src/routes/widget.test.ts` (estendi)

**widget-admin:** in POST e PUT, dopo la validazione repo esistente: le chiavi di `body.repositoryFilters` devono essere ⊆ `body.enabledRepositoryIds` → 422 `invalid_repository_filter`. La risposta `widgetSchema` include `repositoryFilters`. (La proiezione `toPublicWidget`/schema di risposta del CRUD: aggiungi il campo.)

**widget.ts:** endpoint messages → `retrieveChunksForProject(..., { ..., repositoryFilters: widget.repositoryFilters })`. Il config NON espone il filtro.

**Test:**
- CRUD: POST/PUT con filtro per repo abilitato → 200 e round-trip; filtro per repo NON abilitato → 422; filtro per repo di altro progetto → 422 (stessa regola: non è in enabledRepositoryIds validi).
- Pubblica (widget.test.ts): seed di doc_pages su due sourcePath (`apps/webapp/...` e `apps/admin/...`) nello stesso repo, widget con filtro `paths: ["apps/webapp"]` → il messaggio chat produce citazioni SOLO della pagina webapp (pattern del test retrieval per-widget esistente); config invariato (nessun campo filtro).

Commit `feat(server): repositoryFilters nel CRUD widget e nella chat pubblica`.

---

### Task 5: SPA — selezione ad albero nell'editor

**Files:**
- Modify: `apps/web/src/lib/api.ts` (tipo `Widget` + `repositoryFilters`; il body upsert lo include)
- Create: `apps/web/src/components/widget-section-filter.tsx` (albero con checkbox per un repo)
- Modify: `apps/web/src/components/widgets-section.tsx` (blocco collassabile per repo spuntato)
- Modify: locales en/it (namespace `widget`)
- Test: `apps/web/src/components/widget-section-filter.test.tsx` + estendi `widgets-section.test.tsx`

**Dati albero:** riusa `getDocTree(repositoryId)` da `apps/web/src/lib/docs-api.ts` (nodi `{id, slug, title, kind, parentId, position, sourcePath, isManual}`) e `buildForest` da `apps/web/src/components/docs-tree.tsx` (se non esportata, esportala). Query on-demand quando si apre il blocco (useQuery con enabled).

**Componente `WidgetSectionFilter`** (props: `repositoryId`, `value: {paths, slugs} | undefined`, `onChange`, `disabled`):
- Blocco collassabile "Limita alle sezioni" (chiuso default; aperto se `value` esiste). Apertura → carica l'albero.
- Nodo con `sourcePath`: checkbox → aggiunge/rimuove il path da `paths`. Stato checked = il suo sourcePath è coperto da un path selezionato (usa una `pathCovers` locale: uguaglianza o prefisso con confine `/`); indeterminate = un discendente è selezionato ma il nodo no.
- Nodo senza `sourcePath` (manuali/panoramiche): checkbox individuale sullo `slug`.
- Riepilogo ("N sezioni, M pagine") + bottone "Rimuovi filtro" (→ `onChange(undefined)` = repo intero).
- Warning se `value` esiste con paths+slugs vuoti ("non esporrà nulla di questo repo").
- Repo senza docs generate → messaggio "nessuna documentazione" (albero vuoto).

**In `widgets-section.tsx`:** per ogni repo spuntato, render del filtro; lo stato form tiene `repositoryFilters` e il submit lo manda; deselezionare il repo elimina la entry. Member: disabled.

**Test:** albero mock (getDocTree mockato) → spunta un ramo → onChange con path giusto; spunta pagina manuale → slug; "rimuovi filtro" → undefined; warning con entry vuota; submit di widgets-section include repositoryFilters; deselect repo scarta la entry.

**Verifiche:** `pnpm --filter @stubwise/web test` (tutti, parity inclusa) + typecheck + eslint.

Commit `feat(web): filtro sezioni per repo nell'editor widget`.

---

### Task 6: Guida + verifica finale

1. `apps/docs/src/content/docs/integrations/widget.md`: sezione "Exposing only part of a monorepo" (albero nell'editor, paths stabili tra rigenerazioni, fail-closed, slug per pagine manuali). Build docs verde.
2. Verifica finale dalla radice del worktree: `pnpm build && pnpm typecheck && pnpm test && pnpm lint` — TUTTI verdi.
3. Commit `docs: guida filtro sezioni widget`.

**Fuori scope:** filtro chat interna Docs, esclusioni negative, filtri per kind.
