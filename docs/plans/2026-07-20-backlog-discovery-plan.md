# Backlog di discovery — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Pagina /backlog alimentata dai ticket feedback/feature (deviati dalla pipeline fix), con dedup via embedding, raffinamento chat RAG + deep dive, export .md e conversione in task. Più: /tickets di default nasconde done/closed.

**Architecture:** Nuova entità `backlog_items` con embedding pgvector per il dedup; coda `backlog_jobs` (intake/deep_dive) processata da un poller del worker serializzato per-progetto; chat RAG server-side in SSE riusando `docs-chat-core`; deviazione dalla pipeline fix all'ingresso (ingest/creazione ticket) e post-triage, gated da `projects.backlogEnabled`.

**Tech Stack:** Drizzle+pgvector, Fastify+Zod, worker poller pattern (daily-report/pr-review), TanStack Router/Query, react-i18next.

**Design di riferimento:** `docs/plans/2026-07-20-backlog-discovery-design.md` — leggerlo PRIMA di iniziare.

**Regole trasversali (valgono per OGNI task):**
- TDD: test prima, poi implementazione minima, poi verde, poi commit.
- Test per package: `pnpm --filter @stubwise/db test`, `pnpm --filter @stubwise/server test`, `pnpm --filter @stubwise/worker test`, `pnpm --filter @stubwise/web test` (server/worker/db usano testcontainers: serve Docker attivo).
- Commit frequenti sul branch `feature/backlog-discovery` (siamo nel worktree `.worktrees/backlog-discovery`).
- Stringhe UI: SEMPRE in entrambi `apps/web/src/i18n/locales/en.json` e `it.json` (c'è un parity test).
- Prima del merge finale: `pnpm lint` dalla radice (la CI fallisce su lint anche con tutto verde).

---

## Fase A — Fondamenta (shared + db)

### Task 1: Schemi Zod shared per il backlog

**Files:**
- Create: `packages/shared/src/schemas/backlog.ts`
- Modify: `packages/shared/src/index.ts` (o il barrel che esporta gli schemi — verifica come è esportato `./schemas/ticket.js`)
- Test: `packages/shared/src/schemas/backlog.test.ts` (se gli altri schemi hanno test; altrimenti il typecheck basta — verifica se esiste `ticket.test.ts`)

**Step 1: Scrivi lo schema** (fonte di verità per enum e payload, pattern di `packages/shared/src/schemas/ticket.ts:3-40`):

```ts
import { z } from "zod";
import { effortSchema, ticketPrioritySchema } from "./ticket.js";

export const backlogItemStatusSchema = z.enum([
  "new", "refining", "ready", "converted", "archived",
]);
export type BacklogItemStatus = z.infer<typeof backlogItemStatusSchema>;

export const backlogRiskSchema = z.enum(["low", "medium", "high"]);
export type BacklogRisk = z.infer<typeof backlogRiskSchema>;

// L'urgenza riusa la scala di priority dei ticket (low/medium/high/urgent)
export const backlogUrgencySchema = ticketPrioritySchema;

export const backlogItemSourceSchema = z.enum(["ticket", "manual"]);

export const backlogJobKindSchema = z.enum(["intake", "deep_dive"]);
export const backlogJobStatusSchema = z.enum(["queued", "running", "done", "failed"]);

// Metadati suggeriti dall'AI in attesa di conferma umana
export const backlogSuggestedSchema = z.object({
  effort: effortSchema.optional(),
  risk: backlogRiskSchema.optional(),
  riskNote: z.string().optional(),
  urgency: backlogUrgencySchema.optional(),
  reason: z.string().optional(),
});
export type BacklogSuggested = z.infer<typeof backlogSuggestedSchema>;

export const updateBacklogItemSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  status: backlogItemStatusSchema.optional(),
  effort: effortSchema.nullable().optional(),
  risk: backlogRiskSchema.nullable().optional(),
  riskNote: z.string().nullable().optional(),
  urgency: backlogUrgencySchema.nullable().optional(),
});
export type UpdateBacklogItemInput = z.infer<typeof updateBacklogItemSchema>;

export const createBacklogItemSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
});
export type CreateBacklogItemInput = z.infer<typeof createBacklogItemSchema>;
```

**Step 2:** Esporta dal barrel come fanno gli altri schemi. Lancia `pnpm --filter @stubwise/shared build && pnpm --filter @stubwise/shared typecheck`. Expected: PASS.

**Step 3: Commit** — `feat(shared): schemi zod per il backlog di discovery`

### Task 2: Schema DB — enum, tabelle, toggle progetto

**Files:**
- Modify: `packages/db/src/schema.ts`
- Test: `packages/db/src/schema.test.ts` o il test esistente che verifica lo schema (guarda come è testata `activityReports`; se non c'è un test di schema, la migrazione del Task 3 + un test insert/select in Task 3 coprono)

**Step 1: Aggiungi gli enum** vicino agli altri (pattern `enumValues` a `schema.ts:83-92`):

```ts
export const backlogItemStatus = pgEnum("backlog_item_status", enumValues(backlogItemStatusSchema));
export const backlogRisk = pgEnum("backlog_risk", enumValues(backlogRiskSchema));
export const backlogItemSource = pgEnum("backlog_item_source", enumValues(backlogItemSourceSchema));
export const backlogJobKind = pgEnum("backlog_job_kind", enumValues(backlogJobKindSchema));
export const backlogJobStatus = pgEnum("backlog_job_status", enumValues(backlogJobStatusSchema));
export const backlogTicketRole = pgEnum("backlog_ticket_role", ["origin", "converted_to"]);
```

(import degli schemi zod da `@stubwise/shared` in testa al file, come già avviene per `ticketTypeSchema`).

**Step 2: Aggiungi le tabelle** in fondo, pattern `activityReports` (`schema.ts:1838-1861`). Per la colonna embedding usa lo stesso custom type `vector` di `docChunks` (cerca la definizione della colonna `embedding` su `docChunks`, ~`schema.ts:1255-1281`, e riusa il custom type esistente):

```ts
export const backlogItems = pgTable("backlog_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  document: text("document").notNull().default(""),
  status: backlogItemStatus("status").notNull().default("new"),
  effort: integer("effort"),
  risk: backlogRisk("risk"),
  riskNote: text("risk_note"),
  urgency: ticketPriority("urgency"),          // riusa il pgEnum ticket_priority esistente
  requestCount: integer("request_count").notNull().default(1),
  similarToId: uuid("similar_to_id"),           // FK self-ref: vedi nota sotto
  mergedIntoId: uuid("merged_into_id"),
  suggested: jsonb("suggested").$type<BacklogSuggested | null>(),
  embedding: vector("embedding", { dimensions: 1024 }),  // adatta alla firma del custom type esistente
  source: backlogItemSource("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("backlog_items_project_status_idx").on(table.projectId, table.status),
]);

export const backlogItemTickets = pgTable("backlog_item_tickets", {
  itemId: uuid("item_id").notNull().references(() => backlogItems.id, { onDelete: "cascade" }),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  role: backlogTicketRole("role").notNull().default("origin"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.itemId, table.ticketId] })]);

export const backlogChatMessages = pgTable("backlog_chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => backlogItems.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
  content: text("content").notNull(),
  citations: jsonb("citations"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("backlog_chat_messages_item_idx").on(table.itemId, table.createdAt)]);

export const backlogJobs = pgTable("backlog_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  kind: backlogJobKind("kind").notNull(),
  status: backlogJobStatus("status").notNull().default("queued"),
  // intake da ticket: { ticketId } ; intake manuale: { title, body } ; deep_dive: { itemId, repositoryId }
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => [index("backlog_jobs_status_idx").on(table.status, table.createdAt)]);
```

Nota FK self-ref: drizzle richiede la callback-form per i self-reference (`references((): AnyPgColumn => backlogItems.id)`) — guarda se c'è già un esempio nel file, altrimenti usa quella forma per `similarToId` e `mergedIntoId` (onDelete: "set null").

**Step 3: Aggiungi il toggle** su `projects` accanto a `dailyReportEnabled` (`schema.ts:301`):
```ts
backlogEnabled: boolean("backlog_enabled").notNull().default(false),
```

**Step 4:** `pnpm --filter @stubwise/db typecheck` → PASS. Commit: `feat(db): schema backlog_items/jobs/chat + toggle backlogEnabled`

### Task 3: Migrazione 0053

**Files:**
- Create: `packages/db/drizzle/0053_backlog_discovery.sql` (+ snapshot/journal generati)
- Test: `packages/db/src/backlog.test.ts`

**Step 1: Scrivi il test** (testcontainers, pattern dei test esistenti in `packages/db/src` che usano `testing.ts:37`): applica le migrazioni, inserisci un progetto + un `backlogItems` con embedding fittizio 1024-dim, un `backlogJobs` intake, leggi indietro e verifica default (`status="new"`, `requestCount=1`).

**Step 2:** Run: `pnpm --filter @stubwise/db test -- backlog` → FAIL (tabella inesistente).

**Step 3: Genera la migrazione:**
```bash
cd packages/db && pnpm exec drizzle-kit generate --name backlog_discovery
```
Verifica: nasce `drizzle/0053_backlog_discovery.sql` con i `CREATE TYPE`/`CREATE TABLE`/`ALTER TABLE projects ADD COLUMN backlog_enabled` e la entry `idx: 53` in `drizzle/meta/_journal.json`. ⚠️ Trappola batch-tx (`client.ts:52-61`): nessun seed che usi enum nuovi nella stessa migrazione — qui non serve seed, ok.

**Step 4:** Run test → PASS. **Step 5: Commit** — `feat(db): migrazione 0053 backlog discovery`

### Task 4: Estrazione retrieval condiviso in packages/db

Il worker (intake) deve fare retrieval RAG come il server. Sposta il modulo, il server ri-esporta.

**Files:**
- Create: `packages/db/src/docs-retrieval.ts`
- Modify: `apps/server/src/routes/docs-retrieval.ts` (diventa re-export + eventuale glue), `packages/db/src/index.ts`
- Test: sposta/adatta i test esistenti del retrieval se sono in apps/server (cercali con `grep -r "retrieveChunksForProject" --include="*.test.ts"`)

**Step 1:** Sposta da `apps/server/src/routes/docs-retrieval.ts` a `packages/db/src/docs-retrieval.ts`: `toVectorLiteral` (:58), `retrieveWithScope` (:484), `retrieveChunks` (:306), `retrieveChunksForProject` (:362), `retrieveChunksAll` (:425) e i tipi/helper che li servono. NON importare `@stubwise/embeddings`: definisci un tipo strutturale locale
```ts
export interface EmbeddingProvider { embed(inputs: string[]): Promise<number[][]>; }
```
e usa quello nelle firme (il client reale lo soddisfa). Il parametro `logger` rendilo opzionale/strutturale (`{ warn(obj: unknown, msg?: string): void }`) per non dipendere da Fastify.

**Step 2:** In `apps/server/src/routes/docs-retrieval.ts` lascia `export { retrieveChunks, retrieveChunksForProject, retrieveChunksAll, ... } from "@stubwise/db";` così NESSUN call site del server cambia. Verifica che `@stubwise/db` sia già nelle `dependencies` (non devDeps) di `apps/server` e `apps/worker` (trappola Dockerfile).

**Step 3:** `pnpm --filter @stubwise/db build && pnpm typecheck` → PASS. Test server esistenti del retrieval → PASS invariati.

**Step 4: Commit** — `refactor(db): retrieval docs condiviso server/worker`

---

## Fase B — Server

### Task 5: Toggle backlogEnabled su progetto (API)

**Files:**
- Modify: `packages/shared/src/schemas/project.ts` (:80 output, :100 create, :113 update — pattern identico a `dailyReportEnabled`), `apps/server/src/routes/projects.ts` (:83 `toPublicProject`, :115/:144 create, :234 patch)
- Test: il test esistente di projects (cerca `projects.test.ts` in apps/server) — aggiungi un caso PATCH `backlogEnabled: true` → risposta lo riflette.

TDD come sempre: test → FAIL → implementa → PASS → Commit `feat(server): toggle backlogEnabled per progetto`.

### Task 6: Deviazione intake all'ingresso

Quando un ticket `feedback`/`feature` nasce su un progetto con `backlogEnabled`, NON si accoda `aiJobs`: si accoda `backlogJobs` kind=intake.

**Files:**
- Create: `apps/server/src/backlog/enqueue.ts` — helper unico:
```ts
// Ritorna true se il ticket è stato deviato al backlog (niente aiJobs).
export async function maybeEnqueueBacklogIntake(tx: Db, ticket: { id: string; projectId: string; type: string }): Promise<boolean> {
  if (ticket.type !== "feedback" && ticket.type !== "feature") return false;
  const [project] = await tx.select({ enabled: projects.backlogEnabled }).from(projects).where(eq(projects.id, ticket.projectId));
  if (!project?.enabled) return false;
  await tx.insert(backlogJobs).values({ projectId: ticket.projectId, kind: "intake", payload: { ticketId: ticket.id } });
  return true;
}
```
- Modify: `apps/server/src/ingest/processor.ts` — nei 3 punti di insert `aiJobs` (:254, :288, :336, e verifica `processTicketEvent` :344): prima dell'insert chiama l'helper; se ritorna true, salta l'insert `aiJobs`.
- Modify: `apps/server/src/routes/tickets.ts` — nel POST di creazione manuale ticket: stesso helper dopo l'insert del ticket (oggi la creazione manuale non accoda `aiJobs`: qui si AGGIUNGE l'accodamento intake per feedback/feature su progetti abilitati). Il `POST /:id/run-ai` (:1005) resta INVARIATO: è un override umano esplicito.
- Test: `apps/server/src/ingest/processor.test.ts` (o dove sono i test dell'ingest) — casi: (a) progetto abilitato + feedback → riga in `backlog_jobs`, nessuna in `ai_jobs`; (b) progetto disabilitato → comportamento attuale; (c) tipo bug → comportamento attuale.

Commit: `feat(server): deviazione intake backlog all'ingresso dei ticket`

### Task 7: Filtro multi-stato su GET /api/tickets

**Files:**
- Modify: `apps/server/src/routes/tickets.ts` — nella GET lista aggiungi al querystring `statuses: z.string().optional()` (comma-separated, ogni valore validato con `ticketStatusSchema`); se presente → `inArray(tickets.status, parsed)`; mutuamente esclusivo con `status` singolo (se ci sono entrambi, `statuses` vince).
- Test: test lista tickets esistente — caso `?statuses=open,triaged` ritorna solo quelli.

Commit: `feat(server): filtro statuses multiplo su GET /api/tickets`

### Task 8: Generalizza la persistenza di streamChatResponse

**Files:**
- Modify: `apps/server/src/routes/docs-chat-core.ts`
- Test: i test esistenti di docs-chat devono restare verdi.

**Step 1:** Aggiungi a `StreamChatResponseArgs` (:59-75) un campo opzionale:
```ts
persistAssistantMessage?: (args: { content: string; citations: Citation[]; truncated: boolean }) => Promise<void>;
```
Nel flusso (:148-160), se presente usalo al posto dell'insert su `docChatMessages`; altrimenti comportamento attuale identico.

**Step 2:** Test docs-chat esistenti → PASS. Commit: `refactor(server): persistenza pluggabile in streamChatResponse`

### Task 9: Route /api/backlog — CRUD e lista

**Files:**
- Create: `apps/server/src/routes/backlog.ts` (pattern `activity-routes.ts:145` — `withTypeProvider<ZodTypeProvider>`, `preHandler: requireAuth`/`requireAdmin`, errori con `apiError`)
- Modify: `apps/server/src/app.ts` — `void app.register(backlogRoutes, { prefix: "/api/backlog" });` accanto a :485
- Test: `apps/server/src/routes/backlog.test.ts`

Endpoints (schema zod di risposta in cima al file):
- `GET /` — querystring `{ projectId?, status?, urgency?, risk?, q?, cursor?, limit? }`; lista paginata per cursor come la GET tickets; default: esclude `converted` e `archived` se `status` assente. Ogni item con: campi base + `requestCount`, `similarTo: {id,title} | null`, `ticketCount`. `q` filtra su title (ILIKE basta).
- `GET /:id` — item completo + `tickets: [{id, number, title, role}]` (join `backlogItemTickets`→`tickets`) + `messages` (da `backlogChatMessages`, cronologico) + `suggested`.
- `PATCH /:id` — `preHandler: requireAdmin`, body `updateBacklogItemSchema`; per i metadati modificati a mano azzera il campo corrispondente in `suggested`. Transizioni status ammesse: qualsiasi (sono manuali), MA `converted` solo via endpoint convert. Aggiorna `updatedAt`.
- `POST /` — `requireAuth`, body `createBacklogItemSchema`: accoda `backlogJobs` intake con `payload: { title, body }`. Risposta `202 { queued: true }` (l'item lo crea il worker: stesso percorso dedup/RAG dei ticket).
- `POST /:id/suggested/accept` e `POST /:id/suggested/dismiss` — `requireAdmin`: applica i metadati suggeriti (o li scarta) e azzera `suggested`.

Test: crea progetto+item via insert diretto, poi esercita lista (filtri+default), detail, patch, accept/dismiss. Commit: `feat(server): route /api/backlog CRUD+lista`

### Task 10: Chat RAG backlog (SSE) + Aggiorna documento

**Files:**
- Modify: `apps/server/src/routes/backlog.ts`
- Create: `apps/server/src/routes/backlog-rag.ts` (prompt builder)
- Test: `apps/server/src/routes/backlog-chat.test.ts` (pattern del test di docs-chat: fake `chatLlm`, fake embedding client)

**Endpoints:**
- `POST /:id/chat` body `{ message }` — pre-flight `app.chatLlm.isAvailable()` → 503 prima dell'hijack (pattern `docs-chat.ts:110-124`); persisti messaggio user in `backlogChatMessages`; retrieval con `retrieveChunksForProject(app.db, app.embeddingClient, item.projectId, message, {...})`; system prompt da `buildBacklogSystemPrompt(item, originTickets, chunks)` che include: documento corrente, metadati, titolo+corpo dei ticket origin, estratti docs con citazioni; history = tutti i `backlogChatMessages` dell'item (ruoli user/assistant; i `system` — esiti deep dive — inclusi come user con prefisso `[system]` o esclusi: scegli incluso, è contesto utile); `streamChatResponse` con `persistAssistantMessage` che scrive su `backlogChatMessages`. Al primo messaggio: se `item.status === "new"` → `refining`.
- `POST /:id/refresh-document` — `requireAdmin`; una chiamata one-shot: colleziona `app.chatLlm.stream()` (system = istruzione di riscrittura con documento corrente + messaggi dall'ultimo aggiornamento; chiedi output JSON `{document, suggested?}`); aggiorna `backlogItems.document` + `suggested` + `updatedAt`; risposta con l'item aggiornato. Marca il punto di "ultimo aggiornamento" con un messaggio `system` in chat ("documento aggiornato") così i refresh successivi sintetizzano solo il delta.

Commit: `feat(server): chat RAG backlog + aggiorna documento`

### Task 11: Azioni — convert, merge manuale, deep dive enqueue

**Files:**
- Modify: `apps/server/src/routes/backlog.ts`
- Test: estendi `backlog.test.ts`

**Endpoints (tutti `requireAdmin`):**
- `POST /:id/convert` — crea ticket `{ type: "task", status: "open", title: item.title, body: item.document, priority: item.urgency ?? "medium", effort: item.effort, source: "manual", projectId }` col `number` sequenziale come fa la creazione ticket esistente (riusa/estrai l'helper di `tickets.ts`); inserisci link `role: "converted_to"`; item → `converted`. NESSUN accodamento job. Risposta `{ ticketId, ticketNumber }`. Errore 409 se già `converted`.
- `POST /:id/merge` body `{ targetId }` — entrambi stesso progetto, target non archived; sposta i link ticket (upsert, `role` invariato), `requestCount` sommato; chiamata one-shot `chatLlm` che integra i due documenti → aggiorna documento del target; messaggio `system` nella chat del target ("assorbito item X") e in quella dell'assorbito ("fuso in Y"); assorbito → `archived` + `mergedIntoId = targetId`. 
- `POST /:id/deep-dive` body `{ repositoryId }` (valida che il repo appartenga al progetto) — accoda `backlogJobs` `{ kind: "deep_dive", payload: { itemId, repositoryId } }`; 409 se c'è già un deep_dive queued/running per quell'item. Risposta `202`.
- `GET /:id` (estensione): aggiungi `deepDivePending: boolean` (esiste job deep_dive queued/running per l'item).

Commit: `feat(server): convert/merge/deep-dive sul backlog`

---

## Fase C — Worker

### Task 12: Coda backlog_jobs — claim e poller scheletro

**Files:**
- Create: `apps/worker/src/backlog/poller.ts`
- Test: `apps/worker/src/backlog/poller.test.ts`

**Step 1: claim atomico** (pattern `claimNextJob` `queue.ts:80-108`, su `backlog_jobs`):
```ts
export async function claimNextBacklogJob(db: Db): Promise<BacklogJob | null> {
  const [job] = await db.update(backlogJobs)
    .set({ status: "running", startedAt: sql`now()`, attempts: sql`${backlogJobs.attempts} + 1` })
    .where(eq(backlogJobs.id,
      sql`(SELECT id FROM backlog_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)`))
    .returning();
  return job ?? null;
}
```
**Step 2: recovery orfani** (fase 0 del tick, pattern daily-report): `running` con `startedAt` più vecchio di 15 min → se `attempts < 3` torna `queued`, altrimenti `failed` con error "max attempts".

**Step 3: loop** `pollBacklogJobsOnce(deps)` + `startBacklogPoller({..., intervalSeconds, signal})` (pattern `startPrReviewPoller` `review/poller.ts:146`): drena i job claimabili, ognuno dentro `serializer.run(job.projectId, () => runBacklogJob(deps, job))`; su throw → `failed`+error se attempts esauriti, altrimenti `queued`. `runBacklogJob` smista su kind (intake Task 13, deep_dive Task 15).

Test: claim concorrente (due claim → job diversi/null), recovery orfano, dispatch per kind (handler fake). Commit: `feat(worker): coda backlog_jobs con poller`

### Task 13: Intake — dedup + generazione item

**Files:**
- Create: `apps/worker/src/backlog/intake.ts`, `apps/worker/src/backlog/prompts.ts`
- Test: `apps/worker/src/backlog/intake.test.ts` (fake embedding client — `createFakeEmbeddingClient` da `@stubwise/embeddings` —, fake runner che ritorna JSON predefinito)

**Flusso `runIntake(deps, job)`:**
1. Risolvi input: `payload.ticketId` → carica ticket (se già chiuso/inesistente → job done no-op); oppure `payload.{title, body}` (manuale).
2. `const [vec] = await deps.embeddingClient.embed([title + "\n\n" + body])`. Se fallisce → throw (retry).
3. Similarity search sugli item del progetto non archived/converted (pattern `docs-retrieval.ts:511-528`, `<=>` cosine, `toVectorLiteral` ora esportato da `@stubwise/db`): prendi il best match con `similarity = 1 - distance`.
4. **Merge** (`similarity >= deps.mergeThreshold`): run agente (`deps.runner.run` con prompt `buildMergePrompt(item.document, nuovoFeedback)` → output JSON `{document}`; `permissionMode: "plan"`, `maxTurns: 3`, `cwd: deps.workDir` — una dir temporanea vuota creata dal poller all'avvio); aggiorna documento, `requestCount++`, link ticket (`role: origin`), messaggio `system` in chat ("nuovo feedback integrato dal ticket #N"). L'embedding dell'item NON si ricalcola (resta rappresentativo del nucleo dell'idea).
5. **Nuovo item** (sotto merge threshold): retrieval RAG `retrieveChunksForProject(deps.db, deps.embeddingClient, projectId, title+body, {...})`; run agente con `buildIntakePrompt(ticket|input, chunks)` → JSON `{title, document, effort, risk, riskNote, urgency}` (il prompt spiega la scala effort 1-5 e chiede il documento con sezioni: Contesto, Cosa fare, Punti aperti). Inserisci `backlogItems` con embedding, `source`, metadati in `suggested`? NO: alla creazione le stime AI vanno DIRETTE nei campi (design: "AI propone, umano corregge" — `suggested` serve solo per le revisioni successive). `similarToId` = best match se `similarity >= deps.similarThreshold`.
6. Se input da ticket: chiudi il ticket (`status: "closed"`), commento automatico sul ticket ("spostato nel backlog: <titolo item>") e link `backlogItemTickets`.
7. Parse difensivo dell'output agente (pattern verdetto `review/run-review.ts`): JSON malformato → throw (retry); dopo max attempts il job fallisce e il ticket RESTA aperto (fail-safe del design).

Test: (a) nuovo item con metadati e ticket chiuso; (b) merge sopra soglia con requestCount e documento aggiornato; (c) zona grigia → nuovo item con similarToId; (d) intake manuale senza ticket; (e) output agente non-JSON → job requeued. Commit: `feat(worker): intake backlog con dedup embedding`

### Task 14: Deviazione post-triage

**Files:**
- Modify: `apps/worker/src/pipeline/triage.ts` (dopo l'update del type, :286-288, prima del gate :290)
- Test: `apps/worker/src/pipeline/triage.test.ts` (esteso)

Se `decision.type` ∈ {feedback, feature} E il progetto ha `backlogEnabled` E `!job.manualTrigger`: accoda `backlogJobs` intake `{ticketId}`, chiudi il job come **skipped** (guarda le transizioni in `queue.ts` — se non esiste un helper per skipped, aggiungilo sul pattern di `holdJob` :248 con status-guard), commento AI sul ticket che spiega la deviazione, e return early (il ticket verrà chiuso dall'intake). `manualTrigger` bypassa (coerente col gate esistente).

Test: riclassificazione bug→feature su progetto abilitato → job skipped + intake accodato; con manualTrigger → prosegue in fixing. Commit: `feat(worker): deviazione post-triage verso il backlog`

### Task 15: Deep dive

**Files:**
- Create: `apps/worker/src/backlog/deep-dive.ts` (+ prompt in `prompts.ts`)
- Test: `apps/worker/src/backlog/deep-dive.test.ts` (fake mirrors/runner, pattern dei test di run-review)

**Flusso `runDeepDive(deps, job)`:** carica item + repo; `deps.mirrors.withWorktreeAtSha(mirrorProject, headSha, dir => deps.runner.run({ cwd: dir, prompt, permissionMode: "plan", maxTurns: deps.deepDiveMaxTurns, timeoutMs, provider }))` (pattern esatto `run-review.ts:543-569`; per lo sha di HEAD del default branch guarda come lo risolve la review o il MirrorManager). Prompt `buildDeepDivePrompt(item)`: verifica fattibilità, file/moduli toccati, rischi di regressione concreti; output JSON `{analysis, suggested: {effort?, risk?, riskNote?, urgency?, reason?}}`. Poi: appendi/sostituisci sezione `## Analisi tecnica` nel documento, salva `suggested`, messaggio `system` in chat con un riassunto dell'esito. Provider: risolvi con `loadProviderChain`/`loadProviderById` come daily-report (`daily-report-poller.ts:164-178`).

Commit: `feat(worker): deep dive backlog su worktree del mirror`

### Task 16: Config env + wiring in index.ts

**Files:**
- Modify: `apps/worker/src/config.ts` (envSchema + interface + load, pattern `DAILY_REPORT_POLL_MINUTES` :433-440/:568/:638), `apps/worker/src/index.ts` (avvio poller accanto a :306), `.env.example`, `docker-compose.yml` (blocco `worker.environment`)
- Test: quello di config se esiste.

Env: `BACKLOG_MERGE_THRESHOLD` (default 0.90), `BACKLOG_SIMILAR_THRESHOLD` (default 0.78), `BACKLOG_POLL_SECONDS` (default 20), `BACKLOG_MODEL` (default = stesso default di `prReviewModel`), `BACKLOG_AGENT_TIMEOUT_MS` (default = quello della review). Wiring: `startBacklogPoller({ db, embeddingClient, runner, mirrors, serializer, mergeThreshold, similarThreshold, model, agentTimeoutMs, intervalSeconds, signal })` — l'`embeddingClient` esiste già (`index.ts:143-147`). Checklist compose: aggiungi le env con `${VAR:-default}`.

Commit: `feat(worker): config e avvio poller backlog`

---

## Fase D — Web

### Task 17: /tickets — default stati attivi

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`TicketFilters` :279-286 + `listTickets` :304-320: aggiungi `statuses?: string[]` → param comma-joined), `apps/web/src/lib/queries.ts` (la queryKey `ticketKeys.list(filters)` include già filters — verifica che il nuovo campo ci finisca), `apps/web/src/routes/tickets/index.tsx` (:36-45 schema: `status` accetta anche `"all"`; :62-67: calcola `effectiveFilters`), `apps/web/src/components/ticket-filters.tsx` (:78-87)
- Test: `apps/web/src/routes/tickets/index.test.tsx`

Logica: `status` assente → `effectiveFilters = {...search, status: undefined, statuses: ["open","triaged","in_progress","in_review"]}`; `status === "all"` → nessun filtro stato; altrimenti singolo stato. Nel select stato: prima opzione "Attivi (default)" (value ""), poi "Tutti" (value "all"), poi i singoli. i18n: chiavi nuove in `tickets.filters.*` (en+it).

Test: render di /tickets senza status → la fetch verso `/api/tickets` contiene `statuses=open,triaged,in_progress,in_review`; con `?status=all` → nessun parametro stato. Commit: `feat(web): /tickets nasconde done/closed di default`

### Task 18: API client + queries backlog

**Files:**
- Modify: `apps/web/src/lib/api.ts` — tipi `BacklogItem`, `BacklogItemDetail`, `BacklogMessage` + funzioni: `listBacklogItems(filters, cursor?)`, `getBacklogItem(id)`, `patchBacklogItem(id, input)`, `postBacklogItem(input)`, `convertBacklogItem(id)`, `mergeBacklogItem(id, targetId)`, `requestDeepDive(id, repositoryId)`, `refreshBacklogDocument(id)`, `acceptSuggested(id)` / `dismissSuggested(id)` (pattern `request<T>` :57-109)
- Modify: `apps/web/src/lib/queries.ts` — `backlogKeys` factory + `backlogInfiniteQueryOptions(filters)` + `backlogItemQueryOptions(id)` (pattern ticket :61-88)
- Create: `apps/web/src/lib/backlog-chat-api.ts` — `postBacklogChatStream(id, message, onEvent)` sul pattern fetch-stream di `docs-api.ts:326-359`

Typecheck verde, commit: `feat(web): api client backlog`

### Task 19: Pagina lista /backlog + navigazione + i18n

**Files:**
- Create: `apps/web/src/routes/backlog/index.tsx`
- Modify: `apps/web/src/router.tsx` (route con `validateSearch`+loader, pattern :155-170; registra in `addChildren` :585-620), `apps/web/src/components/app-layout.tsx` (:25-35 `NAV_ITEMS`: `{ to: "/backlog", labelKey: "common:nav.backlog", code: "BLG" }`), `apps/web/src/i18n/index.ts` (namespace `backlog` in `NAMESPACES` :13-35), `apps/web/src/i18n/locales/en.json` + `it.json`
- Test: `apps/web/src/routes/backlog/index.test.tsx` (pattern `tickets/index.test.tsx`: fetchMock + `renderApp("/backlog")`)

Contenuto: filtri (progetto/stato/urgenza/rischio/q — `FilterSelect` riusabile da `ticket-filters.tsx:129`), card per item con: titolo, badge effort/risk/urgency (nuovi piccoli badge sul pattern `badges.tsx`, `badgeBase` :87), pill "×N richieste" se `requestCount > 1`, pill "≈ simile a <titolo>" se `similarTo`, stato con pallino (mappa colori nuova tipo `STATUS_DOT`), n° ticket linkati, tempo relativo. Empty state + Load more come tickets. Dialog "Nuovo item" (pattern `new-ticket-dialog.tsx`): titolo+descrizione → `postBacklogItem` → toast/banner "in elaborazione" + invalidate.

Test: lista renderizzata da fetch mockata, default esclude converted/archived, dialog crea. Commit: `feat(web): pagina lista /backlog`

### Task 20: Dettaglio /backlog/$id — documento, metadati, azioni

**Files:**
- Create: `apps/web/src/routes/backlog/$id.tsx`
- Modify: `apps/web/src/router.tsx` (route dettaglio pattern :172-191)
- Test: `apps/web/src/routes/backlog/$id.test.tsx`

Layout due colonne come `tickets/$id.tsx:246` (`grid lg:grid-cols-[minmax(0,1fr)_24rem]`): **main** = documento `<Markdown>` + banner suggeriti ("l'agente suggerisce effort 4 (era 2)" con Accetta/Ignora → `acceptSuggested`/`dismissSuggested`) + ticket linkati (link a /tickets/$id, badge origin/convertito) + banner "analisi in corso" se `deepDivePending` (polling: `refetchInterval` 10s finché pending); **aside** = `SelectField` per status/effort/risk/urgency + `riskNote` (mutation patch con invalidate, pattern `$id.tsx:101-123`) + barra azioni (solo admin, `me.user.role === "admin"` pattern `activity.tsx:41`):
- **Aggiorna documento** → `refreshBacklogDocument` (spinner, poi invalidate)
- **Analisi approfondita** → dialog scelta repo (dai repo del progetto; se uno solo, diretto) → `requestDeepDive`
- **Esporta .md** → client-side: costruisci frontmatter+documento, `navigator.clipboard.writeText` + download via Blob (niente endpoint)
- **Converti in task** → conferma → `convertBacklogItem` → link al ticket creato
- **Fondi con…** → `ComboboxPicker` (`combobox-picker.tsx:43-68`) sugli altri item attivi del progetto, precompilato/evidenziato `similarTo` → `mergeBacklogItem`
- **Archivia/Riapri**

Commit: `feat(web): dettaglio backlog item`

### Task 21: Chat backlog

**Files:**
- Create: `apps/web/src/components/backlog-chat.tsx` (modellato su `docs-chat.tsx`: reader SSE :130-227, `ChatBubble`+`<Markdown>`, `Drawer` su mobile; citazioni che linkano a `/docs/...` come docs-chat; messaggi `system` renderizzati come divider/nota)
- Modify: `apps/web/src/routes/backlog/$id.tsx` (chat nella colonna destra o drawer), i18n `backlog:chat.*`
- Test: `apps/web/src/components/backlog-chat.test.tsx` (pattern `docs-chat.test.tsx`: mock fetch stream)

La history iniziale arriva dal GET dettaglio (`messages`); i nuovi messaggi vanno in append locale + stream. Gestisci 503 `chat_unavailable` come docs-chat (:369-376). Commit: `feat(web): chat di raffinamento backlog`

### Task 22: Toggle backlog nel dettaglio progetto

**Files:**
- Modify: la vista progetto in `/team` dove vive il toggle `dailyReportEnabled` (cercalo in `apps/web/src/routes/team.tsx` o file collegati) — aggiungi il toggle `backlogEnabled` identico, i18n en+it.
- Test: estendi il test esistente di quella vista.

Commit: `feat(web): toggle backlog per progetto`

---

## Fase E — Chiusura

### Task 23: Verifica finale

1. `pnpm typecheck` → PASS. 2. `pnpm lint` → PASS (OBBLIGATORIO). 3. `pnpm test` (radice, Docker attivo) → PASS. 4. `pnpm build` → PASS.
5. Verifica runtime minima con la skill superpowers:verification-before-completion; i test E2E Playwright NON girano in `pnpm -r test` — per le pagine nuove valuta un E2E in `apps/web/e2e` sul pattern esistente ed eseguilo a mano.
6. Aggiorna `CLAUDE.md` SOLO se emergono invarianti nuove (es. nuova env da tenere coerente).

### Task 24: Fine branch

Usa superpowers:finishing-a-development-branch. Promemoria deploy (NON eseguire senza richiesta esplicita): migrazione 0053 all'avvio server, rebuild `server`+`worker`+`caddy`, nuove env `BACKLOG_*` opzionali in `/opt/stubwise/.env`, toggle per progetto da /team, backup DB prima.

---

## Note e scostamenti dal design (già motivati)

1. **/tickets default NON è solo-frontend**: l'API accettava un solo `status` → aggiunto `statuses` multiplo (Task 7+17).
2. **Metadati alla creazione**: le stime AI iniziali vanno dirette nei campi; `suggested` (con conferma) si usa solo per le revisioni successive (refresh-document, deep dive).
3. **Deep dive multi-repo**: scelta esplicita del repo in UI (default automatico "repo con più match" rimandato — YAGNI).
4. **Creazione manuale**: risposta 202 e item creato async dal worker (stesso percorso dedup/RAG), non creazione sincrona.
5. **Chiusura ticket d'origine**: commento AI col titolo dell'item invece dell'"evento in timeline" (non esiste un kind di ticket_event adatto; stesso pattern del triage sui duplicati).
6. **Dedup**: esclude anche gli item `converted` oltre agli `archived` (un feedback su un'idea già convertita merita un item nuovo, non un merge dentro uno chiuso).
7. **Viste salvate**: ammesso `status: "all"` (estensione oltre il "viste invariate" del design) per non perdere l'intento "Tutti" al salvataggio di una vista.
8. **Sicurezza intake**: run agente in `permissionMode: "default"` (non "plan" come da piano) — l'intake non usa tool e "plan" avrebbe concesso letture filesystem inutili.

## Follow-up noti (non bloccanti, dalle review)

- i18n lato server del backlog: marker "Documento aggiornato.", messaggi-ponte del merge e prompt in italiano fisso (innocuo su istanza it; se i18n-izzato, il confronto del marker va fatto sull'insieme dei valori noti).
- Cap/minimo sul documento fuso dal merge manuale; pulizia dei similarToId che puntano a item assorbiti; blocco deep dive su item converted.
- E2E Playwright dedicato alle pagine /backlog (limitato dall'assenza del worker nello stack E2E); estrazione backlog-actions/ModalShell condiviso; retention tabella backlog_jobs.
- Pre-esistente fuori scope: il triage omette permissionMode (→ acceptEdits del runner) — valutare l'uniformazione a "default".
