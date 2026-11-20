import { waitFor, within } from "@testing-library/react";
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

// «Hypothesis» e «Details» sotto la risposta di S2 nella pagina della build
// app (area 10, F3 di 72): l'evento `aside` arricchito della sessione.
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
            data: { inputId: "i1", text: "What's stalled?" },
          },
          {
            id: "2",
            type: "assistant_text",
            segmentId: "s1",
            at: "2026-11-10T10:01:00.000Z",
            data: { text: "AUD has 3 stalled tasks." },
          },
          {
            id: "3",
            type: "aside",
            segmentId: "s1",
            at: "2026-11-10T10:01:01.000Z",
            data: {
              rows: [
                {
                  projectId: PROJECT_ID,
                  projectCode: "AUD",
                  count: 3,
                  ticketId: "t1",
                  taskCode: "AUD-12",
                  stalledSince: "2026-11-01",
                  reason: "to_prepare",
                  closed: false,
                  thresholdDays: 10,
                },
              ],
              hypothesis: { ticketId: "t1", taskCode: "AUD-12", key: "out_of_plan" },
            },
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

describe("le righe sotto la risposta di S2, nella build app", () => {
  it("l'ipotesi col filetto tratteggiato e il codice apribile; «Details» chiuso, che si apre", async () => {
    install();
    const ue = userEvent.setup();
    renderRoute(`/claude/${MINE}`);
    const hypothesis = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-aside="hypothesis"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(hypothesis).toHaveTextContent("AUD-12 may have fallen out of planning: it has no week");
    const details = document.querySelector<HTMLElement>('[data-aside="details"]')!;
    await ue.click(within(details).getByRole("button", { name: "Details" }));
    expect(details).toHaveTextContent("(AUD: 10 days)");
    // Leggere le righe non scrive niente.
    expect(seen.filter((r) => r.method !== "GET")).toEqual([]);
  });
});
