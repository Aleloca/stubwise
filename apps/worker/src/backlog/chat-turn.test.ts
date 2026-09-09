import {
  backlogChatMessages,
  backlogCodeSessions,
  backlogItems,
  backlogQuestions,
  encrypt,
  gitAccounts,
  plugins,
  projectPlugins,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { asc, eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "../agent/fake.js";
import { AgentTimeoutError, type AgentRunResult, type AgentRunner } from "../agent/runner.js";
import { ASK_USER_FILENAME, planParentDir } from "../pipeline/ask-user.js";
import { basePluginPath } from "../plugins/base.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { runChatTurn, type ChatTurnDeps } from "./chat-turn.js";
import { createCodeSessionRegistry } from "./code-session.js";
import type { BacklogJob } from "./poller.js";

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects); // repos/items/sessions/messages cascano.
  await testDb.db.delete(gitAccounts);
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
 * `cleanups`. Gemello identico in deep-dive.test.ts: i due file duplicano già i
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

/** Fake MirrorManager: openWorktree conta le aperture e restituisce una dir finta
 * + un remove() spia. */
function fakeMirrors(): ChatTurnDeps["mirrors"] & {
  readonly opens: number;
  readonly removes: number;
  readonly lastBranch: string | null;
} {
  const state = { opens: 0, removes: 0, lastBranch: null as string | null };
  return {
    get opens() {
      return state.opens;
    },
    get removes() {
      return state.removes;
    },
    get lastBranch() {
      return state.lastBranch;
    },
    openWorktree: (async (_p: unknown, branchName: string) => {
      state.opens++;
      state.lastBranch = branchName;
      return {
        dir: `/tmp/fake-wt-${state.opens}`,
        remove: async () => {
          state.removes++;
        },
      };
    }) as ChatTurnDeps["mirrors"]["openWorktree"],
  } as ChatTurnDeps["mirrors"] & {
    readonly opens: number;
    readonly removes: number;
    readonly lastBranch: string | null;
  };
}

function makeDeps(
  db: Db,
  overrides: Partial<ChatTurnDeps> & { mirrors?: ChatTurnDeps["mirrors"] } = {},
): ChatTurnDeps {
  return {
    db,
    runner: new FakeAgentRunner(),
    mirrors: overrides.mirrors ?? fakeMirrors(),
    // Serializer no-op (esegue subito): la serializzazione è coperta dal poller test.
    serializer: { run: (_p, task) => task() },
    registry: createCodeSessionRegistry(),
    logger: silentLogger,
    encryptionKey: ENCRYPTION_KEY,
    maxTurns: 15,
    timeoutMs: 1000,
    loadProviderChainFn: async () => [],
    ...overrides,
  };
}

async function createProjectWithRepo(
  db: Db,
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
    .values({ name: "Progetto chat", slug: `ct-${randomUUID()}`, ingestionKey: randomUUID() })
    .returning();
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: "Repo chat",
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
  opts: { document?: string; status?: "new" | "refining" | "ready" | "archived" | "converted" } = {},
): Promise<string> {
  const [item] = await db
    .insert(backlogItems)
    .values({
      projectId,
      title: "Voce in chat",
      document: opts.document ?? "## Contesto\nDETTAGLIO_DOCUMENTO",
      source: "manual",
      ...(opts.status ? { status: opts.status } : {}),
    })
    .returning({ id: backlogItems.id });
  return item!.id;
}

async function createSession(
  db: Db,
  itemId: string,
  repositoryId: string,
  opts: { status?: "active" | "closed"; cliSessionId?: string } = {},
): Promise<string> {
  const [session] = await db
    .insert(backlogCodeSessions)
    .values({
      itemId,
      repositoryId,
      status: opts.status ?? "active",
      ...(opts.cliSessionId ? { cliSessionId: opts.cliSessionId } : {}),
    })
    .returning({ id: backlogCodeSessions.id });
  return session!.id;
}

async function addUserMessage(db: Db, itemId: string, content: string): Promise<string> {
  const [msg] = await db
    .insert(backlogChatMessages)
    .values({ itemId, role: "user", content })
    .returning({ id: backlogChatMessages.id });
  return msg!.id;
}

async function messagesOf(db: Db, itemId: string) {
  return db
    .select({ role: backlogChatMessages.role, content: backlogChatMessages.content })
    .from(backlogChatMessages)
    .where(eq(backlogChatMessages.itemId, itemId))
    .orderBy(asc(backlogChatMessages.createdAt), asc(backlogChatMessages.id));
}

/**
 * Entry FINTA del server MCP `ask_user`: al worker basta che il file ESISTA
 * per cablare il tool (non lo esegue mai qui — è il claude CLI a lanciarlo, e
 * nei test il runner è finto). Gemella di `fakeAskUserEntry` in
 * `pipeline/fix.test.ts`.
 */
async function fakeAskUserEntry(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ask-user-entry-backlog-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const entry = join(dir, "index.js");
  await writeFile(entry, "// server MCP finto\n");
  return entry;
}

/**
 * Runner che si comporta come il CLI quando il modello chiama `ask_user`:
 * scrive il file-bridge nel path ESATTO che il worker gli comunica via env
 * (indipendente dalla cwd del run — a differenza del fix, qui cwd è il
 * worktree della sessione, non la parent dir del bridge), e ritorna
 * output/sessionId dati.
 */
function questionRunner(
  jobId: string,
  content: string | object,
  result: { output?: string; sessionId?: string } = {},
): FakeAgentRunner {
  return new FakeAgentRunner({
    script: async () => {
      await writeFile(
        join(planParentDir(jobId), ASK_USER_FILENAME),
        typeof content === "string" ? content : JSON.stringify(content),
      );
      return {
        output: result.output ?? "",
        exitCode: 0,
        ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
      };
    },
  });
}

async function questionsOf(db: Db, itemId: string) {
  return db.select().from(backlogQuestions).where(eq(backlogQuestions.backlogItemId, itemId));
}

function job(
  projectId: string,
  payload:
    | { itemId: string; userMessageId: string; sessionId: string }
    | { itemId: string; answeredQuestionId: string; sessionId: string },
): BacklogJob {
  return {
    id: randomUUID(),
    projectId,
    kind: "chat_turn",
    status: "running",
    payload,
    attempts: 1,
    error: null,
    resultItemId: null,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
  };
}

const FAKE_PROVIDER: ResolvedProvider = { id: "prov-1", kind: "api_key", secret: "sk-fake" };

describe("runChatTurn — primo turno (priming)", () => {
  it("apre il worktree nel serializer, prima col priming, salva assistant + cli_session_id", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, { document: "## Contesto\nDETTAGLIO_DOCUMENTO" });
    const sessionId = await createSession(db, itemId, repositoryId);
    const userMessageId = await addUserMessage(db, itemId, "Come funziona il login?");

    const runner = new FakeAgentRunner({
      results: [{ output: "Il login usa src/auth.ts", exitCode: 0, sessionId: "cli-sess-1" }],
    });
    const mirrors = fakeMirrors();
    const registry = createCodeSessionRegistry();
    let serializerCalls = 0;
    const serializer = {
      run: <T>(_p: string, task: () => Promise<T>) => {
        serializerCalls++;
        return task();
      },
    };

    await runChatTurn(
      makeDeps(db, { runner, mirrors, registry, serializer, loadProviderChainFn: async () => [FAKE_PROVIDER] }),
      job(projectId, { itemId, userMessageId, sessionId }),
      { itemId, userMessageId, sessionId },
    );

    // Worktree aperto UNA volta, DENTRO il serializer, su un branch stubwise/*.
    expect(mirrors.opens).toBe(1);
    expect(serializerCalls).toBe(1);
    expect(mirrors.lastBranch).toBe(`stubwise/backlog-code-${sessionId}`);

    // Run in plan mode, SENZA resume (primo turno), col priming (documento + domanda).
    const call = runner.calls[0]!;
    expect(call.permissionMode).toBe("plan");
    expect(call.resumeSessionId).toBeUndefined();
    expect(call.provider).toEqual(FAKE_PROVIDER);
    expect(call.prompt).toContain("DETTAGLIO_DOCUMENTO");
    expect(call.prompt).toContain("Come funziona il login?");
    expect(call.cwd).toBe("/tmp/fake-wt-1");

    // Risposta assistant persistita.
    const msgs = await messagesOf(db, itemId);
    expect(msgs).toEqual([
      { role: "user", content: "Come funziona il login?" },
      { role: "assistant", content: "Il login usa src/auth.ts" },
    ]);

    // cli_session_id salvato in DB e nel registro.
    const [session] = await db.select().from(backlogCodeSessions).where(eq(backlogCodeSessions.id, sessionId));
    expect(session!.cliSessionId).toBe("cli-sess-1");
    expect(registry.get(itemId)?.cliSessionId).toBe("cli-sess-1");
  });
  it("i plugin abilitati sul progetto arrivano al turno (base per primo, deny rule, copia liberata)", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, { document: "## Contesto\nDOC" });
    const sessionId = await createSession(db, itemId, repositoryId);
    const userMessageId = await addUserMessage(db, itemId, "Dove sta il login?");
    const { pluginsDir, slug } = await seedEnabledPlugin(db, projectId);
    const runner = new FakeAgentRunner({ results: [{ output: "risposta", exitCode: 0 }] });

    await runChatTurn(
      makeDeps(db, { runner, pluginsDir }),
      job(projectId, { itemId, userMessageId, sessionId }),
      { itemId, userMessageId, sessionId },
    );

    const call = runner.calls[0]!;
    expect(call.pluginDirs?.[0]).toBe(basePluginPath());
    expect(call.pluginDirs?.[1]).toMatch(new RegExp(`/plugins/${slug}$`));
    expect(call.pluginDirs?.[1]).not.toContain(pluginsDir);
    expect(call.disallowedTools).toEqual(["Skill(demo:alpha)"]);
    expect(call.settingSources).toBe("");
    expect(existsSync(call.pluginDirs![1]!)).toBe(false);
  });

  it("senza plugin abilitati il turno resta identico a prima (nessun flag)", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, {});
    const sessionId = await createSession(db, itemId, repositoryId);
    const userMessageId = await addUserMessage(db, itemId, "?");
    const runner = new FakeAgentRunner({ results: [{ output: "ok", exitCode: 0 }] });

    await runChatTurn(
      makeDeps(db, { runner, pluginsDir: join(tmpdir(), "stubwise-plugins-inesistente") }),
      job(projectId, { itemId, userMessageId, sessionId }),
      { itemId, userMessageId, sessionId },
    );

    expect(runner.calls[0]!.pluginDirs).toBeUndefined();
    expect(runner.calls[0]!.settingSources).toBeUndefined();
  });
});

describe("runChatTurn — turno successivo (resume)", () => {
  it("riusa il worktree e passa --resume col cli_session_id, prompt = sola domanda", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, { document: "## Contesto\nDOC" });
    const sessionId = await createSession(db, itemId, repositoryId);
    const mirrors = fakeMirrors();
    const registry = createCodeSessionRegistry();

    // Primo turno (priming) → sessione CLI "cli-1".
    const um1 = await addUserMessage(db, itemId, "Prima domanda");
    const runner = new FakeAgentRunner({
      results: [
        { output: "Prima risposta", exitCode: 0, sessionId: "cli-1" },
        { output: "Seconda risposta", exitCode: 0, sessionId: "cli-1" },
      ],
    });
    const deps = makeDeps(db, { runner, mirrors, registry });
    await runChatTurn(deps, job(projectId, { itemId, userMessageId: um1, sessionId }), {
      itemId,
      userMessageId: um1,
      sessionId,
    });

    // Secondo turno → resume.
    const um2 = await addUserMessage(db, itemId, "Seconda domanda specifica");
    await runChatTurn(deps, job(projectId, { itemId, userMessageId: um2, sessionId }), {
      itemId,
      userMessageId: um2,
      sessionId,
    });

    // Worktree aperto UNA sola volta (riuso).
    expect(mirrors.opens).toBe(1);
    // Secondo run: resume col session id, prompt = SOLO la domanda (niente documento).
    const second = runner.calls[1]!;
    expect(second.resumeSessionId).toBe("cli-1");
    expect(second.prompt).toBe("Seconda domanda specifica");
    expect(second.prompt).not.toContain("DOC");

    const msgs = await messagesOf(db, itemId);
    expect(msgs.map((m) => m.content)).toEqual([
      "Prima domanda",
      "Prima risposta",
      "Seconda domanda specifica",
      "Seconda risposta",
    ]);
  });
});

describe("runChatTurn — no-op morbido", () => {
  it("sessione closed → no-op: agente mai invocato, nessuna risposta", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);
    const sessionId = await createSession(db, itemId, repositoryId, { status: "closed" });
    const userMessageId = await addUserMessage(db, itemId, "Domanda");
    const runner = new FakeAgentRunner();

    await runChatTurn(makeDeps(db, { runner }), job(projectId, { itemId, userMessageId, sessionId }), {
      itemId,
      userMessageId,
      sessionId,
    });

    expect(runner.calls).toHaveLength(0);
    expect((await messagesOf(db, itemId)).filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  it("payload che punta alla sessione VECCHIA (chiusa e riaperta) → no-op, non risponde nella nuova", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);
    const oldSession = await createSession(db, itemId, repositoryId, { status: "closed" });
    // Nuova sessione active sullo stesso item.
    await createSession(db, itemId, repositoryId, { status: "active" });
    const userMessageId = await addUserMessage(db, itemId, "Domanda");
    const runner = new FakeAgentRunner();

    await runChatTurn(
      makeDeps(db, { runner }),
      job(projectId, { itemId, userMessageId, sessionId: oldSession }),
      { itemId, userMessageId, sessionId: oldSession },
    );

    expect(runner.calls).toHaveLength(0);
    expect((await messagesOf(db, itemId)).filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  it("sessione chiusa nel frattempo → rimuove il worktree della SUA sessione dal registro", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);
    const sessionId = await createSession(db, itemId, repositoryId, { status: "closed" });
    const userMessageId = await addUserMessage(db, itemId, "Domanda");
    const registry = createCodeSessionRegistry();
    // Worktree in registro appartenente a QUESTA sessione (ora chiusa).
    let removed = 0;
    registry.set(itemId, {
      sessionId,
      repositoryId,
      dir: "/tmp/wt",
      cliSessionId: "cli-x",
      remove: async () => {
        removed++;
      },
    });
    const runner = new FakeAgentRunner();

    await runChatTurn(makeDeps(db, { runner, registry }), job(projectId, { itemId, userMessageId, sessionId }), {
      itemId,
      userMessageId,
      sessionId,
    });

    expect(runner.calls).toHaveLength(0);
    expect(removed).toBe(1);
    expect(registry.get(itemId)).toBeUndefined();
  });

  it("itemId del payload diverso da quello della sessione → no-op", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemA = await createItem(db, projectId);
    const itemB = await createItem(db, projectId);
    const sessionA = await createSession(db, itemA, repositoryId);
    const userMessageId = await addUserMessage(db, itemB, "Domanda");
    const runner = new FakeAgentRunner();

    await runChatTurn(
      makeDeps(db, { runner }),
      job(projectId, { itemId: itemB, userMessageId, sessionId: sessionA }),
      { itemId: itemB, userMessageId, sessionId: sessionA },
    );

    expect(runner.calls).toHaveLength(0);
  });
});

describe("runChatTurn — errore/timeout → messaggio di errore + throw (failed no-retry)", () => {
  it("agente exit ≠ 0 → messaggio assistant di errore + throw", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);
    const sessionId = await createSession(db, itemId, repositoryId);
    const userMessageId = await addUserMessage(db, itemId, "Domanda");
    const runner = new FakeAgentRunner({ output: "crash", exitCode: 1 });

    await expect(
      runChatTurn(makeDeps(db, { runner }), job(projectId, { itemId, userMessageId, sessionId }), {
        itemId,
        userMessageId,
        sessionId,
      }),
    ).rejects.toThrow(/exit 1/);

    const assistant = (await messagesOf(db, itemId)).filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.content).toContain("failed"); // i18n en: "...run failed..."
  });

  it("timeout del runner → messaggio assistant di errore + throw", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);
    const sessionId = await createSession(db, itemId, repositoryId);
    const userMessageId = await addUserMessage(db, itemId, "Domanda");
    const runner: AgentRunner = {
      run: async (): Promise<AgentRunResult> => {
        throw new AgentTimeoutError(1000, "parziale");
      },
    };

    await expect(
      runChatTurn(makeDeps(db, { runner }), job(projectId, { itemId, userMessageId, sessionId }), {
        itemId,
        userMessageId,
        sessionId,
      }),
    ).rejects.toThrow(AgentTimeoutError);

    const assistant = (await messagesOf(db, itemId)).filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.content).toContain("failed");
  });
});

describe("runChatTurn — ri-bootstrap dopo registro vuoto (riavvio del worker)", () => {
  it("registro vuoto ⇒ riapre il worktree e RI-PRIMING (no resume) con la storia dal DB", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, { document: "## Contesto\nDOC" });
    // Sessione con un cli_session_id GIÀ persistito da un turno precedente + storia.
    const sessionId = await createSession(db, itemId, repositoryId, { cliSessionId: "cli-vecchio" });
    await addUserMessage(db, itemId, "Domanda precedente");
    await db.insert(backlogChatMessages).values({ itemId, role: "assistant", content: "Risposta precedente" });
    const userMessageId = await addUserMessage(db, itemId, "Nuova domanda");

    // Registro VUOTO (come dopo un riavvio): l'handle in-memoria è perso.
    const mirrors = fakeMirrors();
    const runner = new FakeAgentRunner({
      results: [{ output: "Risposta post-riavvio", exitCode: 0, sessionId: "cli-nuovo" }],
    });
    await runChatTurn(
      makeDeps(db, { runner, mirrors, registry: createCodeSessionRegistry() }),
      job(projectId, { itemId, userMessageId, sessionId }),
      { itemId, userMessageId, sessionId },
    );

    // Worktree riaperto e run SENZA resume (nuova sessione CLI), col priming che
    // include la storia recente dal DB.
    expect(mirrors.opens).toBe(1);
    const call = runner.calls[0]!;
    expect(call.resumeSessionId).toBeUndefined();
    expect(call.prompt).toContain("DOC");
    expect(call.prompt).toContain("Domanda precedente");
    expect(call.prompt).toContain("Risposta precedente");
    expect(call.prompt).toContain("Nuova domanda");

    // cli_session_id AGGIORNATO al nuovo id.
    const [session] = await db.select().from(backlogCodeSessions).where(eq(backlogCodeSessions.id, sessionId));
    expect(session!.cliSessionId).toBe("cli-nuovo");
  });
});

describe("runChatTurn — fallback session_id assente", () => {
  it("priming senza session_id → il turno successivo ri-primerà (no resume)", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, { document: "## Contesto\nDOC" });
    const sessionId = await createSession(db, itemId, repositoryId);
    const mirrors = fakeMirrors();
    const registry = createCodeSessionRegistry();
    // Nessun sessionId nel risultato del CLI (versione vecchia / non riportato).
    const runner = new FakeAgentRunner({
      results: [
        { output: "R1", exitCode: 0 },
        { output: "R2", exitCode: 0 },
      ],
    });
    const deps = makeDeps(db, { runner, mirrors, registry });

    const um1 = await addUserMessage(db, itemId, "Q1");
    await runChatTurn(deps, job(projectId, { itemId, userMessageId: um1, sessionId }), {
      itemId,
      userMessageId: um1,
      sessionId,
    });
    // cli_session_id resta null (fallback).
    expect(registry.get(itemId)?.cliSessionId).toBeNull();

    const um2 = await addUserMessage(db, itemId, "Q2");
    await runChatTurn(deps, job(projectId, { itemId, userMessageId: um2, sessionId }), {
      itemId,
      userMessageId: um2,
      sessionId,
    });
    // Secondo turno: ancora priming (no resume), worktree riusato.
    expect(mirrors.opens).toBe(1);
    expect(runner.calls[1]!.resumeSessionId).toBeUndefined();
    expect(runner.calls[1]!.prompt).toContain("DOC");
  });
});

describe("runChatTurn — tool ask_user (fase 7, Task 6)", () => {
  const QUESTION = {
    question: "Import CSV o form manuale?",
    options: [
      { label: "Import CSV", consequence: "Serve un file già pronto" },
      { label: "Form manuale" },
    ],
    recommendedIndex: 0,
    allowFreeText: true,
  };

  it("turno che pone una domanda: riga in backlog_questions + messaggio in chat, nessuna risposta in prosa", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);
    const sessionId = await createSession(db, itemId, repositoryId);
    const userMessageId = await addUserMessage(db, itemId, "Come dovremmo importare gli ordini?");
    const chatJob = job(projectId, { itemId, userMessageId, sessionId });
    const runner = questionRunner(chatJob.id, QUESTION, { sessionId: "cli-q1" });

    await runChatTurn(
      makeDeps(db, { runner, askUserServerPath: await fakeAskUserEntry() }),
      chatJob,
      { itemId, userMessageId, sessionId },
    );

    // Il tool era cablato: mcpConfig con l'env del round/tetto.
    const call = runner.calls[0]!;
    expect(call.mcpConfig?.servers.stubwise_ask?.env?.ASK_USER_ROUND).toBe("1");
    expect(call.allowedTools).toContain("mcp__stubwise_ask__ask_user");

    const questions = await questionsOf(db, itemId);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.question).toBe(QUESTION.question);
    expect(questions[0]?.options).toEqual(QUESTION.options);
    expect(questions[0]?.recommendedIndex).toBe(0);
    expect(questions[0]?.answeredAt).toBeNull();
    expect(questions[0]?.dismissedAt).toBeNull();

    // Il messaggio in chat la referenzia (testo della domanda + opzioni),
    // NON una risposta in prosa generica.
    const msgs = await messagesOf(db, itemId);
    const assistantMsg = msgs.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toContain(QUESTION.question);
    expect(assistantMsg?.content).toContain("Import CSV");

    // La sessione CLI resta viva per la ripresa.
    const [session] = await db.select().from(backlogCodeSessions).where(eq(backlogCodeSessions.id, sessionId));
    expect(session!.cliSessionId).toBe("cli-q1");
  });

  it("domanda + testo nello stesso turno: vince la domanda, il testo viene scartato", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);
    const sessionId = await createSession(db, itemId, repositoryId);
    const userMessageId = await addUserMessage(db, itemId, "?");
    const chatJob = job(projectId, { itemId, userMessageId, sessionId });
    const runner = questionRunner(chatJob.id, QUESTION, { output: "Un testo scritto per errore insieme alla domanda" });

    await runChatTurn(
      makeDeps(db, { runner, askUserServerPath: await fakeAskUserEntry() }),
      chatJob,
      { itemId, userMessageId, sessionId },
    );

    const questions = await questionsOf(db, itemId);
    expect(questions).toHaveLength(1);
    const msgs = await messagesOf(db, itemId);
    const assistantMsg = msgs.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).not.toContain("Un testo scritto per errore");
    expect(assistantMsg?.content).toContain(QUESTION.question);
  });

  it("domanda malformata (schema violato): si prosegue in prosa, nessuna riga in backlog_questions", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);
    const sessionId = await createSession(db, itemId, repositoryId);
    const userMessageId = await addUserMessage(db, itemId, "?");
    const chatJob = job(projectId, { itemId, userMessageId, sessionId });
    // Payload SCHEMA-INVALIDO: options con una sola voce (ne servono 2-4).
    const runner = questionRunner(
      chatJob.id,
      { question: "?", options: [{ label: "Solo una" }] },
      { output: "Risposta normale in prosa" },
    );

    await runChatTurn(
      makeDeps(db, { runner, askUserServerPath: await fakeAskUserEntry() }),
      chatJob,
      { itemId, userMessageId, sessionId },
    );

    expect(await questionsOf(db, itemId)).toHaveLength(0);
    const msgs = await messagesOf(db, itemId);
    expect(msgs.find((m) => m.role === "assistant")?.content).toBe("Risposta normale in prosa");
  });

  it("nessuna domanda nel file-bridge (assente): comportamento identico a prima, prosa normale", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);
    const sessionId = await createSession(db, itemId, repositoryId);
    const userMessageId = await addUserMessage(db, itemId, "?");
    const runner = new FakeAgentRunner({ results: [{ output: "Risposta senza domande", exitCode: 0 }] });

    await runChatTurn(
      makeDeps(db, { runner, askUserServerPath: await fakeAskUserEntry() }),
      job(projectId, { itemId, userMessageId, sessionId }),
      { itemId, userMessageId, sessionId },
    );

    expect(await questionsOf(db, itemId)).toHaveLength(0);
    const msgs = await messagesOf(db, itemId);
    expect(msgs.find((m) => m.role === "assistant")?.content).toBe("Risposta senza domande");
  });

  it("una domanda già aperta sulla voce: la nuova viene scartata, si prosegue in prosa", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);
    const sessionId = await createSession(db, itemId, repositoryId);
    // Domanda GIÀ aperta sulla voce (es. posta da un turno precedente, non
    // ancora risposta né "non ora").
    await db.insert(backlogQuestions).values({
      backlogItemId: itemId,
      question: "Domanda già in piedi",
      options: [{ label: "A" }, { label: "B" }],
    });
    const userMessageId = await addUserMessage(db, itemId, "Un nuovo messaggio nel frattempo");
    const chatJob = job(projectId, { itemId, userMessageId, sessionId });
    const runner = questionRunner(chatJob.id, QUESTION, { output: "" });

    await runChatTurn(
      makeDeps(db, { runner, askUserServerPath: await fakeAskUserEntry() }),
      chatJob,
      { itemId, userMessageId, sessionId },
    );

    // Ancora UNA sola domanda aperta: quella nuova non è passata.
    expect(await questionsOf(db, itemId)).toHaveLength(1);
    // Il turno non fallisce: si scrive comunque il messaggio (qui vuoto, il
    // modello aveva già terminato il turno per la domanda scartata).
    const msgs = await messagesOf(db, itemId);
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("voce archiviata MENTRE il turno gira: nessuna domanda scritta, il turno non esplode (fase 7)", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);
    const sessionId = await createSession(db, itemId, repositoryId);
    const userMessageId = await addUserMessage(db, itemId, "Come dovremmo importare gli ordini?");
    const chatJob = job(projectId, { itemId, userMessageId, sessionId });
    // Lo stato è OPEN al controllo di inizio funzione (il turno non farebbe
    // no-op), ma cambia MENTRE l'agente "gira" — simula un'archiviazione
    // arrivata da un'altra richiesta nel mezzo dei minuti di un turno, la
    // stessa forma della corsa già testata per l'ownership in triage.test.ts.
    const runner = new FakeAgentRunner({
      script: async () => {
        await db.update(backlogItems).set({ status: "archived" }).where(eq(backlogItems.id, itemId));
        await writeFile(
          join(planParentDir(chatJob.id), ASK_USER_FILENAME),
          JSON.stringify(QUESTION),
        );
        return { output: "", exitCode: 0, sessionId: "cli-q1" };
      },
    });

    await runChatTurn(
      makeDeps(db, { runner, askUserServerPath: await fakeAskUserEntry() }),
      chatJob,
      { itemId, userMessageId, sessionId },
    );

    // Nessuna riga in backlog_questions: l'INSERT...WHERE EXISTS non ha
    // scritto nulla perché la voce non era più aperta AL MOMENTO dell'insert.
    expect(await questionsOf(db, itemId)).toHaveLength(0);
    // Il turno non fallisce: si scrive comunque il messaggio (prosa, non la
    // domanda scartata).
    const msgs = await messagesOf(db, itemId);
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("il round cablato riflette le domande già poste sulla voce (round 2 dopo una prima)", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId);
    const sessionId = await createSession(db, itemId, repositoryId);
    // Una domanda già risposta in precedenza: conta comunque per il round.
    await db.insert(backlogQuestions).values({
      backlogItemId: itemId,
      question: "Prima domanda",
      options: [{ label: "A" }, { label: "B" }],
      answer: { optionIndex: 0 },
      answeredAt: new Date(),
    });
    const userMessageId = await addUserMessage(db, itemId, "Seconda domanda del turno");
    const chatJob = job(projectId, { itemId, userMessageId, sessionId });
    const runner = new FakeAgentRunner({ results: [{ output: "ok", exitCode: 0 }] });

    await runChatTurn(
      makeDeps(db, { runner, askUserServerPath: await fakeAskUserEntry(), questionMaxRounds: 3 }),
      chatJob,
      { itemId, userMessageId, sessionId },
    );

    const call = runner.calls[0]!;
    expect(call.mcpConfig?.servers.stubwise_ask?.env?.ASK_USER_ROUND).toBe("2");
    expect(call.mcpConfig?.servers.stubwise_ask?.env?.ASK_USER_MAX_ROUNDS).toBe("3");
  });

  it("risposta a una domanda: il turno di ripresa usa --resume e porta la scelta nel prompt", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, { document: "## Contesto\nDOC" });
    const sessionId = await createSession(db, itemId, repositoryId);
    const mirrors = fakeMirrors();
    const registry = createCodeSessionRegistry();

    // Primo turno: pone la domanda e apre la sessione CLI.
    const um1 = await addUserMessage(db, itemId, "Come dovremmo procedere?");
    const firstJob = job(projectId, { itemId, userMessageId: um1, sessionId });
    const askRunner = questionRunner(firstJob.id, QUESTION, { sessionId: "cli-open" });
    const deps = makeDeps(db, { runner: askRunner, mirrors, registry, askUserServerPath: await fakeAskUserEntry() });
    await runChatTurn(deps, firstJob, { itemId, userMessageId: um1, sessionId });
    const [asked] = await questionsOf(db, itemId);

    // La domanda viene risposta (come farebbe answerBacklogQuestion).
    await db
      .update(backlogQuestions)
      .set({ answer: { optionIndex: 0 }, answeredAt: new Date() })
      .where(eq(backlogQuestions.id, asked!.id));

    // Turno di RIPRESA: payload con answeredQuestionId, non userMessageId.
    const resumeRunner = new FakeAgentRunner({ results: [{ output: "Procedo con l'import CSV", exitCode: 0 }] });
    const resumeDeps = makeDeps(db, { runner: resumeRunner, mirrors, registry, askUserServerPath: await fakeAskUserEntry() });
    const resumeJob = job(projectId, { itemId, answeredQuestionId: asked!.id, sessionId });
    await runChatTurn(resumeDeps, resumeJob, { itemId, answeredQuestionId: asked!.id, sessionId });

    expect(mirrors.opens).toBe(1); // worktree riusato
    const call = resumeRunner.calls[0]!;
    expect(call.resumeSessionId).toBe("cli-open");
    expect(call.prompt).toContain(QUESTION.question);
    expect(call.prompt).toContain("Import CSV"); // l'etichetta scelta
    expect(call.prompt).toContain("decisione CHIUSA");

    const msgs = await messagesOf(db, itemId);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "Procedo con l'import CSV")).toBe(true);
  });

  it("risposta con ribootstrap (nessuna sessione CLI da riprendere): priming pieno con la Q&A come domanda corrente", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await createProjectWithRepo(db);
    const itemId = await createItem(db, projectId, { document: "## Contesto\nDOC_RIBOOT" });
    const sessionId = await createSession(db, itemId, repositoryId);
    // Domanda già posta e risposta, ma NESSUNA sessione CLI viva nel registro
    // (come dopo un riavvio del worker: il worktree e la sessione sono persi).
    const [asked] = await db
      .insert(backlogQuestions)
      .values({
        backlogItemId: itemId,
        question: "Serve un rollback?",
        options: [{ label: "Sì" }, { label: "No" }],
        answer: { optionIndex: 1 },
        answeredAt: new Date(),
      })
      .returning();

    const runner = new FakeAgentRunner({ results: [{ output: "Procedo senza rollback", exitCode: 0 }] });
    const resumeJob = job(projectId, { itemId, answeredQuestionId: asked!.id, sessionId });

    await runChatTurn(
      makeDeps(db, { runner, registry: createCodeSessionRegistry() }),
      resumeJob,
      { itemId, answeredQuestionId: asked!.id, sessionId },
    );

    const call = runner.calls[0]!;
    expect(call.resumeSessionId).toBeUndefined(); // priming pieno, non resume
    expect(call.prompt).toContain("DOC_RIBOOT"); // contesto della voce incluso
    expect(call.prompt).toContain("Serve un rollback?");
    expect(call.prompt).toContain("No"); // l'etichetta scelta
  });
});
