import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUndoWindow } from "../../../pages/home/pendingAnswers";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject, serverTask, TICKET_ID, type SeenRequest } from "./fakeServer";

// La Home a blocchi sulla build app vera, davanti a un server finto
// (integrazione area 2, fetta 3, Task L): la Home del reparto viene dal
// server, un filtro eliminato resta come blocco «non disponibile» e i blocchi
// delle aree non integrate non si mostrano.
vi.mock("@backend/api", async () => await import("./index"));

const GONE = "88888888-8888-4888-8888-888888888888";

/** La Home personale che il server ha (null = nessuna), e i corpi dei salvataggi. */
let personalBlocks: { kind: string; filterId?: string }[] | null = null;
let savedBodies: unknown[] = [];
/** Le voci di Claude in «Da decidere» (fetta 3b) e le richieste viste. */
let claudeDecisions: unknown[] = [];
let seen: SeenRequest[] = [];

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  personalBlocks = null;
  savedBodies = [];
  claudeDecisions = [];
  const meHome = () => ({
    blocks: personalBlocks ?? [],
    departmentChanged: [],
    newBlocks: [],
    departmentIds: [DEPT_ID],
    departmentHomes: [
      {
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
    ],
    personal: personalBlocks ? { blocks: personalBlocks, seenDepartmentUpdates: {} } : null,
  });
  seen = installFakeServer({
    "GET /api/me/claude-decisions": () => ({ body: claudeDecisions }),
    [`POST /api/tickets/${TICKET_ID}/approve-plan`]: { status: 202, body: { jobId: "bbbbbbbb-0000-4000-8000-000000000001" } },
    "GET /api/auth/me": { body: me() },
    "PUT /api/me/home": (req) => {
      savedBodies.push(req.body);
      personalBlocks = (req.body as { blocks: { kind: string }[] }).blocks;
      return { body: meHome() };
    },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" }],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    // La Home la danno /api/me/home: una lettura per reparto non serve, e se fallisce non rompe niente.
    [`GET /api/departments/${DEPT_ID}/home`]: { status: 500, body: { code: "internal", message: "x" } },
    "GET /api/me/home": () => ({ body: meHome() }),
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
  }).seen;
});

afterEach(() => {
  setUndoWindow(null);
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

  it("«Da decidere»: una richiesta da trasformare apre il suo pannello in Requests (fetta 4)", async () => {
    const open = vi.fn();
    window.open = open as never;
    const router = renderRoute("/home");
    const decide = await screen.findByRole("region", { name: /^Decide/ });
    expect(await within(decide).findByText("AUD-R4")).toBeInTheDocument();
    expect(within(decide).getByRole("button", { name: "Turn into task: Export to CSV" })).toBeInTheDocument();
    fireEvent.click(within(decide).getByRole("link", { name: "Open request Export to CSV" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/AUD/requests"));
    expect(router.state.location.search).toMatchObject({ request: "33333333-3333-4333-8333-333333333333" });
    expect(open).not.toHaveBeenCalled();
  });

  it("«Da decidere»: il piano di Claude dal server; «Approve» lo approva sul ticket (fetta 3b)", async () => {
    claudeDecisions = [
      {
        id: "bbbbbbbb-0000-4000-8000-000000000001:plan",
        kind: "plan",
        conversationId: "aaaaaaaa-0000-4000-8000-000000000001",
        title: "Export the report",
        ownerId: ME_ID,
        projectId: PROJECT_ID,
        taskId: TICKET_ID,
        objectCode: "AUD-12",
        at: "2026-11-01T09:00:00.000Z",
        planId: "bbbbbbbb-0000-4000-8000-000000000001",
        summary: "Add the CSV export",
        webHref: "/tickets/x",
      },
    ];
    setUndoWindow(0);
    renderRoute("/home");
    const decide = await screen.findByRole("region", { name: /^Decide/ });
    expect(await within(decide).findByText(/Add the CSV export/)).toBeInTheDocument();
    fireEvent.click(within(decide).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(seen.some((r) => r.method === "POST" && r.path === `/api/tickets/${TICKET_ID}/approve-plan`)).toBe(true),
    );
  });

  it("personalizzare dall'app non cancella un blocco di un'area non integrata né un kind sconosciuto", async () => {
    personalBlocks = [
      { kind: "decide" },
      { kind: "myWeek" },
      { kind: "importantMail" },
      { kind: "__future__" },
      { kind: "myTasks" },
    ];
    renderRoute("/home");
    await screen.findByRole("region", { name: /^My tasks/ });
    fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
    const list = await screen.findByRole("list", { name: "Blocks of the Home" });
    // L'editor non elenca ciò che questa build non mostra.
    expect(within(list).queryByText("Important email")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add block" }));
    const menu = await screen.findByRole("menu", { name: "Add block" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Stalled in my projects/ }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies[0]).toEqual({
      blocks: [
        { kind: "decide" },
        { kind: "myWeek" },
        { kind: "importantMail" },
        { kind: "__future__" },
        { kind: "myTasks" },
        { kind: "stalledInMyProjects" },
      ],
    });
  });
});
