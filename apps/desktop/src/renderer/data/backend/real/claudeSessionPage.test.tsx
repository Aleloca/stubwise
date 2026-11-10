import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { resetStreamsForTests } from "./claudeStream";
import { forgetClaudeCaches } from "./claude";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject, TICKET_ID, type SeenRequest } from "./fakeServer";

// Una sessione di lavoro aperta nella build app (area 3, fetta 3b): la casella
// e «Ferma» ci sono dove il server dice `canWrite`/`canInterrupt`; un
// messaggio e «Ferma» sono messaggi della sessione. Niente allegati.
vi.mock("@backend/api", async () => await import("./index"));

const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";
let seen: SeenRequest[] = [];

const detail = (over: Record<string, unknown> = {}) => ({
  id: SESSION,
  kind: "ai_job",
  title: "Export the report",
  projectId: PROJECT_ID,
  projectName: "Audin AI",
  ticketId: TICKET_ID,
  ticketNumber: 12,
  startedAt: "2026-10-20T09:00:00.000Z",
  lastEventAt: "2026-10-20T09:05:00.000Z",
  state: "working",
  canWrite: true,
  canIntervene: true,
  canInterrupt: true,
  questions: [],
  inputs: [],
  ...over,
});

function install(over: Record<string, unknown> = {}) {
  seen = installFakeServer({
    "GET /api/auth/me": { body: me({ projectPermissions: { [PROJECT_ID]: ["tickets.view_all"] } }) },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/me/claude-decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" }],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/agent-sessions": { body: { live: [], recent: [] } },
    [`GET /api/agent-sessions/${SESSION}`]: { body: detail(over) },
    [`GET /api/agent-sessions/${SESSION}/events`]: {
      body: {
        events: [{ id: "1", type: "segment_start", segmentId: "s1", at: "2026-10-20T09:01:00.000Z", data: { label: "execute", interactive: true } }],
        before: null,
      },
    },
    [`GET /api/tasks/${TICKET_ID}/work`]: { body: { claude: "working", webHref: "/x", runs: [] } },
    [`POST /api/agent-sessions/${SESSION}/messages`]: { status: 202, body: { inputId: "eeeeeeee-0000-4000-8000-000000000001", status: "pending" } },
  }).seen;
}

beforeEach(() => {
  setAppClientForTests(null);
  resetStreamsForTests();
  forgetClaudeCaches();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  // Lo stream resta aperto senza dire niente: il flusso viene dal dettaglio.
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("una sessione di lavoro nella build app", () => {
  it("con canWrite: la casella senza graffetta; il messaggio e «Ferma» vanno alla sessione", async () => {
    install();
    const ue = userEvent.setup();
    renderRoute(`/claude/${SESSION}`);
    const box = await screen.findByLabelText("Message to Claude");
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
    await ue.type(box, "Also update the docs");
    await ue.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([{ text: "Also update the docs" }]),
    );
    await ue.click(screen.getByRole("button", { name: /^Stop/ }));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([
        { text: "Also update the docs" },
        { interrupt: true },
      ]),
    );
  });

  it("senza canWrite: niente casella, la riga di chi può scrivere", async () => {
    install({ canWrite: false, canIntervene: false, canInterrupt: false });
    renderRoute(`/claude/${SESSION}`);
    expect(await screen.findByText("Only a maintainer can write to the agent.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Message to Claude")).toBeNull();
  });
});
