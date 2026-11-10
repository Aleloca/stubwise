import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { DEPT_ID, installFakeServer, me, ME_ID, serverProject, STATUS_TODO } from "./fakeServer";

// Nuovo progetto nella build app (review della fetta 4, punto 2): chi lo crea
// ne diventa Project Lead, e i permessi nel progetto nuovo li dice il server.
// Dopo la creazione si rilegge il viewer, come dopo un'amministrazione.
vi.mock("@backend/api", async () => await import("./index"));
vi.mock("@backend/access", async () => await import("./accessFacts"));

const NEW_ID = "abababab-abab-4bab-8bab-abababababab";
let created = false;

beforeEach(() => {
  created = false;
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  installFakeServer({
    // Non un full admin: può creare progetti, e nel progetto nuovo i permessi arrivano col server.
    "GET /api/auth/me": () => ({
      body: me({
        instancePermissions: ["projects.create"],
        projectPermissions: created ? { [NEW_ID]: ["tickets.view_all", "tickets.create", "tickets.edit"] } : {},
      }),
    }),
    "GET /api/projects": () => ({
      body: created ? [serverProject({ id: NEW_ID, name: "Brennero", code: "BRN", memberIds: [ME_ID] })] : [],
    }),
    "POST /api/projects": () => {
      created = true;
      return { status: 201, body: serverProject({ id: NEW_ID, name: "Brennero", code: "BRN", memberIds: [ME_ID] }) };
    },
    "GET /api/me/follows": { body: { projectIds: [] } },
    "GET /api/decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" }],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/tasks": { body: { items: [], truncated: false } },
    "GET /api/tasks/stalled": { body: [] },
    [`GET /api/projects/${NEW_ID}/statuses`]: {
      body: [{ id: STATUS_TODO, projectId: NEW_ID, name: "To do", family: "todo", position: 0 }],
    },
    "GET /api/milestones": { body: [] },
    "GET /api/requests/to-convert": { body: [] },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("nuovo progetto nella build app", () => {
  it("chi non è full admin crea un progetto e ci trova subito «New task»", async () => {
    const ue = userEvent.setup();
    const router = renderRoute("/projects");
    await ue.click(await screen.findByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    await ue.type(within(dialog).getByLabelText("Name"), "Brennero");
    await ue.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/BRN/overview"));
    await router.navigate({ to: "/p/$code/$section", params: { code: "BRN", section: "tasks" } } as never);
    // Quella della testata e quella dello stato vuoto.
    expect(await screen.findAllByRole("button", { name: "New task" })).not.toHaveLength(0);
  });
});
