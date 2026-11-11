import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { chat, forgetPeopleChatCaches } from "./chat";
import { installFakeServer, me, ME_ID, PROJECT_ID, serverProject, serverTicketDetail } from "./fakeServer";
import { getSessionPerson } from "./session";

// @Claude nei canali nella build app (integrazione area 4, fetta 3): la vista
// `claude` del server nella forma del prototipo (`claudeRun`, `claudeEvents`).
// Le righe d'azione vengono dalla sessione, che il server dà SOLO a chi ha
// chiamato (D5); le proposte sono B, decise solo da chi ha chiamato coi flag
// del server, e senza «Annulla».

const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
const ROOT = "7f1c2a1e-0000-4000-8000-0000000000d1";
const REPLY = "7f1c2a1e-0000-4000-8000-0000000000d2";
const SESSION = "7f1c2a1e-0000-4000-8000-0000000000f1";
const PROPOSAL = "7f1c2a1e-0000-4000-8000-0000000000f2";
const QUESTION = "7f1c2a1e-0000-4000-8000-0000000000f3";
const CLAUDE = "7f1c2a1e-0000-4000-8000-0000000000aa";
const MARTA = "55555555-5555-4555-8555-555555555555";

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
  claudeReplying: true,
  ...over,
});

const claudeBlock = (over: Record<string, unknown> = {}) => ({
  state: "waiting",
  error: null,
  retried: false,
  callMessageId: ROOT,
  sessionId: SESSION,
  proposals: [
    {
      id: PROPOSAL,
      summary: "Create a task",
      status: "open",
      cls: "B",
      actions: [{ fn: "createTask", args: { projectId: PROJECT_ID, title: "Export PDF" } }],
      resultCodes: [],
      canConfirm: true,
      canCancel: true,
    },
  ],
  question: {
    id: QUESTION,
    text: "Which format?",
    options: [
      { label: "PDF", description: "The one in the brief" },
      { label: "CSV", description: "" },
    ],
    answer: null,
    canAnswer: true,
  },
  canStop: true,
  canRetry: false,
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
  replyCount: 0,
  claude: claudeBlock(block),
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

const toolUse = (id: string, name: string, input: unknown) => ({
  id,
  type: "tool_use",
  segmentId: "s1",
  at: `2026-11-10T10:00:0${id}.000Z`,
  data: { toolUseId: `t${id}`, name: `mcp__stubwise_chat__${name}`, input },
});
const toolResult = (id: string, of: string, content: string) => ({
  id,
  type: "tool_result",
  segmentId: "s1",
  at: `2026-11-10T10:00:0${id}.500Z`,
  data: { toolUseId: `t${of}`, isError: false, content },
});

beforeEach(() => {
  setAppClientForTests(null);
  forgetPeopleChatCaches();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

function install(routes: Record<string, unknown> = {}) {
  return installFakeServer({
    "GET /api/auth/me": { body: me() },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID, MARTA] })] },
    [`GET /api/chat/channels/${CH}`]: { body: channel() },
    [`GET /api/agent-sessions/${SESSION}/events`]: {
      body: { events: [toolUse("1", "search_tasks", { q: "export" }), toolResult("2", "1", "2 tasks")], before: null },
    },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]);
}

describe("la risposta di @Claude", () => {
  it("per chi ha chiamato: lo stato, le righe d'azione della sua sessione, la scheda B decisa coi flag del server, la domanda", async () => {
    install({ [`GET /api/chat/messages/${ROOT}/thread`]: { body: { root: root(), replies: [reply()] } } });
    await getSessionPerson();
    const thread = (await chat.listThread(ROOT))!;
    expect(thread.root.thread).toMatchObject({ claudeReplying: true });
    const m = thread.replies[0]!;
    expect(m).toMatchObject({
      kind: "claude",
      calledById: ME_ID,
      claudeRun: { callMessageId: ROOT, state: "waiting", retried: false },
    });
    const types = (m.claudeEvents ?? []).map((e) => e.type);
    expect(types).toEqual(["action", "proposal", "question"]);
    expect(m.claudeEvents![0]).toMatchObject({ type: "action", state: "done" });
    const proposal = m.claudeEvents!.find((e) => e.type === "proposal");
    expect(proposal).toMatchObject({
      proposalId: PROPOSAL,
      requesterId: ME_ID,
      canDecide: true,
      cls: "B",
      status: "open",
      actions: [{ fn: "createTask", summary: "Create the task “Export PDF”" }],
    });
    // Niente «Annulla»: nessun gruppo da annullare nella Chat.
    expect(proposal).not.toHaveProperty("groupId");
    expect(m.claudeEvents!.find((e) => e.type === "question")).toMatchObject({
      questionId: QUESTION,
      text: "Which format?",
      options: [{ label: "PDF", consequence: "The one in the brief" }, { label: "CSV" }],
      answer: null,
    });
  });

  it("per un altro lettore: nessuna sessione da leggere, la scheda senza argomenti né decisione", async () => {
    const { seen } = install({
      [`GET /api/chat/messages/${ROOT}/thread`]: {
        body: {
          root: root({ authorId: MARTA }),
          replies: [
            reply(
              { calledById: MARTA },
              {
                sessionId: null,
                canStop: false,
                question: { id: QUESTION, text: "Which format?", options: [{ label: "PDF" }], answer: null, canAnswer: false },
                proposals: [
                  {
                    id: PROPOSAL,
                    summary: "Create a task",
                    status: "open",
                    actions: [{ fn: "createTask", args: {} }],
                    canConfirm: false,
                    canCancel: false,
                  },
                ],
              },
            ),
          ],
        },
      },
    });
    await getSessionPerson();
    const m = (await chat.listThread(ROOT))!.replies[0]!;
    expect(seen.some((r) => r.path.startsWith("/api/agent-sessions"))).toBe(false);
    expect((m.claudeEvents ?? []).map((e) => e.type)).toEqual(["proposal", "question"]);
    const proposal = m.claudeEvents!.find((e) => e.type === "proposal");
    expect(proposal).toMatchObject({ requesterId: MARTA, canDecide: false, actions: [{ fn: "createTask" }] });
    // Il titolo non c'è: la frase non lo nomina (niente virgolette vuote).
    expect((proposal as { actions: { summary: string }[] }).actions[0]!.summary).not.toContain("“");
  });

  it("due lettori della stessa scheda: chi ha chiamato legge tutto, l'altro i dettagli degli oggetti che vede", async () => {
    const TASK = "7f1c2a1e-0000-4000-8000-0000000000b1";
    const actions = (hiddenTask: boolean) => [
      { fn: "createTask", args: { projectId: PROJECT_ID, title: "Export PDF" } },
      { fn: "updateTask", args: hiddenTask ? {} : { id: TASK, patch: { title: "PDF" } } },
    ];
    const thread = (calledById: string, hiddenTask: boolean, decide: boolean) => ({
      [`GET /api/chat/messages/${ROOT}/thread`]: {
        body: {
          root: root({ authorId: calledById }),
          replies: [
            reply(
              { calledById },
              {
                state: "done",
                question: null,
                sessionId: decide ? SESSION : null,
                proposals: [{ id: PROPOSAL, summary: "x", status: "open", actions: actions(hiddenTask), canConfirm: decide, canCancel: decide }],
              },
            ),
          ],
        },
      },
      [`GET /api/tickets/${TASK}`]: { body: serverTicketDetail({ id: TASK, number: 7 }) },
    });
    const summaries = async () => {
      const m = (await chat.listThread(ROOT))!.replies[0]!;
      const p = m.claudeEvents!.find((e) => e.type === "proposal") as { actions: { summary: string }[]; canDecide: boolean };
      return { canDecide: p.canDecide, lines: p.actions.map((a) => a.summary) };
    };
    // Chi ha chiamato.
    install(thread(ME_ID, false, true));
    await getSessionPerson();
    expect(await summaries()).toEqual({ canDecide: true, lines: ["Create the task “Export PDF”", "Change AUD-7 (title)"] });
    // Un altro lettore, che vede il progetto ma non la task: il titolo sì, la task no.
    forgetPeopleChatCaches();
    install(thread(MARTA, true, false));
    expect(await summaries()).toEqual({ canDecide: false, lines: ["Create the task “Export PDF”", "Change a task"] });
  });

  it("finita male: il motivo del server, anche il budget; «Try again» già usato", async () => {
    install({
      [`GET /api/chat/messages/${REPLY}`]: {
        body: reply({}, { state: "failed", error: "budget", retried: true, proposals: [], question: null, canStop: false }),
      },
    });
    await getSessionPerson();
    const hit = (await chat.getMessage(REPLY))!;
    expect(hit.message.claudeRun).toEqual({
      callMessageId: ROOT,
      state: "failed",
      errorCode: "budget",
      retried: true,
      // I flag del server: qui nessuno (già rifatta, niente domanda).
      canStop: false,
      canRetry: false,
      canAnswer: false,
    });
  });

  it("un messaggio di un server senza fetta 3: nessun blocco di Claude", async () => {
    install({ [`GET /api/chat/messages/${ROOT}`]: { body: root({ claudeReplying: undefined }) } });
    await getSessionPerson();
    const hit = (await chat.getMessage(ROOT))!;
    expect(hit.message).not.toHaveProperty("claudeRun");
    expect(hit.message).not.toHaveProperty("claudeEvents");
  });
});

describe("fermare, rifare, rispondere", () => {
  it("le rotte e i corpi; la risposta nuova di «Try again»", async () => {
    const NEW = "7f1c2a1e-0000-4000-8000-0000000000d3";
    const { seen } = install({
      [`POST /api/chat/messages/${REPLY}/claude/stop`]: { body: reply({}, { state: "stopped", canStop: false }) },
      [`POST /api/chat/messages/${REPLY}/claude/retry`]: { status: 201, body: reply({ id: NEW }, { state: "working" }) },
      [`POST /api/chat/messages/${REPLY}/claude/answer`]: { body: reply({}, { state: "working" }) },
    });
    await getSessionPerson();
    expect(await chat.stopClaudeReply(REPLY)).toMatchObject({ id: REPLY, claudeRun: { state: "stopped" } });
    expect(await chat.retryClaudeReply(REPLY)).toMatchObject({ id: NEW, claudeRun: { state: "working" } });
    await chat.answerChatClaudeQuestion(REPLY, QUESTION, { optionIndex: 0, text: null });
    expect(seen.filter((r) => r.method === "POST").map((r) => [r.path, r.body])).toEqual([
      [`/api/chat/messages/${REPLY}/claude/stop`, undefined],
      [`/api/chat/messages/${REPLY}/claude/retry`, undefined],
      [`/api/chat/messages/${REPLY}/claude/answer`, { questionId: QUESTION, optionIndex: 0, text: null }],
    ]);
  });

  it("i rifiuti negli errori del prototipo", async () => {
    install({
      [`POST /api/chat/messages/${REPLY}/claude/stop`]: { status: 403, body: { code: "not_yours", message: "x" } },
      [`POST /api/chat/messages/${REPLY}/claude/retry`]: { status: 409, body: { code: "invalid_status", message: "x" } },
      [`POST /api/chat/messages/${REPLY}/claude/answer`]: { status: 409, body: { code: "already_answered", message: "x" } },
    });
    await getSessionPerson();
    await expect(chat.stopClaudeReply(REPLY)).rejects.toThrow("forbidden");
    await expect(chat.retryClaudeReply(REPLY)).rejects.toThrow("invalid: status");
    await expect(chat.answerChatClaudeQuestion(REPLY, QUESTION, { optionIndex: 0, text: null })).rejects.toThrow(
      /^already_answered$/,
    );
  });
});

describe("le proposte", () => {
  const thread = { [`GET /api/chat/messages/${ROOT}/thread`]: { body: { root: root(), replies: [reply()] } } };

  it("conferma (anche coi valori di «Edit») e annulla con le rotte delle proposte; «Edit» legge gli argomenti", async () => {
    const { seen } = install({
      ...thread,
      [`POST /api/claude/proposals/${PROPOSAL}/confirm`]: { body: proposalView("confirmed") },
      [`POST /api/claude/proposals/${PROPOSAL}/cancel`]: { body: proposalView("cancelled") },
    });
    await getSessionPerson();
    await chat.listThread(ROOT);
    expect(await chat.confirmChatProposal(REPLY, PROPOSAL, { actionIndexes: [0] })).toMatchObject({ status: "confirmed" });
    await chat.confirmChatProposal(REPLY, PROPOSAL, { edited: [{ index: 0, args: { title: "Export" } }] });
    await chat.cancelChatProposal(REPLY, PROPOSAL);
    expect(await chat.editChatProposal(REPLY, PROPOSAL)).toEqual({
      fn: "createTask",
      args: { projectId: PROJECT_ID, title: "Export PDF" },
    });
    expect(seen.filter((r) => r.method === "POST").map((r) => [r.path, r.body])).toEqual([
      [`/api/claude/proposals/${PROPOSAL}/confirm`, { selected: [0] }],
      [`/api/claude/proposals/${PROPOSAL}/confirm`, { edited: [{ index: 0, args: { title: "Export" } }] }],
      [`/api/claude/proposals/${PROPOSAL}/cancel`, undefined],
    ]);
  });

  it("un 404 in un canale archiviato è «canale archiviato», fuori dal canale «non sei più nel canale»", async () => {
    const gone = { status: 404, body: { code: "not_found", message: "x" } };
    const routes = {
      ...thread,
      [`POST /api/claude/proposals/${PROPOSAL}/confirm`]: gone,
      [`POST /api/claude/proposals/${PROPOSAL}/cancel`]: gone,
    };
    install({ ...routes, [`GET /api/chat/channels/${CH}`]: { body: channel({ archived: true }) } });
    await getSessionPerson();
    await chat.listThread(ROOT);
    await expect(chat.confirmChatProposal(REPLY, PROPOSAL)).rejects.toThrow("invalid: archived");
    await expect(chat.cancelChatProposal(REPLY, PROPOSAL)).rejects.toThrow("invalid: archived");

    install({ ...routes, [`GET /api/chat/channels/${CH}`]: { body: channel({ isMember: false, memberIds: [MARTA] }) } });
    await expect(chat.confirmChatProposal(REPLY, PROPOSAL)).rejects.toThrow("not_member");

    // Un canale che non si legge più (un privato da cui si è usciti): fuori anche lui.
    install({ ...routes, [`GET /api/chat/channels/${CH}`]: gone });
    await expect(chat.confirmChatProposal(REPLY, PROPOSAL)).rejects.toThrow("not_member");
  });

  it("una proposta che il server non esegue (409) è «failed», come nella conversazione", async () => {
    install({
      ...thread,
      [`POST /api/claude/proposals/${PROPOSAL}/confirm`]: { status: 409, body: { code: "expired", message: "x" } },
    });
    await getSessionPerson();
    await chat.listThread(ROOT);
    expect(await chat.confirmChatProposal(REPLY, PROPOSAL)).toEqual({ status: "failed", error: "expired" });
  });
});

describe("«Da decidere»", () => {
  it("le domande di @Claude a chi guarda, col canale come lo legge lui", async () => {
    install({
      "GET /api/chat/claude-questions": {
        body: {
          items: [
            {
              id: `chat-claude:${REPLY}:${QUESTION}`,
              channelId: CH,
              messageId: REPLY,
              rootId: ROOT,
              questionId: QUESTION,
              text: "Which format?",
              options: [{ label: "PDF", description: "The one in the brief" }, { label: "CSV" }],
              createdAt: "2026-11-10T10:00:06.000Z",
            },
          ],
        },
      },
      "GET /api/chat/channels": { body: { items: [channel()] } },
      "GET /api/people": { body: [] },
    });
    await getSessionPerson();
    expect(await chat.listClaudeQuestions()).toEqual([
      {
        id: `chat-claude:${REPLY}:${QUESTION}`,
        channelId: CH,
        messageId: REPLY,
        rootId: ROOT,
        channelLabel: expect.stringContaining("design"),
        questionId: QUESTION,
        text: "Which format?",
        options: [{ label: "PDF", consequence: "The one in the brief" }, { label: "CSV" }],
        createdAt: "2026-11-10T10:00:06.000Z",
      },
    ]);
  });
});
