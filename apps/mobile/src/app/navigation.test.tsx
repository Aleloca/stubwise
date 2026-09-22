import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import NetInfo from "@react-native-community/netinfo";
import { Linking } from "react-native";
import * as Keychain from "react-native-keychain";
import "../i18n";
import { AppProviders } from "./providers";
import { navigationRef, RootNavigator } from "./navigation";
import { setPendingDeepLink } from "./linking";

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
