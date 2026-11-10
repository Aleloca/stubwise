import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetClaudeCaches, getConversation } from "./claude";
import { claudeChatNamespace } from "./claudeChatActions";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, ME_ID, PROJECT_ID, serverProject, serverTicketDetail, TICKET_ID } from "./fakeServer";
import { getSessionPerson } from "./session";

// Le proposte e le azioni di Claude nella chat della build app (chat, fetta 3,
// F3.4): gli eventi `proposal` e `actions_executed` della sessione portano solo
// gli id; la scheda e la riga si DERIVANO dalle viste del server (classe e
// motivi calcolati adesso, stato di «Annulla» per chi guarda).

const CONV = "cccccccc-0000-4000-8000-000000000001";
const PROPOSAL_B = "dddddddd-0000-4000-8000-0000000000b1";
const PROPOSAL_A = "dddddddd-0000-4000-8000-0000000000a1";
const GROUP_A = "eeeeeeee-0000-4000-8000-0000000000a1";
const MARTA = "55555555-5555-4555-8555-555555555555";

const session = {
  id: CONV,
  kind: "free",
  title: "Plan the week",
  projectId: null,
  projectName: null,
  ticketId: null,
  ticketNumber: null,
  startedAt: "2026-11-10T10:00:00.000Z",
  lastEventAt: "2026-11-10T10:05:00.000Z",
  state: "idle",
  canWrite: true,
  canIntervene: true,
  canInterrupt: false,
  canClose: false,
  questions: [],
  inputs: [],
};

const conversation = {
  id: CONV,
  title: "Plan the week",
  archived: false,
  context: null,
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:05:00.000Z",
  state: "idle",
  lastEventAt: "2026-11-10T10:05:00.000Z",
  session,
};

const events = [
  { id: "1", type: "input", segmentId: "s1", at: "2026-11-10T10:00:10.000Z", data: { inputId: "i1", text: "Give AUD-12 to Marta and rename it" } },
  { id: "2", type: "actions_executed", segmentId: "s1", at: "2026-11-10T10:00:40.000Z", data: { groupId: GROUP_A, proposalId: PROPOSAL_A } },
  { id: "3", type: "proposal", segmentId: "s1", at: "2026-11-10T10:00:50.000Z", data: { proposalId: PROPOSAL_B } },
  { id: "4", type: "assistant_text", segmentId: "s1", at: "2026-11-10T10:01:00.000Z", data: { text: "Renamed; I need your OK to assign it." } },
];

const proposals = [
  {
    id: PROPOSAL_A,
    sessionId: CONV,
    actions: [{ fn: "updateTask", args: { id: TICKET_ID, patch: { title: "Export the CSV report" } } }],
    summary: "",
    cls: "A",
    status: "confirmed",
    groupId: GROUP_A,
    createdAt: "2026-11-10T10:00:40.000Z",
  },
  {
    id: PROPOSAL_B,
    sessionId: CONV,
    actions: [{ fn: "updateTask", args: { id: TICKET_ID, patch: { assigneeId: MARTA } } }],
    summary: "Assign AUD-12 to Marta",
    cls: "B",
    reasons: [{ kind: "notifies", personIds: [MARTA], more: false }],
    status: "open",
    canConfirm: true,
    canCancel: true,
    createdAt: "2026-11-10T10:00:50.000Z",
  },
];

const groups = [
  {
    id: GROUP_A,
    sessionId: CONV,
    proposalId: PROPOSAL_A,
    actions: [{ fn: "updateTask", args: { id: TICKET_ID, patch: { title: "Export the CSV report" } }, codes: ["AUD-12"] }],
    executedAt: "2026-11-10T10:00:40.000Z",
    undo: "available",
  },
];

function install(routes: Record<string, unknown> = {}) {
  return installFakeServer({
    "GET /api/auth/me": { body: me({ projectPermissions: { [PROJECT_ID]: ["tickets.view_all", "tickets.edit"] } }) },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID, MARTA] })] },
    [`GET /api/agent-sessions/${CONV}`]: { body: session },
    [`GET /api/agent-sessions/${CONV}/events`]: { body: { events, before: null } },
    [`GET /api/claude/conversations/${CONV}`]: { body: conversation },
    [`GET /api/claude/conversations/${CONV}/proposals`]: { body: proposals },
    [`GET /api/claude/conversations/${CONV}/groups`]: { body: groups },
    [`GET /api/tickets/${TICKET_ID}`]: { body: serverTicketDetail() },
    "GET /api/people": {
      body: [
        { id: ME_ID, name: "Ada", initials: "AD", departmentIds: [], email: "ada@example.com" },
        { id: MARTA, name: "Marta Rinaldi", initials: "MR", departmentIds: [], email: "marta@example.com" },
      ],
    },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]);
}

beforeEach(() => {
  setAppClientForTests(null);
  forgetClaudeCaches();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("proposte e azioni di Claude nella conversazione", () => {
  it("una A eseguita è una riga «executed» col suo gruppo; una B in attesa è una scheda con la classe e i motivi del server", async () => {
    install();
    await getSessionPerson();
    const detail = (await getConversation(CONV))!;
    const types = detail.events.map((e) => e.type);
    expect(types).toEqual(["user", "executed", "proposal", "assistant"]);
    const executed = detail.events.find((e) => e.type === "executed")!;
    expect(executed).toMatchObject({
      type: "executed",
      groupId: GROUP_A,
      status: "done",
      resultCodes: ["AUD-12"],
      actions: [{ fn: "updateTask", args: { id: TICKET_ID } }],
    });
    const card = detail.events.find((e) => e.type === "proposal")!;
    expect(card).toMatchObject({
      type: "proposal",
      proposalId: PROPOSAL_B,
      requesterId: ME_ID,
      status: "open",
      cls: "B",
      reasons: [{ kind: "notifies", personIds: [MARTA], more: false }],
      actions: [{ fn: "updateTask" }],
    });
    // Il riassunto di ogni azione si legge dai dati (codice compreso), mai dal modello.
    expect((card as { actions: { summary: string }[] }).actions[0]!.summary).toContain("AUD-12");
    // I campi cambiati con le loro etichette, non le chiavi grezze dello schema.
    expect((card as { actions: { summary: string }[] }).actions[0]!.summary).toBe("Change AUD-12 (assignee)");
    // «Annulla» del gruppo: disponibile, come lo dice il server per chi guarda.
    expect(detail.undo?.[GROUP_A]).toEqual({ state: "available", needsReauth: false });
  });

  it("una B confermata: la scheda resta (confermata, col suo gruppo e i codici), nessuna riga in più", async () => {
    install({
      [`GET /api/agent-sessions/${CONV}/events`]: {
        body: {
          events: [
            ...events.slice(0, 3),
            { id: "5", type: "actions_executed", segmentId: "s1", at: "2026-11-10T10:02:00.000Z", data: { groupId: "eeeeeeee-0000-4000-8000-0000000000b2", proposalId: PROPOSAL_B } },
          ],
          before: null,
        },
      },
      [`GET /api/claude/conversations/${CONV}/proposals`]: {
        body: [proposals[0], { ...proposals[1], status: "confirmed", canConfirm: false, canCancel: false, groupId: "eeeeeeee-0000-4000-8000-0000000000b2" }],
      },
      [`GET /api/claude/conversations/${CONV}/groups`]: {
        body: [
          groups[0],
          {
            id: "eeeeeeee-0000-4000-8000-0000000000b2",
            sessionId: CONV,
            proposalId: PROPOSAL_B,
            actions: [{ fn: "updateTask", args: { id: TICKET_ID, patch: { assigneeId: MARTA } }, codes: ["AUD-12"] }],
            executedAt: "2026-11-10T10:02:00.000Z",
            undo: "changed_after",
            changedBy: MARTA,
          },
        ],
      },
    });
    await getSessionPerson();
    const detail = (await getConversation(CONV))!;
    expect(detail.events.map((e) => e.type)).toEqual(["user", "executed", "proposal"]);
    expect(detail.events.find((e) => e.type === "proposal")).toMatchObject({
      status: "confirmed",
      groupId: "eeeeeeee-0000-4000-8000-0000000000b2",
      resultCodes: ["AUD-12"],
    });
    expect(detail.undo?.["eeeeeeee-0000-4000-8000-0000000000b2"]).toEqual({ state: "changed_after", byName: "Marta Rinaldi", code: null });
  });

  it("un server senza le rotte (404): la conversazione si legge lo stesso, senza schede", async () => {
    install({
      [`GET /api/claude/conversations/${CONV}/proposals`]: { status: 404, body: { code: "not_found", message: "x" } },
      [`GET /api/claude/conversations/${CONV}/groups`]: { status: 404, body: { code: "not_found", message: "x" } },
    });
    await getSessionPerson();
    const detail = (await getConversation(CONV))!;
    expect(detail.events.map((e) => e.type)).toEqual(["user", "assistant"]);
  });
});

describe("«Undo» rifiutato dal server e il «Who?» (review F3.4)", () => {
  const refused = (failure: Record<string, unknown>) => ({
    status: 409,
    body: { code: "refused", message: "The undo was refused", failure: { index: 0, projectId: PROJECT_ID, message: "", ...failure } },
  });

  it("forbidden: il «Who?» viene dal permesso che il server dice mancare, non da una tabella del client", async () => {
    install({ [`POST /api/claude/groups/${GROUP_A}/undo`]: refused({ code: "forbidden", permission: "tickets.moderate" }) });
    await getSessionPerson();
    expect(await claudeChatNamespace.undoClaudeActions(CONV, GROUP_A)).toMatchObject({
      ok: false,
      error: "forbidden",
      whoAction: "moderateComments",
      projectId: PROJECT_ID,
    });
  });

  it("busy: occupato, col motivo; un altro rifiuto non si riprova all'infinito", async () => {
    install({ [`POST /api/claude/groups/${GROUP_A}/undo`]: refused({ code: "busy", permission: null }) });
    await getSessionPerson();
    expect(await claudeChatNamespace.undoClaudeActions(CONV, GROUP_A)).toMatchObject({ ok: false, error: "busy" });
    install({ [`POST /api/claude/groups/${GROUP_A}/undo`]: refused({ code: "invalid", permission: null }) });
    expect(await claudeChatNamespace.undoClaudeActions(CONV, GROUP_A)).toMatchObject({ ok: false, error: "not_undoable" });
  });

  it("changed_after dopo il clic: il nome di chi ha cambiato, dalla vista del gruppo (changedBy)", async () => {
    install({
      [`POST /api/claude/groups/${GROUP_A}/undo`]: { status: 409, body: { code: "changed_after", message: "changed_after" } },
      [`GET /api/claude/conversations/${CONV}/groups`]: { body: [{ ...groups[0], undo: "changed_after", changedBy: MARTA }] },
    });
    await getSessionPerson();
    expect(await claudeChatNamespace.undoClaudeActions(CONV, GROUP_A)).toEqual({
      ok: false,
      error: "changed_after",
      byName: "Marta Rinaldi",
      code: null,
    });
  });

  it("una scheda fallita per permesso: il «Who?» dal permesso del server", async () => {
    install({
      [`GET /api/claude/conversations/${CONV}/proposals`]: {
        body: [
          proposals[0],
          {
            ...proposals[1],
            status: "failed",
            canConfirm: false,
            canCancel: false,
            failure: { code: "forbidden", index: 0, permission: "tickets.create", projectId: PROJECT_ID, message: "" },
          },
        ],
      },
    });
    await getSessionPerson();
    const detail = (await getConversation(CONV))!;
    expect(detail.events.find((e) => e.type === "proposal")).toMatchObject({
      failure: { code: "forbidden", whoAction: "createTasks" },
    });
  });
});

describe("i codici delle task nelle schede (review F3.4)", () => {
  it("una task che non esiste più si legge una volta sola, non a ogni rilettura della conversazione", async () => {
    const GONE = "99999999-0000-4000-8000-0000000000aa";
    const { seen } = install({
      [`GET /api/claude/conversations/${CONV}/proposals`]: {
        body: [proposals[0], { ...proposals[1], actions: [{ fn: "updateTask", args: { id: GONE, patch: { title: "x" } } }] }],
      },
      [`GET /api/tickets/${GONE}`]: { status: 404, body: { code: "not_found", message: "x" } },
    });
    await getSessionPerson();
    await getConversation(CONV);
    await getConversation(CONV);
    expect(seen.filter((r) => r.path === `/api/tickets/${GONE}`)).toHaveLength(1);
  });
});
