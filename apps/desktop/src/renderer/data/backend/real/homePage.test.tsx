import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject, serverTask } from "./fakeServer";

// La Home a blocchi sulla build app vera, davanti a un server finto
// (integrazione area 2, fetta 3, Task L): la Home del reparto viene dal
// server, un filtro eliminato resta come blocco «non disponibile» e i blocchi
// delle aree non integrate non si mostrano.
vi.mock("@backend/api", async () => await import("./index"));

const GONE = "88888888-8888-4888-8888-888888888888";

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  installFakeServer({
    "GET /api/auth/me": { body: me() },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" }],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    [`GET /api/departments/${DEPT_ID}/home`]: {
      body: {
        departmentId: DEPT_ID,
        blocks: [
          { kind: "decide" },
          { kind: "myWeek" },
          { kind: "importantMail" },
          { kind: "myTasks" },
          { kind: "filter", filterId: GONE },
        ],
        updatedAt: "2026-11-01T09:00:00.000Z",
      },
    },
    "GET /api/me/home": {
      body: { blocks: [], departmentChanged: [], newBlocks: [], departmentIds: [DEPT_ID], departmentHomes: [], personal: null },
    },
    "GET /api/departments/roles": { body: [] },
    "GET /api/filters": { body: [] },
    [`GET /api/filters/${GONE}`]: { status: 404, body: { code: "not_found", message: "x" } },
    "GET /api/me/pinned-filters": { body: [] },
    "GET /api/tasks": { body: { items: [serverTask({ assigneeId: ME_ID })], truncated: false } },
    "GET /api/tasks/stalled": { body: [] },
    "GET /api/me/day-arrangements": { body: [] },
    "GET /api/milestones": { body: [] },
    "GET /api/requests/to-convert": {
      body: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          code: "AUD-R4",
          projectId: PROJECT_ID,
          title: "Export to CSV",
          status: "new",
          urgency: "medium",
          requesterIds: [ME_ID],
          requestCount: 1,
          createdAt: "2026-11-01T09:00:00.000Z",
          webHref: "https://stubwise.example/backlog/33333333-3333-4333-8333-333333333333",
        },
      ],
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("la Home nella build app", () => {
  it("la Home del reparto dal server; il filtro eliminato è «non disponibile»; la posta non c'è", async () => {
    renderRoute("/home");
    const tasks = await screen.findByRole("region", { name: /^My tasks/ });
    expect(await within(tasks).findByText("Export the report")).toBeInTheDocument();
    expect(await screen.findByText("This filter is no longer available")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Important email/ })).toBeNull();
  });

  it("«Da decidere»: una richiesta da trasformare si apre nel web (Requests è della fetta 4)", async () => {
    const open = vi.fn();
    window.open = open as never;
    renderRoute("/home");
    const decide = await screen.findByRole("region", { name: /^Decide/ });
    expect(await within(decide).findByText("AUD-R4")).toBeInTheDocument();
    fireEvent.click(within(decide).getByRole("button", { name: "Open Export to CSV in the web" }));
    expect(open).toHaveBeenCalledWith(
      "https://stubwise.example/backlog/33333333-3333-4333-8333-333333333333",
      "_blank",
      "noopener,noreferrer",
    );
    expect(within(decide).getByRole("button", { name: "Turn into task: Export to CSV" })).toBeInTheDocument();
  });
});
