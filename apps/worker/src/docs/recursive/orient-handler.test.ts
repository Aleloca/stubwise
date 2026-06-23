import {
  docGenerationJobs,
  docGenerations,
  docNodes,
  encrypt,
  gitAccounts,
  projects,
  type Db,
} from "@stubwise/db";
import { seedGitAccount, startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  ORIENT_END_MARKER,
  ORIENT_FUNCTIONAL_END_MARKER,
  ORIENT_FUNCTIONAL_START_MARKER,
  ORIENT_START_MARKER,
  ORIENT_TECHNICAL_END_MARKER,
  ORIENT_TECHNICAL_START_MARKER,
} from "@stubwise/docs-engine";
import { eq } from "drizzle-orm";
import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "../../agent/fake.js";
import type { AgentRunUsage } from "../../agent/runner.js";
import { MirrorManager } from "../../git/mirrors.js";
import { type DocJob } from "../queue.js";
import { runOrientation, type RunOrientationDeps } from "./orient-handler.js";
import { createGenerationWorktreeRegistry } from "./registry.js";

// Test del handler di orientamento (M5.2): mirror bare locale come "upstream", un
// FakeAgentRunner scriptato a produrre un piano marcato (===ORIENTATION PLAN=== con
// 2 unità tecniche + 2 capability funzionali) e un fake embedding non serve (no
// embed in orientamento). Si asseriscono: generazione running + 2 radici
// (awaiting_children, pendingChildren=2) + 4 figli pending depth 1; output invalido
// → retry → fail (generazione failed, trigger failed).

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

async function makeUpstream(): Promise<{ url: string }> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-orient-test-"));
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
  return { url: pathToFileURL(dir).href };
}

async function makeMirrors(): Promise<MirrorManager> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-orient-mirrors-"));
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

async function enqueueTrigger(db: Db, projectId: string): Promise<DocJob> {
  const [job] = await db
    .insert(docGenerationJobs)
    .values({ projectId, status: "running", startedAt: new Date() })
    .returning();
  if (!job) throw new Error("insert del trigger non ha restituito la riga");
  return job;
}

/** Piano di orientamento ben formato: 2 unità tecniche + 2 capability funzionali. */
const VALID_PLAN = [
  ORIENT_START_MARKER,
  "Detected a TypeScript project. plans/ is context-noise, src/ is architecture.",
  ORIENT_TECHNICAL_START_MARKER,
  "- Core Module :: src/core :: il cuore del sistema",
  "- API Layer :: src/api :: gli endpoint HTTP",
  ORIENT_TECHNICAL_END_MARKER,
  ORIENT_FUNCTIONAL_START_MARKER,
  "- Greet Users :: src/core :: saluta gli utenti",
  "- Serve Requests :: src/api :: risponde alle richieste",
  ORIENT_FUNCTIONAL_END_MARKER,
  ORIENT_END_MARKER,
].join("\n");

const USAGE: AgentRunUsage = { totalCostUsd: 0.02, models: [] };

function baseDeps(db: Db, mirrors: MirrorManager, runner: FakeAgentRunner): RunOrientationDeps {
  return {
    db,
    mirrors,
    runner,
    encryptionKey: ENCRYPTION_KEY,
    model: "opus",
    agentTimeoutMs: 600_000,
    maxTurns: 30,
  };
}

describe("runOrientation", () => {
  it("semina due radici (awaiting_children, pendingChildren=2) + 4 figli pending depth 1", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, upstream.url);
    const job = await enqueueTrigger(db, projectId);

    const runner = new FakeAgentRunner({
      script: () => ({ output: VALID_PLAN, exitCode: 0, usage: USAGE }),
    });
    const outcome = await runOrientation(baseDeps(db, mirrors, runner), job);
    expect(outcome).toBe("seeded");

    // L'agente è stato chiamato read-only col modello giusto.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.permissionMode).toBe("plan");
    expect(runner.calls[0]?.model).toBe("opus");
    // Il survey è arrivato nel prompt (manifest letto).
    expect(runner.calls[0]?.prompt).toContain("package.json");

    // Generazione running + commitSha + costo aggregato dell'orientamento.
    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.projectId, projectId));
    expect(gen?.status).toBe("running");
    expect(gen?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(Number(gen?.cost)).toBeCloseTo(0.02, 6);

    // Due radici, depth 0, parentId null, awaiting_children, pendingChildren=2.
    const nodes = await db.select().from(docNodes).where(eq(docNodes.generationId, gen!.id));
    const roots = nodes.filter((n) => n.parentId === null);
    expect(roots).toHaveLength(2);
    for (const root of roots) {
      expect(root.depth).toBe(0);
      expect(root.status).toBe("awaiting_children");
      expect(root.pendingChildren).toBe(2);
    }
    const techRoot = roots.find((r) => r.tree === "technical");
    const funcRoot = roots.find((r) => r.tree === "functional");
    expect(techRoot?.title).toBe("Architecture Overview");
    expect(funcRoot?.title).toBe("Capability Map");

    // Quattro figli pending, depth 1, slug/tree/title/unitRef corretti.
    const children = nodes.filter((n) => n.parentId !== null);
    expect(children).toHaveLength(4);
    for (const child of children) {
      expect(child.depth).toBe(1);
      expect(child.status).toBe("pending");
      expect(child.slug.length).toBeGreaterThan(0);
    }
    const techChildren = children.filter((c) => c.parentId === techRoot!.id);
    expect(techChildren.map((c) => c.title).sort()).toEqual(["API Layer", "Core Module"]);
    const coreModule = techChildren.find((c) => c.title === "Core Module");
    expect(coreModule?.tree).toBe("technical");
    expect(coreModule?.unitRef).toBe("src/core");
    expect(coreModule?.sourcePaths).toEqual(["src/core"]);

    const funcChildren = children.filter((c) => c.parentId === funcRoot!.id);
    expect(funcChildren.map((c) => c.title).sort()).toEqual(["Greet Users", "Serve Requests"]);
    expect(funcChildren.every((c) => c.tree === "functional")).toBe(true);

    // Slug univoci tra TUTTI i nodi (radici + figli).
    const slugs = nodes.map((n) => n.slug);
    expect(new Set(slugs).size).toBe(slugs.length);

    // Il trigger è CHIUSO `succeeded` al seed del DAG (decoupling C2), con generationId
    // collegato: lo stato "generazione in corso" vive ora su doc_generations.
    const [jobAfter] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, job.id));
    expect(jobAfter?.status).toBe("succeeded");
    expect(jobAfter?.generationId).toBe(gen!.id);
  });

  it("output invalido (niente marcatori) → retry → fallback: generazione failed, trigger failed", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, upstream.url);
    const job = await enqueueTrigger(db, projectId);

    const runner = new FakeAgentRunner({
      script: () => ({
        output: "Ecco il mio piano in prosa libera, senza marcatori del contratto.",
        exitCode: 0,
        usage: USAGE,
      }),
    });
    const outcome = await runOrientation(baseDeps(db, mirrors, runner), job);
    expect(outcome).toBe("failed");

    // Retry: l'agente è stato invocato DUE volte prima del fallback.
    expect(runner.calls).toHaveLength(2);

    // Generazione failed, nessun nodo seminato.
    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.projectId, projectId));
    expect(gen?.status).toBe("failed");
    expect(gen?.error).toMatch(/orientamento|marcatori|non valido/i);
    const nodes = await db.select().from(docNodes).where(eq(docNodes.generationId, gen!.id));
    expect(nodes).toHaveLength(0);

    // Trigger failed (niente DAG da far avanzare).
    const [jobAfter] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, job.id));
    expect(jobAfter?.status).toBe("failed");
  });

  it("radice senza figli (child-list vuota) → done con pendingChildren=0 (caso degenere)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, upstream.url);
    const job = await enqueueTrigger(db, projectId);

    // Piano valido (marcatori presenti) ma con la sola child-list tecnica popolata.
    const planFuncEmpty = [
      ORIENT_START_MARKER,
      "Solo unità tecniche, nessuna capability funzionale rilevata.",
      ORIENT_TECHNICAL_START_MARKER,
      "- Core Module :: src/core :: il cuore",
      ORIENT_TECHNICAL_END_MARKER,
      ORIENT_FUNCTIONAL_START_MARKER,
      ORIENT_FUNCTIONAL_END_MARKER,
      ORIENT_END_MARKER,
    ].join("\n");

    const runner = new FakeAgentRunner({
      script: () => ({ output: planFuncEmpty, exitCode: 0, usage: USAGE }),
    });
    const outcome = await runOrientation(baseDeps(db, mirrors, runner), job);
    expect(outcome).toBe("seeded");

    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.projectId, projectId));
    const nodes = await db.select().from(docNodes).where(eq(docNodes.generationId, gen!.id));
    const funcRoot = nodes.find((n) => n.parentId === null && n.tree === "functional");
    // Radice funzionale degenere: done, pendingChildren 0, nessun figlio.
    expect(funcRoot?.status).toBe("done");
    expect(funcRoot?.pendingChildren).toBe(0);
    expect(funcRoot?.finishedAt).not.toBeNull();
    expect(nodes.filter((n) => n.parentId === funcRoot!.id)).toHaveLength(0);
    // La radice tecnica invece ha il suo unico figlio e attende.
    const techRoot = nodes.find((n) => n.parentId === null && n.tree === "technical");
    expect(techRoot?.status).toBe("awaiting_children");
    expect(techRoot?.pendingChildren).toBe(1);
  });

  it("piano VUOTO (entrambe le child-list vuote) → orientamento fallito: generazione failed, trigger failed, nessun nodo (C1)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, upstream.url);
    const job = await enqueueTrigger(db, projectId);

    // Piano coi marcatori presenti (parse valido) ma ENTRAMBE le child-list vuote:
    // l'agente non ha trovato nulla da documentare. Senza il fix la generazione
    // resterebbe `running` per sempre (nessun nodo → finalizzazione mai innescata).
    const emptyPlan = [
      ORIENT_START_MARKER,
      "Nessuna unità tecnica né capability funzionale rilevata.",
      ORIENT_TECHNICAL_START_MARKER,
      ORIENT_TECHNICAL_END_MARKER,
      ORIENT_FUNCTIONAL_START_MARKER,
      ORIENT_FUNCTIONAL_END_MARKER,
      ORIENT_END_MARKER,
    ].join("\n");

    const runner = new FakeAgentRunner({
      script: () => ({ output: emptyPlan, exitCode: 0, usage: USAGE }),
    });
    const registry = createGenerationWorktreeRegistry();
    const outcome = await runOrientation(
      { ...baseDeps(db, mirrors, runner), registry },
      job,
    );
    expect(outcome).toBe("failed");

    // Generazione failed (NON stuck running) con ragione "piano vuoto"; nessun nodo seminato.
    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.projectId, projectId));
    expect(gen?.status).toBe("failed");
    expect(gen?.error).toMatch(/vuoto|nessuna unità/i);
    expect(gen?.finishedAt).not.toBeNull();
    const nodes = await db.select().from(docNodes).where(eq(docNodes.generationId, gen!.id));
    expect(nodes).toHaveLength(0);

    // Trigger failed.
    const [jobAfter] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, job.id));
    expect(jobAfter?.status).toBe("failed");

    // Worktree CHIUSO: il registro non ha l'handle (nessun leak), nessun progetto attivo.
    expect(registry.has(gen!.id)).toBe(false);
    expect(registry.activeProjectIds().size).toBe(0);
  });

  it("guard DB: un secondo trigger con una generazione già `running` per il progetto NON ne avvia una seconda (C2)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, upstream.url);

    // Simula una generazione GIÀ in corso per il progetto (es. avviata da un trigger
    // precedente o sopravvissuta a un riavvio): una riga doc_generations `running`.
    await db
      .insert(docGenerations)
      .values({ projectId, status: "running", model: "opus" });

    const job = await enqueueTrigger(db, projectId);
    const runner = new FakeAgentRunner({
      script: () => ({ output: VALID_PLAN, exitCode: 0, usage: USAGE }),
    });
    const outcome = await runOrientation(baseDeps(db, mirrors, runner), job);
    expect(outcome).toBe("skipped");

    // L'agente NON è stato invocato (nessun orientamento avviato).
    expect(runner.calls).toHaveLength(0);

    // NESSUNA seconda generazione creata: resta solo la riga running preesistente.
    const gens = await db.select().from(docGenerations).where(eq(docGenerations.projectId, projectId));
    expect(gens).toHaveLength(1);
    expect(gens[0]?.status).toBe("running");

    // Nessun nodo seminato.
    const nodes = await db
      .select()
      .from(docNodes)
      .where(eq(docNodes.projectId, projectId));
    expect(nodes).toHaveLength(0);

    // Il trigger è chiuso `succeeded`-skip (nessun errore: una generazione è già in corso).
    const [jobAfter] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, job.id));
    expect(jobAfter?.status).toBe("succeeded");
  });
});
