import {
  aiProviders,
  docChunks,
  docGenerationJobs,
  docGenerations,
  docNodes,
  docPages,
  encrypt,
  gitAccounts,
  projects,
  repositories,
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
import type { ResolvedProvider } from "../../providers/chain.js";

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
  await testDb.db.delete(aiProviders);
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

// Crea un progetto (gruppo) — con l'eventuale aiProviderId, che ora vive sul gruppo —
// e un repository che vi appartiene. Ritorna il repositoryId (la documentazione è per
// repository; il provider AI è risolto dal progetto del repository).
async function createRepository(
  db: Db,
  repoUrl: string,
  opts: { aiProviderId?: string } = {},
): Promise<string> {
  uniq++;
  const gitAccountId = await seedGitAccount(db, {
    provider: "github",
    encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), ENCRYPTION_KEY),
  });
  const [project] = await db
    .insert(projects)
    .values({
      name: `Gruppo ${uniq}`,
      slug: `gruppo-${uniq}`,
      ingestionKey: `ingestion-dispatch-${uniq}`,
      ...(opts.aiProviderId !== undefined ? { aiProviderId: opts.aiProviderId } : {}),
    })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project.id,
      name: `Dispatch ${uniq}`,
      slug: `dispatch-${uniq}`,
      provider: "github",
      gitAccountId,
      repoUrl,
      defaultBranch: "main",
    })
    .returning();
  if (!repository) throw new Error("insert del repository non ha restituito la riga");
  return repository.id;
}

/** Progetto del repository (per registry.register, che ora vuole anche il projectId). */
async function projectIdOf(db: Db, repositoryId: string): Promise<string> {
  const [repo] = await db
    .select({ projectId: repositories.projectId })
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  if (!repo) throw new Error(`repository ${repositoryId} non trovato`);
  return repo.projectId;
}

async function enqueueTrigger(
  db: Db,
  repositoryId: string,
  extra: Partial<typeof docGenerationJobs.$inferInsert> = {},
): Promise<string> {
  const [job] = await db
    .insert(docGenerationJobs)
    .values({ repositoryId, status: "queued", ...extra })
    .returning();
  if (!job) throw new Error("insert del trigger non ha restituito la riga");
  return job.id;
}

/** Crea un provider AI abilitato (da bloccare su una generazione). Ritorna il suo id. */
async function createProvider(db: Db): Promise<string> {
  uniq++;
  const [provider] = await db
    .insert(aiProviders)
    .values({
      label: `Pinned ${uniq}`,
      kind: "api_key",
      secretEncrypted: encrypt(`sk-pinned-${uniq}`, ENCRYPTION_KEY),
      enabled: true,
      position: 0,
    })
    .returning();
  if (!provider) throw new Error("insert del provider non ha restituito la riga");
  return provider.id;
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
    const repositoryId = await createRepository(db, upstream);
    const triggerId = await enqueueTrigger(db, repositoryId);

    const runner = scriptedRunner();
    const embeddingClient = createFakeEmbeddingClient();
    const registry = createGenerationWorktreeRegistry();
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

    // Attende che la GENERAZIONE sia chiusa (succeeded/failed). NB: dopo il decoupling
    // (C2) il trigger va `succeeded` GIÀ al seed del DAG, non a fine generazione: lo
    // stato "generazione in corso/conclusa" vive su doc_generations, non sul trigger.
    const deadline = Date.now() + 60_000;
    let genStatus: string | undefined;
    while (Date.now() < deadline) {
      const [g] = await db
        .select({ status: docGenerations.status })
        .from(docGenerations)
        .where(eq(docGenerations.repositoryId, repositoryId));
      genStatus = g?.status;
      if (genStatus === "succeeded" || genStatus === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    controller.abort();
    await workerPromise;

    expect(genStatus).toBe("succeeded");

    // Il trigger è stato chiuso `succeeded` al seed del DAG (decoupling C2).
    const [trigger] = await db
      .select({ status: docGenerationJobs.status })
      .from(docGenerationJobs)
      .where(eq(docGenerationJobs.id, triggerId));
    expect(trigger?.status).toBe("succeeded");

    // Generazione succeeded.
    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.repositoryId, repositoryId));
    expect(gen?.status).toBe("succeeded");

    // Nodi: 2 radici + 2 figli di 1° livello (rami) + 2 nipoti (foglie) = 6, tutti done.
    const nodes = await db.select().from(docNodes).where(eq(docNodes.generationId, gen!.id));
    expect(nodes.length).toBe(6);
    expect(nodes.every((n) => n.status === "done")).toBe(true);

    // COSTO PER-NODO PERSISTITO (C4): ogni run dell'agente costa 0.01 (scripted). Almeno
    // un nodo che ha eseguito explore/synthesize ha un costo > 0 scritto su doc_nodes.cost,
    // e il costo aggregato della generazione (orient + Σ nodi) supera il solo orientamento.
    const nodeCosts = nodes.reduce((sum, n) => sum + Number(n.cost ?? 0), 0);
    expect(nodeCosts).toBeGreaterThan(0);
    // 1 run di orientamento (0.01) + i run dei nodi → costo totale > del solo orientamento.
    expect(Number(gen?.cost)).toBeGreaterThan(0.01);
    expect(Number(gen?.cost)).toBeCloseTo(0.01 + nodeCosts, 6);

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
    const [repo] = await db.select().from(repositories).where(eq(repositories.id, repositoryId));
    expect(repo?.currentDocGenerationId).toBe(gen!.id);

    // Worktree chiuso e deregistrato: registro vuoto, nessun repository attivo.
    expect(registry.has(gen!.id)).toBe(false);
    expect(registry.activeRepositoryIds().size).toBe(0);
  });

  it("worktree perso al riavvio (registro vuoto) → generazione + nodi pendenti failed, nessun reopen-at-HEAD (C3)", async () => {
    const { db } = testDb;
    const repositoryId = await createRepository(db, "https://github.com/acme/x");

    // Generazione `running` con un nodo claimabile, SENZA worktree nel registro: è
    // l'esatta situazione post-riavvio (i nodi sopravvivono nel DB, l'handle in-memoria no).
    const [gen] = await db
      .insert(docGenerations)
      .values({ repositoryId, status: "running", model: "opus" })
      .returning();
    const [root] = await db
      .insert(docNodes)
      .values({
        generationId: gen!.id,
        repositoryId,
        tree: "technical",
        status: "pending",
        depth: 0,
        position: 0,
        title: "Root",
        slug: "root-restart",
        sourcePaths: [],
      })
      .returning();

    const runner = scriptedRunner();
    const embeddingClient = createFakeEmbeddingClient();
    // Registro VUOTO: il worktree della generazione non è registrato (perso al riavvio).
    const registry = createGenerationWorktreeRegistry();

    const dispatched: Promise<void>[] = [];
    const claimed = await dispatchNode(
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
      (work) => dispatched.push(work),
    );
    // Un nodo è stato reclamato (claim riuscito) e il lavoro in background è schedulato.
    expect(claimed).toBe(true);
    await Promise.all(dispatched);

    // L'agente NON è stato invocato: nessun reopen-at-HEAD, si è fallita la generazione.
    expect(runner.calls).toHaveLength(0);

    // Generazione failed (riavvio) + nodo pendente failed.
    const [genAfter] = await db.select().from(docGenerations).where(eq(docGenerations.id, gen!.id));
    expect(genAfter?.status).toBe("failed");
    expect(genAfter?.error).toMatch(/riavvio/i);
    const [nodeAfter] = await db.select().from(docNodes).where(eq(docNodes.id, root!.id));
    expect(nodeAfter?.status).toBe("failed");

    // Il progetto NON resta escluso dal claim (il worktree non è registrato).
    expect(registry.activeRepositoryIds().size).toBe(0);
  });
});

// Provider del PROGETTO (projects.aiProviderId): l'intera generazione usa SOLO quel
// provider, niente fallback.
describe("provider bloccato (project.aiProviderId)", () => {
  const PINNED: ResolvedProvider = {
    id: "00000000-0000-0000-0000-000000000001",
    kind: "api_key",
    secret: "sk-pinned",
  };

  it("trigger con project.aiProviderId valido → orientamento usa quel provider (mock loadProviderByIdFn)", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const providerId = await createProvider(db);
    const repositoryId = await createRepository(db, upstream, { aiProviderId: providerId });
    // Chiamando l'handler direttamente saltiamo claimNextDocJob: il trigger va messo
    // `running` a mano (è lo stato in cui l'handler reale lo riceve).
    const triggerId = await enqueueTrigger(db, repositoryId, {
      status: "running",
      startedAt: new Date(),
    });

    const runner = scriptedRunner();
    const registry = createGenerationWorktreeRegistry();
    const serializer = createProjectSerializer();
    const pinnedForId: ResolvedProvider = { ...PINNED, id: providerId };

    let byIdArgs: { id: string } | null = null;
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
        // chain MAI usata col pin: se venisse chiamata il provider sarebbe sbagliato.
        loadProviderChainFn: async () => [],
        loadProviderByIdFn: async (_db, _key, id) => {
          byIdArgs = { id };
          return pinnedForId;
        },
      },
      serializer,
    );

    await docHandler({
      id: triggerId,
      repositoryId,
    } as never);

    // Il provider è stato risolto per id (non via chain) e l'orientamento ha usato QUEL provider.
    expect(byIdArgs).toEqual({ id: providerId });
    expect(runner.calls.length).toBeGreaterThan(0);
    expect(runner.calls[0]?.provider).toEqual(pinnedForId);

    // La generazione è stata seminata col pin (i job-nodo lo rileggeranno).
    const [gen] = await db
      .select()
      .from(docGenerations)
      .where(eq(docGenerations.repositoryId, repositoryId));
    expect(gen?.pinnedProviderId).toBe(providerId);

    // Pulizia del worktree aperto dall'orientamento.
    const wt = registry.claimForFinalize(gen!.id);
    if (wt) await wt.close().catch(() => {});
  });

  it("trigger con project.aiProviderId NON risolvibile → trigger failed, runOrientation MAI chiamata, niente fallback", async () => {
    const { db } = testDb;
    const mirrors = await makeMirrors();
    const providerId = await createProvider(db);
    const repositoryId = await createRepository(db, "https://github.com/acme/x", {
      aiProviderId: providerId,
    });
    const triggerId = await enqueueTrigger(db, repositoryId, {
      status: "running",
      startedAt: new Date(),
    });

    const runner = scriptedRunner();
    const registry = createGenerationWorktreeRegistry();
    const serializer = createProjectSerializer();

    let chainCalled = false;
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
        loadProviderChainFn: async () => {
          chainCalled = true;
          return [];
        },
        // Pin non risolvibile (disabilitato/cancellato/segreto corrotto).
        loadProviderByIdFn: async () => null,
      },
      serializer,
    );

    await docHandler({
      id: triggerId,
      repositoryId,
    } as never);

    // NESSUN fallback: la catena non è stata interrogata, l'agente non è stato invocato
    // (runOrientation mai chiamata: niente mirror aperto, niente generazione creata).
    expect(chainCalled).toBe(false);
    expect(runner.calls).toHaveLength(0);
    const gens = await db
      .select()
      .from(docGenerations)
      .where(eq(docGenerations.repositoryId, repositoryId));
    expect(gens).toHaveLength(0);

    // Trigger failed con l'errore del pin.
    const [trigger] = await db
      .select()
      .from(docGenerationJobs)
      .where(eq(docGenerationJobs.id, triggerId));
    expect(trigger?.status).toBe("failed");
    expect(trigger?.error).toBe("pinned_provider_unavailable");
  });

  it("trigger SENZA project.aiProviderId → chain[0] (comportamento automatico), loadProviderById MAI chiamata", async () => {
    const { db } = testDb;
    const upstream = await makeUpstream();
    const mirrors = await makeMirrors();
    const repositoryId = await createRepository(db, upstream); // niente aiProviderId
    const triggerId = await enqueueTrigger(db, repositoryId, {
      status: "running",
      startedAt: new Date(),
    });

    const runner = scriptedRunner();
    const registry = createGenerationWorktreeRegistry();
    const serializer = createProjectSerializer();
    const chainProvider: ResolvedProvider = {
      id: "11111111-1111-1111-1111-111111111111",
      kind: "api_key",
      secret: "sk-chain",
    };
    let byIdCalled = false;

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
        loadProviderChainFn: async () => [chainProvider],
        loadProviderByIdFn: async () => {
          byIdCalled = true;
          return null;
        },
      },
      serializer,
    );

    await docHandler({
      id: triggerId,
      repositoryId,
    } as never);

    // Senza provider di progetto: si usa chain[0], loadProviderById MAI chiamata.
    expect(byIdCalled).toBe(false);
    expect(runner.calls.length).toBeGreaterThan(0);
    expect(runner.calls[0]?.provider).toEqual(chainProvider);

    // La generazione NON è stata seminata con un pin (resta null).
    const [gen] = await db
      .select()
      .from(docGenerations)
      .where(eq(docGenerations.repositoryId, repositoryId));
    expect(gen?.pinnedProviderId).toBeNull();

    // Pulizia del worktree aperto dall'orientamento.
    const wt = registry.claimForFinalize(gen!.id);
    if (wt) await wt.close().catch(() => {});
  });

  it("nodo di una generazione pinnata → usa il provider bloccato, NON chain[0]", async () => {
    const { db } = testDb;
    const repositoryId = await createRepository(db, "https://github.com/acme/x");
    const providerId = await createProvider(db);

    // Generazione `running` pinnata + un nodo explore claimabile, worktree registrato.
    const [gen] = await db
      .insert(docGenerations)
      .values({ repositoryId, status: "running", model: "opus", pinnedProviderId: providerId })
      .returning();
    await db
      .insert(docNodes)
      .values({
        generationId: gen!.id,
        repositoryId,
        tree: "technical",
        status: "pending",
        depth: 1,
        position: 0,
        title: "Leaf",
        slug: "leaf-pinned",
        sourcePaths: ["src/core"],
      });

    const runner = scriptedRunner();
    const embeddingClient = createFakeEmbeddingClient();
    const registry = createGenerationWorktreeRegistry();
    // Worktree fittizio registrato (il nodo legge solo, una dir basta).
    const fakeDir = await mkdtemp(join(tmpdir(), "stubwise-pin-wt-"));
    cleanups.push(() => rm(fakeDir, { recursive: true, force: true }));
    registry.register(gen!.id, repositoryId, await projectIdOf(db, repositoryId), {
      dir: fakeDir,
      commitSha: "0".repeat(40),
      close: async () => {},
    } as never);

    const pinnedForId: ResolvedProvider = { ...PINNED, id: providerId };
    let chainCalled = false;
    let byIdId: string | null = null;

    const dispatched: Promise<void>[] = [];
    const claimed = await dispatchNode(
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
        loadProviderChainFn: async () => {
          chainCalled = true;
          return [];
        },
        loadProviderByIdFn: async (_db, _key, id) => {
          byIdId = id;
          return pinnedForId;
        },
      },
      (work) => dispatched.push(work),
    );
    expect(claimed).toBe(true);
    await Promise.all(dispatched);

    // Il provider è stato risolto per id (il pin), non via chain.
    expect(byIdId).toBe(providerId);
    expect(chainCalled).toBe(false);
    // L'agente del nodo ha usato il provider bloccato.
    expect(runner.calls.length).toBeGreaterThan(0);
    expect(runner.calls[0]?.provider).toEqual(pinnedForId);
  });

  it("nodo con pin NON risolvibile → generazione failed, chain[0] MAI usata per il nodo", async () => {
    const { db } = testDb;
    const repositoryId = await createRepository(db, "https://github.com/acme/x");
    const providerId = await createProvider(db);

    const [gen] = await db
      .insert(docGenerations)
      .values({ repositoryId, status: "running", model: "opus", pinnedProviderId: providerId })
      .returning();
    const [node] = await db
      .insert(docNodes)
      .values({
        generationId: gen!.id,
        repositoryId,
        tree: "technical",
        status: "pending",
        depth: 0,
        position: 0,
        title: "Root",
        slug: "root-pin-fail",
        sourcePaths: [],
      })
      .returning();

    const runner = scriptedRunner();
    const embeddingClient = createFakeEmbeddingClient();
    const registry = createGenerationWorktreeRegistry();
    const fakeDir = await mkdtemp(join(tmpdir(), "stubwise-pin-wt-"));
    cleanups.push(() => rm(fakeDir, { recursive: true, force: true }));
    registry.register(gen!.id, repositoryId, await projectIdOf(db, repositoryId), {
      dir: fakeDir,
      commitSha: "0".repeat(40),
      close: async () => {},
    } as never);

    let chainCalled = false;
    const dispatched: Promise<void>[] = [];
    const claimed = await dispatchNode(
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
        loadProviderChainFn: async () => {
          chainCalled = true;
          return [];
        },
        // Pin diventato indisponibile a metà generazione.
        loadProviderByIdFn: async () => null,
      },
      (work) => dispatched.push(work),
    );
    expect(claimed).toBe(true);
    await Promise.all(dispatched);

    // NIENTE fallback: la catena non è stata interrogata, l'agente non è stato invocato.
    expect(chainCalled).toBe(false);
    expect(runner.calls).toHaveLength(0);

    // La generazione è failed (con i suoi nodi non-done) — riusa il fail della generazione.
    const [genAfter] = await db
      .select()
      .from(docGenerations)
      .where(eq(docGenerations.id, gen!.id));
    expect(genAfter?.status).toBe("failed");
    expect(genAfter?.error).toMatch(/provider bloccato/i);
    const [nodeAfter] = await db.select().from(docNodes).where(eq(docNodes.id, node!.id));
    expect(nodeAfter?.status).toBe("failed");
  });

  it("nodo SENZA pin → chain[0] (regressione del comportamento attuale)", async () => {
    const { db } = testDb;
    const repositoryId = await createRepository(db, "https://github.com/acme/x");

    const [gen] = await db
      .insert(docGenerations)
      .values({ repositoryId, status: "running", model: "opus" })
      .returning();
    await db
      .insert(docNodes)
      .values({
        generationId: gen!.id,
        repositoryId,
        tree: "technical",
        status: "pending",
        depth: 1,
        position: 0,
        title: "Leaf",
        slug: "leaf-nopin",
        sourcePaths: ["src/core"],
      })
      .returning();

    const runner = scriptedRunner();
    const embeddingClient = createFakeEmbeddingClient();
    const registry = createGenerationWorktreeRegistry();
    const fakeDir = await mkdtemp(join(tmpdir(), "stubwise-nopin-wt-"));
    cleanups.push(() => rm(fakeDir, { recursive: true, force: true }));
    registry.register(gen!.id, repositoryId, await projectIdOf(db, repositoryId), {
      dir: fakeDir,
      commitSha: "0".repeat(40),
      close: async () => {},
    } as never);

    const chainProvider: ResolvedProvider = {
      id: "11111111-1111-1111-1111-111111111111",
      kind: "api_key",
      secret: "sk-chain",
    };
    let byIdCalled = false;

    const dispatched: Promise<void>[] = [];
    await dispatchNode(
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
        loadProviderChainFn: async () => [chainProvider],
        loadProviderByIdFn: async () => {
          byIdCalled = true;
          return null;
        },
      },
      (work) => dispatched.push(work),
    );
    await Promise.all(dispatched);

    // Senza pin: si usa chain[0], loadProviderById MAI chiamata.
    expect(byIdCalled).toBe(false);
    expect(runner.calls.length).toBeGreaterThan(0);
    expect(runner.calls[0]?.provider).toEqual(chainProvider);
  });
});
