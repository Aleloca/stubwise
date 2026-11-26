import { ApiError } from "@stubwise/api-client";
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
    // Area 11, F6 (72, 136a81da2): la pagina solo a chi legge i Docs del progetto.
    job({ id: "j6", kind: "product_doc_update", code: "ACQ-D5", title: "Sign-in" }),
    job({ id: "j7", kind: "product_doc_update", code: null, title: "" }),
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

const calls: string[] = [];
const fake = (over: Partial<InstanceStatusApi> = {}): InstanceStatusApi => ({
  status: async () => status(),
  pauseQueue: async (id) => {
    calls.push(`pause ${id}`);
  },
  resumeQueue: async (id) => {
    calls.push(`resume ${id}`);
  },
  retryJob: async (id) => {
    calls.push(`retry ${id}`);
    return { jobId: "new-job", status: "queued", stopsAtPlan: true };
  },
  project: async () => ({ id: "p1", queuePause: null }),
  ...over,
});
const refusing = (status: number, code: string) => async () => {
  throw new ApiError(status, code, code);
};

describe("lo Stato dell'istanza dal server (area 9, F4)", () => {
  it("i link li compone il client da tipo, progetto e codice (il server non conosce le rotte)", async () => {
    const v = await createRealInstanceStatus(fake()).getInstanceStatus();
    expect(v.jobs.map((j) => j.href)).toEqual([
      "#/p/ACQ/tasks?task=ACQ-57",
      "#/automations/ACQ-A2/runs/7",
      "#/admin/servers/SRV-3",
      "#/p/ACQ/servers/SRV-4",
      null,
      "#/p/ACQ/docs/product/ACQ-D5",
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

  it("pausa, ripresa e rilancio sulle rotte del server; i rifiuti nelle parole della pagina", async () => {
    calls.splice(0);
    const st = createRealInstanceStatus(fake());
    expect(await st.pauseQueue("p1")).toEqual({ ok: true });
    expect(await st.resumeQueue("p1")).toEqual({ ok: true });
    expect(await st.retryJob("j9")).toEqual({ ok: true, conversationId: "new-job" });
    expect(calls).toEqual(["pause p1", "resume p1", "retry j9"]);
    const paused = createRealInstanceStatus(fake({ pauseQueue: refusing(409, "already_paused") }));
    expect(await paused.pauseQueue("p1")).toEqual({
      ok: false,
      error: "invalid",
      reason: "already_paused",
    });
    const stale = createRealInstanceStatus(fake({ retryJob: refusing(409, "conflict") }));
    expect(await stale.retryJob("j9")).toEqual({ ok: false, error: "conflict" });
    const budget = createRealInstanceStatus(fake({ retryJob: refusing(422, "monthly_budget") }));
    expect(await budget.retryJob("j9")).toEqual({
      ok: false,
      error: "invalid",
      reason: "monthly_budget",
    });
    // Lotto 4, review I-1 (72, 9389b5efc): un codice solo per il budget finito, 409 `budget_exhausted`.
    const exhausted = createRealInstanceStatus(fake({ retryJob: refusing(409, "budget_exhausted") }));
    expect(await exhausted.retryJob("j9")).toEqual({
      ok: false,
      error: "invalid",
      reason: "monthly_budget",
    });
    const no = createRealInstanceStatus(fake({ resumeQueue: refusing(403, "forbidden") }));
    expect(await no.resumeQueue("p1")).toEqual({ ok: false, error: "forbidden" });
  });

  it("senza instance.status.view il server dice 403: la lettura è forbidden (review F4, I2)", async () => {
    const no = createRealInstanceStatus(
      fake({
        status: async () => {
          throw new ApiError(403, "Missing permission instance.status.view", "forbidden");
        },
      }),
    );
    await expect(no.getInstanceStatus()).rejects.toThrow("forbidden");
  });

  it("un codice di progetto vuoto non fa un link rotto (review F4, M5)", async () => {
    const v = await createRealInstanceStatus(
      fake({
        status: async () => ({
          ...status(),
          jobs: [
            job({ projectCode: "" }),
            job({ id: "j2", kind: "server_fix", code: "SRV-4", projectCode: "" }),
          ],
          errors: [],
        }),
      }),
    ).getInstanceStatus();
    expect(v.jobs.map((j) => j.href)).toEqual([null, null]);
  });

  it("la pausa di un progetto dalla sua vista; invisibile o senza pausa, niente (72, 5713037b2)", async () => {
    const paused = createRealInstanceStatus(
      fake({
        project: async () => ({
          queuePause: { byId: null, byName: "Roberta Fontana", since: "2026-11-18T08:00:00.000Z" },
        }),
      }),
    );
    expect(await paused.getQueuePause("p1")).toEqual({
      byId: "",
      byName: "Roberta Fontana",
      since: "2026-11-18T08:00:00.000Z",
    });
    expect(await createRealInstanceStatus(fake()).getQueuePause("p1")).toBeNull();
    const hidden = createRealInstanceStatus(fake({ project: refusing(404, "not_found") }));
    expect(await hidden.getQueuePause("p1")).toBeNull();
  });
});
