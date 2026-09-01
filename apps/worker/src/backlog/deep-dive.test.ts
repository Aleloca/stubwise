import {
  aiProviders,
  backlogChatMessages,
  backlogItems,
  encrypt,
  gitAccounts,
  plugins,
  projectPlugins,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "../agent/runner.js";
import { basePluginPath } from "../plugins/base.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { normalizeAnalysisHeadings, runDeepDive, upsertAnalysisSection } from "./deep-dive.js";
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

/** Ripuliture registrate dai test (volumi finti dei plugin). */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/**
 * Plugin `ready` materializzato su un finto volume e abilitato sul progetto.
 * Ritorna la radice del volume e lo slug; la dir temporanea è ripulita da
 * `cleanups`. Gemello identico in chat-turn.test.ts: i due file duplicano già i
 * propri fake (mirrors, progetto+repo, logger) e restano leggibili da soli.
 */
async function seedEnabledPlugin(
  db: Db,
  projectId: string,
): Promise<{ pluginsDir: string; slug: string }> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-plugin-backlog-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const pluginsDir = join(root, "plugins");
  const slug = "plugin-backlog";
  const sha = "a".repeat(40);
  const dir = join(pluginsDir, slug, sha);
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "demo" }),
    "utf8",
  );
  await mkdir(join(dir, "skills", "alpha"), { recursive: true });
  await writeFile(join(dir, "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\n", "utf8");
  const [row] = await db
    .insert(plugins)
    .values({
      slug,
      name: "demo",
      sourceUrl: "https://example.com/org/demo.git",
      ref: "main",
      resolvedSha: sha,
      status: "ready",
      inventory: {
        name: "demo",
        skills: [{ name: "alpha", bytes: 10 }],
        commands: [],
        agents: [],
        hooks: [],
        hasMcp: false,
      },
      materializedAt: new Date(),
    })
    .returning({ id: plugins.id });
  await db
    .insert(projectPlugins)
    .values({ projectId, pluginId: row!.id, disabledSkills: ["alpha"] });
  cleanups.push(async () => {
    await db.delete(plugins);
  });
  return { pluginsDir, slug };
}

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
    resultItemId: null,
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

  it("normalizeAnalysisHeadings retrocede i ## a ### e lascia i ###+ intatti", () => {
    expect(normalizeAnalysisHeadings("## Rischi\nx\n### Dettaglio\ny\n#### Micro\nz")).toBe(
      "### Rischi\nx\n### Dettaglio\ny\n#### Micro\nz",
    );
    // Un "##" in mezzo alla riga (non a inizio riga) non viene toccato.
    expect(normalizeAnalysisHeadings("testo con ## in mezzo")).toBe("testo con ## in mezzo");
  });

  it("analisi con ## interni: normalizzata al primo upsert, il secondo la sostituisce SENZA sezioni fantasma", () => {
    const doc = "## Contesto\nx\n\n## Punti aperti\nz";
    // Analisi "maleducata" con sottotitoli di livello 2: senza normalizzazione il
    // secondo upsert chiuderebbe la sezione al primo ## interno lasciando orfani.
    const first = upsertAnalysisSection(doc, "intro\n\n## Rischi\nr\n\n## Nodi aperti\nn");
    // I ## interni sono stati retrocessi a ###: la sezione (appesa in fondo) è
    // un blocco unico, senza nuove intestazioni di livello 2.
    expect(first).toContain("### Rischi");
    expect(first).toContain("### Nodi aperti");
    expect(first.match(/^## .*/gm)).toEqual([
      "## Contesto",
      "## Punti aperti",
      "## Analisi tecnica",
    ]);

    const second = upsertAnalysisSection(first, "SOLO nuova analisi");
    // Nessuna sezione fantasma: la vecchia analisi (sottotitoli compresi) è sparita
    // per intero e il resto del documento è intatto.
    expect(second).toBe(
      "## Contesto\nx\n\n## Punti aperti\nz\n\n## Analisi tecnica\n\nSOLO nuova analisi",
    );
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

  it("i plugin abilitati sul progetto arrivano al run (base per primo, deny rule, copia liberata)", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, { document: "## Contesto\nx" });
    const { pluginsDir, slug } = await seedEnabledPlugin(db, projectId);
    const runner = fakeRunner(DEEP_DIVE_JSON);

    await runDeepDive(makeDeps(db, { runner, pluginsDir }), fakeJob(projectId), {
      itemId,
      repositoryId,
    });

    const call = runner.calls[0]!;
    expect(call.pluginDirs?.[0]).toBe(basePluginPath());
    expect(call.pluginDirs?.[1]).toMatch(new RegExp(`/plugins/${slug}$`));
    expect(call.pluginDirs?.[1]).not.toContain(pluginsDir);
    expect(call.disallowedTools).toEqual(["Skill(demo:alpha)"]);
    expect(call.settingSources).toBe("");
    // La copia sparisce con la fine del run.
    expect(existsSync(call.pluginDirs![1]!)).toBe(false);
  });

  it("senza plugin abilitati il run resta identico a prima (nessun flag)", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, {});
    const runner = fakeRunner(DEEP_DIVE_JSON);

    await runDeepDive(
      makeDeps(db, { runner, pluginsDir: join(tmpdir(), "stubwise-plugins-inesistente") }),
      fakeJob(projectId),
      { itemId, repositoryId },
    );

    expect(runner.calls[0]!.pluginDirs).toBeUndefined();
    expect(runner.calls[0]!.settingSources).toBeUndefined();
  });

  it("una modifica dell'utente DURANTE il run sopravvive (upsert sul documento fresco, no lost update)", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, { document: "## Contesto\nORIGINALE" });

    // Runner che simula un refresh-document dell'utente MENTRE l'agente gira:
    // aggiorna il documento in DB e poi restituisce l'esito del deep dive. Il
    // documento passato nel prompt è quello stantio, ma la scrittura finale deve
    // partire dal valore FRESCO (ri-letto con FOR UPDATE nella transazione).
    const runner: AgentRunner = {
      run: vi.fn(async () => {
        await db
          .update(backlogItems)
          .set({ document: "## Contesto\nMODIFICATO DALL'UTENTE" })
          .where(eq(backlogItems.id, itemId));
        return { output: DEEP_DIVE_JSON, exitCode: 0 } satisfies AgentRunResult;
      }),
    };

    await runDeepDive(makeDeps(db, { runner }), fakeJob(projectId), { itemId, repositoryId });

    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.id, itemId));
    // La modifica dell'utente NON è stata annullata e la sezione analisi c'è.
    expect(item!.document).toContain("MODIFICATO DALL'UTENTE");
    expect(item!.document).not.toContain("ORIGINALE");
    expect(item!.document).toContain("## Analisi tecnica");
  });

  it("voce ARCHIVIATA durante il run → esito scartato, nessuna scrittura", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, { document: "## Contesto\nx" });

    // L'utente archivia la voce mentre l'agente gira: l'esito non serve più.
    const runner: AgentRunner = {
      run: vi.fn(async () => {
        await db
          .update(backlogItems)
          .set({ status: "archived" })
          .where(eq(backlogItems.id, itemId));
        return { output: DEEP_DIVE_JSON, exitCode: 0 } satisfies AgentRunResult;
      }),
    };

    await runDeepDive(makeDeps(db, { runner }), fakeJob(projectId), { itemId, repositoryId });

    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.id, itemId));
    expect(item!.document).toBe("## Contesto\nx"); // intatto
    expect(item!.suggested).toBeNull();
    const messages = await db
      .select()
      .from(backlogChatMessages)
      .where(eq(backlogChatMessages.itemId, itemId));
    expect(messages).toHaveLength(0); // niente system message
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
