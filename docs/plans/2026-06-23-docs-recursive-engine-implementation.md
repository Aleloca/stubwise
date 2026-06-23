# Motore documentazione ricorsivo a DAG — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: usa superpowers:executing-plans (o subagent-driven) per
> eseguire questo piano task-by-task.

**Goal:** Sostituire la generazione piatta (map-reduce + capability-pass) con un **DAG di job
durabili** guidato da agente: orientamento framework-aware → esplorazione ricorsiva → join/
sintesi → cross-link → finalizzazione. Output sempre `doc_pages` annidato + `doc_chunks`
(consumo invariato).

**Design di riferimento:** `docs/plans/2026-06-23-docs-recursive-engine-design.md`.

**Architettura:** una tabella `doc_nodes` modella il DAG; explore e synthesize sono **job
separati** claimabili (no deadlock sul worker singolo); il join è atomico (lock + contatore).
Logica pura (prompt, parser, helper DAG) in `packages/docs-engine`; orchestrazione in
`apps/worker`; tabella in `packages/db`. Riusa: `MirrorManager`, `AgentRunner`/`FakeAgentRunner`,
`@stubwise/embeddings`, `chunkMarkdown`, le tabelle `doc_generations`/`doc_pages`/`doc_chunks`.

**Convenzioni:** TDD dove pratico; output AI **machine-parsed sempre con contratto a marcatori
+ validazione** (lezione bug meta-summary); commit per task; messaggi `feat(docs): …`. Chiudere
i commit con `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Verifica continua:
`pnpm build && pnpm typecheck && pnpm lint` + i test per-package.

**Pattern reali da leggere prima:** `apps/worker/src/docs/{queue,reader,pipeline,handler}.ts`,
`apps/worker/src/{queue,handler,index}.ts`, `apps/worker/src/git/mirrors.ts`,
`apps/worker/src/agent/{runner,fake}.ts`, `apps/worker/src/providers/chain.ts`,
`packages/docs-engine/src/{generate,structural,chunk,index}.ts`, `packages/embeddings/src`,
`packages/db/src/schema.ts` (tabelle `doc_*`, `customType` vector, pattern migrazione/test).

---

## Milestone 1 — DB: `doc_nodes` + `doc_pages.links` + enum shared

### Task 1.1: Enum Zod condivisi (`@stubwise/shared`)
Aggiungere `docNodeStatusSchema` (`pending|exploring|awaiting_children|ready_to_synthesize|
synthesizing|done|failed`) e `docTreeSchema` (`technical|functional`) come gli enum esistenti.
Esportarli. Build + typecheck. Commit `feat(docs): enum Zod per i nodi del DAG`.

### Task 1.2: Tabella `doc_nodes` + `doc_pages.links` + migrazione
**Files:** Modify `packages/db/src/schema.ts`; nuova migrazione `drizzle/00NN_*.sql`; Test
`packages/db/src/docs-nodes.test.ts`.

**Step 1 — schema** (pattern colonne/indici come le altre tabelle doc):
```ts
export const docNodeStatus = pgEnum("doc_node_status", [
  "pending","exploring","awaiting_children","ready_to_synthesize","synthesizing","done","failed",
]);
export const docTree = pgEnum("doc_tree", ["technical","functional"]);

export const docNodes = pgTable("doc_nodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  generationId: uuid("generation_id").notNull().references(() => docGenerations.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),                       // self-ref soft (radici = null)
  tree: docTree("tree").notNull(),
  status: docNodeStatus("status").notNull().default("pending"),
  pendingChildren: integer("pending_children").notNull().default(0),
  depth: integer("depth").notNull().default(0),
  position: integer("position").notNull().default(0),
  unitRef: text("unit_ref"),                          // path o nome capability
  title: text("title").notNull().default(""),
  slug: text("slug").notNull().default(""),
  sourcePaths: jsonb("source_paths").notNull().default([]),
  body: text("body").notNull().default(""),
  links: jsonb("links"),                              // [{type,slug,title}] risolto a fine
  error: text("error"),
  cost: numeric("cost", { precision: 12, scale: 6 }),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  index("doc_nodes_generation_idx").on(t.generationId),
  index("doc_nodes_parent_idx").on(t.parentId),
  // claim: nodi processabili (pending o ready_to_synthesize) per generazione
  index("doc_nodes_claimable_idx").on(t.status, t.createdAt),
]);
```
Aggiungere `links: jsonb("links")` a `docPages`.

**Step 2 — migrazione:** generare con drizzle-kit, verificare (niente pgvector qui). Test
`docs-nodes.test.ts` (pattern `docs-schema.test.ts`): insert di una generazione + un nodo
radice + un figlio con `parent_id`; read-back; default status `pending`.

**Step 3:** `pnpm --filter @stubwise/db test`, typecheck. Commit `feat(docs): tabella doc_nodes
e links su doc_pages`.

---

## Milestone 2 — docs-engine: prompt + parser dell'output strutturato (puro, TDD)

Tutti gli output agente machine-parsed usano un **contratto a marcatori** (riuso del pattern di
`generate.ts`: `parseDelimitedBody` per-riga + validazione, NO formato libero). Mettere i nuovi
moduli in `packages/docs-engine/src/recursive/`.

### Task 2.1: Contratto e parser comuni (`recursive/contract.ts`)
- Marcatori per ciascun output (orientamento/explore/synthesize) + un parser per-riga robusto
  (riusare/estrarre `parseDelimitedBody` esistente). Per le liste di figli usare un blocco
  delimitato con righe `- title :: unit_ref :: why` (o JSON tra marcatori — scegliere e
  documentare; preferire un piccolo formato delimitato riga-per-riga, più robusto del JSON
  libero da LLM). Validazione: scartare output senza i marcatori attesi.
- Test: parsing di un output ben formato; rifiuto di output senza marcatori; estrazione robusta
  con preambolo/chiusura (stripping).

### Task 2.2: Prompt + parser orientamento (`recursive/orient.ts`)
- `buildOrientPrompt(repoSurvey)`: istruisce a rilevare framework, classificare cartelle
  (architettura vs rumore, **spiegando**), e produrre il piano: figli tecnici di 1° livello
  (title, path, why) + capability funzionali di 1° livello (title, source_paths, why), TUTTO tra
  marcatori.
- `parseOrientPlan(output)`: `{ technical: ChildSpec[], functional: ChildSpec[], notes }` con
  validazione; `ChildSpec = { title, unitRef?, sourcePaths?, why }`.
- Test (fake output): estrae i due elenchi; rifiuta output malformato.

### Task 2.3: Prompt + parser esplorazione (`recursive/explore.ts`)
- `buildExplorePrompt(node, parentContext, tree)`: due varianti (tecnico = struttura codice;
  funzionale = capability in linguaggio non tecnico, stile profondo già validato). Istruisce a:
  scrivere il body tra marcatori; elencare i figli che **meritano una pagina** (title, unitRef/
  paths, why) tra marcatori; elencare i `source_paths` coperti. Vietare meta-commento/file
  (lezione meta-summary).
- `parseExploreOutput(output)`: `{ body, children: ChildSpec[], sourcePaths: string[] }` +
  validazione (body non-meta, non vuoto). Best-effort: ritorna `null`/reason se invalido.
- Test: parsing completo; foglia (children vuoti); body meta → rifiutato.

### Task 2.4: Prompt + parser sintesi (`recursive/synthesize.ts`)
- `buildSynthesizePrompt(node, childSummaries)`: scrive l'**overview** dell'area che linka i
  figli (un "indice" + sintesi), tra marcatori, linguaggio coerente con l'albero.
- `parseSynthesisOutput(output)`: `{ body }` validato.
- Test: parsing; rifiuto malformato.

Export pubblici da `index.ts`. Commit per task. Verifica: `pnpm --filter @stubwise/docs-engine
test/typecheck`.

---

## Milestone 3 — docs-engine: helper DAG puri (TDD)

`recursive/dag.ts`:
- `dedupeChildren(children, ancestorPaths)`: scarta i figli il cui path è già coperto da un
  antenato (anti-ciclo); ritorna `{ kept, dropped }` (dropped loggati). Test.
- `slugForNode(title, used)`: slug stabile + unico (riuso del pattern slug di `generate.ts`).
  Test (collisioni).
- `resolveImplementsLinks(functionalNodes, technicalNodes)`: mappa `source_path → nodi
  tecnici`; per ogni nodo funzionale → link `implements` ai tecnici che coprono i suoi path +
  inverso `implemented_by`. Pure. Test con fixture (overlap di path → link attesi; nessun
  overlap → nessun link).
- `selectRelatedLinks(pageId, embeddings, k, exclude)`: data una funzione/sorgente di
  similarità iniettata (no I/O), seleziona le top-K pagine più simili escludendo
  padre/figlio/già-linkate. Pure. Test con vettori fittizi.
Export. Commit `feat(docs): helper DAG (dedup, slug, implements/related link)`.

---

## Milestone 4 — worker/db: coda dei job-nodo + join atomico (TDD)

### Task 4.1: Operazioni sui nodi (`apps/worker/src/docs/nodes.ts`)
Mirror dei pattern di `docs/queue.ts`, su `doc_nodes`:
- `claimNextNode(db)`: `FOR UPDATE SKIP LOCKED` su nodi **claimabili** = `status IN
  ('pending','ready_to_synthesize')`, oldest-first; transizione: `pending→exploring`,
  `ready_to_synthesize→synthesizing`; set `lastActivityAt`. Ritorna il nodo + la fase.
- `touchNode`, `failNode(id, error)` (set `failed` + finishedAt), helper di scrittura body/paths.
- `createChildren(db, parentId, specs, …)`: in transazione, inserisce le righe figlie
  (`pending`, depth+1), imposta `parent.pending_children = N`, `parent.status =
  awaiting_children`. Se `specs` vuoto → il nodo (foglia) va a `done` e si invoca il **join**
  sul padre.
- `completeLeafOrSynth(db, nodeId)`: porta il nodo a `done`, set finishedAt, poi **join** sul
  padre.

### Task 4.2: Il join atomico
- `joinParent(db, parentId)`: in **transazione con `FOR UPDATE` sul padre**, decrementa
  `pending_children`; se arriva a 0 → `parent.status = ready_to_synthesize`. Idempotente e
  race-safe.
- `requeueStaleNodes(db, minutes)`: nodi `exploring`/`synthesizing` fermi oltre soglia →
  tornano a `pending`/`ready_to_synthesize` (mirror `requeueStaleDocJobs`).

**Test** `apps/worker/src/docs/nodes.test.ts` (testcontainer):
- claim porta `pending→exploring` e `ready_to_synthesize→synthesizing`;
- createChildren imposta `pending_children` e `awaiting_children`; foglia → `done` + join;
- **race test del join:** 3 figli completati in parallelo (Promise.all su `completeLeafOrSynth`)
  → il padre passa a `ready_to_synthesize` **esattamente una volta** (assert su uno stato finale
  coerente e nessun doppio trigger);
- figlio `failed` decrementa comunque il join;
- requeueStaleNodes ripristina solo i nodi fermi.

Commit `feat(docs): coda job-nodo e join atomico (TDD)`.

---

## Milestone 5 — worker: handler orientamento + explore + synthesize (TDD)

### Task 5.1: Worktree di generazione condiviso
Estendere/riusare `MirrorManager`: serve **un worktree per generazione** vivo per tutta la
durata del DAG (non per-job). Aggiungere a `MirrorManager` (o un wrapper
`apps/worker/src/docs/generation-worktree.ts`) `openGenerationWorktree(project, generationId)` →
crea il worktree (ensureMirror + add) in un path stabile e ritorna `{ dir, commitSha, close() }`;
i job-nodo lo riusano (read-only) via `createWorktreeReader(dir)`; `close()` a finalizzazione.
Documentare l'invariante: niente fetch/prune del mirror mentre il worktree è aperto (serializza
verso i fix-job — riusare la catena per-progetto). Test del ciclo open/read/close.

### Task 5.2: Orientamento (trigger → radici)
`apps/worker/src/docs/recursive/orient-handler.ts`:
- al claim del trigger (`doc_generation_jobs`): crea `doc_generations` `running`, apre il
  worktree di generazione, fa un **survey** del repo (top-level + manifest via il reader),
  costruisce `buildOrientPrompt`, esegue l'agente (read-only, `permissionMode:"plan"`, modello
  `DOC_GENERATION_MODEL`), `parseOrientPlan`.
- Crea le **due radici** (`doc_nodes` tecnica+funzionale, `done`? no: radici sono nodi-ramo →
  `awaiting_children`) e i **nodi di 1° livello** (`pending`) dai due elenchi, con
  `pending_children` impostato sulle radici.
- Best-effort/validazione come al solito. Heartbeat.
- Test (FakeAgentRunner che ritorna un piano marcato): crea 2 radici + N figli pending;
  `pending_children` corretto.

### Task 5.3: Explore handler
`recursive/explore-handler.ts`: dato un nodo `exploring`, costruisce `buildExplorePrompt`,
esegue l'agente nel worktree, `parseExploreOutput` (retry una volta su invalido, poi `failNode`
+ join), scrive `body`+`source_paths`, poi `createChildren(specs)` (con `dedupeChildren` vs
antenati) **oppure** foglia→done+join. Applica i cap (`DOC_MAX_DEPTH`, `DOC_MAX_NODES`) con
logging. Test con FakeAgentRunner: ramo → figli+awaiting; foglia → done+join; output invalido →
retry→fallback→failed+join; cap profondità → niente figli (loggato).

### Task 5.4: Synthesize handler
`recursive/synthesize-handler.ts`: dato un nodo `synthesizing`, raccoglie titoli/riassunti dei
figli (`done`), costruisce `buildSynthesizePrompt`, esegue l'agente, `parseSynthesisOutput`,
scrive l'overview nel `body` (intro+overview+link ai figli), poi `completeLeafOrSynth` (→ done +
join sul padre). Test: padre con 2 figli done → body con i link → done → join sul nonno.

Commit per task. Verifica worker test.

---

## Milestone 6 — worker: finalizzazione (cross-link → proiezione → embed → swap)

`recursive/finalize.ts`, invocato quando la **radice** raggiunge `done` (rilevato nel join: se
il nodo che va `done` è una radice e tutte le radici sono `done` → finalizza):
1. **Implements links:** `resolveImplementsLinks` su tutti i nodi della generazione → scrive
   `links` (implements/implemented_by) sui nodi.
2. **Proiezione → `doc_pages`:** per ogni nodo `done`, crea una `doc_page` (mappa
   `parentId`/`kind=tree`/slug/title/body/source_path=primo path/`links`), legata alla
   generazione. Mappare i `parentId` dei nodi → `parentId` delle pagine (due passaggi:
   inserisci, poi risolvi i parent per id-nodo→id-pagina).
3. **Chunk+embed:** `chunkMarkdown` su ogni pagina → `embeddingClient.embed` (batch
   `EMBED_BATCH_SIZE`) → `doc_chunks` (riuso esatto della pipeline attuale, in **transazione**).
4. **Related links:** `selectRelatedLinks` per ogni pagina usando gli embedding appena scritti
   (query pgvector) → aggiorna `doc_pages.links` con i `related`.
5. **Swap** `currentDocGenerationId` (atomico) + prune generazioni vecchie + `close()` del
   worktree + `completeDocJob` del trigger. Stats in `doc_generations` (nodi, profondità,
   fallimenti, costo aggregato).
Best-effort/transazioni come la pipeline esistente (rollback parziale → niente swap).

**Test** (testcontainer + FakeAgentRunner + FakeEmbeddingClient): un mini-DAG completo →
`doc_pages` annidate (≥3 livelli), `doc_chunks` con embedding, `links` implements presenti,
swap del puntatore, worktree chiuso. Commit `feat(docs): finalizzazione DAG (cross-link,
proiezione, embed, swap) (TDD)`.

---

## Milestone 7 — worker: dispatch + rimozione vecchio motore

### Task 7.1: Dispatch dei job-nodo nel loop
Estendere `runWorker` (`apps/worker/src/queue.ts`) per reclamare anche i `doc_nodes` claimabili
e dispatchare a explore/synthesize handler (oltre al trigger orientamento e ai fix-job),
rispettando la **catena per-progetto** (il worktree di generazione serializza verso i fix) e la
priorità (fix-first, già loggata). Aggiungere `requeueStaleNodes`. Concorrenza: i nodi
parallelizzano fino alla concorrenza del worker. Test d'integrazione leggero: un trigger →
orientamento → N nodi processati → finalizzazione → `succeeded`.

### Task 7.2: Rimuovere il vecchio motore
Una volta verde il nuovo percorso: rimuovere `runDocGenerationJob` (map-reduce) e il
capability-pass da `apps/worker/src/docs/pipeline.ts` e da `packages/docs-engine`
(`buildRepoMap`/`runGeneration`/`buildModulePrompt`/`buildReducePrompt`/`buildCapabilityPrompt`
e relativi test) **solo** se non più referenziati. Aggiornare `index.ts`/`handler.ts` per
puntare al nuovo orientamento. Verificare typecheck/test verdi dopo la rimozione. Commit
`refactor(docs): rimuove la generazione piatta sostituita dal DAG`.

---

## Milestone 8 — server/web: cross-link UI + verifica albero profondo

### Task 8.1: API espone `links`
`apps/server/src/routes/docs.ts`: includere `links` nello schema di risposta della pagina
(`GET .../docs/pages/:slug`). Test.

### Task 8.2: Sezione "Implementa / Correlati" (web)
`apps/web/src/routes/docs/$projectId.tsx` (DocsPageView): rendere `page.links` come piccola
sezione con link a `/docs/$projectId/$slug` (raggruppati per type: implements/implemented_by/
related). Additivo. Component test (link presenti + href corretti). Verificare che `DocsTree`
(già ricorsivo) renda un albero a **3 livelli** (test con fixture annidata).

Commit per task.

---

## Milestone 9 — config, docs, verifica finale

### Task 9.1: Config worker
`apps/worker/src/config.ts`: `DOC_MAX_DEPTH` (default 6), `DOC_MAX_NODES` (default ~400),
riusare `DOC_GENERATION_MODEL`/`DOC_AGENT_TIMEOUT_MS`/`EMBEDDING_*`. Cablare negli handler.
`.env.example`. Test parse.

### Task 9.2: Docs Starlight
Aggiornare la pagina `apps/docs/.../autogenerated.md`: il nuovo modello ricorsivo (alberi
annidati, cross-link), nessun cambiamento d'uso per l'utente (Generate resta uguale). Build docs.

### Task 9.3: Verifica finale
`pnpm build && pnpm typecheck && pnpm lint` verdi; test per-package toccati singolarmente
(testcontainer); E2E navigazione albero profondo + link. Commit fix se servono.

---

## Note di esecuzione
- Riusare il più possibile: `MirrorManager`, `AgentRunner`/`FakeAgentRunner`, `createWorktreeReader`,
  `@stubwise/embeddings`, `chunkMarkdown`, le tabelle `doc_generations`/`doc_pages`/`doc_chunks`,
  i pattern testcontainer.
- Tutti gli output agente machine-parsed: **contratto a marcatori + validazione + retry-poi-
  fallback** (mai formato libero).
- Deploy = rebuild immagine worker (+ web per la sezione links) + migrazione `doc_nodes`
  applicata all'avvio del server. Nessun cambiamento a ricerca/chat.
- L'aggiornamento incrementale dai push è **fuori scope** ma predisposto (source_paths per nodo).
