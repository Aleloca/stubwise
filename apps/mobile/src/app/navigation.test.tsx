import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import NetInfo from "@react-native-community/netinfo";
import { Linking } from "react-native";
import * as Keychain from "react-native-keychain";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import "../i18n";
import { AppProviders, queryClient } from "./providers";
import { navigationRef, RootNavigator } from "./navigation";
import { setPendingDeepLink } from "./linking";
import { WISEY_TAB_FRAMES } from "./wisey-tab-icon";
import { WISEY_CYCLE_MS } from "../lib/wisey-phase";

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
  };
}

/**
 * Quante notifiche aperte ha il progetto dell'hub. È MUTABILE apposta: il
 * test più sotto preme «Fatto» su una card e il server, dal giro seguente,
 * ne conta una in meno — è l'unico modo perché la schermata possa mostrare
 * un numero DIVERSO, cioè perché l'asserzione significhi qualcosa.
 */
let hubOpenNotifications = 2;

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
    return jsonResponse(200, { items: [], nextCursor: null });
  }
  if (url.endsWith("/api/inbox/unread-count") && method === "GET") {
    return jsonResponse(200, { count: 0 });
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
  if (
    method === "GET" &&
    (url.endsWith(`/api/tickets/${PLAN_TICKET_ID}/questions`) ||
      url.endsWith(`/api/tickets/${PLAN_TICKET_ID}/activity`) ||
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
  if (method === "GET" && url.includes("/docs/pages/")) {
    return jsonResponse(200, DOC_PAGE);
  }
  if (method === "GET" && url.includes("/docs/tree")) {
    return jsonResponse(200, [DOC_TREE_NODE]);
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
    await waitFor(() => expect(screen.getByText("Notifiche · 2 da gestire")).toBeTruthy());

    // Entro dall'hub, come farebbe chi tocca «vedi ›».
    await fireEvent.press(screen.getByTestId("hub-inbox-see-all"));
    await waitFor(() => expect(screen.getAllByTestId("pr-ready-card-handled").length).toBe(2));

    // La mutazione VERA: `useHandled` invalida `inboxKeys.all`, e non sa —
    // né deve sapere — che esiste una sezione dell'hub.
    await fireEvent.press(screen.getAllByTestId("pr-ready-card-handled")[0]!);
    await waitFor(() => expect(screen.getAllByTestId("pr-ready-card-handled").length).toBe(1));

    // Torno indietro: l'hub non è stato rimontato, quindi il numero nuovo
    // può arrivare SOLO da un'invalidazione che ha raggiunto la sua query.
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    await waitFor(() => expect(screen.getByText("Notifiche · 1 da gestire")).toBeTruthy());
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
    await waitFor(() => expect(screen.getByTestId(`project-docs-space-${DOC_REPOSITORY_ID}`)).toBeTruthy());

    await fireEvent.press(screen.getByTestId(`project-docs-space-${DOC_REPOSITORY_ID}`));
    await waitFor(() => expect(screen.getByTestId(`project-docs-browse-${DOC_REPOSITORY_ID}-functional`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`project-docs-browse-${DOC_REPOSITORY_ID}-functional`));
    await waitFor(() => expect(screen.getByText("Guida all'API")).toBeTruthy());

    await fireEvent.press(screen.getByText("Guida all'API"));
    await waitFor(() => expect(screen.getByTestId("docs-page-body")).toBeTruthy());

    // ⚠️ La scheda in basso non si è mossa: se il tap fosse uscito dallo
    // stack saremmo nel tab DOC, che si riconosce dal suo switcher di
    // progetto — qui non deve esserci.
    expect(screen.queryByTestId("docs-project-toggle")).toBeNull();

    await fireEvent.press(screen.getByTestId("screen-header-back"));
    await waitFor(() => expect(screen.getByTestId(`project-docs-space-${DOC_REPOSITORY_ID}`)).toBeTruthy());
    expect(screen.queryByTestId("docs-project-toggle")).toBeNull();
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

    await waitFor(() => expect(screen.getByText("Aspetta qualcuno · 1")).toBeTruthy());
    await fireEvent.press(screen.getByText("Export CSV degli ordini"));

    await waitFor(() => expect(screen.getByTestId("plan-section-approve")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("plan-section-approve"));
    await waitFor(() => expect(screen.getByTestId("plan-section-approve-confirm")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("plan-section-approve-confirm"));
    await waitFor(() => expect(planAwaitingApproval).toBe(false));

    await fireEvent.press(screen.getByTestId("screen-header-back"));
    await waitFor(() => expect(screen.queryByText("Aspetta qualcuno · 1")).toBeNull());
    expect(screen.getByText("Portale B2B")).toBeTruthy();
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
    await waitFor(() => expect(screen.getByTestId("hub-tickets-see-all")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("hub-tickets-see-all"));
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
    await waitFor(() => expect(screen.getByTestId("hub-tickets-see-all")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("hub-tickets-see-all"));
    await waitFor(() => expect(screen.getByTestId("screen-header-back")).toBeTruthy());
    const before = pulseCalls;

    await fireEvent.press(screen.getByTestId("screen-header-back"));
    await waitFor(() => expect(screen.getByTestId("hub-tickets-see-all")).toBeTruthy());
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
      "Mbx",
    ]);
  });

  /**
   * La tab Wisey SENZA nome sotto il gufo (25 set 2026, scelta del
   * maintainer). Nella libreria l'etichetta di accessibilità È il titolo
   * (`TabViewImpl.swift:238`), quindi VoiceOver non la nomina: accettato.
   */
  test("la tab Wisey ha il titolo VUOTO; le altre quattro tengono il loro", async () => {
    const bar = await renderMain();
    expect(bar.props.items.map((item) => item.title)).toEqual(["INB", "PRJ", "", "BLG", "MBX"]);
  });

  test("il gufo è un'IMMAGINE a colori: rendering «original», le altre restano tinte dalla barra", async () => {
    const bar = await renderMain();
    const wisey = bar.props.items.findIndex((item) => item.key.startsWith("Wisey"));
    expect(bar.props.items[wisey]?.iconRenderingMode).toBe("original");
    // Il gufo della 5a (Classic), non Minimal: il maintainer l'ha scartato
    // dopo la prova sul telefono (25 set 2026). A riposo, primo fotogramma.
    // Misure e margine dei file li prova `scripts/wisey-assets.test.mjs`.
    expect(bar.props.icons[wisey]).toEqual(WISEY_TAB_FRAMES.rest[0]);
    expect(JSON.stringify(bar.props.icons[wisey])).not.toContain("owl-minimal");
    for (const item of bar.props.items.filter((i) => !i.key.startsWith("Wisey"))) {
      expect(item.iconRenderingMode).not.toBe("original");
    }
  });

  /**
   * L'icona si ANIMA (design §10): la barra nativa non anima immagini, quindi
   * riceve un'icona nuova a ogni fotogramma, sulla fase del gufo grande.
   */
  test("l'icona passata alla barra nativa avanza coi fotogrammi della fase", async () => {
    jest.useFakeTimers();
    const bar = await renderMain();
    const wisey = bar.props.items.findIndex((item) => item.key.startsWith("Wisey"));
    const iconNow = () =>
      (screen.container.queryAll((node) => Array.isArray(node.props.items) && Array.isArray(node.props.icons))[0]!
        .props.icons as unknown[])[wisey];
    expect(iconNow()).toEqual(WISEY_TAB_FRAMES.rest[0]);
    await act(async () => {
      jest.advanceTimersByTime(WISEY_CYCLE_MS.rest / 4);
    });
    expect(iconNow()).toEqual(WISEY_TAB_FRAMES.rest[1]);
    jest.useRealTimers();
  });

  test("l'icona segue lo stato di Wisey: scrivendo nella sua pagina, «ti ascolta»", async () => {
    const bar = await renderMain();
    const wisey = bar.props.items.findIndex((item) => item.key.startsWith("Wisey"));
    const iconNow = () =>
      (screen.container.queryAll((node) => Array.isArray(node.props.items) && Array.isArray(node.props.icons))[0]!
        .props.icons as unknown[])[wisey];
    await act(async () => {
      navigationRef.navigate("Main", { screen: "Wisey" });
    });
    await fireEvent.changeText(await screen.findByTestId("wisey-input"), "ciao");
    await waitFor(() => expect(iconNow()).toEqual(WISEY_TAB_FRAMES.listen[0]));
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
      expect(await screen.findByTestId("wisey-tab-button")).toBeTruthy();
    });
  });
});
