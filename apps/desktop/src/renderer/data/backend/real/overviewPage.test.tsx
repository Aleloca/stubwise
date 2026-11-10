import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject, STATUS_TODO, type SeenRequest } from "./fakeServer";

// L'Overview sulla build app vera, davanti a un server finto (fetta 4, Task R):
// la cronologia arriva a pagine di 28 giorni, e «Show earlier» chiede la pagina
// prima quando quelle lette sono finite (decisione del maintainer).
vi.mock("@backend/api", async () => await import("./index"));

const decision = (id: string, title: string, at: string) => ({ kind: "decision", at, decisionId: id, title });
let chronologyCalls: string[] = [];

const baseRoutes = () => ({
  "GET /api/auth/me": { body: me({ projectPermissions: { [PROJECT_ID]: ["tickets.view_all", "tickets.edit"] } }) },
  "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
  "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
  "GET /api/decisions": { body: [] },
  "GET /api/inbox": { body: { items: [], nextCursor: null } },
  "GET /api/people": {
    body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" }],
  },
  "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
  "GET /api/tasks": { body: { items: [], truncated: false } },
  "GET /api/tasks/stalled": { body: [] },
  [`GET /api/projects/${PROJECT_ID}/statuses`]: {
    body: [{ id: STATUS_TODO, projectId: PROJECT_ID, name: "To do", family: "todo", position: 0 }],
  },
  "GET /api/milestones": { body: [] },
  "GET /api/requests/to-convert": { body: [] },
  [`GET /api/projects/${PROJECT_ID}/decisions`]: { body: [] },
  [`GET /api/projects/${PROJECT_ID}/briefs/latest`]: { body: null },
  [`GET /api/projects/${PROJECT_ID}/chronology`]: (req: SeenRequest) => {
    chronologyCalls.push(req.path);
    return req.path.includes("before=")
      ? {
          body: {
            events: [decision("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc", "Use SQLite", "2026-09-10T10:00:00.000Z")],
            nextBefore: null,
          },
        }
      : {
          body: {
            events: [decision("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Use Postgres", "2026-10-20T10:00:00.000Z")],
            nextBefore: "2026-09-25T00:00:00.000Z",
          },
        };
  },
});

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  chronologyCalls = [];
  installFakeServer(baseRoutes());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("l'Overview nella build app", () => {
  it("la cronologia a pagine: «Show earlier» carica le quattro settimane prima, poi non c'è altro", async () => {
    renderRoute("/p/AUD/overview");
    expect(await screen.findByText("Use Postgres")).toBeInTheDocument();
    expect(screen.queryByText("Use SQLite")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show earlier" }));
    expect(await screen.findByText("Use SQLite")).toBeInTheDocument();
    expect(chronologyCalls).toEqual([
      `/api/projects/${PROJECT_ID}/chronology`,
      `/api/projects/${PROJECT_ID}/chronology?before=2026-09-25T00%3A00%3A00.000Z`,
    ]);
    expect(screen.queryByRole("button", { name: "Show earlier" })).toBeNull();
  });

  it("una voce il cui soggetto non è fra quelli letti non resta vuota", async () => {
    installFakeServer({
      ...baseRoutes(),
      [`GET /api/projects/${PROJECT_ID}/chronology`]: {
        body: {
          events: [
            { kind: "task_closed", at: "2026-10-20T10:00:00.000Z", taskId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
            { kind: "pr_merged", at: "2026-10-20T11:00:00.000Z", prId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef", taskId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
            { kind: "milestone", at: "2026-10-19T10:00:00.000Z", milestoneId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee0" },
          ],
          nextBefore: null,
        },
      },
    });
    renderRoute("/p/AUD/overview");
    const closed = await waitFor(() => {
      const row = document.querySelector('[data-timeline-event="task_closed"]');
      if (!row) throw new Error("not yet");
      return row as HTMLElement;
    });
    expect(closed).toHaveTextContent("A task that isn't in this list");
    const pr = document.querySelector('[data-timeline-event="pr_merged"]') as HTMLElement;
    expect(pr).toHaveTextContent("A task that isn't in this list");
    expect(pr).not.toHaveTextContent("#");
    expect(document.querySelector('[data-timeline-event="milestone"]')).toHaveTextContent("a deleted milestone");
  });
});
