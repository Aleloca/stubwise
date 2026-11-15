import { ApiError } from "@stubwise/api-client";
import { serverCommandViewSchema, serverTaskViewSchema } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { createRealServerTask, type ServerTaskApi } from "./serverTask";

// Area 8, F4b: la sezione Server della task nell'app, da `GET
// /api/tasks/:id/server` (72) e dal registro per task (`fixCommands`), nelle
// forme del prototipo (`getServerTaskInfo`). Lo stato della task lo deriva
// il renderer dallo stato della correzione; permessi e blocchi li dice il server.

const TICKET = "11111111-1111-4111-8111-111111111111";
const SRV = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";
const CMD = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-11-15T10:00:00.000Z";

const fixView = (over: Record<string, unknown> = {}) => ({
  taskId: TICKET,
  serverId: SRV,
  serverCode: "SRV-1",
  status: "awaiting_approval",
  steps: [
    {
      index: 0,
      action: "container.restart",
      params: { container: "portale-import", timeoutSeconds: 30 },
      why: "It leaks memory.",
    },
  ],
  operationsOn: true,
  canRequestPlan: false,
  canApprove: true,
  canStop: false,
  planDigest: "abc123",
  sessionId: SESSION,
  ...over,
});

const taskView = (over: Record<string, unknown> = {}) =>
  serverTaskViewSchema.parse({
    server: { id: SRV, code: "SRV-1", name: "acq-prod-01", projectCode: "ACQ" },
    episode: {
      severity: "trouble",
      reasons: [{ kind: "memory", valuePct: 94, thresholdPct: 90 }],
      startedAt: NOW,
    },
    analysis: null,
    fix: fixView(),
    startBlock: "busy",
    ...over,
  });

function fakeApi(over: Partial<ServerTaskApi> = {}) {
  const calls: unknown[][] = [];
  const api: ServerTaskApi = {
    taskServer: async () => taskView(),
    fixCommands: async () => ({
      commands: [
        serverCommandViewSchema.parse({
          id: CMD,
          action: "container.restart",
          params: { container: "portale-import", timeoutSeconds: 30 },
          kind: "change",
          via: "agent",
          status: "done",
          requestedBy: { id: USER, name: "Laura" },
          issuedAt: NOW,
          exitCode: 0,
          output: "portale-import",
        }),
      ],
    }),
    requestPlan: async (id) => {
      calls.push(["requestPlan", id]);
      return fixView({ status: "proposing" }) as never;
    },
    approve: async (id, digest) => {
      calls.push(["approve", id, digest]);
      return fixView({ status: "approved" }) as never;
    },
    reject: async (id, note) => {
      calls.push(["reject", id, note]);
      return fixView({ status: "rejected" }) as never;
    },
    stop: async (id) => {
      calls.push(["stop", id]);
      return fixView({ status: "stopped" }) as never;
    },
    ...over,
  };
  return { api, calls };
}

describe("la sezione Server della task nell'app (F4b)", () => {
  it("il piano che aspetta: server, episodio, vista della correzione e comandi", async () => {
    const info = (await createRealServerTask(fakeApi().api).getServerTaskInfo(TICKET))!;
    expect(info.server).toEqual({ code: "SRV-1", name: "acq-prod-01", projectCode: "ACQ" });
    expect(info.serverGone).toBe(false);
    expect(info.episode).toMatchObject({
      severity: "trouble",
      reasons: [{ kind: "memory", valuePct: 94, thresholdPct: 90 }],
      recoveredAt: null,
    });
    expect(info.state).toBe("plan_awaiting");
    expect(info.startBlock).toBe("run_live");
    expect(info.fixConversationId).toBe(SESSION);
    expect(info.fix).toMatchObject({
      status: "awaiting_approval",
      planDigest: "abc123",
      sessionId: SESSION,
      canApprove: true,
      canReject: true,
      steps: [
        { index: 0, action: "container.restart", why: "It leaks memory.", status: "waiting" },
      ],
    });
    expect(info.fix!.commands).toEqual([
      expect.objectContaining({
        id: CMD,
        action: "container.restart",
        kind: "change",
        via: "agent",
        status: "done",
        requestedById: USER,
        output: "portale-import",
      }),
    ]);
  });

  it("gli stati della task dallo stato della correzione", async () => {
    const stateOf = async (fix: Record<string, unknown> | null, startBlock: string | null = null) =>
      (await createRealServerTask(
        fakeApi({
          taskServer: async () => taskView({ fix: fix ? fixView(fix) : null, startBlock }),
        }).api,
      ).getServerTaskInfo(TICKET))!.state;
    expect(await stateOf(null)).toBe("diagnosis_ready");
    expect(await stateOf(null, "closed")).toBe("closed");
    expect(await stateOf({ status: "proposing" })).toBe("fix_planning");
    expect(await stateOf({ status: "running" })).toBe("fixing");
    expect(await stateOf({ status: "rejected" })).toBe("plan_rejected");
    expect(await stateOf({ status: "stopped" })).toBe("stopped");
    // Le parole di 72 (fix-run.ts): una proposta senza piano è `none` + `planError`.
    expect(await stateOf({ status: "none", planError: "no_plan" })).toBe("no_plan");
    expect(await stateOf({ status: "none", planError: "timeout" })).toBe("no_plan");
    // `done`: ogni passo ha avuto esito positivo (il rientro lo dice l'episodio).
    expect(await stateOf({ status: "done" })).toBe("resolved");
    // `failed`: un passo andato male o scaduto è «non risolta»; un ricontrollo che non tiene è «fermata».
    expect(await stateOf({ status: "failed", planError: "step_failed:1" })).toBe("not_resolved");
    expect(await stateOf({ status: "failed", planError: "step_expired:0" })).toBe("not_resolved");
    expect(await stateOf({ status: "failed", planError: "recheck:container_unbound" })).toBe(
      "stopped",
    );
    expect(await stateOf({ status: "failed", planError: "worker_restart" })).toBe("stopped");
  });

  it("un server sparito dal progetto: «deleted» col codice; uno che non si vede: nessun server", async () => {
    const gone = (await createRealServerTask(
      fakeApi({
        taskServer: async () =>
          taskView({
            server: { id: SRV, code: "SRV-1", name: "x", projectCode: "ACQ", gone: true },
          }),
      }).api,
    ).getServerTaskInfo(TICKET))!;
    expect(gone).toMatchObject({ server: null, serverGone: true, goneCode: "SRV-1" });
    const hidden = (await createRealServerTask(
      fakeApi({
        taskServer: async () => taskView({ server: { id: SRV, projectCode: "ACQ" } }),
      }).api,
    ).getServerTaskInfo(TICKET))!;
    expect(hidden).toMatchObject({ server: null, serverGone: false });
  });

  it("chi non vede i comandi (403): la sezione c'è, senza registro", async () => {
    const info = (await createRealServerTask(
      fakeApi({
        fixCommands: async () => {
          throw new ApiError(403, "forbidden", "forbidden");
        },
      }).api,
    ).getServerTaskInfo(TICKET))!;
    expect(info.fix!.commands).toEqual([]);
  });

  it("le azioni: chiede un piano, approva col digest, rifiuta con la nota, ferma; `plan_changed` nelle parole del prototipo", async () => {
    const { api, calls } = fakeApi();
    const real = createRealServerTask(api);
    await real.startServerFix(TICKET);
    await real.approveServerFix(TICKET, "abc123");
    await real.rejectServerFix(TICKET, "Not the database");
    await real.stopServerFix(TICKET);
    expect(calls).toEqual([
      ["requestPlan", TICKET],
      ["approve", TICKET, "abc123"],
      ["reject", TICKET, "Not the database"],
      ["stop", TICKET],
    ]);
    const changed = createRealServerTask(
      fakeApi({
        approve: async () => {
          throw new ApiError(409, "conflict", "plan_changed");
        },
      }).api,
    );
    await expect(changed.approveServerFix(TICKET, "old")).rejects.toThrow("invalid: plan_changed");
  });

  it("una task non nata da un server (404): nessuna sezione", async () => {
    const real = createRealServerTask(
      fakeApi({
        taskServer: async () => {
          throw new ApiError(404, "not_found", "not_found");
        },
      }).api,
    );
    expect(await real.getServerTaskInfo(TICKET)).toBeNull();
  });

  it("fermata da un ricontrollo: il motivo che il prototipo sa dire", async () => {
    const stopOf = async (planError: string) =>
      (await createRealServerTask(
        fakeApi({
          taskServer: async () => taskView({ fix: fixView({ status: "failed", planError }) }),
        }).api,
      ).getServerTaskInfo(TICKET))!.stop;
    expect(await stopOf("operations_off")).toEqual({
      byId: null,
      reason: "operations_off",
      outcome: "failed",
    });
    expect(await stopOf("server_not_in_project")).toMatchObject({ reason: "server_gone" });
    expect(await stopOf("approval_revoked")).toMatchObject({ reason: null, outcome: "failed" });
  });

  it("review: un avviso della pulizia vuoto non c'è; un piano in attesa blocca l'avvio", async () => {
    const info = (await createRealServerTask(
      fakeApi({
        taskServer: async () =>
          taskView({
            fix: fixView({ pruneWarning: { projects: [], hiddenCount: 0 } }),
            startBlock: "plan_awaiting",
          }),
      }).api,
    ).getServerTaskInfo(TICKET))!;
    expect(info.fix!.pruneWarning).toBeNull();
    expect(info.startBlock).toBe("run_live");
  });
});
