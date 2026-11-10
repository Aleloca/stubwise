import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject, type SeenRequest } from "./fakeServer";

// Requests sulla build app vera, davanti a un server finto (fetta 4, Task R).
vi.mock("@backend/api", async () => await import("./index"));

const ITEM = "33333333-3333-4333-8333-333333333333";
const OTHER = "33333333-3333-4333-8333-333333333334";
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
const REFINE = "aaaaaaaa-0000-4000-8000-0000000000aa";
let refineLive = false;
const refine = {
  id: REFINE,
  kind: "backlog_refine",
  title: "Export to CSV",
  projectId: PROJECT_ID,
  projectName: "Audin AI",
  ticketId: null,
  ticketNumber: null,
  startedAt: "2026-10-20T10:00:00.000Z",
  lastEventAt: "2026-10-20T10:01:30.000Z",
  state: "idle",
  aiJobId: null,
  backlogItemId: ITEM,
  outcome: null,
};

beforeEach(() => {
  refineLive = false;
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
    "GET /api/requests": { body: [view, { ...view, id: OTHER, code: "AUD-R5", title: "CSV export", urgent: false }] },
    // Dopo il refinement la voce ha il design che Claude ha salvato.
    [`GET /api/requests/${ITEM}`]: () => ({ body: refineLive ? { ...view, design: "The new design for the CSV export" } : view }),
    "GET /api/tasks": { body: { items: [], truncated: false } },
    "GET /api/tasks/stalled": { body: [] },
    "GET /api/milestones": { body: [] },
    [`PATCH /api/requests/${ITEM}`]: { body: { ...view, urgency: "high", urgent: false } },
    [`GET /api/requests/${OTHER}`]: { body: { ...view, id: OTHER, code: "AUD-R5", title: "CSV export" } },
    [`POST /api/requests/${ITEM}/merge`]: { status: 409, body: { code: "request_changed", message: "x" } },
    "GET /api/me/claude-decisions": { body: [] },
    // Il refinement (fetta 3c): la sessione della richiesta e le scritture di Claude.
    "GET /api/agent-sessions": () => ({ body: { live: refineLive ? [refine] : [], recent: [] } }),
    [`POST /api/backlog/${ITEM}/refine-session`]: () => {
      refineLive = true;
      return { status: 201, body: { agentSessionId: REFINE, inputId: null } };
    },
    [`GET /api/agent-sessions/${REFINE}`]: {
      body: { ...refine, canWrite: true, canIntervene: true, canClose: true, questions: [], inputs: [] },
    },
    [`GET /api/agent-sessions/${REFINE}/events`]: {
      body: {
        events: [
          { id: "1", type: "tool_use", segmentId: "s1", at: "2026-10-20T10:01:00.000Z", data: { toolUseId: "t1", name: "mcp__stubwise_refine__set_design", input: { markdown: "The new design for the CSV export" } } },
          { id: "2", type: "tool_result", segmentId: "s1", at: "2026-10-20T10:01:30.000Z", data: { toolUseId: "t1", isError: false, content: "Design saved on the backlog item." } },
        ],
        before: null,
      },
    },
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

  it("una fusione su una richiesta cambiata nel frattempo lo dice", async () => {
    const ue = userEvent.setup();
    renderRoute(`/p/AUD/requests?request=${ITEM}`);
    const panel = await screen.findByRole("dialog");
    await ue.click(await within(panel).findByRole("button", { name: "More actions" }));
    await ue.click(await screen.findByRole("menuitem", { name: "Merge into…" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge into another request" });
    await ue.click(await within(dialog).findByRole("radio", { name: /CSV export/ }));
    await ue.click(within(dialog).getByRole("button", { name: "Merge" }));
    expect(
      await within(dialog).findByText("One of the two requests changed in the meantime. Nothing changed: try again."),
    ).toBeInTheDocument();
  });

  it("«Refine with Claude» apre la sessione della richiesta; il design scritto da Claude compare nella vista", async () => {
    const ue = userEvent.setup();
    const router = renderRoute(`/p/AUD/requests?request=${ITEM}`);
    const panel = await screen.findByRole("dialog");
    await ue.click(await within(panel).findByRole("button", { name: "Refine with Claude" }));
    await waitFor(() =>
      expect(seen.some((r) => r.method === "POST" && r.path === `/api/backlog/${ITEM}/refine-session`)).toBe(true),
    );
    await waitFor(() => expect(router.state.location.search).toMatchObject({ refine: "1" }));
    expect(await screen.findByText("Design saved on the backlog item.")).toBeInTheDocument();
    expect(screen.queryByText("mcp__stubwise_refine__set_design")).toBeNull();
    await ue.click(screen.getByRole("button", { name: "See" }));
    expect((await screen.findAllByText("The new design for the CSV export")).length).toBeGreaterThan(0);
  });
});
