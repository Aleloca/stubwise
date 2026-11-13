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
      "/api/me/automation-runs",
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
