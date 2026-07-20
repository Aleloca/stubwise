import {
  aiProviders,
  backlogChatMessages,
  backlogItems,
  encrypt,
  gitAccounts,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "../agent/runner.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { runDeepDive, upsertAnalysisSection } from "./deep-dive.js";
import { MalformedBacklogPayloadError, type BacklogDeps, type BacklogJob } from "./poller.js";

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);
const HEAD_SHA = "a".repeat(40);

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects); // repos/items/jobs cascano dal progetto.
  await testDb.db.delete(gitAccounts);
  await testDb.db.delete(aiProviders);
});

afterAll(async () => {
  await testDb.stop();
});

const silentLogger = { warn: () => {}, error: () => {} };

/** Runner che cattura le opzioni dell'ultimo run e restituisce un output fisso. */
function fakeRunner(output: string, exitCode = 0): AgentRunner & { calls: AgentRunOptions[] } {
  const calls: AgentRunOptions[] = [];
  const result: AgentRunResult = { output, exitCode };
  return {
    calls,
    run: vi.fn(async (opts: AgentRunOptions) => {
      calls.push(opts);
      return result;
    }),
  };
}

/**
 * Mirror fake: `resolveDefaultBranchHead` → HEAD_SHA (o lancia se `mirrorError`);
 * `withWorktreeAtSha` invoca `fn` con una dir finta e registra lo sha ricevuto.
 */
function fakeMirrors(opts: { mirrorError?: boolean } = {}): BacklogDeps["mirrors"] & {
  readonly shaSeen: string | null;
} {
  const state = { shaSeen: null as string | null };
  return {
    get shaSeen() {
      return state.shaSeen;
    },
    resolveDefaultBranchHead: async () => {
      if (opts.mirrorError) throw new Error("mirror irraggiungibile");
      return HEAD_SHA;
    },
    withWorktreeAtSha: async <T>(_p: unknown, sha: string, fn: (dir: string) => Promise<T>) => {
      state.shaSeen = sha;
      return fn("/tmp/fake-worktree");
    },
  } as BacklogDeps["mirrors"] & { readonly shaSeen: string | null };
}

const FAKE_PROVIDER: ResolvedProvider = { id: "prov-1", kind: "api_key", secret: "sk-fake" };

function makeDeps(
  db: Db,
  overrides: Partial<BacklogDeps> & { mirrors?: BacklogDeps["mirrors"] },
): BacklogDeps {
  return {
    db,
    embeddingClient: { embed: async () => [] },
    runner: fakeRunner("{}"),
    mirrors: fakeMirrors(),
    serializer: { run: (_p, task) => task() },
    logger: silentLogger,
    encryptionKey: ENCRYPTION_KEY,
    mergeThreshold: 0.9,
    similarThreshold: 0.78,
    agentTimeoutMs: 1000,
    deepDiveMaxTurns: 30,
    workDir: "/tmp",
    // Catena vuota di default: nessun provider (auth del container).
    loadProviderChainFn: async () => [],
    ...overrides,
  };
}

/** Progetto + repository con credenziali cifrate. `aiProviderId` opzionale. */
async function createProjectWithRepo(
  db: Db,
  opts: { aiProviderId?: string } = {},
): Promise<{ projectId: string; repositoryId: string }> {
  const [account] = await db
    .insert(gitAccounts)
    .values({
      name: `Account ${randomUUID()}`,
      provider: "github",
      encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), ENCRYPTION_KEY),
    })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({
      name: "Progetto deep dive",
      slug: `dd-${randomUUID()}`,
      ingestionKey: randomUUID(),
      ...(opts.aiProviderId ? { aiProviderId: opts.aiProviderId } : {}),
    })
    .returning();
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: "Repo deep dive",
      slug: `repo-${randomUUID()}`,
      provider: "github",
      gitAccountId: account!.id,
      repoUrl: "https://example.com/owner/repo",
      defaultBranch: "main",
    })
    .returning();
  return { projectId: project!.id, repositoryId: repository!.id };
}

async function createItem(
  db: Db,
  projectId: string,
  opts: { document?: string; status?: "new" | "refining" | "ready" | "archived" } = {},
): Promise<string> {
  const [item] = await db
    .insert(backlogItems)
    .values({
      projectId,
      title: "Idea da approfondire",
      document: opts.document ?? "## Contesto\nx\n## Cosa fare\ny",
      source: "manual",
      ...(opts.status ? { status: opts.status } : {}),
    })
    .returning({ id: backlogItems.id });
  return item!.id;
}

/** Job deep_dive fittizio (il poller ha già reclamato). */
function fakeJob(projectId: string): BacklogJob {
  return {
    id: randomUUID(),
    projectId,
    kind: "deep_dive",
    status: "running",
    payload: { itemId: randomUUID(), repositoryId: randomUUID() },
    attempts: 1,
    error: null,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
  };
}

const DEEP_DIVE_JSON = JSON.stringify({
  analysis: "Fattibile. Toccare `src/foo.ts`. Rischio sul modulo bar.",
  suggested: { effort: 4, risk: "high", riskNote: "modulo bar fragile", urgency: "medium", reason: "visto il codice" },
});

describe("upsertAnalysisSection (pura)", () => {
  it("appende la sezione se assente", () => {
    const out = upsertAnalysisSection("## Contesto\nx", "corpo analisi");
    expect(out).toBe("## Contesto\nx\n\n## Analisi tecnica\n\ncorpo analisi");
  });

  it("appende su documento vuoto senza righe iniziali vuote", () => {
    expect(upsertAnalysisSection("", "a")).toBe("## Analisi tecnica\n\na");
  });

  it("SOSTITUISCE la sezione esistente preservando ciò che segue", () => {
    const doc = "## Contesto\nx\n\n## Analisi tecnica\n\nvecchia\n\n## Punti aperti\nz";
    const out = upsertAnalysisSection(doc, "nuova");
    expect(out).toBe("## Contesto\nx\n\n## Analisi tecnica\n\nnuova\n\n## Punti aperti\nz");
  });

  it("sostituisce fino a fine documento se è l'ultima sezione", () => {
    const doc = "## Contesto\nx\n\n## Analisi tecnica\n\nvecchia";
    expect(upsertAnalysisSection(doc, "nuova")).toBe("## Contesto\nx\n\n## Analisi tecnica\n\nnuova");
  });

  it("le intestazioni ### interne NON chiudono la sezione", () => {
    const doc = "## Analisi tecnica\n\nvecchia\n\n### Dettaglio\ndd";
    expect(upsertAnalysisSection(doc, "nuova")).toBe("## Analisi tecnica\n\nnuova");
  });
});

describe("runDeepDive — successo", () => {
  it("appende l'analisi, salva suggested, aggiunge il system message e passa il provider", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, { document: "## Contesto\nx" });
    const runner = fakeRunner(DEEP_DIVE_JSON);
    const mirrors = fakeMirrors();

    await runDeepDive(
      makeDeps(db, { runner, mirrors, loadProviderChainFn: async () => [FAKE_PROVIDER] }),
      fakeJob(projectId),
      { itemId, repositoryId },
    );

    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.id, itemId));
    expect(item!.document).toContain("## Analisi tecnica");
    expect(item!.document).toContain("Toccare `src/foo.ts`");
    expect(item!.document.startsWith("## Contesto\nx")).toBe(true);
    expect(item!.suggested).toEqual({
      effort: 4,
      risk: "high",
      riskNote: "modulo bar fragile",
      urgency: "medium",
      reason: "visto il codice",
    });
    expect(item!.status).toBe("new"); // status invariato

    // Worktree montato allo sha di HEAD risolto dal mirror.
    expect(mirrors.shaSeen).toBe(HEAD_SHA);
    // Provider (chain[0]) passato al runner, plan mode.
    expect(runner.calls[0]!.provider).toEqual(FAKE_PROVIDER);
    expect(runner.calls[0]!.permissionMode).toBe("plan");

    // Messaggio system in chat, i18n (lingua d'istanza 'en'), col nome del repo.
    const [msg] = await db
      .select()
      .from(backlogChatMessages)
      .where(eq(backlogChatMessages.itemId, itemId));
    expect(msg!.role).toBe("system");
    expect(msg!.content).toContain("Technical analysis completed");
    expect(msg!.content).toContain("Repo deep dive");
  });

  it("SOSTITUISCE la sezione al secondo run (idempotente sul documento)", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, { document: "## Contesto\nx" });
    const job = fakeJob(projectId);

    await runDeepDive(makeDeps(db, { runner: fakeRunner(DEEP_DIVE_JSON) }), job, {
      itemId,
      repositoryId,
    });
    const second = JSON.stringify({ analysis: "SECONDA analisi", suggested: {} });
    await runDeepDive(makeDeps(db, { runner: fakeRunner(second) }), job, { itemId, repositoryId });

    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.id, itemId));
    // Una sola sezione Analisi tecnica, col contenuto del secondo run.
    expect(item!.document.match(/## Analisi tecnica/g)).toHaveLength(1);
    expect(item!.document).toContain("SECONDA analisi");
    expect(item!.document).not.toContain("Toccare `src/foo.ts`");
    // suggested vuoto → azzerato.
    expect(item!.suggested).toBeNull();
  });
});

describe("runDeepDive — no-op e fallimenti", () => {
  it("voce archiviata → no-op, agente mai invocato", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, { status: "archived" });
    const runner = fakeRunner(DEEP_DIVE_JSON);

    await runDeepDive(makeDeps(db, { runner }), fakeJob(projectId), { itemId, repositoryId });

    expect(runner.run).not.toHaveBeenCalled();
    const [msg] = await db
      .select()
      .from(backlogChatMessages)
      .where(eq(backlogChatMessages.itemId, itemId));
    expect(msg).toBeUndefined();
  });

  it("voce inesistente → no-op", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const runner = fakeRunner(DEEP_DIVE_JSON);

    await runDeepDive(makeDeps(db, { runner }), fakeJob(projectId), {
      itemId: randomUUID(),
      repositoryId,
    });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("repository di un ALTRO progetto → MalformedBacklogPayloadError (no retry)", async () => {
    const db = testDb.db;
    const a = await createProjectWithRepo(db);
    const b = await createProjectWithRepo(db);
    const itemId = await createItem(db, a.projectId);

    // Job del progetto A ma repo del progetto B.
    await expect(
      runDeepDive(makeDeps(db, {}), fakeJob(a.projectId), {
        itemId,
        repositoryId: b.repositoryId,
      }),
    ).rejects.toThrow(MalformedBacklogPayloadError);
  });

  it("repository inesistente → MalformedBacklogPayloadError (no retry)", async () => {
    const db = testDb.db;
    const { projectId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);

    await expect(
      runDeepDive(makeDeps(db, {}), fakeJob(projectId), {
        itemId,
        repositoryId: randomUUID(),
      }),
    ).rejects.toThrow(MalformedBacklogPayloadError);
  });

  it("output malformato → throw (retry), documento e suggested invariati", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, { document: "## Contesto\nx" });

    await expect(
      runDeepDive(makeDeps(db, { runner: fakeRunner("non è JSON") }), fakeJob(projectId), {
        itemId,
        repositoryId,
      }),
    ).rejects.toThrow(/non parsabile/);

    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.id, itemId));
    expect(item!.document).toBe("## Contesto\nx");
    expect(item!.suggested).toBeNull();
  });

  it("agente exit ≠ 0 → throw (retry)", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);

    await expect(
      runDeepDive(makeDeps(db, { runner: fakeRunner(DEEP_DIVE_JSON, 1) }), fakeJob(projectId), {
        itemId,
        repositoryId,
      }),
    ).rejects.toThrow(/exit 1/);
  });

  it("errore del mirror → throw (retry)", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);

    await expect(
      runDeepDive(makeDeps(db, { mirrors: fakeMirrors({ mirrorError: true }) }), fakeJob(projectId), {
        itemId,
        repositoryId,
      }),
    ).rejects.toThrow(/mirror irraggiungibile/);
  });
});
