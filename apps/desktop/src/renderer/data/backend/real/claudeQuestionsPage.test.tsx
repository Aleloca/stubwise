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

// Le domande a scelta della libera nella pagina della build app (area 10,
// F2, Task 3 di 72): l'evento `question` della sessione, i dati da
// `GET …/questions`, la scheda del prototipo e la risposta su `POST …/answer`.
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

const Q1 = "dddddddd-0000-4000-8000-000000000001";
const question = (over: Record<string, unknown> = {}) => ({
  id: Q1,
  text: "Which department should be alerted?",
  options: [
    { label: "Support", description: "Every urgent request from support" },
    { label: "Sales" },
  ],
  answer: null,
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
            data: { inputId: "i1", text: "Alert the department on urgent support requests" },
          },
          {
            id: "2",
            type: "question",
            segmentId: "s1",
            at: "2026-11-10T10:01:00.000Z",
            data: { questionId: Q1 },
          },
        ],
        before: null,
      },
    },
    [`GET /api/claude/conversations/${MINE}/proposals`]: { body: [] },
    [`GET /api/claude/conversations/${MINE}/groups`]: { body: [] },
    [`GET /api/claude/conversations/${MINE}/questions`]: { body: [question()] },
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

describe("le domande di Claude nella libera, nella build app", () => {
  it("la scheda dice domanda, opzioni e conseguenze; un clic manda l'indice", async () => {
    install({
      [`POST /api/claude/conversations/${MINE}/questions/${Q1}/answer`]: {
        status: 202,
        body: { inputId: "eeeeeeee-0000-4000-8000-000000000001", status: "pending" },
      },
    });
    const ue = userEvent.setup();
    renderRoute(`/claude/${MINE}`);
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-question="${Q1}"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(within(card).getByText("Which department should be alerted?")).toBeInTheDocument();
    expect(within(card).getByText("Every urgent request from support")).toBeInTheDocument();
    await ue.click(within(card).getByRole("button", { name: /Support/ }));
    await waitFor(() =>
      expect(
        seen.filter((r) => r.method === "POST" && r.path.includes("/answer")).map((r) => r.body),
      ).toEqual([{ index: 0 }]),
    );
  });

  it("una domanda già risposta si legge chiusa, con la risposta", async () => {
    install({
      [`GET /api/claude/conversations/${MINE}/questions`]: {
        body: [
          question({
            answer: {
              index: 1,
              text: null,
              by: { id: ME_ID, name: "Ada" },
              at: "2026-11-10T10:02:00.000Z",
            },
          }),
        ],
      },
    });
    renderRoute(`/claude/${MINE}`);
    const line = (await screen.findByText("Which department should be alerted?")).closest("p")!;
    expect(line).toHaveTextContent("Sales");
    expect(document.querySelector(`[data-question="${Q1}"]`)).toBeNull();
    expect(screen.queryByRole("button", { name: /Support/ })).toBeNull();
  });

  it("chi legge la pubblica di un altro vede la domanda, ma non risponde", async () => {
    install({}, false);
    renderRoute(`/claude/${MINE}`);
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-question="${Q1}"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    const support = within(card).queryByRole("button", { name: /Support/ });
    expect(support === null || (support as HTMLButtonElement).disabled).toBe(true);
  });
});
