import { describe, expect, it } from "vitest";
import { serverViewSchema } from "./server.js";
import { serverAnalysisViewSchema, serverCommandViewSchema, serverFixViewSchema, serverSshAccessViewSchema } from "./server-operations.js";

// Area 8, F4b: le forme sono additive e i default non concedono niente.
const ID = "11111111-1111-4111-8111-111111111111";
const AT = "2026-11-14T10:00:00.000Z";

describe("le forme delle operazioni sui server", () => {
  it("i minimi si leggono coi default", () => {
    expect(serverCommandViewSchema.parse({ id: ID, action: "container.logs", params: {}, kind: "read", status: "done", issuedAt: AT })).toMatchObject({ via: "agent", requestedBy: null, output: null });
    expect(serverAnalysisViewSchema.parse({ id: ID, serverId: ID, status: "running", startedAt: AT })).toMatchObject({ attribution: null, taskCode: null, blockedBy: null });
    expect(serverFixViewSchema.parse({ taskId: ID, serverId: ID, status: "none" })).toMatchObject({ steps: [], canApprove: false, canStop: false, canRequestPlan: false, operationsOn: false });
    expect(serverSshAccessViewSchema.parse({ status: "none" })).toMatchObject({ canManage: false, publicKey: null, verifyResult: null });
  });
  it("la vista di un server di prima: agentOperations false", () => {
    const view = serverViewSchema.parse({
      id: ID, name: "s", hostname: null, status: "online", sampleIntervalSeconds: 30, agentVersion: null,
      alertThresholds: { cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 }, lastSeenAt: null, createdAt: AT,
      projects: [], checksUp: 0, checksDown: 0, recentCpu: [],
    });
    expect(view.agentOperations).toBe(false);
  });
});

describe("agentConfigSchema: serverId è additivo", () => {
  it("una config di un server vecchio, senza serverId, si legge ancora", async () => {
    const { agentConfigSchema } = await import("./server.js");
    const cfg = agentConfigSchema.parse({ sampleIntervalSeconds: 30, checks: [] });
    expect(cfg.serverId).toBeUndefined();
  });
});
