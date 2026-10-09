import type { StubwiseClient } from "@stubwise/api-client";
import type { ProjectPulseSummary, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import { Linking, StyleSheet } from "react-native";
import { ApiError } from "@stubwise/api-client";
import "../../i18n";
import { pullToRefresh } from "../../test-utils/pull-to-refresh";
import { ProjectDetailScreen } from "./ProjectDetailScreen";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TICKET_A = "22222222-2222-4222-8222-222222222222";
const TICKET_B = "33333333-3333-4333-8333-333333333333";

function summary(overrides: Partial<Reader<ProjectPulseSummary>> = {}): Reader<ProjectPulseSummary> {
  return {
    projectId: PROJECT_ID,
    projectName: "Portale B2B",
    waitingForYou: [],
    waitingForOthers: [],
    running: [],
    failedCount: 0,
    backlogReadyCount: 0,
    idleDays: 0,
    stalled: [],
    waitingForMerge: [],
    lastReportDate: null,
    ...overrides,
  };
}

/** Una riga della lista ticket, quanto basta a `ticketHeading` e alla riga. */
function ticket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TICKET_A,
    projectId: PROJECT_ID,
    number: 33,
    title: "Export CSV clienti",
    type: "bug",
    priority: "medium",
    status: "open",
    createdAt: "2026-09-20T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * ⚠️ IL DOPPIO DEL CLIENT VA COMPLETATO PRIMA DEI TEST CHE LO USANO
 * (CLAUDE.md, la terza trappola: un metodo mancante non fa fallire niente).
 * Questo `as unknown as StubwiseClient` AFFERMA di essere il client intero,
 * quindi il compilatore tace se `tickets`/`backlog`/`inbox` non ci sono — e
 * le tre sezioni dell'hub, che stanno fuori dai gate `isPending`/`isError`
 * della schermata apposta, mostrerebbero il proprio errore senza far
 * fallire un solo test. È successo davvero qui il 22 set 2026: i 24 test
 * passavano con tre query che fallivano tutte.
 */
/** Un repository come lo porta la proiezione sintetica di `projects.get`. */
function projectDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Il dettaglio di progetto COMPLETO (tappa 3): la sezione impostazioni ne
  // legge gli interruttori, e nei test `readerSchema` non gira — una fixture
  // a cui manca un campo arriva al componente così com'è (CLAUDE.md).
  return {
    id: PROJECT_ID,
    name: "Portale B2B",
    slug: "portale-b2b",
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    dailyReportEnabled: false,
    backlogEnabled: false,
    pulseEnabled: false,
    pulseEveryDays: 3,
    weeklyBriefEnabled: false,
    ingestionKey: "ik_test",
    nextTicketNumber: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    repositories: [],
    ...overrides,
  };
}

function server(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "s1",
    name: "prod-web-1",
    hostname: "web1.acme.test",
    status: "online",
    sampleIntervalSeconds: 30,
    agentVersion: "1.4.0",
    alertThresholds: { cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 },
    lastSeenAt: "2026-09-23T10:00:00.000Z",
    createdAt: "2026-08-01T10:00:00.000Z",
    projects: [{ id: PROJECT_ID, name: "Portale B2B" }],
    checksUp: 3,
    checksDown: 0,
    recentCpu: [10, 20],
    ...overrides,
  };
}

function repositorySummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Nome e slug DIVERSI apposta: è il caso reale, e due stringhe uguali
  // renderebbero il test cieco su quale delle due sta guardando.
  return { id: "r1", name: "Portale API", slug: "portale-api", provider: "github", ...overrides };
}

/** Uno spazio documentale come lo porta `docs.projectSpaces`. */
function docSpace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repositoryId: "r1",
    slug: "portale-api",
    name: "Spazio API",
    pageCount: 12,
    lastGenerationAt: null,
    lastCommitSha: null,
    ...overrides,
  };
}

/** Una milestone col suo avanzamento, come la porta `projects.milestones`. */
function milestone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m1",
    projectId: PROJECT_ID,
    name: "Lancio pilota",
    description: null,
    dueDate: "2026-10-15T00:00:00.000Z",
    status: "open",
    closedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    counts: { total: 8, completed: 3, byStatus: {} },
    ...overrides,
  };
}

function makeClient(
  overrides: {
    pulse?: jest.Mock;
    activityForDate?: jest.Mock;
    briefs?: jest.Mock;
    listTickets?: jest.Mock;
    listBacklog?: jest.Mock;
    listInbox?: jest.Mock;
    getProject?: jest.Mock;
    projectSpaces?: jest.Mock;
    milestones?: jest.Mock;
    listServers?: jest.Mock;
    release?: jest.Mock;
  } = {},
): StubwiseClient {
  return {
    projects: {
      pulse: overrides.pulse ?? jest.fn().mockResolvedValue([summary()]),
      briefs: overrides.briefs ?? jest.fn().mockResolvedValue([]),
      // ⚠️ I tre metodi della tappa 2 vanno nel doppio PRIMA dei test che li
      // usano (CLAUDE.md, la terza trappola): senza, le tre sezioni nuove
      // mostrerebbero il proprio errore — stanno fuori dai gate della
      // schermata apposta — e non un solo test fallirebbe.
      get: overrides.getProject ?? jest.fn().mockResolvedValue(projectDetail()),
      milestones: overrides.milestones ?? jest.fn().mockResolvedValue([]),
    },
    activity: { forDate: overrides.activityForDate ?? jest.fn().mockResolvedValue({ date: "2026-08-31", projects: [] }) },
    tickets: {
      list: overrides.listTickets ?? jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 }),
      // ⚠️ Il merge dall'app (28 set 2026): nel doppio PRIMA dei test che lo
      // usano, per la stessa ragione dei metodi della tappa 2.
      release: overrides.release ?? jest.fn().mockResolvedValue({ merged: true, sha: "abc123" }),
    },
    backlog: { list: overrides.listBacklog ?? jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 }) },
    inbox: { list: overrides.listInbox ?? jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 }) },
    docs: { projectSpaces: overrides.projectSpaces ?? jest.fn().mockResolvedValue([]) },
    // ⚠️ Tappa 3: nel doppio PRIMA dei test che lo usano. Senza, la sezione
    // monitor mostrerebbe il proprio errore — sta fuori dai gate della
    // schermata — e nessun test fallirebbe.
    servers: { list: overrides.listServers ?? jest.fn().mockResolvedValue([]) },
  } as unknown as StubwiseClient;
}

async function renderScreen(
  client: StubwiseClient,
  navigate: jest.Mock = jest.fn(),
  id: string = PROJECT_ID,
  popTo: jest.Mock = jest.fn(),
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "viewer-1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
  const navigation = { navigate, popTo } as never;
  // `await`: vedi il commento gemello in `ProjectsScreen.test.tsx`.
  const rendered = await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <ProjectDetailScreen navigation={navigation} route={{ key: "Detail", name: "Detail", params: { id } }} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { rendered, navigate };
}

beforeEach(() => jest.clearAllMocks());

describe("ProjectDetailScreen", () => {
  test("caricamento: mostra lo skeleton", async () => {
    const client = makeClient({ pulse: jest.fn(() => new Promise(() => {})) });
    const { rendered } = await renderScreen(client);
    expect(screen.getByTestId("project-detail-skeleton")).toBeTruthy();
    rendered.unmount();
  });

  test("errore: mostra Riprova, che ricarica", async () => {
    const pulse = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce([summary()]);
    const client = makeClient({ pulse });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("project-detail-error")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-detail-retry"));
    await waitFor(() => expect(screen.getByText("Portale B2B")).toBeTruthy());
  });

  test("id non presente nel polso: stato 'non trovato', non un errore", async () => {
    const client = makeClient({ pulse: jest.fn().mockResolvedValue([]) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("project-detail-not-found")).toBeTruthy());
  });

  // Fix di review (App M1+M2, Task 2, 11 set 2026): rete anti-regressione —
  // l'avatar (unico accesso alle Impostazioni) deve restare raggiungibile su
  // OGNI schermata post-login, incluse quelle di dettaglio come questa (prima
  // del fix ne era priva del tutto).
  test("le Impostazioni sono raggiungibili (avatar presente)", async () => {
    const client = makeClient();
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("settings-avatar-button")).toBeTruthy());
  });

  test("il tasto indietro torna a List con popTo, non ne spinge una seconda", async () => {
    const navigate = jest.fn();
    const popTo = jest.fn();
    const client = makeClient();
    await renderScreen(client, navigate, PROJECT_ID, popTo);
    await waitFor(() => expect(screen.getByText("Portale B2B")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(popTo).toHaveBeenCalledWith("List");
    expect(navigate).not.toHaveBeenCalledWith("List");
  });

  test("brief settimanale e report di ieri non compaiono nel dettaglio", async () => {
    const briefs = jest.fn().mockResolvedValue([]);
    const activityForDate = jest.fn();
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([summary({ lastReportDate: "2026-08-31" })]),
      briefs,
      activityForDate,
    });
    await renderScreen(client);
    // Nessuna delle tre tab li mostra (v3): si guarda in tutte.
    await waitFor(() => expect(screen.getByTestId("hub-panel-now")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("hub-tab-work"));
    await fireEvent.press(screen.getByTestId("hub-tab-project"));
    await waitFor(() => expect(screen.getByTestId("hub-project-settings")).toBeTruthy());
    expect(screen.queryByText("Brief settimanale")).toBeNull();
    expect(screen.queryByText("Report di ieri")).toBeNull();
    expect(screen.queryByTestId("project-detail-brief-toggle")).toBeNull();
    expect(briefs).not.toHaveBeenCalled();
    expect(activityForDate).not.toHaveBeenCalled();
  });
});

/**
 * TRASCINA PER AGGIORNARE, su ogni tab (design v3 §3): lo stesso gesto e le
 * stesse chiavi di prima. Ricarica ciò che la tab aperta sta mostrando — le
 * altre, non montate, si rileggono quando si aprono.
 */
describe("ProjectDetailScreen — trascina per aggiornare", () => {
  test("su Adesso ricarica il polso e i server", async () => {
    const pulse = jest.fn().mockResolvedValue([summary()]);
    const listServers = jest.fn().mockResolvedValue([]);
    await renderScreen(makeClient({ pulse, listServers }));
    await waitFor(() => expect(listServers).toHaveBeenCalledTimes(1));
    const pulseBefore = pulse.mock.calls.length;

    await pullToRefresh("project-detail-refresh");

    await waitFor(() => expect(pulse.mock.calls.length).toBe(pulseBefore + 1));
    await waitFor(() => expect(listServers).toHaveBeenCalledTimes(2));
  });

  test("su Lavoro ricarica ticket, backlog e notifiche", async () => {
    const listTickets = jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    const listBacklog = jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    const listInbox = jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    await renderScreen(makeClient({ listTickets, listBacklog, listInbox }));
    await waitFor(() => expect(screen.getByTestId("hub-tab-work")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("hub-tab-work"));
    await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(1));

    await pullToRefresh("project-detail-refresh");

    await waitFor(() => expect(listTickets).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listBacklog).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(2));
  });
});

/**
 * DETTAGLIO PROGETTO v3 — LE TRE TAB (28 set 2026, design §3).
 *
 * Adesso · Lavoro · Progetto. Si apre sempre su Adesso; la tab scelta resta
 * finché la schermata è montata. Il badge di Adesso conta «Tocca a te», il
 * pallino di Progetto dice che un server è giù.
 */
describe("ProjectDetailScreen v3 — le tre tab", () => {
  const tabSelected = (testID: string) => screen.getByTestId(testID).props.accessibilityState?.selected === true;

  test("si apre su Adesso", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("hub-tab-now")).toBeTruthy());
    expect(tabSelected("hub-tab-now")).toBe(true);
    expect(tabSelected("hub-tab-work")).toBe(false);
    expect(tabSelected("hub-tab-project")).toBe(false);
    expect(screen.getByTestId("hub-panel-now")).toBeTruthy();
    expect(screen.queryByTestId("hub-panel-work")).toBeNull();
  });

  test("premere una tab mostra il suo contenuto, e la scelta resta anche quando il polso si ricarica", async () => {
    const pulse = jest.fn().mockResolvedValue([summary()]);
    await renderScreen(makeClient({ pulse }));
    await waitFor(() => expect(screen.getByTestId("hub-tab-work")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("hub-tab-work"));
    expect(tabSelected("hub-tab-work")).toBe(true);
    expect(screen.getByTestId("hub-panel-work")).toBeTruthy();
    expect(screen.queryByTestId("hub-panel-now")).toBeNull();

    await pullToRefresh("project-detail-refresh");
    await waitFor(() => expect(pulse).toHaveBeenCalledTimes(2));
    expect(tabSelected("hub-tab-work")).toBe(true);

    await fireEvent.press(screen.getByTestId("hub-tab-project"));
    expect(screen.getByTestId("hub-panel-project")).toBeTruthy();
  });

  test("il badge di Adesso conta domande, piani e le PR che PUOI mergiare", async () => {
    const pulse = jest.fn().mockResolvedValue([
      summary({
        waitingForYou: [{ kind: "question", ticketId: TICKET_A, ticketNumber: 27, title: "Domanda", notificationId: "n1" }],
        waitingForMerge: [
          { ticketId: TICKET_B, ticketNumber: 38, title: "PR mia", prUrl: "https://example.com/pr/38", canMerge: true },
          { ticketId: TICKET_B, ticketNumber: 39, title: "PR d'altri", prUrl: "https://example.com/pr/39", canMerge: false },
        ],
      }),
    ]);
    await renderScreen(makeClient({ pulse }));
    await waitFor(() => expect(screen.getByTestId("hub-tab-now-badge")).toBeTruthy());
    expect(screen.getByTestId("hub-tab-now-badge")).toHaveTextContent("2");
  });

  test("a zero il badge non c'è", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("hub-tab-now")).toBeTruthy());
    expect(screen.queryByTestId("hub-tab-now-badge")).toBeNull();
  });

  test("il pallino di Progetto c'è quando un server del progetto è giù, e solo allora", async () => {
    const listServers = jest.fn().mockResolvedValue([server({ checksDown: 1 })]);
    await renderScreen(makeClient({ listServers }));
    await waitFor(() => expect(screen.getByTestId("hub-tab-project-alert")).toBeTruthy());
  });

  test("nessun pallino se i server sono su, né per un server mai connesso", async () => {
    const listServers = jest.fn().mockResolvedValue([server({}), server({ id: "s2", status: "never_connected" })]);
    await renderScreen(makeClient({ listServers }));
    await waitFor(() => expect(listServers).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("hub-tab-project")).toBeTruthy());
    expect(screen.queryByTestId("hub-tab-project-alert")).toBeNull();
  });

  test("nessun pallino se la lettura dei server fallisce, e la schermata resta intera", async () => {
    const failing = jest.fn().mockRejectedValue(new Error("down"));
    await renderScreen(makeClient({ listServers: failing }));
    await waitFor(() => expect(failing).toHaveBeenCalled());
    // Una lettura accessoria che fallisce non toglie la schermata.
    await waitFor(() => expect(screen.getByTestId("hub-panel-now")).toBeTruthy());
    expect(screen.queryByTestId("hub-tab-project-alert")).toBeNull();
  });
});

/**
 * DETTAGLIO PROGETTO v3 — LA TAB «ADESSO» (design §4).
 *
 * I bottoni portano dove si DECIDE, non decidono dalla riga: Rispondi alla
 * card della domanda, Approva al ticket col piano, Mergia alla conferma.
 */
describe("ProjectDetailScreen v3 — Adesso", () => {
  const REPO = "66666666-6666-4666-8666-666666666666";
  const NINE_DAYS_AGO = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000 - 60_000).toISOString();

  const QUESTION = {
    kind: "question" as const,
    ticketId: TICKET_A,
    ticketNumber: 27,
    title: "Checkout fallisce con carta salvata",
    notificationId: "44444444-4444-4444-8444-444444444444",
    priority: "urgent" as const,
  };
  const PLAN = {
    kind: "plan_approval" as const,
    ticketId: TICKET_B,
    ticketNumber: 41,
    title: "Export CSV degli ordini",
    notificationId: "55555555-5555-4555-8555-555555555555",
    priority: "high" as const,
  };
  const PR = {
    ticketId: "77777777-7777-4777-8777-777777777777",
    ticketNumber: 38,
    title: "Aggiorna dipendenze del worker",
    prUrl: "https://example.com/pr/38",
    canMerge: true,
    repositoryId: REPO,
    repositoryName: "web-app",
    priority: "medium" as const,
  };

  test("«Tocca a te»: la riga mono, il titolo e il bottone di ciascuna", async () => {
    const pulse = jest.fn().mockResolvedValue([summary({ waitingForYou: [QUESTION, PLAN], waitingForMerge: [PR] })]);
    await renderScreen(makeClient({ pulse }));
    await waitFor(() => expect(screen.getByText("Tocca a te · 3")).toBeTruthy());
    expect(screen.getByText("#27 · urgente · domanda")).toBeTruthy();
    expect(screen.getByText("#41 · alta · piano")).toBeTruthy();
    expect(screen.getByText("#38 · media · PR pronta")).toBeTruthy();
    expect(screen.getByText("Checkout fallisce con carta salvata")).toBeTruthy();
    expect(screen.getByText("Rispondi")).toBeTruthy();
    expect(screen.getByText("Approva")).toBeTruthy();
    expect(screen.getByText("Mergia")).toBeTruthy();
  });

  test("Rispondi apre la card d'inbox della domanda, col progetto per tornare indietro", async () => {
    const navigate = jest.fn();
    await renderScreen(makeClient({ pulse: jest.fn().mockResolvedValue([summary({ waitingForYou: [QUESTION] })]) }), navigate);
    await waitFor(() => expect(screen.getByText("Rispondi")).toBeTruthy());
    await fireEvent.press(screen.getByText("Rispondi"));
    expect(navigate).toHaveBeenCalledWith("Card", { id: QUESTION.notificationId, backLabel: "Portale B2B" });
  });

  test("Approva apre il TICKET, dove il piano si legge: non approva niente dalla riga", async () => {
    const navigate = jest.fn();
    await renderScreen(makeClient({ pulse: jest.fn().mockResolvedValue([summary({ waitingForYou: [PLAN] })]) }), navigate);
    await waitFor(() => expect(screen.getByText("Approva")).toBeTruthy());
    await fireEvent.press(screen.getByText("Approva"));
    expect(navigate).toHaveBeenCalledWith("Ticket", { id: TICKET_B, backLabel: "Portale B2B" });
  });

  test("il tap sulla riga, fuori dal bottone, apre il ticket", async () => {
    const navigate = jest.fn();
    await renderScreen(makeClient({ pulse: jest.fn().mockResolvedValue([summary({ waitingForYou: [QUESTION] })]) }), navigate);
    await waitFor(() => expect(screen.getByText("Checkout fallisce con carta salvata")).toBeTruthy());
    await fireEvent.press(screen.getByText("Checkout fallisce con carta salvata"));
    expect(navigate).toHaveBeenCalledWith("Ticket", { id: TICKET_A, backLabel: "Portale B2B" });
  });

  test("Mergia NON c'è senza canMerge: la PR sta fra le cose che aspettano altri", async () => {
    const pulse = jest.fn().mockResolvedValue([summary({ waitingForMerge: [{ ...PR, canMerge: false }] })]);
    await renderScreen(makeClient({ pulse }));
    await waitFor(() => expect(screen.getByText("Aspetta altri · fermi · 1")).toBeTruthy());
    expect(screen.queryByText("Mergia")).toBeNull();
    expect(screen.queryByText(/Tocca a te/)).toBeNull();
    expect(screen.getByText("attende il merge")).toBeTruthy();
  });

  test("Mergia NON c'è senza repositoryId (server più vecchio): la riga resta, e porta al ticket", async () => {
    const { repositoryId: _r, repositoryName: _n, ...prSenzaRepo } = PR;
    void _r;
    void _n;
    const navigate = jest.fn();
    await renderScreen(makeClient({ pulse: jest.fn().mockResolvedValue([summary({ waitingForMerge: [prSenzaRepo] })]) }), navigate);
    await waitFor(() => expect(screen.getByText("Tocca a te · 1")).toBeTruthy());
    expect(screen.queryByText("Mergia")).toBeNull();
    await fireEvent.press(screen.getByText("Aggiorna dipendenze del worker"));
    expect(navigate).toHaveBeenCalledWith("Ticket", { id: PR.ticketId, backLabel: "Portale B2B" });
  });

  test("«In esecuzione»: il titolo col numero e i minuti", async () => {
    const pulse = jest.fn().mockResolvedValue([
      summary({ running: [{ ticketId: TICKET_A, ticketNumber: 44, title: "Filtri salvati nella lista ordini", sinceMinutes: 12 }] }),
    ]);
    await renderScreen(makeClient({ pulse }));
    await waitFor(() => expect(screen.getByText("In esecuzione · 1")).toBeTruthy());
    expect(screen.getByText("#44 Filtri salvati nella lista ordini")).toBeTruthy();
    expect(screen.getByText("12 min")).toBeTruthy();
  });

  test("«Aspetta altri · fermi»: attese altrui, poi PR d'altri, poi i fermi, ognuno col suo testo a destra", async () => {
    const pulse = jest.fn().mockResolvedValue([
      summary({
        waitingForOthers: [{ ...PLAN, ticketNumber: 33, title: "Testo del bottone troncato", who: { kind: "requester" } }],
        waitingForMerge: [{ ...PR, canMerge: false }],
        stalled: [
          { ticketId: TICKET_A, ticketNumber: 19, title: "Notifiche email duplicate", stalledSince: NINE_DAYS_AGO, reason: "to_prepare" },
        ],
      }),
    ]);
    await renderScreen(makeClient({ pulse }));
    await waitFor(() => expect(screen.getByText("Aspetta altri · fermi · 3")).toBeTruthy());
    const titles = screen.getAllByText(/^#(33|38|19) /).map((node) => node.props.children as string);
    expect(titles).toEqual(["#33 Testo del bottone troncato", "#38 Aggiorna dipendenze del worker", "#19 Notifiche email duplicate"]);
    expect(screen.getByText("→ richiedente")).toBeTruthy();
    expect(screen.getByText("attende il merge")).toBeTruthy();
    // Il MOTIVO accanto ai giorni: è un fatto derivato dai job, e nell'app
    // non c'è un altro posto che lo mostri (review della #61).
    expect(screen.getByText("fermo 9g · da preparare")).toBeTruthy();
  });

  test("il banner del monitor: server giù, e il tap porta alla tab Progetto", async () => {
    const listServers = jest.fn().mockResolvedValue([server({ name: "prod-eu-1", checksDown: 1 })]);
    await renderScreen(makeClient({ listServers }));
    await waitFor(() => expect(screen.getByTestId("hub-now-monitor-banner")).toBeTruthy());
    expect(screen.getByText("Monitor · server giù")).toBeTruthy();
    expect(screen.getByText("prod-eu-1 · 1 controllo giù")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("hub-now-monitor-banner"));
    expect(screen.getByTestId("hub-tab-project").props.accessibilityState?.selected).toBe(true);
    expect(screen.getByTestId("hub-panel-project")).toBeTruthy();
  });

  test("niente banner quando i server sono su", async () => {
    const listServers = jest.fn().mockResolvedValue([server({})]);
    await renderScreen(makeClient({ listServers }));
    await waitFor(() => expect(listServers).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("hub-panel-now")).toBeTruthy());
    expect(screen.queryByTestId("hub-now-monitor-banner")).toBeNull();
  });

  test("tutto vuoto: al posto dei blocchi, la frase del polso", async () => {
    await renderScreen(makeClient({ pulse: jest.fn().mockResolvedValue([summary({ idleDays: 3 })]) }));
    await waitFor(() => expect(screen.getByTestId("hub-now-empty")).toBeTruthy());
    expect(screen.getByText("fermo da 3 giorni")).toBeTruthy();
    expect(screen.queryByTestId("hub-now-your-turn")).toBeNull();
    expect(screen.queryByTestId("hub-now-running")).toBeNull();
    expect(screen.queryByTestId("hub-now-others")).toBeNull();
  });
});

/**
 * DETTAGLIO PROGETTO v3 — IL MERGE DALL'APP (design §6).
 *
 * Mergia apre una conferma in due passi; Merge chiama la rotta di rilascio
 * esistente. Gli errori si mostrano nel pannello, che resta aperto.
 */
describe("ProjectDetailScreen v3 — il merge", () => {
  const REPO = "66666666-6666-4666-8666-666666666666";
  const PR_TICKET = "77777777-7777-4777-8777-777777777777";
  const PR = {
    ticketId: PR_TICKET,
    ticketNumber: 38,
    title: "Aggiorna dipendenze del worker",
    prUrl: "https://example.com/pr/38",
    canMerge: true,
    repositoryId: REPO,
    repositoryName: "web-app",
  };

  async function openMerge(release?: jest.Mock, pulse?: jest.Mock) {
    const pulseMock = pulse ?? jest.fn().mockResolvedValue([summary({ waitingForMerge: [PR] })]);
    const releaseMock = release ?? jest.fn().mockResolvedValue({ merged: true, sha: "abc123" });
    await renderScreen(makeClient({ pulse: pulseMock, release: releaseMock }));
    await waitFor(() => expect(screen.getByText("Mergia")).toBeTruthy());
    await fireEvent.press(screen.getByText("Mergia"));
    return { release: releaseMock, pulse: pulseMock };
  }

  test("Mergia apre la conferma: la domanda, il repository col ticket, il link alla PR", async () => {
    const { release } = await openMerge();
    expect(screen.getByText("Mergiare la PR di #38?")).toBeTruthy();
    expect(screen.getByText("web-app · Aggiorna dipendenze del worker")).toBeTruthy();
    expect(screen.getByText("Apri la PR ›")).toBeTruthy();
    // Aprire la conferma non mergia niente.
    expect(release).not.toHaveBeenCalled();
  });

  test("«Apri la PR ›» apre l'indirizzo della PR", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    await openMerge();
    await fireEvent.press(screen.getByText("Apri la PR ›"));
    expect(openURL).toHaveBeenCalledWith("https://example.com/pr/38");
    openURL.mockRestore();
  });

  test("Annulla chiude senza mergiare", async () => {
    const { release } = await openMerge();
    await fireEvent.press(screen.getByTestId("merge-sheet-cancel"));
    await waitFor(() => expect(screen.queryByText("Mergiare la PR di #38?")).toBeNull());
    expect(release).not.toHaveBeenCalled();
  });

  test("Merge chiama la rotta di rilascio col ticket e il repository; al successo il pannello si chiude e il polso si ricarica", async () => {
    const { release, pulse } = await openMerge();
    const pulseCalls = pulse.mock.calls.length;
    await fireEvent.press(screen.getByTestId("merge-sheet-confirm"));
    await waitFor(() => expect(release).toHaveBeenCalledWith(PR_TICKET, REPO));
    await waitFor(() => expect(screen.queryByText("Mergiare la PR di #38?")).toBeNull());
    await waitFor(() => expect(pulse.mock.calls.length).toBeGreaterThan(pulseCalls));
  });

  test("in attesa il bottone mostra lo spinner e non si ripreme", async () => {
    const release = jest.fn(() => new Promise(() => {}));
    await openMerge(release);
    await fireEvent.press(screen.getByTestId("merge-sheet-confirm"));
    await waitFor(() => expect(screen.getByTestId("merge-sheet-confirm-spinner")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("merge-sheet-confirm"));
    expect(release).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["checks_failed", new ApiError(409, "…", "checks_failed"), "I controlli del provider falliscono"],
    ["already_closed", new ApiError(409, "…", "already_closed"), "Questa PR non è più aperta"],
    ["rete", new TypeError("Network request failed"), "Stubwise non risponde, controlla la connessione e riprova"],
  ])("errore %s: il messaggio si vede e il pannello resta aperto", async (_name, error, message) => {
    const release = jest.fn().mockRejectedValue(error);
    await openMerge(release);
    await fireEvent.press(screen.getByTestId("merge-sheet-confirm"));
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    expect(screen.getByText("Mergiare la PR di #38?")).toBeTruthy();
  });
});

/**
 * DETTAGLIO PROGETTO v3 — LA TAB «LAVORO» (design §5).
 *
 * Tre blocchi — ticket, backlog, notifiche — ognuno col conteggio e «tutti ›».
 * Ognuno carica per conto suo: uno che fallisce non porta giù gli altri.
 */
describe("ProjectDetailScreen v3 — Lavoro", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * DAY - 60_000).toISOString();

  async function openWork(overrides: Parameters<typeof makeClient>[0] = {}, navigate: jest.Mock = jest.fn()) {
    await renderScreen(makeClient(overrides), navigate);
    await waitFor(() => expect(screen.getByTestId("hub-tab-work")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("hub-tab-work"));
    return navigate;
  }

  test("ticket: il conteggio degli aperti, le tre righe più recenti con l'età, e dove portano", async () => {
    const listTickets = jest.fn().mockResolvedValue({
      items: [
        ticket({ id: TICKET_A, number: 44, title: "Filtri salvati nella lista ordini", createdAt: new Date().toISOString() }),
        ticket({ id: TICKET_B, number: 41, title: "Export CSV degli ordini", createdAt: ago(5) }),
        ticket({ id: "t3", number: 38, title: "Aggiorna dipendenze del worker", createdAt: ago(12) }),
      ],
      nextCursor: null,
      total: 14,
    });
    const navigate = await openWork({ listTickets });
    await waitFor(() => expect(screen.getByText("#44 Filtri salvati nella lista ordini")).toBeTruthy());
    expect(screen.getByText(/14 aperti/)).toBeTruthy();
    expect(screen.getByText("oggi")).toBeTruthy();
    expect(screen.getByText("5 g")).toBeTruthy();
    expect(screen.getByText("12 g")).toBeTruthy();
    // Solo gli APERTI, e tre.
    expect(listTickets).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, statuses: expect.not.arrayContaining(["done", "closed"]) }),
      undefined,
      3,
    );

    await fireEvent.press(screen.getByText("#41 Export CSV degli ordini"));
    expect(navigate).toHaveBeenLastCalledWith("Ticket", { id: TICKET_B, backLabel: "Portale B2B" });
    await fireEvent.press(screen.getByTestId("hub-work-tickets-all"));
    expect(navigate).toHaveBeenLastCalledWith("Tickets", { projectId: PROJECT_ID, projectName: "Portale B2B" });
  });

  test("backlog: la barra delle pronte, «3 pronte · 8 da preparare», e il tap apre il backlog", async () => {
    const listBacklog = jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 11 });
    const navigate = await openWork({ pulse: jest.fn().mockResolvedValue([summary({ backlogReadyCount: 3 })]), listBacklog });
    await waitFor(() => expect(screen.getByText("3 pronte")).toBeTruthy());
    expect(screen.getByText("8 da preparare")).toBeTruthy();
    expect(screen.getByText(/11 voci/)).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId("hub-work-backlog-bar-fill").props.style).width).toBe(`${(3 / 11) * 100}%`);

    await fireEvent.press(screen.getByTestId("hub-work-backlog-bar"));
    expect(navigate).toHaveBeenLastCalledWith("ProjectBacklog", { projectId: PROJECT_ID, projectName: "Portale B2B" });
    navigate.mockClear();
    await fireEvent.press(screen.getByTestId("hub-work-backlog-all"));
    expect(navigate).toHaveBeenLastCalledWith("ProjectBacklog", { projectId: PROJECT_ID, projectName: "Portale B2B" });
  });

  test("notifiche: quante da gestire, le due più recenti, e il tap apre la card", async () => {
    const listInbox = jest.fn().mockResolvedValue({
      items: [
        { id: "n1", text: "L'agente chiede quale gateway usare per i rimborsi" },
        { id: "n2", text: "Piano pronto per #41 Export CSV degli ordini" },
      ],
      nextCursor: null,
      total: 2,
    });
    const navigate = await openWork({ listInbox });
    await waitFor(() => expect(screen.getByText("L'agente chiede quale gateway usare per i rimborsi")).toBeTruthy());
    expect(screen.getByText(/2 da gestire/)).toBeTruthy();
    expect(listInbox).toHaveBeenCalledWith({ projectId: PROJECT_ID }, undefined, 2);

    await fireEvent.press(screen.getByText("Piano pronto per #41 Export CSV degli ordini"));
    expect(navigate).toHaveBeenLastCalledWith("Card", { id: "n2", backLabel: "Portale B2B" });
    await fireEvent.press(screen.getByTestId("hub-work-inbox-all"));
    expect(navigate).toHaveBeenLastCalledWith("ProjectInbox", { projectId: PROJECT_ID, projectName: "Portale B2B" });
  });

  test("un blocco che fallisce mostra il suo errore, e gli altri restano", async () => {
    await openWork({
      listTickets: jest.fn().mockRejectedValue(new Error("down")),
      listInbox: jest.fn().mockResolvedValue({ items: [{ id: "n1", text: "Una notifica" }], nextCursor: null, total: 1 }),
    });
    await waitFor(() => expect(screen.getByTestId("hub-work-tickets-error")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Una notifica")).toBeTruthy());
  });

  test("blocchi vuoti: lo dicono", async () => {
    await openWork();
    await waitFor(() => expect(screen.getByText("Nessun ticket aperto.")).toBeTruthy());
    expect(screen.getByText("Backlog vuoto.")).toBeTruthy();
    expect(screen.getByText("Niente da gestire.")).toBeTruthy();
  });

  test("SERVER PIÙ VECCHIO, senza `total`: niente numeri inventati, niente barra", async () => {
    await openWork({
      pulse: jest.fn().mockResolvedValue([summary({ backlogReadyCount: 2 })]),
      listTickets: jest.fn().mockResolvedValue({ items: [ticket({ number: 44, title: "Un ticket" })], nextCursor: null }),
      listBacklog: jest.fn().mockResolvedValue({ items: [{ id: "b1", title: "Voce" }], nextCursor: null }),
    });
    await waitFor(() => expect(screen.getByText("#44 Un ticket")).toBeTruthy());
    expect(screen.queryByText(/aperti/)).toBeNull();
    expect(screen.getByText("2 pronte")).toBeTruthy();
    expect(screen.queryByText(/da preparare/)).toBeNull();
    expect(screen.queryByTestId("hub-work-backlog-bar-fill")).toBeNull();
  });
});

/**
 * DETTAGLIO PROGETTO v3 — LA TAB «PROGETTO» (design §7).
 *
 * Una scheda con cinque righe, ognuna col suo riassunto; ogni riassunto è una
 * lettura ACCESSORIA, fuori dai gate: se fallisce dice «—» e la riga resta
 * premibile.
 */
describe("ProjectDetailScreen v3 — Progetto", () => {
  const toProject = { projectId: PROJECT_ID, projectName: "Portale B2B" };

  async function openProject(overrides: Parameters<typeof makeClient>[0] = {}, navigate: jest.Mock = jest.fn()) {
    await renderScreen(makeClient(overrides), navigate);
    await waitFor(() => expect(screen.getByTestId("hub-tab-project")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("hub-tab-project"));
    return navigate;
  }

  const full = {
    getProject: jest.fn(),
    projectSpaces: jest.fn(),
    milestones: jest.fn(),
    listServers: jest.fn(),
  };

  beforeEach(() => {
    full.getProject.mockResolvedValue(
      projectDetail({
        docAutoUpdate: true,
        dailyReportEnabled: true,
        backlogEnabled: true,
        pulseEnabled: true,
        weeklyBriefEnabled: false,
        repositories: [
          // Nome e slug DIVERSI apposta: la riga mostra il NOME.
          repositorySummary({ id: "r1", name: "web-app", slug: "acme-web-app" }),
          repositorySummary({ id: "r2", name: "api", slug: "acme-api" }),
        ],
      }),
    );
    full.projectSpaces.mockResolvedValue([docSpace({ repositoryId: "r1", pageCount: 20 }), docSpace({ repositoryId: "r2", pageCount: 13 })]);
    full.milestones.mockResolvedValue([
      milestone({ id: "m1", status: "open" }),
      milestone({ id: "m2", status: "open" }),
      milestone({ id: "m3", status: "closed" }),
    ]);
    full.listServers.mockResolvedValue([server({ id: "s1", name: "prod-eu-1", checksDown: 1 }), server({ id: "s2", name: "prod-eu-2" })]);
  });

  test("cinque righe, ognuna col suo riassunto", async () => {
    await openProject(full);
    await waitFor(() => expect(screen.getByText("web-app · api")).toBeTruthy());
    expect(screen.getByText("Repository")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("2 spazi · 33 pag.")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("2 aperte")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("2 server · 1 giù")).toBeTruthy());
    // docAutoUpdate, report giornaliero, backlog e pulse (acceso CON il backlog).
    await waitFor(() => expect(screen.getByText("4 automazioni")).toBeTruthy());
  });

  test("il monitor è rosso se un server è giù, e solo allora", async () => {
    await openProject(full);
    await waitFor(() => expect(screen.getByText("2 server · 1 giù")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("2 aperte")).toBeTruthy());
    expect(StyleSheet.flatten(screen.getByText("2 server · 1 giù").props.style).color).toBe("#ff6b6e");
    expect(StyleSheet.flatten(screen.getByText("2 aperte").props.style).color).not.toBe("#ff6b6e");
  });

  test("ogni riga porta alla sua schermata", async () => {
    const navigate = await openProject(full);
    await waitFor(() => expect(screen.getByText("web-app · api")).toBeTruthy());
    const cases: [string, string][] = [
      ["hub-project-repositories", "ProjectRepositories"],
      ["hub-project-docs", "ProjectDocs"],
      ["hub-project-roadmap", "ProjectRoadmap"],
      ["hub-project-monitor", "ProjectMonitor"],
      ["hub-project-settings", "ProjectSettings"],
    ];
    for (const [testID, route] of cases) {
      await fireEvent.press(screen.getByTestId(testID));
      expect(navigate).toHaveBeenLastCalledWith(route, toProject);
    }
  });

  test("una lettura che fallisce dice «—», e la riga resta premibile", async () => {
    const navigate = await openProject({
      ...full,
      getProject: jest.fn().mockRejectedValue(new Error("down")),
      milestones: jest.fn().mockRejectedValue(new Error("down")),
    });
    await waitFor(() => expect(screen.getAllByText("—")).toHaveLength(3));
    // Le altre righe no: ognuna sta in piedi da sola.
    await waitFor(() => expect(screen.getByText("2 spazi · 33 pag.")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("hub-project-settings"));
    expect(navigate).toHaveBeenLastCalledWith("ProjectSettings", toProject);
  });

  test("il banner del monitor c'è anche qui, e porta al Monitor", async () => {
    const navigate = await openProject(full);
    await waitFor(() => expect(screen.getByTestId("hub-project-monitor-banner")).toBeTruthy());
    expect(screen.getByText("prod-eu-1 · 1 controllo giù")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("hub-project-monitor-banner"));
    expect(navigate).toHaveBeenLastCalledWith("ProjectMonitor", toProject);
  });

  test("nessun repository, nessuna automazione: lo dice", async () => {
    await openProject({ listServers: jest.fn().mockResolvedValue([]) });
    await waitFor(() => expect(screen.getByText("nessuno")).toBeTruthy());
    expect(screen.getByText("0 automazioni")).toBeTruthy();
    expect(screen.queryByTestId("hub-project-monitor-banner")).toBeNull();
  });

  test("trascina per aggiornare su Progetto ricarica le quattro letture", async () => {
    await openProject(full);
    await waitFor(() => expect(full.milestones).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(full.projectSpaces).toHaveBeenCalledTimes(1));
    const [projectBefore, serversBefore] = [full.getProject.mock.calls.length, full.listServers.mock.calls.length];

    await pullToRefresh("project-detail-refresh");

    await waitFor(() => expect(full.getProject.mock.calls.length).toBe(projectBefore + 1));
    await waitFor(() => expect(full.projectSpaces).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(full.milestones).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(full.listServers.mock.calls.length).toBe(serversBefore + 1));
  });
});
