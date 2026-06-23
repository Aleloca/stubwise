import {
  docChunks,
  docGenerationJobs,
  docGenerations,
  docNodes,
  docPages,
  encrypt,
  gitAccounts,
  projects,
  type Db,
} from "@stubwise/db";
import { seedGitAccount, startTestDb, type TestDb } from "@stubwise/db/testing";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import {
  EXPLORE_BODY_END_MARKER,
  EXPLORE_BODY_START_MARKER,
  EXPLORE_CHILDREN_END_MARKER,
  EXPLORE_CHILDREN_START_MARKER,
  ORIENT_END_MARKER,
  ORIENT_FUNCTIONAL_END_MARKER,
  ORIENT_FUNCTIONAL_START_MARKER,
  ORIENT_START_MARKER,
  ORIENT_TECHNICAL_END_MARKER,
  ORIENT_TECHNICAL_START_MARKER,
  SOURCE_PATHS_END_MARKER,
  SOURCE_PATHS_START_MARKER,
  SYNTH_BODY_END_MARKER,
  SYNTH_BODY_START_MARKER,
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
import type { AgentRunOptions, AgentRunResult } from "../../agent/runner.js";
import { MirrorManager } from "../../git/mirrors.js";
import { createDocHandler, failDocJobOnError } from "../handler.js";
import { createProjectSerializer } from "../../handler.js";
import { runWorker } from "../../queue.js";
import { dispatchNode } from "./node-dispatch.js";
import { createGenerationWorktreeRegistry } from "./registry.js";

// Test d'integrazione del DISPATCH del DAG (M7.1): un trigger doc-generation +
// un repo bare locale + progetto; un FakeAgentRunner scriptato a produrre un piano
// di orientamento valido, poi output di explore (alcune foglie, alcune con figli) e
// di synthesize validi; un FakeEmbeddingClient. Si guida runWorker fino a generazione
// completata, poi si assertano: doc_pages annidate, doc_chunks, currentDocGenerationId
// swappato, generazione succeeded, trigger succeeded, worktree chiuso (registro vuoto).

vi.setConfig({ testTimeout: 120_000 });

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

async function git(args: string[], cwd: string): Promise<void> {
  await execa("git", args, { cwd });
}

async function makeUpstream(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-dispatch-test-"));
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
  return pathToFileURL(dir).href;
}

async function makeMirrors(): Promise<MirrorManager> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-dispatch-mirrors-"));
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
      name: `Dispatch ${uniq}`,
      slug: `dispatch-${uniq}`,
      provider: "github",
      gitAccountId,
      repoUrl,
      defaultBranch: "main",
      ingestionKey: `ingestion-dispatch-${uniq}`,
    })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  return project.id;
}

async function enqueueTrigger(db: Db, projectId: string): Promise<string> {
  const [job] = await db
    .insert(docGenerationJobs)
    .values({ projectId, status: "queued" })
    .returning();
  if (!job) throw new Error("insert del trigger non ha restituito la riga");
  return job.id;
}

/** Piano di orientamento: 1 unità tecnica + 1 capability funzionale. */
const ORIENT_PLAN = [
  ORIENT_START_MARKER,
  "TypeScript project. src/ is architecture.",
  ORIENT_TECHNICAL_START_MARKER,
  "- Core Module :: src/core :: il cuore del sistema",
  ORIENT_TECHNICAL_END_MARKER,
  ORIENT_FUNCTIONAL_START_MARKER,
  "- Greet Users :: src/core :: saluta gli utenti",
  ORIENT_FUNCTIONAL_END_MARKER,
  ORIENT_END_MARKER,
].join("\n");

const LONG_BODY =
  "This area of the system is described here in plain language with enough words to be a real page and to chunk into at least one markdown chunk for embedding.";

/** Output di explore CON un figlio (ramo): body + 1 figlio + source paths. */
function exploreBranch(childTitle: string, childRef: string): string {
  return [
    EXPLORE_BODY_START_MARKER,
    `## ${childTitle} area`,
    LONG_BODY,
    EXPLORE_BODY_END_MARKER,
    EXPLORE_CHILDREN_START_MARKER,
    `- ${childTitle} :: ${childRef} :: dettaglio di ${childTitle}`,
    EXPLORE_CHILDREN_END_MARKER,
    SOURCE_PATHS_START_MARKER,
    childRef,
    SOURCE_PATHS_END_MARKER,
  ].join("\n");
}

/** Output di explore SENZA figli (foglia): body + children vuoto + source paths. */
function exploreLeaf(ref: string): string {
  return [
    EXPLORE_BODY_START_MARKER,
    `## Leaf for ${ref}`,
    LONG_BODY,
    EXPLORE_BODY_END_MARKER,
    EXPLORE_CHILDREN_START_MARKER,
    EXPLORE_CHILDREN_END_MARKER,
    SOURCE_PATHS_START_MARKER,
    ref,
    SOURCE_PATHS_END_MARKER,
  ].join("\n");
}

/** Output di synthesize: overview valida. */
function synth(title: string): string {
  return [
    SYNTH_BODY_START_MARKER,
    `## ${title} overview`,
    `${LONG_BODY} It links the child pages below.`,
    SYNTH_BODY_END_MARKER,
  ].join("\n");
}

/**
 * AgentRunner scriptato che riconosce la FASE dal contenuto del prompt (ogni prompt
 * contiene i marcatori dell'output che richiede) e produce un output valido. Explore
 * di un nodo di 1° livello → ramo (1 figlio); explore di un nodo più profondo →
 * foglia. Così il DAG ha sia foglie sia rami che richiedono la sintesi.
 */
function scriptedRunner(): FakeAgentRunner {
  let exploreCount = 0;
  const script = (opts: AgentRunOptions): AgentRunResult => {
    const p = opts.prompt;
    const usage = { totalCostUsd: 0.01, models: [] };
    if (p.includes(ORIENT_TECHNICAL_START_MARKER)) {
      return { output: ORIENT_PLAN, exitCode: 0, usage };
    }
    if (p.includes(SYNTH_BODY_START_MARKER)) {
      return { output: synth("Area"), exitCode: 0, usage };
    }
    if (p.includes(EXPLORE_BODY_START_MARKER)) {
      exploreCount += 1;
      // Il PRIMO explore per albero (nodo di 1° livello) produce un figlio; gli
      // explore successivi (i figli) sono foglie. Due alberi → i primi due explore
      // sono rami, il resto foglie.
      if (exploreCount <= 2) {
        return { output: exploreBranch("Detail", "src/core/detail"), exitCode: 0, usage };
      }
      return { output: exploreLeaf("src/core/detail"), exitCode: 0, usage };
    }
    // Prompt non riconosciuto: output vuoto (non dovrebbe accadere).
    return { output: "", exitCode: 0, usage };
  };
  return new FakeAgentRunner({ script });
}

describe("dispatch del DAG (M7.1)", () => {
  it("trigger → orientamento → nodi → finalizzazione: generazione succeeded, pagine annidate, swap, worktree chiuso", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const projectId = await createProject(db, upstream);
    const triggerId = await enqueueTrigger(db, projectId);

    const runner = scriptedRunner();
    const embeddingClient = createFakeEmbeddingClient();
    const registry = createGenerationWorktreeRegistry(mirrors, ENCRYPTION_KEY);
    const serializer = createProjectSerializer();

    const docHandler = createDocHandler(
      {
        db,
        runner,
        mirrors,
        registry,
        encryptionKey: ENCRYPTION_KEY,
        model: "opus",
        agentTimeoutMs: 600_000,
        maxTurns: 30,
        loadProviderChainFn: async () => [],
      },
      serializer,
    );

    const dispatchNodeFn = (track: (work: Promise<void>) => void): Promise<boolean> =>
      dispatchNode(
        {
          db,
          runner,
          registry,
          finalize: { embeddingClient },
          model: "opus",
          agentTimeoutMs: 600_000,
          maxTurns: 30,
          maxDepth: 6,
          maxNodes: 400,
          encryptionKey: ENCRYPTION_KEY,
          loadProviderChainFn: async () => [],
        },
        track,
      );

    // Guida il loop con un fix-handler no-op (nessun fix in coda) finché la
    // generazione è chiusa, poi abort.
    const controller = new AbortController();
    const workerPromise = runWorker({
      db,
      handler: async () => {},
      docHandler,
      docHandlerOnError: failDocJobOnError,
      dispatchNode: dispatchNodeFn,
      activeGenerationProjectIds: () => registry.activeProjectIds(),
      concurrency: 2,
      pollMs: 50,
      requeueEveryMs: 1_000_000, // niente requeue durante il test
      signal: controller.signal,
    });

    // Attende che il trigger sia chiuso (succeeded/failed).
    const deadline = Date.now() + 60_000;
    let triggerStatus = "queued";
    while (Date.now() < deadline) {
      const [job] = await db
        .select({ status: docGenerationJobs.status })
        .from(docGenerationJobs)
        .where(eq(docGenerationJobs.id, triggerId));
      triggerStatus = job?.status ?? "queued";
      if (triggerStatus === "succeeded" || triggerStatus === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    controller.abort();
    await workerPromise;

    expect(triggerStatus).toBe("succeeded");

    // Generazione succeeded.
    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.projectId, projectId));
    expect(gen?.status).toBe("succeeded");

    // Nodi: 2 radici + 2 figli di 1° livello (rami) + 2 nipoti (foglie) = 6, tutti done.
    const nodes = await db.select().from(docNodes).where(eq(docNodes.generationId, gen!.id));
    expect(nodes.length).toBe(6);
    expect(nodes.every((n) => n.status === "done")).toBe(true);

    // doc_pages annidate (≥3 livelli): root → child → grandchild.
    const pages = await db.select().from(docPages).where(eq(docPages.generationId, gen!.id));
    expect(pages.length).toBe(6);
    const roots = pages.filter((p) => p.parentId === null);
    expect(roots.length).toBe(2);
    // Almeno una catena a 3 livelli (un nipote la cui pagina padre ha a sua volta un padre).
    const byId = new Map(pages.map((p) => [p.id, p]));
    const threeLevels = pages.some((p) => {
      const parent = p.parentId ? byId.get(p.parentId) : undefined;
      return parent?.parentId != null;
    });
    expect(threeLevels).toBe(true);

    // doc_chunks con embedding.
    const chunks = await db.select().from(docChunks).where(eq(docChunks.generationId, gen!.id));
    expect(chunks.length).toBeGreaterThan(0);

    // SWAP del puntatore corrente.
    const [proj] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(proj?.currentDocGenerationId).toBe(gen!.id);

    // Worktree chiuso e deregistrato: registro vuoto, nessun progetto attivo.
    expect(registry.has(gen!.id)).toBe(false);
    expect(registry.activeProjectIds().size).toBe(0);
  });
});
