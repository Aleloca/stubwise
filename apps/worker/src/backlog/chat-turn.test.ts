import {
  backlogChatMessages,
  backlogCodeSessions,
  backlogItems,
  encrypt,
  gitAccounts,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { asc, eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "../agent/fake.js";
import { AgentTimeoutError, type AgentRunResult, type AgentRunner } from "../agent/runner.js";
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

function job(projectId: string, payload: { itemId: string; userMessageId: string; sessionId: string }): BacklogJob {
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
