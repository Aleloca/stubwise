import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentSessionEvents,
  agentSessionInputs,
  agentSessions,
  backlogItems,
  backlogRefineSessions,
  instanceSettings,
  users,
  type Db,
} from "@stubwise/db";
import { seedBacklogItem, startTestDb, type TestDb } from "@stubwise/db/testing";
import { REFINE_MCP_SERVER_NAME } from "@stubwise/shared";
import {
  AgentRunCancelledError,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRunner,
} from "../../agent/runner.js";
import { SessionInputRelay } from "../../sessions/relay.js";
import { startRefineBridge, type RefineBridge } from "./bridge.js";
import { runRefineTurn, type RefineTurnDeps } from "./turn.js";
import { createRefineWorktreeRegistry, refineParentDir } from "./worktrees.js";

let t: TestDb;
let bridge: RefineBridge;
let adminId: string;
let memberId: string;
beforeAll(async () => {
  t = await startTestDb();
  bridge = await startRefineBridge({ db: t.db, log: () => undefined });
  const [a] = await t.db.insert(users).values({ email: "a@x.test", passwordHash: "x", role: "admin" }).returning();
  const [m] = await t.db.insert(users).values({ email: "m@x.test", passwordHash: "x", role: "member" }).returning();
  adminId = a!.id;
  memberId = m!.id;
}, 120_000);
afterAll(async () => {
  await bridge.close();
  await t.stop();
});

const OK: AgentRunResult = { exitCode: 0, output: "fatto", sessionId: "cli-1" };

/** Runner finto: registra le opzioni; `script` decide l'esito di ogni chiamata. */
function fakeRunner(script: Array<(o: AgentRunOptions) => Promise<AgentRunResult>>) {
  const calls: AgentRunOptions[] = [];
  const runner: AgentRunner = {
    recordsSessions: true,
    run: vi.fn(async (o: AgentRunOptions) => {
      calls.push(o);
      return (script[calls.length - 1] ?? script.at(-1)!)(o);
    }),
  };
  return { runner, calls };
}

/** Il CLI ha PRESO il messaggio: l'evento input che il runner vero scriverebbe all'eco. */
async function echo(o: AgentRunOptions) {
  await t.db.insert(agentSessionEvents).values({
    sessionId: o.session!.sessionId,
    segmentId: "seg",
    type: "input",
    data: { inputId: o.openingInput!.inputId, text: o.openingInput!.text },
  });
}

async function seeded(opts: { cliSessionId?: string; status?: "active" | "closed"; author?: string } = {}) {
  const { itemId } = await seedBacklogItem(t.db, { title: "Export CSV" });
  const [s] = await t.db
    .insert(agentSessions)
    .values({ ownerKey: `backlog_refine:${itemId}`, kind: "backlog_refine", title: "t", backlogItemId: itemId })
    .returning();
  await t.db.insert(backlogRefineSessions).values({
    itemId,
    agentSessionId: s!.id,
    status: opts.status ?? "active",
    cliSessionId: opts.cliSessionId ?? null,
    ...(opts.status === "closed" ? { closedAt: new Date(), closedReason: "user" as const } : {}),
  });
  const [input] = await t.db
    .insert(agentSessionInputs)
    .values({ sessionId: s!.id, text: "ciao", authorUserId: opts.author ?? adminId })
    .returning();
  return { itemId, agentSessionId: s!.id, inputId: input!.id };
}

function deps(runner: AgentRunner, over: Partial<RefineTurnDeps> = {}) {
  const openProjectWorktrees = vi.fn(
    async (repos: { repositoryId: string; name: string }[], _branch: string, parentDir: string) => {
      await mkdir(parentDir, { recursive: true });
      return {
        dirs: repos.map((r) => ({ repositoryId: r.repositoryId, name: r.name, dir: `${parentDir}/${r.name}` })),
        remove: vi.fn(async () => undefined),
      };
    },
  );
  const d: RefineTurnDeps = {
    db: t.db,
    runner,
    bridge,
    mirrors: { openProjectWorktrees } as unknown as RefineTurnDeps["mirrors"],
    serializer: { run: (_id: string, fn: () => Promise<unknown>) => fn() } as unknown as RefineTurnDeps["serializer"],
    worktrees: createRefineWorktreeRegistry(),
    encryptionKey: Buffer.alloc(32, 1),
    maxTurns: 30,
    turnTimeoutMs: 60_000,
    refineServerPath: "/nope/index.js",
    loadProviderChainFn: async () => [],
    loadMirrorProjectsFn: async (_db: Db, projectId: string) => [
      { repositoryId: projectId, name: "api", project: {} as never },
    ],
    log: () => undefined,
    ...over,
  };
  return { d, openProjectWorktrees };
}
const inputOf = async (id: string) =>
  (await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.id, id)))[0]!;
const refineOf = async (sid: string) =>
  (await t.db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.agentSessionId, sid)))[0]!;
const run = (d: RefineTurnDeps, s: { agentSessionId: string; inputId: string }, signal = new AbortController().signal) =>
  runRefineTurn(d, { ...s, signal });
const tick = () => new Promise((r) => setTimeout(r, 30));

describe("runRefineTurn", () => {
  it("primo turno: prompt d'avvio, nessun --resume, sola lettura per costruzione, cli_session_id salvato", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([
      async (o) => {
        await echo(o);
        return OK;
      },
    ]);
    expect(await run(deps(runner).d, s)).toBe("completed");
    const o = calls[0]!;
    expect(o.prompt).toContain("Export CSV");
    expect(o.resumeSessionId).toBeUndefined();
    expect(o.permissionMode).toBe("default");
    expect(o.cwd).toBe(refineParentDir(s.agentSessionId));
    expect(o.timeoutMs).toBe(60_000);
    expect(o.openingInput).toEqual({ inputId: s.inputId, text: "ciao", authorUserId: adminId });
    expect(o.session).toMatchObject({ sessionId: s.agentSessionId, label: "refine" });
    expect(o.session!.pauseKey).toMatch(new RegExp(`^backlog_refine:${s.agentSessionId}:`));
    for (const forbidden of ["Edit", "Write", "Bash", "WebFetch", "NotebookEdit", "MultiEdit"]) {
      expect(o.allowedTools).not.toContain(forbidden);
    }
    // Senza grafi e senza entry MCP: esattamente le letture e le skill.
    expect(o.allowedTools).toEqual(["Read", "Grep", "Glob", "Skill"]);
    expect(o.mcpConfig).toBeUndefined();
    expect((await refineOf(s.agentSessionId)).cliSessionId).toBe("cli-1");
    expect((await inputOf(s.inputId)).status).toBe("delivered");
  });

  it("con l'entry MCP: i tre tool di scrittura entrano nell'allowlist chiusa", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([
      async (o) => {
        await echo(o);
        return OK;
      },
    ]);
    // Un file che esiste: la config MCP c'è.
    expect(await run(deps(runner, { refineServerPath: process.execPath }).d, s)).toBe("completed");
    const o = calls[0]!;
    expect(o.allowedTools!.slice(0, 4)).toEqual(["Read", "Grep", "Glob", "Skill"]);
    expect(o.allowedTools!.slice(4).every((n) => n.startsWith(`mcp__${REFINE_MCP_SERVER_NAME}__`))).toBe(true);
    expect(o.allowedTools).toHaveLength(7);
    const env = o.mcpConfig!.servers[REFINE_MCP_SERVER_NAME]!.env!;
    expect(Object.keys(env).sort()).toEqual(["REFINE_BRIDGE_SECRET", "REFINE_BRIDGE_URL"]);
  });

  it("turno successivo: --resume col cli_session_id, prompt = solo il messaggio, worktree NON riaperti", async () => {
    const s = await seeded({ cliSessionId: "cli-0" });
    const { runner, calls } = fakeRunner([
      async (o) => {
        await echo(o);
        return OK;
      },
    ]);
    const { d, openProjectWorktrees } = deps(runner);
    await run(d, s);
    expect(calls[0]!.resumeSessionId).toBe("cli-0");
    const [second] = await t.db
      .insert(agentSessionInputs)
      .values({ sessionId: s.agentSessionId, text: "e il piano?", authorUserId: adminId })
      .returning();
    expect(await run(d, { agentSessionId: s.agentSessionId, inputId: second!.id })).toBe("completed");
    expect(calls[1]!.resumeSessionId).toBe("cli-1");
    expect(calls[1]!.prompt).toBe("e il piano?");
    expect(calls[1]!.session!.pauseKey).not.toBe(calls[0]!.session!.pauseKey);
    expect(openProjectWorktrees).toHaveBeenCalledTimes(1);
  });

  it("entry già nel registro: la riusa, mai riaperta né sovrascritta", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([
      async (o) => {
        await echo(o);
        return OK;
      },
    ]);
    const { d, openProjectWorktrees } = deps(runner);
    const remove = vi.fn(async () => undefined);
    const existing = { agentSessionId: s.agentSessionId, parentDir: "/gia/aperti", repos: [], remove };
    d.worktrees.set(existing);
    expect(await run(d, s)).toBe("completed");
    expect(openProjectWorktrees).not.toHaveBeenCalled();
    expect(calls[0]!.cwd).toBe("/gia/aperti");
    expect(d.worktrees.get(s.agentSessionId)).toBe(existing);
    expect(remove).not.toHaveBeenCalled();
  });

  it("riavvio + --resume rifiutato: stesso percorso, un tentativo col prompt d'avvio e cli_session_id riscritto", async () => {
    const s = await seeded({ cliSessionId: "cli-perso" });
    const { runner, calls } = fakeRunner([
      async (o) => {
        // Come il relay a fine segmento senza eco: l'input torna `pending`.
        await t.db
          .update(agentSessionInputs)
          .set({ status: "pending", deliveredAt: null })
          .where(eq(agentSessionInputs.id, o.openingInput!.inputId));
        return { exitCode: 1, output: "No conversation found" };
      },
      async (o) => {
        await echo(o);
        return { ...OK, sessionId: "cli-nuovo" };
      },
    ]);
    const { d, openProjectWorktrees } = deps(runner); // registro VUOTO: come dopo un riavvio
    expect(await run(d, s)).toBe("completed");
    expect(openProjectWorktrees.mock.calls[0]![2]).toBe(refineParentDir(s.agentSessionId));
    expect(openProjectWorktrees.mock.calls[0]![1]).toBe(`stubwise/backlog-refine-${s.agentSessionId}`);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.resumeSessionId).toBe("cli-perso");
    expect(calls[1]!.resumeSessionId).toBeUndefined();
    expect(calls[1]!.prompt).toContain("Export CSV");
    expect(calls[1]!.openingInput!.inputId).toBe(s.inputId);
    expect(calls[1]!.session!.pauseKey).toBe(calls[0]!.session!.pauseKey);
    expect((await refineOf(s.agentSessionId)).cliSessionId).toBe("cli-nuovo");
    expect((await inputOf(s.inputId)).status).toBe("delivered");
  });

  it("--resume fallito DOPO l'eco: nessun nuovo tentativo (il messaggio è già nella conversazione)", async () => {
    const s = await seeded({ cliSessionId: "cli-0" });
    const { runner, calls } = fakeRunner([
      async (o) => {
        await echo(o);
        return { exitCode: 1, output: "boom" };
      },
    ]);
    expect(await run(deps(runner).d, s)).toBe("failed");
    expect(calls).toHaveLength(1);
    expect(await inputOf(s.inputId)).toMatchObject({ status: "delivered", reason: null });
    expect((await refineOf(s.agentSessionId)).cliSessionId).toBe("cli-0");
  });

  it("input già reclamato da altri: skipped, nessun run", async () => {
    const s = await seeded();
    await t.db.update(agentSessionInputs).set({ status: "delivered" }).where(eq(agentSessionInputs.id, s.inputId));
    const { runner, calls } = fakeRunner([async () => OK]);
    expect(await run(deps(runner).d, s)).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("sessione chiusa o voce convertita/archiviata: input undelivered/session_not_live, nessun run", async () => {
    const closed = await seeded({ status: "closed" });
    const converted = await seeded();
    await t.db.update(backlogItems).set({ status: "converted" }).where(eq(backlogItems.id, converted.itemId));
    const archived = await seeded();
    await t.db.update(backlogItems).set({ status: "archived" }).where(eq(backlogItems.id, archived.itemId));
    const { runner, calls } = fakeRunner([async () => OK]);
    for (const s of [closed, converted, archived]) {
      const { d, openProjectWorktrees } = deps(runner);
      expect(await run(d, s)).toBe("skipped");
      expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
      expect(openProjectWorktrees).not.toHaveBeenCalled();
    }
    expect(calls).toHaveLength(0);
  });

  it("budget sforato, due ruoli: il member riceve budget_exceeded e niente run né worktree, l'admin passa", async () => {
    await t.db
      .insert(instanceSettings)
      .values({ id: 1, monthlyBudgetUsd: "1" })
      .onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "1" } });
    try {
      const byMember = await seeded({ author: memberId });
      const byAdmin = await seeded({ author: adminId });
      const { runner, calls } = fakeRunner([
        async (o) => {
          await echo(o);
          return OK;
        },
      ]);
      const { d, openProjectWorktrees } = deps(runner, { monthlyCostUsdFn: async () => 5 });
      expect(await run(d, byMember)).toBe("skipped");
      expect(await inputOf(byMember.inputId)).toMatchObject({ status: "undelivered", reason: "budget_exceeded" });
      expect(openProjectWorktrees).not.toHaveBeenCalled();
      expect(await run(d, byAdmin)).toBe("completed");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.openingInput!.inputId).toBe(byAdmin.inputId);
      expect((await inputOf(byAdmin.inputId)).status).toBe("delivered");
    } finally {
      await t.db.update(instanceSettings).set({ monthlyBudgetUsd: null }).where(eq(instanceSettings.id, 1));
    }
  });

  it("turno in attesa del serializer: l'input è ancora pending e la sessione non è viva (stato derivato queued)", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([
      async (o) => {
        await echo(o);
        return OK;
      },
    ]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const serializer = {
      run: async <T>(_id: string, fn: () => Promise<T>) => {
        await gate;
        return fn();
      },
    };
    const { d } = deps(runner, { serializer });
    const turn = run(d, s);
    await tick();
    await tick();
    expect((await inputOf(s.inputId)).status).toBe("pending");
    const [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.id, s.agentSessionId));
    expect(row!.liveSegmentIds).toEqual([]);
    expect(calls).toHaveLength(0);
    release();
    expect(await turn).toBe("completed");
    expect((await inputOf(s.inputId)).status).toBe("delivered");
  });

  it("«Chiudi» mentre il turno aspetta il serializer: cancelled, nessun run, input lasciato pending", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([async () => OK]);
    const ac = new AbortController();
    const serializer = {
      run: async <T>(_id: string, fn: () => Promise<T>) => {
        ac.abort();
        return fn();
      },
    };
    expect(await run(deps(runner, { serializer }).d, s, ac.signal)).toBe("cancelled");
    expect(calls).toHaveLength(0);
    expect((await inputOf(s.inputId)).status).toBe("pending");
  });

  it("claim perso dopo l'apertura dei worktree: skipped, nessun run, i worktree restano nel registro", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([async () => OK]);
    const { d, openProjectWorktrees } = deps(runner);
    openProjectWorktrees.mockImplementationOnce(async () => {
      // Nel frattempo il server ha chiuso la sessione e l'input.
      await t.db
        .update(agentSessionInputs)
        .set({ status: "undelivered", reason: "session_not_live" })
        .where(eq(agentSessionInputs.id, s.inputId));
      return { dirs: [], remove: vi.fn(async () => undefined) };
    });
    expect(await run(d, s)).toBe("skipped");
    expect(calls).toHaveLength(0);
    expect(d.worktrees.get(s.agentSessionId)?.parentDir).toBe(refineParentDir(s.agentSessionId));
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
  });

  it("annullato («Chiudi»): cancelled, l'input non diventa turn_failed", async () => {
    const s = await seeded();
    const { runner } = fakeRunner([
      async () => {
        throw new AgentRunCancelledError(null, "", 0);
      },
    ]);
    expect(await run(deps(runner).d, s)).toBe("cancelled");
    expect(await inputOf(s.inputId)).toMatchObject({ status: "delivered", reason: null });
  });

  it("progetto senza repository: turn_failed, nessun run", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([async () => OK]);
    const { d } = deps(runner, { loadMirrorProjectsFn: async () => [] });
    expect(await run(d, s)).toBe("failed");
    expect(calls).toHaveLength(0);
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "turn_failed" });
  });

  it("errore prima che il CLI prenda il messaggio: undelivered/turn_failed, e il segreto del turno è revocato", async () => {
    const s = await seeded();
    let secret = "";
    const { runner } = fakeRunner([
      async (o) => {
        secret = o.mcpConfig?.servers[REFINE_MCP_SERVER_NAME]?.env?.["REFINE_BRIDGE_SECRET"] ?? "";
        throw new Error("provider giù");
      },
    ]);
    const { d } = deps(runner, { refineServerPath: process.execPath }); // un file che esiste: la config MCP c'è
    expect(await run(d, s)).toBe("failed");
    expect(secret).not.toBe("");
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "turn_failed" });
    const res = await fetch(`${bridge.url}/tools/set_plan`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ markdown: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("segreto revocato anche a turno riuscito", async () => {
    const s = await seeded();
    let secret = "";
    const { runner } = fakeRunner([
      async (o) => {
        secret = o.mcpConfig!.servers[REFINE_MCP_SERVER_NAME]!.env!["REFINE_BRIDGE_SECRET"]!;
        await echo(o);
        return OK;
      },
    ]);
    expect(await run(deps(runner, { refineServerPath: process.execPath }).d, s)).toBe("completed");
    const res = await fetch(`${bridge.url}/tools/set_plan`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ markdown: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("turno fallito senza eco → turn_failed, nessun secondo turno (il relay non lo rimette in coda)", async () => {
    const s = await seeded();
    const turnStarter = { requestTurn: vi.fn() };
    const relay = new SessionInputRelay({ db: t.db, turnStarter, log: () => undefined });
    const { runner, calls } = fakeRunner([
      async (o) => {
        // Il runner vero, a fine segmento senza eco: il relay riporta l'input
        // a `pending` e chiede un turno (no-op: questo è ancora in corso).
        await relay.inputsNotEchoed(o.session!.sessionId, [o.openingInput!.inputId]);
        return { exitCode: 1, output: "CLI rotto" };
      },
    ]);
    expect(await run(deps(runner).d, s)).toBe("failed");
    expect(turnStarter.requestTurn).toHaveBeenCalledTimes(1);
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "turn_failed" });
    // La sveglia di fine turno dello scheduler: nessuna richiesta nuova.
    await relay.deliverPending(s.agentSessionId);
    expect(turnStarter.requestTurn).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it("turno fallito DOPO l'eco: failed, l'input resta delivered (è nella trascrizione)", async () => {
    const s = await seeded();
    const { runner } = fakeRunner([
      async (o) => {
        await echo(o);
        throw new Error("timeout");
      },
    ]);
    expect(await run(deps(runner).d, s)).toBe("failed");
    expect(await inputOf(s.inputId)).toMatchObject({ status: "delivered", reason: null });
  });
});
