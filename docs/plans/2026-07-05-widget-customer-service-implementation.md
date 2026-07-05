# Widget Customer Service — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Widget chat embeddabile per progetto: RAG sulla docs (repo whitelisted), proposta ticket con conferma utente, viewer conversazioni e impostazioni nella SPA, bundle IIFE servito da Caddy.

**Architecture:** Nuova superficie pubblica `/widget/:slug/*` sul server (stesso modello di `/ingest`: CORS aperto, auth `X-Stubwise-Key` = ingestionKey, rate limit per chiave). Chat SSE che riusa il retrieval ibrido esistente filtrato per repo; la proposta ticket viaggia come **sentinel JSON nel testo LLM** (il loop chat non supporta tool-use), intercettata server-side e riemessa come evento SSE `ticket_proposal`. Frontend widget = nuovo package `@stubwise/widget` (Preact, Vite lib mode, output IIFE) montato in Shadow DOM.

**Tech Stack:** Fastify + Zod, Drizzle/Postgres (testcontainers nei test), Preact 10, Vite 7 (build IIFE), Vitest (+ happy-dom per UI), TanStack Router/Query nella SPA.

**Design di riferimento:** `docs/plans/2026-07-05-widget-customer-service-design.md`.

**Deviazioni dal design (motivate, già decise):**
1. **Niente tool-use LLM**: `ChatLlm.stream` emette solo delta testuali (`apps/server/src/routes/chat-llm.ts:51-62`); la proposta ticket usa un sentinel testuale (vedi Task 6) invece di un tool Anthropic.
2. **Entry npm = `@stubwise/widget`** (package autonomo pubblicabile) invece di `@stubwise/sdk/widget`: evita di accoppiare il publish dell'SDK al widget. L'SDK non viene toccato.

**Regole trasversali:**
- TDD: test prima, poi implementazione minima, poi commit. Commit frequenti con `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` in coda.
- I test server usano testcontainers: singolo file con `pnpm --filter @stubwise/server exec vitest run src/routes/<file>.test.ts` (timeout lunghi, `beforeAll` 120s è la norma).
- Dopo ogni task: `pnpm --filter <pkg> typecheck` (o build). `pnpm lint` dalla radice almeno nel task finale.
- Stringhe UI SPA: sempre in ENTRAMBI `apps/web/src/i18n/locales/en.json` e `it.json` (c'è `src/i18n/parity.test.ts` che fallisce altrimenti).

---

### Task 1: Schemi shared (`widget` source + schemi widget)

**Files:**
- Modify: `packages/shared/src/schemas/ticket.ts` (enum `ticketSourceSchema`, righe ~19-26)
- Create: `packages/shared/src/schemas/widget.ts`
- Modify: `packages/shared/src/index.ts` (o il barrel degli schemi — segui il pattern degli export esistenti, es. come è esportato `ingest.ts`)
- Test: `packages/shared/src/schemas/widget.test.ts`

**Step 1: test fallente**

```ts
import { describe, expect, it } from "vitest";
import { ticketSourceSchema } from "./ticket.js";
import {
  widgetChatMessageBodySchema,
  widgetConversationCreateBodySchema,
  widgetSettingsSchema,
  widgetTicketConfirmBodySchema,
} from "./widget.js";

describe("widget schemas", () => {
  it("accetta la source widget", () => {
    expect(ticketSourceSchema.parse("widget")).toBe("widget");
  });

  it("valida la creazione conversazione", () => {
    const parsed = widgetConversationCreateBodySchema.parse({
      user: { id: "u_42", email: "a@b.it", name: "Mario" },
    });
    expect(parsed.user.id).toBe("u_42");
    // email/name opzionali
    expect(widgetConversationCreateBodySchema.parse({ user: { id: "x" } }).user.email).toBeUndefined();
  });

  it("limita il messaggio a 2000 caratteri", () => {
    expect(() => widgetChatMessageBodySchema.parse({ content: "a".repeat(2001) })).toThrow();
    expect(widgetChatMessageBodySchema.parse({ content: "ciao" }).content).toBe("ciao");
  });

  it("limita i tipi ticket confermabili", () => {
    expect(() => widgetTicketConfirmBodySchema.parse({ title: "t", body: "b", type: "task" })).toThrow();
    expect(widgetTicketConfirmBodySchema.parse({ title: "t", body: "b", type: "bug" }).type).toBe("bug");
  });

  it("widget settings con default", () => {
    const s = widgetSettingsSchema.parse({});
    expect(s.enabled).toBe(false);
    expect(s.enabledRepositoryIds).toEqual([]);
    expect(s.language).toBe("it");
  });
});
```

**Step 2:** `pnpm --filter @stubwise/shared exec vitest run src/schemas/widget.test.ts` → FAIL (modulo inesistente).

**Step 3: implementazione**

In `ticket.ts` aggiungi `"widget"` a `ticketSourceSchema`. Nuovo `widget.ts`:

```ts
import { z } from "zod";

export const widgetTicketTypeSchema = z.enum(["bug", "feedback", "feature"]);
export type WidgetTicketType = z.infer<typeof widgetTicketTypeSchema>;

export const widgetLanguageSchema = z.enum(["it", "en"]);

export const widgetSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  enabledRepositoryIds: z.array(z.string().uuid()).default([]),
  title: z.string().min(1).max(80).default("Assistenza"),
  welcomeMessage: z.string().min(1).max(500).default("Ciao! Come posso aiutarti?"),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#22c55e"),
  language: widgetLanguageSchema.default("it"),
});
export type WidgetSettings = z.infer<typeof widgetSettingsSchema>;

export const widgetConversationCreateBodySchema = z.object({
  user: z.object({
    id: z.string().min(1).max(200),
    email: z.string().email().max(320).optional(),
    name: z.string().min(1).max(200).optional(),
  }),
});

export const widgetChatMessageBodySchema = z.object({
  content: z.string().min(1).max(2000),
});

export const widgetTicketConfirmBodySchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(20_000),
  type: widgetTicketTypeSchema,
});
```

Esporta `widget.js` dal barrel come gli altri schemi.

**Step 4:** test → PASS. **Step 5:** `pnpm --filter @stubwise/shared build && pnpm --filter @stubwise/shared typecheck`, poi commit `feat(shared): schemi widget e source ticket widget`.

---

### Task 2: Schema DB + migrazione

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0040_widget.sql` (generata)
- Test: `packages/db/src/widget-schema.test.ts`

**Step 1: test fallente** (pattern: guarda `packages/db/src/schema.test.ts` e usa `startTestDb` da `./testing.js`):

```ts
// Verifica: insert widget_settings 1:1 col progetto, conversazione+messaggi,
// enum ticket_source accetta 'widget'.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, seedRepository, type TestDb } from "./testing.js";
import { tickets, widgetConversations, widgetMessages, widgetSettings } from "./schema.js";

describe("widget tables", () => {
  let testDb: TestDb;
  let projectId: string;
  beforeAll(async () => {
    testDb = await startTestDb();
    ({ projectId } = await seedRepository(testDb.db));
  }, 120_000);
  afterAll(() => testDb.stop());

  it("settings, conversazioni, messaggi", async () => {
    await testDb.db.insert(widgetSettings).values({ projectId, enabled: true });
    const [conv] = await testDb.db
      .insert(widgetConversations)
      .values({ projectId, externalUserId: "u_1", externalUserEmail: "a@b.it", externalUserName: "Mario" })
      .returning();
    await testDb.db.insert(widgetMessages).values({ conversationId: conv!.id, role: "user", content: "ciao" });
    const msgs = await testDb.db.select().from(widgetMessages).where(eq(widgetMessages.conversationId, conv!.id));
    expect(msgs).toHaveLength(1);
  });

  it("ticket_source accetta widget", async () => {
    const [t] = await testDb.db
      .insert(tickets)
      .values({ projectId, number: 900, title: "t", type: "bug", priority: "medium", source: "widget" })
      .returning();
    expect(t!.source).toBe("widget");
  });
});
```

(Adatta le colonne NOT NULL di `tickets` a quelle reali dello schema — copia da `seedTicket` in `testing.ts`.)

**Step 2:** run → FAIL. **Step 3: implementazione** in `schema.ts` (modello: `docChatSessions`/`docChatMessages` a righe ~1361-1407):

```ts
export const widgetSettings = pgTable("widget_settings", {
  projectId: uuid("project_id").primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  enabledRepositoryIds: jsonb("enabled_repository_ids").$type<string[]>().notNull().default([]),
  title: text("title").notNull().default("Assistenza"),
  welcomeMessage: text("welcome_message").notNull().default("Ciao! Come posso aiutarti?"),
  accentColor: text("accent_color").notNull().default("#22c55e"),
  language: text("language").notNull().default("it"),
});

export const widgetConversations = pgTable("widget_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  externalUserId: text("external_user_id").notNull(),
  externalUserEmail: text("external_user_email"),
  externalUserName: text("external_user_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("widget_conversations_project_idx").on(t.projectId, t.lastMessageAt)]);

export const widgetMessages = pgTable("widget_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull()
    .references(() => widgetConversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // "user" | "assistant"
  content: text("content").notNull(),
  citations: jsonb("citations"),
  ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("widget_messages_conversation_idx").on(t.conversationId)]);
```

Segui ESATTAMENTE lo stile/helper dello schema esistente (import, `index()` come array, naming snake_case). L'enum: `ticketSource` è già derivato da `ticketSourceSchema` shared (`schema.ts:85`) → si aggiorna da solo col Task 1, ma la migrazione SQL va generata.

**Step 4: genera migrazione:** `cd packages/db && npx drizzle-kit generate --name widget`. Verifica che il file contenga `ALTER TYPE "public"."ticket_source" ADD VALUE 'widget'` + i 3 `CREATE TABLE`. ⚠️ **Trappola nota:** il migratore esegue il batch in UNA transazione — va bene che ADD VALUE e CREATE TABLE convivano (solo DDL), ma NESSUNA migrazione presente o futura nello stesso batch può fare DML con `'widget'`. Non aggiungere seed.

**Step 5:** test → PASS. `pnpm --filter @stubwise/db build && pnpm --filter @stubwise/db typecheck`. Commit `feat(db): tabelle widget e source ticket widget`.

---

### Task 3: API interna impostazioni widget

**Files:**
- Create: `apps/server/src/routes/widget-settings.ts`
- Modify: `apps/server/src/app.ts` (registrazione, accanto alle altre route `/api`)
- Test: `apps/server/src/routes/widget-settings.test.ts`

Endpoint (pattern auth: lettura `requireAuth`, scrittura `requireAdmin`, come `routes/projects.ts`):
- `GET /api/projects/:projectId/widget-settings` → settings correnti; se la riga non esiste, ritorna i default dello schema shared (`widgetSettingsSchema.parse({})`) senza crearla. 404 se progetto inesistente.
- `PUT /api/projects/:projectId/widget-settings` → body = `widgetSettingsSchema` (parziale? no: PUT completo, il form manda tutto); upsert (`onConflictDoUpdate` su `projectId`). Valida che ogni id in `enabledRepositoryIds` sia un repository del progetto → 422 altrimenti.

**Step 1: test fallente** — setup come `docs-chat.test.ts` (`startTestDb`, `buildApp`, `seedUsers`, `seedRepository`); casi:
1. GET senza auth → 401.
2. GET su progetto vergine → 200 con default (`enabled: false`).
3. PUT admin con repo del progetto → 200; GET riflette i valori.
4. PUT con repositoryId di un ALTRO progetto → 422.
5. PUT da member (non admin) → 403.

**Step 2:** FAIL. **Step 3:** implementa (plugin fastify come le altre route `/api`, registralo in `app.ts` vicino a `projects`). **Step 4:** PASS. **Step 5:** commit `feat(server): API impostazioni widget per progetto`.

---

### Task 4: Superficie pubblica `/widget/:slug` — plugin + config endpoint

**Files:**
- Create: `apps/server/src/routes/widget.ts`
- Modify: `apps/server/src/app.ts` (registra con `prefix: "/widget"`, fuori da `/api`, accanto a `ingestRoutes` ~riga 377)
- Test: `apps/server/src/routes/widget.test.ts`

**Copia il pattern di `ingest.ts`** (righe 37-97): plugin con `IngestRoutesOptions`-like (`rateLimit: RateLimitConfig`), CORS scoped `origin: "*"`, `methods: ["GET", "POST"]`, `allowedHeaders: ["content-type", "x-stubwise-key"]`; preValidation identica (lookup `projects` per slug, `keysMatch` timing-safe da `../ingest/shared.js`, 401 `invalid_ingestion_key` indistinguibile); rate limit con `keyGenerator` sulla chiave; `schemaErrorFormatter` → 422. Decora `request.widgetProject = { id, name }` (module augmentation propria).

Endpoint di questo task — `GET /widget/:slug/config`:
- Legge `widget_settings`; se assente o `enabled=false` → `{ enabled: false }`.
- Se enabled: `{ enabled: true, title, welcomeMessage, accentColor, language, chatEnabled }` dove `chatEnabled = (await app.chatLlm.isAvailable?.())?.available ?? true` E `enabledRepositoryIds.length > 0`.

In `app.ts`: `void app.register(widgetRoutes, { prefix: "/widget", rateLimit: opts.ingestRateLimit ?? { max: 300, timeWindow: "1 minute" } })`. ⚠️ Aggiorna anche il **Caddyfile** `@backend` matcher in un task successivo (Task 13) — qui basta il server.

**Step 1: test fallente** (setup come `docs-chat.test.ts` con `chatLlm` fake):
1. GET config senza header chiave → 401; con chiave sbagliata → 401.
2. Slug inesistente → 401 (indistinguibile).
3. Chiave giusta, settings assenti → `{ enabled: false }`.
4. Settings enabled con 1 repo abilitato → `enabled: true` + campi + `chatEnabled: true`.
5. Settings enabled ma `enabledRepositoryIds: []` → `chatEnabled: false`.
6. Risposta include header CORS `access-control-allow-origin: *`.

**Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS. **Step 5:** commit `feat(server): superficie pubblica /widget con config endpoint`.

---

### Task 5: Conversazioni pubbliche (create/resume + storico)

**Files:**
- Modify: `apps/server/src/routes/widget.ts`
- Test: `apps/server/src/routes/widget.test.ts` (estendi)

Endpoint (tutti sotto il plugin del Task 4, quindi già auth+CORS+rate-limit; se widget disabled → 404 `widget_disabled` su tutti):
- `POST /widget/:slug/conversations` body `widgetConversationCreateBodySchema` → crea riga in `widget_conversations` → `{ conversationId }`.
- `GET /widget/:slug/conversations/:conversationId/messages?userId=<externalUserId>` → 404 se la conversazione non appartiene al progetto O `externalUserId !== userId` (anti-lettura cross-utente con id conversazione rubato); altrimenti `{ messages: [{ id, role, content, citations, ticketId, createdAt }] }` cronologico.

**Step 1: test fallente:** creazione → id uuid; storico vuoto; 404 con userId sbagliato; 404 con conversazione di altro progetto; 404 se `enabled=false`.
**Step 2-4:** FAIL → implementa → PASS. **Step 5:** commit `feat(server): conversazioni widget (crea/riprendi + storico)`.

---

### Task 6: Chat SSE con retrieval filtrato e sentinel `ticket_proposal`

Il task più delicato. **Files:**
- Modify: `apps/server/src/routes/docs-retrieval.ts` (opzione `repositoryIds`)
- Modify: `apps/server/src/routes/docs-chat-core.ts` (esporta `writeSseEvent` e `TRUNCATION_MARKER` se non già esportati)
- Create: `apps/server/src/routes/widget-chat.ts` (system prompt + parser sentinel + stream loop widget)
- Modify: `apps/server/src/routes/widget.ts` (endpoint messaggio)
- Modify: `apps/server/src/app.ts` + `apps/server/src/config.ts` se serve (cap giornaliero via `BuildAppOptions.widgetDailyMessageCap`, default 200)
- Test: `apps/server/src/routes/widget-chat.test.ts` (unit parser) + `apps/server/src/routes/widget.test.ts` (integrazione)

**6a — retrieval filtrato.** In `RetrieveChunksOptions` aggiungi `repositoryIds?: string[]`; in `retrieveChunksForProject` (righe ~225-241), dopo il fetch dei repo del progetto filtra `repos = repos.filter(r => options.repositoryIds.includes(r.id))` quando l'opzione è presente. Test unit/integrazione: con 2 repo documentati e filtro su 1, i chunk ritornati appartengono solo a quello. (Guarda i test esistenti di docs-retrieval per il seeding di doc_pages.)

**6b — sentinel.** Formato che il system prompt impone all'LLM, SOLO in coda alla risposta quando ritiene che serva un ticket:

```
<<<TICKET_PROPOSAL
{"title": "...", "body": "...", "type": "bug|feedback|feature"}
TICKET_PROPOSAL>>>
```

Parser streaming in `widget-chat.ts`:

```ts
const PROPOSAL_START = "<<<TICKET_PROPOSAL";
const PROPOSAL_END = "TICKET_PROPOSAL>>>";

export interface SentinelSplit {
  /** Porzione di `full` sicura da inoltrare come delta (non contiene inizio di marker). */
  safeLength: number;
}

/** Quanto di `full` può essere inoltrato senza rischiare di emettere un pezzo di marker. */
export function safeForwardLength(full: string): number {
  const idx = full.indexOf(PROPOSAL_START);
  if (idx !== -1) return idx; // tutto ciò che segue è proposta, non si inoltra
  // trattieni un suffisso che potrebbe essere l'inizio del marker spezzato tra delta
  for (let k = Math.min(PROPOSAL_START.length - 1, full.length); k > 0; k--) {
    if (full.endsWith(PROPOSAL_START.slice(0, k))) return full.length - k;
  }
  return full.length;
}

export function extractProposal(full: string): {
  visible: string;
  proposal: { title: string; body: string; type: "bug" | "feedback" | "feature" } | null;
} { /* trova i marker, JSON.parse + widgetTicketConfirmBodySchema.safeParse; malformato → proposal null, visible = full senza blocco */ }
```

Scrivi PRIMA i test unit del parser (marker spezzato su più delta, nessun marker, JSON malformato, testo dopo il marker di chiusura da scartare).

**6c — system prompt** (`buildWidgetSystemPrompt(chunks, settings)` in `widget-chat.ts`): base analoga a `buildDocsSystemPrompt` (`docs-rag.ts:61`) ma registro customer service, nella lingua `settings.language`, regole: rispondi SOLO dal contesto documentazione; se l'utente segnala un bug/feedback o chiede qualcosa di irrisolvibile con la docs, proponi un ticket chiudendo la risposta col blocco sentinel (spiega il formato esatto e che `type` ∈ bug|feedback|feature); non promettere mai tempi; non citare percorsi file interni.

**6d — endpoint** `POST /widget/:slug/conversations/:conversationId/messages` body `widgetChatMessageBodySchema`:
1. Verifica conversazione (come Task 5, con `userId` nel body insieme a `content` — aggiungi `userId: z.string()` allo schema shared del messaggio).
2. **Cap giornaliero:** `SELECT count(*) FROM widget_messages m JOIN widget_conversations c ON ... WHERE c.project_id = :id AND m.role = 'user' AND m.created_at >= date_trunc('day', now())` ≥ cap → 429 `{ code: "widget_chat_cap_reached" }` PRIMA di hijackare.
3. Pre-flight LLM come la chat esistente (503 `chat_unavailable`).
4. Inserisci il messaggio user, aggiorna `lastMessageAt`.
5. Retrieval: `retrieveChunksForProject(db, embeddingClient, projectId, content, { k: CHAT_RETRIEVAL_K, repositoryIds: settings.enabledRepositoryIds })` → citazioni con `buildCitations`.
6. Stream: NON riusare `streamChatResponse` (persistenza hardcoded su docChatMessages); scrivi `streamWidgetChatResponse` in `widget-chat.ts` riusando `writeSseEvent` e la stessa meccanica hijack/headers/abort (copiala da `docs-chat-core.ts:92-160`), con in più: forwarding dei delta limitato a `safeForwardLength`, a fine stream `extractProposal` → eventi `data: {type:"delta",text}` … poi eventuale `{type:"ticket_proposal", proposal:{title,body,type}}` poi `{type:"done", conversationId, citations}`. Persisti il messaggio assistant su `widget_messages` con `content = visible` e `citations`.
7. History nel prompt: ultime 10 coppie da `widget_messages` (escluso il blocco sentinel, che tanto non è mai persistito).

**Step integrazione (widget.test.ts):** con `fakeChatLlm`:
- Stream normale → eventi `delta` + `done` con citazioni; messaggi persistiti (user+assistant).
- `streamOverride` che emette testo + sentinel (spezzato in delta a metà marker) → i delta ricevuti NON contengono il marker, arriva `ticket_proposal` col JSON parsato, il contenuto persistito non contiene il sentinel.
- Cap: `buildApp({ ..., widgetDailyMessageCap: 1 })` → secondo messaggio → 429.
- Retrieval filtrato: repo B non abilitato → le citazioni non lo referenziano (seed doc_pages su 2 repo).

**Step 2-4:** FAIL → implementa → PASS (unit prima, integrazione poi). **Step 5:** commit atomici: `feat(server): filtro repositoryIds nel retrieval progetto`, poi `feat(server): chat SSE widget con proposta ticket via sentinel`.

---

### Task 7: Conferma ticket dal widget

**Files:**
- Modify: `apps/server/src/routes/widget.ts`
- Test: `apps/server/src/routes/widget.test.ts` (estendi)

`POST /widget/:slug/conversations/:conversationId/tickets` body `widgetTicketConfirmBodySchema` + `userId`:
1. Verifica conversazione (progetto+userId) e widget enabled.
2. Componi il body del ticket: `body` della proposta + separatore `---` + blocco markdown con identità (`externalUserName`/`Email`/`externalUserId`) + trascrizione ultimi 10 messaggi (`> **utente:** ...` / `> **assistente:** ...`).
3. Crea con `createTicket(db, { projectId, title, body, type, priority: "medium", source: "widget" })` (`apps/server/src/db/tickets.ts:50`). Valuta `createExternalTicket` (`ingest/processor.ts:318`) se vuoi anche l'accodamento `aiJobs` — **NO per v1**: i ticket widget non partono automaticamente in pipeline AI; usa `createTicket` puro.
4. Inserisci in `widget_messages` una riga `role: "assistant"`, `content` breve di conferma nella lingua settings (es. `"Segnalazione registrata: #<number>"`), `ticketId` valorizzato.
5. Risposta `{ ticketId, number }`.

**Test:** creazione felice (ticket in DB con source `widget`, body contiene email e trascrizione, messaggio con ticketId collegato); 404 userId sbagliato; 422 type `task`; il numero ticket incrementa `next_ticket_number`.

Commit `feat(server): creazione ticket dal widget con trascrizione`.

---

### Task 8: API interna viewer conversazioni

**Files:**
- Modify: `apps/server/src/routes/widget-settings.ts` (o file dedicato `widget-conversations-admin.ts` se preferisci — stesso plugin `/api`)
- Test: `apps/server/src/routes/widget-settings.test.ts` (estendi)

Endpoint (`requireAuth`, come le letture progetto):
- `GET /api/projects/:projectId/widget/conversations?limit=50&ticketId=<uuid>` → lista ordinata per `lastMessageAt` desc: `{ id, externalUserId, externalUserEmail, externalUserName, lastMessageAt, createdAt, messageCount, ticketCount }` (`ticketCount` = messaggi con ticketId non nullo; usare subquery/aggregazione). Con `ticketId`: solo la conversazione che contiene quel ticket (per il link "Vedi conversazione" dal ticket).
- `GET /api/projects/:projectId/widget/conversations/:conversationId/messages` → filo completo (verifica appartenenza al progetto → 404).

**Test:** lista vuota; lista con 2 conversazioni ordinate; filtro ticketId; messaggi 404 cross-progetto; 401 senza sessione.

Commit `feat(server): API interna conversazioni widget`.

---

### Task 9: Package `@stubwise/widget` — scaffold + core senza UI

**Files:**
- Create: `packages/widget/package.json`, `packages/widget/tsconfig.json`, `packages/widget/vite.config.ts`
- Create: `packages/widget/src/core/dsn.ts`, `packages/widget/src/core/api.ts`, `packages/widget/src/core/sse.ts`, `packages/widget/src/core/storage.ts`
- Create: `packages/widget/src/core/{dsn,sse,storage}.test.ts`

**package.json:**

```json
{
  "name": "@stubwise/widget",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "publishConfig": { "access": "public" },
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/stubwise-widget.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "vite build && tsc -p tsconfig.build.json --emitDeclarationOnly",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "preact": "^10.25.0" },
  "devDependencies": { "@preact/preset-vite": "^2.9.0", "happy-dom": "catalog-or-version-usata-da-apps-web", "vite": "workspace-version", "vitest": "workspace-version", "typescript": "workspace-version" }
}
```

(Allinea le versioni devDeps a quelle di `apps/web/package.json` — leggi il file. `pnpm-workspace.yaml` include già `packages/*`.)

**vite.config.ts:** `@preact/preset-vite`; `build.lib = { entry: "src/index.ts", name: "Stubwise", formats: ["es", "iife"], fileName: (f) => f === "iife" ? "stubwise-widget.iife.js" : "stubwise-widget.js" }`; `define: { "process.env.NODE_ENV": '"production"' }`; sezione `test` come apps/web (`environment: "happy-dom"`). **tsconfig:** extends base MA override `module/moduleResolution: "bundler"`, `jsx: "react-jsx"`, `jsxImportSource: "preact"`, `lib: ["ES2022", "DOM"]` (come fa apps/web — leggi il suo tsconfig).

**Core (TDD file per file):**
- `dsn.ts`: `parseWidgetDsn(dsn) → { origin, slug, key }` da `https://KEY@host/p/slug` (adatta la logica di `packages/sdk/src/core/transport.ts:21-43`; NON importare dall'SDK). Test: DSN valido, con porta, malformato → throw.
- `storage.ts`: `getConversationId(slug)/setConversationId(slug, id)` su localStorage key `stubwise-widget:<slug>:conversation`, try/catch totale (localStorage può lanciare in privacy mode → ritorna null).
- `sse.ts`: `parseSseStream(response, onEvent)` — reader + TextDecoder + buffer su `\n\n` + `data: {json}` (adatta il pattern di `apps/web/src/components/docs-chat.tsx:167-210`). Eventi tipizzati: `delta | ticket_proposal | done | error`. Test con `ReadableStream` fittizia che spezza gli eventi a metà.
- `api.ts`: client minimale con `X-Stubwise-Key`: `fetchConfig`, `createConversation`, `fetchMessages`, `sendMessage` (ritorna Response per lo stream), `confirmTicket`. Nessun test dedicato (coperto dai test UI + server).

Commit `feat(widget): package @stubwise/widget con core dsn/sse/storage`.

---

### Task 10: Widget UI (Preact, Shadow DOM)

**Files:**
- Create: `packages/widget/src/index.ts` (entry: `initWidget`, `window.Stubwise`, evento `stubwise:ready`)
- Create: `packages/widget/src/ui/widget.tsx` (root: bolla + pannello), `src/ui/chat.tsx`, `src/ui/ticket-card.tsx`, `src/ui/styles.ts` (CSS come stringa, iniettato nello shadow root)
- Create: `packages/widget/src/i18n.ts` (stringhe statiche it/en)
- Test: `packages/widget/src/ui/widget.test.tsx`

**Comportamento (dal design):**
- `initWidget({ dsn, user })`: parse DSN → `fetchConfig`; se fetch fallisce o `enabled: false` → non monta nulla e NON lancia (try/catch totale sull'intero init, `console.warn` al più). Se ok: crea `<div id="stubwise-widget-host">` su `document.body`, `attachShadow({ mode: "open" })`, `<style>` + render Preact dentro.
- Bolla fissa bottom-right (colore `accentColor`), click → pannello 380×600 (media query full-screen < 480px), header con `title`.
- All'apertura: se c'è conversationId in storage → `fetchMessages` (404 → scarta storage e riparti); altrimenti mostra solo `welcomeMessage` come messaggio assistant fittizio (non persistito). La conversazione si crea lazy al primo messaggio inviato.
- Invio messaggio → `sendMessage` → `parseSseStream`: delta accumulati nel messaggio assistant in progress; `ticket_proposal` → aggiungi card in coda alla chat; `done` → citazioni sotto il messaggio (`fonte: <title>` testo semplice); `error`/429 → messaggio di cortesia (da i18n, per 429 la variante "assistente non disponibile, puoi comunque descrivere il problema e invieremo una segnalazione" — in v1 il 429 mostra solo il testo, la chat resta per ticket già proposti).
- Card ticket: badge type, input title, textarea body (precompilati, editabili), bottoni Invia/Annulla → `confirmTicket` → card diventa conferma `#<number>`; annulla → card scompare.
- `chatEnabled: false` in config → composer disabilitato con nota, il widget si monta comunque (per leggere lo storico).

**Test (happy-dom, mock `fetch` globale):**
1. `initWidget` con config `enabled:false` → nessun nodo montato, nessun throw.
2. Config ok → bolla presente; click → pannello con welcomeMessage.
3. Invio messaggio con stream mock (delta+done) → testo assistant renderizzato, citazione visibile.
4. Stream con `ticket_proposal` → card con campi precompilati; conferma → chiamata `confirmTicket` col body editato e card di successo.
5. `fetch` che lancia all'init → nessun throw.

**Verifica bundle:** `pnpm --filter @stubwise/widget build` → esiste `dist/stubwise-widget.iife.js` e contiene `window.Stubwise` (`grep`). L'entry IIFE: `index.ts` assegna `window.Stubwise = { initWidget }` e fa `window.dispatchEvent(new Event("stubwise:ready"))` (guard `typeof window !== "undefined"`).

Commit `feat(widget): UI chat con card ticket in Shadow DOM`.

---

### Task 11: SPA — sezione impostazioni Widget nel progetto

**Files:**
- Modify: `apps/web/src/lib/api.ts` (tipi + `getWidgetSettings`, `putWidgetSettings`)
- Modify: `apps/web/src/lib/queries.ts` (queryOptions `widgetSettingsQueryOptions(projectId)`)
- Create: `apps/web/src/components/widget-settings-section.tsx`
- Modify: `apps/web/src/routes/projects/$projectId.tsx` (nuova sezione dopo "Integrazione", righe ~169-175)
- Modify: `apps/web/src/i18n/locales/en.json` + `it.json` (namespace nuovo `widget` → aggiungilo a `NAMESPACES` in `apps/web/src/i18n/index.ts:13-32`)
- Test: `apps/web/src/components/widget-settings-section.test.tsx`

Contenuto sezione (pattern form: `components/notifications-section.tsx:290-310` con `useMutation` + `setQueryData`):
- Toggle enabled; checklist repository del progetto (dai dati già nel loader/`projectQueryOptions` — verifica cosa espone; se i repo non ci sono, usa la query repos esistente usata dalla pagina, righe ~119-161) con warning se enabled e lista vuota; input title/welcomeMessage/accentColor (input `type="color"` + esadecimale) e select lingua it/en; bottone salva.
- Snippet integrazione (riusa lo stile di `components/integration-panel.tsx:27-48` e `CopyButton`):

```html
<script src="{origin}/widget.js" defer></script>
<script>
  window.addEventListener("stubwise:ready", function () {
    Stubwise.initWidget({
      dsn: "{protocol}//{ingestionKey}@{host}/p/{slug}",
      user: { id: "USER_ID", email: "USER_EMAIL", name: "USER_NAME" },
    });
  });
</script>
```

**Test component** (pattern `integration-panel.test.tsx`): render con settings mock → toggle e campi visibili; submit chiama `putWidgetSettings` con i valori (mocka `api.ts` con `vi.mock`); snippet contiene slug e chiave.

Commit `feat(web): impostazioni widget nel progetto con snippet`.

---

### Task 12: SPA — pagina Conversazioni

**Files:**
- Modify: `apps/web/src/lib/api.ts` + `queries.ts` (list/messages)
- Create: `apps/web/src/routes/projects/widget-conversations.tsx` (lista + dettaglio; scegli tu se pagina unica con pannello dettaglio o due route — pagina unica con selezione è più semplice)
- Modify: `apps/web/src/router.tsx` (nuova `createRoute` figlia di `authedRoute`, path `/projects/$projectId/conversations`, loader `ensureQueryData`, registrala in `addChildren` ~righe 475-506)
- Modify: `apps/web/src/routes/projects/$projectId.tsx` (link "Conversazioni widget" nella pagina progetto, visibile quando il widget è enabled)
- Modify: locales en/it (namespace `widget`)
- Test: `apps/web/src/routes/projects/widget-conversations.test.tsx`

Lista: utente (name/email/id), data ultimo messaggio, badge `N ticket` se `ticketCount > 0`. Dettaglio: filo read-only con ruoli, citazioni (`fonte: titolo`), messaggi con ticketId → link `Link` al ticket (route ticket esistente — cerca il path in `router.tsx`).

**Ticket → conversazione:** nella pagina dettaglio ticket (trova il file della route ticket in `router.tsx`), se `ticket.source === "widget"`, mostra link "Vedi conversazione" → `/projects/$projectId/conversations?ticketId=<id>`; la pagina conversazioni con `ticketId` nei search params seleziona quella conversazione (usa `validateSearch` di TanStack Router).

**Test:** render lista con 2 conversazioni mock; selezione mostra i messaggi; badge ticket presente.

Commit `feat(web): viewer conversazioni widget e link dal ticket`.

---

### Task 13: Caddy, Dockerfile.caddy, proxy dev

**Files:**
- Modify: `Caddyfile`
- Modify: `Dockerfile.caddy`
- Modify: `apps/web/vite.config.ts` (proxy dev)
- Modify: `CLAUDE.md` (una riga nella sezione architettura runtime: widget.js servito da caddy; `/widget/*` API pubblica proxata al server)

1. **Caddyfile:** aggiungi `/widget/*` al matcher `@backend` (`path /api/* /ingest/* /webhooks/* /widget/*`). Per il bundle, PRIMA del fallback SPA:

```
handle /widget.js {
	root * /srv/widget
	rewrite * /stubwise-widget.iife.js
	file_server
}
```

⚠️ Ordine: il matcher `@backend` con `/widget/*` NON matcha `/widget.js` (path senza slash successivo)? Verifica: `/widget/*` in Caddy matcha `/widget/config` ma anche... NO, `/widget/*` non matcha `/widget.js`. Ma per sicurezza metti il blocco `handle /widget.js` PRIMA di `handle @backend` e aggiungi un commento sull'ordine (i `handle` sono valutati in ordine, come per `/guide/*`).
2. **Dockerfile.caddy:** nello stage `web-build` aggiungi `COPY packages/widget/package.json packages/widget/` accanto agli altri package.json PRIMA di `pnpm install`; dopo la build web aggiungi `RUN pnpm --filter @stubwise/widget build`; nello stage finale `COPY --from=web-build /repo/packages/widget/dist /srv/widget`. (Nota: `COPY packages packages` copia già i sorgenti.)
3. **vite.config.ts (apps/web):** aggiungi `"/widget"` al proxy dev verso `localhost:3000` (righe 10-15) — utile per provare il widget in locale.
4. **Verifica build immagine:** `docker build -f Dockerfile.caddy -t stubwise-caddy-test .` → OK e `docker run --rm --entrypoint ls stubwise-caddy-test /srv/widget` mostra il file. Se Docker non è disponibile in locale, almeno `pnpm --filter @stubwise/widget build` e review manuale del Dockerfile.

Commit `feat(deploy): widget.js servito da caddy e route /widget proxata`.

---

### Task 14: Guida Starlight

**Files:**
- Create: `apps/docs/src/content/docs/<posizione coerente con le guide esistenti>/widget.md` (o `.mdx` — guarda i file vicini)

Pagina breve: cos'è il widget, prerequisiti (docs generate, repo abilitati), snippet script-tag + init con identità, uso npm `@stubwise/widget`, note (fiducia sull'identità, cap giornaliero, i ticket arrivano con source widget). Lingua: coerente col resto della guida (leggi 1-2 pagine esistenti). `pnpm --filter @stubwise/docs build` per verificare.

Commit `docs: guida integrazione widget`.

---

### Task 15: Verifica finale

1. `pnpm build` (radice) → verde.
2. `pnpm typecheck` → verde.
3. `pnpm test` → verde (testcontainers: NON parallelizzare oltre; se flaky, rilancia il singolo package).
4. `pnpm lint` → verde. **La CI fallisce su lint anche con tutto il resto verde.**
5. Smoke manuale opzionale: `docker compose` locale o `pnpm dev` + pagina HTML di prova con lo script-tag puntato all'istanza dev.
6. Commit finale di eventuali fix + push del branch `feature/widget-customer-service`.

**Fuori scope (non implementare):** handoff umano, notifiche nuova conversazione, 👍/👎, HMAC, visibilità per-pagina, pipeline AI automatica sui ticket widget.
