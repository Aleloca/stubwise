# Daily Activity Report — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ogni notte, per ogni progetto abilitato, generare uno standup asincrono dai commit del giorno (git log per autore + riassunto AI), consultabile in una sezione SPA con due viste (per progetto / per-dev), con associazione email git e account Bitbucket ai membri da `/team`.

**Architecture:** Un poller nel worker (pattern `review/poller.ts` ma a cadenza giornaliera via gate UTC) legge i commit del giorno dal mirror git già esistente (nuovo metodo `MirrorManager.getCommitsInRange`), li raggruppa per email, registra gli autori osservati, e per ogni autore lancia l'agente claude CLI per un riassunto. I report sono persistiti in `activity_reports` + `activity_report_entries`. L'API server espone la lettura (tutti i membri) e il linking identità (solo admin, pattern `slack/identity-routes.ts`). La SPA aggiunge una sezione "Attività" e due badge di linking in `/team`.

**Tech Stack:** Drizzle/Postgres (`packages/db`), Fastify + Zod (`apps/server`), worker poller + `AgentRunner` (`apps/worker`), React + TanStack Router/Query + Tailwind (`apps/web`). Test: Vitest + testcontainers (server/worker/db), happy-dom (web).

**Convenzioni di riferimento (verbatim raccolte):**
- Schema: `packages/db/src/schema.ts:190-206` (`users`), `:1100-1126` (`prReviewJobs`, unique + notBefore), enum via `pgEnum`.
- Migrazioni: `pnpm --filter @stubwise/db exec drizzle-kit generate`; prossimo numero **0049**; file in `packages/db/drizzle/`. Seed post-migrate SOLO se serve un enum value ADDato: qui NON serve (creiamo enum nuovi). `runMigrations` in `packages/db/src/client.ts`.
- Poller: `apps/worker/src/review/poller.ts` (struttura `startXxxPoller` + `pollXxxOnce`), avvio in `apps/worker/src/index.ts:264-293`, config in `apps/worker/src/config.ts` (pattern `*PollMinutes`).
- API linking: `apps/server/src/slack/identity-routes.ts`, registrazione `apps/server/src/app.ts:467-475`, resolver `apps/server/src/ingest/reporter.ts`, fixtures test `apps/server/src/test/fixtures.ts` (`seedUsers`, `sessionCookie`).
- Web: routing code-based `apps/web/src/router.tsx:444-457`, nav `apps/web/src/components/app-layout.tsx:25-34`, client `apps/web/src/lib/api.ts:782-836`, query `apps/web/src/lib/queries.ts`, test `apps/web/src/routes/team.test.tsx`.

**Nota commit:** ogni task termina con un commit. Usa il footer di sessione già in uso nel repo.

---

## Fase 0 — Schema DB e migrazione

### Task 1: Nuove tabelle, colonne e enum

**Files:**
- Modify: `packages/db/src/schema.ts` (aggiungi enum, tabelle, colonne)
- Test: `packages/db/src/schema.test.ts` (nuovo describe)
- Generate: `packages/db/drizzle/0049_*.sql`

**Step 1: Aggiungi l'enum status in cima agli enum (dopo `docJobStatus`, ~schema.ts:183).**

```ts
export const activityReportStatus = pgEnum("activity_report_status", [
  "queued",
  "running",
  "done",
  "failed",
]);
```

**Step 2: Aggiungi l'import `date` a `drizzle-orm/pg-core`** (schema.ts:22-39). Inserisci `date,` in ordine alfabetico dopo `customType,`. Non esiste ancora nessuna colonna `date` nello schema: la introduciamo qui perché il "giorno" del report è semanticamente una data, e semplifica l'unique `(projectId, date)`.

**Step 3: Aggiungi la colonna `bitbucketUsername` alla tabella `users`** (dentro `pgTable("users", {...})`, dopo `slackAvatarUrl`):

```ts
  // Username Bitbucket linkato al membro (speculare a slackUserId): un solo
  // membro per username, nullable (l'unique ignora i NULL in Postgres).
  bitbucketUsername: text("bitbucket_username").unique(),
```

**Step 4: Aggiungi la colonna `dailyReportEnabled` alla tabella `projects`** (trova `export const projects = pgTable("projects", {...}`; aggiungi accanto agli altri toggle booleani del progetto):

```ts
  // Se true, il poller notturno genera lo standup giornaliero per questo
  // progetto. Default false: opt-in esplicito per non generare report (e
  // consumare run dell'agente) su progetti non interessati.
  dailyReportEnabled: boolean("daily_report_enabled").notNull().default(false),
```

**Step 5: Aggiungi le quattro nuove tabelle in fondo allo schema** (dopo l'ultima tabella esistente):

```ts
/**
 * Alias email git → membro. Un membro può committare con più email (lavoro,
 * personale, noreply del provider): relazione 1 membro : N email. Distinta da
 * users.slackUserId (colonna singola) proprio per questo. L'email è memorizzata
 * lowercase; l'unique impedisce che la stessa email sia linkata a due membri.
 */
export const gitIdentities = pgTable(
  "git_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull().unique(),
    authorName: text("author_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("git_identities_user_id_idx").on(table.userId)],
);

/**
 * Autori git realmente osservati nei repo (auto-raccolti dal poller), per
 * alimentare il picker di link in /team (analogo a slack workspace-users). La
 * risoluzione a membro passa da git_identities, non serve un userId qui.
 */
export const gitAuthorsSeen = pgTable("git_authors_seen", {
  email: text("email").primaryKey(),
  authorName: text("author_name"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Un report di attività per (progetto, giorno UTC). L'unique (project_id, date)
 * rende idempotente il gate notturno: più tick concorrenti non creano doppioni.
 */
export const activityReports = pgTable(
  "activity_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    status: activityReportStatus("status").notNull().default("queued"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("activity_reports_project_date_unique").on(table.projectId, table.date)],
);

/** Una riga per (report, autore git): conteggi, commit e riassunto AI. */
export const activityReportEntries = pgTable(
  "activity_report_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => activityReports.id, { onDelete: "cascade" }),
    gitEmail: text("git_email").notNull(),
    authorName: text("author_name"),
    commitCount: integer("commit_count").notNull().default(0),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    repoIds: jsonb("repo_ids").$type<string[]>().notNull().default([]),
    commits: jsonb("commits")
      .$type<{ sha: string; subject: string; repoId: string }[]>()
      .notNull()
      .default([]),
    aiSummary: text("ai_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("activity_report_entries_report_id_idx").on(table.reportId)],
);
```

**Step 6: Genera la migrazione.**

Run: `pnpm --filter @stubwise/db exec drizzle-kit generate --name daily_activity_report`
Expected: crea `packages/db/drizzle/0049_daily_activity_report.sql` con `CREATE TYPE activity_report_status`, `ALTER TABLE users ADD COLUMN bitbucket_username`, `ALTER TABLE projects ADD COLUMN daily_report_enabled`, `CREATE TABLE git_identities/git_authors_seen/activity_reports/activity_report_entries` + indici/unique. Ispeziona il file: NON deve contenere `ALTER TYPE ... ADD VALUE` (creiamo un enum nuovo, nessuna trappola transazione).

**Step 7: Scrivi il test dello schema** in `packages/db/src/schema.test.ts` (nuovo `describe`, sul modello dei test esistenti che usano `startTestDb`):

```ts
describe("schema: daily activity report", () => {
  it("git_identities: email unique, cascade su delete user", async () => {
    const [u] = await db.insert(users).values({ email: `a-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning();
    await db.insert(gitIdentities).values({ userId: u!.id, email: "dev@x.it" });
    await expect(
      db.insert(gitIdentities).values({ userId: u!.id, email: "dev@x.it" }),
    ).rejects.toThrow();
    await db.delete(users).where(eq(users.id, u!.id));
    const rows = await db.select().from(gitIdentities).where(eq(gitIdentities.userId, u!.id));
    expect(rows).toHaveLength(0);
  });

  it("activity_reports: (project_id, date) unique", async () => {
    const [p] = await db.insert(projects).values({ name: "P", slug: `p-${randomUUID()}`, ingestionKey: randomUUID() }).returning();
    await db.insert(activityReports).values({ projectId: p!.id, date: "2026-07-14" });
    await expect(
      db.insert(activityReports).values({ projectId: p!.id, date: "2026-07-14" }),
    ).rejects.toThrow();
  });
});
```

**Step 8: Verifica.**
Run: `pnpm --filter @stubwise/db typecheck && pnpm --filter @stubwise/db test`
Expected: PASS.

**Step 9: Commit.**
```bash
git add packages/db/src/schema.ts packages/db/src/schema.test.ts packages/db/drizzle
git commit -m "feat(db): schema per daily activity report (identita git/bitbucket + report)"
```

---

## Fase 1 — MirrorManager: commit del giorno

### Task 2: `getCommitsInRange` (git log con finestra temporale + numstat)

`MirrorManager` non espone `git log` con `--since/--until` né `--numstat` (solo `getCommitMessages` su range di sha). Il `git` interno è privato → aggiungiamo un metodo pubblico sul suo modello.

**Files:**
- Modify: `apps/worker/src/git/mirrors.ts` (nuovo metodo dopo `getCommitMessages`, ~:613)
- Test: `apps/worker/src/git/mirrors.test.ts` (se esiste; altrimenti aggiungi al file di test dei mirror)

**Step 1: Definisci il tipo di ritorno e il metodo.** Aggiungi vicino agli altri tipi esportati:

```ts
export interface RangeCommit {
  sha: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601 (author date). */
  date: string;
  subject: string;
  isMerge: boolean;
  additions: number;
  deletions: number;
}
```

**Step 2: Implementa il metodo** (dentro la classe `MirrorManager`, sul modello di `getCommitMessages`):

```ts
  /**
   * Commit su TUTTI i ref con author-date nella finestra [since, until)
   * (`git log --all --since --until --numstat`), dal mirror aggiornato. `since`
   * incluso, `until` escluso: passa istanti UTC. Ogni commit riporta autore,
   * email, data ISO, subject, flag merge e righe aggiunte/rimosse (somma del
   * numstat; i file binari, marcati "-", contano 0).
   */
  async getCommitsInRange(
    project: MirrorProject,
    since: Date,
    until: Date,
  ): Promise<RangeCommit[]> {
    const mirrorDir = await this.ensureMirror(project);
    // Record separato da NUL; header dei campi separati da TAB; poi le righe
    // numstat. %P non vuoto con più di un parent ⇒ merge.
    const format = "%x00%H%x09%an%x09%ae%x09%aI%x09%P%x09%s";
    const out = await this.git(
      [
        "log",
        "--all",
        `--since=${since.toISOString()}`,
        `--until=${until.toISOString()}`,
        "--numstat",
        `--pretty=format:${format}`,
      ],
      { cwd: mirrorDir },
    );
    const commits: RangeCommit[] = [];
    for (const record of out.split("\x00")) {
      const trimmed = record.replace(/^\n+/, "");
      if (trimmed.length === 0) continue;
      const [header, ...statLines] = trimmed.split("\n");
      const [sha, authorName, authorEmail, dateIso, parents, subject] = header.split("\t");
      let additions = 0;
      let deletions = 0;
      for (const line of statLines) {
        if (line.length === 0) continue;
        const [add, del] = line.split("\t");
        additions += add === "-" ? 0 : Number(add);
        deletions += del === "-" ? 0 : Number(del);
      }
      commits.push({
        sha: sha!,
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        date: dateIso ?? "",
        subject: subject ?? "",
        isMerge: (parents ?? "").trim().split(/\s+/).filter(Boolean).length > 1,
        additions,
        deletions,
      });
    }
    return commits;
  }
```

**Step 3: Scrivi il test** — crea un repo git reale in una tmp dir, committa con date/autori noti, monta come mirror, verifica finestra + numstat + esclusione merge. Segui il pattern del test dei mirror esistente (cerca `mirrors.test.ts` per il setup di un repo locale; se non c'è, crea `apps/worker/src/git/mirrors.test.ts` con `startTestDb` non necessario — serve solo git + fs tmp). Asserzioni minime:

```ts
it("getCommitsInRange filtra per finestra e somma numstat", async () => {
  // ... setup repo con 1 commit dentro e 1 fuori finestra
  const commits = await mirrors.getCommitsInRange(project, since, until);
  expect(commits).toHaveLength(1);
  expect(commits[0]!.authorEmail).toBe("dev@x.it");
  expect(commits[0]!.additions).toBeGreaterThan(0);
});
```

**Step 4: Verifica.**
Run: `pnpm --filter @stubwise/worker typecheck && pnpm --filter @stubwise/worker test src/git/mirrors.test.ts`
Expected: PASS.

**Step 5: Commit.**
```bash
git add apps/worker/src/git/mirrors.ts apps/worker/src/git/mirrors.test.ts
git commit -m "feat(worker): MirrorManager.getCommitsInRange (git log per finestra + numstat)"
```

---

## Fase 2 — API server: resolver + linking

### Task 3: Resolver `resolveUserByGitEmail`

**Files:**
- Modify: `apps/server/src/ingest/reporter.ts` (aggiungi funzione)
- Test: `apps/server/src/ingest/reporter.test.ts` (se esiste; altrimenti nuovo)

**Step 1: Test (case-insensitive, non associata → null).**

```ts
it("resolveUserByGitEmail: match case-insensitive via git_identities", async () => {
  const [u] = await db.insert(users).values({ email: `m-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning();
  await db.insert(gitIdentities).values({ userId: u!.id, email: "dev@x.it" });
  expect(await resolveUserByGitEmail(db, "DEV@X.it")).toBe(u!.id);
  expect(await resolveUserByGitEmail(db, "nope@x.it")).toBeNull();
});
```

**Step 2: Implementa** (in `reporter.ts`, sul modello di `resolveReporter`):

```ts
import { gitIdentities } from "@stubwise/db";

/**
 * Risolve il membro Stubwise a partire da un'email autore git (match
 * case-insensitive su git_identities.email). Ritorna lo userId, o null se
 * l'email non è associata ad alcun membro.
 */
export async function resolveUserByGitEmail(db: Db, email?: string | null): Promise<string | null> {
  if (!email) return null;
  const [row] = await db
    .select({ userId: gitIdentities.userId })
    .from(gitIdentities)
    .where(sql`lower(${gitIdentities.email}) = lower(${email})`)
    .limit(1);
  return row?.userId ?? null;
}
```

**Step 3: Verifica.** `pnpm --filter @stubwise/server test src/ingest/reporter.test.ts` → PASS.

**Step 4: Commit.**
```bash
git commit -am "feat(server): resolver resolveUserByGitEmail (email git -> membro)"
```

### Task 4: Route di linking git-identity + bitbucket + observed-authors

Nuovo plugin sul modello `slack/identity-routes.ts`, montato con `prefix: "/api"`.

**Files:**
- Create: `apps/server/src/routes/git-identity-routes.ts`
- Modify: `apps/server/src/app.ts` (registra il plugin dopo `slackIdentityRoutes`, ~:475)
- Test: `apps/server/src/routes/git-identity-routes.test.ts`

**Step 1: Scrivi i test** (pattern `identity-routes.test.ts` + `seedUsers`): 
- `POST /api/users/:id/git-identities` con `{ email }` → 200, ritorna l'utente con le sue identità; una seconda email → due identità.
- Email già di un altro membro → 409 `git_identity_taken`.
- `DELETE /api/users/:id/git-identities/:email` → 204; email inesistente → 404.
- `PUT /api/users/:id/bitbucket` `{ username }` → 200; username già preso → 409 `bitbucket_identity_taken`; utente assente → 404.
- `DELETE /api/users/:id/bitbucket` → 204.
- `GET /api/git/observed-authors` → lista da `git_authors_seen` con `linkedUserId`.
- member (non admin) → 403; non autenticato → 401 (su una mutation).

**Step 2: Implementa il plugin.** Struttura (requireAdmin, Zod, `isUniqueViolation` → 409):

```ts
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { gitAuthorsSeen, gitIdentities, users } from "@stubwise/db";
import { requireAdmin } from "../auth/session.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";

const gitIdentitySchema = z.object({ id: z.uuid(), email: z.string(), authorName: z.string().nullable() });
const observedAuthorSchema = z.object({
  email: z.string(),
  authorName: z.string().nullable(),
  lastSeenAt: z.iso.datetime(),
  linkedUserId: z.uuid().nullable(),
});

export async function gitIdentityRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  async function identitiesOf(userId: string) {
    const rows = await app.db
      .select({ id: gitIdentities.id, email: gitIdentities.email, authorName: gitIdentities.authorName })
      .from(gitIdentities)
      .where(eq(gitIdentities.userId, userId));
    return rows;
  }

  // POST /api/users/:id/git-identities — associa un'email git al membro.
  app.post(
    "/users/:id/git-identities",
    {
      preHandler: requireAdmin,
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ email: z.string().min(1), authorName: z.string().optional() }),
        response: { 200: z.array(gitIdentitySchema), 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const [existing] = await app.db.select({ id: users.id }).from(users).where(eq(users.id, id));
      if (!existing) return apiError(reply, 404, "user_not_found", "User not found");
      const email = request.body.email.trim().toLowerCase();
      try {
        await app.db.insert(gitIdentities).values({ userId: id, email, authorName: request.body.authorName ?? null });
      } catch (err) {
        if (isUniqueViolation(err)) {
          return apiError(reply, 409, "git_identity_taken", "This git email is already linked to a member");
        }
        throw err;
      }
      return reply.code(200).send(await identitiesOf(id));
    },
  );

  // DELETE /api/users/:id/git-identities/:email — rimuove un'associazione.
  app.delete(
    "/users/:id/git-identities/:email",
    {
      preHandler: requireAdmin,
      schema: {
        params: z.object({ id: z.uuid(), email: z.string() }),
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const email = decodeURIComponent(request.params.email).toLowerCase();
      const [deleted] = await app.db
        .delete(gitIdentities)
        .where(and(eq(gitIdentities.userId, request.params.id), eq(gitIdentities.email, email)))
        .returning({ id: gitIdentities.id });
      if (!deleted) return apiError(reply, 404, "git_identity_not_found", "Git identity not found");
      return reply.code(204).send(null);
    },
  );

  // PUT /api/users/:id/bitbucket — linka l'username Bitbucket (colonna singola).
  app.put(
    "/users/:id/bitbucket",
    {
      preHandler: requireAdmin,
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ username: z.string().min(1) }),
        response: { 200: z.object({ id: z.uuid(), bitbucketUsername: z.string().nullable() }), 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      let updated;
      try {
        [updated] = await app.db
          .update(users)
          .set({ bitbucketUsername: request.body.username })
          .where(eq(users.id, request.params.id))
          .returning({ id: users.id, bitbucketUsername: users.bitbucketUsername });
      } catch (err) {
        if (isUniqueViolation(err)) {
          return apiError(reply, 409, "bitbucket_identity_taken", "This Bitbucket username is already linked to another member");
        }
        throw err;
      }
      if (!updated) return apiError(reply, 404, "user_not_found", "User not found");
      return reply.code(200).send(updated);
    },
  );

  // DELETE /api/users/:id/bitbucket — scollega l'username Bitbucket.
  app.delete(
    "/users/:id/bitbucket",
    {
      preHandler: requireAdmin,
      schema: { params: z.object({ id: z.uuid() }), response: { 204: z.null(), 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const [updated] = await app.db
        .update(users)
        .set({ bitbucketUsername: null })
        .where(eq(users.id, request.params.id))
        .returning({ id: users.id });
      if (!updated) return apiError(reply, 404, "user_not_found", "User not found");
      return reply.code(204).send(null);
    },
  );

  // GET /api/git/observed-authors — email git viste nei repo, col link Stubwise.
  app.get(
    "/git/observed-authors",
    { preHandler: requireAdmin, schema: { response: { 200: z.array(observedAuthorSchema), ...authErrorResponses } } },
    async () => {
      const seen = await app.db.select().from(gitAuthorsSeen).orderBy(sql`${gitAuthorsSeen.lastSeenAt} desc`);
      const linked = await app.db
        .select({ email: gitIdentities.email, userId: gitIdentities.userId })
        .from(gitIdentities);
      const byEmail = new Map(linked.map((l) => [l.email, l.userId]));
      return seen.map((s) => ({
        email: s.email,
        authorName: s.authorName,
        lastSeenAt: s.lastSeenAt.toISOString(),
        linkedUserId: byEmail.get(s.email) ?? null,
      }));
    },
  );
}
```

**Step 3: Registra in `app.ts`** dopo il blocco `slackIdentityRoutes` (~:475):

```ts
  void app.register(gitIdentityRoutes, { prefix: "/api" });
```
(più l'import in cima: `import { gitIdentityRoutes } from "./routes/git-identity-routes.js";`)

**Step 4: Verifica.** `pnpm --filter @stubwise/server test src/routes/git-identity-routes.test.ts` → PASS.

**Step 5: Commit.**
```bash
git add apps/server/src/routes/git-identity-routes.ts apps/server/src/routes/git-identity-routes.test.ts apps/server/src/app.ts
git commit -m "feat(server): route linking identita git/bitbucket + observed-authors"
```

### Task 5: Route di lettura report `GET /api/activity`

Visibile a tutti i membri (`requireAuth`). Restituisce, per una data, entrambe le viste (per progetto + per-dev), risolvendo email→membro via `git_identities`.

**Files:**
- Create: `apps/server/src/routes/activity-routes.ts`
- Modify: `apps/server/src/app.ts` (register `prefix: "/api/activity"`)
- Test: `apps/server/src/routes/activity-routes.test.ts`

**Step 1: Test** — seed di `activity_reports` + `activity_report_entries` per una data, un'email associata a un membro e una no; asserisci che `GET /api/activity?date=2026-07-14` ritorni i blocchi per progetto e la vista per-dev con `resolvedUser` popolato solo per l'email associata. Non autenticato → 401.

**Step 2: Implementa.** Schema di risposta:

```ts
const entrySchema = z.object({
  gitEmail: z.string(),
  authorName: z.string().nullable(),
  resolvedUser: z.object({ id: z.uuid(), email: z.string(), avatarUrl: z.string().nullable() }).nullable(),
  commitCount: z.number(),
  additions: z.number(),
  deletions: z.number(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string(), repoId: z.string() })),
  aiSummary: z.string().nullable(),
});
```

Handler `GET /` con `querystring: z.object({ date: z.string() })`, `preHandler: requireAuth`. Query: join `activity_reports` (per la data) → `activity_report_entries`, più `projects` per i nomi e `git_identities`+`users` per risolvere gli autori. Costruisci due aggregazioni in memoria: `byProject` (progetto → entries) e `byDev` (resolvedUserId o gitEmail → entries su tutti i progetti). Ritorna `{ date, projects: [...], developers: [...] }`. Risoluzione: `Map<lowercase(email), {id,email,avatarUrl}>` da un'unica query `git_identities join users`.

**Step 3: Registra + import in `app.ts`:** `void app.register(activityRoutes, { prefix: "/api/activity" });`

**Step 4: Verifica.** `pnpm --filter @stubwise/server test src/routes/activity-routes.test.ts` → PASS.

**Step 5: Commit.**
```bash
git add apps/server/src/routes/activity-routes.ts apps/server/src/routes/activity-routes.test.ts apps/server/src/app.ts
git commit -m "feat(server): GET /api/activity (report attivita, viste per-progetto e per-dev)"
```

---

## Fase 3 — Worker: poller giornaliero

### Task 6: Config env

**Files:**
- Modify: `apps/worker/src/config.ts` (schema Zod + `WorkerConfig` + mapping)
- Modify: `.env.example`
- Test: `apps/worker/src/config.test.ts` (se esiste; aggiungi asserzioni sui default)

**Step 1: Aggiungi allo `envSchema`** (pattern `USAGE_POLL_MINUTES`):

```ts
  DAILY_REPORT_POLL_MINUTES: z.preprocess(
    emptyAsUndefined,
    z.coerce.number({ error: "deve essere un intero ≥ 0 in minuti (es. 15; 0 = disabilitato)" })
      .int().min(0).default(15),
  ),
  DAILY_REPORT_MAX_AUTHORS_PER_PROJECT: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1).default(25),
  ),
  DAILY_REPORT_RETENTION_DAYS: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1).default(90),
  ),
```

**Step 2: Aggiungi i campi a `WorkerConfig`** (`dailyReportPollMinutes: number;`, `dailyReportMaxAuthorsPerProject: number;`, `dailyReportRetentionDays: number;`) e il mapping in `loadWorkerConfig` (`dailyReportPollMinutes: parsed.DAILY_REPORT_POLL_MINUTES,` ecc.).

**Step 3: Aggiungi le tre env a `.env.example`** con commento.

**Step 4: Verifica + commit.**
Run: `pnpm --filter @stubwise/worker typecheck`
```bash
git commit -am "feat(worker): config env per il daily report poller"
```

### Task 7: Il poller e la generazione

**Files:**
- Create: `apps/worker/src/reports/daily-report-poller.ts`
- Modify: `apps/worker/src/index.ts` (import + avvio + log)
- Test: `apps/worker/src/reports/daily-report-poller.test.ts`

**Step 1: Test di `pollDailyReportsOnce`** (testcontainers, stub del runner e dei mirror; pattern `review/poller.test.ts`):
- Progetto con `dailyReportEnabled=true` e nessun report per ieri → crea un `activity_reports` `done` con entries derivate dai commit stub; gli autori finiscono in `git_authors_seen`.
- Progetto con `dailyReportEnabled=false` → nessun report.
- Report per ieri già presente → idempotente (nessun secondo report).
- Commit di merge esclusi dal conteggio (default).
- Oltre `maxAuthorsPerProject` → entries senza `aiSummary` per gli autori in eccesso (dati grezzi comunque presenti).

**Step 2: Implementa il poller.** Firma dipendenze + `pollDailyReportsOnce` + `startDailyReportPoller` (pattern `startLimitResumePoller`, `intervalMinutes`). Logica del gate e generazione:

```ts
export interface PollDailyReportsDeps {
  db: Db;
  mirrors: MirrorManager;
  runner: AgentRunner;
  encryptionKey: Buffer;
  serializer: ProjectSerializer;
  maxAuthorsPerProject: number;
  retentionDays: number;
  model?: string;
  agentTimeoutMs: number;
  /** Iniettabile nei test: "adesso". Default new Date(). */
  now?: () => Date;
}

/** Giorno UTC precedente a `now`, come [since, until) e stringa YYYY-MM-DD. */
function previousUtcDay(now: Date): { since: Date; until: Date; date: string } {
  const untilMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const until = new Date(untilMs);
  const since = new Date(untilMs - 24 * 60 * 60 * 1000);
  const date = since.toISOString().slice(0, 10);
  return { since, until, date };
}
```

`pollDailyReportsOnce`:
1. `const { since, until, date } = previousUtcDay((deps.now ?? (() => new Date()))());`
2. Seleziona i progetti con `dailyReportEnabled = true`.
3. Per ciascuno, dentro `deps.serializer.run(projectId, ...)`:
   a. Prova a inserire `activity_reports { projectId, date, status: 'running' }` con `.onConflictDoNothing()` sull'unique `(project_id, date)`; se nessuna riga inserita → già fatto, salta (idempotenza).
   b. In try/catch: per ogni repository del progetto, costruisci il `MirrorProject` (decifra le credenziali git col `encryptionKey` — riusa l'helper già usato da run-review: cerca `loadReviewContext`/`decrypt` in `apps/worker/src/review/run-review.ts` e replica il caricamento delle credenziali), chiama `deps.mirrors.getCommitsInRange(project, since, until)`.
   c. Aggrega i commit per `lowercase(authorEmail)` (escludi i merge dal conteggio di default): `{ authorName, commitCount, additions, deletions, repoIds:Set, commits:[] }`.
   d. Upsert in `git_authors_seen` ogni email vista (`onConflictDoUpdate` su `email` → aggiorna `lastSeenAt`, `authorName`).
   e. Per ogni autore (fino a `maxAuthorsPerProject`), lancia `deps.runner.run({ cwd, prompt, model, permissionMode: "plan", maxTurns, timeoutMs, provider })` con un prompt che elenca subject+numstat del giorno e chiede 2-4 righe di riassunto; `aiSummary = result.output.trim()`. Oltre il cap: entry senza summary + `log()` di quanti saltati. Se il run fallisce/limite: entry coi dati grezzi, `aiSummary=null` (best-effort, niente resume).
   f. Inserisci le `activity_report_entries`; aggiorna `activity_reports` a `status='done', finishedAt=now()`.
   g. In caso di errore non recuperabile: `status='failed', error=...` (best-effort, non propagare).
4. Retention: `DELETE FROM activity_reports WHERE date < now()::date - retentionDays` (cascade sulle entries).

`startDailyReportPoller` identico a `startLimitResumePoller` (flag `running`, `setInterval(..., intervalMinutes*60_000)`, `unref`, stop su `signal.abort`).

**Nota `cwd`/provider agente:** il riassunto NON richiede il checkout del codice (basta subject+numstat), ma `AgentRunner.run` vuole un `cwd` valido e un `provider` risolto. Riusa il pattern di `run-review.ts` per risolvere il provider (`loadProviderChain`/`loadProviderById`) e usa una tmp dir come `cwd` (o il mirror dir). Se preferisci dare all'agente accesso al repo per riassunti più ricchi, usa `mirrors.withWorktreeAtSha(project, headSha, ...)` con l'ultimo sha del giorno — ma per l'MVP resta su subject+numstat (più economico).

**Step 3: Avvia in `index.ts`** (dopo `startLimitResumePoller`, prima di `runWorker`):

```ts
startDailyReportPoller({
  db,
  mirrors,
  runner,
  encryptionKey: config.encryptionKey,
  serializer,
  maxAuthorsPerProject: config.dailyReportMaxAuthorsPerProject,
  retentionDays: config.dailyReportRetentionDays,
  model: config.prReviewModel,
  agentTimeoutMs: config.prReviewTimeoutMs,
  intervalMinutes: config.dailyReportPollMinutes,
  signal: controller.signal,
});
```
+ import in cima e un ramo nel log di avvio (`, daily-report ${config.dailyReportPollMinutes > 0 ? \`ogni ${config.dailyReportPollMinutes}'\` : "disabilitato"}`).

**Step 4: Verifica.** `pnpm --filter @stubwise/worker test src/reports/daily-report-poller.test.ts` → PASS.

**Step 5: Commit.**
```bash
git add apps/worker/src/reports apps/worker/src/index.ts
git commit -m "feat(worker): daily report poller (gate UTC, git log per autore, riassunto AI)"
```

---

## Fase 4 — Web: linking in /team

### Task 8: API client + queries per git/bitbucket

**Files:**
- Modify: `apps/web/src/lib/api.ts` (estendi la sezione `// --- Users ---`)
- Modify: `apps/web/src/lib/queries.ts` (nuovo `observedAuthorsQueryOptions`)

**Step 1: Estendi `PublicUser`/`TeamUser`** aggiungendo i campi che il server ora restituisce da `GET /api/users` (vedi Task 8b) — `bitbucketUsername: string | null;` e `gitIdentities: { id: string; email: string; authorName: string | null }[]`.

> **Task 8b (server, prerequisito):** estendi `publicUserSchema` e l'handler `GET /api/users` in `apps/server/src/routes/users.ts` per includere `bitbucketUsername` e le `gitIdentities` di ciascun utente (una query su `git_identities` mappata per userId, no N+1). Aggiorna `users.test.ts`. Commit separato: `feat(server): esponi gitIdentities e bitbucketUsername in GET /api/users`.

**Step 2: Aggiungi le funzioni API** (dopo `unlinkUserSlack`):

```ts
export interface ObservedAuthor {
  email: string;
  authorName: string | null;
  lastSeenAt: string;
  linkedUserId: string | null;
}
export function getObservedAuthors(): Promise<ObservedAuthor[]> {
  return api.get("/api/git/observed-authors");
}
export function linkGitIdentity(userId: string, email: string): Promise<TeamUser["gitIdentities"]> {
  return api.post(`/api/users/${encodeURIComponent(userId)}/git-identities`, { email });
}
export function unlinkGitIdentity(userId: string, email: string): Promise<void> {
  return request("DELETE", `/api/users/${encodeURIComponent(userId)}/git-identities/${encodeURIComponent(email)}`);
}
export function linkUserBitbucket(userId: string, username: string): Promise<{ id: string; bitbucketUsername: string | null }> {
  return api.put(`/api/users/${encodeURIComponent(userId)}/bitbucket`, { username });
}
export function unlinkUserBitbucket(userId: string): Promise<void> {
  return request("DELETE", `/api/users/${encodeURIComponent(userId)}/bitbucket`);
}
```

**Step 3: `observedAuthorsQueryOptions`** in `queries.ts` (pattern `slackWorkspaceUsersQueryOptions`, `retry: false`, `queryKey: ["git", "observed-authors"]`).

**Step 4: Verifica + commit.** `pnpm --filter @stubwise/web typecheck`
```bash
git commit -am "feat(web): API client per linking git/bitbucket + observed authors"
```

### Task 9: Estendi `MemberRow` in `/team`

**Files:**
- Modify: `apps/web/src/routes/team.tsx`
- Modify: `apps/web/src/i18n/locales/{en,it}.json` (chiavi `settings:team.*` e `errors.*` per i nuovi code)
- Modify: `apps/web/src/routes/team.test.tsx`

**Step 1: Test** (pattern esistente): renderizza `/team` con un membro, mocka `GET /api/git/observed-authors`; verifica badge `Git · N`, apertura picker, `POST .../git-identities`, comparsa dell'email, UNLINK; idem per Bitbucket (LINK/UNLINK, 409 → messaggio i18n `git_identity_taken`/`bitbucket_identity_taken`).

**Step 2: Implementa** una seconda riga di azioni in `MemberRow` accanto a quella Slack: un badge Git (`GIT · {n}` verde se `gitIdentities.length>0`) con picker che pesca da `observedAuthorsQueryOptions` (riusa la logica di `SlackPicker`: valuta di estrarre un `Picker` generico in `components/`, oppure duplica il pattern combobox), mutation `linkGitIdentity`/`unlinkGitIdentity` con `invalidate()` su `usersQueryOptions` + `observedAuthorsQueryOptions`; e un badge Bitbucket (`BITBUCKET · {username}`) con un piccolo input testo + `linkUserBitbucket`/`unlinkUserBitbucket`. Le azioni solo `isAdmin`. Errori via `translateApiError`.

**Step 3: i18n** — aggiungi chiavi in `en.json` e `it.json` (parità verificata da `parity.test.ts`): `team.gitLinked`, `team.gitNotLinked`, `team.linkGit`, `team.unlinkGit`, `team.bitbucketLinkedTo`, `team.linkBitbucket`, ecc., e i messaggi errore per `git_identity_taken`, `bitbucket_identity_taken`, `git_identity_not_found` nel namespace `errors`.

**Step 4: Verifica + commit.**
Run: `pnpm --filter @stubwise/web test src/routes/team.test.tsx && pnpm --filter @stubwise/web test src/i18n/parity.test.ts`
```bash
git add apps/web/src/routes/team.tsx apps/web/src/routes/team.test.tsx apps/web/src/i18n
git commit -m "feat(web): linking identita git/bitbucket nella pagina Team"
```

---

## Fase 5 — Web: sezione Attività

### Task 10: API client + query per i report

**Files:**
- Modify: `apps/web/src/lib/api.ts` (tipi + `getActivity(date)`)
- Modify: `apps/web/src/lib/queries.ts` (`activityReportQueryOptions(date)`)

**Step 1:** definisci i tipi `ActivityReport`, `ActivityEntry` (speculari allo schema Zod del server), `getActivity(date: string): Promise<ActivityReport>` → `api.get(\`/api/activity?date=${date}\`)`. `activityReportQueryOptions(date)` come funzione parametrizzata (pattern `serversQueryOptions`), `queryKey: ["activity", date]`.

**Step 2: Verifica + commit.** `pnpm --filter @stubwise/web typecheck`
```bash
git commit -am "feat(web): API client + query per i report attivita"
```

### Task 11: La pagina, la route e la voce di nav

**Files:**
- Create: `apps/web/src/routes/activity.tsx` (esporta `ActivityPage`)
- Modify: `apps/web/src/router.tsx` (import + `createRoute` + `addChildren`)
- Modify: `apps/web/src/components/app-layout.tsx` (`NAV_ITEMS`)
- Modify: `apps/web/src/i18n/locales/{en,it}.json` (`common:nav.activity` + namespace pagina)
- Test: `apps/web/src/routes/activity.test.tsx`

**Step 1: Test** (pattern `team.test.tsx`): monta `/activity`, mocka `GET /api/auth/me` e `GET /api/activity?date=...`; verifica la vista per-progetto (blocchi progetto, autore col nome del membro risolto o email grezza, riassunto AI, commit) e lo switch alla vista per-dev; il selettore data cambia la query.

**Step 2: Implementa `ActivityPage`**: selettore data (default: ieri, calcolato UTC), due tab (`project` | `dev`) in `useState`, `useSuspenseQuery(activityReportQueryOptions(date))`. Rendering coerente con l'estetica terminal (riusa `Avatar`, `formatDate`). Email non risolta in corsivo + hint "associa in Team" (`Link to="/team"`) se admin.

**Step 3: Route** in `router.tsx` (template `teamRoute`):
```tsx
const activityRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/activity",
  component: ActivityPage,
});
```
+ import `ActivityPage` e aggiunta in `authedRoute.addChildren([... activityRoute ...])`.

**Step 4: Nav** — aggiungi a `NAV_ITEMS`: `{ to: "/activity", labelKey: "common:nav.activity", code: "ACT" }` + chiavi i18n `nav.activity` in en/it.

**Step 5: Verifica + commit.**
Run: `pnpm --filter @stubwise/web test src/routes/activity.test.tsx`
```bash
git add apps/web/src/routes/activity.tsx apps/web/src/router.tsx apps/web/src/components/app-layout.tsx apps/web/src/i18n
git commit -m "feat(web): sezione Attivita (viste per-progetto e per-dev)"
```

### Task 12: Toggle `dailyReportEnabled` nel dettaglio progetto

**Files:**
- Modify: `apps/server/src/routes/projects.ts` (esponi/aggiorna il campo nel PATCH progetto — cerca il pattern degli altri toggle booleani)
- Modify: `apps/web/src/routes/...` (dettaglio progetto: aggiungi lo switch, riusa il pattern dei toggle esistenti)
- Test: aggiorna i test progetto lato server + web

**Step 1-5:** TDD come sopra (test del PATCH che accetta `dailyReportEnabled`; test UI dello switch). Commit: `feat: toggle dailyReportEnabled per progetto`.

---

## Fase 6 — Verifica finale

### Task 13: Typecheck, lint, test, build su tutto il monorepo

**Step 1:** `pnpm typecheck` → 0 errori.
**Step 2:** `pnpm lint` → 0 errori (CLAUDE.md: la CI fallisce su lint anche con typecheck+test verdi).
**Step 3:** `pnpm test` → verde (testcontainers: richiede Docker; se flaky per Postgres concorrenti, rilancia i package singoli).
**Step 4:** `pnpm build` → ok.
**Step 5:** E2E Playwright per la UI nuova (non girano in `pnpm -r test`): `pnpm --filter @stubwise/web e2e` a mano per `/activity` e `/team`.
**Step 6:** aggiorna `docs/plans/2026-07-15-daily-activity-report-design.md` con eventuali scostamenti e la memoria `MEMORY.md`.

**Deploy (CLAUDE.md):**
- Backend (nuove route, poller, migrazioni): ribuilda `server` e `worker`.
- Frontend (`/activity` + `/team`): ribuilda `caddy`.
- Nuove env in `/opt/stubwise/.env`: `DAILY_REPORT_POLL_MINUTES`, `DAILY_REPORT_MAX_AUTHORS_PER_PROJECT`, `DAILY_REPORT_RETENTION_DAYS`.
- ⚠️ Riavvio worker: verifica prima `select id from doc_generations where status in ('running','paused')` vuoto (invariante fail-on-restart).
- Abilita `dailyReportEnabled` sui progetti desiderati; associa le email git in `/team`.

---

## Note trasversali

- **Best-effort ovunque nel poller**: ogni progetto in try/catch isolato, il tick non propaga mai (pattern `review/poller.ts`).
- **Niente resume sul limite provider** per i summary (MVP): entry coi dati grezzi, `aiSummary=null`.
- **UTC** per il giorno del report (coerente con i cap giornalieri già in UTC).
- **Merge/bot**: default esclude i merge dal conteggio; il filtro bot (email `*@users.noreply`, dependabot) è un'estensione a valle configurabile — per l'MVP basta l'esclusione merge.
- **DRY**: valuta di estrarre un componente `Picker` generico da `SlackPicker` se il combobox git risulta un duplicato 1:1.
