import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetClaudeCaches, getConversation } from "./claude";
import { claudeChatNamespace, summaryOf } from "./claudeChatActions";
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

describe("setSubscription di Claude nella build app (area 8, F2, R5)", () => {
  const GROUP_S = "eeeeeeee-0000-4000-8000-0000000000c1";
  const PROPOSAL_S = "dddddddd-0000-4000-8000-0000000000c1";
  const PROPOSAL_SB = "dddddddd-0000-4000-8000-0000000000c2";
  const subEvents = [
    { id: "1", type: "input", segmentId: "s1", at: "2026-11-14T10:00:10.000Z", data: { inputId: "i1", text: "Stop the release alerts on my phone in AUD" } },
    { id: "2", type: "actions_executed", segmentId: "s1", at: "2026-11-14T10:00:40.000Z", data: { groupId: GROUP_S, proposalId: PROPOSAL_S } },
    { id: "3", type: "proposal", segmentId: "s1", at: "2026-11-14T10:00:50.000Z", data: { proposalId: PROPOSAL_SB } },
  ];
  const args = { projectId: PROJECT_ID, type: "release.failed", phone: false };
  const subRoutes = {
    [`GET /api/agent-sessions/${CONV}/events`]: { body: { events: subEvents, before: null } },
    [`GET /api/claude/conversations/${CONV}/proposals`]: {
      body: [
        { ...proposals[0], id: PROPOSAL_S, actions: [{ fn: "setSubscription", args }], groupId: GROUP_S },
        {
          ...proposals[1],
          id: PROPOSAL_SB,
          actions: [{ fn: "setSubscription", args: { projectId: PROJECT_ID, type: "server.trouble", app: true, phone: true } }],
          reasons: [],
        },
      ],
    },
    [`GET /api/claude/conversations/${CONV}/groups`]: {
      body: [{ ...groups[0], id: GROUP_S, proposalId: PROPOSAL_S, actions: [{ fn: "setSubscription", args, codes: [], effectFailure: null }] }],
    },
  };

  it("la riga eseguita ha il codice del progetto (dal projectId), come nel prototipo", async () => {
    install(subRoutes);
    await getSessionPerson();
    const detail = (await getConversation(CONV))!;
    const executed = detail.events.find((e) => e.type === "executed")!;
    expect(executed).toMatchObject({ groupId: GROUP_S, objectCodes: ["AUD"], actions: [{ fn: "setSubscription", args }] });
    expect(detail.undo?.[GROUP_S]).toEqual({ state: "available", needsReauth: false });
  });

  it("i progetti illeggibili non fermano la conversazione: la riga c'è, senza il codice", async () => {
    install({ ...subRoutes, "GET /api/projects": { status: 500, body: { code: "internal", message: "x" } } });
    await getSessionPerson();
    const detail = (await getConversation(CONV))!;
    const executed = detail.events.find((e) => e.type === "executed")!;
    expect(executed).toMatchObject({ groupId: GROUP_S, objectCodes: [null] });
  });

  it("il codice del progetto si legge dall'elenco, senza i membri di ogni progetto", async () => {
    const { seen } = install({ ...subRoutes, "GET /api/projects": { body: [serverProject()] } });
    await getSessionPerson();
    await getConversation(CONV);
    expect(seen.filter((r) => /\/members/.test(r.path))).toEqual([]);
  });

  it("il riassunto dagli argomenti: progetto, tipo con la sua etichetta, solo i valori presenti", async () => {
    install(subRoutes);
    await getSessionPerson();
    const detail = (await getConversation(CONV))!;
    const summaries = detail.events.flatMap((e) =>
      e.type === "executed" || e.type === "proposal" ? (e as { actions: { summary: string }[] }).actions.map((a) => a.summary) : [],
    );
    expect(summaries).toEqual([
      "Change your “Release failed” alerts in AUD: Phone off",
      "Change your “Server in trouble” alerts in AUD: App on, Phone on",
    ]);
  });
});

describe("un'azione che questa build non conosce (server più nuovo, area 8, F2, R5)", () => {
  it("la riga si legge lo stesso, con un riassunto generico e non con una chiave grezza", async () => {
    const GROUP_X = "eeeeeeee-0000-4000-8000-0000000000d1";
    install({
      [`GET /api/agent-sessions/${CONV}/events`]: {
        body: {
          events: [{ id: "2", type: "actions_executed", segmentId: "s1", at: "2026-11-14T10:00:40.000Z", data: { groupId: GROUP_X } }],
          before: null,
        },
      },
      [`GET /api/claude/conversations/${CONV}/proposals`]: { body: [] },
      [`GET /api/claude/conversations/${CONV}/groups`]: {
        body: [{ ...groups[0], id: GROUP_X, proposalId: null, actions: [{ fn: "aFutureAction", args: { projectId: PROJECT_ID }, codes: [] }] }],
      },
    });
    await getSessionPerson();
    const detail = (await getConversation(CONV))!;
    const executed = detail.events.find((e) => e.type === "executed") as { actions: { summary: string }[] } | undefined;
    expect(executed?.actions.map((a) => a.summary)).toEqual(["A change"]);
  });
});

describe("il riassunto di setSubscription senza canali (review F2, m3)", () => {
  it("senza app né phone (il server non lo manda, il client si difende) non finisce con «: »", () => {
    const args = { projectId: PROJECT_ID, type: "release.failed" };
    expect(summaryOf("setSubscription", args, "AUD").summary).toBe("Change your “Release failed” alerts in AUD");
    expect(summaryOf("setSubscription", args, null).summary).toBe("Change your “Release failed” alerts in a project");
  });
});

describe("resetSubscription, l'inverso di un setSubscription senza scelta salvata (review F2, 6)", () => {
  it("il riassunto dice il ritorno al default, col codice del progetto", () => {
    const args = { projectId: PROJECT_ID, type: "release.failed" };
    expect(summaryOf("resetSubscription", args, "AUD").summary).toBe(
      "Put your “Release failed” alerts in AUD back to the default",
    );
    expect(summaryOf("resetSubscription", args, null).summary).toBe(
      "Put your “Release failed” alerts in a project back to the default",
    );
  });
});
