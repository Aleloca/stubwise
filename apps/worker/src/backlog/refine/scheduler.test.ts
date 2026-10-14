import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agentSessionInputs, agentSessions, backlogRefineSessions, users, type Db } from "@stubwise/db";
import { seedBacklogItem, startTestDb, type TestDb } from "@stubwise/db/testing";
import { BACKLOG_REFINE_CLOSED_CHANNEL } from "@stubwise/shared";
import { AgentRunCancelledError, type AgentRunOptions, type AgentRunResult, type AgentRunner } from "../../agent/runner.js";
import { SessionInputRelay } from "../../sessions/relay.js";
import { startRefineBridge, type RefineBridge } from "./bridge.js";
import { RefineScheduler, type RefineSchedulerDeps } from "./scheduler.js";
import { runRefineTurn, type RefineTurnDeps, type RefineTurnOutcome } from "./turn.js";
import { createRefineWorktreeRegistry, type RefineWorktreeRegistry } from "./worktrees.js";

let t: TestDb;
let userId: string;
let realBridge: RefineBridge;
beforeAll(async () => {
  t = await startTestDb();
  realBridge = await startRefineBridge({ db: t.db, log: () => undefined });
  const [u] = await t.db.insert(users).values({ email: "a@x.test", passwordHash: "x", role: "admin" }).returning();
  userId = u!.id;
}, 120_000);
afterAll(async () => {
  await realBridge.close();
  await t.stop();
});
// Ogni test parte senza input `pending` lasciati dai precedenti: il relay a
// fine turno sveglia TUTTE le sessioni.
beforeEach(async () => {
  await t.db
    .update(agentSessionInputs)
    .set({ status: "undelivered", reason: "session_not_live" })
    .where(eq(agentSessionInputs.status, "pending"));
});

async function session(lastActivityAt = new Date()) {
  const { itemId } = await seedBacklogItem(t.db);
  const [s] = await t.db
    .insert(agentSessions)
    .values({ ownerKey: `backlog_refine:${itemId}`, kind: "backlog_refine", title: "t", backlogItemId: itemId })
    .returning();
  await t.db.insert(backlogRefineSessions).values({ itemId, agentSessionId: s!.id, lastActivityAt });
  return s!.id;
}
async function input(sessionId: string, text: string) {
  const [r] = await t.db.insert(agentSessionInputs).values({ sessionId, text, authorUserId: userId }).returning();
  return r!.id;
}
const inputOf = async (id: string) =>
  (await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.id, id)))[0]!;
/** Ciò che scrive il server alla chiusura (`closeRefineSession`). */
const closeRow = (sid: string, closedReason: "user" | "idle" = "user") =>
  t.db
    .update(backlogRefineSessions)
    .set({ status: "closed", closedReason, closedAt: new Date() })
    .where(eq(backlogRefineSessions.agentSessionId, sid));
/** Ciò che scrive il server quando qualcuno riscrive (`reopenRefineSessionIfClosed`). */
const reopenRow = (sid: string) =>
  t.db
    .update(backlogRefineSessions)
    .set({ status: "active", closedReason: null, closedAt: null, lastActivityAt: new Date() })
    .where(eq(backlogRefineSessions.agentSessionId, sid));
const refineOf = async (sid: string) =>
  (await t.db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.agentSessionId, sid)))[0]!;

/**
 * Un runTurn finto, controllato dal test: come quello vero RECLAMA l'input
 * (`pending → delivered`), poi resta aperto finché non lo si chiude.
 */
function controlledTurns() {
  const calls: {
    agentSessionId: string;
    inputId: string;
    signal: AbortSignal;
    finish: (o: RefineTurnOutcome) => void;
  }[] = [];
  const runTurn = vi.fn(async (i: { agentSessionId: string; inputId: string; signal: AbortSignal }) => {
    await t.db
      .update(agentSessionInputs)
      .set({ status: "delivered", deliveredAt: new Date() })
      .where(and(eq(agentSessionInputs.id, i.inputId), eq(agentSessionInputs.status, "pending")));
    return new Promise<RefineTurnOutcome>((resolve) => {
      i.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
      calls.push({ ...i, finish: resolve });
    });
  });
  return { calls, runTurn };
}
const tick = () => new Promise((r) => setTimeout(r, 50));
/** Finché `cond` non è vera (al più ~2 s). */
async function until(cond: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 40 && !(await cond()); i++) await tick();
}

function scheduler(over: Partial<RefineSchedulerDeps> = {}) {
  const bridge = { revokeSession: vi.fn() };
  const worktrees = createRefineWorktreeRegistry();
  const relay = { deliverPending: vi.fn(async () => undefined) };
  const s = new RefineScheduler({
    db: t.db,
    maxConcurrent: 2,
    idleMinutes: 30,
    bridge,
    worktrees,
    runTurn: controlledTurns().runTurn,
    log: () => undefined,
    ...over,
  });
  s.attachRelay(relay);
  return { s, bridge, worktrees, relay };
}

/** Le dipendenze del turno VERO, con runner e serializer finti (come turn.test.ts). */
function realTurnDeps(
  runner: AgentRunner,
  worktrees: RefineWorktreeRegistry,
  over: Partial<RefineTurnDeps> = {},
): RefineTurnDeps {
  return {
    db: t.db,
    runner,
    bridge: realBridge,
    mirrors: {
      openProjectWorktrees: async (repos: { repositoryId: string; name: string }[], _b: string, parentDir: string) => {
        await mkdir(parentDir, { recursive: true });
        return {
          dirs: repos.map((r) => ({ repositoryId: r.repositoryId, name: r.name, dir: `${parentDir}/${r.name}` })),
          remove: async () => undefined,
        };
      },
    } as unknown as RefineTurnDeps["mirrors"],
    serializer: { run: (_id: string, fn: () => Promise<unknown>) => fn() } as unknown as RefineTurnDeps["serializer"],
    worktrees,
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
}

/**
 * Scheduler cablato come in index.ts: relay vero, turno vero. `run` riceve il
 * relay, per fare ciò che fa il runner vero a fine segmento (`inputsNotEchoed`).
 */
function wired(
  run: (relay: SessionInputRelay, o: AgentRunOptions) => Promise<AgentRunResult>,
  over: Partial<RefineTurnDeps> = {},
) {
  const worktrees = createRefineWorktreeRegistry();
  const runTurn = vi.fn((i: { agentSessionId: string; inputId: string; signal: AbortSignal }) =>
    runRefineTurn(realTurnDeps(runner, worktrees, over), i),
  );
  const s = new RefineScheduler({
    db: t.db,
    maxConcurrent: 2,
    idleMinutes: 30,
    bridge: realBridge,
    worktrees,
    runTurn,
    log: () => undefined,
  });
  const relay = new SessionInputRelay({ db: t.db, turnStarter: s, log: () => undefined });
  s.attachRelay(relay);
  const runSpy = vi.fn((o: AgentRunOptions) => run(relay, o));
  const runner: AgentRunner = { recordsSessions: true, run: runSpy };
  return { s, relay, runTurn, run: runSpy };
}

describe("RefineScheduler", () => {
  it("due richieste insieme: UN turno, col messaggio più vecchio (Review Focus #2)", async () => {
    const sid = await session();
    const first = await input(sid, "primo");
    await input(sid, "secondo");
    const turns = controlledTurns();
    const { s } = scheduler({ runTurn: turns.runTurn });
    s.requestTurn(sid);
    s.requestTurn(sid);
    await tick();
    expect(turns.calls.map((c) => c.inputId)).toEqual([first]);
    await s.shutdown();
  });

  it("a fine turno sveglia il relay: il messaggio arrivato nella grazia diventa il turno dopo (Review Focus #1)", async () => {
    const sid = await session();
    const first = await input(sid, "primo");
    const turns = controlledTurns();
    const { s } = scheduler({ runTurn: turns.runTurn });
    const relay = new SessionInputRelay({ db: t.db, turnStarter: s, log: () => undefined });
    s.attachRelay(relay);
    s.requestTurn(sid);
    await tick();
    const late = await input(sid, "arrivato tardi");
    await relay.deliverPending(sid); // turno ancora in corso: requestTurn è un no-op
    expect(turns.calls).toHaveLength(1);
    expect((await inputOf(late)).status).toBe("pending");
    turns.calls[0]!.finish("completed");
    await until(() => turns.calls.length === 2);
    expect(turns.calls.map((c) => c.inputId)).toEqual([first, late]);
    await s.shutdown();
  });

  it("tetto d'istanza: la seconda sessione aspetta e parte quando il posto si libera", async () => {
    const a = await session();
    const b = await session();
    await input(a, "a");
    await input(b, "b");
    const turns = controlledTurns();
    const { s, relay } = scheduler({ runTurn: turns.runTurn, maxConcurrent: 1 });
    s.requestTurn(a);
    s.requestTurn(b);
    await tick();
    expect(turns.calls.map((c) => c.agentSessionId)).toEqual([a]);
    turns.calls[0]!.finish("completed");
    await tick();
    expect(relay.deliverPending).toHaveBeenCalled();
    s.requestTurn(b); // ciò che farebbe il relay
    await tick();
    expect(turns.calls.map((c) => c.agentSessionId)).toEqual([a, b]);
    await s.shutdown();
  });

  it("un turno che rigetta (DB giù) libera il posto, l'input resta pending, nessuna sveglia immediata", async () => {
    const sid = await session();
    const only = await input(sid, "x");
    const runTurn = vi.fn(async () => {
      throw new Error("db giù");
    });
    const log = vi.fn();
    const { s, relay } = scheduler({ runTurn, log, maxConcurrent: 1 });
    s.requestTurn(sid);
    await tick();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("db giù"));
    expect((await inputOf(only)).status).toBe("pending");
    expect(relay.deliverPending).not.toHaveBeenCalled();
    s.requestTurn(sid); // la sveglia periodica del relay: il posto è libero
    await tick();
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  it("closeSession a metà turno: segreti revocati PRIMA, turno annullato, pending → undelivered, worktree smontati (Review Focus #3)", async () => {
    const sid = await session();
    await input(sid, "in corso");
    const turns = controlledTurns();
    const { s, bridge, worktrees } = scheduler({ runTurn: turns.runTurn });
    const remove = vi.fn(async () => undefined);
    worktrees.set({ agentSessionId: sid, parentDir: "/p", repos: [], remove });
    s.requestTurn(sid);
    await tick();
    const waiting = await input(sid, "in coda");
    let abortedAtRevoke: boolean | null = null;
    bridge.revokeSession.mockImplementation(() => {
      abortedAtRevoke = turns.calls[0]!.signal.aborted;
    });
    await closeRow(sid); // come closeRefineSession, prima della NOTIFY
    await s.closeSession(sid);
    expect(bridge.revokeSession).toHaveBeenCalledWith(sid);
    expect(abortedAtRevoke).toBe(false); // revoca PRIMA dell'abort
    expect(turns.calls[0]!.signal.aborted).toBe(true);
    expect(await inputOf(waiting)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(worktrees.get(sid)).toBeUndefined();
    // Idempotente.
    await s.closeSession(sid);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("riaperta DURANTE l'attesa del turno annullato: il messaggio nuovo resta pending, i worktree restano e diventa il turno dopo", async () => {
    const sid = await session();
    const first = await input(sid, "primo");
    // Un turno che ci mette un po' a fermarsi: l'abort si risolve a comando.
    let stopped!: () => void;
    const calls: string[] = [];
    const runTurn = vi.fn(async (i: { agentSessionId: string; inputId: string; signal: AbortSignal }) => {
      calls.push(i.inputId);
      await t.db
        .update(agentSessionInputs)
        .set({ status: "delivered", deliveredAt: new Date() })
        .where(eq(agentSessionInputs.id, i.inputId));
      if (calls.length > 1) return "completed" as const;
      return new Promise<RefineTurnOutcome>((resolve) => {
        i.signal.addEventListener("abort", () => (stopped = () => resolve("cancelled")), { once: true });
      });
    });
    const { s, worktrees, bridge } = scheduler({ runTurn });
    const relay = new SessionInputRelay({ db: t.db, turnStarter: s, log: () => undefined });
    s.attachRelay(relay);
    const remove = vi.fn(async () => undefined);
    worktrees.set({ agentSessionId: sid, parentDir: "/p", repos: [], remove });
    s.requestTurn(sid);
    await until(() => calls.length === 1);
    await closeRow(sid);
    const closing = s.closeSession(sid);
    await until(() => stopped !== undefined);
    // Mentre il turno si ferma, la persona riscrive: il server riapre.
    await reopenRow(sid);
    const again = await input(sid, "ci sono ancora");
    await relay.deliverPending(sid); // in chiusura: requestTurn è un no-op
    expect(calls).toEqual([first]);
    stopped();
    await closing;
    expect(bridge.revokeSession).toHaveBeenCalledWith(sid);
    expect(remove).not.toHaveBeenCalled();
    expect(worktrees.get(sid)).toBeDefined();
    await until(() => calls.length === 2);
    expect(calls).toEqual([first, again]);
    expect((await inputOf(again)).status).toBe("delivered");
    await s.shutdown();
  });

  it("closeSession su una sessione già di nuovo active (finestra dello sweep): input pending intatti, worktree intatti, relay svegliato", async () => {
    const sid = await session();
    const waiting = await input(sid, "riscritto");
    const { s, worktrees, relay } = scheduler();
    const remove = vi.fn(async () => undefined);
    worktrees.set({ agentSessionId: sid, parentDir: "/p", repos: [], remove });
    await s.closeSession(sid);
    expect(await inputOf(waiting)).toMatchObject({ status: "pending", reason: null });
    expect(remove).not.toHaveBeenCalled();
    expect(relay.deliverPending).toHaveBeenCalledWith(sid);
  });

  it("closeSession (sweep con lettura stantia) su una sessione di nuovo active CON un turno vivo: nessuna revoca, nessun abort, worktree intatti, relay svegliato", async () => {
    const sid = await session();
    await input(sid, "in corso");
    const turns = controlledTurns();
    const { s, bridge, worktrees, relay } = scheduler({ runTurn: turns.runTurn });
    const remove = vi.fn(async () => undefined);
    worktrees.set({ agentSessionId: sid, parentDir: "/p", repos: [], remove });
    s.requestTurn(sid);
    await until(() => turns.calls.length === 1);
    // La riga è `active` (riaperta dopo la lettura dello sweep): niente da chiudere.
    await s.closeSession(sid);
    expect(bridge.revokeSession).not.toHaveBeenCalled();
    expect(turns.calls[0]!.signal.aborted).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(worktrees.get(sid)).toBeDefined();
    expect(relay.deliverPending).toHaveBeenCalledWith(sid);
    turns.calls[0]!.finish("completed");
    await s.shutdown();
  });

  it("stopAcceptingTurns: nessun turno nuovo, quelli in corso proseguono", async () => {
    const a = await session();
    const b = await session();
    await input(a, "a");
    await input(b, "b");
    const turns = controlledTurns();
    const { s } = scheduler({ runTurn: turns.runTurn });
    s.requestTurn(a);
    await until(() => turns.calls.length === 1);
    s.stopAcceptingTurns();
    s.requestTurn(b);
    await tick();
    expect(turns.calls.map((c) => c.agentSessionId)).toEqual([a]);
    expect(turns.calls[0]!.signal.aborted).toBe(false);
    await s.shutdown();
  });

  it("«Chiudi» mentre il turno VERO aspetta il serializer: nessun run, e chiusa la sessione l'input è session_not_live", async () => {
    const sid = await session();
    const opening = await input(sid, "ciao");
    let entered!: () => void;
    const waiting = new Promise<void>((r) => (entered = r));
    // Serializer occupato da un fix lungo: non si libera durante il test.
    const serializer = {
      run: () => {
        entered();
        return new Promise(() => undefined);
      },
    } as unknown as RefineTurnDeps["serializer"];
    const { s, runTurn, run } = wired(async () => ({ exitCode: 0, output: "" }), { serializer });
    s.requestTurn(sid);
    await waiting;
    expect((await inputOf(opening)).status).toBe("pending"); // in coda, non ancora reclamato
    await closeRow(sid); // come closeRefineSession, prima della NOTIFY
    await s.closeSession(sid);
    expect(await runTurn.mock.results[0]!.value).toBe("cancelled");
    expect(run).not.toHaveBeenCalled();
    expect(await inputOf(opening)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("«Chiudi» a run avviato, prima dell'eco: l'input finisce session_not_live, nessun turno dopo", async () => {
    const sid = await session();
    const opening = await input(sid, "ciao");
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const { s, runTurn } = wired(
      (relay, o) =>
        new Promise<AgentRunResult>((_resolve, reject) => {
          started();
          o.signal!.addEventListener(
            "abort",
            () => {
              // Il runner vero, a fine segmento senza eco: il relay riporta
              // l'input a `pending` (sessione a turni), poi il run lancia.
              void relay
                .inputsNotEchoed(o.session!.sessionId, [o.openingInput!.inputId])
                .then(() => reject(new AgentRunCancelledError(null, "", 0)));
            },
            { once: true },
          );
        }),
    );
    s.requestTurn(sid);
    await running;
    expect((await inputOf(opening)).status).toBe("delivered");
    await closeRow(sid); // come closeRefineSession, prima della NOTIFY
    await s.closeSession(sid);
    expect(await runTurn.mock.results[0]!.value).toBe("cancelled");
    expect(await inputOf(opening)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
    await tick();
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("«Ferma» prima dell'eco: l'input resta undelivered/stdin_closed e lo scheduler non ne fa un turno", async () => {
    const sid = await session();
    const opening = await input(sid, "ciao");
    const { s, runTurn, run } = wired(async (relay, o) => {
      await relay.inputsNotEchoed(o.session!.sessionId, [o.openingInput!.inputId]);
      throw new AgentRunCancelledError(null, "", 0);
    });
    s.requestTurn(sid);
    await until(async () => (await inputOf(opening)).status === "undelivered");
    await tick();
    await tick();
    expect(await inputOf(opening)).toMatchObject({ status: "undelivered", reason: "stdin_closed" });
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    await s.shutdown();
  });

  it("turno fallito senza eco: turn_failed, e la sveglia di fine turno non ne fa un secondo turno", async () => {
    const sid = await session();
    const opening = await input(sid, "ciao");
    const { s, runTurn } = wired(async (relay, o) => {
      await relay.inputsNotEchoed(o.session!.sessionId, [o.openingInput!.inputId]);
      return { exitCode: 1, output: "CLI rotto" };
    });
    s.requestTurn(sid);
    await until(async () => (await inputOf(opening)).status === "undelivered");
    await tick();
    await tick();
    expect(await inputOf(opening)).toMatchObject({ status: "undelivered", reason: "turn_failed" });
    expect(runTurn).toHaveBeenCalledTimes(1);
    await s.shutdown();
  });

  it("NOTIFY di chiusura dal server: closeSession", async () => {
    const sid = await session();
    const { s, bridge } = scheduler({ listen: (ch, cb) => t.client.listen(ch, cb) });
    await s.start();
    await closeRow(sid); // il server scrive `closed` PRIMA della NOTIFY
    await t.db.execute(sql`select pg_notify(${BACKLOG_REFINE_CLOSED_CHANNEL}, ${JSON.stringify({ agentSessionId: sid })})`);
    await until(() => bridge.revokeSession.mock.calls.length > 0);
    expect(bridge.revokeSession).toHaveBeenCalledWith(sid);
    await s.shutdown();
  });

  it("LISTEN fallito: start non lancia (resta lo sweep)", async () => {
    const log = vi.fn();
    const { s } = scheduler({ listen: async () => Promise.reject(new Error("no")), log });
    await expect(s.start()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(BACKLOG_REFINE_CLOSED_CHANNEL));
  });

  it("sweep: chiude per inattività solo senza messaggi in coda e senza turno in corso", async () => {
    const old = new Date(Date.now() - 3_600_000);
    const idle = await session(old);
    const queued = await session(old);
    await input(queued, "in coda");
    const busy = await session(old);
    const working = await input(busy, "al lavoro");
    const fresh = await session();
    const turns = controlledTurns();
    const { s, bridge } = scheduler({ runTurn: turns.runTurn });
    s.requestTurn(busy);
    await until(() => turns.calls.length === 1);
    // Il turno ha reclamato il suo input: `busy` è escluso SOLO dal turno in corso.
    expect((await inputOf(working)).status).toBe("delivered");
    await s.sweepIdle();
    expect(await refineOf(idle)).toMatchObject({ status: "closed", closedReason: "idle" });
    expect(bridge.revokeSession).toHaveBeenCalledWith(idle);
    for (const sid of [queued, busy, fresh]) expect((await refineOf(sid)).status).toBe("active");
    await s.shutdown();
  });

  it("sweep: riconcilia i worktree di una sessione chiusa dal server (NOTIFY persa)", async () => {
    const sid = await session();
    const live = await session();
    await t.db
      .update(backlogRefineSessions)
      .set({ status: "closed", closedReason: "user", closedAt: new Date() })
      .where(eq(backlogRefineSessions.agentSessionId, sid));
    const { s, worktrees } = scheduler();
    const remove = vi.fn(async () => undefined);
    const keep = vi.fn(async () => undefined);
    worktrees.set({ agentSessionId: sid, parentDir: "/p", repos: [], remove });
    worktrees.set({ agentSessionId: live, parentDir: "/q", repos: [], remove: keep });
    await s.sweepIdle();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(keep).not.toHaveBeenCalled();
  });

  it("shutdown: annulla i turni in corso, smonta i worktree e non ne avvia di nuovi", async () => {
    const sid = await session();
    await input(sid, "x");
    const turns = controlledTurns();
    const { s, worktrees } = scheduler({ runTurn: turns.runTurn });
    const remove = vi.fn(async () => undefined);
    worktrees.set({ agentSessionId: sid, parentDir: "/p", repos: [], remove });
    s.requestTurn(sid);
    await until(() => turns.calls.length === 1);
    await s.shutdown();
    expect(turns.calls[0]!.signal.aborted).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
    const other = await session();
    await input(other, "y");
    s.requestTurn(other);
    await tick();
    expect(turns.calls).toHaveLength(1);
  });
});
