import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject } from "./fakeServer";

// Requests sulla build app vera, davanti a un server finto (fetta 4, Task R).
vi.mock("@backend/api", async () => await import("./index"));

const ITEM = "33333333-3333-4333-8333-333333333333";
const view = {
  id: ITEM,
  code: "AUD-R4",
  projectId: PROJECT_ID,
  title: "Export to CSV",
  description: "Users want CSV.",
  requesterIds: [ME_ID],
  status: "new",
  urgency: "high",
  urgent: true,
  size: "S",
  taskIds: [],
  createdAt: "2026-10-20T09:00:00.000Z",
  webHref: "/backlog/" + ITEM,
};

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  installFakeServer({
    "GET /api/auth/me": {
      body: me({ projectPermissions: { [PROJECT_ID]: ["tickets.create", "tickets.edit", "backlog.edit", "backlog.create"] } }),
    },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" }],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/requests": { body: [view] },
    [`GET /api/requests/${ITEM}`]: { body: view },
    "GET /api/tasks": { body: { items: [], truncated: false } },
    "GET /api/tasks/stalled": { body: [] },
    "GET /api/milestones": { body: [] },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("Requests nella build app", () => {
  it("l'elenco viene dal server, col codice R<n> e «Urgent»; il dettaglio si apre", async () => {
    renderRoute("/p/AUD/requests");
    const row = (await screen.findByText("Export to CSV")).closest("[data-request-row]") as HTMLElement;
    expect(within(row).getByText("AUD-R4")).toBeInTheDocument();
    expect(within(row).getByText("Urgent")).toBeInTheDocument();
    renderRoute(`/p/AUD/requests?request=${ITEM}`);
    expect(await screen.findByText("Users want CSV.")).toBeInTheDocument();
  });
});
