import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { resetStreamsForTests } from "./claudeStream";
import { forgetClaudeCaches } from "./claude";
import {
  DEPT_ID,
  installFakeServer,
  me,
  ME_ID,
  PROJECT_ID,
  serverProject,
  type SeenRequest,
} from "./fakeServer";

// S0 nella pagina della build app (area 10, F7 di 72): l'evento
// `capabilities` del ponte diventa la lista del prototipo, con le frasi del
// renderer; un id ignoto non c'è. Ogni riga scrive la frase d'esempio nella
// casella senza inviarla.
vi.mock("@backend/api", async () => await import("./index"));

const CONV = "cccccccc-0000-4000-8000-0000000000f5";
const MINE = "cccccccc-0000-4000-8000-0000000000f6";
const GIULIA = "55555555-5555-4555-8555-555555555555";
let seen: SeenRequest[] = [];

const session = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "free",
  title: "Callbacks",
  projectId: null,
  projectName: null,
  ticketId: null,
  ticketNumber: null,
  startedAt: "2026-11-10T10:00:00.000Z",
  lastEventAt: "2026-11-10T10:05:00.000Z",
  state: "idle",
  canWrite: false,
  canIntervene: false,
  canInterrupt: false,
  canClose: false,
  questions: [],
  inputs: [],
  ...over,
});

const view = (over: Record<string, unknown> = {}) => ({
  id: MINE,
  title: "Callbacks",
  archived: false,
  context: null,
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:05:00.000Z",
  state: "idle",
  lastEventAt: "2026-11-10T10:05:00.000Z",
  visibility: "private",
  author: { id: ME_ID, name: "Ada" },
  isOwner: true,
  publishedAt: null,
  publishedBy: null,
  publishedProjects: [],
  privateTail: false,
  heldProjects: [],
  continuesFrom: null,
  canPublish: true,
  canContinue: false,
  ...over,
});

const theirs = (over: Record<string, unknown> = {}) =>
  view({
    id: CONV,
    visibility: "public",
    author: { id: GIULIA, name: "Giulia Ferri" },
    isOwner: false,
    publishedAt: "2026-11-10T10:06:00.000Z",
    publishedBy: { id: GIULIA, name: "Giulia Ferri" },
    publishedProjects: [{ id: PROJECT_ID, code: "AUD", name: "Audin AI" }],
    canPublish: false,
    canContinue: true,
    ...over,
  });

function install(routes: Record<string, unknown> = {}, owner = true) {
  const mine = owner ? view() : theirs({ id: MINE });
  seen = installFakeServer({
    "GET /api/auth/me": { body: me({ instancePermissions: ["claude.public.view"] }) },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID, GIULIA] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/me/claude-decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [
        {
          id: ME_ID,
          name: "Ada",
          initials: "AD",
          departmentIds: [DEPT_ID],
          email: "ada@example.com",
        },
        {
          id: GIULIA,
          name: "Giulia Ferri",
          initials: "GF",
          departmentIds: [DEPT_ID],
          email: "giulia@example.com",
        },
      ],
    },
    "GET /api/departments": {
      body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }],
    },
    "GET /api/agent-sessions": { body: { live: [], recent: [] } },
    "GET /api/claude/conversations/status": { body: { budgetExhausted: false } },
    "GET /api/claude/conversations": { body: { items: [mine], nextCursor: null } },
    [`GET /api/claude/conversations/${MINE}`]: {
      body: { ...mine, session: session(MINE, { canWrite: owner, canIntervene: owner }) },
    },
    [`GET /api/agent-sessions/${MINE}`]: {
      body: session(MINE, { canWrite: owner, canIntervene: owner }),
    },
    [`GET /api/agent-sessions/${MINE}/events`]: {
      body: {
        events: [
          {
            id: "1",
            type: "input",
            segmentId: "s1",
            at: "2026-11-10T10:00:10.000Z",
            data: { inputId: "i1", text: "Book me a flight to Milan" },
          },
          {
            id: "2",
            type: "assistant_text",
            segmentId: "s1",
            at: "2026-11-10T10:01:00.000Z",
            data: { text: "I can't book flights. Here is what I can do." },
          },
          {
            id: "3",
            type: "capabilities",
            segmentId: "s1",
            at: "2026-11-10T10:01:01.000Z",
            data: { items: ["automation", "__unknown__", "taskDescription"] },
          },
        ],
        before: null,
      },
    },
    [`GET /api/claude/conversations/${MINE}/proposals`]: { body: [] },
    [`GET /api/claude/conversations/${MINE}/groups`]: { body: [] },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]).seen;
}

beforeEach(() => {
  setAppClientForTests(null);
  resetStreamsForTests();
  forgetClaudeCaches();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("«cosa sai fare» nella build app (S0)", () => {
  it("la lista delle capacità ricevute, nella lingua di chi guarda; l'ignota no; la riga scrive nella casella senza inviare", async () => {
    install();
    const ue = userEvent.setup();
    renderRoute(`/claude/${MINE}`);
    const list = await screen.findByRole("list", { name: "What I can do" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Build an automation and test it"),
      expect.stringContaining("Write a task's description"),
    ]);
    await ue.click(within(rows[0]!).getByRole("button"));
    const box = await screen.findByLabelText("Message to Claude");
    await waitFor(() => expect((box as HTMLTextAreaElement).value).not.toBe(""));
    expect(seen.filter((r) => r.method !== "GET")).toEqual([]);
  });
});
