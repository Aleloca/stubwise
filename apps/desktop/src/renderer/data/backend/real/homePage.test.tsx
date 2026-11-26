import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUndoWindow } from "../../../pages/home/pendingAnswers";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import {
  calendarRangeRoute,
  DEPT_ID,
  installFakeServer,
  me,
  ME_ID,
  PROJECT_ID,
  serverProject,
  serverTask,
  TICKET_ID,
  type SeenRequest,
} from "./fakeServer";

// La Home a blocchi sulla build app vera, davanti a un server finto
// (integrazione area 2, fetta 3, Task L): la Home del reparto viene dal
// server, un filtro eliminato resta come blocco «non disponibile» e i blocchi
// delle aree non integrate non si mostrano.
vi.mock("@backend/api", async () => await import("./index"));
// Un blocco di un'area spenta: nella build ogni blocco della Home è ormai
// integrato, quindi il test spegne da sé un'area (`hiddenArea`) per provare
// che personalizzare non cancella un blocco nascosto (review M4).
const hidden = vi.hoisted(() => ({ area: null as string | null }));
vi.mock("../../integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integration")>();
  return {
    ...actual,
    isIntegrated: (t: Parameters<typeof actual.isIntegrated>[0]) =>
      !(t.kind === "feature" && t.name === hidden.area) && actual.isIntegrated(t),
    featureIntegrated: (name: string) => name !== hidden.area && actual.featureIntegrated(name),
  };
});

const GONE = "88888888-8888-4888-8888-888888888888";

/** La Home personale che il server ha (null = nessuna), e i corpi dei salvataggi. */
let personalBlocks: { kind: string; filterId?: string }[] | null = null;
let savedBodies: unknown[] = [];
/** Le voci di Claude in «Da decidere» (fetta 3b) e le richieste viste. */
let claudeDecisions: unknown[] = [];
/** Area 4, fetta 2: le domande della Chat a chi guarda. */
let chatQuestions: unknown[] = [];
/** Area 4, fetta 3: le domande di @Claude a chi l'ha chiamato. */
let chatClaudeQuestions: unknown[] = [];
/** Un server della sola fetta 1: le rotte delle domande non ci sono (404). */
let chatQuestionsMissing = false;
let seen: SeenRequest[] = [];
/** Area 6, fetta 1: le caselle Google e gli appuntamenti visti. */
let googleAccounts: unknown[] = [];
let calendarItems: unknown[] = [];
let importantThreads: unknown[] = [];
/** Area 8: le righe di «Clienti in attesa». */
let waitingItems: unknown[] = [];
/** Lotto 7, A7: le automazioni viste e le esecuzioni che mi riguardano. */
let automationRows: unknown[] = [];
let myAutomationRuns: unknown[] = [];
const AUTOMATION_ROWS: unknown[] = [
  {
    id: "77777777-7777-4777-8777-777777777771",
    code: "AUD-A1",
    name: "Avvio progetto",
    description: "",
    projectId: PROJECT_ID,
    ownerId: ME_ID,
    status: "active",
    versions: [],
    createdAt: "2026-11-01T09:00:00.000Z",
    createdById: ME_ID,
    permissions: { manage: true },
    openRuns: 1,
    waitingRuns: 1,
    lastRunAt: "2026-11-20T09:00:00.000Z",
    hasDraft: false,
    configErrorCount: 0,
    liveErrorCount: 0,
  },
];
const MY_RUNS: unknown[] = [
  {
    id: "77777777-7777-4777-8777-777777777779",
    automationId: "77777777-7777-4777-8777-777777777771",
    n: 3,
    code: "AUD-A1 #3",
    title: "Kickoff for Acme",
    status: "waiting",
    startedAt: "2026-11-20T09:00:00.000Z",
    endedAt: null,
    automationCode: "AUD-A1",
    automationName: "Avvio progetto",
    automationProjectId: PROJECT_ID,
    log: [],
    concern: "waiting_me",
  },
];

beforeEach(() => {
  hidden.area = null;
  automationRows = [];
  myAutomationRuns = [];
  waitingItems = [];
  googleAccounts = [];
  calendarItems = [];
  importantThreads = [];
  chatQuestions = [];
  chatClaudeQuestions = [];
  chatQuestionsMissing = false;
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  personalBlocks = null;
  savedBodies = [];
  claudeDecisions = [];
  const meHome = () => ({
    blocks: personalBlocks ?? [],
    departmentChanged: [],
    newBlocks: [],
    departmentIds: [DEPT_ID],
    departmentHomes: [
      {
        departmentId: DEPT_ID,
        blocks: [
          { kind: "decide" },
          { kind: "myWeek" },
          { kind: "waitingCustomers" },
          { kind: "myTasks" },
          { kind: "filter", filterId: GONE },
        ],
        updatedAt: "2026-11-01T09:00:00.000Z",
      },
    ],
    personal: personalBlocks ? { blocks: personalBlocks, seenDepartmentUpdates: {} } : null,
  });
  seen = installFakeServer({
    "GET /api/me/claude-decisions": () => ({ body: claudeDecisions }),
    "GET /api/automations": () => ({ body: { items: automationRows } }),
    "GET /api/me/automation-runs": () => ({ body: { items: myAutomationRuns } }),
    // Area 6, fetta 1: «Prossimi appuntamenti» dal Calendario in lettura.
    "GET /api/me/google/accounts": () => ({ body: googleAccounts }),
    "GET /api/me/calendar/range": (req: SeenRequest) => calendarRangeRoute(calendarItems)(req),
    // Area 6, fetta 2: «Posta importante» (`important: true`).
    "GET /api/me/mail/threads": () => ({ body: { items: importantThreads, nextCursor: null } }),
    // Area 6, fetta 2: le proposte della Posta in «Da decidere».
    "GET /api/me/mail/proposals": { body: { items: [] } },
    // Area 8: «Clienti in attesa» dalla posta (72, W2).
    "GET /api/me/waiting-customers": () => ({
      body: { items: waitingItems, total: waitingItems.length },
    }),
    // Area 4, fetta 2: le domande della Chat in «Da decidere».
    "GET /api/chat/questions": () =>
      chatQuestionsMissing
        ? { status: 404, body: { code: "not_found", message: "x" } }
        : { body: { items: chatQuestions } },
    "GET /api/chat/claude-questions": () =>
      chatQuestionsMissing
        ? { status: 404, body: { code: "not_found", message: "x" } }
        : { body: { items: chatClaudeQuestions } },
    "POST /api/chat/messages/7f1c2a1e-0000-4000-8000-0000000000d2/claude/answer": () => {
      chatClaudeQuestions = [];
      return {
        body: {
          id: "7f1c2a1e-0000-4000-8000-0000000000d2",
          channelId: "7f1c2a1e-0000-4000-8000-0000000000c1",
          text: "",
          createdAt: "2026-11-10T10:00:05.000Z",
        },
      };
    },
    "GET /api/chat/channels": { body: { items: [] } },
    [`POST /api/tickets/${TICKET_ID}/approve-plan`]: {
      status: 202,
      body: { jobId: "bbbbbbbb-0000-4000-8000-000000000001" },
    },
    "GET /api/auth/me": { body: me() },
    "PUT /api/me/home": (req) => {
      savedBodies.push(req.body);
      personalBlocks = (req.body as { blocks: { kind: string }[] }).blocks;
      return { body: meHome() };
    },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
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
      ],
    },
    "GET /api/departments": {
      body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }],
    },
    // La Home la danno /api/me/home: una lettura per reparto non serve, e se fallisce non rompe niente.
    [`GET /api/departments/${DEPT_ID}/home`]: {
      status: 500,
      body: { code: "internal", message: "x" },
    },
    "GET /api/me/home": () => ({ body: meHome() }),
    "GET /api/departments/roles": { body: [] },
    "GET /api/filters": { body: [] },
    [`GET /api/filters/${GONE}`]: { status: 404, body: { code: "not_found", message: "x" } },
    "GET /api/me/pinned-filters": { body: [] },
    "GET /api/tasks": { body: { items: [serverTask({ assigneeId: ME_ID })], truncated: false } },
    "GET /api/tasks/stalled": { body: [] },
    "GET /api/me/day-arrangements": { body: [] },
    "GET /api/milestones": { body: [] },
    "GET /api/requests/to-convert": {
      body: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          code: "AUD-R4",
          projectId: PROJECT_ID,
          title: "Export to CSV",
          status: "new",
          urgency: "medium",
          requesterIds: [ME_ID],
          requestCount: 1,
          createdAt: "2026-11-01T09:00:00.000Z",
          webHref: "https://stubwise.example/backlog/33333333-3333-4333-8333-333333333333",
        },
      ],
    },
  }).seen;
});

afterEach(() => {
  vi.useRealTimers();
  setUndoWindow(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("la Home nella build app", () => {
  it("la Home del reparto dal server; il filtro eliminato è «non disponibile»; i clienti in attesa (area 8) dalla posta", async () => {
    renderRoute("/home");
    const tasks = await screen.findByRole("region", { name: /^My tasks/ });
    expect(await within(tasks).findByText("Export the report")).toBeInTheDocument();
    expect(await screen.findByText("This filter is no longer available")).toBeInTheDocument();
    const waiting = await screen.findByRole("region", { name: /^Customers waiting/ });
    expect(await within(waiting).findByText("No customer is waiting")).toBeInTheDocument();
    expect(seen.some((r) => r.path.startsWith("/api/me/waiting-customers"))).toBe(true);
  });

  it("review C1: un clic su «Clienti in attesa» apre il thread della SUA casella (`<accountId>_<gmailId>`)", async () => {
    const account = "aaaaaaaa-2222-4222-8222-222222222222";
    personalBlocks = [{ kind: "waitingCustomers" }, { kind: "myTasks" }];
    waitingItems = [
      {
        threadId: "18c0ffee",
        accountId: account,
        accountEmail: "ada@acme.test",
        customer: { name: "Anna Verdi", email: "anna@cliente.test" },
        subject: "Fattura di ottobre",
        project: { id: "33333333-3333-4333-8333-333333333333", code: "AUD", name: "Audin" },
        waitingSince: "2026-11-13T10:00:00.000Z",
        judgment: "yes",
        reason: "Asks for the invoice.",
      },
    ];
    const router = renderRoute("/home");
    const block = await screen.findByRole("region", { name: /^Customers waiting/ });
    const link = await within(block).findByRole("link", { name: /Anna Verdi/ });
    fireEvent.click(link);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/mail/${account}_18c0ffee`),
    );
  });

  it("«Da decidere»: una domanda della Chat a chi guarda, dal server (area 4, fetta 2)", async () => {
    chatQuestions = [
      {
        id: "chat:7f1c2a1e-0000-4000-8000-0000000000d1",
        channelId: "7f1c2a1e-0000-4000-8000-0000000000c1",
        messageId: "7f1c2a1e-0000-4000-8000-0000000000d1",
        rootId: "7f1c2a1e-0000-4000-8000-0000000000d1",
        askedById: null,
        text: "Can you review the PDF export?",
        createdAt: "2026-11-10T10:00:00.000Z",
      },
    ];
    renderRoute("/home");
    const decide = await screen.findByRole("region", { name: /^Decide/ });
    expect(await within(decide).findByText(/Can you review the PDF export\?/)).toBeInTheDocument();
  });

  it("«Da decidere»: la domanda di @Claude a chi l'ha chiamato, e la risposta da lì (area 4, fetta 3)", async () => {
    chatClaudeQuestions = [
      {
        id: "chat-claude:7f1c2a1e-0000-4000-8000-0000000000d2:7f1c2a1e-0000-4000-8000-0000000000f3",
        channelId: "7f1c2a1e-0000-4000-8000-0000000000c1",
        messageId: "7f1c2a1e-0000-4000-8000-0000000000d2",
        rootId: "7f1c2a1e-0000-4000-8000-0000000000d1",
        questionId: "7f1c2a1e-0000-4000-8000-0000000000f3",
        text: "Which format first?",
        options: [{ label: "PDF" }, { label: "CSV" }],
        createdAt: "2026-11-10T10:00:06.000Z",
      },
    ];
    // La finestra di «Annulla» della Home: qui la risposta parte subito.
    setUndoWindow(0);
    renderRoute("/home");
    const decide = await screen.findByRole("region", { name: /^Decide/ });
    expect(await within(decide).findByText(/Which format first\?/)).toBeInTheDocument();
    fireEvent.click(within(decide).getByRole("button", { name: /PDF/ }));
    await waitFor(() =>
      expect(
        seen
          .filter((r) => r.method === "POST" && r.path.endsWith("/claude/answer"))
          .map((r) => r.body),
      ).toEqual([
        { questionId: "7f1c2a1e-0000-4000-8000-0000000000f3", optionIndex: 0, text: null },
      ]),
    );
  });

  it("«Da decidere» con un server della sola fetta 1 (404 sulle domande della Chat): il blocco c'è, col resto", async () => {
    chatQuestionsMissing = true;
    renderRoute("/home");
    const decide = await screen.findByRole("region", { name: /^Decide/ });
    expect(await within(decide).findByText("AUD-R4")).toBeInTheDocument();
  });

  it("«Da decidere»: una richiesta da trasformare apre il suo pannello in Requests (fetta 4)", async () => {
    const open = vi.fn();
    window.open = open as never;
    const router = renderRoute("/home");
    const decide = await screen.findByRole("region", { name: /^Decide/ });
    expect(await within(decide).findByText("AUD-R4")).toBeInTheDocument();
    expect(
      within(decide).getByRole("button", { name: "Turn into task: Export to CSV" }),
    ).toBeInTheDocument();
    fireEvent.click(within(decide).getByRole("link", { name: "Open request Export to CSV" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/AUD/requests"));
    expect(router.state.location.search).toMatchObject({
      request: "33333333-3333-4333-8333-333333333333",
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("«Da decidere»: il piano di Claude dal server; «Approve» lo approva sul ticket (fetta 3b)", async () => {
    claudeDecisions = [
      {
        id: "bbbbbbbb-0000-4000-8000-000000000001:plan",
        kind: "plan",
        conversationId: "aaaaaaaa-0000-4000-8000-000000000001",
        title: "Export the report",
        ownerId: ME_ID,
        projectId: PROJECT_ID,
        taskId: TICKET_ID,
        objectCode: "AUD-12",
        at: "2026-11-01T09:00:00.000Z",
        planId: "bbbbbbbb-0000-4000-8000-000000000001",
        summary: "Add the CSV export",
        planDigest: "sha256:mostrato",
        webHref: "/tickets/x",
      },
    ];
    setUndoWindow(0);
    renderRoute("/home");
    const decide = await screen.findByRole("region", { name: /^Decide/ });
    expect(await within(decide).findByText(/Add the CSV export/)).toBeInTheDocument();
    fireEvent.click(within(decide).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(
        seen.some(
          (r) => r.method === "POST" && r.path === `/api/tickets/${TICKET_ID}/approve-plan`,
        ),
      ).toBe(true),
    );
    // Il digest del piano della voce che si è approvata (review dell'area 3, punto 13).
    expect(seen.find((r) => r.path === `/api/tickets/${TICKET_ID}/approve-plan`)?.body).toEqual({
      planDigest: "sha256:mostrato",
    });
  });

  // Lotto 7, A7 (registro: «Blocco della Home delle automazioni»): il blocco
  // nella build app, sulle rotte dell'area 7 (`/api/me/automation-runs`).
  it("«Automations»: le esecuzioni che mi riguardano, dal server", async () => {
    personalBlocks = [{ kind: "automations" }];
    automationRows = AUTOMATION_ROWS;
    myAutomationRuns = MY_RUNS;
    renderRoute("/home");
    const block = await screen.findByRole("region", { name: /^Automations/ });
    expect(await within(block).findByText(/AUD-A1 #3/)).toBeInTheDocument();
    expect(seen.some((r) => r.path.startsWith("/api/me/automation-runs"))).toBe(true);
  });

  it("personalizzare dall'app non cancella un blocco di un'area spenta né un kind sconosciuto", async () => {
    // L'area di «Clienti in attesa» spenta per questo test: il blocco è nascosto.
    hidden.area = "mail-waiting";
    personalBlocks = [
      { kind: "decide" },
      { kind: "myWeek" },
      { kind: "waitingCustomers" },
      { kind: "__future__" },
      { kind: "myTasks" },
    ];
    renderRoute("/home");
    await screen.findByRole("region", { name: /^My tasks/ });
    fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
    const list = await screen.findByRole("list", { name: "Blocks of the Home" });
    // L'editor non elenca ciò che questa build non mostra.
    expect(within(list).queryByText("Customers waiting")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add block" }));
    const menu = await screen.findByRole("menu", { name: "Add block" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Stalled in my projects/ }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies[0]).toEqual({
      blocks: [
        { kind: "decide" },
        { kind: "myWeek" },
        { kind: "waitingCustomers" },
        { kind: "__future__" },
        { kind: "myTasks" },
        { kind: "stalledInMyProjects" },
      ],
    });
  });

  it("«Prossimi appuntamenti»: l'appuntamento di oggi dal Calendario vero (area 6, fetta 1)", async () => {
    // L'oggi della Home (`@backend/clock` del prototipo, nei test) e quello del livello dati coincidono.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    personalBlocks = [{ kind: "upcomingEvents" }, { kind: "myTasks" }];
    googleAccounts = [
      {
        id: "aaaaaaaa-1111-4111-8111-111111111111",
        email: "ada@acme.test",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        workspaceName: "Acme",
        scopes: [],
        proposalsEnabled: true,
        connectedAt: "2026-10-01T09:00:00.000Z",
        lastSyncAt: "2026-10-23T11:59:00.000Z",
        disabledAt: null,
        disabledReason: null,
        missingScopes: [],
      },
    ];
    calendarItems = [
      {
        id: "eeeeeeee-1111-4111-8111-111111111111",
        accountId: "aaaaaaaa-1111-4111-8111-111111111111",
        accountEmail: "ada@acme.test",
        projectId: null,
        title: "Sprint review",
        organizer: "ada@acme.test",
        startsAt: "2026-10-23T15:00:00.000Z",
        endsAt: "2026-10-23T16:00:00.000Z",
        status: "proposed",
      },
    ];
    renderRoute("/home");
    const upcoming = await screen.findByRole("region", { name: /^Upcoming/ });
    expect(await within(upcoming).findByText(/Sprint review/)).toBeInTheDocument();
  });

  it("F3b (review, 4): un fuori ufficio in corso che finisce un altro giorno dice giorno e ora, e la parola del tipo", async () => {
    // L'oggi della Home (`@backend/clock` del prototipo, nei test) e quello del livello dati coincidono.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    personalBlocks = [{ kind: "upcomingEvents" }, { kind: "myTasks" }];
    googleAccounts = [
      {
        id: "aaaaaaaa-1111-4111-8111-111111111111",
        email: "ada@acme.test",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        workspaceName: "Acme",
        scopes: [],
        proposalsEnabled: true,
        connectedAt: "2026-10-01T09:00:00.000Z",
        lastSyncAt: "2026-10-23T11:59:00.000Z",
        disabledAt: null,
        disabledReason: null,
        missingScopes: [],
      },
    ];
    calendarItems = [
      {
        id: "eeeeeeee-1111-4111-8111-111111111111",
        accountId: "aaaaaaaa-1111-4111-8111-111111111111",
        accountEmail: "ada@acme.test",
        projectId: null,
        title: "Ferie a Lisbona",
        organizer: "ada@acme.test",
        startsAt: "2026-10-23T08:00:00.000Z",
        endsAt: "2026-10-25T18:00:00.000Z",
        eventType: "outOfOffice",
        status: "proposed",
      },
    ];
    renderRoute("/home");
    const upcoming = await screen.findByRole("region", { name: /^Upcoming/ });
    const row = (await within(upcoming).findByText(/Ferie a Lisbona/)).closest(
      "[data-upcoming-event]",
    )!;
    const weekday = new Intl.DateTimeFormat("en", { weekday: "short" }).format(
      new Date("2026-10-25T18:00:00.000Z"),
    );
    expect(row.textContent).toContain(weekday);
    expect(row.textContent).toContain("Out of office");
  });

  it("«Posta importante»: le conversazioni con un messaggio alto non letto (area 6, fetta 2)", async () => {
    personalBlocks = [{ kind: "importantMail" }, { kind: "myTasks" }];
    googleAccounts = [
      {
        id: "aaaaaaaa-1111-4111-8111-111111111111",
        email: "ada@acme.test",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        workspaceName: "Acme",
        scopes: [],
        proposalsEnabled: true,
        connectedAt: "2026-10-01T09:00:00.000Z",
        lastSyncAt: "2026-10-23T11:59:00.000Z",
        disabledAt: null,
        disabledReason: null,
        missingScopes: [],
      },
    ];
    importantThreads = [
      {
        threadId: "t-1",
        accountId: "aaaaaaaa-1111-4111-8111-111111111111",
        accountEmail: "ada@acme.test",
        subject: "Contratto da firmare",
        lastFrom: "Bob Rossi <bob@client.test>",
        lastReceivedAt: "2026-10-23T09:00:00.000Z",
        unread: true,
        importance: "high",
      },
    ];
    renderRoute("/home");
    const block = await screen.findByRole("region", { name: /^Important email/ });
    expect(await within(block).findByText(/Contratto da firmare/)).toBeInTheDocument();
    expect(
      new URLSearchParams(
        seen.find((r) => r.path.startsWith("/api/me/mail/threads"))!.path.split("?")[1],
      ).get("important"),
    ).toBe("true");
  });
});
