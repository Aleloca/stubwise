import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automations } from ".";
import { setAppClientForTests } from "./client";
import { installFakeServer, PROJECT_ID, serverProject, serverTask } from "./fakeServer";
import { listNotifications } from "./notifications";
import { search } from "./search";
import { toMilestone } from "./statuses";
import { getTaskByCode } from "./tasks";

// Ciò che delle Automations compare FUORI dalla loro destinazione nella build
// app (area 7, F1), solo a destinazione accesa (il flag): un link
// porterebbe altrimenti a una pagina «in arrivo».
// - ⌘K: il gruppo `automations` di `GET /api/search`, già filtrato per
//   visibilità.
// - La riga d'origine di una task: solo se il server dice che l'ha creata
//   un'automazione (`source`), così un 404 di `/api/automation-origin` vuol
//   dire «non la vedi», mai «task manuale».
// - Le card `automation.*` dell'inbox: aprono l'esecuzione (o
//   l'automazione), coi campi che il server deriva a lettura.

const flag = vi.hoisted(() => ({ on: false }));
vi.mock("../../integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integration")>();
  return {
    ...actual,
    // La build app ha la destinazione accesa (R8): qui si prova anche spenta.
    isIntegrated: (t: Parameters<typeof actual.isIntegrated>[0]) =>
      t.kind === "destination" && t.name === "automations" ? flag.on : actual.isIntegrated(t),
  };
});

const group = <T>(items: T[]) => ({ items, hasMore: false });
const hit = {
  kind: "automation",
  id: "77777777-7777-4777-8777-777777777771",
  code: "AUD-A1",
  label: "Avvio",
  route: "#/automations/AUD-A1",
  status: "active",
};
const results = {
  tickets: group([]),
  projects: group([]),
  repositories: group([]),
  docs: group([]),
  automations: group([hit]),
};

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  flag.on = false;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("⌘K: automazioni ed esecuzioni dal server", () => {
  it("a destinazione accesa, il gruppo `automations` della ricerca", async () => {
    flag.on = true;
    const { seen } = installFakeServer({ "GET /api/search": { body: results } });
    expect(await automations.searchAutomations("avv")).toEqual([hit]);
    expect(seen.map((r) => r.path)).toEqual(["/api/search?q=avv&citable=true"]);
  });

  it("le task e le automazioni di ⌘K vengono da una sola ricerca (review, minore)", async () => {
    flag.on = true;
    const { seen } = installFakeServer({
      "GET /api/search": { body: results },
      "GET /api/projects": { body: [] },
    });
    await Promise.all([search("avv"), automations.searchAutomations("avv")]);
    expect(seen.filter((r) => r.path.startsWith("/api/search"))).toHaveLength(1);
  });

  it("a destinazione spenta non si chiede niente", async () => {
    const { seen } = installFakeServer({ "GET /api/search": { body: results } });
    expect(await automations.searchAutomations("avv")).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("un server senza il gruppo (più vecchio): nessun risultato", async () => {
    flag.on = true;
    const { automations: _omit, ...old } = results;
    void _omit;
    installFakeServer({ "GET /api/search": { body: old } });
    expect(await automations.searchAutomations("avv")).toEqual([]);
  });
});

describe("la riga d'origine di una task creata da un'automazione", () => {
  const routes = {
    "GET /api/tasks/by-code/AUD-12": { body: serverTask({ source: "automation" }) },
    "GET /api/tasks/by-code/AUD-13": { body: serverTask({ source: "manual" }) },
  };

  it("a destinazione accesa: solo la task con `source: automation` porta il riferimento (risolto dal server)", async () => {
    flag.on = true;
    installFakeServer(routes);
    expect((await getTaskByCode("AUD-12"))?.automationRef).toBeDefined();
    expect((await getTaskByCode("AUD-13"))?.automationRef).toBeUndefined();
  });

  it("a destinazione spenta nessuna riga", async () => {
    installFakeServer(routes);
    expect((await getTaskByCode("AUD-12"))?.automationRef).toBeUndefined();
  });
});

describe("le card `automation.*` dell'inbox", () => {
  const card = (over: Record<string, unknown> = {}) => ({
    id: "33333333-3333-4333-8333-333333333334",
    kind: "automation.failed",
    status: "open",
    text: "Avvio · AUD-A1 #3",
    summary: "Il passo 1 non è riuscito",
    actions: ["open"],
    projectId: PROJECT_ID,
    ticketId: null,
    jobId: null,
    createdAt: "2026-11-13T10:00:00.000Z",
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
    chat: null,
    automation: {
      automationCode: "AUD-A1",
      automationName: "Avvio",
      runCode: "AUD-A1 #3",
      runStatus: "failed",
      waitingOnYou: false,
      decided: false,
    },
    ...over,
  });
  const inbox = (items: unknown[]) =>
    installFakeServer({
      "GET /api/inbox": ({ path }) => ({
        body: { items: path.includes("status=open") ? items : [], nextCursor: null },
      }),
      "GET /api/projects": { body: [serverProject()] },
    });

  it("a destinazione accesa: l'esecuzione (o l'automazione, se la card non ne ha una)", async () => {
    flag.on = true;
    const paused = card({
      id: "33333333-3333-4333-8333-333333333335",
      kind: "automation.paused",
      createdAt: "2026-11-13T09:00:00.000Z",
      automation: { ...card().automation, runCode: null, runStatus: null },
    });
    inbox([card(), paused]);
    const [failed, other] = await listNotifications();
    expect(failed).toMatchObject({
      objectCode: "AUD-A1 #3",
      title: "Avvio · AUD-A1 #3",
      body: "Il passo 1 non è riuscito",
      link: "#/automations/AUD-A1/runs/3",
    });
    expect(failed!.webHref).toBeUndefined();
    expect(other).toMatchObject({ objectCode: "AUD-A1", link: "#/automations/AUD-A1" });
  });

  it("a destinazione spenta niente link; un'automazione sparita è `objectGone`", async () => {
    inbox([
      card(),
      card({ id: "33333333-3333-4333-8333-333333333336", automation: null, objectGone: true }),
    ]);
    const [a, gone] = await listNotifications();
    expect(a!.link).toBe("");
    expect(gone).toMatchObject({ objectGone: true, link: "" });
  });
});

describe("la riga d'origine di un traguardo creato da un'automazione", () => {
  const m = (over: Record<string, unknown> = {}) => ({
    id: "m-1",
    projectId: PROJECT_ID,
    name: "Kick-off",
    description: null,
    dueDate: null,
    status: "open",
    ...over,
  });

  it("a destinazione accesa: solo con `automationCreated: true` (assente = no)", () => {
    flag.on = true;
    expect(toMilestone(m({ automationCreated: true })).automationRef).toBeDefined();
    expect(toMilestone(m({ automationCreated: false })).automationRef).toBeUndefined();
    expect(toMilestone(m()).automationRef).toBeUndefined();
  });

  it("a destinazione spenta nessuna riga", () => {
    expect(toMilestone(m({ automationCreated: true })).automationRef).toBeUndefined();
  });
});
