import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import NetInfo from "@react-native-community/netinfo";
import { Linking } from "react-native";
import * as Keychain from "react-native-keychain";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import "../i18n";
import { AppProviders, queryClient } from "./providers";
import { navigationRef, RootNavigator } from "./navigation";
import { setPendingDeepLink } from "./linking";
import { AgentSessionStreamContext } from "../lib/agent-session-view";
import { FakeXhr } from "../test-utils/fake-xhr";
import { WISEY_TAB_ICON } from "./wisey-tab-icon";

const successUser = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "giulia@farmakom.it",
  role: "member",
  language: "it",
  avatarUrl: null,
  slackUserId: null,
};

const HUB_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const BACKLOG_ITEM_ID = "22222222-2222-4222-8222-222222222222";

const BACKLOG_ITEM_LIST_ROW = {
  id: BACKLOG_ITEM_ID,
  projectId: HUB_PROJECT_ID,
  title: "Accesso clienti con SSO",
  status: "ready",
  effort: 4,
  risk: "medium",
  riskNote: null,
  urgency: "high",
  requestCount: 1,
  source: "manual",
  similarTo: null,
  ticketCount: 0,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const BACKLOG_ITEM_DETAIL = {
  ...BACKLOG_ITEM_LIST_ROW,
  document: "I clienti enterprise chiedono il login SSO.",
  implementationPlan: null,
  originContent: null,
  suggested: null,
  tickets: [],
  messages: [],
  deepDivePending: false,
  codeSession: null,
  pendingTurn: false,
};

const HUB_NOTIFICATION_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Il ticket col piano da approvare del test sul SINTOMO (23 set 2026, «l'app
 * non resta indietro»). Finché il piano non è approvato il polso lo mette
 * sotto «aspetta te»; dal momento dell'approvazione il server finto smette —
 * come farebbe quello vero.
 */
const PLAN_TICKET_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PLAN_JOB_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PLAN_NOTIFICATION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
let planAwaitingApproval = false;
/** Quante volte il polso è stato chiesto al server: il test del ritorno le conta. */
let pulseCalls = 0;

const PLAN_TICKET = {
  id: PLAN_TICKET_ID,
  projectId: "11111111-1111-4111-8111-111111111111",
  number: 27,
  title: "Export CSV degli ordini",
  body: "Aggiunge l'esportazione CSV degli ordini.",
  type: "feature",
  priority: "medium",
  status: "in_progress",
  source: "manual",
  assigneeId: null,
  milestoneId: null,
  effort: 3,
  labels: [],
  technicalPayload: null,
  occurrences: 1,
  lastSeenAt: "2026-09-20T09:00:00.000Z",
  createdAt: "2026-09-20T09:00:00.000Z",
  updatedAt: "2026-09-20T09:00:00.000Z",
  implementationPlan: "1. Aggiungere l'export.",
  originContent: null,
  repositories: [],
};

function planJob() {
  return {
    id: PLAN_JOB_ID,
    ticketId: PLAN_TICKET_ID,
    status: planAwaitingApproval ? "awaiting_plan_approval" : "fixing",
    log: "",
    prUrl: null,
    error: null,
    createdAt: "2026-09-20T09:05:00.000Z",
    startedAt: null,
    finishedAt: null,
    providerLabel: null,
    providerKind: null,
    requestedByUserId: null,
  };
}

/** Il polso, ricostruito a ogni richiesta dallo stato del server finto. */
function hubPulse() {
  return HUB_PULSE.map((row) => ({
    ...row,
    waitingForYou: planAwaitingApproval
      ? [
          {
            kind: "plan_approval",
            ticketId: PLAN_TICKET_ID,
            ticketNumber: 27,
            title: "Export CSV degli ordini",
            notificationId: PLAN_NOTIFICATION_ID,
          },
        ]
      : [],
  }));
}

/** Il polso del progetto dell'hub: i secchi vuoti, serve solo il nome. */
const HUB_PULSE = [
  {
    projectId: HUB_PROJECT_ID,
    projectName: "Portale B2B",
    waitingForYou: [],
    waitingForOthers: [],
    running: [],
    failedCount: 0,
    backlogReadyCount: 1,
    idleDays: 0,
    stalled: [],
    waitingForMerge: [],
    lastReportDate: null,
  },
];

function hubNotification(id: string) {
  return {
    id,
    kind: "review.completed",
    status: "open",
    text: `Review finita su PR #${id.slice(0, 2)}`,
    actions: ["handled"],
    projectId: HUB_PROJECT_ID,
    ticketId: null,
    jobId: null,
    createdAt: "2026-09-02T09:48:00.000Z",
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
    reviewOutcome: null,
  };
}

/**
 * Quante notifiche aperte ha il progetto dell'hub. È MUTABILE apposta: il
 * test più sotto preme «Fatto» su una card e il server, dal giro seguente,
 * ne conta una in meno — è l'unico modo perché la schermata possa mostrare
 * un numero DIVERSO, cioè perché l'asserzione significhi qualcosa.
 */
let hubOpenNotifications = 2;

/**
 * La DOMANDA dell'agente in inbox (piano C, Task 8): sul job del piano, così
 * la ricerca della sessione (`?aiJobId=`) trova `AGENT_SESSION_SUMMARY`.
 * `inboxItems` è vuota di default; `agentSessionsAvailable` a `false` simula un
 * server senza le rotte (404 senza `code`, Review Focus 5).
 */
const QUESTION_NOTIFICATION_ID = "56565656-5656-4565-8565-565656565656";
function questionNotification() {
  return {
    id: QUESTION_NOTIFICATION_ID,
    kind: "job.awaiting_input",
    status: "open",
    text: "L'agente chiede: esporto anche gli ordini annullati?",
    actions: ["answer", "open", "snooze"],
    projectId: null,
    ticketId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    jobId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    createdAt: "2026-10-09T08:02:00.000Z",
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
    reviewOutcome: null,
    question: {
      questionId: "57575757-5757-4575-8575-575757575757",
      round: 1,
      question: "Esporto anche gli ordini annullati?",
      options: [{ label: "Sì" }, { label: "No" }],
      recommendedIndex: 1,
      allowFreeText: false,
    },
  };
}
let inboxItems: unknown[] = [];
let agentSessionsAvailable = true;
/** L'inbox di un PROGETTO (`/api/inbox?projectId=`): `null` = le notifiche dell'hub. */
let projectInboxItems: unknown[] | null = null;

const DOC_REPOSITORY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOC_PAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const DOC_SPACE = {
  repositoryId: DOC_REPOSITORY_ID,
  slug: "portale-api",
  name: "Spazio API",
  pageCount: 3,
  lastGenerationAt: null,
  lastCommitSha: null,
};

const DOC_TREE_NODE = {
  id: DOC_PAGE_ID,
  slug: "guida",
  title: "Guida all'API",
  kind: "functional",
  parentId: null,
  position: 0,
  sourcePath: null,
  isManual: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  viewCount: 0,
  // Obbligatorio benché nullable: senza, il parse dell'INTERA risposta
  // fallisce e la query resta in errore — non un campo degradato.
  significant: null,
};

const DOC_PAGE = {
  ...DOC_TREE_NODE,
  body: "# Guida all'API\n\nCome si chiama l'API.",
  commitSha: null,
  commitUrl: null,
  links: null,
  updatedAt: "2026-08-01T00:00:00.000Z",
  significant: null,
};

/**
 * Una sessione dell'agente sul ticket del piano (piano C, Task 6): viva, così
 * la schermata apre lo stream — sull'XHR finto, iniettato col provider.
 */
const AGENT_SESSION_ID = "abababab-abab-4bab-8bab-abababababab";
const AGENT_SESSION_SUMMARY = {
  id: AGENT_SESSION_ID,
  kind: "ai_job",
  title: "Export CSV degli ordini",
  projectId: HUB_PROJECT_ID,
  projectName: "Farmakom",
  ticketId: PLAN_TICKET_ID,
  ticketNumber: 27,
  startedAt: "2026-10-09T08:00:00.000Z",
  lastEventAt: "2026-10-09T08:05:00.000Z",
  state: "working",
  activeSegment: "execute",
  lastActivity: null,
  aiJobId: PLAN_JOB_ID,
  outcome: null,
};
const AGENT_SESSION_DETAIL = { ...AGENT_SESSION_SUMMARY, canWrite: false, canInterrupt: false, paused: false, questions: [], inputs: [] };
const AGENT_SESSION_EVENTS = {
  events: [
    {
      id: "1",
      type: "assistant_text",
      segmentId: "s1",
      at: "2026-10-09T08:01:00.000Z",
      data: { text: "Aggiungo il CSV" },
    },
  ],
  before: null,
};

function jsonResponse(status: number, body: unknown): Response {
  const init: ResponseInit = { status };
  if (body !== undefined) {
    return new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json" } });
  }
  return new Response(null, init);
}

/** Router minimo per il fetch mockato: solo le rotte che il flusso deep-link tocca davvero. */
function routeFetch(input: RequestInfo | URL, init?: RequestInit): Response {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url.endsWith("/api/auth/mobile-login")) {
    return jsonResponse(200, { token: "stw_pat_x", patId: "55555555-5555-4555-8555-555555555555", user: successUser });
  }
  if (url.endsWith("/api/projects") && method === "GET") {
    return jsonResponse(200, []);
  }
  if (url.endsWith("/api/me/follows") && method === "GET") {
    return jsonResponse(200, { projectIds: [] });
  }
  if (url.endsWith("/api/me/follows") && method === "PUT") {
    return jsonResponse(204, undefined);
  }
  // L'Inbox vera (Task 14) monta insieme al deep link: List e Card leggono la
  // stessa query, e la tab bar interroga il contatore non letto.
  if (url.endsWith("/api/inbox") && method === "GET") {
    return jsonResponse(200, { items: inboxItems, nextCursor: null });
  }
  if (url.endsWith("/api/inbox/unread-count") && method === "GET") {
    return jsonResponse(200, { count: 0 });
  }
  // La ricerca globale (9 ott 2026, il test dell'indietro dalla ricerca): un
  // solo progetto, quello dell'hub.
  if (url.includes("/api/search?") && method === "GET") {
    return jsonResponse(200, {
      tickets: { items: [], hasMore: false },
      projects: { items: [{ id: HUB_PROJECT_ID, name: "Portale B2B", slug: "portale-b2b", snippet: null }], hasMore: false },
      repositories: { items: [], hasMore: false },
      docs: { items: [], hasMore: false },
      mail: { items: [], hasMore: false },
    });
  }
  // L'hub di progetto (22 set 2026): il polso, l'anteprima dei ticket e
  // l'inbox del progetto — più il «Fatto» su una notifica, che è la
  // mutazione vera del test sull'invalidazione.
  if (url.endsWith("/api/projects/pulse") && method === "GET") {
    pulseCalls += 1;
    return jsonResponse(200, hubPulse());
  }
  // La schermata del ticket col piano da approvare (23 set 2026): tutto ciò
  // che `WorkScreen` legge, più l'approvazione — la mutazione VERA del test
  // sul sintomo. PRIMA del ramo generico `/api/tickets`, che la inghiottirebbe.
  if (method === "POST" && url.endsWith(`/api/tickets/${PLAN_TICKET_ID}/approve-plan`)) {
    planAwaitingApproval = false;
    return jsonResponse(200, { jobId: PLAN_JOB_ID });
  }
  if (method === "GET" && url.endsWith(`/api/tickets/${PLAN_TICKET_ID}`)) {
    return jsonResponse(200, PLAN_TICKET);
  }
  if (method === "GET" && url.endsWith(`/api/tickets/${PLAN_TICKET_ID}/jobs`)) {
    return jsonResponse(200, [planJob()]);
  }
  // La storia del ticket (5 ott 2026): `WorkScreen` la legge in Attività.
  if (method === "GET" && url.endsWith(`/api/tickets/${PLAN_TICKET_ID}/history`)) {
    return jsonResponse(200, { events: [], total: 0 });
  }
  if (
    method === "GET" &&
    (url.endsWith(`/api/tickets/${PLAN_TICKET_ID}/questions`) ||
      url.endsWith(`/api/tickets/${PLAN_TICKET_ID}/comments`) ||
      url.includes("/reviews") ||
      url.endsWith("/api/users") ||
      url.includes("/api/milestones"))
  ) {
    return jsonResponse(200, []);
  }
  if (method === "POST" && url.includes("/api/inbox/") && url.endsWith("/handled")) {
    hubOpenNotifications -= 1;
    return jsonResponse(204, undefined);
  }
  if (method === "GET" && url.includes("/api/inbox?") && projectInboxItems !== null) {
    return jsonResponse(200, { items: projectInboxItems, nextCursor: null, total: projectInboxItems.length });
  }
  if (method === "GET" && url.includes("/api/inbox?")) {
    const items = [hubNotification(HUB_NOTIFICATION_ID), hubNotification("44444444-4444-4444-8444-444444444444")].slice(
      0,
      hubOpenNotifications,
    );
    return jsonResponse(200, { items, nextCursor: null, total: hubOpenNotifications });
  }
  // La documentazione di un progetto (22 set 2026, tappa 2): gli spazi,
  // l'albero di uno spazio e una pagina. La PAGINA prima dell'albero: i due
  // path condividono il prefisso `/docs/`.
  if (method === "GET" && url.includes("/docs/spaces")) {
    return jsonResponse(200, [DOC_SPACE]);
  }
  // «La documentazione nell'app, come sul web» (25 set 2026): highlights e
  // brief sono letture accessorie; qui un repository senza brief (404).
  if (method === "GET" && url.includes("/docs/highlights")) {
    return jsonResponse(200, {
      countsByKind: { technical: 0, functional: 1, product: 0, manual: 0, releases: 0 },
      topViewed: [],
      latestReleases: [],
      ...(url.includes("/api/repositories/") ? { recentlyUpdated: [] } : {}),
    });
  }
  if (method === "GET" && url.includes("/docs/brief")) {
    return jsonResponse(404, { error: { code: "doc_brief_not_found", message: "No brief" } });
  }
  if (method === "POST" && url.includes("/docs/pages/") && url.endsWith("/view")) {
    return jsonResponse(204, undefined);
  }
  if (method === "GET" && url.includes("/docs/pages/")) {
    return jsonResponse(200, DOC_PAGE);
  }
  if (method === "GET" && url.includes("/docs/tree")) {
    return jsonResponse(200, [DOC_TREE_NODE]);
  }
  if (!agentSessionsAvailable && url.includes("/api/agent-sessions")) {
    return jsonResponse(404, { message: "Route not found" });
  }
  // Le sessioni degli agenti (piano C): gli eventi PRIMA del dettaglio, il
  // dettaglio prima dell'elenco — condividono il prefisso.
  if (method === "GET" && url.includes(`/api/agent-sessions/${AGENT_SESSION_ID}/events`)) {
    return jsonResponse(200, AGENT_SESSION_EVENTS);
  }
  if (method === "GET" && url.endsWith(`/api/agent-sessions/${AGENT_SESSION_ID}`)) {
    return jsonResponse(200, AGENT_SESSION_DETAIL);
  }
  if (method === "GET" && url.includes("/api/agent-sessions")) {
    return jsonResponse(200, { live: [AGENT_SESSION_SUMMARY], recent: [] });
  }
  if (method === "GET" && url.includes("/api/tickets")) {
    return jsonResponse(200, { items: [], nextCursor: null, total: 0 });
  }
  // Il backlog di un progetto e il documento di una sua voce (22 set 2026):
  // li tocca il test dell'hub più sotto. Il dettaglio PRIMA della lista,
  // altrimenti `/api/backlog/<id>` finirebbe nel ramo della lista.
  if (method === "GET" && url.includes(`/api/backlog/${BACKLOG_ITEM_ID}`)) {
    return jsonResponse(200, BACKLOG_ITEM_DETAIL);
  }
  if (method === "GET" && url.includes("/api/backlog")) {
    return jsonResponse(200, { items: [BACKLOG_ITEM_LIST_ROW], nextCursor: null, total: 1 });
  }
  throw new Error(`rotta non mockata nel test: ${method} ${url}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  // Stato in memoria di linking.ts: senza reset, un deep link consumato in
  // un test resterebbe (o mancherebbe) nel test successivo.
  setPendingDeepLink(null);
  hubOpenNotifications = 2;
  inboxItems = [];
  agentSessionsAvailable = true;
  projectInboxItems = null;
  planAwaitingApproval = false;
  pulseCalls = 0;
});

describe("deep link", () => {
  test("stubwise://inbox/abc CON sessione: apre subito Main/Inbox/Card", async () => {
    const session = {
      baseUrl: "https://stubwise.example",
      token: "stw_pat_existing",
      patId: "66666666-6666-4666-8666-666666666666",
      user: successUser,
    };
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
      username: "stubwise-session",
      password: JSON.stringify(session),
      service: "com.app.aleloca.stubwise.session",
      storage: "keychain",
    });
    (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://inbox/abc");
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));

    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );

    await waitFor(() => expect(screen.getByTestId("inbox-card-screen")).toBeTruthy());
    // Non è finito su Login: la sessione esisteva già.
    expect(screen.queryByTestId("login-url")).toBeNull();
  });

  test("stubwise://inbox/abc SENZA sessione: apre Login, e lo riapre dopo login+onboarding", async () => {
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue(false);
    (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://inbox/abc");
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));

    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );

    // Il link NON porta direttamente alla card: senza sessione si finisce
    // su Login, e il link resta "in sospeso" (vedi app/linking.ts).
    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());
    expect(screen.queryByTestId("inbox-card-screen")).toBeNull();

    await fireEvent.changeText(screen.getByTestId("login-url"), "stubwise.example");
    await fireEvent.changeText(screen.getByTestId("login-email"), "giulia@farmakom.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "hunter2");
    await fireEvent.press(screen.getByTestId("login-submit"));

    // Dopo il login si passa da Onboarding, non direttamente a Main.
    await waitFor(() => expect(screen.getByTestId("onboarding-later")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("onboarding-later"));

    // Solo ORA `Main` monta per la prima volta, e consuma il link rimasto
    // in sospeso: la card compare senza che l'utente abbia dovuto toccare
    // di nuovo la notifica.
    await waitFor(() => expect(screen.getByTestId("inbox-card-screen")).toBeTruthy());
  });

  test("stubwise://tickets/:id?tab=activity SENZA sessione: dopo il login il ticket si apre su Attività", async () => {
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue(false);
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(`stubwise://tickets/${PLAN_TICKET_ID}?tab=activity`);
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));

    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );

    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("login-url"), "stubwise.example");
    await fireEvent.changeText(screen.getByTestId("login-email"), "giulia@farmakom.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "hunter2");
    await fireEvent.press(screen.getByTestId("login-submit"));
    await waitFor(() => expect(screen.getByTestId("onboarding-later")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("onboarding-later"));

    // Il link in sospeso porta la tab con sé: non si perde nel passaggio dal login.
    await waitFor(() =>
      expect(screen.getByTestId("work-tab-activity").props.accessibilityState).toEqual({ selected: true }),
    );
  });

  /**
   * Il link VIVO, da autenticati: lo risolve il parser di react-navigation
   * (`Ticket: "tickets/:id"`), che legge la query da sé. E — sullo STESSO
   * router vero — il caso I1 della review finale: un secondo link con gli
   * stessi valori, dopo una scelta a mano, riporta sulla tab chiesta. Qui si
   * verifica davvero che react-navigation 7 dia un oggetto params nuovo a ogni
   * navigazione, cosa su cui l'effetto di `WorkScreen` si appoggia.
   */
  test("stubwise://tickets/:id?tab=activity CON sessione: il ticket su Attività, e un secondo link uguale ci riporta", async () => {
    const session = {
      baseUrl: "https://stubwise.example",
      token: "stw_pat_existing",
      patId: "66666666-6666-4666-8666-666666666666",
      user: successUser,
    };
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
      username: "stubwise-session",
      password: JSON.stringify(session),
      service: "com.app.aleloca.stubwise.session",
      storage: "keychain",
    });
    const link = `stubwise://tickets/${PLAN_TICKET_ID}?tab=activity`;
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(link);
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));

    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );

    const selected = (tab: string) => screen.getByTestId(`work-tab-${tab}`).props.accessibilityState?.selected;
    await waitFor(() => expect(selected("activity")).toBe(true));

    await fireEvent.press(screen.getByTestId("work-tab-status"));
    expect(selected("status")).toBe(true);

    const urlListener = (Linking.addEventListener as jest.Mock).mock.calls.find(([type]) => type === "url")?.[1] as
      | ((event: { url: string }) => void)
      | undefined;
    expect(urlListener).toBeDefined();
    await act(async () => {
      urlListener!({ url: link });
    });
    await waitFor(() => expect(selected("activity")).toBe(true));
  });

  // Mutazione da rompere apposta: se `getInitialURL`/`subscribe` in
  // linking.ts passassero l'URL al navigator ANCHE da sloggati (invece di
  // metterlo in sospeso), react-navigation tenterebbe di risolvere uno
  // stato per uno screen ("Main/Inbox/Card") che non esiste ancora
  // nell'albero montato (solo `Auth` lo è) — il test sopra lo intercetta
  // già (Login deve comparire, non la card), ma qui verifichiamo anche che
  // NESSUN deep link resti "perso" quando non ce n'è uno.
  test("stubwise://mail/email/xyz CON sessione: apre DIRETTAMENTE il dettaglio, non la lista Mbx (architettura, regola 2)", async () => {
    const session = {
      baseUrl: "https://stubwise.example",
      token: "stw_pat_existing",
      patId: "88888888-8888-4888-8888-888888888888",
      user: successUser,
    };
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
      username: "stubwise-session",
      password: JSON.stringify(session),
      service: "com.app.aleloca.stubwise.session",
      storage: "keychain",
    });
    (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://mail/email/xyz");
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));

    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );

    await waitFor(() => expect(screen.getByTestId("mail-detail-screen")).toBeTruthy());
    // Non è finito sullo scambio Posta/Calendario di Mbx: il deep link salta
    // la lista, non ci passa in mezzo.
    expect(screen.queryByTestId("mbx-switch")).toBeNull();
  });

  test("stubwise://mail/calendar/xyz: nessuna schermata calendario da raggiungere ancora, il link viene scartato", async () => {
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue(false);
    (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://mail/calendar/xyz");
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));

    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );

    // Un URL malformato (source non "email") non deve mai far girare a vuoto
    // il resolver: `resolveDeepLinkTarget` lo scarta (`null`), quindi non
    // resta nemmeno "in sospeso" — login normale, nessuna sorpresa dopo.
    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());
  });

  test("stubwise://calendar/:day/:id CON sessione: apre MBX sul CALENDARIO, non sulla Posta (App M3, Fase D)", async () => {
    const session = {
      baseUrl: "https://stubwise.example",
      token: "stw_pat_existing",
      patId: "88888888-8888-4888-8888-888888888888",
      user: successUser,
    };
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
      username: "stubwise-session",
      password: JSON.stringify(session),
      service: "com.app.aleloca.stubwise.session",
      storage: "keychain",
    });
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(
      "stubwise://calendar/2026-09-17/7c9e6679-7425-40de-944b-e07fc1f90ae7",
    );
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));

    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );

    // La scheda MBX mostra due cose: chi tocca la notifica di un
    // appuntamento deve trovarsi davanti la griglia, non la lista della posta
    // con una scheda da cambiare a mano.
    await waitFor(() => expect(screen.getByTestId("calendar-panel")).toBeTruthy());
    expect(screen.getByTestId("calendar-month-label").props.children.join("")).toContain("settembre");
    expect(screen.queryByTestId("mbx-mail-list")).toBeNull();
  });

  test("senza deep link in coda, l'onboarding porta a Main pulito (nessuna card)", async () => {
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue(false);
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(undefined);
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));

    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );
    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("login-url"), "stubwise.example");
    await fireEvent.changeText(screen.getByTestId("login-email"), "giulia@farmakom.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "hunter2");
    await fireEvent.press(screen.getByTestId("login-submit"));
    await waitFor(() => expect(screen.getByTestId("onboarding-later")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("onboarding-later"));

    // "Inbox" compare più volte (placeholder + etichetta della tab bar):
    // la verifica che conta è che Main sia montato (Onboarding sparito) e
    // nessuna card fantasma sia apparsa.
    await waitFor(() => expect(screen.queryByTestId("onboarding-later")).toBeNull());
    expect(screen.getAllByText("Inbox").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("inbox-card-screen")).toBeNull();
  });
});

/**
 * AGT AL POSTO DI MBX (sessioni degli agenti, piano C, design §8.1): posta e
 * calendario non sono più una tab. Il loro stack sta sulla RADICE, sopra le
 * schede, e ci si entra dal profilo (le Impostazioni). I link che il server
 * emette nelle push (`mail/…`, `calendar/…`) continuano a funzionare: cambia
 * solo dove atterrano — e da lì «indietro» deve riportare alle schede.
 */
describe("posta e calendario fuori dalla barra", () => {
  function mockSession() {
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
      username: "stubwise-session",
      password: JSON.stringify({
        baseUrl: "https://stubwise.example",
        token: "stw_pat_existing",
        patId: "66666666-6666-4666-8666-666666666666",
        user: successUser,
      }),
      service: "com.app.aleloca.stubwise.session",
      storage: "keychain",
    });
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));
  }

  async function renderApp() {
    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );
  }

  /** Il bottone «indietro» della schermata in cima: le scene sotto restano montate. */
  function topBackButton() {
    const buttons = screen.getAllByTestId("screen-header-back");
    return buttons[buttons.length - 1]!;
  }

  function rootRouteNames(): string[] {
    return (navigationRef.getRootState()?.routes ?? []).map((route) => route.name);
  }

  /** Preflight H1: a freddo, `Main` sotto la posta — o non c'è nessun indietro. */
  test("a freddo, stubwise://mail/email/xyz apre il dettaglio SOPRA le schede, e indietro torna a Main", async () => {
    mockSession();
    (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://mail/email/xyz");
    await renderApp();

    await waitFor(() => expect(screen.getByTestId("mail-detail-screen")).toBeTruthy());
    expect(rootRouteNames()).toEqual(["Main", "Mail"]);

    await fireEvent.press(topBackButton());
    await waitFor(() => expect(rootRouteNames()).toEqual(["Main"]));
  });

  test("a freddo, stubwise://calendar/:day apre il calendario SOPRA le schede, e indietro torna a Main", async () => {
    mockSession();
    (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://calendar/2026-10-09");
    await renderApp();

    await waitFor(() => expect(screen.getByTestId("calendar-panel")).toBeTruthy());
    expect(rootRouteNames()).toEqual(["Main", "Mail"]);

    await fireEvent.press(topBackButton());
    await waitFor(() => expect(rootRouteNames()).toEqual(["Main"]));
  });

  /** Il link arrivato PRIMA del login lo consuma `MainTabs`, non il parser: va riportato anche lì. */
  test("stubwise://mail/email/xyz SENZA sessione: dopo il login si apre il dettaglio della posta", async () => {
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue(false);
    (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://mail/email/xyz");
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));
    await renderApp();

    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("login-url"), "stubwise.example");
    await fireEvent.changeText(screen.getByTestId("login-email"), "giulia@farmakom.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "hunter2");
    await fireEvent.press(screen.getByTestId("login-submit"));
    await waitFor(() => expect(screen.getByTestId("onboarding-later")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("onboarding-later"));

    await waitFor(() => expect(screen.getByTestId("mail-detail-screen")).toBeTruthy());
    expect(rootRouteNames()).toEqual(["Main", "Mail"]);
  });

  test("stubwise://calendar/:day SENZA sessione: dopo il login si apre il calendario", async () => {
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue(false);
    (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://calendar/2026-09-17");
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));
    await renderApp();

    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("login-url"), "stubwise.example");
    await fireEvent.changeText(screen.getByTestId("login-email"), "giulia@farmakom.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "hunter2");
    await fireEvent.press(screen.getByTestId("login-submit"));
    await waitFor(() => expect(screen.getByTestId("onboarding-later")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("onboarding-later"));

    await waitFor(() => expect(screen.getByTestId("calendar-panel")).toBeTruthy());
    expect(screen.getByTestId("calendar-month-label").props.children.join("")).toContain("settembre");
  });

  /** Design §8.1: posta e calendario si raggiungono dal profilo. Preflight M1: e se ne esce. */
  test("dal profilo, «Posta» apre la posta e «indietro» torna al profilo", async () => {
    mockSession();
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(undefined);
    await renderApp();
    await waitFor(() => expect(navigationRef.isReady()).toBe(true));

    await act(async () => {
      navigationRef.navigate("Settings");
    });
    await fireEvent.press(await screen.findByTestId("settings-row-mail"));

    await waitFor(() => expect(screen.getByTestId("mbx-switch")).toBeTruthy());
    expect(screen.getByTestId("mbx-tab-mail").props.accessibilityState).toEqual({ selected: true });
    expect(rootRouteNames()).toEqual(["Main", "Settings", "Mail"]);

    await fireEvent.press(topBackButton());
    await waitFor(() => expect(rootRouteNames()).toEqual(["Main", "Settings"]));
  });

  test("dal profilo, un risultato della ricerca torna su Main: nessuna seconda Main sopra il profilo", async () => {
    mockSession();
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(undefined);
    await renderApp();
    await waitFor(() => expect(navigationRef.isReady()).toBe(true));

    await act(async () => {
      navigationRef.navigate("Settings");
    });
    await waitFor(() => expect(rootRouteNames()).toEqual(["Main", "Settings"]));
    const triggers = await screen.findAllByTestId("global-search-trigger");
    await fireEvent.press(triggers[triggers.length - 1]!);
    await fireEvent.changeText(await screen.findByTestId("global-search-input"), "Portale");
    await fireEvent.press(await screen.findByTestId(`global-search-project-${HUB_PROJECT_ID}`));

    await waitFor(() => expect(rootRouteNames()).toEqual(["Main"]));
    type Nested = { index: number; routes: { name: string; params?: unknown; state?: Nested }[] };
    const mainState = () => navigationRef.getRootState()?.routes[0]?.state as Nested | undefined;
    await waitFor(() => expect(mainState()?.routes[mainState()!.index]?.name).toBe("Projects"));
    // E la Detail del progetto è arrivata davvero, col suo id, nello stack Progetti.
    await waitFor(() => {
      const projects = mainState()?.routes.find((route) => route.name === "Projects")?.state;
      const last = projects?.routes[projects.routes.length - 1];
      expect(last?.name).toBe("Detail");
      expect(last?.params).toMatchObject({ id: HUB_PROJECT_ID });
    });
  });

  test("dal profilo, «Calendario» apre la stessa schermata già sul calendario", async () => {
    mockSession();
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(undefined);
    await renderApp();
    await waitFor(() => expect(navigationRef.isReady()).toBe(true));

    await act(async () => {
      navigationRef.navigate("Settings");
    });
    await fireEvent.press(await screen.findByTestId("settings-row-calendar"));

    await waitFor(() => expect(screen.getByTestId("calendar-panel")).toBeTruthy());
    expect(screen.getByTestId("mbx-tab-calendar").props.accessibilityState).toEqual({ selected: true });
  });

  test("stubwise://agents apre la schermata degli agenti nella tab AGT", async () => {
    mockSession();
    (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://agents");
    await renderApp();

    await waitFor(() => expect(screen.getByTestId("agents-screen")).toBeTruthy());
    const main = navigationRef.getRootState()?.routes[0];
    const tabs = main?.state as { index: number; routes: { name: string }[] } | undefined;
    expect(tabs?.routes[tabs.index]?.name).toBe("Agents");
  });

  /** Preflight L3: un link agli agenti arrivato prima del login non si perde. */
  test("stubwise://agents SENZA sessione: dopo il login si apre la tab AGT", async () => {
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue(false);
    (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://agents");
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));
    await renderApp();

    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("login-url"), "stubwise.example");
    await fireEvent.changeText(screen.getByTestId("login-email"), "giulia@farmakom.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "hunter2");
    await fireEvent.press(screen.getByTestId("login-submit"));
    await waitFor(() => expect(screen.getByTestId("onboarding-later")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("onboarding-later"));

    await waitFor(() => expect(screen.getByTestId("agents-screen")).toBeTruthy());
  });
});

// Task 20: il banner offline è GLOBALE (`app/providers.tsx`, top bar sopra
// ogni tab) — PRIMA viveva anche dentro `InboxScreen` (Task 13/14), che
// aveva la propria copia locale pilotata dalla STESSA condizione
// (`useIsOnline()`/NetInfo). Un test che monta solo `InboxScreen` isolata
// (come `InboxScreen.test.tsx`) non può vedere la duplicazione — vede
// SOLO il banner locale, non quello globale, che vive un livello sopra in
// `AppProviders`. Serve una composizione VERA (`AppProviders` → `RootNavigator`
// → `MainNavigator` → `InboxScreen`, la stessa di `App.tsx`) per accorgersene:
// è esattamente questo test.
describe("banner offline globale (Task 20) — non duplica sulla tab Inbox reale", () => {
  test("da offline, con sessione già valida, il banner compare UNA sola volta (chrome globale, non anche dentro l'Inbox)", async () => {
    const session = {
      baseUrl: "https://stubwise.example",
      token: "stw_pat_existing",
      patId: "77777777-7777-4777-8777-777777777777",
      user: successUser,
    };
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
      username: "stubwise-session",
      password: JSON.stringify(session),
      service: "com.app.aleloca.stubwise.session",
      storage: "keychain",
    });
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(undefined);
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));

    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );

    // Aspetta che la vera InboxScreen abbia finito il primo caricamento
    // (skeleton sparito, ScrollView montato): è lì dentro, PRIMA del fix,
    // che sarebbe comparso il secondo banner ridondante.
    await waitFor(() => expect(screen.queryByTestId("inbox-skeleton")).toBeNull());

    expect(screen.getAllByText(/Offline/)).toHaveLength(1);

    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
  });
});

/**
 * IL FILO NON SI SPEZZA (22 set 2026, hub di progetto).
 *
 * ⚠️ Questo test monta l'albero VERO — `AppProviders` → `RootNavigator` →
 * `MainNavigator` → stack `Projects` — e non un componente isolato con una
 * navigazione finta, perché la proprietà da fissare è proprio ciò che una
 * navigazione finta non può mostrare: **dove si torna**. Un test che
 * verificasse solo «la rotta `Item` esiste» passerebbe anche se l'indietro
 * finisse sulla lista generale del backlog, che è esattamente il difetto
 * chiuso qui.
 *
 * Fino a questo giro `BacklogItemScreen` era registrata SOLO nello stack
 * BLG: aprirla dall'hub usciva dallo stack `Projects`, la scheda in basso
 * saltava su BLG, e l'indietro riportava al backlog di TUTTI i progetti —
 * con il progetto da cui si era partiti perso per strada.
 */
describe("hub di progetto — il dettaglio di una voce resta nello stack del progetto", () => {
  test("dall'elenco del progetto: apro la voce, torno indietro, sono ancora nell'elenco DEL PROGETTO", async () => {
    const session = {
      baseUrl: "https://stubwise.example",
      token: "stw_pat_existing",
      patId: "99999999-9999-4999-8999-999999999999",
      user: successUser,
    };
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
      username: "stubwise-session",
      password: JSON.stringify(session),
      service: "com.app.aleloca.stubwise.session",
      storage: "keychain",
    });
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(undefined);
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));

    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );
    await waitFor(() => expect(navigationRef.isReady()).toBe(true));

    // Si entra dove ci porterebbe «vedi ›» sulla sezione backlog dell'hub.
    // Il tap su quel bottone è già coperto da `ProjectDetailScreen.test.tsx`:
    // qui interessa cosa succede DA LÌ IN POI, con il navigatore vero.
    await act(async () => {
      navigationRef.navigate("Main", {
        screen: "Projects",
        params: {
          screen: "ProjectBacklog",
          params: { projectId: HUB_PROJECT_ID, projectName: "Portale B2B" },
        },
      });
    });
    await waitFor(() => expect(screen.getByTestId(`backlog-open-${BACKLOG_ITEM_ID}`)).toBeTruthy());
    expect(screen.getByTestId("project-backlog-chip-active")).toBeTruthy();

    // Apro la voce: è la STESSA `BacklogItemScreen` del tab BLG, registrata
    // anche qui — una copia sola, due registrazioni.
    await fireEvent.press(screen.getByTestId(`backlog-open-${BACKLOG_ITEM_ID}`));
    await waitFor(() => expect(screen.getByTestId("backlog-item-proceed")).toBeTruthy());

    // ⚠️ La scheda in basso non si è mossa: se il tap fosse uscito dallo
    // stack, saremmo nel tab BLG — la cui lista si riconosce dai SUOI chip
    // (`backlog-chip-active`, senza il prefisso `project-`).
    expect(screen.queryByTestId("backlog-chip-active")).toBeNull();

    // E l'indietro riporta all'elenco DEL PROGETTO, non a quello generale.
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    await waitFor(() => expect(screen.getByTestId("project-backlog-chip-active")).toBeTruthy());
    expect(screen.queryByTestId("backlog-chip-active")).toBeNull();
  });
});

/**
 * I NUMERI DELL'HUB NON RESTANO INDIETRO (22 set 2026, difetto colto in
 * review).
 *
 * ⚠️ Questo test monta l'albero VERO e fa una MUTAZIONE VERA, e nessuna
 * delle due cose è cerimonia: le chiavi dell'hub erano nate in un namespace
 * proprio (`["projects","hub",…]`), che nessuna invalidazione raggiungeva.
 * Un test con un `QueryClient` fresco per render non può mostrarlo — non ha
 * niente di stantio da mostrare — e uno che invalidasse a mano la chiave
 * giusta proverebbe solo che `invalidateQueries` funziona.
 *
 * Qui la sequenza è quella dell'utente: guardo l'hub, entro, faccio una
 * cosa, torno indietro. `ProjectDetailScreen` resta MONTATA sotto per tutto
 * il tempo (stack nativo) e l'app non ha refetch-on-focus da nessuna parte:
 * se la sua query non sta sotto `["inbox"]`, al ritorno il numero è quello
 * di prima.
 */
describe("hub di progetto — i conteggi si aggiornano dopo un'azione", () => {
  test("gestisco una notifica dentro il progetto e, tornando all'hub, il numero è calato", async () => {
    const session = {
      baseUrl: "https://stubwise.example",
      token: "stw_pat_existing",
      patId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      user: successUser,
    };
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
      username: "stubwise-session",
      password: JSON.stringify(session),
      service: "com.app.aleloca.stubwise.session",
      storage: "keychain",
    });
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(undefined);
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));

    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );
    await waitFor(() => expect(navigationRef.isReady()).toBe(true));

    await act(async () => {
      navigationRef.navigate("Main", {
        screen: "Projects",
        params: { screen: "Detail", params: { id: HUB_PROJECT_ID } },
      });
    });
    // Dettaglio v3 (28 set 2026): le notifiche stanno nella tab Lavoro.
    await waitFor(() => expect(screen.getByTestId("hub-tab-work")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("hub-tab-work"));
    await waitFor(() => expect(screen.getByText(/2 da gestire/)).toBeTruthy());

    // Entro dall'hub, come farebbe chi tocca «tutte ›».
    await fireEvent.press(screen.getByTestId("hub-work-inbox-all"));
    await waitFor(() => expect(screen.getAllByTestId("pr-ready-card-handled").length).toBe(2));

    // La mutazione VERA: `useHandled` invalida `inboxKeys.all`, e non sa —
    // né deve sapere — che esiste una sezione dell'hub.
    await fireEvent.press(screen.getAllByTestId("pr-ready-card-handled")[0]!);
    await waitFor(() => expect(screen.getAllByTestId("pr-ready-card-handled").length).toBe(1));

    // Torno indietro: l'hub non è stato rimontato, quindi il numero nuovo
    // può arrivare SOLO da un'invalidazione che ha raggiunto la sua query.
    // E si ritrova la tab di prima: la scelta resta finché l'hub è montato.
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    await waitFor(() => expect(screen.getByText(/1 da gestire/)).toBeTruthy());
    expect(screen.getByTestId("hub-tab-work").props.accessibilityState?.selected).toBe(true);
  });
});

/**
 * LA DOCUMENTAZIONE SI LEGGE SENZA USCIRE DAL PROGETTO (22 set 2026, tappa
 * 2) — è la verifica che il maintainer fa sul telefono.
 *
 * ⚠️ Albero di navigazione VERO, come per i due gemelli della tappa 1 e per
 * la stessa ragione: la proprietà è DOVE SI TORNA, e una navigazione finta
 * non può mostrarla. Un test che verificasse solo «la rotta `Page` esiste»
 * passerebbe anche se l'indietro finisse nel tab DOC, sulla documentazione di
 * un progetto qualsiasi — che è il difetto che la registrazione doppia
 * esiste per impedire.
 */
describe("hub di progetto — la documentazione resta nello stack del progetto", () => {
  test("apro una pagina dalla documentazione del progetto e, tornando indietro, sono ancora lì", async () => {
    const session = {
      baseUrl: "https://stubwise.example",
      token: "stw_pat_existing",
      patId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      user: successUser,
    };
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
      username: "stubwise-session",
      password: JSON.stringify(session),
      service: "com.app.aleloca.stubwise.session",
      storage: "keychain",
    });
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(undefined);
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));

    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );
    await waitFor(() => expect(navigationRef.isReady()).toBe(true));

    await act(async () => {
      navigationRef.navigate("Main", {
        screen: "Projects",
        params: {
          screen: "ProjectDocs",
          params: { projectId: HUB_PROJECT_ID, projectName: "Portale B2B" },
        },
      });
    });
    await waitFor(() => expect(screen.getByTestId(`project-docs-repo-${DOC_REPOSITORY_ID}`)).toBeTruthy());

    // Dalla pagina generale alla documentazione del repository, a tab.
    await fireEvent.press(screen.getByTestId(`project-docs-repo-${DOC_REPOSITORY_ID}`));
    await waitFor(() => expect(screen.getByTestId("repo-docs-tab-functional")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("repo-docs-tab-functional"));
    await waitFor(() => expect(screen.getByTestId("repo-docs-node-guida")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("repo-docs-node-guida"));
    await waitFor(() => expect(screen.getByTestId("docs-page-body")).toBeTruthy());

    // Indietro: si torna alla documentazione del repository, dentro lo stack
    // del progetto — non a un'altra scheda.
    const backs = screen.getAllByTestId("screen-header-back");
    await fireEvent.press(backs[backs.length - 1]!);
    // La pagina se n'è andata (la documentazione del repository era rimasta
    // montata SOTTO: vederla non basterebbe a provare l'indietro).
    await waitFor(() => expect(screen.queryByTestId("docs-page-body")).toBeNull());
    expect(screen.getByTestId("repo-docs-tab-functional")).toBeTruthy();
  });
});


/** Una sessione salvata, con il ruolo scelto: il test del piano vuole un maintainer. */
function mockSession(role: "admin" | "member") {
  const session = {
    baseUrl: "https://stubwise.example",
    token: "stw_pat_existing",
    patId: "12121212-1212-4121-8121-121212121212",
    user: { ...successUser, role },
  };
  (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
    username: "stubwise-session",
    password: JSON.stringify(session),
    service: "com.app.aleloca.stubwise.session",
    storage: "keychain",
  });
  (Linking.getInitialURL as jest.Mock).mockResolvedValue(undefined);
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));
}

/**
 * ⚠️ Il `QueryClient` dell'app è UNO per tutto il file (è un singleton di
 * modulo): senza svuotarlo, il polso arriva già in cache dai test
 * precedenti, fresco, e non viene nemmeno chiesto — i test qui sotto
 * contano proprio quelle richieste.
 */
function clearAppCache() {
  queryClient.clear();
}

async function openHub() {
  await render(
    <AppProviders>
      <RootNavigator />
    </AppProviders>,
  );
  await waitFor(() => expect(navigationRef.isReady()).toBe(true));
  await act(async () => {
    navigationRef.navigate("Main", {
      screen: "Projects",
      params: { screen: "Detail", params: { id: HUB_PROJECT_ID } },
    });
  });
}

/**
 * IL SINTOMO DA CUI È PARTITO «L'APP NON RESTA INDIETRO» (23 set 2026,
 * design §1 e §8) — ed è la verifica che il maintainer fa sul telefono.
 *
 * Approvi il piano del #27 dal ticket aperto dall'hub, torni indietro
 * SUBITO, e il #27 non deve più essere sotto «aspetta te». «Subito» è il
 * punto: il polso ha pochi secondi, è dentro il suo `staleTime`, quindi il
 * ricaricamento al ritorno NON parte. L'unica cosa che può aggiornarlo è
 * l'invalidazione che `useTicketAction` dichiara. Verificato togliendola: il
 * test diventa rosso.
 */
describe("l'app non resta indietro — approvi un piano e torni all'hub", () => {
  beforeEach(clearAppCache);

  test("il ticket non è più sotto «aspetta te», senza uscire dal progetto", async () => {
    planAwaitingApproval = true;
    mockSession("admin");
    await openHub();

    // Dettaglio v3: un piano che il maintainer può approvare è «Tocca a te».
    await waitFor(() => expect(screen.getByText("Tocca a te · 1")).toBeTruthy());
    await fireEvent.press(screen.getByText("Export CSV degli ordini"));

    await waitFor(() => expect(screen.getByTestId("plan-section-approve")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("plan-section-approve"));
    await waitFor(() => expect(screen.getByTestId("plan-section-approve-confirm")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("plan-section-approve-confirm"));
    await waitFor(() => expect(planAwaitingApproval).toBe(false));

    await fireEvent.press(screen.getByTestId("screen-header-back"));
    await waitFor(() => expect(screen.queryByText("Tocca a te · 1")).toBeNull());
    expect(screen.getByText("Portale B2B")).toBeTruthy();
  });
});

/**
 * L'indietro dell'hub (9 ott 2026). Con react-navigation 7 `navigate("List")`
 * da `Detail` SPINGE una seconda `List` (navigate torna indietro solo sulla
 * schermata corrente): l'indietro dell'hub deve togliere `Detail`, non
 * aggiungere schermate.
 */
describe("hub di progetto — l'indietro torna all'elenco senza duplicarlo", () => {
  beforeEach(clearAppCache);

  function projectsRoutes(): string[] {
    const main = navigationRef.getRootState()?.routes[0]?.state as
      | { routes: { name: string; state?: { routes: { name: string }[] } }[] }
      | undefined;
    const projects = main?.routes.find((route) => route.name === "Projects");
    return (projects?.state?.routes ?? []).map((route) => route.name);
  }

  test("dall'elenco all'hub e indietro: nello stack resta UNA sola List", async () => {
    mockSession("admin");
    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );
    await waitFor(() => expect(navigationRef.isReady()).toBe(true));
    await act(async () => {
      navigationRef.navigate("Main", { screen: "Projects", params: { screen: "List" } });
    });
    await act(async () => {
      navigationRef.navigate("Main", {
        screen: "Projects",
        params: { screen: "Detail", params: { id: HUB_PROJECT_ID } },
      });
    });
    await waitFor(() => expect(screen.getByText("Portale B2B")).toBeTruthy());
    expect(projectsRoutes()).toEqual(["List", "Detail"]);

    await fireEvent.press(screen.getByTestId("screen-header-back"));
    await waitFor(() => expect(projectsRoutes()).toEqual(["List"]));
  });
});

/**
 * IL RITORNO SU UNA SCHERMATA RICARICA CIÒ CHE È SCADUTO, E SOLO QUELLO
 * (23 set 2026, design §3). Albero vero: la regola vive in `RootNavigator`,
 * sull'`onStateChange` del `NavigationContainer`, e solo il navigatore vero
 * la fa scattare.
 */
describe("l'app non resta indietro — il ritorno su una schermata", () => {
  beforeEach(clearAppCache);

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * ⚠️ Timer FINTI, e non un `Date.now` spostato: una query montata diventa
   * «scaduta» quando scatta un TIMER interno dell'osservatore (dopo lo
   * `staleTime`), non quando l'orologio lo dice. Spostare solo l'orologio
   * lascia la query fresca, e il test fallirebbe per un motivo che sul
   * telefono non esiste — dove il timer scatta davvero.
   */
  test("tornando all'hub dopo lo `staleTime`, il polso si ricarica", async () => {
    jest.useFakeTimers();
    mockSession("member");
    await openHub();
    // Dettaglio v3: l'elenco dei ticket si apre dalla tab Lavoro.
    await waitFor(() => expect(screen.getByTestId("hub-tab-work")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("hub-tab-work"));
    await waitFor(() => expect(screen.getByTestId("hub-work-tickets-all")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("hub-work-tickets-all"));
    await waitFor(() => expect(screen.getByTestId("screen-header-back")).toBeTruthy());
    const before = pulseCalls;

    // Il tempo passa mentre si è nella schermata figlia: il polso (10 s di
    // `staleTime`) diventa vecchio, ma l'hub resta montato sotto. Meno del
    // minuto dell'intervallo, che altrimenti lo ricaricherebbe da sé.
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    expect(pulseCalls).toBe(before);

    await fireEvent.press(screen.getByTestId("screen-header-back"));
    await waitFor(() => expect(pulseCalls).toBe(before + 1));
  });

  test("tornando all'hub SUBITO, il polso non si ricarica: è ancora fresco", async () => {
    mockSession("member");
    await openHub();
    // Dettaglio v3: l'elenco dei ticket si apre dalla tab Lavoro.
    await waitFor(() => expect(screen.getByTestId("hub-tab-work")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("hub-tab-work"));
    await waitFor(() => expect(screen.getByTestId("hub-work-tickets-all")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("hub-work-tickets-all"));
    await waitFor(() => expect(screen.getByTestId("screen-header-back")).toBeTruthy());
    const before = pulseCalls;

    await fireEvent.press(screen.getByTestId("screen-header-back"));
    await waitFor(() => expect(screen.getByTestId("hub-work-tickets-all")).toBeTruthy());
    // Una lettura in più avrebbe tempo di partire: si aspetta un giro.
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 50);
      });
    });
    expect(pulseCalls).toBe(before);
  });
});

/**
 * LA BARRA DELLE SCHEDE (25 set 2026, «Wisey, anteprima nell'app» §2).
 *
 * Si legge dalle props del componente NATIVO della barra, non da una
 * costante: è quello che iOS riceve davvero, quindi il test prova il
 * cablaggio e non una lista tenuta accanto al codice.
 */
describe("la barra delle schede", () => {
  type NativeTabItem = { key: string; title: string; iconRenderingMode?: string };

  async function renderMain() {
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
      username: "stubwise-session",
      password: JSON.stringify({
        baseUrl: "https://stubwise.example",
        token: "stw_pat_existing",
        patId: "66666666-6666-4666-8666-666666666666",
        user: successUser,
      }),
      service: "com.app.aleloca.stubwise.session",
      storage: "keychain",
    });
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(undefined);
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));
    await render(
      <AppProviders>
        <RootNavigator />
      </AppProviders>,
    );
    let bar: { props: { items: NativeTabItem[]; icons: unknown[] } } | undefined;
    await waitFor(() => {
      bar = screen.container.queryAll(
        (node) => Array.isArray(node.props.items) && Array.isArray(node.props.icons),
      )[0] as unknown as typeof bar;
      expect(bar).toBeDefined();
    });
    return bar!;
  }

  test("cinque schede, Wisey al CENTRO: il tab DOC non c'è più", async () => {
    const bar = await renderMain();
    // La chiave di rotta, non il titolo: Wisey non ha un titolo (qui sotto).
    expect(bar.props.items.map((item) => item.key.split("-")[0])).toEqual([
      "Inbox",
      "Projects",
      "Wisey",
      "Backlog",
      "Agents",
    ]);
  });

  /**
   * La tab Wisey SENZA nome sotto il gufo (25 set 2026, scelta del
   * maintainer). Nella libreria l'etichetta di accessibilità È il titolo
   * (`TabViewImpl.swift:238`), quindi VoiceOver non la nomina: accettato.
   */
  test("la tab Wisey ha il titolo VUOTO; le altre quattro tengono il loro", async () => {
    const bar = await renderMain();
    expect(bar.props.items.map((item) => item.title)).toEqual(["INB", "PRJ", "", "BLG", "AGT"]);
  });

  /**
   * Design §11: la tab nativa di Wisey resta (le altre quattro tengono il
   * loro posto) ma la copre il cerchio nostro — la sua icona è TRASPARENTE.
   */
  test("la tab nativa di Wisey ha un'icona trasparente; le altre restano SF Symbol", async () => {
    const bar = await renderMain();
    const wisey = bar.props.items.findIndex((item) => item.key.startsWith("Wisey"));
    expect(bar.props.icons[wisey]).toEqual(WISEY_TAB_ICON);
    expect(JSON.stringify(bar.props.icons[wisey])).toContain("wisey-tab-empty");
  });


  /**
   * IL CERCHIO CHE SPORGE (design §11): posato sopra la barra, agganciato
   * all'altezza VERA della barra, che la libreria dà solo dentro le scene —
   * la porta fuori un riportatore nella scena di Inbox.
   */
  describe("il cerchio di Wisey sopra la barra", () => {
    afterEach(() => {
      (useBottomTabBarHeight as jest.Mock).mockReturnValue(0);
    });

    test("con la barra misurata compare, e il tap apre la pagina di Wisey", async () => {
      (useBottomTabBarHeight as jest.Mock).mockReturnValue(83);
      await renderMain();
      // La scena di Wisey è pigra: prima del tap non esiste.
      expect(screen.queryByTestId("wisey-input")).toBeNull();
      const button = await screen.findByRole("button", { name: "Wisey" });
      await fireEvent.press(button);
      await waitFor(() => expect(screen.getByTestId("wisey-input")).toBeTruthy());
    });

    test("senza misura (0) non compare", async () => {
      await renderMain();
      expect(screen.queryByTestId("wisey-tab-button")).toBeNull();
    });

    /**
     * ⚠️ Le scene sono PIGRE: si montano quando le visiti. Un deep link apre
     * l'app su un'altra tab, e se Inbox non si montasse il riportatore non
     * scriverebbe mai l'altezza — il cerchio resterebbe nascosto. Per questo
     * la tab Inbox ha `lazy: false`.
     */
    test("anche aprendo l'app da un deep link su un'altra tab il cerchio compare", async () => {
      (useBottomTabBarHeight as jest.Mock).mockReturnValue(83);
      (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
        username: "stubwise-session",
        password: JSON.stringify({
          baseUrl: "https://stubwise.example",
          token: "stw_pat_existing",
          patId: "66666666-6666-4666-8666-666666666666",
          user: successUser,
        }),
        service: "com.app.aleloca.stubwise.session",
        storage: "keychain",
      });
      (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://mail/email/xyz");
      jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));
      await render(
        <AppProviders>
          <RootNavigator />
        </AppProviders>,
      );
      await waitFor(() => expect(screen.getByTestId("mail-detail-screen")).toBeTruthy());
      // Dal piano C la posta non è più una tab: sta sul root stack, SOPRA le
      // schede (preflight H1). Le schede sono montate sotto — è ciò che rende
      // possibile il ritorno —, quindi il cerchio esiste già, nascosto dalla
      // posta; tornando indietro si vede.
      expect(await screen.findByTestId("wisey-tab-button", { includeHiddenElements: true })).toBeTruthy();
      await act(async () => {
        navigationRef.goBack();
      });
      expect(await screen.findByTestId("wisey-tab-button")).toBeTruthy();
    });

    /** La stessa prova su una TAB vera diversa da Inbox, ora che la posta non lo è più. */
    test("aprendo l'app da un deep link sulla tab AGT il cerchio compare", async () => {
      (useBottomTabBarHeight as jest.Mock).mockReturnValue(83);
      (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
        username: "stubwise-session",
        password: JSON.stringify({
          baseUrl: "https://stubwise.example",
          token: "stw_pat_existing",
          patId: "66666666-6666-4666-8666-666666666666",
          user: successUser,
        }),
        service: "com.app.aleloca.stubwise.session",
        storage: "keychain",
      });
      (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://agents");
      jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));
      await render(
        <AppProviders>
          <RootNavigator />
        </AppProviders>,
      );
      await waitFor(() => expect(screen.getByTestId("agents-screen")).toBeTruthy());
      expect(await screen.findByTestId("wisey-tab-button")).toBeTruthy();
    });
  });
});

/**
 * LA SESSIONE DI UN AGENTE SUL ROOT STACK (9 ott 2026, chat della sessione,
 * Task A1): la sessione si apre SOPRA le schede, senza la barra in basso,
 * come la posta (`RootStackParamList.Mail`) — da Inbox, Progetti, AGT, dal
 * ticket e dalla push —, e «indietro» torna da dove si era venuti. Il deep
 * link a freddo mette le schede SOTTO (`initialRouteName: "Main"`).
 *
 * Il ticket aperto DALLA sessione si apre anche lui sul root stack, sopra la
 * sessione (preflight M7: indietro torna alla sessione).
 *
 * `useBottomTabBarHeight` qui è quello VERO (il resto della suite lo mocka a
 * 0): una schermata sul root stack che lo chiamasse lancerebbe, come sul
 * telefono. Dentro le schede il `TabView` lo fornisce (parte da 0).
 */
describe("la sessione di un agente", () => {
  beforeEach(() => {
    clearAppCache();
    FakeXhr.reset();
    (useBottomTabBarHeight as jest.Mock).mockImplementation(
      jest.requireActual("react-native-bottom-tabs").useBottomTabBarHeight,
    );
  });

  afterEach(() => {
    (useBottomTabBarHeight as jest.Mock).mockImplementation(() => 0);
  });

  async function renderApp() {
    await render(
      <AgentSessionStreamContext.Provider value={{ createXhr: FakeXhr.create, backoffMs: () => 60_000 }}>
        <AppProviders>
          <RootNavigator />
        </AppProviders>
      </AgentSessionStreamContext.Provider>,
    );
  }

  /** I nomi delle rotte del ROOT stack. */
  function rootRoutes(): string[] {
    return (navigationRef.getRootState()?.routes ?? []).map((route) => route.name);
  }

  /** La rotta in cima al root stack. */
  function topRoute(): string | undefined {
    const state = navigationRef.getRootState();
    return state?.routes[state.index]?.name;
  }

  /** I nomi delle rotte dello stack di una scheda. */
  function tabStackRoutes(tab: "Inbox" | "Projects" | "Agents"): string[] {
    const main = navigationRef.getRootState()?.routes.find((route) => route.name === "Main")?.state as
      | { routes: { name: string; state?: { routes: { name: string }[] } }[] }
      | undefined;
    const stack = main?.routes.find((route) => route.name === tab);
    return (stack?.state?.routes ?? []).map((route) => route.name);
  }

  /** La scheda attiva dentro `Main`. */
  function activeTab(): string | undefined {
    const main = navigationRef.getRootState()?.routes.find((route) => route.name === "Main")?.state as
      | { index: number; routes: { name: string }[] }
      | undefined;
    return main === undefined ? undefined : main.routes[main.index]?.name;
  }

  function topBackButton() {
    const buttons = screen.getAllByTestId("screen-header-back");
    return buttons[buttons.length - 1]!;
  }

  test("stubwise://agents/:id a freddo: la sessione sul root stack, le schede SOTTO, e lo stream parte", async () => {
    mockSession("admin");
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(`stubwise://agents/${AGENT_SESSION_ID}`);
    await renderApp();

    await waitFor(() => expect(screen.getByTestId("agent-session-screen")).toBeTruthy());
    expect(await screen.findByText("Aggiungo il CSV")).toBeTruthy();
    expect(rootRoutes()).toEqual(["Main", "AgentSession"]);
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    expect(FakeXhr.instances[0]!.after).toBe("1");

    // Indietro: le schede che stavano sotto.
    await fireEvent.press(topBackButton());
    await waitFor(() => expect(rootRoutes()).toEqual(["Main"]));
  });

  test("stubwise://agents/:id SENZA sessione: dopo il login la sessione sul root stack, sopra le schede", async () => {
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue(false);
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(`stubwise://agents/${AGENT_SESSION_ID}`);
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));
    await renderApp();

    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("login-url"), "stubwise.example");
    await fireEvent.changeText(screen.getByTestId("login-email"), "giulia@farmakom.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "hunter2");
    await fireEvent.press(screen.getByTestId("login-submit"));
    await waitFor(() => expect(screen.getByTestId("onboarding-later")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("onboarding-later"));

    await waitFor(() => expect(screen.getByTestId("agent-session-screen")).toBeTruthy());
    expect(rootRoutes()).toEqual(["Main", "AgentSession"]);
  });

  /** Il link vivo che arriva a un'app già aperta (`Linking.addEventListener`). */
  async function openLiveLink(url: string) {
    await waitFor(() => expect(navigationRef.isReady()).toBe(true));
    const urlListener = (Linking.addEventListener as jest.Mock).mock.calls.find(([type]) => type === "url")?.[1] as
      | ((event: { url: string }) => void)
      | undefined;
    expect(urlListener).toBeDefined();
    await act(async () => {
      urlListener!({ url });
    });
  }

  /**
   * Piano C, Task 8 (preflight H2/H3): la push di una domanda apre
   * `stubwise://inbox/<id>?session=1`, e la card si SOSTITUISCE con la
   * sessione. Ora la sessione sta sul root stack: la card esce dallo stack
   * dell'Inbox (non resta sotto la sessione), e indietro torna alla lista.
   */
  test("stubwise://inbox/:id?session=1 (link vivo): la card si sostituisce con la sessione, indietro torna alla lista", async () => {
    mockSession("admin");
    inboxItems = [questionNotification()];
    await renderApp();
    await openLiveLink(`stubwise://inbox/${QUESTION_NOTIFICATION_ID}?session=1`);

    await waitFor(() => expect(screen.getByTestId("agent-session-screen")).toBeTruthy());
    await waitFor(() => expect(tabStackRoutes("Inbox")).toEqual(["List"]));
    expect(rootRoutes()).toEqual(["Main", "AgentSession"]);

    await fireEvent.press(topBackButton());
    await waitFor(() => expect(rootRoutes()).toEqual(["Main"]));
    expect(activeTab()).toBe("Inbox");
    expect(tabStackRoutes("Inbox")).toEqual(["List"]);
  });

  test("lo stesso link SENZA sessione: dopo il login si apre la sessione, e la card non resta sotto", async () => {
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue(false);
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(`stubwise://inbox/${QUESTION_NOTIFICATION_ID}?session=1`);
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => routeFetch(input, init));
    inboxItems = [questionNotification()];
    await renderApp();

    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("login-url"), "stubwise.example");
    await fireEvent.changeText(screen.getByTestId("login-email"), "giulia@farmakom.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "hunter2");
    await fireEvent.press(screen.getByTestId("login-submit"));
    await waitFor(() => expect(screen.getByTestId("onboarding-later")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("onboarding-later"));

    await waitFor(() => expect(screen.getByTestId("agent-session-screen")).toBeTruthy());
    await waitFor(() => expect(tabStackRoutes("Inbox")).toEqual(["List"]));
    expect(rootRoutes()).toEqual(["Main", "AgentSession"]);
  });

  test("server senza sessioni: la push apre comunque la card, come prima (Review Focus 5)", async () => {
    mockSession("admin");
    inboxItems = [questionNotification()];
    agentSessionsAvailable = false;
    await renderApp();
    await openLiveLink(`stubwise://inbox/${QUESTION_NOTIFICATION_ID}?session=1`);

    await waitFor(() => expect(screen.getByTestId("question-card")).toBeTruthy());
    // La ricerca è avvenuta (e ha preso il 404): la card resta lo stesso.
    await waitFor(() =>
      expect(
        (globalThis.fetch as jest.Mock).mock.calls.some(([input]) => String(input).includes("/api/agent-sessions?aiJobId=")),
      ).toBe(true),
    );
    await act(async () => {});
    expect(screen.queryByTestId("agent-session-screen")).toBeNull();
    expect(tabStackRoutes("Inbox")).toEqual(["List", "Card"]);
    expect(rootRoutes()).toEqual(["Main"]);
  });

  test("a freddo, una push senza sessione apre la card, e indietro torna alla lista", async () => {
    mockSession("admin");
    inboxItems = [questionNotification()];
    agentSessionsAvailable = false;
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(`stubwise://inbox/${QUESTION_NOTIFICATION_ID}?session=1`);
    await renderApp();

    await waitFor(() => expect(screen.getByTestId("question-card")).toBeTruthy());
    expect(tabStackRoutes("Inbox")).toEqual(["List", "Card"]);
    await fireEvent.press(screen.getByTestId("inbox-card-back"));
    await waitFor(() => expect(tabStackRoutes("Inbox")).toEqual(["List"]));
  });

  test("«Apri» di una domanda già risposta, dalla card: la sessione sul root stack, la ricerca per job non resta sotto", async () => {
    mockSession("admin");
    inboxItems = [{ ...questionNotification(), actions: ["open"] }];
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(`stubwise://inbox/${QUESTION_NOTIFICATION_ID}`);
    await renderApp();

    await fireEvent.press(await screen.findByTestId("question-card-open"));
    await waitFor(() => expect(screen.getByTestId("agent-session-screen")).toBeTruthy());
    expect(rootRoutes()).toEqual(["Main", "AgentSession"]);
    // `AgentSessionByJob` è uscita dallo stack: la card resta, sotto la sessione.
    await waitFor(() => expect(tabStackRoutes("Inbox")).toEqual(["List", "Card"]));

    await fireEvent.press(topBackButton());
    await waitFor(() => expect(rootRoutes()).toEqual(["Main"]));
    expect(activeTab()).toBe("Inbox");
    expect(screen.getByTestId("question-card")).toBeTruthy();
  });

  test("AGT → sessione → ticket → indietro → indietro: sessione e ticket sul root stack, poi di nuovo AGT", async () => {
    mockSession("admin");
    (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://agents");
    await renderApp();

    await fireEvent.press(await screen.findByTestId(`agent-row-${AGENT_SESSION_ID}`));
    await waitFor(() => expect(screen.getByTestId("agent-session-screen")).toBeTruthy());
    expect(rootRoutes()).toEqual(["Main", "AgentSession"]);
    expect(tabStackRoutes("Agents")).toEqual(["List"]);

    await fireEvent.press(await screen.findByTestId("agent-session-ticket"));
    await waitFor(() => expect(rootRoutes()).toEqual(["Main", "AgentSession", "Ticket"]));
    // Il ticket dice che indietro si torna alla sessione.
    expect(await screen.findByText("‹ Sessione")).toBeTruthy();

    await fireEvent.press(topBackButton());
    await waitFor(() => expect(rootRoutes()).toEqual(["Main", "AgentSession"]));
    expect(screen.getByTestId("agent-session-screen")).toBeTruthy();

    await fireEvent.press(topBackButton());
    await waitFor(() => expect(rootRoutes()).toEqual(["Main"]));
    expect(activeTab()).toBe("Agents");
    expect(tabStackRoutes("Agents")).toEqual(["List"]);
  });

  test("ticket (Progetti) → sessione → indietro: torna al ticket, nello stack dei Progetti", async () => {
    mockSession("admin");
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(`stubwise://tickets/${PLAN_TICKET_ID}`);
    await renderApp();

    await fireEvent.press(await screen.findByTestId("work-session-link"));
    await waitFor(() => expect(screen.getByTestId("agent-session-screen")).toBeTruthy());
    expect(rootRoutes()).toEqual(["Main", "AgentSession"]);
    expect(tabStackRoutes("Projects")).toEqual(["Ticket"]);

    await fireEvent.press(topBackButton());
    await waitFor(() => expect(rootRoutes()).toEqual(["Main"]));
    expect(topRoute()).toBe("Main");
    expect(activeTab()).toBe("Projects");
    expect(tabStackRoutes("Projects")).toEqual(["Ticket"]);
    expect(screen.getByTestId("work-session-link")).toBeTruthy();
  });

  /**
   * Fix round 1 (review A1, Minor 1): il `pop` della card ha come BERSAGLIO il
   * suo stack. Con la card PRIMA del suo stack (indice 0) quel `pop` non ha
   * niente da togliere: senza bersaglio salirebbe al root e chiuderebbe la
   * sessione appena aperta.
   */
  test("card all'indice 0 del suo stack: la sessione si apre e RESTA (il pop non sale al root)", async () => {
    mockSession("admin");
    inboxItems = [questionNotification()];
    await renderApp();
    await waitFor(() => expect(navigationRef.isReady()).toBe(true));
    await act(async () => {
      navigationRef.reset({
        index: 0,
        routes: [
          {
            name: "Main",
            state: {
              routes: [{ name: "Inbox", state: { routes: [{ name: "Card", params: { id: QUESTION_NOTIFICATION_ID, session: true } }] } }],
            },
          },
        ],
      } as never);
    });

    await waitFor(() => expect(screen.getByTestId("agent-session-screen")).toBeTruthy());
    await act(async () => {});
    expect(rootRoutes()).toEqual(["Main", "AgentSession"]);
    expect(topRoute()).toBe("AgentSession");
  });

  /**
   * Fix round 1 (Minor 5): riaprire la STESSA sessione dal suo ticket non
   * impila un doppione — si torna a quella che c'è (`getId` + `pop: true`).
   */
  test("sessione → ticket → la stessa sessione: si torna a quella, nessun doppione", async () => {
    mockSession("admin");
    (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://agents");
    await renderApp();

    await fireEvent.press(await screen.findByTestId(`agent-row-${AGENT_SESSION_ID}`));
    await fireEvent.press(await screen.findByTestId("agent-session-ticket"));
    await waitFor(() => expect(rootRoutes()).toEqual(["Main", "AgentSession", "Ticket"]));

    await fireEvent.press(await screen.findByTestId("work-session-link"));
    await waitFor(() => expect(rootRoutes()).toEqual(["Main", "AgentSession"]));
    expect(screen.getByTestId("agent-session-screen")).toBeTruthy();
  });

  /** Fix round 1 (Minor 4): la push arriva mentre si guarda un ticket aperto dall'Inbox. */
  test("push mentre si è su Inbox → ticket: la sessione sopra, e indietro torna al ticket", async () => {
    mockSession("admin");
    inboxItems = [questionNotification()];
    (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://inbox");
    await renderApp();
    await waitFor(() => expect(navigationRef.isReady()).toBe(true));
    await act(async () => {
      navigationRef.navigate("Main", { screen: "Inbox", params: { screen: "Ticket", params: { id: PLAN_TICKET_ID } } });
    });
    await waitFor(() => expect(tabStackRoutes("Inbox")).toEqual(["List", "Ticket"]));

    await openLiveLink(`stubwise://inbox/${QUESTION_NOTIFICATION_ID}?session=1`);
    await waitFor(() => expect(screen.getByTestId("agent-session-screen")).toBeTruthy());
    await waitFor(() => expect(tabStackRoutes("Inbox")).toEqual(["List", "Ticket"]));
    expect(rootRoutes()).toEqual(["Main", "AgentSession"]);

    await fireEvent.press(topBackButton());
    await waitFor(() => expect(rootRoutes()).toEqual(["Main"]));
    expect(activeTab()).toBe("Inbox");
    expect(tabStackRoutes("Inbox")).toEqual(["List", "Ticket"]);
  });

  /** Fix round 1 (Minor 4): «Apri» di una domanda dall'inbox di un PROGETTO, nella scheda Progetti. */
  test("dall'inbox di un progetto: la sessione sopra, e indietro torna all'inbox del progetto", async () => {
    mockSession("admin");
    projectInboxItems = [{ ...questionNotification(), projectId: HUB_PROJECT_ID, actions: ["open"] }];
    (Linking.getInitialURL as jest.Mock).mockResolvedValue("stubwise://projects");
    await renderApp();
    await waitFor(() => expect(navigationRef.isReady()).toBe(true));
    await act(async () => {
      navigationRef.navigate("Main", {
        screen: "Projects",
        params: { screen: "ProjectInbox", params: { projectId: HUB_PROJECT_ID, projectName: "Farmakom" } },
      });
    });

    await fireEvent.press(await screen.findByTestId("question-card-open"));
    await waitFor(() => expect(screen.getByTestId("agent-session-screen")).toBeTruthy());
    expect(rootRoutes()).toEqual(["Main", "AgentSession"]);
    await waitFor(() => expect(tabStackRoutes("Projects")).toEqual(["List", "ProjectInbox"]));

    await fireEvent.press(topBackButton());
    await waitFor(() => expect(rootRoutes()).toEqual(["Main"]));
    expect(activeTab()).toBe("Projects");
    expect(tabStackRoutes("Projects")).toEqual(["List", "ProjectInbox"]);
  });

  /**
   * Fix round 1 (Minor 4): la push di una domanda arriva mentre una sessione
   * (un'altra) è già aperta. Il link porta prima a `Main` (`pop: true`, come
   * per la posta): la sessione aperta si chiude, si apre la nuova, e indietro
   * torna alle schede — non alla vecchia sessione.
   */
  test("push mentre un'altra sessione è aperta: si vede la nuova, e indietro torna alle schede", async () => {
    mockSession("admin");
    inboxItems = [questionNotification()];
    const OTHER_ID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(`stubwise://agents/${AGENT_SESSION_ID}`);
    // L'altra sessione: la ricerca per job della push trova QUELLA.
    const base = (globalThis.fetch as jest.Mock).getMockImplementation()!;
    (globalThis.fetch as jest.Mock).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agent-sessions?aiJobId=")) {
        return jsonResponse(200, { live: [{ ...AGENT_SESSION_SUMMARY, id: OTHER_ID }], recent: [] });
      }
      if (url.includes(`/api/agent-sessions/${OTHER_ID}/events`)) return jsonResponse(200, AGENT_SESSION_EVENTS);
      if (url.endsWith(`/api/agent-sessions/${OTHER_ID}`)) return jsonResponse(200, { ...AGENT_SESSION_DETAIL, id: OTHER_ID });
      return base(input, init);
    });
    await renderApp();
    await waitFor(() => expect(screen.getByTestId("agent-session-screen")).toBeTruthy());
    expect(rootRoutes()).toEqual(["Main", "AgentSession"]);

    await openLiveLink(`stubwise://inbox/${QUESTION_NOTIFICATION_ID}?session=1`);
    await waitFor(() => {
      const state = navigationRef.getRootState()!;
      expect(state.routes.map((route) => route.name)).toEqual(["Main", "AgentSession"]);
      expect((state.routes[1]!.params as { id: string }).id).toBe(OTHER_ID);
    });
    await waitFor(() => expect(tabStackRoutes("Inbox")).toEqual(["List"]));

    await fireEvent.press(topBackButton());
    await waitFor(() => expect(rootRoutes()).toEqual(["Main"]));
    expect(activeTab()).toBe("Inbox");
  });

  /**
   * Fix round 1 (Minor 5, il verso opposto): una sessione DIVERSA si spinge
   * sopra — il `getId` della rotta distingue le sessioni, e senza il link
   * riuserebbe la rotta in cima cambiandole l'id (la prima andrebbe persa).
   */
  test("sessione aperta, link a un'ALTRA sessione: si impila sopra, e indietro torna alla prima", async () => {
    mockSession("admin");
    const OTHER_ID = "efefefef-efef-4fef-8fef-efefefefefef";
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(`stubwise://agents/${AGENT_SESSION_ID}`);
    const base = (globalThis.fetch as jest.Mock).getMockImplementation()!;
    (globalThis.fetch as jest.Mock).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/api/agent-sessions/${OTHER_ID}/events`)) return jsonResponse(200, AGENT_SESSION_EVENTS);
      if (url.endsWith(`/api/agent-sessions/${OTHER_ID}`)) return jsonResponse(200, { ...AGENT_SESSION_DETAIL, id: OTHER_ID });
      return base(input, init);
    });
    await renderApp();
    await waitFor(() => expect(screen.getByTestId("agent-session-screen")).toBeTruthy());

    await openLiveLink(`stubwise://agents/${OTHER_ID}`);
    const ids = () =>
      (navigationRef.getRootState()?.routes ?? []).map((route) =>
        route.name === "AgentSession" ? (route.params as { id: string }).id : route.name,
      );
    await waitFor(() => expect(ids()).toEqual(["Main", AGENT_SESSION_ID, OTHER_ID]));

    await fireEvent.press(topBackButton());
    await waitFor(() => expect(ids()).toEqual(["Main", AGENT_SESSION_ID]));
  });
});
