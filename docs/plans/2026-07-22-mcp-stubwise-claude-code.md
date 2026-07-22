# Integrazione Claude Code ↔ Stubwise via server MCP — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Dare a Claude Code (sul PC di ogni sviluppatore) la capacità di leggere e scrivere backlog e ticket di Stubwise, così che design/piani e stato di avanzamento restino sincronizzati con l'istanza condivisa.

**Architecture:** Tre componenti. (1) Un **Personal Access Token (PAT)** lato `apps/server` per autenticare l'API `/api/*` senza cookie, modellato sul token `sk_` del monitoring. (2) Una **piccola estensione backlog** che restituisce il `jobId` dell'intake e un endpoint di status che risolve l'`itemId` finale (necessario per il link bidirezionale, dato che l'intake è asincrono con auto-merge). (3) Un nuovo pacchetto **`packages/mcp`** (`@stubwise/mcp`, server MCP stdio via `npx`) che espone tool tipizzati mappati 1:1 sugli endpoint esistenti, più i **deliverable di integrazione** in Claude Code (`.mcp.json`, comando `/stubwise:init`, skill, snippet `CLAUDE.md`).

**Tech Stack:** Fastify + Zod (server), Drizzle + Postgres (db), React + TanStack Router/Query (SPA), `@modelcontextprotocol/sdk` + Zod (MCP), Vitest + testcontainers (test).

**Riferimento design:** `docs/plans/2026-07-22-mcp-stubwise-claude-code-design.md`.

**Ordine e dipendenze:** Fase A (PAT) e Fase B (backlog jobId) sono indipendenti tra loro. La Fase C (MCP) dipende da A (auth) e B (polling create_backlog_item). La Fase D dipende da C. Eseguire A → B → C → D.

**Convenzioni verificate nel repo:**
- Un pacchetto per singolo comando: `pnpm --filter @stubwise/<nome> <script>`.
- `pnpm lint` PRIMA di ogni merge (la CI fallisce su lint anche con typecheck/test verdi).
- Le migrazioni Drizzle si generano con `pnpm --filter @stubwise/db exec drizzle-kit generate` e si applicano all'avvio del server via `runMigrations` (`apps/server/src/index.ts`). Ultima migrazione presente: `0055`.
- Test DB/server/worker usano testcontainers; lanciarli per pacchetto per evitare la flakiness da troppi Postgres concorrenti.

---

## FASE A — Personal Access Token (auth server)

### Task A1: Tabella `personalAccessTokens` nello schema Drizzle

**Files:**
- Modify: `packages/db/src/schema.ts` (aggiungere accanto a `sessions`, ~riga 271)
- Test: `packages/db/src/schema.test.ts` (esiste già; aggiungere un caso)

**Step 1 — Scrivere il test che fallisce.** In `packages/db/src/schema.test.ts` aggiungi un test che inserisce un utente + un PAT e lo rilegge (usa l'helper di test-db già presente nel file; imita i test esistenti su altre tabelle):

```ts
it("persiste e rilegge un personal access token", async () => {
  const [user] = await db
    .insert(users)
    .values({ email: "pat@example.com", passwordHash: "x", role: "member" })
    .returning();
  const [pat] = await db
    .insert(personalAccessTokens)
    .values({ userId: user!.id, name: "laptop", tokenHash: "deadbeef" })
    .returning();
  expect(pat!.tokenHash).toBe("deadbeef");
  expect(pat!.lastUsedAt).toBeNull();
  expect(pat!.expiresAt).toBeNull();
});
```

**Step 2 — Verificare che fallisce.** Run: `pnpm --filter @stubwise/db test -- schema.test.ts`. Atteso: FAIL — `personalAccessTokens` non esiste.

**Step 3 — Implementare la tabella.** In `packages/db/src/schema.ts`, dopo la definizione di `sessions`:

```ts
export const personalAccessTokens = pgTable(
  "personal_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(), // sha256 hex del token stw_pat_…
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Lookup dei token di un utente (lista/revoca in UI) + pulizia in cascata.
  (table) => [index("personal_access_tokens_user_id_idx").on(table.userId)],
);
```

La tabella è auto-esportata da `packages/db/src/index.ts` (`export * from "./schema.js"`).

**Step 4 — Verificare che passa.** Run: `pnpm --filter @stubwise/db test -- schema.test.ts`. Atteso: PASS.

**Step 5 — Commit.**

```bash
git add packages/db/src/schema.ts packages/db/src/schema.test.ts
git commit -m "feat(db): tabella personal_access_tokens"
```

---

### Task A2: Migrazione `0056` + test di migrazione

**Files:**
- Create: `packages/db/drizzle/0056_personal_access_tokens.sql` (generata)
- Create: `packages/db/src/migration-0056.test.ts`
- Modify (auto): `packages/db/drizzle/meta/_journal.json` + snapshot

**Step 1 — Generare la migrazione.** Run: `pnpm --filter @stubwise/db exec drizzle-kit generate`. Verifica che compaia `packages/db/drizzle/0056_*.sql` con `CREATE TABLE "personal_access_tokens"` (uuid PK, FK cascade a users, `token_hash` unique, timestamp nullable). Rinomina il tag se serve coerenza.

**Step 2 — Scrivere il test di migrazione** (modello: `packages/db/src/migration-0041.test.ts`). Applica le migrazioni su un DB testcontainer pulito e verifica che la tabella e i vincoli esistano:

```ts
it("crea la tabella personal_access_tokens con token_hash unique", async () => {
  const rows = await db.execute(sql`
    select column_name from information_schema.columns
    where table_name = 'personal_access_tokens' order by column_name`);
  const cols = rows.map((r) => r.column_name);
  expect(cols).toEqual(
    expect.arrayContaining(["id", "user_id", "name", "token_hash", "last_used_at", "expires_at", "created_at"]),
  );
});
```

**Step 3 — Verificare.** Run: `pnpm --filter @stubwise/db test -- migration-0056.test.ts`. Atteso: PASS.

**Step 4 — Commit.**

```bash
git add packages/db/drizzle packages/db/src/migration-0056.test.ts
git commit -m "feat(db): migrazione 0056 personal_access_tokens"
```

---

### Task A3: Util di generazione/hash del PAT

**Files:**
- Modify: `apps/server/src/routes/shared.ts` (accanto a `generateServerKey`, ~riga 21)
- Test: `apps/server/src/routes/shared.test.ts` (creare se non esiste)

**Step 1 — Test che fallisce.**

```ts
import { describe, it, expect } from "vitest";
import { generatePat, hashServerKey } from "./shared.js";

describe("generatePat", () => {
  it("produce un token con prefisso stw_pat_ e 48 hex", () => {
    const t = generatePat();
    expect(t).toMatch(/^stw_pat_[0-9a-f]{48}$/);
  });
  it("token diversi hanno hash diversi, stesso token stesso hash", () => {
    const a = generatePat();
    expect(hashServerKey(a)).toBe(hashServerKey(a));
    expect(hashServerKey(a)).not.toBe(hashServerKey(generatePat()));
  });
});
```

**Step 2 — Verificare fallimento.** Run: `pnpm --filter @stubwise/server test -- shared.test.ts`. Atteso: FAIL — `generatePat` non esportata.

**Step 3 — Implementare.** In `apps/server/src/routes/shared.ts`:

```ts
/** Personal Access Token: `stw_pat_` + 24 byte esadecimali. In DB si salva solo hashServerKey(token). */
export function generatePat(): string {
  return `stw_pat_${randomBytes(24).toString("hex")}`;
}
```

(`randomBytes` è già importato in cima al file; riusiamo `hashServerKey` per l'hash sha256.)

**Step 4 — Verificare.** Run: `pnpm --filter @stubwise/server test -- shared.test.ts`. Atteso: PASS.

**Step 5 — Commit.**

```bash
git add apps/server/src/routes/shared.ts apps/server/src/routes/shared.test.ts
git commit -m "feat(server): generatePat per i personal access token"
```

---

### Task A4: `requireAuth` accetta il Bearer PAT

Questo è il fulcro: estendendo `requireAuth`, TUTTE le route già protette (incluse quelle `requireAdmin`) accettano il PAT senza modifiche per-route.

**Files:**
- Modify: `apps/server/src/auth/session.ts`
- Test: `apps/server/src/auth/session.test.ts` (creare se non esiste; altrimenti aggiungere)

**Step 1 — Test che fallisce.** Test d'integrazione a livello di funzione: inserisci utente + PAT, costruisci una `FastifyRequest` fittizia con header `authorization` e verifica che `requireAuth` popoli `request.user`. Modella il setup DB sui test server esistenti (testcontainer + `buildApp` o accesso diretto al `db`). Approccio consigliato: test via HTTP con `app.inject` su una route protetta esistente (es. `GET /api/projects`) passando `Authorization: Bearer <pat>` e verificando 200; e con un PAT revocato/scaduto verificando 401.

```ts
it("autentica una route protetta con Bearer PAT valido", async () => {
  const token = generatePat();
  await db.insert(personalAccessTokens).values({ userId: user.id, name: "t", tokenHash: hashServerKey(token) });
  const res = await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
});

it("rifiuta un PAT scaduto", async () => {
  const token = generatePat();
  await db.insert(personalAccessTokens).values({
    userId: user.id, name: "t", tokenHash: hashServerKey(token),
    expiresAt: new Date(Date.now() - 1000),
  });
  const res = await app.inject({ method: "GET", url: "/api/projects", headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(401);
});
```

**Step 2 — Verificare fallimento.** Run: `pnpm --filter @stubwise/server test -- session.test.ts`. Atteso: FAIL (401 col PAT valido, perché non ancora gestito).

**Step 3 — Implementare.** In `apps/server/src/auth/session.ts` aggiungi la risoluzione via PAT e chiamala all'inizio di `requireAuth`:

```ts
import { createHash } from "node:crypto";
import { personalAccessTokens } from "@stubwise/db";
// ...

const PAT_PREFIX = "stw_pat_";

/** Risolve un utente da `Authorization: Bearer stw_pat_...`. Ritorna null se assente/non valido/scaduto. Aggiorna lastUsedAt. */
export async function findPatUser(db: Db, authorization: string | undefined): Promise<SessionUser | null> {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/.exec(authorization);
  const token = m?.[1];
  if (!token || !token.startsWith(PAT_PREFIX)) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const [row] = await db
    .select({
      patId: personalAccessTokens.id,
      expiresAt: personalAccessTokens.expiresAt,
      id: users.id,
      email: users.email,
      role: users.role,
      language: users.language,
      avatarUrl: users.slackAvatarUrl,
      slackUserId: users.slackUserId,
    })
    .from(personalAccessTokens)
    .innerJoin(users, eq(personalAccessTokens.userId, users.id))
    .where(eq(personalAccessTokens.tokenHash, tokenHash));
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  // best-effort: non blocca l'auth se fallisce
  await db
    .update(personalAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(personalAccessTokens.id, row.patId))
    .catch(() => undefined);
  return {
    id: row.id, email: row.email, role: row.role,
    language: row.language, avatarUrl: row.avatarUrl, slackUserId: row.slackUserId,
  };
}
```

E in `requireAuth`, prima del ramo cookie:

```ts
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const patUser = await findPatUser(request.server.db, request.headers.authorization);
  if (patUser) {
    request.user = patUser;
    return;
  }
  const sessionId = sessionIdFromRequest(request);
  const user = sessionId ? await findSessionUser(request.server.db, sessionId) : null;
  if (!user) {
    await apiError(reply, 401, "unauthorized", "Authentication required");
    return;
  }
  request.user = user;
}
```

`requireAdmin` resta invariato (chiama `requireAuth` e poi controlla `request.user?.role`): un PAT di un non-admin verrà correttamente respinto con 403 sulle route admin.

**Step 4 — Verificare.** Run: `pnpm --filter @stubwise/server test -- session.test.ts`. Atteso: PASS.

**Step 5 — Commit.**

```bash
git add apps/server/src/auth/session.ts apps/server/src/auth/session.test.ts
git commit -m "feat(server): requireAuth accetta Bearer personal access token"
```

---

### Task A5: Route CRUD dei PAT (`/api/pats`)

**Files:**
- Create: `apps/server/src/routes/pat.ts`
- Modify: `apps/server/src/app.ts` (import + register con prefix `/api/pats`)
- Create: `packages/shared/src/schemas/pat.ts` (schemi) + export in `packages/shared/src/schemas/index.ts` (o dove aggregato)
- Test: `apps/server/src/routes/pat.test.ts`

**Step 1 — Schemi condivisi.** In `packages/shared/src/schemas/pat.ts`:

```ts
import { z } from "zod";

export const createPatSchema = z.object({
  name: z.string().min(1).max(100),
  expiresAt: z.string().datetime().nullable().optional(), // ISO; null/omesso = infinito
});
export const patViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  lastUsedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export const patWithTokenSchema = patViewSchema.extend({ token: z.string() });
export type PatView = z.infer<typeof patViewSchema>;
export type PatWithToken = z.infer<typeof patWithTokenSchema>;
```

**Step 2 — Test che fallisce** (`pat.test.ts`, via `app.inject` con cookie di sessione di un utente member): create → 201 con `token` in chiaro (formato `stw_pat_…`); list → 200 senza `token`; delete → 204; dopo delete il token non autentica più (401 su `/api/projects`). Verifica anche che due utenti non vedano i token altrui.

**Step 3 — Implementare la route** (modello: `apps/server/src/routes/servers.ts` per la UX segreto-una-tantum):

```ts
export async function patRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get("/", { preHandler: requireAuth, schema: { response: { 200: z.array(patViewSchema), ...authErrorResponses } } },
    async (request) => {
      const rows = await app.db.select().from(personalAccessTokens)
        .where(eq(personalAccessTokens.userId, request.user!.id))
        .orderBy(desc(personalAccessTokens.createdAt));
      return rows.map(toPatView);
    });

  app.post("/", { preHandler: requireAuth, schema: { body: createPatSchema, response: { 201: patWithTokenSchema, ...authErrorResponses } } },
    async (request, reply) => {
      const token = generatePat();
      const [created] = await app.db.insert(personalAccessTokens).values({
        userId: request.user!.id,
        name: request.body.name,
        tokenHash: hashServerKey(token),
        expiresAt: request.body.expiresAt ? new Date(request.body.expiresAt) : null,
      }).returning();
      return reply.code(201).send({ ...toPatView(created!), token });
    });

  app.delete("/:id", { preHandler: requireAuth, schema: { params: z.object({ id: z.uuid() }), response: { 204: z.null(), 404: errorSchema, ...authErrorResponses } } },
    async (request, reply) => {
      const deleted = await app.db.delete(personalAccessTokens)
        .where(and(eq(personalAccessTokens.id, request.params.id), eq(personalAccessTokens.userId, request.user!.id)))
        .returning({ id: personalAccessTokens.id });
      if (deleted.length === 0) return apiError(reply, 404, "pat_not_found", "Token not found");
      return reply.code(204).send();
    });
}
```

`toPatView` converte le date in ISO string. Registra in `app.ts` accanto agli altri: `app.register(patRoutes, { prefix: "/api/pats" })`.

**Step 4 — Verificare.** Run: `pnpm --filter @stubwise/server test -- pat.test.ts`. Atteso: PASS.

**Step 5 — Commit.**

```bash
git add apps/server/src/routes/pat.ts apps/server/src/app.ts packages/shared/src/schemas/pat.ts packages/shared/src/schemas/index.ts apps/server/src/routes/pat.test.ts
git commit -m "feat(server): CRUD /api/pats con token una-tantum"
```

---

### Task A6: UI impostazioni utente per i PAT

**Files:**
- Create: `apps/web/src/routes/settings/access-tokens.tsx`
- Modify: `apps/web/src/lib/api.ts` (binding + tipi), `apps/web/src/router.tsx` (route), `apps/web/src/routes/settings/layout.tsx` (voce nav), file i18n `settings` (chiave `layout.nav.accessTokens` + testi pagina)
- Test: `apps/web/src/routes/settings/access-tokens.test.tsx` (happy-dom)

**Step 1 — Binding API** in `apps/web/src/lib/api.ts` (modello `createServer`/`deleteServer`):

```ts
export interface PatView { id: string; name: string; lastUsedAt: string | null; expiresAt: string | null; createdAt: string }
export interface PatWithToken extends PatView { token: string }
export function listPats(): Promise<PatView[]> { return api.get("/api/pats"); }
export function createPat(name: string, expiresAt: string | null): Promise<PatWithToken> { return api.post("/api/pats", { name, expiresAt }); }
export function deletePat(id: string): Promise<void> { return request("DELETE", `/api/pats/${encodeURIComponent(id)}`); }
export const patsQueryOptions = queryOptions({ queryKey: ["pats"], queryFn: listPats });
```

**Step 2 — Test che fallisce** (`access-tokens.test.tsx`): render della pagina con QueryClient e API mockata; simula create → il token in chiaro compare in un pannello reveal; simula delete → la riga sparisce. Modella su un test settings esistente.

**Step 3 — Implementare la pagina** (modello: `account.tsx` per struttura + `monitor/server-admin.tsx` `KeyPanel` per il reveal una-tantum, incluso il fallback copy per contesti http non-sicuri). La pagina: lista dei token (nome, ultimo uso, scadenza), form "crea" (nome + scadenza opzionale), e al successo un pannello che mostra `token` UNA volta con pulsante copia. Registra la route in `router.tsx` (senza `requireAdmin`, i PAT sono per-utente) e aggiungila a `settingsRoute.addChildren([...])`; aggiungi la voce nav `{ to: "/settings/access-tokens", labelKey: "accessTokens", adminOnly: false }` in `layout.tsx`; aggiungi le chiavi i18n.

**Step 4 — Verificare.** Run: `pnpm --filter @stubwise/web test -- access-tokens.test.tsx`. Atteso: PASS. Poi `pnpm --filter @stubwise/web typecheck`.

**Step 5 — Commit.**

```bash
git add apps/web/src
git commit -m "feat(web): impostazioni Personal Access Token"
```

**Nota E2E:** questa è modifica UI → prevedere un E2E Playwright a mano più avanti (non gira in `pnpm -r test`).

---

## FASE B — Backlog: jobId di ritorno + endpoint di status

### Task B1: Colonna `resultItemId` su `backlog_jobs` + migrazione

**Files:**
- Modify: `packages/db/src/schema.ts` (tabella `backlogJobs`, ~riga 2078)
- Create: migrazione `0057_backlog_jobs_result_item.sql` (generata) + `packages/db/src/migration-0057.test.ts`

**Step 1 — Test che fallisce** (migration test, come A2): verifica la presenza della colonna `result_item_id` con FK a `backlog_items` `ON DELETE set null`.

**Step 2 — Implementare la colonna.** In `backlogJobs`:

```ts
    // itemId prodotto dall'intake (o item su cui è avvenuto l'auto-merge). Null finché il job non è done.
    resultItemId: uuid("result_item_id").references(() => backlogItems.id, { onDelete: "set null" }),
```

**Step 3 — Generare migrazione.** Run: `pnpm --filter @stubwise/db exec drizzle-kit generate`. Verifica `0057_*.sql`.

**Step 4 — Verificare.** Run: `pnpm --filter @stubwise/db test -- migration-0057.test.ts`. Atteso: PASS.

**Step 5 — Commit.**

```bash
git add packages/db/src/schema.ts packages/db/drizzle packages/db/src/migration-0057.test.ts
git commit -m "feat(db): backlog_jobs.result_item_id + migrazione 0057"
```

---

### Task B2: Il worker intake scrive `resultItemId` sul job

**Files:**
- Modify: `apps/worker/src/backlog/intake.ts` (dentro la transazione, ~righe 255-273)
- Test: `apps/worker/src/backlog/intake.test.ts` (aggiungere un caso)

**Step 1 — Test che fallisce.** Nel test dell'intake, dopo aver eseguito `runIntake` su un job manuale, verifica che `backlogJobs.resultItemId` del job punti all'item creato.

**Step 2 — Implementare.** Nella `tx` dopo l'insert dell'item:

```ts
      const item = inserted!;
      await tx.update(backlogJobs).set({ resultItemId: item.id }).where(eq(backlogJobs.id, job.id));
      if (ticket) await closeOriginTicket(tx, ticket, item.id, item.title, lang);
```

(In caso di auto-merge, `similarToId`/l'item risultante è comunque l'item canonico da referenziare: assicurati che `item.id` sia quello finale usato anche per il link.)

**Step 3 — Verificare.** Run: `pnpm --filter @stubwise/worker test -- intake.test.ts`. Atteso: PASS.

**Step 4 — Commit.**

```bash
git add apps/worker/src/backlog/intake.ts apps/worker/src/backlog/intake.test.ts
git commit -m "feat(worker): intake collega il job all'item creato (resultItemId)"
```

---

### Task B3: `POST /api/backlog` ritorna il `jobId`

**Files:**
- Modify: `apps/server/src/routes/backlog.ts` (handler POST, ~righe 713-739)
- Test: `apps/server/src/routes/backlog.test.ts` (aggiornare l'asserzione della 202)

**Step 1 — Aggiornare/aggiungere il test.** Il POST manuale deve rispondere `202 { queued: true, jobId }` con `jobId` uuid.

**Step 2 — Implementare.** Cambia l'insert e lo schema:

```ts
        response: {
          202: z.object({ queued: z.literal(true), jobId: z.uuid() }),
          404: errorSchema,
          ...authErrorResponses,
        },
```
```ts
      const [job] = await app.db
        .insert(backlogJobs)
        .values({ projectId, kind: "intake", payload: { title, body } })
        .returning({ id: backlogJobs.id });
      return reply.code(202).send({ queued: true, jobId: job!.id });
```

**Step 3 — Verificare.** Run: `pnpm --filter @stubwise/server test -- backlog.test.ts`. Atteso: PASS.

**Step 4 — Commit.**

```bash
git add apps/server/src/routes/backlog.ts apps/server/src/routes/backlog.test.ts
git commit -m "feat(server): POST /api/backlog ritorna il jobId"
```

---

### Task B4: `GET /api/backlog/jobs/:jobId` → `{ status, resultItemId }`

**Files:**
- Modify: `apps/server/src/routes/backlog.ts` (nuovo handler nel plugin)
- Test: `apps/server/src/routes/backlog.test.ts`

**Step 1 — Test che fallisce.** Enqueue un job (via POST), poi GET `/api/backlog/jobs/:jobId` → 200 `{ status: "queued", resultItemId: null }`. Con jobId inesistente → 404. Con un progetto altrui, coerente con la policy (requireAuth basta; opzionale scoping per progetto).

**Step 2 — Implementare** (dentro il plugin backlog, riusa `requireAuth`):

```ts
  app.get(
    "/jobs/:jobId",
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ jobId: z.uuid() }),
        response: {
          200: z.object({
            status: backlogJobStatusSchema,
            resultItemId: z.uuid().nullable(),
            error: z.string().nullable(),
          }),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const [job] = await app.db
        .select({ status: backlogJobs.status, resultItemId: backlogJobs.resultItemId, error: backlogJobs.error })
        .from(backlogJobs)
        .where(eq(backlogJobs.id, request.params.jobId));
      if (!job) return apiError(reply, 404, "job_not_found", "Job not found");
      return { status: job.status, resultItemId: job.resultItemId, error: job.error };
    },
  );
```

**Step 3 — Verificare.** Run: `pnpm --filter @stubwise/server test -- backlog.test.ts`. Atteso: PASS.

**Step 4 — Commit.**

```bash
git add apps/server/src/routes/backlog.ts apps/server/src/routes/backlog.test.ts
git commit -m "feat(server): GET /api/backlog/jobs/:jobId per lo status dell'intake"
```

---

## FASE C — Pacchetto `packages/mcp` (server MCP)

### Task C1: Scaffold del pacchetto

**Files:**
- Create: `packages/mcp/package.json`, `packages/mcp/tsconfig.json`, `packages/mcp/tsconfig.build.json`, `packages/mcp/src/index.ts` (bin), `packages/mcp/vitest.config.ts`

**Step 1 — `package.json`** (primo pacchetto con `"bin"`; dipende da `@modelcontextprotocol/sdk`, `zod`, `undici` per fetch Node stabile):

```json
{
  "name": "@stubwise/mcp",
  "version": "0.1.0",
  "description": "Stubwise MCP server: connect Claude Code to your Stubwise backlog and tickets.",
  "license": "MIT",
  "type": "module",
  "publishConfig": { "access": "public" },
  "files": ["dist"],
  "bin": { "stubwise-mcp": "./dist/index.js" },
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "pnpm run build"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^4.1.5"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^3.2.0"
  }
}
```

`tsconfig.json` e `tsconfig.build.json`: identici al modello di `packages/sdk`. `src/index.ts` inizia con lo shebang `#!/usr/bin/env node`.

**Step 2 — Installare le dipendenze.** Run (dalla radice): `pnpm install`. Verifica che `@modelcontextprotocol/sdk` si risolva.

**Step 3 — Build a vuoto.** `src/index.ts` provvisorio: `console.error("stubwise-mcp");`. Run: `pnpm --filter @stubwise/mcp build`. Atteso: `dist/index.js` creato.

**Step 4 — Commit.**

```bash
git add packages/mcp pnpm-lock.yaml
git commit -m "chore(mcp): scaffold pacchetto @stubwise/mcp"
```

---

### Task C2: Config loader (`.stubwise.json` + env) e HTTP client

**Files:**
- Create: `packages/mcp/src/config.ts`, `packages/mcp/src/client.ts`
- Test: `packages/mcp/src/config.test.ts`, `packages/mcp/src/client.test.ts`

**Step 1 — Test config.** `loadConfig({ cwd, env })` risolve: `STUBWISE_URL` (default prod), `STUBWISE_TOKEN` (obbligatorio; se assente → errore chiaro), e legge lo slug progetto da `.stubwise.json` risalendo dalle cartelle (`{ "project": "slug" }`). Se manca `.stubwise.json` → `projectSlug` = null (i tool di scrittura lo richiederanno).

**Step 2 — Implementare `config.ts`.** Cerca `.stubwise.json` da `cwd` verso l'alto fino alla radice del repo. Espone `{ baseUrl, token, projectSlug }`.

**Step 3 — Test client.** `StubwiseClient` con `fetch` mockato: ogni metodo manda `Authorization: Bearer <token>` e mappa 401/403/404/network su errori parlanti (riusa la semantica di `ApiError`). Metodi minimi: `listProjects`, `listBacklog`, `getBacklogItem`, `createBacklogItem`, `getBacklogJob`, `createTicket`, `getTicket`, `listTickets`, `convertBacklog`, `patchTicket`.

**Step 4 — Implementare `client.ts`.** Thin wrapper su `fetch` (Node 22 ha `fetch` globale) verso `${baseUrl}/api/...`. Valida le risposte con gli schemi Zod da `@stubwise/shared` dove disponibili.

**Step 5 — Verificare.** Run: `pnpm --filter @stubwise/mcp test`. Atteso: PASS.

**Step 6 — Commit.**

```bash
git add packages/mcp/src/config.ts packages/mcp/src/client.ts packages/mcp/src/config.test.ts packages/mcp/src/client.test.ts
git commit -m "feat(mcp): config loader e HTTP client"
```

---

### Task C3: Tool di lettura

**Files:**
- Create: `packages/mcp/src/tools/read.ts`
- Test: `packages/mcp/src/tools/read.test.ts`

Tool: `list_projects`, `list_backlog` (filtri projectSlug/status/urgency/q), `get_backlog_item`, `list_tickets`, `get_ticket`. Ogni tool ha `inputSchema` Zod (raw shape) e un handler che chiama il client e ritorna `content: [{ type: "text", text: JSON.stringify(...) }]` (o testo formattato leggibile). `projectSlug` di default preso dalla config; sovrascrivibile per argomento.

**Step 1 — Test** con client mockato: input valido → chiamata giusta; input non valido → errore di validazione. **Step 2 — Implementare. Step 3 — Verificare** (`pnpm --filter @stubwise/mcp test`). **Step 4 — Commit** `feat(mcp): tool di lettura backlog/ticket/progetti`.

---

### Task C4: Tool di scrittura (incluso polling `create_backlog_item`)

**Files:**
- Create: `packages/mcp/src/tools/write.ts`
- Test: `packages/mcp/src/tools/write.test.ts`

Tool:
- `create_ticket` → `POST /api/tickets` (ritorna id + number sincroni).
- `convert_backlog_to_ticket` → `POST /api/backlog/:id/convert`.
- `set_ticket_status` → `PATCH /api/tickets/:id` (validare lo stato contro l'enum reale: `open|triaged|in_progress|in_review|done|closed`).
- `create_backlog_item` → `POST /api/backlog`, poi **polling** su `GET /api/backlog/jobs/:jobId` finché `status` è `done`/`failed` (backoff, timeout configurabile, es. 120s). Ritorna `{ itemId, url }` risolto, oppure — su timeout/`failed` — un esito "in elaborazione, riferimento da aggiornare" senza fallire l'operazione lato Claude.

**Step 1 — Test.** Il caso polling con client mockato: prima risposta job `queued`, poi `done` con `resultItemId`; verifica che il tool ritorni l'itemId. Caso timeout: job resta `queued` → esito "pending" non-eccezionale.

**Step 2 — Implementare.** **Step 3 — Verificare.** **Step 4 — Commit** `feat(mcp): tool di scrittura con polling dell'intake backlog`.

---

### Task C5: Assemblaggio del server MCP stdio

**Files:**
- Modify: `packages/mcp/src/index.ts`
- Create: `packages/mcp/src/server.ts`
- Test: `packages/mcp/src/server.test.ts`

**Step 1 — Test.** `buildServer(client, config)` registra tutti i tool attesi (verifica i nomi registrati). Non testare il transport stdio (lo gestisce Claude Code).

**Step 2 — Implementare.** In `server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

export function buildServer(client, config) {
  const server = new McpServer({ name: "stubwise", version: "0.1.0" });
  registerReadTools(server, client, config);
  registerWriteTools(server, client, config);
  return server;
}
```

In `index.ts` (bin): carica config, costruisci client + server, collega `StdioServerTransport`. Se `STUBWISE_TOKEN` manca, scrivi un errore chiaro su stderr ed esci con codice ≠ 0.

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { StubwiseClient } from "./client.js";
import { buildServer } from "./server.js";

const config = loadConfig({ cwd: process.cwd(), env: process.env });
const server = buildServer(new StubwiseClient(config), config);
await server.connect(new StdioServerTransport());
```

**Step 3 — Verificare.** Run: `pnpm --filter @stubwise/mcp test && pnpm --filter @stubwise/mcp build`. Atteso: PASS + `dist/index.js` eseguibile.

**Step 4 — Prova manuale (smoke).** Con un server Stubwise locale in esecuzione e un PAT valido:
```bash
STUBWISE_URL=http://localhost:3000 STUBWISE_TOKEN=stw_pat_... node packages/mcp/dist/index.js
```
Verifica che parta senza crash (attende su stdio). `Ctrl-C` per uscire.

**Step 5 — Commit** `feat(mcp): server MCP stdio con registrazione tool`.

---

## FASE D — Integrazione Claude Code (deliverable nel repo)

### Task D1: `.mcp.json`, comando `/stubwise:init`, skill, snippet CLAUDE.md

**Files:**
- Create: `.mcp.json` (radice del repo Stubwise, come esempio auto-consumato)
- Create: `.claude/commands/stubwise/init.md` (comando `/stubwise:init`)
- Create: `.claude/skills/stubwise/SKILL.md` (istruzioni sui trigger dei 5 flussi)
- Modify: `CLAUDE.md` (breve sezione che rimanda alla skill)

**Step 1 — `.mcp.json`:**

```json
{
  "mcpServers": {
    "stubwise": {
      "command": "npx",
      "args": ["-y", "@stubwise/mcp"],
      "env": { "STUBWISE_TOKEN": "${STUBWISE_TOKEN}", "STUBWISE_URL": "${STUBWISE_URL}" }
    }
  }
}
```

(In sviluppo locale, prima della pubblicazione npm, si può puntare a `node packages/mcp/dist/index.js`.)

**Step 2 — Comando `/stubwise:init`** (`.claude/commands/stubwise/init.md`): istruzioni per far sì che Claude (a) scopra le radici git sotto la cwd, (b) usi il tool `list_projects`, (c) chieda all'utente l'accoppiamento repo→progetto, (d) scriva `.stubwise.json` in ogni radice e lo committi. Gestione monorepo/multirepo esplicita.

**Step 3 — Skill `stubwise`** (`.claude/skills/stubwise/SKILL.md`): quando e come usare i tool per i 5 flussi (design→backlog con link nel frontmatter; avvio piano→convert/create + `in_progress`; fine→`in_review`; `done` on-demand; consultazione backlog; nota al volo). Include l'avvertenza che `create_backlog_item` è asincrono e che il riferimento va scritto nel frontmatter del doc dopo la risoluzione.

**Step 4 — Snippet `CLAUDE.md`**: poche righe che citano la skill `stubwise` e il comando `/stubwise:init`.

**Step 5 — Verifica manuale end-to-end** (con server locale + PAT): apri Claude Code nel repo, lancia `/stubwise:init`, poi chiedi "cosa c'è in backlog?" e verifica la risposta. Crea un item di prova e verifica che compaia in Stubwise.

**Step 6 — Commit** `feat: integrazione Claude Code (mcp.json, comando init, skill)`.

---

## Verifica finale prima del merge

1. `pnpm build` — verde (include il nuovo `packages/mcp`).
2. `pnpm typecheck` — verde.
3. `pnpm lint` — verde (**obbligatorio**, la CI fallisce su lint).
4. Test per pacchetto toccato: `pnpm --filter @stubwise/{db,server,worker,web,mcp} test`.
5. E2E Playwright per la UI dei PAT (a mano, non gira in `pnpm -r test`).
6. `superpowers:requesting-code-review` sul branch.

## Note di deploy (dopo il merge)

- **Migrazioni 0056 + 0057** applicate all'avvio del server → **backup DB** prima; ribuildare `server`.
- **UI PAT** → ribuildare `caddy` (la SPA è servita da caddy).
- **Worker** (resultItemId) → ribuildare `worker`.
- **`@stubwise/mcp`** → pubblicazione npm separata (nessun impatto sul compose Stubwise; gira sui PC degli sviluppatori). Fino alla pubblicazione, `.mcp.json` può puntare al build locale.
- Ogni sviluppatore: crea un PAT dalle impostazioni, lo esporta in `STUBWISE_TOKEN`, lancia `/stubwise:init` nei propri repo.
