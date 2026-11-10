import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject, type SeenRequest } from "./fakeServer";

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

let seen: SeenRequest[] = [];

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  seen = installFakeServer({
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
    [`PATCH /api/requests/${ITEM}`]: { body: { ...view, urgency: "high", urgent: false } },
  }).seen;
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

  it("«Urgent» si abbassa a High: nel menu High non è già scelta, e sceglierla la salva", async () => {
    const ue = userEvent.setup();
    renderRoute(`/p/AUD/requests?request=${ITEM}`);
    await ue.click(await screen.findByRole("button", { name: "Urgency: Urgent. Change" }));
    const high = await screen.findByRole("menuitemradio", { name: /High/ });
    expect(high).toHaveAttribute("aria-checked", "false");
    await ue.click(high);
    await waitFor(() => expect(seen.find((r) => r.method === "PATCH")?.body).toEqual({ urgency: "high" }));
  });
});
