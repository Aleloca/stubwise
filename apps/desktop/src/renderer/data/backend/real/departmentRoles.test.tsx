import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject } from "./fakeServer";

// I ruoli di reparto nella build app (correzioni della fetta 3): dandomi
// `department.home.manage` dalla pagina Reparti, i miei permessi si rileggono
// subito, senza riavviare l'app.
vi.mock("@backend/api", async () => await import("./index"));
// Anche i fatti sugli accessi sono quelli della build app (dal Viewer del server).
vi.mock("@backend/access", async () => await import("./accessFacts"));

let deptPerms: Record<string, string[]> = {};

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  deptPerms = {};
  installFakeServer({
    "GET /api/auth/me": () => ({
      body: me({ instancePermissions: ["users.view_all", "departments.manage"], departmentPermissions: deptPerms }),
    }),
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" }],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/departments/roles": () => ({
      body: (deptPerms[DEPT_ID] ?? []).length
        ? [{ departmentId: DEPT_ID, userId: ME_ID, permissions: deptPerms[DEPT_ID] }]
        : [],
    }),
    [`PATCH /api/departments/${DEPT_ID}`]: { body: { id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true } },
    [`PUT /api/departments/${DEPT_ID}/roles`]: (req) => {
      const roles = (req.body as { roles: { userId: string; permissions: string[] }[] }).roles;
      deptPerms = roles.some((r) => r.userId === ME_ID) ? { [DEPT_ID]: ["department.home.manage"] } : {};
      return { body: [] };
    },
    [`GET /api/departments/${DEPT_ID}/home`]: {
      body: { departmentId: DEPT_ID, blocks: [{ kind: "decide" }, { kind: "myWeek" }], updatedAt: null },
    },
    "GET /api/me/home": {
      body: { blocks: [{ kind: "decide" }, { kind: "myWeek" }], departmentChanged: [], newBlocks: [], departmentIds: [DEPT_ID], departmentHomes: [], personal: null },
    },
    "GET /api/filters": { body: [] },
    "GET /api/me/pinned-filters": { body: [] },
    "GET /api/tasks": { body: { items: [], truncated: false } },
    "GET /api/tasks/stalled": { body: [] },
    "GET /api/me/day-arrangements": { body: [] },
    "GET /api/milestones": { body: [] },
    "GET /api/requests/to-convert": { body: [] },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("ruoli di reparto e permessi di chi guarda", () => {
  it("dopo essermi dato department.home.manage compare Customize → reparto", async () => {
    const ue = userEvent.setup();
    const router = renderRoute(`/admin/departments?department=${DEPT_ID}`);
    await ue.click(await screen.findByRole("checkbox", { name: "Ada manages the Home" }));
    await ue.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(deptPerms).toEqual({ [DEPT_ID]: ["department.home.manage"] }));
    await act(() => router.navigate({ to: "/home" }));
    await ue.click(await screen.findByRole("button", { name: "Customize" }));
    const menu = await screen.findByRole("menu", { name: "Customize which Home" });
    expect(within(menu).getByText("General Home")).toBeInTheDocument();
  });
});
