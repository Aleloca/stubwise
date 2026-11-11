import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { forgetPeopleChatCaches } from "./chat";
import { resetChatStreams, setChatStreamTransport } from "./chatStream";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject, type SeenRequest } from "./fakeServer";

// @Claude nei canali nelle pagine della build app (area 4, fetta 3, flag
// `chat-claude` acceso): la risposta nel thread «chiamato da», le righe
// d'azione solo a chi ha chiamato, le schede B decise solo da lui (coi flag
// del server) e senza «Annulla», la domanda, il budget finito, e il 404 di un
// canale archiviato detto come tale.
vi.mock("@backend/api", async () => await import("./index"));

const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
const ROOT = "7f1c2a1e-0000-4000-8000-0000000000d1";
const REPLY = "7f1c2a1e-0000-4000-8000-0000000000d2";
const SESSION = "7f1c2a1e-0000-4000-8000-0000000000f1";
const PROPOSAL = "7f1c2a1e-0000-4000-8000-0000000000f2";
const QUESTION = "7f1c2a1e-0000-4000-8000-0000000000f3";
const CLAUDE = "7f1c2a1e-0000-4000-8000-0000000000aa";
const MARTA = "55555555-5555-4555-8555-555555555555";
let seen: SeenRequest[] = [];

const channel = (over: Record<string, unknown> = {}) => ({
  id: CH,
  kind: "project",
  projectId: PROJECT_ID,
  name: "design",
  visibility: "open",
  archived: false,
  createdBy: MARTA,
  createdAt: "2026-11-10T09:00:00.000Z",
  memberIds: [ME_ID, MARTA],
  isMember: true,
  canWrite: true,
  canLeave: true,
  lastMessageAt: "2026-11-10T10:00:00.000Z",
  lastReadAt: "2026-11-10T10:00:00.000Z",
  ...over,
});

const root = (over: Record<string, unknown> = {}) => ({
  id: ROOT,
  channelId: CH,
  threadRootId: null,
  authorId: ME_ID,
  kind: "person",
  text: "@Claude what's left on the export?",
  createdAt: "2026-11-10T10:00:00.000Z",
  replyCount: 1,
  ...over,
});

const proposal = (over: Record<string, unknown> = {}) => ({
  id: PROPOSAL,
  summary: "Create a task",
  status: "open",
  actions: [{ fn: "createTask", args: { projectId: PROJECT_ID, title: "Export PDF" } }],
  canConfirm: true,
  canCancel: true,
  ...over,
});

const reply = (over: Record<string, unknown> = {}, block: Record<string, unknown> = {}) => ({
  id: REPLY,
  channelId: CH,
  threadRootId: ROOT,
  authorId: CLAUDE,
  kind: "claude",
  calledById: ME_ID,
  text: "Two things are left.",
  createdAt: "2026-11-10T10:00:05.000Z",
  claude: {
    state: "waiting",
    callMessageId: ROOT,
    sessionId: SESSION,
    proposals: [proposal()],
    question: {
      id: QUESTION,
      text: "Which format first?",
      options: [{ label: "PDF" }, { label: "CSV" }],
      answer: null,
      canAnswer: true,
    },
    canStop: true,
    ...block,
  },
  ...over,
});

const proposalView = (status: string) => ({
  id: PROPOSAL,
  sessionId: SESSION,
  summary: "Create a task",
  actions: [{ fn: "createTask", args: { projectId: PROJECT_ID, title: "Export PDF" } }],
  status,
  createdAt: "2026-11-10T10:00:05.000Z",
});

function install(thread: { root: unknown; replies: unknown[] }, routes: Record<string, unknown> = {}) {
  seen = installFakeServer({
    "GET /api/auth/me": { body: me({ projectPermissions: { [PROJECT_ID]: ["tickets.view_all", "tickets.create"] } }) },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID, MARTA] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/me/claude-decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [
        { id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" },
        { id: MARTA, name: "Marta Rinaldi", initials: "MR", departmentIds: [DEPT_ID], email: "marta@example.com" },
      ],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/agent-sessions": { body: { live: [], recent: [] } },
    "GET /api/claude/conversations/status": { body: { budgetExhausted: false } },
    "GET /api/chat/channels": { body: { items: [channel()] } },
    [`GET /api/chat/channels/${CH}`]: { body: channel() },
    [`GET /api/chat/channels/${CH}/messages`]: { body: { items: [thread.root], before: null } },
    [`POST /api/chat/channels/${CH}/read`]: { status: 204 },
    [`GET /api/chat/messages/${ROOT}/thread`]: { body: { ...thread, lastReadAt: null } },
    [`GET /api/chat/messages/${ROOT}`]: { body: thread.root },
    [`GET /api/agent-sessions/${SESSION}/events`]: {
      body: {
        events: [
          {
            id: "1",
            type: "tool_use",
            segmentId: "s1",
            at: "2026-11-10T10:00:01.000Z",
            data: { toolUseId: "t1", name: "mcp__stubwise_chat__search_tasks", input: { q: "export" } },
          },
          {
            id: "2",
            type: "tool_result",
            segmentId: "s1",
            at: "2026-11-10T10:00:02.000Z",
            data: { toolUseId: "t1", isError: false, content: "2 tasks" },
          },
        ],
        before: null,
      },
    },
    "GET /api/chat/threads": { body: { items: [] } },
    "GET /api/chat/mentions": { body: { items: [] } },
    "GET /api/chat/signal": { body: { hasNews: false, mentions: 0 } },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]).seen;
}

beforeEach(() => {
  setAppClientForTests(null);
  resetChatStreams();
  forgetPeopleChatCaches();
  setChatStreamTransport(() => () => undefined);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  setChatStreamTransport(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

const replyArticle = async () =>
  (await screen.findByRole("article", { name: /called by/ }, { timeout: 3000 })) as HTMLElement;

describe("@Claude nei canali, nella build app", () => {
  it("chi ha chiamato: «called by», cosa ha letto, la domanda a cui risponde, la scheda che conferma", async () => {
    install(
      { root: root(), replies: [reply()] },
      {
        [`POST /api/chat/messages/${REPLY}/claude/answer`]: { body: reply({}, { state: "working", question: null }) },
        [`POST /api/claude/proposals/${PROPOSAL}/confirm`]: { body: proposalView("confirmed") },
      },
    );
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}?thread=${ROOT}`);
    const article = await replyArticle();
    expect(article).toHaveAccessibleName("called by Ada");
    expect(within(article).getByText("Two things are left.")).toBeInTheDocument();
    // Le righe d'azione della sua sessione (D5).
    await waitFor(() => expect(seen.some((r) => r.path.startsWith(`/api/agent-sessions/${SESSION}/events`))).toBe(true));
    expect(within(article).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    // La domanda: risponde lui.
    expect(within(article).getByText("Which format first?")).toBeInTheDocument();
    await ue.click(within(article).getByRole("button", { name: "PDF" }));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST" && r.path.endsWith("/claude/answer")).map((r) => r.body)).toEqual([
        { questionId: QUESTION, optionIndex: 0, text: null },
      ]),
    );
    // La scheda: «Create the task “Export PDF”», e la conferma.
    expect(within(article).getByText(/Export PDF/)).toBeInTheDocument();
    await ue.click(within(article).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(seen.some((r) => r.method === "POST" && r.path === `/api/claude/proposals/${PROPOSAL}/confirm`)).toBe(true));
  });

  it("un altro lettore: niente righe d'azione, niente Stop, nessuna decisione; la scheda dice per chi è", async () => {
    install({
      root: root({ authorId: MARTA }),
      replies: [
        reply(
          { calledById: MARTA },
          {
            sessionId: null,
            canStop: false,
            // Due azioni: il progetto della prima lo vede (argomenti pieni), quello della seconda no (`{}`).
            proposals: [
              proposal({
                actions: [
                  { fn: "createTask", args: { projectId: PROJECT_ID, title: "Export PDF" } },
                  { fn: "createRequest", args: {} },
                ],
                canConfirm: false,
                canCancel: false,
              }),
            ],
            question: { id: QUESTION, text: "Which format first?", options: [{ label: "PDF" }], answer: null, canAnswer: false },
          },
        ),
      ],
    });
    renderRoute(`/chat/${CH}?thread=${ROOT}`);
    const article = await replyArticle();
    expect(article).toHaveAccessibleName("called by Marta Rinaldi");
    expect(within(article).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(within(article).queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(within(article).getByText("Proposal for Marta Rinaldi")).toBeInTheDocument();
    expect(within(article).getByText(/Create the task “Export PDF”/)).toBeInTheDocument();
    expect(within(article).getByText("Send a request")).toBeInTheDocument();
    expect(within(article).getByText("Waiting for Marta Rinaldi")).toBeInTheDocument();
    expect(seen.some((r) => r.path.startsWith("/api/agent-sessions/"))).toBe(false);
  });

  it("chi ha chiamato non decide quando il server non glielo lascia fare (canConfirm/canCancel spenti)", async () => {
    install({
      root: root(),
      replies: [reply({}, { state: "done", question: null, proposals: [proposal({ canConfirm: false, canCancel: false })] })],
    });
    renderRoute(`/chat/${CH}?thread=${ROOT}`);
    const article = await replyArticle();
    expect(await within(article).findByText(/Export PDF/)).toBeInTheDocument();
    expect(within(article).queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(within(article).queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("Stop, «Try again» e la risposta alla domanda seguono i flag del server, anche per chi ha chiamato", async () => {
    install({
      root: root(),
      replies: [
        reply(
          {},
          {
            state: "waiting",
            canStop: false,
            proposals: [],
            question: { id: QUESTION, text: "Which format first?", options: [{ label: "PDF" }], answer: null, canAnswer: false },
          },
        ),
        reply(
          { id: "7f1c2a1e-0000-4000-8000-0000000000d3", createdAt: "2026-11-10T10:01:00.000Z", text: "" },
          { state: "failed", error: "other", sessionId: null, proposals: [], question: null, canStop: false, canRetry: false },
        ),
      ],
    });
    renderRoute(`/chat/${CH}?thread=${ROOT}`);
    const articles = await screen.findAllByRole("article", { name: /called by/ }, { timeout: 3000 });
    expect(articles).toHaveLength(2);
    expect(within(articles[0]!).getByText("Which format first?")).toBeInTheDocument();
    expect(within(articles[0]!).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(within(articles[0]!).queryByRole("button", { name: "PDF" })).toBeNull();
    expect(within(articles[1]!).getByText(/Claude couldn't finish/)).toBeInTheDocument();
    expect(within(articles[1]!).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("«Delete Claude's reply» segue canDelete del server, non chi ha chiamato", async () => {
    const OTHER = "7f1c2a1e-0000-4000-8000-0000000000d3";
    install({
      root: root(),
      replies: [
        reply({ canDelete: false }, { state: "done", question: null, proposals: [] }),
        reply({ id: OTHER, calledById: MARTA, canDelete: true, createdAt: "2026-11-10T10:01:00.000Z" }, {
          state: "done",
          sessionId: null,
          question: null,
          proposals: [],
          canStop: false,
        }),
      ],
    });
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}?thread=${ROOT}`);
    const [mine, other] = await screen.findAllByRole("article", { name: /called by/ }, { timeout: 3000 });
    await ue.click(within(mine!).getByRole("button", { name: "More actions" }));
    let menu = screen.getByRole("menu", { name: "Message actions" });
    expect(within(menu).queryByRole("menuitem", { name: "Delete Claude's reply" })).toBeNull();
    await ue.keyboard("{Escape}");
    await ue.click(within(other!).getByRole("button", { name: "More actions" }));
    menu = screen.getByRole("menu", { name: "Message actions" });
    expect(within(menu).getByRole("menuitem", { name: "Delete Claude's reply" })).toBeInTheDocument();
  });

  it("una scheda confermata nella Chat non ha «Annulla»", async () => {
    install({
      root: root(),
      replies: [reply({}, { state: "done", question: null, proposals: [proposal({ status: "confirmed", resultCodes: ["AUD-9"], canConfirm: false, canCancel: false })] })],
    });
    renderRoute(`/chat/${CH}?thread=${ROOT}`);
    const article = await replyArticle();
    expect(await within(article).findByText("Done")).toBeInTheDocument();
    expect(within(article).queryByRole("button", { name: /^Undo/ })).toBeNull();
  });

  it("il canale archiviato mentre la scheda è aperta: il 404 della conferma lo dice", async () => {
    let archived = false;
    install(
      { root: root(), replies: [reply({}, { state: "done", question: null })] },
      {
        // Il canale viene archiviato dopo la lettura del thread.
        [`GET /api/chat/channels/${CH}`]: () => ({ body: channel({ archived }) }),
        [`POST /api/claude/proposals/${PROPOSAL}/confirm`]: { status: 404, body: { code: "not_found", message: "x" } },
      },
    );
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}?thread=${ROOT}`);
    const article = await replyArticle();
    archived = true;
    await ue.click(within(article).getByRole("button", { name: "Confirm" }));
    expect(await within(article).findByText("This channel is archived: nothing was changed.")).toBeInTheDocument();
  });

  it("la casella offre @Claude e avvisa che risponderà a nome di chi scrive, davanti a tutto il canale", async () => {
    install({ root: root({ replyCount: 0 }), replies: [] });
    const ue = userEvent.setup();
    renderRoute(`/chat/${CH}`);
    const box = await screen.findByRole("combobox", { name: /^Message/ });
    await ue.type(box, "@Cla");
    expect(await screen.findByRole("option", { name: /@Claude/ })).toBeInTheDocument();
    await ue.keyboard("{Escape}");
    await ue.type(box, "ude summarize");
    expect(await screen.findByText(/Claude will act as you and reply here/)).toBeInTheDocument();
  });

  it("budget finito: il motivo, e «Try again» per chi ha chiamato", async () => {
    install({
      root: root(),
      replies: [reply({ text: "" }, { state: "failed", error: "budget", sessionId: null, proposals: [], question: null, canStop: false, canRetry: true })],
    });
    renderRoute(`/chat/${CH}?thread=${ROOT}`);
    const article = await replyArticle();
    expect(within(article).getByText("Claude couldn't finish: the monthly Claude budget is used up")).toBeInTheDocument();
    expect(within(article).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
