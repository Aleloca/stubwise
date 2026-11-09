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

  it("la sezione Claude dice lo stato vero, le PR e Open in web", async () => {
    const ue = userEvent.setup();
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    renderRoute("/p/AUD/tasks?task=AUD-12");
    const panel = await screen.findByRole("dialog", { name: "Task AUD-12" });
    const claude = await within(panel).findByRole("region", { name: "Claude" });
    expect(await within(claude).findByText("Claude is waiting for its plan to be approved.")).toBeInTheDocument();
    expect(within(claude).getByRole("link", { name: "PR #7" })).toHaveAttribute("href", "https://git.example/acme/app/pull/7");
    await ue.click(within(claude).getByRole("button", { name: "Open in web" }));
    expect(assign).toHaveBeenCalledWith(`/tickets/${TICKET_ID}`);
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
