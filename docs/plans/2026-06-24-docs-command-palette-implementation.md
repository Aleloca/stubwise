# Command palette di ricerca dei Docs — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development per eseguire questo piano task-by-task.

**Goal:** Sostituire la ricerca inline dei Docs con una command palette (Cmd/K)
con autocomplete sui risultati esistenti e cronologia server-side per-utente/
per-progetto delle pagine cliccate.

**Architecture:** La search ibrida backend esiste già (`GET .../docs/search`). Si
aggiunge una tabella `doc_search_history` con endpoint CRUD, e si rifà il
frontend come modale. Vedi `docs/plans/2026-06-24-docs-command-palette-design.md`.

**Tech Stack:** Drizzle/Postgres, Fastify+Zod, React+TanStack Router/Query, Tailwind v4, Vitest.

---

## Task 1: Tabella `doc_search_history` + migrazione

**Files:**
- Modify: `packages/db/src/schema.ts` (dopo `docChunks`/in coda alle tabelle docs)
- Create: `packages/db/drizzle/0028_*.sql` (via drizzle-kit generate)
- Test: `packages/db/src/schema.test.ts` (o il file di test schema esistente)

**Step 1 — schema.** Aggiungi la tabella (rispetta lo stile di `docPages`):

```ts
export const docSearchHistory = pgTable(
  "doc_search_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    kind: docPageKind("kind").notNull(),
    clickedAt: timestamp("clicked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("doc_search_history_user_project_slug_unique").on(
      table.userId,
      table.projectId,
      table.slug,
    ),
    index("doc_search_history_recent_idx").on(
      table.userId,
      table.projectId,
      table.clickedAt.desc(),
    ),
  ],
);
```

**Step 2 — genera migrazione.** `pnpm --filter @stubwise/db exec drizzle-kit generate`
→ verifica che il file 0028 crei tabella + indici (no DROP indesiderati).

**Step 3 — test.** Se esiste un test schema/migrazioni, aggiungi un caso che
inserisce due righe stesso (user,project,slug) e verifica che l'unique impedisca
il duplicato (o che l'upsert aggiorni `clickedAt`). Altrimenti copri in Task 2.

**Step 4 — typecheck + build db.** `pnpm --filter @stubwise/db typecheck && pnpm --filter @stubwise/db build`.

**Step 5 — commit.** `feat(db): tabella doc_search_history per la cronologia di ricerca dei Docs`

---

## Task 2: Endpoint cronologia (server) + test

**Files:**
- Modify: `apps/server/src/routes/docs.ts` (aggiungi le route dopo la `/docs/search`)
- Test: `apps/server/src/routes/docs-search.test.ts` (o nuovo `docs-history.test.ts`)

Pattern di riferimento: la route `/docs/search` (`docs.ts:525`) — `preHandler:
requireAuth`, `request.user!.id`, check esistenza progetto con `apiError(reply,
404, ...)`, schemi Zod in `response`.

**Step 1 — schemi Zod.** `historyEntrySchema` (`{slug,title,kind,clickedAt}`),
`recordHistoryBodySchema` (`{slug,title,kind}` con `kind` = enum docPageKind),
`historySlugParamsSchema` (`{projectId, slug}`).

**Step 2 — GET `/projects/:projectId/docs/history`.** requireAuth; check
progetto; `select` where `userId = request.user.id and projectId`, `orderBy
clickedAt desc`, `limit 8`. Risposta `z.array(historyEntrySchema)`.

**Step 3 — POST `/projects/:projectId/docs/history`.** Body `recordHistoryBodySchema`.
Upsert:

```ts
await app.db.insert(docSearchHistory)
  .values({ projectId, userId, slug, title, kind })
  .onConflictDoUpdate({
    target: [docSearchHistory.userId, docSearchHistory.projectId, docSearchHistory.slug],
    set: { clickedAt: new Date(), title, kind },
  });
```

Poi **poda** oltre le ultime 20 (sottoquery degli id top-20 per
userId+projectId, `delete where id not in (...)`). Risposta 204 (no content) o
l'entry; scegli 204 per semplicità.

**Step 4 — DELETE `/projects/:projectId/docs/history/:slug`.** Cancella la riga
(userId+projectId+slug). 204.

**Step 5 — DELETE `/projects/:projectId/docs/history`.** Cancella tutte le righe
(userId+projectId). 204.

**Step 6 — test (testcontainers).** Seed: 1 progetto, 2 utenti. Verifica:
- POST crea; ri-POST stesso slug NON duplica e aggiorna `clickedAt` (l'ordine cambia).
- GET ritorna solo le righe dell'utente corrente (isolamento per utente), max 8,
  ordine `clickedAt desc`.
- DELETE singola rimuove solo quella; DELETE all svuota solo per quell'utente+progetto.
- 404 su progetto inesistente; 401 senza auth.
- Poda: dopo 21 POST con slug diversi restano 20 righe.

**Step 7 — lint/typecheck/test server.** `pnpm --filter @stubwise/server typecheck && pnpm --filter @stubwise/server test docs`.

**Step 8 — commit.** `feat(server): endpoint cronologia ricerca Docs (GET/POST/DELETE)`

---

## Task 3: Client API web + query keys

**Files:**
- Modify: `apps/web/src/lib/docs-api.ts`
- Modify: `apps/web/src/lib/queries.ts` (`docsKeys`)

**Step 1 — tipi + funzioni** (stile `searchDocs`, usa `api.get/post/delete`):

```ts
export interface DocHistoryEntry { slug: string; title: string; kind: DocPageKind; clickedAt: string; }
export function getDocsHistory(projectId: string): Promise<DocHistoryEntry[]> { ... GET .../docs/history }
export function recordDocsHistoryClick(projectId: string, e: {slug:string;title:string;kind:DocPageKind}): Promise<void> { ... POST }
export function deleteDocsHistoryEntry(projectId: string, slug: string): Promise<void> { ... DELETE .../history/:slug }
export function clearDocsHistory(projectId: string): Promise<void> { ... DELETE .../history }
```

**Step 2 — query key.** In `docsKeys` aggiungi
`history: (projectId) => [...docsKeys.space(projectId), "history"] as const`.

**Step 3 — typecheck.** `pnpm --filter @stubwise/web typecheck`.

**Step 4 — commit.** `feat(web): client API cronologia ricerca Docs`

---

## Task 4: Componente `DocsCommandPalette` + test

**Files:**
- Create: `apps/web/src/components/docs-command-palette.tsx`
- Create: `apps/web/src/components/docs-command-palette.test.tsx`
- Modify: i18n `apps/web/src/i18n/locales/{it,en}.json` (chiavi `docs.palette.*`)

**Props:** `{ projectId: string; open: boolean; onClose: () => void }`.

**Comportamento:**
- Modale `role="dialog"` `aria-modal`, backdrop, focus-trap minimale (focus su
  input all'apertura; Esc chiude; clic su backdrop chiude). Ripristina il focus
  al trigger alla chiusura (il chiamante gestisce il ref del trigger, o usa
  `document.activeElement` salvato).
- Input con debounce 250ms (riusa la logica di `DocsSearch`). `< 2` caratteri →
  mostra **RECENTI** (query `getDocsHistory`, `docsKeys.history`); `>= 2` →
  risultati `searchDocs` (titolo + tag kind + snippet `line-clamp-2`).
- Lista unificata navigabile: stato `activeIndex`; `ArrowUp/Down` muove (clamp),
  `Enter` apre l'elemento attivo, `Esc` chiude. `aria-activedescendant`.
- Riga RECENTI: titolo + kind + bottone **✕** (`deleteDocsHistoryEntry`,
  optimistic update); header con **"Cancella tutto"** (`clearDocsHistory`).
- Aprire un elemento: chiama `recordDocsHistoryClick` (fire-and-forget, invalida
  `docsKeys.history`), naviga con `useNavigate` a `/docs/$projectId/$slug`, poi `onClose()`.
- Footer-hint `↑↓ naviga · ↵ apri · esc chiudi` (i18n).
- Estetica terminal: sfondo `ink-900`, bordo `line-strong`, niente bianco.

**Step 1 — test (happy-dom + router minimale + QueryClient).** Riusa il pattern
di `docs-tree.test.tsx`/`docs-space.test.tsx`. Mocka `getDocsHistory`,
`searchDocs`, le mutation. Casi:
- `open=false` non rende nulla; `open=true` rende il dialog con input a fuoco.
- Input vuoto: rende le voci RECENTI dalla history mockata.
- Digitando "auth": compaiono i risultati mockati (titolo + snippet).
- Click su un risultato: chiama record + naviga + `onClose`.
- ✕ su una voce recente: chiama deleteEntry e la riga sparisce (optimistic).
- "Cancella tutto": chiama clear e la lista si svuota.
- Tastiera: ArrowDown poi Enter apre la seconda voce.
- Esc chiama `onClose`.

**Step 2 — implementa** fino al verde.

**Step 3 — i18n** chiavi `docs.palette`: `trigger`, `placeholder`, `recents`,
`clearAll`, `removeOne` (con `{{title}}`), `noResults`, `hintNav`, `hintOpen`,
`hintClose`, `label`. Aggiungi a it.json ed en.json.

**Step 4 — lint/typecheck/test.** `pnpm --filter @stubwise/web typecheck && pnpm --filter @stubwise/web test docs-command-palette && pnpm lint`.

**Step 5 — commit.** `feat(web): command palette di ricerca dei Docs (Cmd/K)`

---

## Task 5: Trigger + wiring nel layout, rimozione search inline

**Files:**
- Create: `apps/web/src/components/docs-search-trigger.tsx`
- Modify: `apps/web/src/components/docs-sidebar.tsx` (sostituisci `<DocsSearch>` con `<DocsSearchTrigger>`)
- Modify: `apps/web/src/routes/docs/$projectId.tsx` (stato `open`, Cmd/K, render palette)
- Modify/aggiorna: `apps/web/src/routes/docs-space.test.tsx` (la search inline non c'è più)
- (eventuale) Rimuovi `apps/web/src/components/docs-search.tsx` se non più usato, e il suo test.

**Step 1 — `DocsSearchTrigger`.** Pulsante full-width stile box:
`⌕ {placeholder} ⌘K` (mostra `⌘K` su mac, `Ctrl K` altrove — opzionale; ok `⌘K`
statico). Props `{ onOpen: () => void }`. `onClick={onOpen}`. Accessibile come button.

**Step 2 — layout `$projectId.tsx`.** Stato `const [paletteOpen, setPaletteOpen] = useState(false)`.
Listener globale:
```ts
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault(); setPaletteOpen(true);
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, []);
```
Passa `onOpen={() => setPaletteOpen(true)}` alla sidebar (→ trigger) e renderizza
`<DocsCommandPalette projectId open={paletteOpen} onClose={() => setPaletteOpen(false)} />`.
Nota: `DocsSidebar` è usata sia nell'aside desktop sia nel drawer mobile —
propaga `onOpen` a entrambi (aprendo la palette il drawer mobile va chiuso).

**Step 3 — sidebar.** Rimpiazza `<DocsSearch .../>` con `<DocsSearchTrigger onOpen={...} />`.

**Step 4 — test.** Aggiorna `docs-space.test.tsx`: dove cercava l'input inline,
ora c'è il trigger; aggiungi un test "Cmd/K apre la palette" e "il trigger apre
la palette" a livello di route (mocka search/history handlers). Verifica che la
vecchia UX inline non sia più presente.

**Step 5 — lint/typecheck/test web completo.** `pnpm --filter @stubwise/web typecheck && pnpm --filter @stubwise/web test && pnpm lint`.

**Step 6 — commit.** `feat(web): palette Cmd/K al posto della ricerca inline dei Docs`

---

## Task 6: Verifica finale + E2E + deploy

**Step 1 — suite completa.** Dalla radice del worktree: `pnpm typecheck && pnpm lint && pnpm -r test` (rispetta i limiti testcontainers).

**Step 2 — E2E (UI).** Gli E2E Playwright non girano in `pnpm -r test`; se rapido,
aggiungi/lancia uno smoke che apre la palette (Cmd/K) e naviga a un risultato.
Se troppo oneroso a livello locale, annota che va verificato manualmente in prod.

**Step 3 — finishing.** REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch
(merge su main). Poi deploy: ribuilda `server` (endpoint+migrazione) e `caddy`
(frontend) sul VPS; verifica startup migrazione e bundle servito.

---

## Note trasversali

- **Snapshot title/kind**: la cronologia non fa JOIN su `doc_pages`; sopravvive
  alle rigenerazioni. Slug morto → placeholder "pagina non trovata" esistente.
- **Optimistic update**: ✕ e "Cancella tutto" aggiornano subito la cache
  `docsKeys.history`; `onError` ripristina.
- **DRY**: riusa la logica debounce/risultati di `DocsSearch` dentro la palette;
  non duplicare la riga risultato.
- **Niente over-build**: nessuna ricerca globale app, nessuna cronologia delle
  query digitate (solo pagine cliccate). YAGNI.
