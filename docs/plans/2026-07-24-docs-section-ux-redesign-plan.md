# Redesign UX/UI della sezione Docs — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: usa superpowers:executing-plans per implementare
> questo piano task per task. Per i task frontend "design-heavy" usa
> frontend-design:frontend-design per la resa visiva (estetica "terminal" esistente).

**Goal:** Rendere la sezione Docs orientante per chi non conosce il prodotto: home di
progetto e di repo con overview e punti d'ingresso, sidebar navigabile a tab per
categoria, e Release come changelog first-class (data, significatività, timeline
cross-repo).

**Architecture:** Prima il data layer (migrazioni + esposizione campi già in DB), poi
gli endpoint "highlights" che alimentano le nuove home, infine le viste React. Le
Release diventano un oggetto navigabile a sé (vista dedicata), fuori dall'albero.

**Tech Stack:** Drizzle/Postgres, Fastify + Zod (`fastify-type-provider-zod`), React +
TanStack Router/Query, Tailwind v4, Vitest (happy-dom), testcontainers (server).

**Riferimento design:** `docs/plans/2026-07-24-docs-section-ux-redesign-design.md`.

---

## Note operative trasversali

- **Migrazioni:** modifica `packages/db/src/schema.ts`, poi genera con
  `pnpm --filter @stubwise/db generate` (drizzle-kit assegna il numero `0060...` e
  aggiorna `meta/`). Per il backfill di `significant` serve una **migrazione dati SQL
  custom** aggiuntiva (drizzle non la genera). Trappola nota: mai usare in una
  migrazione un enum value aggiunto in una precedente (qui non aggiungiamo enum).
- **Test server:** usano testcontainers; gira i singoli file con
  `pnpm --filter @stubwise/server test -- <file>`.
- **Pre-merge OBBLIGATORIO:** `pnpm lint` (root), `pnpm typecheck`, `pnpm test`.
- **Deploy:** `apps/web` → ribuildare **caddy**; `apps/server`/`apps/worker` →
  ribuildare server e worker. Non riavviare il worker con generazioni
  `running`/`paused` in corso. E2E docs Playwright a mano.
- **Commit frequenti:** un commit per task (o per step significativo).

---

## FASE 1 — Data layer & backend

### Task 1: Colonne `viewCount` e `significant` su `doc_pages`

**Files:**
- Modify: `packages/db/src/schema.ts:1248-1302` (blocco `docPages`)
- Create: `packages/db/drizzle/0060_*.sql` (generata) + `0061_backfill_release_significant.sql` (dati, a mano)

**Step 1:** In `schema.ts`, dentro `docPages`, aggiungi due colonne dopo `isManual`
(riga ~1272):

```ts
// Contatore visualizzazioni (increment fire-and-forget all'apertura pagina).
viewCount: integer("view_count").notNull().default(0),
// Solo per kind="releases": true se la release è "significativa" (calcolata dal
// worker via parseReleaseNotes). Null per le pagine non-release. Sostituisce il
// prefisso "[minore]" nel titolo come segnale filtrabile.
significant: boolean("significant"),
```

**Step 2:** Genera la migrazione schema:
`pnpm --filter @stubwise/db generate`
Expected: nuovo file `0060_*.sql` con `ALTER TABLE "doc_pages" ADD COLUMN "view_count" ... ADD COLUMN "significant" ...` + snapshot in `meta/`.

**Step 3:** Crea a mano la migrazione dati di backfill
`packages/db/drizzle/0061_backfill_release_significant.sql`:

```sql
-- Backfill significant per le release esistenti dal prefisso "[minore]" nel titolo.
-- Le release NON minori (senza prefisso) diventano significant=true.
UPDATE "doc_pages"
SET "significant" = ("title" NOT LIKE '[minore]%')
WHERE "kind" = 'releases';

-- Rimuove il prefisso "[minore] " dal titolo: ora la significatività è una colonna.
UPDATE "doc_pages"
SET "title" = substring("title" FROM char_length('[minore] ') + 1)
WHERE "kind" = 'releases' AND "title" LIKE '[minore]%';
```

Aggiorna manualmente `packages/db/drizzle/meta/_journal.json` aggiungendo la entry
per `0061` (segui il formato delle entry esistenti, `idx` incrementale).

**Step 4:** Verifica che le migrazioni applichino (girano all'avvio server nei test):
`pnpm --filter @stubwise/db test`
Expected: PASS (le migrazioni si applicano senza errori sul Postgres di test).

**Step 5:** Commit
`git add packages/db && git commit -m "feat(db): viewCount e significant su doc_pages + backfill release"`

---

### Task 2: Esporre `createdAt`, `viewCount`, `significant` in tree e page

**Files:**
- Modify: `apps/server/src/routes/docs.ts` (`treeNodeSchema` 109-118, select tree 671-684, `pageSchema` 131-147, `toPage` 155-173)
- Test: `apps/server/test/docs.*.test.ts` (crea/estendi un file di test per tree e page)

**Step 1 (test):** aggiungi un test che, dato un repo con una pagina generata,
verifica che `GET /repositories/:id/docs/tree` ritorni `createdAt` (ISO string) e
`viewCount` (number) su ogni nodo, e per una release anche `significant`.
Run: `pnpm --filter @stubwise/server test -- docs`
Expected: FAIL (campi assenti).

**Step 2:** Estendi `treeNodeSchema`:

```ts
const treeNodeSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  kind: docPageKindSchema,
  parentId: z.uuid().nullable(),
  position: z.number().int(),
  sourcePath: z.string().nullable(),
  isManual: z.boolean(),
  createdAt: z.string(),
  viewCount: z.number().int(),
  significant: z.boolean().nullable(),
});
```

Estendi la select in `/docs/tree` (671-684) con
`createdAt: docPages.createdAt, viewCount: docPages.viewCount, significant: docPages.significant`
e mappa `createdAt` a ISO nel ritorno (il handler oggi ritorna `rows` diretto: introduci
un `.map` che converte `createdAt` con `.toISOString()`).

**Step 3:** Estendi `pageSchema` con gli stessi tre campi e aggiornane `toPage`
(`createdAt: row.createdAt.toISOString(), viewCount: row.viewCount, significant: row.significant`).

**Step 4:** Run test → PASS.

**Step 5:** Commit `feat(docs-api): espone createdAt/viewCount/significant su tree e page`.

---

### Task 3: Endpoint increment viste `POST .../docs/pages/:slug/view`

**Files:**
- Modify: `apps/server/src/routes/docs.ts` (nuovo handler vicino agli altri page handler)
- Test: stesso file di test docs

**Step 1 (test):** test che chiama `POST /repositories/:id/docs/pages/:slug/view` e
verifica risposta `204` e che il `viewCount` della pagina sia incrementato di 1 (rileggi
via `GET .../pages/:slug`). Verifica anche `404` per slug inesistente.
Run test → FAIL.

**Step 2:** Aggiungi il handler:

```ts
app.post(
  "/repositories/:repositoryId/docs/pages/:slug/view",
  {
    preHandler: requireAuth,
    schema: {
      params: slugParamsSchema,
      response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
    },
  },
  async (request, reply) => {
    const { repositoryId, slug } = request.params;
    const res = await app.db
      .update(docPages)
      .set({ viewCount: sql`${docPages.viewCount} + 1` })
      .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.slug, slug)))
      .returning({ id: docPages.id });
    if (res.length === 0) {
      return apiError(reply, 404, "doc_page_not_found", "Documentation page not found");
    }
    return reply.code(204).send();
  },
);
```

Nota: l'increment atomico via `sql` evita race. Lo slug può appartenere a più
generazioni storiche: l'update le incrementa tutte con quello slug nel repo — accettabile
(il contatore è per-slug logico). Se si volesse solo la corrente, filtrare per
generationId corrente OR null; per semplicità/robustezza aggiorniamo per slug.

**Step 3:** Run test → PASS.

**Step 4:** Commit `feat(docs-api): endpoint increment viste pagina`.

---

### Task 4: Worker persiste `significant` e rimuove il prefisso `[minore]`

**Files:**
- Modify: `apps/worker/src/docs/auto-update.ts:1147-1187` (creazione entry release)
- Test: `apps/worker/test/...` (il file che copre la creazione release, se esiste; altrimenti test mirato)

**Step 1 (test):** verifica che, creando una release da note con `significant=false`, la
`docPage` inserita abbia `title` SENZA prefisso `[minore]` e `significant=false`; con
`significant=true`, `significant=true`. Run → FAIL.

**Step 2:** In `auto-update.ts` sostituisci la riga 1152:

```ts
// Prima: const title = notes.significant ? notes.title : `[minore] ${notes.title}`;
const title = notes.title;
```

e nell'`insert` (1175-1187) aggiungi `significant: notes.significant,`.

**Step 3:** Run test → PASS.

**Step 4:** Commit `feat(worker): persiste significant sulle release, niente prefisso titolo`.

---

### Task 5: Endpoint highlights per repo `GET .../docs/highlights`

**Files:**
- Modify: `apps/server/src/routes/docs.ts` (nuovo schema `highlightsSchema` + handler)
- Test: file di test docs

Forma risposta:

```ts
const highlightRefSchema = z.object({
  slug: z.string(), title: z.string(), kind: docPageKindSchema, viewCount: z.number().int(),
});
const releaseRefSchema = z.object({
  slug: z.string(), title: z.string(), createdAt: z.string(),
  significant: z.boolean().nullable(), commitSha: z.string().nullable(),
});
const highlightsSchema = z.object({
  countsByKind: z.record(docPageKindSchema, z.number().int()),
  topViewed: z.array(highlightRefSchema),        // pagine non-release, per viewCount desc, limit 6
  recentlyUpdated: z.array(highlightRefSchema),   // pagine non-release, per updatedAt desc, limit 6
  latestReleases: z.array(releaseRefSchema),      // kind=releases, per position asc (più recenti), limit 5
});
```

**Step 1 (test):** setup repo con qualche pagina (diverse kind + una release), chiama
`GET /repositories/:id/docs/highlights`, verifica `countsByKind`, che `topViewed` sia
ordinato per viewCount desc ed escluda le release, e che `latestReleases` abbia
`createdAt`/`significant`. Run → FAIL.

**Step 2:** Implementa il handler: scope pagine = generazione corrente OR manuali (riusa
il `genFilter` di `/docs/tree`). `countsByKind` = `GROUP BY kind`. `topViewed`/
`recentlyUpdated` = query separate con `orderBy` e `limit`, `kind != 'releases'`.
`latestReleases` = `kind='releases'` ordinate per `position asc` limit 5, mappando
`createdAt.toISOString()` e `commitSha` (per le release è null: usa lo short-sha dallo
slug se serve in UI, ma il campo resta il commit di generazione = null → deriva lato UI).

**Step 3:** Run test → PASS.

**Step 4:** Commit `feat(docs-api): endpoint highlights per repo`.

---

### Task 6: Endpoint highlights per progetto `GET /api/projects/:id/docs/highlights`

**Files:**
- Modify: `apps/server/src/routes/projects*.ts` (dove vivono le route project-docs; cerca
  `projects/:id/docs/spaces` e affianca) oppure `docs.ts` se le project-route sono lì
- Test: file di test project docs

**Step 1 (test):** progetto con 2 repo con release; `GET /api/projects/:id/docs/highlights`
ritorna un changelog unificato (`latestReleases` cross-repo con `repositoryId`/`repoName`,
ordinato per createdAt desc) + `topViewed` aggregato. Run → FAIL.

**Step 2:** Risolvi le repo del progetto, poi aggrega: query su `docPages` joinando
`repositories` filtrando per le repo del progetto. `latestReleases` cross-repo (aggiungi
`repositoryId`, `repoName`, `repoSlug` allo schema release per il project-scope). Limita
(es. 10 release, 8 topViewed).

**Step 3:** Run test → PASS.

**Step 4:** Commit `feat(docs-api): endpoint highlights aggregato di progetto`.

---

## FASE 2 — Client API & query

### Task 7: Client `docs-api.ts` — nuovi campi, tipi highlights, view ping

**Files:**
- Modify: `apps/web/src/lib/docs-api.ts`
- Test: se esiste un test del client; altrimenti coperto dai test componenti

**Step 1:** aggiungi ai tipi `DocTreeNode`/`DocPage` i campi `createdAt`, `viewCount`,
`significant`. Aggiungi tipi `DocHighlights`, `DocHighlightRef`, `DocReleaseRef` e i
fetcher `getRepoHighlights(repositoryId)` / `getProjectHighlights(projectId)`. Aggiungi
`pingPageView(repositoryId, slug)` (POST, ignora errori — fire-and-forget).

**Step 2:** typecheck `pnpm --filter @stubwise/web typecheck` → PASS.

**Step 3:** Commit `feat(web): client per highlights e view ping`.

---

### Task 8: Query options & cache keys

**Files:**
- Modify: `apps/web/src/lib/queries.ts:645-657` (blocco `docsKeys`)

**Step 1:** aggiungi `docRepoHighlightsQueryOptions(repositoryId)` e
`docProjectHighlightsQueryOptions(projectId)` con chiavi in `docsKeys`. `staleTime`
moderato (es. 30s) perché sono viste "novità".

**Step 2:** typecheck → PASS. Commit `feat(web): query options highlights`.

---

## FASE 3 — Release come changelog first-class

### Task 9: Vista changelog `/docs/:repoId/releases`

**Files:**
- Modify: `apps/web/src/router.tsx` (nuova route `docsReleasesRoute` sotto `docsSpaceRoute`)
- Create: `apps/web/src/routes/docs/releases.$projectId.tsx` (o dentro `$projectId.tsx`)
- Create: `apps/web/src/components/docs-releases.tsx`
- Test: `apps/web/src/components/docs-releases.test.tsx`

**Step 1 (test):** rendi `DocsReleases` con una lista di release mock; verifica: mostra
data leggibile (`formatRelativeTime`/data assoluta da `lib/format.ts`), badge "minore"
solo quando `significant===false`, il titolo, e che il filtro "solo significative"
nasconda le minori. Run `pnpm --filter @stubwise/web test -- docs-releases` → FAIL.

**Step 2:** Implementa `DocsReleases` (usa frontend-design per la resa "terminal"):
timeline verticale, ogni voce = data + titolo + badge minore + commit short (dallo slug
`release-YYYYMMDD-HHmm-<sha>`), corpo markdown espandibile (`<Markdown>`), link "pagine
impattate" dai `links`. Filtro "solo significative" (checkbox) + ricerca testuale locale
sul titolo. Le release arrivano dal tree filtrato `kind==='releases'` (già caricato) o da
un fetch dedicato; ordina per `position asc`.

**Step 3:** collega la route in `router.tsx` e il rendering. Run test → PASS.

**Step 4:** Commit `feat(web): vista changelog release dedicata`.

---

### Task 10: Release fuori dall'albero + link "Release · N"

**Files:**
- Modify: `apps/web/src/components/docs-tree.tsx:26` (ordine gruppi) e la costruzione gruppi
- Modify: `apps/web/src/components/docs-sidebar.tsx`

**Step 1 (test):** aggiorna/aggiungi test di `DocsTree` che verifica che il gruppo
`releases` NON venga più renderizzato come sezione dell'albero. Run → FAIL.

**Step 2:** rimuovi `releases` dai kind dell'albero (`docs-tree.tsx`). In `DocsSidebar`
aggiungi una voce/link dedicata "Release · N" (N = conteggio release) che punta a
`/docs/:repoId/releases`, con stato attivo quando la route è quella.

**Step 3:** Run test → PASS. Commit `feat(web): release fuori dall'albero, link dedicato`.

---

## FASE 4 — Home di repo & navigazione sidebar

### Task 11: Sidebar a tab per categoria (Technical/Functional/Product)

**Files:**
- Modify: `apps/web/src/components/docs-tree.tsx`, `apps/web/src/components/docs-sidebar.tsx`
- Test: `apps/web/src/components/docs-tree.test.tsx`

**Step 1 (test):** verifica che con tab attiva "Technical" l'albero mostri SOLO le pagine
technical; cambiando tab a "Functional" mostri solo quelle; la tab attiva segue il `kind`
della pagina corrente all'ingresso. Run → FAIL.

**Step 2:** introduci uno stato `activeKind` (default = kind della pagina attiva o
`technical`) e dei segmenti/tab in cima all'albero (`manual` incluso solo se ci sono
pagine manuali). Renderizza un solo `kind` per volta. Persisti la tab attiva per repo
(es. in URL search param `?cat=` o stato locale). Riusa `CollapsibleSection` per la
gerarchia interna.

**Step 3:** Run test → PASS. Commit `feat(web): sidebar a tab per categoria`.

---

### Task 12: Sidebar ridimensionabile + tooltip titoli

**Files:**
- Modify: `apps/web/src/routes/docs/$projectId.tsx` (aside sidebar), `docs-tree.tsx`

**Step 1 (test):** test leggero che le voci troncate espongono l'attributo `title`
(tooltip nativo) col titolo completo. Run → FAIL.

**Step 2:** aggiungi `title={node.title}` sulle voci troncate. Rendi l'aside
ridimensionabile con un handle di drag (larghezza in `localStorage` per repo, min/max
sensati). Su `lg+` soltanto; su mobile resta il drawer.

**Step 3:** Run test → PASS. Commit `feat(web): sidebar ridimensionabile e tooltip`.

---

### Task 13: Overview di repo (rimpiazza "SELECT A PAGE")

**Files:**
- Modify: `apps/web/src/routes/docs/$projectId.tsx` (`DocsSpaceIndex`)
- Create: `apps/web/src/components/docs-repo-overview.tsx`
- Test: `apps/web/src/components/docs-repo-overview.test.tsx`

**Step 1 (test):** `DocsRepoOverview` con highlights + brief mock: verifica che mostri
titolo repo, sintesi dal brief, card categoria con conteggi, sezione "inizia da qui" e
"novità" (recentlyUpdated + latestReleases + topViewed). Verifica i link corretti. Run → FAIL.

**Step 2:** implementa (frontend-design). Dati da `docRepoHighlightsQueryOptions` +
`docBriefQueryOptions` (identity). Card categoria linkano alla tab sidebar corrispondente;
"inizia da qui" = Brief + Architecture Overview (prima technical) + top page per categoria;
"novità" da highlights. Monta in `DocsSpaceIndex` al posto del placeholder "SELECT A PAGE".

**Step 3:** Run test → PASS. Commit `feat(web): overview di repo al posto di select-a-page`.

---

### Task 14: View ping fire-and-forget all'apertura pagina

**Files:**
- Modify: `apps/web/src/routes/docs/$projectId.tsx` (`DocsPageView`)

**Step 1 (test):** verifica che al montaggio di `DocsPageView` con uno slug venga chiamato
`pingPageView` una volta (mock del client). Debounce: nessun secondo ping entro N secondi
per lo stesso slug. Run → FAIL.

**Step 2:** in `DocsPageView` aggiungi un `useEffect` sullo slug che chiama
`pingPageView(repositoryId, slug)` (ignora errori). Debounce con un ref/set per non
contare refresh ravvicinati nella stessa sessione.

**Step 3:** Run test → PASS. Commit `feat(web): conteggio viste all'apertura pagina`.

---

## FASE 5 — Home di progetto

### Task 15: Redesign `/docs/project/:id` (ProjectDocsLanding)

**Files:**
- Modify: `apps/web/src/routes/docs/project.$projectId.tsx`
- Create: eventuali sotto-componenti (`docs-project-hero.tsx`, riuso `docs-releases` per la
  timeline cross-repo)
- Test: `apps/web/src/routes/docs/project.$projectId.test.tsx` (o component test)

**Step 1 (test):** con project highlights + brief mock verifica: hero con sintesi dal
brief (non la frase boilerplate), sezione "inizia da qui", card repo con conteggi per
categoria + ultima release con data, striscia "novità" (changelog cross-repo), e che la
chat sia un pannello richiamabile (non aperta di default a metà schermo) con domande
suggerite. Run → FAIL.

**Step 2:** implementa (frontend-design). Layout a colonna singola:
1. Hero: nome + sintesi da brief identity (fetch brief del repo principale) + link brief.
2. "Inizia da qui": Brief, Architecture Overview, Product, ultima release.
3. Card repo (riuso arricchito): conteggi per categoria da `getProjectHighlights`/spaces.
4. "Novità": `DocsReleases` in modalità compatta cross-repo (da project highlights).
5. Chat `DocsChat` scope project: pulsante "Chiedi ai docs" apre il pannello; passa 3-4
   `suggestedQuestions` renderizzate come chip cliccabili nell'empty state della chat.

**Step 3:** aggiungi la prop `suggestedQuestions?` a `DocsChat` (empty state) senza
rompere gli usi esistenti. Run test → PASS.

**Step 4:** Commit `feat(web): home di progetto orientante`.

---

## FASE 6 — Verifica & deploy

### Task 16: Verifica completa

**Step 1:** `pnpm lint` (root) → PASS.
**Step 2:** `pnpm typecheck` → PASS.
**Step 3:** `pnpm test` → PASS.
**Step 4:** E2E docs a mano (Playwright, `apps/web/e2e`): naviga home progetto → repo
overview → apri una pagina (verifica ping) → tab categoria → vista release (filtro
significative). Usa la skill `verify` per guidare la prova end-to-end nell'app reale.
**Step 5:** Commit finale se ci sono fix di verifica.

### Task 17: Deploy (on-demand, dopo ok utente)

- Backup DB prod.
- Deploy: `apps/server` + `apps/worker` (nuovi endpoint, migrazioni 0060/0061, worker
  significant) → ribuild server+worker; `apps/web` → ribuild caddy. Ordine: server (applica
  migrazioni all'avvio) → worker → caddy.
- Verifica bundle servito (grep di una stringa nuova in `/srv/web`).
- Verifica: `GET /api/repositories/:id/docs/highlights` 200; una release mostra data e
  niente prefisso `[minore]`.

---

## Ordine di dipendenza

FASE 1 (backend) → FASE 2 (client) → FASI 3/4/5 (frontend, in gran parte parallelizzabili
tra loro una volta pronto il client) → FASE 6 (verifica/deploy). Le Fasi 3, 4, 5 sono
indipendenti: eseguibili in parallelo da subagent distinti dopo la Fase 2.
