import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject, TICKET_ID } from "./fakeServer";

// «By person» di Activity nella build app (integrazione area 3, fetta 3d): il
// permesso `people.activity.view` arriva dal server (registro vero), la
// rassegna dal suo aggregato. «Generate report» e «Link a person» non ci sono.
vi.mock("@backend/api", async () => await import("./index"));
vi.mock("@backend/access", async () => await import("./accessFacts"));

function install(instancePermissions: string[]) {
  return installFakeServer({
    "GET /api/auth/me": {
      body: me({ instancePermissions, projectPermissions: { [PROJECT_ID]: ["tickets.view_all"] } }),
    },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/me/claude-decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" }],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/tasks": { body: { items: [], truncated: false } },
    "GET /api/tasks/stalled": { body: [] },
    "GET /api/milestones": { body: [] },
    "GET /api/requests/to-convert": { body: [] },
    "GET /api/activity/portfolio": { body: { events: [], nextBefore: null } },
    "GET /api/people/activity": {
      body: [
        {
          personId: ME_ID,
          name: "Ada",
          departmentIds: [DEPT_ID],
          tasksClosed: [{ taskId: TICKET_ID, code: "AUD-12", title: "Export the report", projectId: PROJECT_ID, at: "2026-10-23T09:00:00.000Z" }],
        },
        {
          personId: null,
          name: "bot@ci.example",
          commits: [
            { sha: "abc1234", repo: "acme/app", authorId: null, authorName: "bot@ci.example", message: "chore: deps", aiSummary: "Bumps the dependencies", at: "2026-10-23T08:00:00.000Z", projectId: PROJECT_ID },
          ],
        },
      ],
    },
    "POST /api/activity/generate": { body: { queued: 1 } },
    "GET /api/activity": {
      // Nessun report del giorno: il prototipo offrirebbe «Generate report».
      body: { date: "2026-10-23", projects: [] },
    },
  }).seen;
}

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("«By person» nella build app", () => {
  it("col permesso dal server: la rassegna del giorno; rigenerare vale per tutti i progetti; niente «Link a person»", async () => {
    const seen = install(["people.activity.view", "settings.manage", "users.manage"]);
    renderRoute("/projects?view=person");
    expect(await screen.findByRole("radio", { name: "By person" })).toBeInTheDocument();
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(await screen.findByText(/bot@ci\.example/)).toBeInTheDocument();
    await waitFor(() => expect(seen.some((r) => r.path.startsWith("/api/people/activity?date="))).toBe(true));
    // Espansa la persona, la riga del report c'è («non generato»): il gesto dice che vale per tutti i progetti.
    fireEvent.click(screen.getAllByRole("button", { name: "Expand all" })[0]!);
    expect((await screen.findAllByText("Daily report: not generated")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Generate report" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Regenerate the reports of all projects for that day" })[0]!);
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST" && r.path === "/api/activity/generate")).toHaveLength(1),
    );
    expect(screen.queryByRole("button", { name: "Link a person" })).toBeNull();
  });

  it("senza il permesso: la scheda non c'è e la rassegna non si legge", async () => {
    const seen = install([]);
    renderRoute("/projects");
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole("radio", { name: "By person" })).toBeNull();
    expect(seen.some((r) => r.path.startsWith("/api/people/activity"))).toBe(false);
  });
});
