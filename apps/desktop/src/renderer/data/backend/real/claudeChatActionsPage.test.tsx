import { newTaskBodySchema } from "@stubwise/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { resetStreamsForTests, setStreamTransport, type StreamHandlers } from "./claudeStream";
import { forgetClaudeCaches } from "./claude";
import { __forgetPageEventsForTest, __forgetStartedForTest } from "../../../layout/claudePanel/pageActions";
import {
  DEPT_ID,
  installFakeServer,
  me,
  ME_ID,
  PROJECT_ID,
  serverProject,
  serverTicketDetail,
  STATUS_TODO,
  TICKET_ID,
  type SeenRequest,
} from "./fakeServer";

// Le azioni di Claude nella pagina della conversazione, nella build app (chat,
// fetta 3, F3.4): la scheda di una B coi motivi del server, la conferma, la
// conferma di una parte, l'annullamento della scheda; la riga di una A col suo
// «Annulla». Il server finto risponde 404 a ogni rotta non dichiarata e il test
// non ammette chiamate fuori elenco.
vi.mock("@backend/api", async () => await import("./index"));

const CONV = "cccccccc-0000-4000-8000-000000000001";
const PROPOSAL = "dddddddd-0000-4000-8000-0000000000b1";
const GROUP_A = "eeeeeeee-0000-4000-8000-0000000000a1";
const MARTA = "55555555-5555-4555-8555-555555555555";
let seen: SeenRequest[] = [];

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

const cardB = (over: Record<string, unknown> = {}) => ({
  id: PROPOSAL,
  sessionId: CONV,
  actions: [
    { fn: "updateTask", args: { id: TICKET_ID, patch: { assigneeId: MARTA } } },
    { fn: "startRun", args: { taskId: TICKET_ID } },
  ],
  summary: "",
  cls: "B",
  reasons: [{ kind: "notifies", personIds: [MARTA], more: false }, { kind: "starts_work" }],
  status: "open",
  canConfirm: true,
  canCancel: true,
  createdAt: "2026-11-10T10:00:50.000Z",
  ...over,
});

const groupA = (over: Record<string, unknown> = {}) => ({
  id: GROUP_A,
  sessionId: CONV,
  proposalId: null,
  actions: [{ fn: "updateTask", args: { id: TICKET_ID, patch: { title: "Export the CSV" } }, codes: ["AUD-12"] }],
  executedAt: "2026-11-10T10:00:40.000Z",
  undo: "available",
  ...over,
});

const ALLOWED = [
  // Il punto della Chat sul binario (area 4, fetta 1).
  /^GET \/api\/chat\/(signal|channels)(\?|$)/,
  /^GET \/api\/auth\/me$/,
  /^GET \/api\/projects$/,
  /^GET \/api\/me\/follows$/,
  /^GET \/api\/decisions/,
  /^GET \/api\/me\/claude-decisions$/,
  /^GET \/api\/inbox/,
  // Area 6, fetta 2: le proposte della Posta in «Da decidere» (prima dalle card dell'inbox).
  /^GET \/api\/me\/mail\/proposals(\?|$)/,
  /^GET \/api\/people$/,
  /^GET \/api\/departments$/,
  /^GET \/api\/tasks(\?|$)/,
  /^GET \/api\/tickets\/[^/]+$/,
  /^GET \/api\/tasks\/by-code\/[^/]+$/,
  /^GET \/api\/projects\/[^/]+\/statuses$/,
  /^GET \/api\/milestones/,
  /^GET \/api\/agent-sessions(\?|$)/,
  /^GET \/api\/agent-sessions\/[^/]+(\/events.*)?$/,
  /^GET \/api\/agent-sessions\/[^/]+\/stream/,
  /^(GET|POST) \/api\/claude\/conversations(\?|$)/,
  /^GET \/api\/claude\/conversations\/status$/,
  /^GET \/api\/claude\/conversations\/[^/]+$/,
  /^GET \/api\/claude\/conversations\/[^/]+\/(proposals|groups)$/,
  /^POST \/api\/claude\/proposals\/[^/]+\/(confirm|cancel)$/,
  /^POST \/api\/claude\/groups\/[^/]+\/undo$/,
];
const outside = () => seen.filter((r) => !ALLOWED.some((re) => re.test(`${r.method} ${r.path}`)));

function install(over: { proposals?: unknown[]; groups?: unknown[]; routes?: Record<string, unknown> } = {}) {
  let proposals = over.proposals ?? [cardB()];
  seen = installFakeServer({
    "GET /api/auth/me": { body: me({ projectPermissions: { [PROJECT_ID]: ["tickets.view_all", "tickets.create", "tickets.edit", "runs.start"] } }) },
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
    "GET /api/tasks": { body: { items: [], truncated: false } },
    [`GET /api/tickets/${TICKET_ID}`]: { body: serverTicketDetail() },
    [`GET /api/projects/${PROJECT_ID}/statuses`]: {
      body: [{ id: STATUS_TODO, projectId: PROJECT_ID, name: "To do", family: "todo", position: 0 }],
    },
    "GET /api/milestones": { body: [] },
    "GET /api/agent-sessions": { body: { live: [], recent: [] } },
    "GET /api/claude/conversations/status": { body: { budgetExhausted: false } },
    "GET /api/claude/conversations": { body: { items: [conversation] } },
    [`GET /api/claude/conversations/${CONV}`]: { body: conversation },
    [`GET /api/claude/conversations/${CONV}/proposals`]: () => ({ body: proposals }),
    [`GET /api/claude/conversations/${CONV}/groups`]: { body: over.groups ?? [] },
    [`GET /api/agent-sessions/${CONV}`]: { body: session },
    [`GET /api/agent-sessions/${CONV}/events`]: {
      body: {
        events: [
          { id: "1", type: "input", segmentId: "s1", at: "2026-11-10T10:00:10.000Z", data: { inputId: "i1", text: "Give AUD-12 to Marta and start" } },
          ...(over.groups ? [{ id: "2", type: "actions_executed", segmentId: "s1", at: "2026-11-10T10:00:40.000Z", data: { groupId: GROUP_A } }] : []),
          ...(over.proposals?.length === 0 ? [] : [{ id: "3", type: "proposal", segmentId: "s1", at: "2026-11-10T10:00:50.000Z", data: { proposalId: PROPOSAL } }]),
          { id: "4", type: "assistant_text", segmentId: "s1", at: "2026-11-10T10:01:00.000Z", data: { text: "I need your OK." } },
        ],
        before: null,
      },
    },
    [`POST /api/claude/proposals/${PROPOSAL}/confirm`]: (req: SeenRequest) => {
      proposals = [cardB({ status: "confirmed", canConfirm: false, canCancel: false })];
      return { body: cardB({ status: "confirmed", canConfirm: false, canCancel: false, ...(req.body ? {} : {}) }) };
    },
    [`POST /api/claude/proposals/${PROPOSAL}/cancel`]: () => {
      proposals = [cardB({ status: "cancelled", canConfirm: false, canCancel: false })];
      return { body: proposals[0] };
    },
    ...over.routes,
  } as Parameters<typeof installFakeServer>[0]).seen;
}

beforeEach(() => {
  setAppClientForTests(null);
  resetStreamsForTests();
  __forgetStartedForTest();
  __forgetPageEventsForTest();
  document.documentElement.removeAttribute("data-theme");
  try {
    localStorage.clear();
  } catch {
    /* niente storage */
  }
  forgetClaudeCaches();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  setStreamTransport(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

const card = () => screen.findByRole("region", { name: /Claude proposes/ });

describe("le azioni di Claude nella pagina della conversazione", () => {
  describe("«fillMailBody» confermata (area 6, F3)", () => {
    const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
    const fill = { fn: "fillMailBody", args: { accountId: ACC, threadId: "t-1", mode: "reply", text: "Ciao Bob, arriva lunedì." } };
    const setup = (action: Record<string, unknown>) =>
      install({
        proposals: [
          cardB({ actions: [fill], reasons: [], status: "confirmed", canConfirm: false, canCancel: false, groupId: GROUP_A }),
        ],
        groups: [groupA({ proposalId: PROPOSAL, actions: [action] })],
        routes: {
          [`GET /api/agent-sessions/${CONV}/events`]: {
            body: {
              events: [
                { id: "1", type: "input", segmentId: "s1", at: "2026-11-10T10:00:10.000Z", data: { inputId: "i1", text: "Rispondi a Bob" } },
                { id: "3", type: "proposal", segmentId: "s1", at: "2026-11-10T10:00:50.000Z", data: { proposalId: PROPOSAL } },
                { id: "5", type: "actions_executed", segmentId: "s1", at: "2026-11-10T10:00:55.000Z", data: { groupId: GROUP_A, proposalId: PROPOSAL } },
              ],
              before: null,
            },
          },
        },
      });

    it("Gmail non l'ha salvata (`mail_not_saved`): la scheda non dice «Done» ma «Not saved to Gmail», e «Copy the text» copia il testo", async () => {
      setup({ ...fill, codes: [], effectFailure: "mail_not_saved" });
      // userEvent mette i suoi appunti: si rileggono da lì.
      const ue = userEvent.setup();
      renderRoute(`/claude/${CONV}`);
      const proposal = await card();
      await waitFor(() => expect(proposal).toHaveTextContent("Not saved to Gmail"));
      expect(proposal).not.toHaveTextContent(/\bDone\b/);
      expect(within(proposal).queryByRole("button", { name: /Retry/ })).toBeNull();
      await ue.click(within(proposal).getByRole("button", { name: "Copy the text" }));
      expect(await navigator.clipboard.readText()).toBe("Ciao Bob, arriva lunedì.");
      expect(await within(proposal).findByText("Copied")).toBeInTheDocument();
    });

    it("un server di prima, senza `effectFailure` nel gruppo: «Done» come ogni scheda confermata", async () => {
      // Fixture SENZA il campo, apposta: è la prova della difesa `?? null`.
      setup({ ...fill, codes: [] });
      renderRoute(`/claude/${CONV}`);
      const proposal = await card();
      await waitFor(() => expect(proposal).toHaveTextContent("Done"));
      expect(proposal).not.toHaveTextContent("Not saved to Gmail");
      expect(proposal).toHaveTextContent("Write the email body in your Gmail draft");
    });
  });

  it("una B: la scheda coi motivi del server, l'avvio del lavoro compreso; «Confirm» la conferma sul server", async () => {
    install();
    const ue = userEvent.setup();
    renderRoute(`/claude/${CONV}`);
    const proposal = await card();
    await waitFor(() => expect(proposal).toHaveTextContent("Notifies Marta Rinaldi"));
    expect(proposal).toHaveTextContent("Starts Claude's work: it can't be undone");
    expect(proposal).toHaveTextContent("AUD-12");
    await ue.click(within(proposal).getByRole("button", { name: /^Confirm all/ }));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST").map((r) => [r.path, r.body])).toEqual([
        [`/api/claude/proposals/${PROPOSAL}/confirm`, {}],
      ]),
    );
    expect(outside()).toEqual([]);
  });

  it("conferma di una parte: solo le azioni scelte vanno al server (selected)", async () => {
    install();
    const ue = userEvent.setup();
    renderRoute(`/claude/${CONV}`);
    const proposal = await card();
    const boxes = await within(proposal).findAllByRole("checkbox");
    await ue.click(boxes[1]!);
    await ue.click(within(proposal).getByRole("button", { name: /^Confirm 1 selected/ }));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([{ selected: [0] }]),
    );
  });

  it("scaduta (lo dice il server): nessun bottone, la frase della scadenza", async () => {
    install({ proposals: [cardB({ status: "expired", canConfirm: false, canCancel: false })] });
    renderRoute(`/claude/${CONV}`);
    const proposal = await card();
    await waitFor(() => expect(proposal).toHaveTextContent("Not carried out · expired"));
    expect(within(proposal).queryByRole("button", { name: /^Confirm/ })).toBeNull();
  });

  it("scaduta alla conferma (409 expired): la scheda si rilegge e dice la scadenza, senza bottoni", async () => {
    let expired = false;
    install({
      routes: {
        [`GET /api/claude/conversations/${CONV}/proposals`]: () => ({
          body: [expired ? cardB({ status: "expired", canConfirm: false, canCancel: false }) : cardB()],
        }),
        [`POST /api/claude/proposals/${PROPOSAL}/confirm`]: () => {
          expired = true;
          return { status: 409, body: { code: "expired", message: "x" } };
        },
      },
    });
    const ue = userEvent.setup();
    renderRoute(`/claude/${CONV}`);
    const proposal = await card();
    await ue.click(within(proposal).getByRole("button", { name: /^Confirm all/ }));
    // L'esito del clic, a vista: la conferma non è passata.
    expect(await screen.findByText("This proposal has expired: nothing was changed.")).toBeInTheDocument();
    await waitFor(async () => expect(await card()).toHaveTextContent("Not carried out · expired"));
    expect(within(await card()).queryByRole("button", { name: /^Confirm/ })).toBeNull();
  });

  it("«Edit» su una task proposta: il dialogo coi valori di Claude; salvare CONFERMA con edited, non crea a mano", async () => {
    install({
      proposals: [
        cardB({
          actions: [{ fn: "createTask", args: { projectId: PROJECT_ID, title: "Export the CSV", type: "activity", assigneeId: MARTA } }],
          reasons: [{ kind: "notifies", personIds: [MARTA], more: false }],
        }),
      ],
    });
    const ue = userEvent.setup();
    renderRoute(`/claude/${CONV}`);
    const proposal = await card();
    await ue.click(within(proposal).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    const title = within(dialog).getByLabelText("Title");
    expect(title).toHaveValue("Export the CSV");
    await ue.clear(title);
    await ue.type(title, "Export the CSV report");
    await ue.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(seen.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([`/api/claude/proposals/${PROPOSAL}/confirm`]));
    const body = seen.find((r) => r.method === "POST")!.body as { edited: { index: number; args: unknown }[] };
    expect(body.edited).toHaveLength(1);
    expect(body.edited[0]!.index).toBe(0);
    // Gli args devono passare lo schema VERO del server (`createTask` = `newTaskBodySchema`):
    // un `requestId: null` lo rompe, e la proposta finirebbe `failed`.
    const parsed = newTaskBodySchema.safeParse(body.edited[0]!.args);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data).toMatchObject({ projectId: PROJECT_ID, title: "Export the CSV report", assigneeId: MARTA });
    expect(outside()).toEqual([]);
  });

  it("«Edit»: mentre la conferma parte, «Create task» è spento (niente doppio invio)", async () => {
    let release: () => void = () => undefined;
    install({
      proposals: [
        cardB({
          actions: [{ fn: "createTask", args: { projectId: PROJECT_ID, title: "Export the CSV", type: "activity" } }],
          reasons: [],
        }),
      ],
      routes: {
        [`POST /api/claude/proposals/${PROPOSAL}/confirm`]: () =>
          new Promise((resolve) => {
            release = () => resolve({ body: cardB({ status: "confirmed", canConfirm: false, canCancel: false }) });
          }),
      },
    });
    const ue = userEvent.setup();
    renderRoute(`/claude/${CONV}`);
    const proposal = await card();
    await ue.click(within(proposal).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    const save = within(dialog).getByRole("button", { name: "Create task" });
    await ue.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    release();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  });

  it("«Edit» la cui conferma non riesce (failed dal server): il dialogo resta aperto e dice l'errore", async () => {
    install({
      proposals: [
        cardB({
          actions: [{ fn: "createTask", args: { projectId: PROJECT_ID, title: "Export the CSV", type: "activity" } }],
          reasons: [],
        }),
      ],
      routes: {
        [`POST /api/claude/proposals/${PROPOSAL}/confirm`]: () => ({
          body: cardB({ status: "failed", canConfirm: false, canCancel: false }),
        }),
      },
    });
    const ue = userEvent.setup();
    renderRoute(`/claude/${CONV}`);
    const proposal = await card();
    await ue.click(within(proposal).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await ue.click(within(dialog).getByRole("button", { name: "Create task" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't create the task");
    expect(screen.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
  });

  const pageProposal = () =>
    cardB({
      actions: [{ fn: "pageAction", args: { kind: "theme", to: "dark" } }],
      // Come il server: senza letture non fidate nasce chiusa (A, la esegue il renderer).
      cls: "A",
      status: "confirmed",
      reasons: [],
      canConfirm: false,
      canCancel: false,
    });

  it("dopo un contenuto non fidato l'azione della pagina è una scheda: la pagina non cambia finché non si conferma, poi una volta sola", async () => {
    let status = "open";
    const view = () =>
      cardB({
        actions: [{ fn: "pageAction", args: { kind: "theme", to: "dark" } }],
        reasons: [],
        status,
        canConfirm: status === "open",
        canCancel: status === "open",
      });
    const confirms: unknown[] = [];
    install({
      routes: {
        [`GET /api/claude/conversations/${CONV}/proposals`]: () => ({ body: [view()] }),
        // Il server la chiude e basta: nessun gruppo, nessun evento; l'azione la fa il renderer.
        [`POST /api/claude/proposals/${PROPOSAL}/confirm`]: (body: unknown) => {
          confirms.push(body);
          status = "confirmed";
          return { body: view() };
        },
      },
    });
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const themeWrites = () => writes.mock.calls.filter(([key]) => key === "stubwise.theme").length;
    const ue = userEvent.setup();
    renderRoute(`/claude/${CONV}`);
    const proposal = await card();
    // Aperta: la pagina non cambia da sola.
    await new Promise((r) => setTimeout(r, 100));
    expect(document.documentElement.dataset.theme).not.toBe("dark");
    expect(themeWrites()).toBe(0);
    await ue.click(within(proposal).getByRole("button", { name: /^Confirm/ }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(confirms).toHaveLength(1);
    // Altri render e riletture: non si riapplica.
    await new Promise((r) => setTimeout(r, 300));
    expect(themeWrites()).toBe(1);
    writes.mockRestore();
  });

  it("un'azione della pagina letta dalla storia (D3) NON riparte: la riga dice «non applicata» col gesto per rifarla", async () => {
    install({ proposals: [pageProposal()] });
    const ue = userEvent.setup();
    renderRoute(`/claude/${CONV}`);
    const row = await screen.findByText(/Not applied in this window/);
    expect(row).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).not.toBe("dark");
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    // Il gesto: la applica adesso, e da lì «Undo» come una partita dal vivo.
    await ue.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("button", { name: /^Undo/ })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(seen.filter((r) => r.method === "POST")).toEqual([]);
    expect(outside()).toEqual([]);
  });

  it("un'azione della pagina arrivata DAL VIVO nello stream di questa vista parte da sola, con «Undo» locale", async () => {
    let handlers: StreamHandlers | null = null;
    setStreamTransport((_path, h) => {
      handlers = h;
      return () => undefined;
    });
    let proposals: unknown[] = [];
    const history: unknown[] = [
      { id: "1", type: "input", segmentId: "s1", at: "2026-11-10T10:00:10.000Z", data: { inputId: "i1", text: "Dark theme please" } },
      { id: "4", type: "assistant_text", segmentId: "s1", at: "2026-11-10T10:01:00.000Z", data: { text: "I need your OK." } },
    ];
    install({
      proposals: [],
      routes: {
        [`GET /api/claude/conversations/${CONV}/proposals`]: () => ({ body: proposals }),
        [`GET /api/agent-sessions/${CONV}/events`]: () => ({ body: { events: history, before: null } }),
      },
    });
    renderRoute(`/claude/${CONV}`);
    expect(await screen.findByText("I need your OK.")).toBeInTheDocument();
    await waitFor(() => expect(handlers).not.toBeNull());
    proposals = [pageProposal()];
    const live = { id: "9", type: "proposal", segmentId: "s2", at: "2026-11-10T10:02:00.000Z", data: { proposalId: PROPOSAL } };
    // Il server ora ha l'evento anche nella storia (la lettura dopo lo stream lo trova).
    history.push(live);
    handlers!.onFrame({
      messages: [{ type: "session", detail: session }, { type: "events", events: [live] }],
      lastId: "9",
      real: true,
      invalidSession: false,
    } as never);
    // La riga arriva con la rilettura del dettaglio dopo lo stream.
    expect(await screen.findByRole("button", { name: /^Undo/ }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(/Not applied in this window/)).toBeNull();
    expect(seen.filter((r) => r.method === "POST")).toEqual([]);
  });

  it("«Cancel» annulla la scheda sul server; niente si esegue", async () => {
    install();
    const ue = userEvent.setup();
    renderRoute(`/claude/${CONV}`);
    const proposal = await card();
    await ue.click(within(proposal).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([`/api/claude/proposals/${PROPOSAL}/cancel`]),
    );
    expect(outside()).toEqual([]);
  });

  it("una A eseguita: la riga col suo «Undo», che chiama il server", async () => {
    install({
      proposals: [],
      groups: [groupA()],
      routes: { [`POST /api/claude/groups/${GROUP_A}/undo`]: { body: { kind: "undone" } } },
    });
    const ue = userEvent.setup();
    renderRoute(`/claude/${CONV}`);
    const undo = await screen.findByRole("button", { name: /^Undo/ });
    await ue.click(undo);
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([`/api/claude/groups/${GROUP_A}/undo`]),
    );
    expect(outside()).toEqual([]);
  });
});
