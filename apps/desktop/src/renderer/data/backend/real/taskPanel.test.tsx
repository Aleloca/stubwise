import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import {
  DEPT_ID,
  installFakeServer,
  me,
  ME_ID,
  PROJECT_ID,
  serverProject,
  serverTask,
  serverComment,
  STATUS_TODO,
  TICKET_ID,
} from "./fakeServer";

// Le Tasks e il pannello della task sulla build app vera, davanti a un server
// finto (Review Focus 4 del piano: una task invisibile aperta da link).
vi.mock("@backend/api", async () => await import("./index"));

const open = vi.fn();

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  window.open = open as never;
  installFakeServer(routes());
});

const routes = () => ({
    "GET /api/auth/me": { body: me() },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" }],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/tasks": { body: { items: [serverTask()], truncated: false } },
    "GET /api/tasks/stalled": { body: [] },
    "GET /api/tasks/by-code/AUD-12": { body: serverTask() },
    "GET /api/tasks/by-code/AUD-404": { status: 404, body: { code: "not_found", message: "x" } },
    [`GET /api/tasks/${TICKET_ID}/activity`]: { body: [] },
    [`GET /api/tasks/${TICKET_ID}/work`]: {
      body: {
        claude: "awaiting_approval",
        pullRequests: [{ repo: "acme/app", number: 7, url: "https://git.example/acme/app/pull/7", state: "open" }],
        webHref: `/tickets/${TICKET_ID}`,
      },
    },
    [`GET /api/projects/${PROJECT_ID}/statuses`]: {
      body: [{ id: STATUS_TODO, projectId: PROJECT_ID, name: "To do", family: "todo", position: 0 }],
    },
    "GET /api/milestones": { body: [] },
    [`POST /api/tickets/${TICKET_ID}/attachments`]: {
      status: 400,
      body: { code: "storage_not_configured", message: "x" },
    },
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("Tasks nella build app", () => {
  it("l'elenco viene dal server", async () => {
    renderRoute("/p/AUD/tasks");
    expect(await screen.findByText("Export the report")).toBeInTheDocument();
  });

  it("una task invisibile dà il pannello not found", async () => {
    renderRoute("/p/AUD/tasks?task=AUD-404");
    const panel = await screen.findByRole("dialog");
    await waitFor(() => expect(within(panel).getByText(/AUD-404/)).toBeInTheDocument());
    expect(within(panel).queryByText("Export the report")).toBeNull();
  });

  it("la sezione Claude legge il lavoro vero; il piano lo decide solo chi il server dice (waitsOnViewer)", async () => {
    const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";
    installFakeServer({
      ...routes(),
      [`GET /api/tasks/${TICKET_ID}/work`]: {
        body: {
          claude: "awaiting_approval",
          pullRequests: [{ repo: "acme/app", number: 7, url: "https://git.example/acme/app/pull/7", state: "open" }],
          webHref: `/tickets/${TICKET_ID}`,
          runs: [
            {
              id: "bbbbbbbb-0000-4000-8000-000000000001",
              sessionId: SESSION,
              ownerId: ME_ID,
              createdAt: "2026-10-20T09:00:00.000Z",
              state: "awaiting_approval",
              plan: { text: "1. Do it", summary: "Do it", status: "pending", at: "2026-10-20T09:04:00.000Z" },
            },
          ],
          software: true,
          openPr: true,
          actions: { start: "allowed", relaunch: "allowed", resume: "allowed", requestChanges: "allowed" },
        },
      },
      [`GET /api/agent-sessions/${SESSION}`]: {
        body: {
          id: SESSION,
          kind: "ai_job",
          title: "Export the report",
          projectId: PROJECT_ID,
          projectName: "Audin AI",
          ticketId: TICKET_ID,
          ticketNumber: 12,
          startedAt: "2026-10-20T09:00:00.000Z",
          lastEventAt: "2026-10-20T09:04:00.000Z",
          state: "awaiting_approval",
          canWrite: true,
          questions: [],
          inputs: [],
        },
      },
      [`GET /api/agent-sessions/${SESSION}/events`]: {
        body: {
          events: [{ id: "1", type: "segment_start", segmentId: "s1", at: "2026-10-20T09:01:00.000Z", data: { label: "plan", interactive: false } }],
          before: null,
        },
      },
    });
    renderRoute("/p/AUD/tasks?task=AUD-12");
    const panel = await screen.findByRole("dialog", { name: "Task AUD-12" });
    const claude = () => within(panel).getByRole("region", { name: "Claude" });
    await waitFor(() => expect(claude()).toHaveTextContent("Waiting for approval"));
    expect(
      within(claude()).queryByRole("button", {
        name: /^Approve|^Reject|Pre-approve|Relaunch|Request changes|Resume the correction|^Start/,
      }),
    ).toBeNull();
  });

  it("una sessione fallita: «Relaunch with instructions» come il server la permette; rilanciare manda commento e run-ai", async () => {
    const posts: string[] = [];
    installFakeServer({
      ...routes(),
      [`GET /api/tasks/${TICKET_ID}/work`]: {
        body: {
          claude: "failed",
          webHref: `/tickets/${TICKET_ID}`,
          runs: [
            {
              id: "bbbbbbbb-0000-4000-8000-000000000002",
              sessionId: null,
              ownerId: ME_ID,
              createdAt: "2026-10-20T09:00:00.000Z",
              state: "finished",
              outcome: "failed",
              failureSummary: "The tests failed.",
            },
          ],
          software: true,
          openPr: true,
          actions: { start: "allowed", relaunch: "allowed", resume: "unavailable", requestChanges: "allowed" },
        },
      },
      [`POST /api/tickets/${TICKET_ID}/comments`]: (req) => {
        posts.push(req.path);
        return { status: 201, body: serverComment("Fix the failing test") };
      },
      [`POST /api/tickets/${TICKET_ID}/run-ai`]: (req) => {
        posts.push(req.path);
        return { status: 202, body: { jobId: "bbbbbbbb-0000-4000-8000-000000000004", status: "queued" } };
      },
    });
    renderRoute("/p/AUD/tasks?task=AUD-12");
    const panel = await screen.findByRole("dialog", { name: "Task AUD-12" });
    const claude = () => within(panel).getByRole("region", { name: "Claude" });
    await waitFor(() => expect(claude()).toHaveTextContent("The tests failed."));
    const ue = userEvent.setup();
    await ue.click(within(claude()).getByRole("button", { name: "Relaunch with instructions" }));
    await ue.type(within(claude()).getByLabelText("Instructions for Claude"), "Fix the failing test");
    await ue.click(within(claude()).getByRole("button", { name: "Relaunch" }));
    await waitFor(() => expect(posts).toEqual([`/api/tickets/${TICKET_ID}/comments`, `/api/tickets/${TICKET_ID}/run-ai`]));
  });

  it("allegati spenti mostrano il messaggio", async () => {
    renderRoute("/p/AUD/tasks?task=AUD-12");
    const panel = await screen.findByRole("dialog", { name: "Task AUD-12" });
    const section = await within(panel).findByRole("region", { name: /Attachments/ });
    const input = section.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { files: [new File(["ciao"], "a.txt", { type: "text/plain" })] } });
    expect(await within(section).findByText("Attachments are off on this instance.")).toBeInTheDocument();
  });

  describe("«Annulla il lavoro»", () => {
    const SESSION = "aaaaaaaa-0000-4000-8000-000000000003";
    const parked = (cancelReply: { status?: number; body: unknown }, seen: string[]) => ({
      ...routes(),
      "GET /api/auth/me": { body: me({ projectPermissions: { [PROJECT_ID]: ["tickets.view_all", "runs.start"] } }) },
      [`GET /api/tasks/${TICKET_ID}/work`]: {
        body: {
          claude: "working",
          webHref: `/tickets/${TICKET_ID}`,
          runs: [{ id: "bbbbbbbb-0000-4000-8000-000000000003", sessionId: SESSION, ownerId: ME_ID, createdAt: "2026-10-20T09:00:00.000Z", state: "idle" }],
        },
      },
      [`GET /api/agent-sessions/${SESSION}`]: {
        body: {
          id: SESSION, kind: "ai_job", title: "Export the report", projectId: PROJECT_ID, projectName: "Audin AI",
          ticketId: TICKET_ID, ticketNumber: 12, startedAt: "2026-10-20T09:00:00.000Z", lastEventAt: null,
          state: "held", canWrite: true, canInterrupt: true, questions: [], inputs: [],
        },
      },
      [`GET /api/agent-sessions/${SESSION}/events`]: { body: { events: [], before: null } },
      [`POST /api/tasks/${TICKET_ID}/cancel-run`]: () => {
        seen.push("cancel");
        return cancelReply;
      },
      [`POST /api/agent-sessions/${SESSION}/messages`]: () => {
        seen.push("stop");
        return { status: 202, body: { inputId: "eeeeeeee-0000-4000-8000-000000000009", status: "pending" } };
      },
    });

    async function openCancel() {
      const ue = userEvent.setup();
      renderRoute("/p/AUD/tasks?task=AUD-12");
      const panel = await screen.findByRole("dialog", { name: "Task AUD-12" });
      const claude = () => within(panel).getByRole("region", { name: "Claude" });
      // La sessione ferma è arrivata (lo stato lo dice): il menu ha le sue voci.
      await waitFor(() => expect(claude()).toHaveTextContent("Waiting"));
      await ue.click(within(claude()).getByRole("button", { name: "More actions for Claude" }));
      await ue.click(await screen.findByRole("menuitem", { name: "Cancel the work" }));
      return { ue, dialog: await screen.findByRole("dialog", { name: "Cancel Claude's work on this task?" }) };
    }

    it("con conferma, chiude il lavoro parcheggiato", async () => {
      const seen: string[] = [];
      installFakeServer(parked({ body: { claude: "none", webHref: "/x" } }, seen));
      const { ue, dialog } = await openCancel();
      expect(seen).toEqual([]);
      await ue.click(within(dialog).getByRole("button", { name: "Cancel the work" }));
      await waitFor(() => expect(seen).toEqual(["cancel"]));
      expect(await screen.findByText("Claude's work was cancelled.")).toBeInTheDocument();
    });

    it("con Claude al lavoro il server rifiuta: si propone «Ferma»", async () => {
      const seen: string[] = [];
      installFakeServer(parked({ status: 409, body: { code: "run_in_progress", message: "x" } }, seen));
      const { ue, dialog } = await openCancel();
      await ue.click(within(dialog).getByRole("button", { name: "Cancel the work" }));
      expect(await within(dialog).findByText("Claude is working right now: stop it first, then cancel.")).toBeInTheDocument();
      await ue.click(within(dialog).getByRole("button", { name: "Stop Claude" }));
      await waitFor(() => expect(seen).toEqual(["cancel", "stop"]));
    });
  });
});
