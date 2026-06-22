import {
  docChunks,
  docGenerationJobs,
  docGenerations,
  docPages,
  encrypt,
  gitAccounts,
  projects,
  type Db,
} from "@stubwise/db";
import { seedGitAccount, startTestDb, type TestDb } from "@stubwise/db/testing";
import { createFakeEmbeddingClient, FAKE_EMBEDDING_DIMENSION } from "@stubwise/embeddings";
import { eq } from "drizzle-orm";
import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "../agent/fake.js";
import type { AgentRunOptions, AgentRunUsage } from "../agent/runner.js";
import { MirrorManager } from "../git/mirrors.js";
import { runDocGenerationJob, type RunDocGenerationDeps } from "./pipeline.js";
import { type DocJob } from "./queue.js";

// Test end-to-end della pipeline di doc-generation: un mirror bare locale come
// "upstream" (pattern handler.test.ts), un FakeAgentRunner scriptato a produrre
// output ===TECHNICAL===/===FUNCTIONAL=== validi, un fake embedding client. Si
// asseriscono: generazione succeeded + commitSha + costo, pagine + chunk con
// embedding 1024-dim, swap del puntatore corrente, prune, best-effort, heartbeat.

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
  const root = await mkdtemp(join(tmpdir(), "stubwise-docs-test-"));
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
  const root = await mkdtemp(join(tmpdir(), "stubwise-docs-mirrors-"));
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
      name: `Docs ${uniq}`,
      slug: `docs-${uniq}`,
      provider: "github",
      gitAccountId,
      repoUrl,
      defaultBranch: "main",
      ingestionKey: `ingestion-docs-${uniq}`,
    })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  return project.id;
}

async function enqueueDocJob(db: Db, projectId: string): Promise<DocJob> {
  const [job] = await db
    .insert(docGenerationJobs)
    .values({ projectId, status: "running", startedAt: new Date() })
    .returning();
  if (!job) throw new Error("insert del doc-job non ha restituito la riga");
  return job;
}

/** Output map/reduce valido: due sezioni delimitate dai marker. */
function agentOutput(label: string): string {
  return [
    "===TECHNICAL===",
    `## Technical ${label}`,
    "This module does technical things with enough words to chunk meaningfully.",
    "===FUNCTIONAL===",
    "## Capability: Greeting",
    "It greets users in plain language so anyone can understand the value.",
  ].join("\n");
}

const USAGE: AgentRunUsage = { totalCostUsd: 0.01, models: [] };

function baseDeps(
  db: Db,
  mirrors: MirrorManager,
  runner: FakeAgentRunner,
): RunDocGenerationDeps {
  return {
    db,
    mirrors,
    runner,
    embeddingClient: createFakeEmbeddingClient(),
    encryptionKey: ENCRYPTION_KEY,
    model: "opus",
    maxModules: 80,
    moduleMaxTurns: 30,
    agentTimeoutMs: 600_000,
  };
}

describe("runDocGenerationJob", () => {
  it("genera, persiste pagine + chunk con embedding, fa lo swap e completa il job", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, upstream.url);
    const job = await enqueueDocJob(db, projectId);

    const runner = new FakeAgentRunner({
      script: (opts: AgentRunOptions) => ({ output: agentOutput(opts.prompt.slice(0, 8)), exitCode: 0, usage: USAGE }),
    });
    // permissionMode "plan" (read-only) deve essere passato a ogni run.
    const outcome = await runDocGenerationJob(baseDeps(db, mirrors, runner), job);
    expect(outcome).toBe("succeeded");
    expect(runner.calls.every((c) => c.permissionMode === "plan")).toBe(true);
    expect(runner.calls.every((c) => c.model === "opus")).toBe(true);

    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.projectId, projectId));
    expect(gen?.status).toBe("succeeded");
    expect(gen?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(gen?.model).toBe("opus");
    // Costo aggregato = somma dei totalCostUsd di ogni run (≥ 2 run: map + reduce).
    expect(Number(gen?.cost)).toBeCloseTo(runner.calls.length * 0.01, 6);
    const stats = gen?.stats as { pages: number; chunks: number; modules: number };
    expect(stats.pages).toBeGreaterThan(0);
    expect(stats.chunks).toBeGreaterThan(0);

    const pages = await db.select().from(docPages).where(eq(docPages.generationId, gen!.id));
    // Almeno overview tecnica + un modulo + mappa funzionale + una capability.
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.some((p) => p.kind === "technical" && p.parentId === null)).toBe(true);
    expect(pages.some((p) => p.kind === "functional")).toBe(true);
    // parentId risolto (nessun orfano fra le figlie): ogni pagina con parent ha un id valido.
    const ids = new Set(pages.map((p) => p.id));
    expect(pages.filter((p) => p.parentId !== null).every((p) => ids.has(p.parentId!))).toBe(true);

    const chunks = await db.select().from(docChunks).where(eq(docChunks.generationId, gen!.id));
    expect(chunks.length).toBe(stats.chunks);
    expect(chunks[0]?.embedding?.length).toBe(FAKE_EMBEDDING_DIMENSION);
    expect((chunks[0]?.metadata as { layer?: string }).layer).toBeTruthy();

    // SWAP: il puntatore corrente del progetto è la nuova generazione.
    const [projAfter] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(projAfter?.currentDocGenerationId).toBe(gen!.id);

    // Job succeeded + collegato alla generazione.
    const [jobAfter] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, job.id));
    expect(jobAfter?.status).toBe("succeeded");
    expect(jobAfter?.generationId).toBe(gen!.id);
  });

  it("pruna le generazioni oltre corrente + precedente (cascade su pagine/chunk)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, upstream.url);

    // Due generazioni vecchie già succeeded (la più vecchia verrà prunata).
    const [oldest] = await db
      .insert(docGenerations)
      .values({ projectId, status: "succeeded", createdAt: new Date(Date.now() - 20_000) })
      .returning();
    const [previous] = await db
      .insert(docGenerations)
      .values({ projectId, status: "succeeded", createdAt: new Date(Date.now() - 10_000) })
      .returning();
    // Una pagina nella più vecchia, per verificare la cascade.
    await db.insert(docPages).values({
      projectId,
      generationId: oldest!.id,
      kind: "technical",
      slug: "old-page",
      title: "Old",
    });

    const job = await enqueueDocJob(db, projectId);
    const runner = new FakeAgentRunner({
      script: () => ({ output: agentOutput("x"), exitCode: 0, usage: USAGE }),
    });
    await runDocGenerationJob(baseDeps(db, mirrors, runner), job);

    const remaining = await db.select().from(docGenerations).where(eq(docGenerations.projectId, projectId));
    const ids = new Set(remaining.map((g) => g.id));
    // La nuova + la precedente restano; la più vecchia è prunata.
    expect(ids.has(previous!.id)).toBe(true);
    expect(ids.has(oldest!.id)).toBe(false);
    expect(remaining.length).toBe(2);
    // Cascade: la pagina della generazione prunata è sparita.
    const orphan = await db.select().from(docPages).where(eq(docPages.generationId, oldest!.id));
    expect(orphan.length).toBe(0);
  });

  it("best-effort: un modulo che fa throw non aborta la generazione (succeeded, failure registrato)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, upstream.url);
    const job = await enqueueDocJob(db, projectId);

    let mapCall = 0;
    const runner = new FakeAgentRunner({
      script: (opts: AgentRunOptions) => {
        // Il reduce contiene "REDUCE step"; i map sono i prompt di modulo.
        const isReduce = opts.prompt.includes("REDUCE step");
        if (!isReduce) {
          mapCall += 1;
          if (mapCall === 1) throw new Error("agent boom sul primo modulo");
        }
        return { output: agentOutput("ok"), exitCode: 0, usage: USAGE };
      },
    });
    const outcome = await runDocGenerationJob(baseDeps(db, mirrors, runner), job);
    expect(outcome).toBe("succeeded");

    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.projectId, projectId));
    expect(gen?.status).toBe("succeeded");
    const stats = gen?.stats as { moduleFailures: string[] };
    expect(stats.moduleFailures.length).toBeGreaterThanOrEqual(1);
  });

  it("cap di costo superato: generazione failed, job held (no swap), nessun cap silenzioso", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, upstream.url);
    const job = await enqueueDocJob(db, projectId);

    const runner = new FakeAgentRunner({
      script: () => ({ output: agentOutput("x"), exitCode: 0, usage: { totalCostUsd: 5, models: [] } }),
    });
    const outcome = await runDocGenerationJob(
      { ...baseDeps(db, mirrors, runner), costCapUsd: 0.5 },
      job,
    );
    expect(outcome).toBe("held");

    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.projectId, projectId));
    expect(gen?.status).toBe("failed");
    expect(gen?.error).toMatch(/tetto/);
    // NESSUNO swap: il puntatore resta null.
    const [projAfter] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(projAfter?.currentDocGenerationId).toBeNull();
    const [jobAfter] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, job.id));
    expect(jobAfter?.status).toBe("held");
  });

  it("heartbeat: touchDocJob avanza lastActivityAt durante la generazione", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, upstream.url);
    // lastActivityAt nel passato per misurare l'avanzamento.
    const past = new Date(Date.now() - 60_000);
    const [job] = await db
      .insert(docGenerationJobs)
      .values({ projectId, status: "running", startedAt: past, lastActivityAt: past })
      .returning();

    const runner = new FakeAgentRunner({
      script: () => ({ output: agentOutput("x"), exitCode: 0, usage: USAGE }),
    });
    await runDocGenerationJob(baseDeps(db, mirrors, runner), job!);

    const [jobAfter] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, job!.id));
    expect(jobAfter!.lastActivityAt.getTime()).toBeGreaterThan(past.getTime());
  });

  it("errore (credenziali non decifrabili): generazione non avviata, job failed, no swap", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    // Account con credenziali cifrate da una chiave DIVERSA: decrypt fallisce.
    const otherKey = randomBytes(32);
    uniq++;
    const gitAccountId = await seedGitAccount(db, {
      provider: "github",
      encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), otherKey),
    });
    const [project] = await db
      .insert(projects)
      .values({
        name: `Docs ${uniq}`,
        slug: `docs-${uniq}`,
        provider: "github",
        gitAccountId,
        repoUrl: "https://github.com/acme/mai-clonato",
        defaultBranch: "main",
        ingestionKey: `ingestion-docs-${uniq}`,
      })
      .returning();
    const job = await enqueueDocJob(db, project!.id);

    const runner = new FakeAgentRunner({ output: "non dovrei girare" });
    const outcome = await runDocGenerationJob(baseDeps(db, mirrors, runner), job);
    expect(outcome).toBe("failed");
    expect(runner.calls).toHaveLength(0);

    const [jobAfter] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, job.id));
    expect(jobAfter?.status).toBe("failed");
    const [projAfter] = await db.select().from(projects).where(eq(projects.id, project!.id));
    expect(projAfter?.currentDocGenerationId).toBeNull();
  });
});
