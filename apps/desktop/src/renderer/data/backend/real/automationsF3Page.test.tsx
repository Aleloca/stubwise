import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { forgetAutomationRefs } from "./automationsLive";
import { setAppClientForTests } from "./client";
import {
  DEPT_ID,
  installFakeServer,
  me,
  ME_ID,
  PROJECT_ID,
  serverProject,
  type SeenRequest,
} from "./fakeServer";

// La prova con Claude vero nella build app (area 7, F3, D4 e F3-3 = a), fino
// alle richieste esatte: «Run to next stop» si FERMA al primo passo di Claude
// col costo stimato (una sola stima, nessuna chiamata a Claude, nessun giro
// che riparte da solo), e dopo «Test with Claude» chiede la risposta al
// server. Qui `automations-f3` è acceso; nella build app resta spento.
vi.mock("@backend/api", async () => await import("./index"));
vi.mock("../../integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integration")>();
  const on = (name: string) =>
    name === "automations" || name === "automations-f2" || name === "automations-f3";
  return {
    ...actual,
    isIntegrated: (t: Parameters<typeof actual.isIntegrated>[0]) =>
      ((t.kind === "destination" || t.kind === "projectSection" || t.kind === "feature") &&
        on(t.name)) ||
      actual.isIntegrated(t),
    featureIntegrated: (name: string) => on(name) || actual.featureIntegrated(name),
  };
});

const A_ID = "77777777-7777-4777-8777-777777777771";
let seen: SeenRequest[] = [];

const FLOW = {
  trigger: { kind: "manual" },
  steps: [
    {
      id: "c1",
      kind: "claude",
      instruction: "Il contratto è firmato?",
      inputs: ["avvio.data"],
      outcomes: ["si", "no"],
      fields: [],
      branches: { si: [], no: [] },
    },
  ],
  titleTemplate: "Avvio",
};
const version = (n: number, rev: number, published: boolean) => ({
  n,
  flow: FLOW,
  publishedAt: published ? "2026-11-10T09:00:00.000Z" : null,
  publishedById: published ? ME_ID : null,
  savedAt: "2026-11-12T09:00:00.000Z",
  savedById: ME_ID,
  rev,
  testedRev: rev,
});
const row = () => ({
  id: A_ID,
  code: "AUD-A1",
  name: "Avvio progetto",
  description: "",
  projectId: PROJECT_ID,
  ownerId: ME_ID,
  status: "active",
  versions: [version(1, 3, true), version(2, 6, false)],
  createdAt: "2026-11-01T09:00:00.000Z",
  createdById: ME_ID,
  permissions: { manage: true },
  openRuns: 0,
  waitingRuns: 0,
  lastRunAt: null,
  hasDraft: true,
  configErrorCount: 0,
  liveErrorCount: 0,
});

function install(routes: Record<string, unknown> = {}) {
  seen = installFakeServer({
    "GET /api/auth/me": {
      body: me({
        projectPermissions: { [PROJECT_ID]: ["tickets.view_all", "automations.manage"] },
      }),
    },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/me/claude-decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [
        {
          id: ME_ID,
          name: "Ada",
          initials: "AD",
          departmentIds: [DEPT_ID],
          email: "ada@example.com",
        },
      ],
    },
    "GET /api/departments": {
      body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }],
    },
    "GET /api/agent-sessions": { body: { live: [], recent: [] } },
    "GET /api/claude/conversations/status": { body: { budgetExhausted: false } },
    "GET /api/me/automation-runs": { body: { items: [] } },
    "GET /api/me/automation-approvals": { body: { items: [] } },
    "GET /api/automations": { body: { items: [row()] } },
    "GET /api/automation-runs": { body: { items: [], nextCursor: null } },
    "GET /api/automations/AUD-A1": {
      body: { automation: row(), configErrors: [], liveErrors: [], runs: [] },
    },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]).seen;
}

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

const context = () => ({
  automation: { ...row(), ownerId: ME_ID, status: "draft" },
  version: 2,
  draft: true,
  rev: 6,
  ownerId: ME_ID,
  configErrors: [],
  people: [{ id: ME_ID, name: "Ada", departmentIds: [DEPT_ID], deactivated: false }],
  projects: [],
});

describe("la prova con Claude vero (F3)", () => {
  it("si ferma al passo di Claude col costo; confermato, chiede la risposta al server", async () => {
    install({
      "GET /api/automations/AUD-A1/examples": { body: { items: [], context: context() } },
      "POST /api/automations/AUD-A1/test/estimate": {
        body: { claudeSteps: 1, estimateUsd: 0.01, model: "claude-sonnet" },
      },
      "POST /api/automations/AUD-A1/test/claude": {
        body: { outcome: "si", reason: "C'è la firma", truncated: [] },
      },
      "POST /api/automations/AUD-A1/tested": { status: 204 },
    });
    renderRoute("/automations/AUD-A1/test");
    const dialog = await screen.findByRole(
      "dialog",
      { name: "Choose an example" },
      { timeout: 3000 },
    );
    await userEvent.click(await within(dialog).findByRole("button", { name: "Start test" }));
    await waitFor(() => expect(document.querySelector("[data-example-line]")).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /Run to next stop/ }));
    const cost = await screen.findByRole("region", { name: "Claude in this test" });
    expect(cost).toHaveTextContent("$0.01");
    // Fermo davvero: nessun giro che riparte da solo, una stima, nessuna risposta chiesta.
    await new Promise((r) => setTimeout(r, 400));
    const count = seen.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(seen.length).toBe(count);
    expect(seen.filter((r) => r.path.endsWith("/test/estimate"))).toHaveLength(1);
    expect(seen.filter((r) => r.path.endsWith("/test/claude"))).toHaveLength(0);
    await userEvent.click(within(cost).getByRole("button", { name: "Test with Claude" }));
    await waitFor(() =>
      expect(seen.filter((r) => r.path.endsWith("/test/claude"))).toHaveLength(1),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Claude in this test" })).toBeNull(),
    );
  }, 20_000);

  it("il budget mensile finito ferma la prova con le sue parole", async () => {
    install({
      "GET /api/automations/AUD-A1/examples": { body: { items: [], context: context() } },
      "POST /api/automations/AUD-A1/test/estimate": {
        body: { claudeSteps: 1, estimateUsd: 0.01, model: "claude-sonnet" },
      },
      "POST /api/automations/AUD-A1/test/claude": {
        status: 409,
        body: { code: "budget", message: "budget" },
      },
    });
    renderRoute("/automations/AUD-A1/test");
    const dialog = await screen.findByRole(
      "dialog",
      { name: "Choose an example" },
      { timeout: 3000 },
    );
    await userEvent.click(await within(dialog).findByRole("button", { name: "Start test" }));
    await waitFor(() => expect(document.querySelector("[data-example-line]")).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /Run to next stop/ }));
    const cost = await screen.findByRole("region", { name: "Claude in this test" });
    const confirm = within(cost).getByRole("button", { name: "Test with Claude" });
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);
    expect(await screen.findByText(/monthly AI budget is used up/)).toBeInTheDocument();
  }, 20_000);
});

describe("le esecuzioni con Claude (F3, R4)", () => {
  const run = (over: Record<string, unknown>) => ({
    id: "77777777-7777-4777-8777-777777777778",
    automationId: A_ID,
    n: 8,
    version: 2,
    title: "Avvio",
    event: {},
    vars: {},
    waitingUntil: null,
    pending: null,
    startedAt: "2026-11-13T09:00:00.000Z",
    endedAt: null,
    error: null,
    projectIds: [PROJECT_ID],
    code: "AUD-A1 #8",
    automationCode: "AUD-A1",
    automationName: "Avvio progetto",
    automationProjectId: PROJECT_ID,
    flow: FLOW,
    deciders: [],
    ownerId: "22222222-2222-4222-8222-000000000099",
    permissions: { manage: true, approve: false, chooseProject: false },
    parent: null,
    children: [],
    pendingEffect: null,
    ...over,
  });

  it("ferma per il budget mensile: lo dice, e non offre «Retry»", async () => {
    install({
      "GET /api/automations/AUD-A1/runs/8": {
        body: run({
          status: "running",
          cursor: "0",
          aiWaiting: { reason: "monthly_budget" },
          log: [
            {
              at: "2026-11-13T09:00:00.000Z",
              stepId: "c1",
              path: "0",
              kind: "claude",
              outcome: "waiting",
              input: {},
              output: {},
              reason: null,
              why: { code: "monthlyBudget" },
              byId: null,
              effects: [],
            },
          ],
        }),
      },
    });
    renderRoute("/automations/AUD-A1/runs/8");
    expect(await screen.findAllByText(/monthly AI budget/, {}, { timeout: 3000 })).not.toHaveLength(
      0,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("la motivazione di Claude che cita un'email che non vedo: la riga lo dice", async () => {
    install({
      "GET /api/automations/AUD-A1/runs/8": {
        body: run({
          status: "done",
          cursor: null,
          endedAt: "2026-11-13T09:01:00.000Z",
          log: [
            {
              at: "2026-11-13T09:00:00.000Z",
              stepId: "c1",
              path: "0",
              kind: "claude",
              outcome: "ok",
              input: {},
              output: { outcome: "si" },
              reason: null,
              reasonHidden: true,
              byId: null,
              effects: [],
            },
          ],
        }),
      },
    });
    renderRoute("/automations/AUD-A1/runs/8");
    expect(
      await screen.findByText(
        /Claude's reasoning quotes an email you can't see/,
        {},
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
  });
});
