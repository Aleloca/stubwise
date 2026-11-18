import { describe, expect, it } from "vitest";
import { createRealInstanceStatus, type InstanceStatusApi } from "./instanceStatus";

// Area 9, F4: lo Stato dell'istanza su `GET /api/instance/status` (72, e7875b084).

const job = (over: Record<string, unknown>) => ({
  id: "j1",
  kind: "task_run",
  projectId: "p1",
  projectCode: "ACQ",
  title: "Export",
  code: "ACQ-57",
  state: "running",
  waiting: null,
  since: "2026-11-18T09:00:00.000Z",
  workerId: "4821:1",
  retry: "unavailable",
  retryNeeds: null,
  retryBlock: null,
  retryStopsAtPlan: false,
  href: null,
  summary: null,
  startFailed: false,
  superseded: false,
  ...over,
});

const status = () => ({
  queues: [],
  otherProjects: null,
  jobs: [
    job({}),
    job({ id: "j2", kind: "automation", code: "ACQ-A2 #7", workerId: null, state: "waiting" }),
    job({
      id: "j3",
      kind: "server_fix",
      code: "SRV-3",
      projectId: null,
      projectCode: "",
      state: "failed",
    }),
    job({ id: "j4", kind: "server_fix", code: "SRV-4", state: "failed" }),
    job({ id: "j5", kind: "pr_review", code: "#12" }),
  ],
  workers: [
    { id: "4821:0", jobId: null, hidden: false },
    { id: "4821:1", jobId: "j1", hidden: false },
  ],
  quota: [],
  errors: [
    {
      jobId: "j3",
      at: "2026-11-18T08:00:00.000Z",
      summary: "boom",
      startFailed: false,
      href: null,
    },
  ],
  nightly: [],
  refreshedAt: "2026-11-18T09:05:00.000Z",
});

const fake = (over: Partial<InstanceStatusApi> = {}): InstanceStatusApi => ({
  status: async () => status(),
  ...over,
});

describe("lo Stato dell'istanza dal server (area 9, F4)", () => {
  it("i link li compone il client da tipo, progetto e codice (il server non conosce le rotte)", async () => {
    const v = await createRealInstanceStatus(fake()).getInstanceStatus();
    expect(v.jobs.map((j) => j.href)).toEqual([
      "#/p/ACQ/tasks?task=ACQ-57",
      "#/automations/ACQ-A2/runs/7",
      "#/admin/servers/SRV-3",
      "#/p/ACQ/servers/SRV-4",
      null,
    ]);
    // L'errore porta dove porta il suo lavoro.
    expect(v.errors[0]!.href).toBe("#/admin/servers/SRV-3");
  });

  it("i worker sono gli slot del server, nell'ordine; il resto passa com'è", async () => {
    const v = await createRealInstanceStatus(fake()).getInstanceStatus();
    expect(v.workers.map((w) => [w.id, w.jobId])).toEqual([
      ["4821:0", null],
      ["4821:1", "j1"],
    ]);
    expect(v.refreshedAt).toBe("2026-11-18T09:05:00.000Z");
  });
});
