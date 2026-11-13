import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_F4_AVAILABILITY } from "@stubwise/shared";
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

// Le Automations della F4 nella build app (area 7): le generali
// (`automations.general.manage`), le sorgenti, la tabella cliente → progetto,
// «avvia un'altra». Qui `automations-f4` è acceso; nella build app resta
// spento finché il suo server non c'è.
vi.mock("@backend/api", async () => await import("./index"));
vi.mock("../../integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integration")>();
  const on = (name: string) =>
    name === "automations" ||
    name === "automations-f2" ||
    name === "automations-f3" ||
    name === "automations-f4";
  return {
    ...actual,
    isIntegrated: (t: Parameters<typeof actual.isIntegrated>[0]) =>
      ((t.kind === "destination" || t.kind === "projectSection" || t.kind === "feature") &&
        on(t.name)) ||
      actual.isIntegrated(t),
    featureIntegrated: (name: string) => on(name) || actual.featureIntegrated(name),
    // Quelle che leggono `featureIntegrated` dentro il modulo: come con `automations-f4` acceso.
    generalsAvailable: () => true,
    automationAvailability: () => AUTOMATION_F4_AVAILABILITY,
  };
});

/** I permessi d'istanza di chi guarda, per test. */
const instance = { permissions: [] as string[] };

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
        instancePermissions: ["users.view_all", ...instance.permissions],
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

beforeEach(() => {
  instance.permissions = [];
});

describe("le automazioni generali (F4, R3)", () => {
  it("con automations.general.manage si crea una generale: POST con projectId null", async () => {
    instance.permissions = ["automations.general.manage"];
    install({
      "POST /api/automations": {
        body: {
          ...row(),
          id: "77777777-7777-4777-8777-77777777777a",
          code: "AUT-1",
          projectId: null,
        },
      },
    });
    renderRoute("/automations");
    await userEvent.click(
      (await screen.findAllByRole("button", { name: /New automation/ }, { timeout: 3000 }))[0]!,
    );
    const dialog = await screen.findByRole("dialog", { name: "New automation" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Contratti");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Project" }), "");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(seen.find((r) => r.method === "POST" && r.path === "/api/automations")?.body).toEqual({
        name: "Contratti",
        projectId: null,
      }),
    );
  });

  it("senza il permesso delle generali né la voce né l'opzione", async () => {
    install();
    renderRoute("/automations");
    await userEvent.click(
      (await screen.findAllByRole("button", { name: /New automation/ }, { timeout: 3000 }))[0]!,
    );
    const dialog = await screen.findByRole("dialog", { name: "New automation" });
    expect(within(dialog).queryByRole("option", { name: /Across projects/ })).toBeNull();
  });
});
