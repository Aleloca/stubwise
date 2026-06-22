# Documentazione autogenerata (Confluence-like) — Implementation Plan (v1)

> **For Claude:** REQUIRED SUB-SKILL: usa superpowers:executing-plans per implementare questo piano task-by-task.

**Goal:** Generare per ogni progetto collegato una documentazione tecnica + funzionale
approfondita a partire dal codice (map-reduce gerarchico con map agentico), consultabile in
una sezione "Docs" di primo livello e tramite chat RAG (pgvector + Claude).

**Architecture:** Nuovo dominio "Docs" sopra l'infra esistente. Logica pura in
`packages/docs-engine`; un nuovo tipo di job **per-progetto** nel worker che clona il repo in
worktree (riuso `MirrorManager`), esegue agent Claude **read-only** per modulo (map) e di
sintesi (reduce), poi chunk+embed in **pgvector**. Server Fastify espone trigger/lettura/
ricerca/chat (streaming). Web aggiunge la sezione Docs.

**Tech Stack:** TypeScript, pnpm workspaces, Drizzle + Postgres (+pgvector), Fastify+Zod,
React+Vite+TanStack Router/Query, Vitest+testcontainers, embedding self-hosted via Ollama
(`bge-m3`, 1024 dim) attraverso API OpenAI-compatibile.

**Design di riferimento:** `docs/plans/2026-06-22-stubwise-docs-confluence-design.md`.

---

## Decisioni risolte (leggere prima di iniziare)

1. **Job per-progetto, tabella dedicata.** I job AI esistenti (`aiJobs`) sono legati al
   ticket; non li tocchiamo (preservano l'invariante staleness). La doc-generation usa una
   nuova tabella `doc_generation_jobs` (project-scoped) con un proprio claim/loop, che riusa
   `MirrorManager`, `AgentRunner`, provider chain e i pattern di heartbeat.
2. **Generazione read-only.** Gli agent girano in `permissionMode: "plan"` (nessuna scrittura
   sul repo, nessun commit/push). L'output strutturato torna via stdout JSON e viene salvato
   in Postgres.
3. **pgvector a 1024 dim** (bge-m3). Il modello è configurabile ma la dimensione è fissata
   in migrazione; cambiare famiglia di modello con dimensione diversa richiede una migrazione
   (documentato).
4. **Embedding provider via config/env** (non DB) per la v1: `EMBEDDING_BASE_URL`,
   `EMBEDDING_MODEL`, `EMBEDDING_API_KEY?`. Client contro `/v1/embeddings` OpenAI-compatibile;
   default self-hosted Ollama (`http://ollama:11434/v1`, `bge-m3`, nessuna key).
5. **Costo** tracciato in `doc_generations.cost` (aggregato) + breakdown nelle `stats` jsonb.
   Niente modifica a `agentRuns` (FK su `aiJobs`).
6. **Cap di costo/limiti** loggati esplicitamente (niente cap silenziosi).

**Convenzioni di commit:** un commit per task completato (test + impl insieme quando il task è
una coppia test→impl). Messaggi `feat(docs): ...`, `test(docs): ...`, `chore(docs): ...`.
Chiudere ogni commit con `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Verifica continua:** dopo ogni milestone, dal root del worktree:
`pnpm build && pnpm typecheck && pnpm lint`. I test per-package: `pnpm --filter <pkg> test`.
(Il build è necessario prima del typecheck: i package dipendono dai `dist/*.d.ts` a monte —
vedi `@stubwise/shared`.)

---

## Milestone 0 — Scaffolding del package `docs-engine`

### Task 0.1: Creare il package `packages/docs-engine`

**Files:**
- Create: `packages/docs-engine/package.json`
- Create: `packages/docs-engine/tsconfig.json`
- Create: `packages/docs-engine/tsconfig.build.json`
- Create: `packages/docs-engine/vitest.config.ts`
- Create: `packages/docs-engine/src/index.ts`

**Step 1: Copiare la struttura di un package puro esistente come riferimento.**
Leggi `packages/i18n/package.json`, `packages/i18n/tsconfig.json`,
`packages/i18n/tsconfig.build.json` per replicare ESATTAMENTE script e campi (name, exports,
`type: module`, script `build`/`test`/`typecheck`).

**Step 2: Scrivere `package.json`** (adatta nome e versione dal riferimento):

```json
{
  "name": "@stubwise/docs-engine",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@stubwise/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```
(Verifica i nomi/versioni reali in `packages/i18n/package.json`; usa `catalog:` se quel
package lo usa, altrimenti le versioni esplicite.)

**Step 3: `tsconfig.json` / `tsconfig.build.json`** identici per struttura a quelli di
`packages/i18n` (extends `../../tsconfig.base.json`, `outDir: dist`, `rootDir: src`).

**Step 4: `vitest.config.ts`** — i test sono puri (no Postgres), quindi config minimale:
```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
```

**Step 5: `src/index.ts`** placeholder: `export {};`

**Step 6: Installare e verificare.**
Run: `pnpm install && pnpm --filter @stubwise/docs-engine build`
Expected: build OK, nessun errore.

**Step 7: Commit.**
```bash
git add packages/docs-engine pnpm-lock.yaml
git commit -m "chore(docs): scaffolding package @stubwise/docs-engine"
```

---

## Milestone 1 — Schema DB + migrazione pgvector

### Task 1.1: Custom type `vector` e tabelle Docs nello schema

**Files:**
- Modify: `packages/db/src/schema.ts`
- Test: `packages/db/src/docs-schema.test.ts` (Create)

**Step 1: Aggiungere il custom type `vector`** vicino al `tsvector` esistente
(`packages/db/src/schema.ts:31-35`). La dimensione è parametrica:

```typescript
const vector = (dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: string): number[] {
      return value.slice(1, -1).split(",").map(Number);
    },
  })("embedding");
```

**Step 2: Aggiungere gli enum** (pattern `pgEnum` come gli esistenti, valori da
`@stubwise/shared` se condivisi — vedi Task 1.3 per gli schema Zod in shared):

```typescript
export const docPageKind = pgEnum("doc_page_kind", ["technical", "functional", "manual"]);
export const docGenerationStatus = pgEnum("doc_generation_status", [
  "pending", "running", "succeeded", "failed",
]);
export const docGenerationTrigger = pgEnum("doc_generation_trigger", ["manual", "push"]);
export const docJobStatus = pgEnum("doc_job_status", [
  "queued", "running", "succeeded", "failed", "held",
]);
```

**Step 3: Tabelle.** Aggiungere in coda allo schema (pattern colonne/indici come `tickets`):

```typescript
export const docGenerations = pgTable("doc_generations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  status: docGenerationStatus("status").notNull().default("pending"),
  commitSha: text("commit_sha"),
  trigger: docGenerationTrigger("trigger").notNull().default("manual"),
  model: text("model"),
  cost: numeric("cost", { precision: 12, scale: 6 }),
  stats: jsonb("stats"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("doc_generations_project_idx").on(t.projectId)]);

// La generazione "corrente" del progetto: FK su projects (Task 1.2) o tabella pivot.
export const docPages = pgTable("doc_pages", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  generationId: uuid("generation_id").references(() => docGenerations.id, { onDelete: "cascade" }),
  kind: docPageKind("kind").notNull(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  parentId: uuid("parent_id"),
  position: integer("position").notNull().default(0),
  sourcePath: text("source_path"),
  body: text("body").notNull().default(""),
  isManual: boolean("is_manual").notNull().default(false),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  searchTsv: tsvector("search_tsv").generatedAlwaysAs(
    (): SQL => sql`to_tsvector('english', coalesce(${docPages.title}, '') || ' ' || coalesce(${docPages.body}, ''))`,
  ),
}, (t) => [
  index("doc_pages_project_idx").on(t.projectId),
  index("doc_pages_generation_idx").on(t.generationId),
  uniqueIndex("doc_pages_project_slug_unique").on(t.projectId, t.slug),
  index("doc_pages_search_tsv_idx").using("gin", t.searchTsv),
]);

export const docChunks = pgTable("doc_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  pageId: uuid("page_id").notNull().references(() => docPages.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  generationId: uuid("generation_id").references(() => docGenerations.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  embedding: vector(1024),
  metadata: jsonb("metadata"),
  tokenCount: integer("token_count"),
}, (t) => [index("doc_chunks_project_idx").on(t.projectId)]);
// NB: l'indice HNSW sull'embedding va in SQL a mano nella migrazione (Task 1.2).

export const docGenerationJobs = pgTable("doc_generation_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  generationId: uuid("generation_id").references(() => docGenerations.id, { onDelete: "set null" }),
  status: docJobStatus("status").notNull().default("queued"),
  trigger: docGenerationTrigger("trigger").notNull().default("manual"),
  log: text("log").notNull().default(""),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("doc_generation_jobs_status_idx").on(t.status),
  index("doc_generation_jobs_project_idx").on(t.projectId),
]);

export const docChatSessions = pgTable("doc_chat_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("doc_chat_sessions_project_idx").on(t.projectId)]);

export const docChatMessages = pgTable("doc_chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => docChatSessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // "user" | "assistant"
  content: text("content").notNull(),
  citations: jsonb("citations"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("doc_chat_messages_session_idx").on(t.sessionId)]);
```

**Step 4: Test** `packages/db/src/docs-schema.test.ts` (pattern da
`packages/db/src/schema.test.ts`):

```typescript
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Db } from "./index.js";
import { docGenerations, docPages, projects } from "./index.js";
import { startTestDb, type TestDb } from "./testing.js";

let testDb: TestDb; let db: Db;
beforeAll(async () => { testDb = await startTestDb(); db = testDb.db; });
afterAll(async () => { await testDb.stop(); });

it("persiste una generazione e una pagina manuale (generationId null)", async () => {
  const [project] = await db.insert(projects).values(/* campi minimi richiesti, copia da schema.test */).returning();
  const [gen] = await db.insert(docGenerations).values({ projectId: project!.id }).returning();
  const [page] = await db.insert(docPages).values({
    projectId: project!.id, generationId: null, kind: "manual",
    slug: "guida", title: "Guida", isManual: true,
  }).returning();
  const [read] = await db.select().from(docPages).where(eq(docPages.id, page!.id));
  expect(read?.generationId).toBeNull();
  expect(read?.isManual).toBe(true);
  expect(gen!.status).toBe("pending");
});
```

**Step 5: Run test (fallisce — manca la migrazione/estensione).**
Run: `pnpm --filter @stubwise/db test -- docs-schema`
Expected: FAIL (tabelle/estensione `vector` inesistenti).

→ procede in Task 1.2.

### Task 1.2: Migrazione SQL `0026` (estensione vector + tabelle + HNSW + current generation)

**Files:**
- Create: `packages/db/drizzle/0026_docs.sql` (oppure generata via drizzle-kit poi editata)
- Modify: `packages/db/src/schema.ts` (aggiungere `currentDocGenerationId` a `projects`)

**Step 1: Aggiungere a `projects`** una colonna per la generazione corrente:
```typescript
currentDocGenerationId: uuid("current_doc_generation_id"),
```
(FK soft: si imposta dopo lo swap; niente reference circolare hard per evitare problemi
d'ordine in migrazione — validare a livello applicativo.)

**Step 2: Generare la migrazione** con drizzle-kit (`pnpm --filter @stubwise/db exec
drizzle-kit generate`) e poi **editare il file `0026_*.sql`** per:
- mettere in cima `CREATE EXTENSION IF NOT EXISTS vector;`
- aggiungere l'indice HNSW (drizzle non lo genera):

```sql
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
-- (CREATE TYPE enum..., CREATE TABLE doc_* ... generati da drizzle-kit) ...
--> statement-breakpoint
CREATE INDEX doc_chunks_embedding_idx ON doc_chunks USING hnsw (embedding vector_cosine_ops);
```

**Step 3: Verificare che il testcontainer abbia pgvector.** L'immagine attuale è
`postgres:17-alpine` (`packages/db/src/testing.ts`), che **non** include pgvector. Cambiare
in `pgvector/pgvector:pg17` in `testing.ts`:
```typescript
const container = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
```
E nel `docker-compose.yml` di produzione cambiare l'immagine Postgres in
`pgvector/pgvector:pg17` (Task 8.1).

**Step 4: Run test (ora passa).**
Run: `pnpm --filter @stubwise/db test -- docs-schema`
Expected: PASS.

**Step 5: Test embedding round-trip** (aggiungere a `docs-schema.test.ts`): inserire un
`docChunks` con `embedding` di 1024 numeri e una ricerca per distanza coseno:
```typescript
it("inserisce un chunk con embedding e fa ricerca per distanza coseno", async () => {
  // ...seed project, generation, page...
  const emb = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
  await db.insert(docChunks).values({ pageId, projectId, content: "ciao", embedding: emb });
  const rows = await db.execute(sql`
    SELECT content FROM doc_chunks
    ORDER BY embedding <=> ${`[${emb.join(",")}]`}::vector LIMIT 1`);
  expect(rows[0]?.content).toBe("ciao");
});
```
Run: `pnpm --filter @stubwise/db test -- docs-schema` → PASS.

**Step 6: Commit.**
```bash
git add packages/db
git commit -m "feat(docs): schema + migrazione pgvector per documentazione"
```

### Task 1.3: Schema Zod condivisi in `@stubwise/shared`

**Files:**
- Modify: `packages/shared/src/...` (dove vivono gli altri enum Zod, es. `ticketTypeSchema`)

**Step 1:** Aggiungere `docPageKindSchema`, `docGenerationStatusSchema`,
`docGenerationTriggerSchema`, `docJobStatusSchema` come gli enum esistenti, ed esportarli.
Far derivare gli `pgEnum` del db da questi (come fa già lo schema per gli altri enum).

**Step 2:** Build + typecheck.
Run: `pnpm --filter @stubwise/shared build && pnpm --filter @stubwise/db typecheck`
Expected: 0 errori.

**Step 3: Commit.**
```bash
git add packages/shared packages/db
git commit -m "feat(docs): enum Zod condivisi per il dominio Docs"
```

---

## Milestone 2 — `docs-engine`: pass strutturale (puro, TDD)

Logica deterministica e testabile con fixture in-memory. Niente fs reale: si inietta un
**reader** astratto.

### Task 2.1: Tipi e interfaccia del filesystem reader

**Files:**
- Create: `packages/docs-engine/src/types.ts`
- Create: `packages/docs-engine/src/fs.ts`

**Step 1: `types.ts`** — il repo map e i moduli:
```typescript
export interface RepoFile { path: string; size: number; }
export interface ModuleNode {
  path: string;            // dir del modulo, relativa alla root
  language: string | null; // linguaggio dominante
  files: string[];         // path file del modulo
  manifest: string | null; // package.json | composer.json | ...
  publicSurface: string[]; // export/route/CLI rilevati (path o simboli)
  dependsOn: string[];     // path di altri moduli (dep graph)
  score: number;           // priorità (size + centralità + superficie)
}
export interface RepoMap {
  languages: Record<string, number>; // ext -> #file
  modules: ModuleNode[];
  skipped: { path: string; reason: string }[]; // cap loggati
}
```

**Step 2: `fs.ts`** — reader astratto (impl reale nel worker, fake nei test):
```typescript
export interface RepoReader {
  list(): Promise<RepoFile[]>;            // tutti i file tracciati (gia' al netto di .gitignore)
  read(path: string): Promise<string>;    // contenuto testuale
}
```

**Step 3: Commit.**
```bash
git add packages/docs-engine/src/types.ts packages/docs-engine/src/fs.ts
git commit -m "feat(docs): tipi RepoMap e RepoReader in docs-engine"
```

### Task 2.2: Rilevamento linguaggi ed esclusioni (TDD)

**Files:**
- Test: `packages/docs-engine/src/structural.test.ts` (Create)
- Create: `packages/docs-engine/src/structural.ts`

**Step 1: Test (fallisce).**
```typescript
import { describe, expect, it } from "vitest";
import { buildRepoMap } from "./structural.js";
import type { RepoReader, RepoFile } from "./fs.js";

function reader(files: Record<string, string>): RepoReader {
  const list: RepoFile[] = Object.keys(files).map((p) => ({ path: p, size: files[p]!.length }));
  return { list: async () => list, read: async (p) => files[p] ?? "" };
}

describe("buildRepoMap", () => {
  it("conta i linguaggi per estensione ed esclude build/dist", async () => {
    const map = await buildRepoMap(reader({
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 2;",
      "dist/a.js": "x", // escluso
      "README.md": "# hi",
    }), { maxModules: 50 });
    expect(map.languages[".ts"]).toBe(2);
    expect(map.languages[".js"]).toBeUndefined(); // dist escluso
    expect(map.skipped.some((s) => s.path.startsWith("dist"))).toBe(true);
  });
});
```
Run: `pnpm --filter @stubwise/docs-engine test -- structural`
Expected: FAIL (buildRepoMap non definita).

**Step 2: Implementare** `buildRepoMap` (esclusioni: `dist/`, `build/`, `node_modules/`,
`vendor/`, `.git/`, file binari per estensione; conteggio linguaggi; `skipped` per ogni
esclusione rilevante). Vedi commento inline per la lista esatta di esclusioni.

**Step 3: Run → PASS.** Commit:
```bash
git add packages/docs-engine/src/structural.ts packages/docs-engine/src/structural.test.ts
git commit -m "feat(docs): rilevamento linguaggi ed esclusioni (TDD)"
```

### Task 2.3: Identificazione moduli + manifest (TDD)

**Step 1: Test** — un repo con `packages/a/package.json` e `packages/b/package.json` produce
due moduli con `manifest` valorizzato e `files` corretti; sotto-directory senza manifest
diventano moduli a profondità configurabile.
**Step 2: Implementare** la segmentazione in moduli (confini = manifest; fallback = directory
a `moduleDepth` default 2).
**Step 3: PASS + commit** `feat(docs): identificazione moduli e manifest`.

### Task 2.4: Superficie pubblica + dependency graph (TDD)

**Step 1: Test** — un modulo TS con `export function foo` e `import { x } from "../b"`
produce `publicSurface` contenente `foo` e `dependsOn` contenente il modulo `b`. (Euristiche
regex per TS/JS in v1; estendibili per altri linguaggi.)
**Step 2: Implementare** estrazione `export ...` e risoluzione import relativi → modulo.
**Step 3: PASS + commit** `feat(docs): superficie pubblica e dependency graph (TDD)`.

### Task 2.5: Scoring e prioritizzazione con limiti (TDD)

**Step 1: Test** — con `maxModules: 2` su 5 moduli, vengono tenuti i 2 con score più alto e
gli altri 3 finiscono in `skipped` con `reason: "module budget"`.
**Step 2: Implementare** `score = w1*size + w2*centralità(dep) + w3*publicSurface`, ordinamento
e cap con logging in `skipped`.
**Step 3: PASS + commit** `feat(docs): scoring e cap moduli con logging (TDD)`.

---

## Milestone 3 — `docs-engine`: orchestrazione map-reduce + chunking (puro, TDD)

L'orchestrazione è pura: riceve un **AgentFn** iniettato (così i test usano un fake e il
worker passa l'agent reale).

### Task 3.1: Contratti map/reduce e prompt builder (TDD)

**Files:**
- Create: `packages/docs-engine/src/generate.ts`
- Test: `packages/docs-engine/src/generate.test.ts`

**Step 1: Tipi**:
```typescript
export interface ModuleDoc {
  modulePath: string;
  technicalMarkdown: string;
  functionalMarkdown: string;
}
export interface GeneratedPage {
  kind: "technical" | "functional";
  slug: string; title: string; parentSlug: string | null;
  sourcePath: string | null; body: string;
}
export type AgentFn = (input: { prompt: string; cwd?: string }) => Promise<string>;
```

**Step 2: Test del prompt builder** — `buildModulePrompt(module, repoMap)` include il path
del modulo, i file e l'istruzione a produrre due sezioni (tecnica + funzionale). Asserire che
il prompt contenga i marker attesi.

**Step 3: Implementare** `buildModulePrompt` e `buildReducePrompt(moduleDocs)`.

**Step 4: PASS + commit** `feat(docs): prompt builder map/reduce (TDD)`.

### Task 3.2: `runGeneration` orchestrazione con AgentFn fake (TDD)

**Step 1: Test** — dato un `RepoMap` con 2 moduli e un `AgentFn` fake che ritorna JSON
strutturato, `runGeneration` chiama l'agent per ogni modulo (map) + 1 volta per la sintesi
(reduce) e produce un albero di `GeneratedPage` con: overview tecnica (root), pagina tecnica
per modulo, pagine funzionali. Asserire conteggi e parentSlug.

**Step 2: Implementare** `runGeneration({ repoMap, agent, limits, onProgress })`:
- map: per ogni modulo (entro budget) `agent(buildModulePrompt(...))` → parse → `ModuleDoc`;
  fallimento per-modulo = best-effort (modulo annotato, prosegue);
- reduce: `agent(buildReducePrompt(moduleDocs))` → overview tecnica + mappa funzionale;
- compone `GeneratedPage[]` con slug stabili e gerarchia.
- `onProgress(msg)` per heartbeat (lo userà il worker per `touchJob`).

**Step 3: Test best-effort** — un AgentFn che lancia su un modulo non blocca la generazione;
la pagina di quel modulo è assente ma le altre ci sono e il risultato segnala il fallimento.

**Step 4: PASS + commit** `feat(docs): orchestrazione runGeneration map-reduce (TDD)`.

### Task 3.3: Chunking markdown-aware (TDD)

**Step 1: Test** — `chunkMarkdown(md, { targetTokens, overlap })` spezza per heading,
rispetta un target approssimato di token (stima parole→token), e mantiene un overlap. Asserire
che ogni chunk porti l'heading di provenienza nei metadata.

**Step 2: Implementare** `chunkMarkdown` (split per `#`/`##`, accorpamento fino a target,
overlap di N righe/parole).

**Step 3: PASS + commit** `feat(docs): chunking markdown-aware (TDD)`.

### Task 3.4: Export pubblico del package

**Step 1:** In `src/index.ts` esportare: `buildRepoMap`, `runGeneration`, `chunkMarkdown`,
tipi. Build.
**Step 2: Commit** `chore(docs): export pubblici docs-engine`.

---

## Milestone 4 — Embedding provider (TDD)

Client OpenAI-compatibile per `/v1/embeddings`, riusabile da worker e server. Lo mettiamo in
un piccolo package condiviso `packages/embeddings` (puro, con `fetch` iniettabile) per non
duplicarlo.

### Task 4.1: Scaffolding `packages/embeddings`
Come Task 0.1 (package puro). Dipendenze: nessuna oltre dev. Commit
`chore(docs): scaffolding package @stubwise/embeddings`.

### Task 4.2: `EmbeddingClient` contro `/v1/embeddings` (TDD)

**Files:**
- Create: `packages/embeddings/src/index.ts`
- Test: `packages/embeddings/src/index.test.ts`

**Step 1: Test** con `fetch` fake:
```typescript
import { expect, it, vi } from "vitest";
import { createEmbeddingClient } from "./index.js";

it("chiama /v1/embeddings e ritorna i vettori", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const client = createEmbeddingClient({
    baseUrl: "http://ollama:11434/v1", model: "bge-m3", fetch: fetchMock,
  });
  const out = await client.embed(["a", "b"]);
  expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(String(url)).toBe("http://ollama:11434/v1/embeddings");
  expect(JSON.parse(String(init!.body))).toMatchObject({ model: "bge-m3", input: ["a", "b"] });
});

it("invia Authorization se apiKey presente", async () => { /* ... */ });
it("propaga errore HTTP con messaggio chiaro", async () => { /* status 500 -> throw */ });
```
Run: `pnpm --filter @stubwise/embeddings test`
Expected: FAIL.

**Step 2: Implementare** `createEmbeddingClient({ baseUrl, model, apiKey?, fetch? })` con
metodo `embed(inputs: string[]): Promise<number[][]>` (POST JSON, header opzionale,
gestione errori). Esportare anche un `FakeEmbeddingClient` deterministico per i test di
worker/server (es. hash del testo → vettore stabile di 1024 dim).

**Step 3: PASS + commit** `feat(docs): EmbeddingClient OpenAI-compatibile (TDD)`.

---

## Milestone 5 — Worker: pipeline doc-generation (TDD)

Riusa `MirrorManager`, `AgentRunner`, provider chain, pattern staleness. Job project-scoped
con claim/loop dedicati.

### Task 5.1: Config worker per Docs

**Files:**
- Modify: `apps/worker/src/config.ts`

**Step 1:** Aggiungere (pattern Zod come gli esistenti, es. `FIX_PLAN_MODEL`):
`DOC_GENERATION_MODEL` (default "opus"), `DOC_MAX_MODULES` (default 80),
`DOC_MODULE_MAX_TURNS` (default 30), `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL` (default
"bge-m3"), `EMBEDDING_API_KEY` (opzionale).
**Step 2:** Aggiornare `assertStaleInvariant` se introduce un timeout job doc (mantenere
`WORKER_STALE_MINUTES > timeout doc-job + margine`). Vedi memory invariante staleness.
**Step 3: Commit** `feat(docs): config worker per doc-generation`.

### Task 5.2: Claim e transizioni job doc (TDD)

**Files:**
- Create: `apps/worker/src/docs/queue.ts`
- Test: `apps/worker/src/docs/queue.test.ts`

**Step 1: Test** (pattern `queue.test.ts`): enqueue di un `doc_generation_jobs`, `claimNextDocJob`
lo porta a `running` con `startedAt`; `touchDocJob` bumpa `lastActivityAt`; `requeueStaleDocJobs`
rimette in `queued` i job `running` fermi oltre soglia.

**Step 2: Implementare** `claimNextDocJob` (`FOR UPDATE SKIP LOCKED`), `touchDocJob`,
`completeDocJob`, `failDocJob`, `holdDocJob`, `requeueStaleDocJobs` — copiando i pattern di
`apps/worker/src/queue.ts:25-278`.

**Step 3: PASS + commit** `feat(docs): claim/transizioni job doc-generation (TDD)`.

### Task 5.3: Real `RepoReader` da worktree + pipeline (TDD con fake)

**Files:**
- Create: `apps/worker/src/docs/pipeline.ts`
- Create: `apps/worker/src/docs/reader.ts`
- Test: `apps/worker/src/docs/pipeline.test.ts`

**Step 1: `reader.ts`** — implementa `RepoReader` su una directory di worktree:
`list()` = `git ls-files` nel worktree (così rispetta `.gitignore`); `read()` = lettura file.

**Step 2: Test della pipeline** con `FakeAgentRunner` (da `apps/worker/src/agent/fake.ts`) e
`FakeEmbeddingClient`: seed progetto + un mirror bare locale (pattern `handler.test.ts`),
invoca `runDocGenerationJob`, asserisce che:
- venga creata una `doc_generations` `succeeded` con `commitSha` valorizzato;
- esistano `doc_pages` (tecniche + funzionali) e `doc_chunks` con embedding;
- `projects.currentDocGenerationId` punti alla nuova generazione (swap);
- la generazione precedente venga prunata (oltre corrente+1).

**Step 3: Implementare `runDocGenerationJob(deps, job)`**:
1. crea `doc_generations` `running`; collega al job;
2. `mirrors.ensureMirror(project)` + `mirrors.withWorktree(project, async (dir, commitSha) => {`
3.   `reader = createWorktreeReader(dir)`; `repoMap = await buildRepoMap(reader, { maxModules })`;
4.   `agent = (input) => runner.run({ cwd: dir, prompt: input.prompt, model: DOC_GENERATION_MODEL, permissionMode: "plan", maxTurns: DOC_MODULE_MAX_TURNS, provider }).then(r => r.output)`
5.   `pages = await runGeneration({ repoMap, agent, limits, onProgress: (m) => touchDocJob(...) })`
6.   persisti `doc_pages` (albero), poi per ogni pagina `chunkMarkdown` → `embed` → `doc_chunks`;
7.   registra costo aggregato in `doc_generations.cost` + `stats`;
8. `})`
9. swap `currentDocGenerationId`, prune vecchie, `completeDocJob`.
   Gestione errori: `failDocJob` + `doc_generations.status = failed`. Heartbeat via `onProgress`.
   Cap di costo: se `cost > limite` → `holdDocJob` + notifica (riuso pattern budget).

**Step 4: PASS + commit** `feat(docs): pipeline runDocGenerationJob nel worker (TDD)`.

### Task 5.4: Integrare il loop doc nel runWorker

**Files:**
- Modify: `apps/worker/src/queue.ts` (o il punto di avvio del loop) / `apps/worker/src/index.ts`

**Step 1:** Nel ciclo principale, oltre a `claimNextJob` (fix), chiamare `claimNextDocJob` e
dispatchare a `runDocGenerationJob`, rispettando la **catena per-progetto** (`handler.ts`
chains map) così un doc-job e un fix-job dello stesso progetto si serializzano e i doc-job non
affamano i fix (priorità: i fix per primi nel claim, oppure slot separato — scegliere e
**loggare** la politica). Aggiungere `requeueStaleDocJobs` accanto a `requeueStale`.
**Step 2:** Test di integrazione leggero (un doc-job e un fix-job sullo stesso progetto non si
sovrappongono).
**Step 3: Commit** `feat(docs): dispatch job doc nel loop worker`.

---

## Milestone 6 — Server: API Docs (TDD)

### Task 6.1: Trigger generazione + stato

**Files:**
- Create: `apps/server/src/routes/docs.ts`
- Test: `apps/server/src/routes/docs.test.ts`
- Modify: `apps/server/src/app.ts` (register con prefix `/api`)

**Step 1: Test** (pattern `ai-providers.test.ts`, `app.inject`): `POST
/api/projects/:id/docs/generate` con cookie admin crea un `doc_generation_jobs` `queued` →
201; senza admin → 403; `GET /api/projects/:id/docs/status` ritorna la generazione corrente +
ultimo job.
**Step 2: Implementare** le route (`requireAdmin` per generate, `requireAuth` per status),
Zod schema, inserimento job.
**Step 3: PASS + commit** `feat(docs): API trigger/stato generazione (TDD)`.

### Task 6.2: Hub spazi + albero pagine + pagina singola

**Step 1: Test** — `GET /api/docs/spaces` lista i progetti con doc (conteggio pagine, data
ultima generazione); `GET /api/projects/:id/docs/tree` ritorna l'albero (technical/functional/
manual) della generazione corrente + manuali; `GET /api/projects/:id/docs/pages/:slug` ritorna
una pagina.
**Step 2: Implementare** le query (join su `currentDocGenerationId`; manuali sempre incluse).
**Step 3: PASS + commit** `feat(docs): API hub/albero/pagina (TDD)`.

### Task 6.3: Pagine manuali CRUD

**Step 1: Test** — `POST/PATCH/DELETE /api/projects/:id/docs/manual` crea/edita/elimina pagine
`is_manual` (require member); la rigenerazione non le tocca (già garantito dallo schema).
**Step 2: Implementare** con `requireAuth` + validazione.
**Step 3: PASS + commit** `feat(docs): CRUD pagine manuali (TDD)`.

### Task 6.4: Ricerca (semantica + full-text)

**Files:**
- Modify: `apps/server/src/routes/docs.ts`
- Modify: `apps/server/src/config.ts` (EMBEDDING_* anche lato server)

**Step 1: Test** — `GET /api/projects/:id/docs/search?q=...` ritorna pagine; con embedding
mockato (FakeEmbeddingClient iniettato in `buildApp`) i risultati semantici hanno priorità,
con fallback full-text su `doc_pages.search_tsv`.
**Step 2: Implementare** retrieval ibrido: embed query → `ORDER BY embedding <=> $q` su
`doc_chunks` filtrato per progetto + generazione corrente; unione con `websearch_to_tsquery`
su `doc_pages.search_tsv` (pattern `tickets.ts:427-442`).
**Step 3: PASS + commit** `feat(docs): ricerca semantica+full-text (TDD)`.

### Task 6.5: Chat RAG in streaming

**Files:**
- Create: `apps/server/src/routes/docs-chat.ts`
- Test: `apps/server/src/routes/docs-chat.test.ts`

**Step 1: Test** — `POST /api/projects/:id/docs/chat` con `{ sessionId?, message }`:
con embedder + LLM mockati (iniettati in `buildApp`), risponde in `text/event-stream`,
persiste `doc_chat_sessions`/`messages` con `citations`, e i chunk recuperati provengono dal
progetto corretto. Asserire che la risposta includa citazioni e che senza contesto sufficiente
il prompt istruisca il "non lo so".
**Step 2: Implementare**:
- retrieval (come 6.4) → top-K chunk;
- system prompt con le regole dei due registri (dev/business), anti-allucinazione, citazioni;
- streaming via `reply.raw.write("data: ...\n\n")` (pattern SSE), poi persistenza;
- astrazione `ChatLlm` iniettabile (default: provider Claude via SDK lato server; fake nei test).
**Step 3: PASS + commit** `feat(docs): chat RAG in streaming (TDD)`.

---

## Milestone 7 — Web: sezione Docs (component tests)

### Task 7.1: Voce sidebar + rotta `/docs` + namespace i18n

**Files:**
- Modify: `apps/web/src/components/app-layout.tsx` (`NAV_ITEMS` + voce `DOC`)
- Modify: `apps/web/src/router.tsx` (rotte `/docs`, `/docs/$projectId`, `/docs/$projectId/$slug`)
- Modify: `apps/web/src/i18n/index.ts` (+ `"docs"` in NAMESPACES)
- Create: `apps/web/src/i18n/locales/en.json`, `it.json` (sezione `docs`)
- Create: `apps/web/src/lib/docs-api.ts`, query options in `apps/web/src/lib/queries.ts`

**Step 1: Test** (pattern `projects.test.tsx` con `mockApi` + `renderApp`): navigando a `/docs`
con `GET /api/docs/spaces` mockata, si vede l'elenco spazi; la sidebar mostra la voce "Docs".
**Step 2: Implementare** voce nav, rotte, client API (`getDocSpaces`, `getDocTree`,
`getDocPage`, `searchDocs`, `generateDocs`, manual CRUD), query options factory.
**Step 3: PASS + commit** `feat(docs): sidebar Docs + hub spazi (web, TDD)`.

### Task 7.2: Albero spazio + render pagina

**Files:**
- Create: `apps/web/src/routes/docs/$projectId.tsx`, `apps/web/src/components/docs-tree.tsx`
- Test: `apps/web/src/components/docs-tree.test.tsx`

**Step 1: Test** — dato un albero mockato, il componente mostra i tre gruppi (Tecnico/
Funzionale/Manuale) e cliccando una pagina la rende con `Markdown`; mostra il badge "generato
al commit". 
**Step 2: Implementare** `DocsTree` (riuso `collapsible-section.tsx`) + layout a tre zone +
`Markdown` per il body + badge `source_path`/commit.
**Step 3: PASS + commit** `feat(docs): albero spazio e render pagina (web, TDD)`.

### Task 7.3: Pagine manuali (editor)

**Step 1: Test** — creazione/modifica pagina manuale via `MarkdownEditor`; chiamate API mockate.
**Step 2: Implementare** form + `MarkdownEditor` + invalidazione query.
**Step 3: PASS + commit** `feat(docs): editing pagine manuali (web, TDD)`.

### Task 7.4: Stato/trigger generazione + ricerca

**Step 1: Test** — bottone "Genera documentazione" (solo admin) chiama l'API e mostra lo stato;
barra di ricerca mostra risultati mockati.
**Step 2: Implementare** pannello stato + ricerca.
**Step 3: PASS + commit** `feat(docs): trigger generazione e ricerca (web, TDD)`.

### Task 7.5: Widget chat in streaming

**Files:**
- Create: `apps/web/src/components/docs-chat.tsx`
- Test: `apps/web/src/components/docs-chat.test.tsx`

**Step 1: Test** — inviando una domanda (fetch SSE mockata), il widget mostra la risposta in
streaming e le citazioni cliccabili.
**Step 2: Implementare** il drawer chat: `fetch` con lettura dello stream (`ReadableStream`),
rendering incrementale, citazioni → link alla pagina.
**Step 3: PASS + commit** `feat(docs): widget chat RAG (web, TDD)`.

---

## Milestone 8 — Infra, docs, verifica finale

### Task 8.1: docker-compose — Ollama + Postgres pgvector

**Files:**
- Modify: `docker-compose.yml`

**Step 1:** Cambiare l'immagine Postgres in `pgvector/pgvector:pg17`. Aggiungere il servizio:
```yaml
  ollama:
    image: ollama/ollama:latest
    volumes: [ollama:/root/.ollama]
    # pull del modello bge-m3 al primo avvio (entrypoint o doc d'istruzione)
```
Aggiungere `EMBEDDING_BASE_URL=http://ollama:11434/v1`, `EMBEDDING_MODEL=bge-m3` a server e
worker. Documentare il `ollama pull bge-m3` iniziale.
**Step 2:** Verifica compose `docker compose config`.
**Step 3: Commit** `chore(docs): Ollama + Postgres pgvector nel compose`.

### Task 8.2: Documentazione utente (Starlight)

**Files:**
- Create: `apps/docs/src/content/docs/...` (pagina "Documentation" — feature, requisiti
  embedding, come generare, chat).
**Step 1:** Scrivere la pagina (in inglese, coerente con la scelta solo-EN delle docs).
**Step 2: Commit** `docs: pagina documentazione autogenerata`.

### Task 8.3: Verifica finale

**Step 1:** Dal root del worktree:
```bash
pnpm build && pnpm typecheck && pnpm lint
```
Expected: tutti exit 0.
**Step 2:** Test per-package toccati:
```bash
pnpm --filter @stubwise/docs-engine test
pnpm --filter @stubwise/embeddings test
pnpm --filter @stubwise/db test
pnpm --filter @stubwise/server test
pnpm --filter @stubwise/worker test
pnpm --filter @stubwise/web test
```
(Per i package con Postgres, eseguire singolarmente per i limiti testcontainer — vedi memory.)
**Step 3: E2E Playwright** (CI o locale): flusso navigazione Docs + chat.
**Step 4: Commit** eventuali fix `chore(docs): verifica finale verde`.

---

## Fuori scope v1 (fase 2 — già predisposto)

- **Aggiornamento incrementale dai push:** webhook push → diff `commitSha`↔HEAD → mapping file
  cambiati → moduli (riuso `dependsOn`/`source_path`) → re-map dei soli moduli toccati + reduce
  + re-embed dei chunk cambiati. Lo schema (`commitSha`, `sourcePath`) è già pronto.
- **Chat cross-progetto:** rimuovere il filtro `project_id` nel retrieval.
- **Rerank ibrido** e **embedding del codice** (oltre alla prosa).

## Note di rischio / da validare in esecuzione

- **Politica priorità** doc-job vs fix-job nel worker singolo: decidere e **loggare**.
- **Heartbeat**: assicurarsi che `onProgress`→`touchDocJob` sia chiamato abbastanza spesso da
  non superare `WORKER_STALE_MINUTES` durante map/reduce lunghi.
- **Dimensione embedding** fissata a 1024 (bge-m3): cambiare modello con altra dimensione =
  migrazione.
- **Qualità doc**: validazione manuale in v1; eval automatica come follow-up.
