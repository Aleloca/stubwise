import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automations } from ".";
import { setAppClientForTests } from "./client";
import { forgetAutomationRefs } from "./automationsLive";
import { installFakeServer, me, ME_ID, PROJECT_ID } from "./fakeServer";
import { getSessionPerson } from "./session";

// Il cablaggio delle Automations sul client vero (area 7, F1, R2/R7):
// `api.automations` della build app parla con `client.automations`. Il
// server finto risponde con le forme di `@stubwise/shared/automations`, come
// le rotte di 72 (`apps/server/src/routes/automations*.ts`).

const A_ID = "77777777-7777-4777-8777-777777777771";
const RUN_ID = "77777777-7777-4777-8777-777777777772";
const FLOW = { trigger: { kind: "manual" }, steps: [], titleTemplate: "Prova" };

const serverAutomation = (rev: number) => ({
  id: A_ID,
  code: "AUD-A1",
  name: "Avvio",
  description: "",
  projectId: PROJECT_ID,
  ownerId: ME_ID,
  status: "draft",
  versions: [
    {
      n: 1,
      flow: FLOW,
      publishedAt: null,
      publishedById: null,
      savedAt: "2026-11-13T09:00:00.000Z",
      savedById: ME_ID,
      rev,
      testedRev: null,
    },
  ],
});
const serverRow = (rev: number) => ({ ...serverAutomation(rev), permissions: { manage: true } });
const serverRun = (over: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  automationId: A_ID,
  n: 3,
  code: "AUD-A1 #3",
  automationCode: "AUD-A1",
  automationName: "Avvio",
  automationProjectId: PROJECT_ID,
  status: "waiting",
  cursor: "0",
  round: 2,
  ...over,
});

beforeEach(() => {
  setAppClientForTests(null);
  forgetAutomationRefs();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("le Automations della build app sul client vero", () => {
  it("elenco, dettaglio e check della bozza vanno alle rotte per codice", async () => {
    const { seen } = installFakeServer({
      "GET /api/automations": { body: { items: [serverRow(4)] } },
      "GET /api/automations/AUD-A1": {
        body: { automation: serverRow(4), configErrors: [], liveErrors: [], runs: [serverRun()] },
      },
      "POST /api/automations/AUD-A1/check": {
        body: { issues: [{ path: "0", code: "incomplete", message: "x" }] },
      },
    });
    expect(
      (await automations.listAutomations({ projectId: PROJECT_ID })).map((a) => a.code),
    ).toEqual(["AUD-A1"]);
    expect((await automations.getAutomation(A_ID))?.runs.map((r) => r.id)).toEqual([RUN_ID]);
    expect(await automations.checkDraft(A_ID, FLOW as never)).toEqual([
      { path: "0", code: "incomplete", message: "x" },
    ]);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /api/automations?project=${PROJECT_ID}`,
      "GET /api/automations/AUD-A1",
      "POST /api/automations/AUD-A1/check",
    ]);
    expect(seen[2]!.body).toEqual({ flow: FLOW });
  });

  it("salvataggio col rev letto, pubblicazione col rev nuovo; un 409 config è `invalid: config`", async () => {
    const { seen } = installFakeServer({
      "GET /api/automations": { body: { items: [serverRow(4)] } },
      "PUT /api/automations/AUD-A1/draft": { body: serverAutomation(5) },
      "POST /api/automations/AUD-A1/publish": {
        status: 409,
        body: {
          code: "config",
          message: "config",
          issues: [{ path: "0", code: "incomplete", message: "x" }],
        },
      },
    });
    await automations.listAutomations();
    await automations.saveDraft(A_ID, FLOW as never);
    await expect(automations.publish(A_ID)).rejects.toThrow("invalid: config");
    expect(seen[1]!.body).toEqual({ flow: FLOW, expectedRev: 4 });
    expect(seen[2]!.body).toEqual({ expectedRev: 5 });
  });

  it("le decisioni vanno all'esecuzione per codice e numero, col passo e il giro visti", async () => {
    const { seen } = installFakeServer({
      "GET /api/automation-runs": { body: { items: [serverRun()], nextCursor: null } },
      "POST /api/automations/AUD-A1/runs/3/approve": { status: 204 },
      "POST /api/automations/AUD-A1/runs/3/reject": {
        status: 409,
        body: { code: "stale", message: "stale" },
      },
    });
    await automations.listRuns();
    await automations.approve(RUN_ID, undefined, { expectedPath: "0" });
    await expect(automations.reject(RUN_ID, { expectedPath: "0" })).rejects.toThrow(
      "invalid: not_waiting",
    );
    expect(seen[1]).toMatchObject({
      path: "/api/automations/AUD-A1/runs/3/approve",
      body: { expectedPath: "0", expectedRound: 2 },
    });
  });

  it("la Home e «Da decidere» leggono le mie esecuzioni e le mie approvazioni, e se ne ricorda il giro", async () => {
    const { seen } = installFakeServer({
      "GET /api/me/automation-runs": { body: { items: [serverRun()] } },
      "GET /api/me/automation-approvals": {
        body: {
          items: [{ runId: RUN_ID, automationCode: "AUD-A1", n: 3, cursor: "1", round: 5 }],
        },
      },
      "POST /api/automations/AUD-A1/runs/3/approve": { status: 204 },
    });
    expect((await automations.listMyRuns()).map((r) => r.id)).toEqual([RUN_ID]);
    expect((await automations.listMyApprovals()).map((d) => d.runId)).toEqual([RUN_ID]);
    await automations.approve(RUN_ID, undefined, { expectedPath: "1" });
    expect(seen.map((r) => r.path)).toEqual([
      "/api/me/automation-runs?log=none",
      "/api/me/automation-approvals",
      "/api/automations/AUD-A1/runs/3/approve",
    ]);
    expect(seen[2]!.body).toEqual({ expectedPath: "1", expectedRound: 5 });
  });

  it("la sezione del progetto e la riga d'origine; un'origine che non si vede è `visible: false`", async () => {
    const view = { projectId: PROJECT_ID, own: [], general: [] };
    const { seen } = installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/automations`]: { body: view },
      "GET /api/automation-origin": (req) =>
        req.path.includes("task=AUD-7")
          ? { body: { visible: true, code: "AUD-A1", name: "Avvio", n: 3, entry: "0" } }
          : undefined,
    });
    expect(await automations.getProjectAutomations(PROJECT_ID)).toEqual(view);
    const ref = { automationId: A_ID, runId: RUN_ID };
    expect(await automations.automationOrigin(ref, "AUD-7", "task")).toMatchObject({
      visible: true,
      n: 3,
    });
    // 404: la task non si vede più o non l'ha creata un'automazione.
    expect(await automations.automationOrigin(ref, "m-1", "milestone")).toEqual({ visible: false });
    expect(seen.map((r) => r.path)).toEqual([
      `/api/projects/${PROJECT_ID}/automations`,
      "/api/automation-origin?task=AUD-7",
      "/api/automation-origin?milestone=m-1",
    ]);
  });

  it("la prova: gli esempi per codice, e a prova finita bene `/tested` con la rev (uno stale non la rompe)", async () => {
    const empty = { trigger: { kind: "manual" }, steps: [], titleTemplate: "Prova" };
    const context = {
      automation: {
        ...serverAutomation(7),
        versions: [{ ...serverAutomation(7).versions[0], flow: empty }],
      },
      version: 1,
      draft: true,
      rev: 7,
      ownerId: ME_ID,
      configErrors: [],
      people: [{ id: ME_ID, name: "Ada", departmentIds: [], deactivated: false }],
      projects: [],
    };
    const { seen } = installFakeServer({
      "GET /api/auth/me": { body: me() },
      "GET /api/automations": { body: { items: [serverRow(7)] } },
      "GET /api/automations/AUD-A1/examples": { body: { items: [], context } },
      "POST /api/automations/AUD-A1/tested": {
        status: 409,
        body: { code: "stale", message: "stale", rev: 8 },
      },
    });
    await getSessionPerson();
    await automations.listAutomations();
    expect(await automations.listSimulationExamples(A_ID, "draft")).toEqual([]);
    const id = await automations.startSimulation(A_ID, "draft", {});
    expect((await automations.getSimulation(id))?.status).toBe("done");
    expect(
      seen.filter((r) => r.path.includes("AUD-A1/")).map((r) => `${r.method} ${r.path}`),
    ).toEqual([
      "GET /api/automations/AUD-A1/examples?version=draft",
      "POST /api/automations/AUD-A1/tested",
    ]);
    expect(seen.at(-1)!.body).toEqual({ version: 1, rev: 7 });
  });
});

describe("gli input che il worker applica dopo (review I2)", () => {
  const detail = (over: Record<string, unknown> = {}) => ({
    ...serverRun({ status: "waiting_approval", cursor: "0", round: 2 }),
    version: 1,
    title: "Avvio",
    event: {},
    vars: {},
    waitingUntil: null,
    pending: { approverIds: [ME_ID], preview: {} },
    log: [],
    startedAt: "2026-11-13T09:00:00.000Z",
    endedAt: null,
    error: null,
    projectIds: [PROJECT_ID],
    flow: FLOW,
    deciders: [ME_ID],
    ownerId: ME_ID,
    permissions: { manage: true, approve: true, chooseProject: false },
    parent: null,
    children: [],
    pendingEffect: null,
    ...over,
  });

  it("dopo Approva, finché il worker non l'applica: fuori da «Da decidere», «in coda» nel dettaglio; poi si rilegge", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let applied = false;
      installFakeServer({
        "GET /api/me/automation-approvals": {
          body: { items: [{ runId: RUN_ID, automationCode: "AUD-A1", n: 3, cursor: "0", round: 2 }] },
        },
        "GET /api/automations/AUD-A1/runs/3": () => ({
          body: applied ? detail({ status: "running", cursor: "1", pending: null }) : detail(),
        }),
        "POST /api/automations/AUD-A1/runs/3/approve": { status: 204 },
      });
      expect(await automations.listMyApprovals()).toHaveLength(1);
      expect((await automations.getRun(RUN_ID))?.permissions.approve).toBe(true);
      await automations.approve(RUN_ID, undefined, { expectedPath: "0" });
      // Il server non l'ha ancora applicato: la voce non torna, e non si decide due volte.
      expect(await automations.listMyApprovals()).toEqual([]);
      const queued = await automations.getRun(RUN_ID);
      expect(queued?.inputQueued).toBe(true);
      expect(queued?.permissions.approve).toBe(false);
      let idle = false;
      void automations.whenAutomationsIdle().then(() => (idle = true));
      await vi.advanceTimersByTimeAsync(2500);
      expect(idle).toBe(false);
      applied = true;
      await vi.advanceTimersByTimeAsync(1500);
      expect(idle).toBe(true);
      expect((await automations.getRun(RUN_ID))?.inputQueued).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("annulla, riprova e salta aspettano anche loro; un worker fermo non blocca oltre i 10 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      installFakeServer({
        "GET /api/automation-runs": {
          body: { items: [serverRun({ status: "failed", cursor: "1" })], nextCursor: null },
        },
        "GET /api/automations/AUD-A1/runs/3": {
          body: detail({ status: "failed", cursor: "1", pending: null }),
        },
        "POST /api/automations/AUD-A1/runs/3/retry": { status: 204 },
      });
      await automations.listRuns();
      await automations.retryStep(RUN_ID);
      expect((await automations.getRun(RUN_ID))?.inputQueued).toBe(true);
      let idle = false;
      void automations.whenAutomationsIdle().then(() => (idle = true));
      await vi.advanceTimersByTimeAsync(9000);
      expect(idle).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(idle).toBe(true);
      expect((await automations.getRun(RUN_ID))?.inputQueued).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("la prova dopo una modifica (review, minore)", () => {
  it("salvare la bozza butta il contesto della prova: la prova dopo gira sul flusso nuovo", async () => {
    const context = {
      automation: serverAutomation(7),
      version: 1,
      draft: true,
      rev: 7,
      ownerId: ME_ID,
      configErrors: [],
      people: [{ id: ME_ID, name: "Ada", departmentIds: [], deactivated: false }],
      projects: [],
    };
    const { seen } = installFakeServer({
      "GET /api/auth/me": { body: me() },
      "GET /api/automations": { body: { items: [serverRow(7)] } },
      "GET /api/automations/AUD-A1/examples": { body: { items: [], context } },
      "PUT /api/automations/AUD-A1/draft": { body: serverAutomation(8) },
      "POST /api/automations/AUD-A1/tested": { status: 204 },
    });
    await getSessionPerson();
    await automations.listAutomations();
    await automations.listSimulationExamples(A_ID, "draft");
    await automations.saveDraft(A_ID, FLOW as never);
    await automations.startSimulation(A_ID, "draft", {});
    expect(seen.filter((r) => r.path.includes("/examples"))).toHaveLength(2);
  });
});

describe("la prova con Claude vero (F3, le rotte di 72)", () => {
  const claudeFlow = {
    trigger: { kind: "manual" },
    titleTemplate: "Prova",
    steps: [
      {
        id: "c1",
        kind: "claude",
        instruction: "Firmato?",
        inputs: ["avvio.data"],
        outcomes: ["si", "no"],
        fields: [],
        branches: { si: [], no: [] },
      },
    ],
  };
  const context = {
    automation: {
      ...serverAutomation(7),
      versions: [{ ...serverAutomation(7).versions[0], flow: claudeFlow }],
    },
    version: 1,
    draft: true,
    rev: 7,
    ownerId: ME_ID,
    configErrors: [],
    people: [{ id: ME_ID, name: "Ada", departmentIds: [], deactivated: false }],
    projects: [],
  };
  const base = (claude: { status?: number; body?: unknown }) => ({
    "GET /api/auth/me": { body: me() },
    "GET /api/automations": { body: { items: [serverRow(7)] } },
    "GET /api/automations/AUD-A1/examples": { body: { items: [], context } },
    "POST /api/automations/AUD-A1/test/estimate": {
      body: { claudeSteps: 1, estimateUsd: 0.01, model: "claude-sonnet" },
    },
    "POST /api/automations/AUD-A1/test/claude": claude,
    "POST /api/automations/AUD-A1/tested": { status: 204 },
  });
  const start = async () => {
    await getSessionPerson();
    await automations.listAutomations();
    const id = await automations.startSimulation(A_ID, "draft", { avvio: { data: "2026-11-13" } });
    const first = await automations.simulationStep(id, { kind: "run" });
    expect(first.costToConfirm).toEqual({ claudeSteps: 1, estimateUsd: 0.01, model: "claude-sonnet" });
    await automations.confirmSimulationCost(id);
    return id;
  };

  it("stima e risposta dalle rotte vere, coi corpi esatti", async () => {
    const { seen } = installFakeServer(base({ body: { outcome: "si", reason: "Firmato", truncated: [] } }));
    const id = await start();
    const v = await automations.simulationStep(id, { kind: "run" });
    expect(v.status).toBe("done");
    expect(seen.find((r) => r.path.endsWith("/test/estimate"))!.body).toEqual({
      version: "draft",
      event: { avvio: { data: "2026-11-13" } },
    });
    expect(seen.find((r) => r.path.endsWith("/test/claude"))!.body).toEqual({
      version: 1,
      path: "0",
      vars: expect.objectContaining({ "avvio.data": "2026-11-13" }),
    });
  });

  it("un 404 della stima: automazione sparita (not_found) o server senza la F3 (not_available)", async () => {
    const routes = (automationGone: boolean) => ({
      ...base({ body: { outcome: "si", reason: "x", truncated: [] } }),
      "POST /api/automations/AUD-A1/test/estimate": { status: 404, body: { code: "not_found", message: "x" } },
      "GET /api/automations/AUD-A1": automationGone
        ? { status: 404, body: { code: "not_found", message: "x" } }
        : { body: { automation: serverRow(7), configErrors: [], liveErrors: [], runs: [] } },
    });
    for (const [gone, code] of [
      [true, "not_found"],
      [false, "not_available"],
    ] as const) {
      installFakeServer(routes(gone));
      forgetAutomationRefs();
      await getSessionPerson();
      await automations.listAutomations();
      const id = await automations.startSimulation(A_ID, "draft", {});
      expect((await automations.simulationStep(id, { kind: "run" })).interrupted).toBe(code);
    }
  });

  it("una risposta fuori forma (422) fa fallire il passo col codice del motore; il budget finito (409) ferma la prova", async () => {
    installFakeServer(
      base({
        status: 422,
        body: { code: "claude_invalid", message: "x", error: "unknown_outcome", result: { outcome: "forse", reason: "boh" } },
      }),
    );
    let id = await start();
    const v = await automations.simulationStep(id, { kind: "run" });
    expect(v.status).toBe("failed");
    expect(v.error).toBe("unknown_outcome");
    installFakeServer(base({ status: 409, body: { code: "budget", message: "budget" } }));
    forgetAutomationRefs();
    id = await start();
    expect((await automations.simulationStep(id, { kind: "run" })).interrupted).toBe("budget");
  });
});

describe("al cambio di persona", () => {
  it("codici e revisioni letti dalla persona di prima non valgono per la nuova", async () => {
    let who = me();
    installFakeServer({
      "GET /api/auth/me": () => ({ body: who }),
      "GET /api/automations": { body: { items: [serverRow(4)] } },
      "GET /api/automations/AUD-A1": {
        body: { automation: serverRow(4), configErrors: [], liveErrors: [], runs: [] },
      },
    });
    await getSessionPerson();
    await automations.listAutomations();
    expect(await automations.getAutomation(A_ID)).not.toBeNull();
    who = me({ user: { ...me().user, id: "22222222-2222-4222-8222-000000000002" } });
    await getSessionPerson();
    expect(await automations.getAutomation(A_ID)).toBeNull();
  });
});

describe("gli agganci delle pagine", () => {
  it("le esecuzioni le muove il worker: nessun evento dal client, e «idle» è una rilettura dopo un attimo", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const off = automations.onAutomationsSettled(() => {});
      expect(typeof off).toBe("function");
      off();
      let idle = false;
      void automations.whenAutomationsIdle().then(() => (idle = true));
      await vi.advanceTimersByTimeAsync(500);
      expect(idle).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(idle).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("una prova con errori di configurazione lancia la classe che le pagine riconoscono", async () => {
    const context = {
      automation: serverAutomation(7),
      version: 1,
      draft: true,
      rev: 7,
      ownerId: ME_ID,
      configErrors: [{ path: "0", code: "incomplete", message: "x" }],
      people: [{ id: ME_ID, name: "Ada", departmentIds: [], deactivated: false }],
      projects: [],
    };
    installFakeServer({
      "GET /api/auth/me": { body: me() },
      "GET /api/automations": { body: { items: [serverRow(7)] } },
      "GET /api/automations/AUD-A1/examples": { body: { items: [], context } },
    });
    await getSessionPerson();
    await automations.listAutomations();
    await expect(automations.startSimulation(A_ID, "draft", {})).rejects.toBeInstanceOf(
      automations.SimulationConfigError,
    );
  });
});
