import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentSessions,
  environmentServers,
  instanceSettings,
  projectEnvironments,
  serverCommands,
  projects,
  serverFixes,
  serverMetrics,
  serverOperationApprovals,
  servers,
  type Db,
} from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { SERVER_FIX_TOOLS, SERVER_MCP_SERVER_NAME } from "@stubwise/shared";
import { FakeAgentRunner } from "../agent/fake.js";
import type { AgentRunOptions, AgentRunResult } from "../agent/runner.js";
import type { SelectDeps } from "../providers/select.js";
import { startServerOpsBridge, type ServerOpsBridge } from "./bridge.js";
import { proposeNextServerFix, recoverStaleFixes, runNextApprovedFix, type ServerFixDeps } from "./fix-run.js";

/**
 * Area 8, F4b, S6: la correzione nel worker. Un passo alla volta, coi
 * ricontrolli PRIMA di firmare ogni passo; un piano nuovo da una sessione
 * `server_fix` con le sole letture e `propose_server_plan` (validato).
 * docs/invariants/server-operations.md.
 */

const KEY = randomBytes(32);
let testDb: TestDb;
let db: Db;
let bridge: ServerOpsBridge;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  bridge = await startServerOpsBridge({ db, encryptionKey: KEY, log: () => undefined, sleep: async () => undefined });
}, 120_000);
afterAll(async () => {
  await bridge.close();
  await testDb.stop();
});

const restart = { action: "container.restart", params: { container: "web-a", timeoutSeconds: 10 }, why: "riparte" };
const start = { action: "container.start", params: { container: "web-a" }, why: "riparte" };

async function scene(opts: { steps?: object[]; status?: "approved" | "proposing"; operations?: boolean } = {}) {
  const [server] = await db
    .insert(servers)
    .values({ name: `s-${randomBytes(3).toString("hex")}`, keyHash: `h-${randomBytes(8).toString("hex")}`, agentCapabilities: { operations: opts.operations ?? true } })
    .returning();
  await db.insert(serverMetrics).values({
    serverId: server!.id,
    ts: new Date(),
    cpuPct: 1,
    load1m: 0,
    memUsedBytes: 1,
    memTotalBytes: 2,
    swapUsedBytes: 0,
    diskUsedBytes: 1,
    diskTotalBytes: 2,
    netRxBytes: 0,
    netTxBytes: 0,
    services: ["web-a", "db-b"].map((name) => ({ source: "docker", name, state: "running" })) as never,
  });
  const a = await seedRepository(db);
  const b = await seedRepository(db);
  const envs: string[] = [];
  for (const [p, c] of [
    [a, "web-a"],
    [b, "db-b"],
  ] as const) {
    const [env] = await db.insert(projectEnvironments).values({ projectId: p.projectId, name: "production", kind: "production", serverId: server!.id }).returning();
    await db.insert(environmentServers).values({ environmentId: env!.id, repositoryId: p.repositoryId, serverId: server!.id, containers: [c] });
    envs.push(env!.id);
  }
  const { ticketId } = await seedTicket(db, { projectId: a.projectId });
  const steps = (opts.steps ?? [restart, start]) as { action: string; params: Record<string, unknown>; why: string }[];
  const status = opts.status ?? "approved";
  const [approval] = status === "approved" ? await db.insert(serverOperationApprovals).values({ serverId: server!.id, taskId: ticketId, steps }).returning() : [];
  const [fix] = await db
    .insert(serverFixes)
    .values({ taskId: ticketId, serverId: server!.id, projectId: a.projectId, status, steps: status === "approved" ? steps : [], approvalId: approval?.id ?? null })
    .returning();
  return { serverId: server!.id, fix: fix!, approvalId: approval?.id, envs, projectId: a.projectId };
}

const SELECT: SelectDeps = { db: undefined as unknown as Db, encryptionKey: KEY, backgroundWeeklyThreshold: 0.9, selectProvidersFn: async () => ({ candidates: [], legacyAuth: true, emptyReason: null }) };

/** L'agente: a ogni attesa esegue i comandi pendenti con `exitCode`, poi `after` (una mossa del test). */
function deps(opts: { exitCode?: number; after?: (n: number) => Promise<void>; runner?: FakeAgentRunner; budgetSpent?: number } = {}): ServerFixDeps {
  let n = 0;
  return {
    db,
    encryptionKey: KEY,
    runner: opts.runner ?? new FakeAgentRunner({ output: "x" }),
    bridge,
    select: { ...SELECT, db },
    serverPath: fileURLToPath(import.meta.url),
    monthlyCostUsdFn: async () => opts.budgetSpent ?? 0,
    log: () => undefined,
    sleep: async () => {
      await db
        .update(serverCommands)
        .set({ status: "done", exitCode: opts.exitCode ?? 0, output: "ok", deliveredAt: new Date(), finishedAt: new Date() })
        .where(eq(serverCommands.status, "pending"));
      n += 1;
      await opts.after?.(n);
    },
  };
}

const fixOf = async (id: string) => (await db.select().from(serverFixes).where(eq(serverFixes.id, id)))[0]!;
const commandsOf = (serverId: string) => db.select().from(serverCommands).where(eq(serverCommands.serverId, serverId)).orderBy(serverCommands.issuedAt);

describe("l'esecuzione: un passo alla volta, coi ricontrolli", () => {
  it("tutti i passi approvati, ognuno un comando firmato col suo indice; poi done", async () => {
    const s = await scene();
    await runNextApprovedFix(deps());
    expect(await fixOf(s.fix.id)).toMatchObject({ status: "done", planError: null });
    const cmds = await commandsOf(s.serverId);
    expect(cmds.map((c) => [c.kind, c.action, c.approvalId, c.stepIndex, c.status])).toEqual([
      ["change", "container.restart", s.approvalId, 0, "done"],
      ["change", "container.start", s.approvalId, 1, "done"],
    ]);
  });

  it("un passo fallito ferma il piano: il secondo non si firma", async () => {
    const s = await scene();
    await runNextApprovedFix(deps({ exitCode: 1 }));
    expect(await fixOf(s.fix.id)).toMatchObject({ status: "failed", planError: "step_failed:0" });
    expect(await commandsOf(s.serverId)).toHaveLength(1);
  });

  it("NEGATIVO: l'approvazione revocata fra due passi → il secondo non si firma", async () => {
    const s = await scene();
    await runNextApprovedFix(deps({ after: async () => void (await db.update(serverOperationApprovals).set({ revokedAt: new Date() }).where(eq(serverOperationApprovals.id, s.approvalId!))) }));
    expect(await fixOf(s.fix.id)).toMatchObject({ status: "failed", planError: "approval_revoked" });
    expect(await commandsOf(s.serverId)).toHaveLength(1);
  });

  it("NEGATIVO: il container legato a un ALTRO progetto a metà → il passo dopo non si firma", async () => {
    const s = await scene();
    await runNextApprovedFix(deps({ after: async () => void (await db.update(environmentServers).set({ containers: ["db-b", "web-a"] }).where(eq(environmentServers.environmentId, s.envs[1]!))) }));
    expect(await fixOf(s.fix.id)).toMatchObject({ status: "failed", planError: "recheck:container_of_other_project" });
    expect(await commandsOf(s.serverId)).toHaveLength(1);
  });

  it("lo Stop a metà: la correzione resta stopped e nessun passo dopo si firma", async () => {
    const s = await scene();
    await runNextApprovedFix(deps({ after: async () => void (await db.update(serverFixes).set({ status: "stopped" }).where(eq(serverFixes.id, s.fix.id))) }));
    expect((await fixOf(s.fix.id)).status).toBe("stopped");
    expect(await commandsOf(s.serverId)).toHaveLength(1);
  });

  it("operazioni spente → nessun comando", async () => {
    const s = await scene({ operations: false });
    await runNextApprovedFix(deps());
    expect(await fixOf(s.fix.id)).toMatchObject({ status: "failed", planError: "operations_off" });
    expect(await commandsOf(s.serverId)).toEqual([]);
  });
});

/** Il «CLI» della sessione che propone: chiama gli strumenti dal ponte. */
function cli(calls: (tool: (name: string, args?: object) => Promise<{ status: number; body: { ok?: boolean; message?: string } }>) => Promise<void>, seen: AgentRunOptions[] = []) {
  return new FakeAgentRunner({
    script: async (opts: AgentRunOptions): Promise<AgentRunResult> => {
      seen.push(opts);
      const env = opts.mcpConfig!.servers[SERVER_MCP_SERVER_NAME]!.env!;
      await calls(async (name, args = {}) => {
        const res = await fetch(`${env["SERVER_OPS_BRIDGE_URL"]}/tools/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${env["SERVER_OPS_BRIDGE_SECRET"]}` },
          body: JSON.stringify(args),
        });
        return { status: res.status, body: (await res.json()) as { ok?: boolean; message?: string } };
      });
      return { output: "fatto", exitCode: 0 };
    },
  });
}

async function drainProposals(d: ServerFixDeps) {
  while (await proposeNextServerFix(d)) {
    /* una alla volta */
  }
}

describe("un piano nuovo: la sessione server_fix", () => {
  it("area 9, F4 (46): con la coda del progetto attribuito in pausa la proposta aspetta (nessuna sessione); alla ripresa parte", async () => {
    const s = await scene({ status: "proposing" });
    const seen: AgentRunOptions[] = [];
    const runner = cli(async (tool) => {
      await tool("propose_server_plan", { steps: [restart] });
    }, seen);
    await db.update(projects).set({ queuePausedAt: new Date() }).where(eq(projects.id, s.projectId));
    try {
      expect(await proposeNextServerFix(deps({ runner }))).toBe(false);
      expect(seen).toHaveLength(0);
      expect(await fixOf(s.fix.id)).toMatchObject({ status: "proposing", sessionId: null });
    } finally {
      await db.update(projects).set({ queuePausedAt: null }).where(eq(projects.id, s.projectId));
    }
    await drainProposals(deps({ runner }));
    expect((await fixOf(s.fix.id)).status).toBe("awaiting_approval");
  });

  it("sole letture e propose_server_plan; un piano valido va in attesa d'approvazione; il resoconto dell'analisi qui non esiste", async () => {
    const s = await scene({ status: "proposing" });
    const seen: AgentRunOptions[] = [];
    let reportStatus = 0;
    await drainProposals(
      deps({
        runner: cli(async (tool) => {
          reportStatus = (await tool("report_server_diagnosis", { summary: "x", cause: { projectCode: null, containers: [], why: "" } })).status;
          expect((await tool("propose_server_plan", { steps: [restart] })).body.ok).toBe(true);
          expect((await tool("propose_server_plan", { steps: [start] })).body.ok).toBe(false);
        }, seen),
      }),
    );
    expect(reportStatus).toBe(404);
    const opts = seen.find((o) => o.usage.operation === "server_fix_plan")!;
    expect(opts.allowedTools).toEqual(SERVER_FIX_TOOLS.map((t) => `mcp__${SERVER_MCP_SERVER_NAME}__${t}`));
    expect(opts.builtinTools).toBe("");
    expect(opts.usage).toEqual({ operation: "server_fix_plan", projectId: s.projectId });
    const fix = await fixOf(s.fix.id);
    expect(fix).toMatchObject({ status: "awaiting_approval", steps: [restart] });
    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, fix.sessionId!));
    expect(session).toMatchObject({ kind: "server_fix", projectId: s.projectId, ticketId: s.fix.taskId });
  });

  it("NEGATIVO: un piano su un container di un altro progetto, o un rilascio, non si salva → nessun piano, col motivo", async () => {
    const s = await scene({ status: "proposing" });
    const replies: boolean[] = [];
    await drainProposals(
      deps({
        runner: cli(async (tool) => {
          replies.push((await tool("propose_server_plan", { steps: [{ ...restart, params: { container: "db-b", timeoutSeconds: 5 } }] })).body.ok!);
          replies.push((await tool("propose_server_plan", { steps: [{ action: "image.pull", params: { image: "evil:latest" }, why: "deploy" }] })).body.ok!);
        }),
      }),
    );
    expect(replies).toEqual([false, false]);
    expect(await fixOf(s.fix.id)).toMatchObject({ status: "none", steps: [], planError: "no_plan" });
  });

  it("review F4b, I3: nella correzione si leggono SOLO i container del progetto della task", async () => {
    const s = await scene({ status: "proposing" });
    const replies: { ok?: boolean; message?: string }[] = [];
    await drainProposals(
      deps({
        runner: cli(async (tool) => {
          replies.push((await tool("container_logs", { container: "db-b", lines: 20, sinceMinutes: 10 })).body);
          replies.push((await tool("container_state", { container: "db-b" })).body);
        }),
      }),
    );
    for (const r of replies) expect(r).toMatchObject({ ok: false, message: expect.stringContaining("only containers of this task's project") });
    // Nessun comando per il container dell'altro progetto (la lettura su web-a la coprono i test dell'analisi).
    expect(await commandsOf(s.serverId)).toEqual([]);
  });

  it("review F4b: una sessione di prima (Stop e richiesta di nuovo mentre gira) non scrive nella richiesta nuova", async () => {
    const s = await scene({ status: "proposing" });
    const other = (await db.insert(agentSessions).values({ ownerKey: `x:${randomBytes(4).toString("hex")}`, kind: "server_fix", title: "nuova" }).returning())[0]!.id;
    let reply: { ok?: boolean } = {};
    await drainProposals(
      deps({
        runner: cli(async (tool) => {
          // Nel frattempo: fermata e richiesta di nuovo, con una sessione nuova.
          await db.update(serverFixes).set({ sessionId: other }).where(eq(serverFixes.id, s.fix.id));
          reply = (await tool("propose_server_plan", { steps: [restart] })).body;
        }),
      }),
    );
    expect(reply.ok).toBe(false);
    expect((await fixOf(s.fix.id)).steps).toEqual([]);
  });

  it("budget mensile esaurito → nessun run, nessun piano", async () => {
    const s = await scene({ status: "proposing" });
    await db.update(instanceSettings).set({ monthlyBudgetUsd: "1" }).where(eq(instanceSettings.id, 1));
    const seen: AgentRunOptions[] = [];
    await drainProposals(deps({ budgetSpent: 5, runner: cli(async () => undefined, seen) }));
    await db.update(instanceSettings).set({ monthlyBudgetUsd: null }).where(eq(instanceSettings.id, 1));
    expect(seen).toEqual([]);
    expect(await fixOf(s.fix.id)).toMatchObject({ status: "none", planError: "monthly_budget" });
  });
});


describe("review F4b: una correzione appesa dopo un crash del worker", () => {
  it("running ferma da 30' → failed (worker_restart), approvazione revocata; una recente resta", async () => {
    const old = await scene();
    const fresh = await scene();
    const now = new Date();
    await db.update(serverFixes).set({ status: "running", updatedAt: new Date(now.getTime() - 31 * 60_000) }).where(eq(serverFixes.id, old.fix.id));
    await db.update(serverFixes).set({ status: "running", updatedAt: new Date(now.getTime() - 60_000) }).where(eq(serverFixes.id, fresh.fix.id));
    await recoverStaleFixes(db, now);
    expect(await fixOf(old.fix.id)).toMatchObject({ status: "failed", planError: "worker_restart" });
    expect((await db.select().from(serverOperationApprovals).where(eq(serverOperationApprovals.id, old.approvalId!)))[0]!.revokedAt).not.toBeNull();
    expect((await fixOf(fresh.fix.id)).status).toBe("running");
  });
});
