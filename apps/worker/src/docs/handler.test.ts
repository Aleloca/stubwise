import {
  aiJobs,
  docGenerationJobs,
  encrypt,
  gitAccounts,
  projects,
  tickets,
  type Db,
} from "@stubwise/db";
import { seedGitAccount, startTestDb, type TestDb } from "@stubwise/db/testing";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { eq } from "drizzle-orm";
import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "../agent/fake.js";
import { MirrorManager } from "../git/mirrors.js";
import { createProjectSerializer } from "../handler.js";
import { runWorker } from "../queue.js";
import { createDocHandler, failDocJobOnError } from "./handler.js";

// Test del wiring del loop doc-generation (Task 5.4): un doc-job `queued`
// reclamato dal loop → createDocHandler → runDocGenerationJob fino a
// `succeeded`. Più la serializzazione CONDIVISA doc↔fix (stesso progetto =
// nessuna sovrapposizione) e la politica di priorità (i fix per primi).

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let uniq = 0;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects);
  await testDb.db.delete(gitAccounts);
});

afterAll(async () => {
  await testDb.stop();
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout;
}

/** Mirror bare locale con un manifest + un file sorgente (un modulo TS). */
async function makeUpstream(): Promise<{ dir: string; url: string }> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-dochandler-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "upstream.git");
  await execa("git", ["init", "--bare", "-b", "main", dir]);
  const work = join(root, "seed-work");
  await execa("git", ["init", "-b", "main", work]);
  await git(["remote", "add", "origin", dir], work);
  await writeFile(join(work, "package.json"), JSON.stringify({ name: "demo" }) + "\n");
  await writeFile(join(work, "index.ts"), "export function hello() { return 'hi'; }\n");
  await git(["add", "."], work);
  await git(
    ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-m", "seed"],
    work,
  );
  await git(["push", "origin", "main"], work);
  return { dir, url: pathToFileURL(dir).href };
}

async function makeMirrors(): Promise<MirrorManager> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-dochandler-mirrors-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return new MirrorManager({ mirrorsDir: join(root, "mirrors") });
}

async function createProject(db: Db, repoUrl: string): Promise<string> {
  uniq++;
  const gitAccountId = await seedGitAccount(db, {
    provider: "github",
    encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), ENCRYPTION_KEY),
  });
  const [project] = await db
    .insert(projects)
    .values({
      name: `DocHandler ${uniq}`,
      slug: `dochandler-${uniq}`,
      provider: "github",
      gitAccountId,
      repoUrl,
      defaultBranch: "main",
      ingestionKey: `ingestion-dochandler-${uniq}`,
    })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  return project.id;
}

/** Output map/reduce valido: due sezioni delimitate dai marker. */
function agentOutput(): string {
  return [
    "===TECHNICAL===",
    "## Technical",
    "This module does technical things with enough words to chunk meaningfully.",
    "===FUNCTIONAL===",
    "## Capability: Greeting",
    "It greets users in plain language so anyone can understand the value.",
  ].join("\n");
}

function docDeps(db: Db, mirrors: MirrorManager, runner: FakeAgentRunner) {
  return {
    db,
    runner,
    mirrors,
    embeddingClient: createFakeEmbeddingClient(),
    encryptionKey: ENCRYPTION_KEY,
    model: "opus",
    maxModules: 80,
    moduleMaxTurns: 30,
    agentTimeoutMs: 600_000,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("loop doc-generation (Task 5.4)", () => {
  it("reclama un doc-job queued dal loop e lo porta a succeeded", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, upstream.url);
    const [docJob] = await db
      .insert(docGenerationJobs)
      .values({ projectId, status: "queued" })
      .returning();
    if (!docJob) throw new Error("insert del doc-job non ha restituito la riga");

    const runner = new FakeAgentRunner({
      script: () => ({ output: agentOutput(), exitCode: 0 }),
    });
    const serializer = createProjectSerializer();
    const docHandler = createDocHandler(docDeps(db, mirrors, runner), serializer);

    const controller = new AbortController();
    const worker = runWorker({
      db,
      // Fix handler innocuo: nessun fix in coda, non viene mai invocato.
      handler: async () => {},
      docHandler,
      docHandlerOnError: failDocJobOnError,
      pollMs: 20,
      signal: controller.signal,
    });

    await vi.waitFor(
      async () => {
        const [j] = await db
          .select()
          .from(docGenerationJobs)
          .where(eq(docGenerationJobs.id, docJob.id));
        expect(j?.status).toBe("succeeded");
      },
      { timeout: 30_000 },
    );
    controller.abort();
    await worker;

    const [j] = await db
      .select()
      .from(docGenerationJobs)
      .where(eq(docGenerationJobs.id, docJob.id));
    expect(j?.status).toBe("succeeded");
    expect(j?.generationId).not.toBeNull();
    // Lo swap del puntatore corrente è avvenuto.
    const [proj] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(proj?.currentDocGenerationId).toBe(j?.generationId);
    // permissionMode "plan" (read-only) su ogni run dell'agent.
    expect(runner.calls.every((c) => c.permissionMode === "plan")).toBe(true);
  });

  it("serializza un doc-job e un fix-job dello STESSO progetto (serializer condiviso)", async () => {
    const { db } = testDb;
    // Repo mai clonato: il fix e il doc-job non arrivano al mirror, ma la
    // serializzazione si misura PRIMA (le due esecuzioni non si sovrappongono).
    const projectId = await createProject(db, "https://github.com/acme/mai-clonato");

    const windows: Array<{ kind: string; start: number; end: number }> = [];
    const record = async (kind: string): Promise<void> => {
      const start = Date.now();
      await sleep(300);
      windows.push({ kind, start, end: Date.now() });
    };

    // Serializer CONDIVISO: è ciò che index.ts passa a entrambi gli handler.
    const serializer = createProjectSerializer();

    // Fix handler finto che registra la sua finestra (niente triage/mirror reale).
    const fixHandler = (async (job: typeof aiJobs.$inferSelect) => {
      // projectId del fix: stesso del doc-job → stessa catena.
      void job;
      await serializer.run(projectId, () => record("fix"));
    }) as (job: typeof aiJobs.$inferSelect) => Promise<void>;

    // Doc handler finto che registra la sua finestra sulla STESSA catena.
    const docHandler = (async (job: typeof docGenerationJobs.$inferSelect) => {
      void job;
      await serializer.run(projectId, () => record("doc"));
    }) as (job: typeof docGenerationJobs.$inferSelect) => Promise<void>;

    // Inseriamo un fix-job e un doc-job e li lanciamo insieme, come farebbe il loop.
    const [ticket] = await db
      .insert(tickets)
      .values({ projectId, number: 1, title: "bug", type: "bug", priority: "high", source: "sdk_error" })
      .returning();
    const [fixJob] = await db.insert(aiJobs).values({ ticketId: ticket!.id }).returning();
    const [docJob] = await db
      .insert(docGenerationJobs)
      .values({ projectId, status: "running", startedAt: new Date() })
      .returning();

    await Promise.all([fixHandler(fixJob!), docHandler(docJob!)]);

    expect(windows).toHaveLength(2);
    const [first, second] = [...windows].sort((a, b) => a.start - b.start) as [
      (typeof windows)[number],
      (typeof windows)[number],
    ];
    // NESSUNA sovrapposizione: il secondo inizia solo dopo la fine del primo.
    expect(second.start).toBeGreaterThanOrEqual(first.end);
  });

  it("priorità: con un fix e un doc-job in coda, il fix parte e il doc-job NON in quel tick", async () => {
    const { db } = testDb;
    const projectIdFix = await createProject(db, "https://github.com/acme/fix-prio");
    const projectIdDoc = await createProject(db, "https://github.com/acme/doc-prio");

    // Un fix-job queued (progetto A) e un doc-job queued (progetto B): progetti
    // diversi, così la priorità NON è confusa dalla serializzazione.
    const [ticket] = await db
      .insert(tickets)
      .values({
        projectId: projectIdFix,
        number: 1,
        title: "bug",
        type: "bug",
        priority: "high",
        source: "sdk_error",
      })
      .returning();
    await db.insert(aiJobs).values({ ticketId: ticket!.id });
    const [docJob] = await db
      .insert(docGenerationJobs)
      .values({ projectId: projectIdDoc, status: "queued" })
      .returning();

    const order: string[] = [];
    const controller = new AbortController();
    const worker = runWorker({
      db,
      concurrency: 1, // un solo slot: forza la scelta fix-vs-doc nello stesso tick.
      pollMs: 20,
      signal: controller.signal,
      handler: async (job) => {
        order.push("fix");
        await db
          .update(aiJobs)
          .set({ status: "skipped", finishedAt: new Date() })
          .where(eq(aiJobs.id, job.id));
        // Tiene occupato lo slot abbastanza da poter osservare che il doc-job
        // non è partito nello stesso tick.
        await sleep(200);
      },
      docHandler: async (job) => {
        order.push("doc");
        await db
          .update(docGenerationJobs)
          .set({ status: "succeeded", finishedAt: new Date() })
          .where(eq(docGenerationJobs.id, job.id));
      },
      docHandlerOnError: failDocJobOnError,
    });

    await vi.waitFor(
      async () => {
        const [j] = await db
          .select()
          .from(docGenerationJobs)
          .where(eq(docGenerationJobs.id, docJob!.id));
        expect(j?.status).toBe("succeeded");
      },
      { timeout: 15_000 },
    );
    controller.abort();
    await worker;

    // Il fix è stato dispatchato PRIMA del doc-job (priorità ai fix).
    expect(order[0]).toBe("fix");
    expect(order).toContain("doc");
  });
});
