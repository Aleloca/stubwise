import { aiJobs, encrypt, projects, tickets, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "./agent/fake.js";
import type { AgentRunOptions } from "./agent/runner.js";
import { MirrorManager } from "./git/mirrors.js";
import { createHandler } from "./handler.js";
import { claimNextJob, type AiJob } from "./queue.js";

// E2E del wiring: job `queued` reclamato → handler → triage (decisione fix)
// → fase di fix con push e PR finta. Più i test della serializzazione
// per-progetto (due job dello stesso progetto non devono mai sovrapporsi:
// il fetch --prune di un job cancellerebbe i ref stubwise/* dell'altro).

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let uniq = 0;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects);
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

async function makeUpstream(): Promise<{ dir: string; url: string }> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-handler-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "upstream.git");
  await execa("git", ["init", "--bare", "-b", "main", dir]);
  const work = join(root, "seed-work");
  await execa("git", ["init", "-b", "main", work]);
  await git(["remote", "add", "origin", dir], work);
  await writeFile(join(work, "app.js"), "exports.sum = (a, b) => a - b;\n");
  await git(["add", "."], work);
  await git(["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-m", "seed"], work);
  await git(["push", "origin", "main"], work);
  return { dir, url: pathToFileURL(dir).href };
}

async function makeMirrors(): Promise<MirrorManager> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-handler-mirrors-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return new MirrorManager({ mirrorsDir: join(root, "mirrors") });
}

async function createProject(db: Db, repoUrl: string): Promise<string> {
  uniq++;
  const [project] = await db
    .insert(projects)
    .values({
      name: `Handler ${uniq}`,
      slug: `handler-${uniq}`,
      provider: "github",
      repoUrl,
      defaultBranch: "main",
      encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), ENCRYPTION_KEY),
      ingestionKey: `ingestion-handler-${uniq}`,
    })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  return project.id;
}

async function createQueuedJob(db: Db, projectId: string, title: string, number: number): Promise<string> {
  const [ticket] = await db
    .insert(tickets)
    .values({ projectId, number, title, type: "bug", priority: "high", source: "sdk_error" })
    .returning();
  if (!ticket) throw new Error("insert del ticket non ha restituito la riga");
  const [job] = await db.insert(aiJobs).values({ ticketId: ticket.id }).returning();
  if (!job) throw new Error("insert del job non ha restituito la riga");
  return ticket.id;
}

async function claim(db: Db): Promise<AiJob> {
  const job = await claimNextJob(db);
  if (!job) throw new Error("nessun job in coda da reclamare");
  return job;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createHandler", () => {
  it("e2e: job queued → triage decide fix → fase di fix con PR aperta", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, upstream.url);
    const ticketId = await createQueuedJob(db, projectId, "sum sbaglia il segno", 3);

    const REPORT = "## Processo di indagine\nok\n## Causa radice\nok\n## Soluzione\nok\n## Motivazione\nok\n";
    const runner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) => {
        if (opts.model === "haiku") {
          // Fase di triage: nessun file, solo la decisione.
          return { output: `{"decision":"fix","type":"bug","effort":3}`, exitCode: 0 };
        }
        // Fase di fix: scrive il "diff" e il report nel worktree.
        await writeFile(join(opts.cwd, "app.js"), "exports.sum = (a, b) => a + b;\n");
        await writeFile(join(opts.cwd, "STUBWISE_REPORT.md"), REPORT);
        return { output: "fix applicato", exitCode: 0 };
      },
    });
    const openPullRequest = vi.fn().mockResolvedValue({ url: "https://github.com/acme/repo/pull/5" });

    const handler = createHandler({
      db,
      runner,
      mirrors,
      encryptionKey: ENCRYPTION_KEY,
      getProviderFn: () => ({ openPullRequest }) as never,
    });

    const job = await claim(db);
    await handler(job);

    // Triage (haiku) + fix in DUE FASI (plan opus, execute sonnet): TRE
    // chiamate al runner, in quest'ordine.
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[0]?.model).toBe("haiku");
    expect(runner.calls[1]?.model).toBe("opus");
    expect(runner.calls[1]?.permissionMode).toBe("plan");
    expect(runner.calls[2]?.model).toBe("sonnet");
    expect(runner.calls[2]?.permissionMode).toBe("acceptEdits");

    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("pr_opened");
    expect(jobAfter?.prUrl).toBe("https://github.com/acme/repo/pull/5");
    const [ticketAfter] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticketAfter?.status).toBe("in_review");
    // Il branch è davvero arrivato sull'origin di test.
    expect(await git(["branch", "--list", "stubwise/ticket-3"], upstream.dir)).toContain("stubwise/ticket-3");
    expect(openPullRequest).toHaveBeenCalledTimes(1);
  });

  it("decisione skip → la fase di fix non parte (runner chiamato una sola volta)", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, "https://github.com/acme/mai-clonato");
    await createQueuedJob(db, projectId, "ticket vago", 1);

    const runner = new FakeAgentRunner({
      output: `{"decision":"skip","type":"bug","effort":1,"reason":"troppo vago"}`,
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY });

    const job = await claim(db);
    await handler(job);

    expect(runner.calls).toHaveLength(1);
    const [jobAfter] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(jobAfter?.status).toBe("skipped");
  });

  it("serializza i job dello STESSO progetto: il secondo parte solo dopo la fine del primo", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, "https://github.com/acme/seriale");
    await createQueuedJob(db, projectId, "primo job", 1);
    await createQueuedJob(db, projectId, "secondo job", 2);

    const windows: Array<{ title: string; start: number; end: number }> = [];
    const runner = new FakeAgentRunner({
      script: async (opts: AgentRunOptions) => {
        const title = /Title: (.*)\n/.exec(opts.prompt)?.[1] ?? "?";
        const start = Date.now();
        await sleep(300);
        windows.push({ title, start, end: Date.now() });
        return {
          output: `{"decision":"skip","type":"bug","effort":1,"reason":"test di serializzazione"}`,
          exitCode: 0,
        };
      },
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY });

    const job1 = await claim(db);
    const job2 = await claim(db);
    // Lanciati INSIEME, come farebbe runWorker con concurrency 2.
    await Promise.all([handler(job1), handler(job2)]);

    expect(windows).toHaveLength(2);
    const [first, second] = [...windows].sort((a, b) => a.start - b.start) as [
      (typeof windows)[number],
      (typeof windows)[number],
    ];
    // Nessuna sovrapposizione: il secondo inizia dopo la fine del primo.
    expect(second.start).toBeGreaterThanOrEqual(first.end);
  });

  it("NON serializza job di progetti DIVERSI: le esecuzioni si sovrappongono", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const projectA = await createProject(db, "https://github.com/acme/parallelo-a");
    const projectB = await createProject(db, "https://github.com/acme/parallelo-b");
    await createQueuedJob(db, projectA, "job progetto A", 1);
    await createQueuedJob(db, projectB, "job progetto B", 1);

    const windows: Array<{ start: number; end: number }> = [];
    const runner = new FakeAgentRunner({
      script: async () => {
        const start = Date.now();
        await sleep(300);
        windows.push({ start, end: Date.now() });
        return {
          output: `{"decision":"skip","type":"bug","effort":1,"reason":"test di parallelismo"}`,
          exitCode: 0,
        };
      },
    });
    const handler = createHandler({ db, runner, mirrors, encryptionKey: ENCRYPTION_KEY });

    const job1 = await claim(db);
    const job2 = await claim(db);
    await Promise.all([handler(job1), handler(job2)]);

    expect(windows).toHaveLength(2);
    const [first, second] = [...windows].sort((a, b) => a.start - b.start) as [
      (typeof windows)[number],
      (typeof windows)[number],
    ];
    // Sovrapposizione: il secondo è partito PRIMA che il primo finisse.
    expect(second.start).toBeLessThan(first.end);
  });
});
