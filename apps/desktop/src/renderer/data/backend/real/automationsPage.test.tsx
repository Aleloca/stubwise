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

// Le pagine delle Automations nella build app (area 7, F1, R4), fino alla
// richiesta esatta. La destinazione è accesa solo qui: nella build app il
// flag resta spento finché il maintainer non dice di accenderlo.
vi.mock("@backend/api", async () => await import("./index"));
vi.mock("../../integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integration")>();
  return {
    ...actual,
    isIntegrated: (t: Parameters<typeof actual.isIntegrated>[0]) =>
      ((t.kind === "destination" || t.kind === "projectSection" || t.kind === "feature") &&
        t.name === "automations") ||
      actual.isIntegrated(t),
    featureIntegrated: (name: string) => name === "automations" || actual.featureIntegrated(name),
  };
});

const A_ID = "77777777-7777-4777-8777-777777777771";
let seen: SeenRequest[] = [];

const FLOW = {
  trigger: { kind: "manual" },
  steps: [
    {
      id: "n1",
      kind: "notify",
      who: { personId: ME_ID },
      text: "Fatto",
      approval: { mode: "auto" },
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

describe("le Automations nella build app", () => {
  it("l'elenco viene dal server, non «Coming soon»", async () => {
    install();
    renderRoute("/automations");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Automations" }, { timeout: 3000 }),
    ).toBeInTheDocument();
    const list = await screen.findByRole("region", { name: "Automations by project" });
    expect(list.querySelector('[data-automation-row="AUD-A1"]')).toHaveTextContent(
      "Avvio progetto",
    );
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(seen.some((r) => r.method === "GET" && r.path.startsWith("/api/automations"))).toBe(
      true,
    );
  });

  it("pubblicare la bozza dal dettaglio: POST …/publish col rev letto", async () => {
    install({
      "POST /api/automations/AUD-A1/publish": {
        body: { ...row(), versions: [version(1, 3, true), version(2, 6, true)], hasDraft: false },
      },
    });
    renderRoute("/automations/AUD-A1");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Avvio progetto" }, { timeout: 3000 }),
    ).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Publish v2" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish version 2 of AUD-A1?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(
        seen.find((r) => r.method === "POST" && r.path === "/api/automations/AUD-A1/publish")?.body,
      ).toEqual({
        expectedRev: 6,
      }),
    );
  });
});
