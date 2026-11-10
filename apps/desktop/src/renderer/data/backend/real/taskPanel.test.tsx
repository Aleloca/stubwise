import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

  it("la sezione Claude legge il lavoro vero, in lettura: anche col server che permette tutto, nessuna azione (3b)", async () => {
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

  it("una sessione fallita con rilancio e modifiche permessi dal server: nella 3a niente bottoni", async () => {
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
    });
    renderRoute("/p/AUD/tasks?task=AUD-12");
    const panel = await screen.findByRole("dialog", { name: "Task AUD-12" });
    const claude = () => within(panel).getByRole("region", { name: "Claude" });
    await waitFor(() => expect(claude()).toHaveTextContent("The tests failed."));
    expect(within(claude()).queryByRole("button", { name: /Relaunch|Request changes/ })).toBeNull();
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
});
