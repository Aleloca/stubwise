import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, PROJECT_ID, serverProject } from "./fakeServer";
import { liveProjectAutomations } from "./projectAutomations";

// Nella build app `@backend/access` è quello vero (`accessFacts.ts`): chi vede
// il progetto lo dicono i permessi del server. Qui lo stesso.
vi.mock("@backend/access", async () => {
  const real = await import("./accessFacts");
  return { ...real };
});

// Registro, area 9 r.1121: Progetto → Settings → Automations e le frasi
// «spento» (brief, Docs notturni, pulse, report) sulla lettura del progetto
// (`GET /api/projects/:id`) e sulla sua PATCH, coi soli campi cambiati.

const detail = (over: Record<string, unknown> = {}) => ({
  ...serverProject(),
  docAutoUpdate: true,
  dailyReportEnabled: false,
  backlogEnabled: true,
  pulseEnabled: true,
  pulseEveryDays: 5,
  weeklyBriefEnabled: false,
  prCorrectionMaxRounds: 3,
  modules: ["docs"],
  repositories: [],
  permissions: ["project.settings.manage"],
  ...over,
});

const meWith = (projectPermissions: string[]) =>
  me({ projectPermissions: { [PROJECT_ID]: projectPermissions } });

function server(
  projectPermissions = ["project.settings.manage"],
  over: Record<string, unknown> = {},
) {
  return installFakeServer({
    [`GET /api/projects/${PROJECT_ID}`]: { body: detail(over) },
    [`PATCH /api/projects/${PROJECT_ID}`]: ({ body }) => ({
      body: { ...serverProject(), ...(body as object) },
    }),
    "GET /api/auth/me": { body: meWith(projectPermissions) },
  });
}

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

// Revisione di 3bbe2ddc6..444b8b773, I-4: il diff si fa contro i valori da
// cui è partita la schermata (l'ultima `getProjectSettings`), non contro una
// rilettura al salvataggio, che sovrascriverebbe il cambio di un altro.
describe("due persone sugli stessi interruttori", () => {
  /** Un server col progetto che cambia: le PATCH lo aggiornano, come il vero. */
  function liveServer() {
    let project = detail({ pulseEnabled: false });
    const { seen } = installFakeServer({
      [`GET /api/projects/${PROJECT_ID}`]: () => ({ body: project }),
      [`PATCH /api/projects/${PROJECT_ID}`]: ({ body }) => {
        project = { ...project, ...(body as object) };
        return { body: project };
      },
      "GET /api/auth/me": { body: meWith(["project.settings.manage"]) },
    });
    return { seen, change: (over: Record<string, unknown>) => (project = { ...project, ...over }) };
  }

  it("Marco accende il pulse mentre Laura ha la schermata aperta: il salvataggio di Laura non lo rispegne", async () => {
    const { seen, change } = liveServer();
    const laura = (await liveProjectAutomations.getProjectSettings(PROJECT_ID))!;
    expect(laura.switches.pulse).toBe(false);
    change({ pulseEnabled: true });
    expect(
      await liveProjectAutomations.saveProjectAutomations(PROJECT_ID, {
        switches: laura.switches,
        pulseEveryDays: laura.pulseEveryDays,
        correctionCap: 5,
      }),
    ).toEqual({ ok: true });
    expect(seen.filter((r) => r.method === "PATCH").map((r) => r.body)).toEqual([{ prCorrectionMaxRounds: 5 }]);
  });

  it("un cambio di Laura stessa parte, anche se il server è cambiato nel frattempo", async () => {
    const { seen, change } = liveServer();
    const laura = (await liveProjectAutomations.getProjectSettings(PROJECT_ID))!;
    change({ prCorrectionMaxRounds: 4 });
    await liveProjectAutomations.saveProjectAutomations(PROJECT_ID, {
      switches: { ...laura.switches, dailyReport: true },
      pulseEveryDays: laura.pulseEveryDays,
      correctionCap: laura.correctionCap,
    });
    expect(seen.filter((r) => r.method === "PATCH").map((r) => r.body)).toEqual([{ dailyReportEnabled: true }]);
  });
});

describe("gli interruttori del progetto dal server (r.1121)", () => {
  it("la lettura: interruttori, giorni del pulse, tetto delle correzioni e chi può cambiarli", async () => {
    server();
    const v = (await liveProjectAutomations.getProjectSettings(PROJECT_ID))!;
    expect(v.switches).toEqual({
      docsNightly: true,
      dailyReport: false,
      backlogDiscovery: true,
      pulse: true,
      weeklyBrief: false,
    });
    expect(v.pulseEveryDays).toBe(5);
    expect(v.correctionCap).toBe(3);
    expect(v.pulseNeedsBacklog).toBe(false);
    expect(v.access.automations).toMatchObject({ visible: true, canEdit: true });
  });

  it("senza project.settings.manage la sezione si legge e non si cambia", async () => {
    server([]);
    const v = (await liveProjectAutomations.getProjectSettings(PROJECT_ID))!;
    expect(v.access.automations.canEdit).toBe(false);
  });

  it("le frasi «spento»: gli interruttori soli", async () => {
    server();
    expect(await liveProjectAutomations.getProjectSwitches(PROJECT_ID)).toMatchObject({
      weeklyBrief: false,
      docsNightly: true,
    });
  });

  it("salvare manda solo i campi cambiati, coi nomi del server", async () => {
    const { seen } = server();
    const out = await liveProjectAutomations.saveProjectAutomations(PROJECT_ID, {
      switches: {
        docsNightly: true,
        dailyReport: true,
        backlogDiscovery: true,
        pulse: true,
        weeklyBrief: true,
      },
      pulseEveryDays: 5,
      correctionCap: 0,
    });
    expect(out).toEqual({ ok: true });
    const patch = seen.find((r) => r.method === "PATCH")!;
    expect(patch.body).toEqual({
      dailyReportEnabled: true,
      weeklyBriefEnabled: true,
      prCorrectionMaxRounds: 0,
    });
  });

  it("le regole del prototipo prima della PATCH: il pulse senza discovery, i giorni, il tetto", async () => {
    const { seen } = server();
    const base = {
      docsNightly: true,
      dailyReport: false,
      backlogDiscovery: true,
      pulse: true,
      weeklyBrief: false,
    };
    const save = (
      input: Partial<{ switches: typeof base; pulseEveryDays: number; correctionCap: number }>,
    ) =>
      liveProjectAutomations.saveProjectAutomations(PROJECT_ID, {
        switches: base,
        pulseEveryDays: 5,
        correctionCap: 3,
        ...input,
      });
    expect(await save({ switches: { ...base, backlogDiscovery: false } })).toMatchObject({
      ok: false,
      error: "invalid",
      reason: "pulse_needs_backlog",
    });
    expect(await save({ pulseEveryDays: 31 })).toMatchObject({ ok: false, reason: "pulse_days" });
    expect(await save({ correctionCap: 11 })).toMatchObject({
      ok: false,
      reason: "correction_cap",
    });
    expect(seen.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("il server dice no: 403 è forbidden, 404 not_found", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}`]: { body: detail() },
      [`PATCH /api/projects/${PROJECT_ID}`]: {
        status: 403,
        body: { code: "forbidden", message: "x" },
      },
      "GET /api/auth/me": { body: meWith(["project.settings.manage"]) },
    });
    const out = await liveProjectAutomations.saveProjectAutomations(PROJECT_ID, {
      switches: {
        docsNightly: false,
        dailyReport: false,
        backlogDiscovery: true,
        pulse: true,
        weeklyBrief: false,
      },
      pulseEveryDays: 5,
      correctionCap: 3,
    });
    expect(out).toEqual({ ok: false, error: "forbidden" });
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}`]: {
        status: 404,
        body: { code: "not_found", message: "x" },
      },
    });
    expect(await liveProjectAutomations.getProjectSwitches(PROJECT_ID)).toBeNull();
  });
});
