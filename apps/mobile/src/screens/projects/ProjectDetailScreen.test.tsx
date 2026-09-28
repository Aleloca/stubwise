import type { StubwiseClient } from "@stubwise/api-client";
import type { ProjectPulseSummary, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import { StyleSheet } from "react-native";
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
    tickets: { list: overrides.listTickets ?? jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 }) },
    backlog: { list: overrides.listBacklog ?? jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 }) },
    inbox: { list: overrides.listInbox ?? jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 }) },
    docs: { projectSpaces: overrides.projectSpaces ?? jest.fn().mockResolvedValue([]) },
    // ⚠️ Tappa 3: nel doppio PRIMA dei test che lo usano. Senza, la sezione
    // monitor mostrerebbe il proprio errore — sta fuori dai gate della
    // schermata — e nessun test fallirebbe.
    servers: { list: overrides.listServers ?? jest.fn().mockResolvedValue([]) },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient, navigate: jest.Mock = jest.fn(), id: string = PROJECT_ID) {
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
  const navigation = { navigate } as never;
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

  test("il tasto indietro naviga a List", async () => {
    const navigate = jest.fn();
    const client = makeClient();
    await renderScreen(client, navigate);
    await waitFor(() => expect(screen.getByText("Portale B2B")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(navigate).toHaveBeenCalledWith("List");
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
    await waitFor(() => expect(screen.getByTestId("hub-settings")).toBeTruthy());
    expect(screen.queryByText("Brief settimanale")).toBeNull();
    expect(screen.queryByText("Report di ieri")).toBeNull();
    expect(screen.queryByTestId("project-detail-brief-toggle")).toBeNull();
    expect(briefs).not.toHaveBeenCalled();
    expect(activityForDate).not.toHaveBeenCalled();
  });
});

/**
 * LE TRE SEZIONI DELL'HUB (22 set 2026, design §3/§4).
 *
 * Il punto di queste asserzioni non è che le righe compaiano — è che ogni
 * sezione stia in piedi DA SOLA: carica per conto suo, e un suo guasto non
 * tocca né il polso né le altre due.
 */
describe("ProjectDetailScreen — le sezioni dell'hub", () => {
  test("i conteggi arrivano da `total`, non dalle righe ricevute", async () => {
    const client = makeClient({
      // Due righe in pagina, quattordici in totale: contare le righe direbbe
      // «2», che è il `limit` dell'anteprima e non una notizia.
      listTickets: jest.fn().mockResolvedValue({ items: [ticket(), ticket({ id: TICKET_B, number: 35 })], nextCursor: null, total: 14 }),
      listBacklog: jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 6 }),
      listInbox: jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 4 }),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Ticket · 14 aperti")).toBeTruthy());
    expect(screen.getByText("Backlog · 6 voci")).toBeTruthy();
    expect(screen.getByText("Notifiche · 4 da gestire")).toBeTruthy();
  });

  test("SERVER PIÙ VECCHIO: senza `total` l'etichetta perde il numero e le righe restano", async () => {
    // ⚠️ Fixture lasciata SENZA `total` apposta: è la prova che il degrado
    // c'è (CLAUDE.md, «una fixture incompleta»). Un'app aggiornata dagli
    // store può parlare con un server che quel campo non lo manda.
    const client = makeClient({
      listTickets: jest.fn().mockResolvedValue({ items: [ticket()], nextCursor: null }),
      listBacklog: jest.fn().mockResolvedValue({ items: [{ ...ticket(), title: "Voce di backlog" }], nextCursor: null }),
      listInbox: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Ticket")).toBeTruthy());
    expect(screen.getByText("Export CSV clienti")).toBeTruthy();
    // Il backlog senza totale non può dire quanto è maturo (servirebbe la
    // differenza fra attive e pronte): degrada ai TITOLI.
    expect(screen.getByText("Voce di backlog")).toBeTruthy();
    expect(screen.queryByText(/da preparare/)).toBeNull();
  });

  test("il backlog dice quanto è maturo: le pronte dal polso, il totale dalla lista", async () => {
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([summary({ backlogReadyCount: 3 })]),
      listBacklog: jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 6 }),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("3 pronte · 3 da preparare")).toBeTruthy());
  });

  test("UNA SEZIONE CHE FALLISCE NON PORTA GIÙ LE ALTRE né il polso", async () => {
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([summary({ backlogReadyCount: 2 })]),
      listTickets: jest.fn().mockRejectedValue(new Error("down")),
      listBacklog: jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 5 }),
      listInbox: jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 1 }),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("hub-tickets-error")).toBeTruthy());
    // Le altre due sono arrivate, e il polso è intero.
    expect(screen.getByText("Backlog · 5 voci")).toBeTruthy();
    expect(screen.getByText("Notifiche · 1 da gestire")).toBeTruthy();
    expect(screen.getByText("Portale B2B")).toBeTruthy();
  });

  test("una sezione vuota si MOSTRA e lo dice: vuoto e non-ancora-arrivato sono cose diverse", async () => {
    const client = makeClient();
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("hub-tickets-empty")).toBeTruthy());
    expect(screen.getByText("Nessun ticket aperto.")).toBeTruthy();
    expect(screen.getByTestId("hub-backlog-empty")).toBeTruthy();
    expect(screen.getByTestId("hub-inbox-empty")).toBeTruthy();
  });

  test("«vedi ›» porta alle tre schermate, col progetto e il suo nome", async () => {
    const navigate = jest.fn();
    const client = makeClient();
    await renderScreen(client, navigate);
    await waitFor(() => expect(screen.getByTestId("hub-tickets-see-all")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("hub-tickets-see-all"));
    expect(navigate).toHaveBeenCalledWith("Tickets", { projectId: PROJECT_ID, projectName: "Portale B2B" });

    await fireEvent.press(screen.getByTestId("hub-backlog-see-all"));
    expect(navigate).toHaveBeenCalledWith("ProjectBacklog", { projectId: PROJECT_ID, projectName: "Portale B2B" });

    await fireEvent.press(screen.getByTestId("hub-inbox-see-all"));
    expect(navigate).toHaveBeenCalledWith("ProjectInbox", { projectId: PROJECT_ID, projectName: "Portale B2B" });
  });

  test("la sezione ticket chiede SOLO gli aperti, e col limite dell'anteprima", async () => {
    const listTickets = jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    await renderScreen(makeClient({ listTickets }));
    await waitFor(() => expect(listTickets).toHaveBeenCalled());
    expect(listTickets).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, statuses: ["open", "triaged", "in_progress", "in_review"] },
      undefined,
      2,
    );
  });

  test("un tap su una riga ticket dell'anteprima apre il ticket", async () => {
    const navigate = jest.fn();
    const client = makeClient({
      listTickets: jest.fn().mockResolvedValue({ items: [ticket()], nextCursor: null, total: 1 }),
    });
    await renderScreen(client, navigate);
    await waitFor(() => expect(screen.getByText("Export CSV clienti")).toBeTruthy());
    await fireEvent.press(screen.getByText("Export CSV clienti"));
    expect(navigate).toHaveBeenCalledWith("Ticket", { id: TICKET_A, backLabel: "Portale B2B" });
  });
});

/**
 * LE TRE SEZIONI DI «DI COSA È FATTO» (22 set 2026, tappa 2).
 *
 * Stessa proprietà delle tre del lavoro: ognuna sta in piedi da sola, e il
 * suo guasto non tocca le altre né il polso.
 */
describe("ProjectDetailScreen — repository, documentazione, roadmap", () => {
  test("i conteggi dicono quante cose ci sono, e le righe quali", async () => {
    const client = makeClient({
      getProject: jest.fn().mockResolvedValue(
        projectDetail({
          repositories: [repositorySummary(), repositorySummary({ id: "r2", name: "Portale Web", slug: "portale-web" })],
        }),
      ),
      projectSpaces: jest.fn().mockResolvedValue([docSpace()]),
      milestones: jest.fn().mockResolvedValue([milestone()]),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Repository · 2")).toBeTruthy());
    expect(screen.getByText("Portale API")).toBeTruthy();
    expect(screen.getByText("Spazio API")).toBeTruthy();
    expect(screen.getByText("Documentazione · 1 spazio")).toBeTruthy();
    expect(screen.getByText("Roadmap · 1 aperta")).toBeTruthy();
    expect(screen.getByText("Lancio pilota")).toBeTruthy();
  });

  /**
   * ⚠️ Il numero della roadmap è quello delle APERTE, non il totale: di una
   * roadmap interessa quanto manca. Con tre milestone di cui una chiusa
   * l'etichetta dice 2, non 3.
   */
  test("la roadmap conta le milestone APERTE, non tutte", async () => {
    const client = makeClient({
      milestones: jest.fn().mockResolvedValue([
        milestone({ id: "m1" }),
        milestone({ id: "m2", name: "Beta" }),
        milestone({ id: "m3", name: "Vecchia", status: "closed", closedAt: "2026-09-01T00:00:00.000Z" }),
      ]),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Roadmap · 2 aperte")).toBeTruthy());
  });

  test("una sezione che fallisce non porta giù le altre né il polso", async () => {
    const client = makeClient({
      getProject: jest.fn().mockRejectedValue(new Error("down")),
      projectSpaces: jest.fn().mockResolvedValue([docSpace()]),
      milestones: jest.fn().mockResolvedValue([milestone()]),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("hub-repositories-error")).toBeTruthy());
    expect(screen.getByText("Documentazione · 1 spazio")).toBeTruthy();
    expect(screen.getByText("Roadmap · 1 aperta")).toBeTruthy();
    expect(screen.getByText("Portale B2B")).toBeTruthy();
  });

  test("sezioni vuote: lo dicono, invece di sparire", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("hub-repositories-empty")).toBeTruthy());
    expect(screen.getByTestId("hub-docs-empty")).toBeTruthy();
    expect(screen.getByTestId("hub-roadmap-empty")).toBeTruthy();
  });

  test("«vedi ›» porta alle tre schermate, col progetto e il suo nome", async () => {
    const navigate = jest.fn();
    await renderScreen(makeClient(), navigate);
    await waitFor(() => expect(screen.getByTestId("hub-repositories-see-all")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("hub-repositories-see-all"));
    expect(navigate).toHaveBeenCalledWith("ProjectRepositories", { projectId: PROJECT_ID, projectName: "Portale B2B" });

    await fireEvent.press(screen.getByTestId("hub-docs-see-all"));
    expect(navigate).toHaveBeenCalledWith("ProjectDocs", { projectId: PROJECT_ID, projectName: "Portale B2B" });

    await fireEvent.press(screen.getByTestId("hub-roadmap-see-all"));
    expect(navigate).toHaveBeenCalledWith("ProjectRoadmap", { projectId: PROJECT_ID, projectName: "Portale B2B" });
  });

  test("un tap su un repository dell'anteprima apre il suo dettaglio, per SLUG", async () => {
    const navigate = jest.fn();
    const client = makeClient({
      getProject: jest.fn().mockResolvedValue(projectDetail({ repositories: [repositorySummary()] })),
    });
    await renderScreen(client, navigate);
    await waitFor(() => expect(screen.getByTestId("hub-repository-r1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("hub-repository-r1"));
    expect(navigate).toHaveBeenCalledWith("Repository", { slug: "portale-api", projectName: "Portale B2B" });
  });

  /**
   * «La documentazione nell'app, come sul web» (25 set 2026): una riga della
   * sezione Documentazione apre la documentazione DI QUEL repository, a tab.
   */
  test("un tap su uno spazio della documentazione apre la documentazione del suo repository", async () => {
    const navigate = jest.fn();
    const client = makeClient({ projectSpaces: jest.fn().mockResolvedValue([docSpace()]) });
    await renderScreen(client, navigate);
    await waitFor(() => expect(screen.getByTestId("hub-docs-space-r1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("hub-docs-space-r1"));
    expect(navigate).toHaveBeenCalledWith("RepoDocs", { repositoryId: "r1", repositoryName: "Spazio API" });
  });
});

/**
 * TAPPA 3 (23 set 2026): monitor e impostazioni, in fondo all'hub.
 */
describe("ProjectDetailScreen — monitor e impostazioni", () => {
  test("la sezione monitor chiede i server DEL PROGETTO", async () => {
    const listServers = jest.fn().mockResolvedValue([]);
    await renderScreen(makeClient({ listServers }));
    await waitFor(() => expect(listServers).toHaveBeenCalledWith(PROJECT_ID));
  });

  test("quanti server e quanti controlli giù, nell'etichetta", async () => {
    const client = makeClient({
      listServers: jest.fn().mockResolvedValue([
        server({ id: "s1", checksDown: 2 }),
        server({ id: "s2", name: "prod-db", checksDown: 1 }),
      ]),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Monitor · 2 server · 3 controlli giù")).toBeTruthy());
  });

  /**
   * ⚠️ Il rosso solo quando qualcosa è DAVVERO rotto. Due server: uno sano,
   * uno offline — solo il secondo è rosso (il mai connesso ha il suo test), e
   * l'etichetta non parla di controlli giù perché non ce ne sono.
   */
  test("rosso solo per ciò che è rotto: offline sì, un server sano no", async () => {
    const client = makeClient({
      listServers: jest.fn().mockResolvedValue([
        server({ id: "s1" }),
        server({ id: "s2", name: "prod-db", status: "offline" }),
      ]),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Monitor · 2 server")).toBeTruthy());
    const healthy = screen.getByTestId("hub-server-s1-trailing");
    const down = screen.getByTestId("hub-server-s2-trailing");
    const color = (node: ReturnType<typeof screen.getByTestId>) =>
      (StyleSheet.flatten(node.props.style) as { color?: string } | undefined)?.color;
    expect(down.props.children).toBe("Offline");
    expect(color(down)).not.toBe(color(healthy));
  });

  test("un server mai connesso non è rosso", async () => {
    const client = makeClient({
      listServers: jest.fn().mockResolvedValue([
        server({ id: "s1" }),
        server({ id: "s3", name: "nuovo", status: "never_connected", lastSeenAt: null, recentCpu: [] }),
      ]),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("hub-server-s3-trailing")).toBeTruthy());
    const style = (id: string) => JSON.stringify(screen.getByTestId(id).props.style);
    expect(screen.getByTestId("hub-server-s3-trailing").props.children).toBe("Mai connesso");
    expect(style("hub-server-s3-trailing")).toBe(style("hub-server-s1-trailing"));
  });

  test("il monitor che fallisce non porta giù le altre sezioni", async () => {
    const client = makeClient({ listServers: jest.fn().mockRejectedValue(new Error("down")) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("hub-monitor-error")).toBeTruthy());
    expect(screen.getByTestId("hub-roadmap-empty")).toBeTruthy();
    expect(screen.getByTestId("hub-settings-summary")).toBeTruthy();
  });

  test("nessun server: lo dice", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByTestId("hub-monitor-empty")).toBeTruthy());
  });

  test("le impostazioni dicono cosa è acceso", async () => {
    const client = makeClient({
      getProject: jest.fn().mockResolvedValue(
        projectDetail({ backlogEnabled: true, pulseEnabled: true, pulseEveryDays: 5, weeklyBriefEnabled: true }),
      ),
    });
    await renderScreen(client);
    await waitFor(() =>
      expect(screen.getByTestId("hub-settings-summary")).toBeTruthy(),
    );
    await waitFor(() => expect(screen.getByText("Backlog · Pulse ogni 5 g · Brief settimanale")).toBeTruthy());
  });

  /** ⚠️ Acceso senza backlog il pulse è muto: la riga lo dice, come il web. */
  test("pulse acceso senza backlog: in attesa, non una cadenza", async () => {
    const client = makeClient({
      getProject: jest.fn().mockResolvedValue(projectDetail({ pulseEnabled: true, pulseEveryDays: 5 })),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Pulse in attesa del backlog")).toBeTruthy());
  });

  test("niente acceso: lo dice", async () => {
    await renderScreen(makeClient());
    await waitFor(() => expect(screen.getByText("Nessuna automazione attiva.")).toBeTruthy());
  });

  test("«vedi ›» e «apri ›» portano al monitor e alle impostazioni, col progetto e il suo nome", async () => {
    const navigate = jest.fn();
    await renderScreen(makeClient(), navigate);
    await waitFor(() => expect(screen.getByTestId("hub-monitor-see-all")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("hub-monitor-see-all"));
    expect(navigate).toHaveBeenCalledWith("ProjectMonitor", { projectId: PROJECT_ID, projectName: "Portale B2B" });
    await fireEvent.press(screen.getByTestId("hub-settings-see-all"));
    expect(navigate).toHaveBeenCalledWith("ProjectSettings", { projectId: PROJECT_ID, projectName: "Portale B2B" });
  });

  /**
   * ⚠️ LE RIGHE RIASSUNTIVE SONO AZIONI (23 set 2026). Segnalato dal
   * maintainer sul telefono: la riga delle impostazioni si apriva solo dal
   * bottone «apri ›», non toccando la riga — e sul telefono si tocca la
   * riga. Stesso difetto, non segnalato, sulla maturità del backlog e sul
   * gruppo «backlog pronto» del polso: righe disegnate identiche a quelle
   * premibili che non rispondevano al tocco.
   *
   * Il test preme la RIGA, mai il «vedi ›»: quello è coperto qui sopra, e un
   * test che premesse il bottone passerebbe anche col difetto tornato.
   */
  test("toccare una riga riassuntiva apre la stessa schermata del suo «vedi ›»", async () => {
    const navigate = jest.fn();
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([summary({ backlogReadyCount: 3 })]),
      listBacklog: jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 6 }),
    });
    await renderScreen(client, navigate);
    const toBacklog = { projectId: PROJECT_ID, projectName: "Portale B2B" };

    await waitFor(() => expect(screen.getByTestId("hub-settings-summary")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("hub-settings-summary"));
    expect(navigate).toHaveBeenCalledWith("ProjectSettings", toBacklog);

    await waitFor(() => expect(screen.getByTestId("hub-backlog-maturity")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("hub-backlog-maturity"));
    expect(navigate).toHaveBeenLastCalledWith("ProjectBacklog", toBacklog);
  });

  test("un tap su un server dell'anteprima apre il suo cruscotto", async () => {
    const navigate = jest.fn();
    await renderScreen(makeClient({ listServers: jest.fn().mockResolvedValue([server()]) }), navigate);
    await waitFor(() => expect(screen.getByTestId("hub-server-s1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("hub-server-s1"));
    expect(navigate).toHaveBeenCalledWith("Server", { serverId: "s1", projectName: "Portale B2B" });
  });
});

/**
 * TRASCINA PER AGGIORNARE sull'hub (23 set 2026): il gesto ricarica il polso
 * E ogni sezione — ognuna ha la sua query, e l'hub le elenca tutte al
 * componente condiviso.
 */
describe("ProjectDetailScreen — trascina per aggiornare", () => {
  test("il gesto ricarica il polso e le sezioni", async () => {
    const pulse = jest.fn().mockResolvedValue([summary()]);
    const listTickets = jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    const getProject = jest.fn().mockResolvedValue(projectDetail());
    const listServers = jest.fn().mockResolvedValue([]);
    const milestones = jest.fn().mockResolvedValue([]);
    await renderScreen(makeClient({ pulse, listTickets, getProject, listServers, milestones }));
    await waitFor(() => expect(listServers).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(milestones).toHaveBeenCalledTimes(1));
    const [pulseBefore, ticketsBefore, projectBefore] = [
      pulse.mock.calls.length,
      listTickets.mock.calls.length,
      getProject.mock.calls.length,
    ];

    await pullToRefresh("project-detail-refresh");

    await waitFor(() => expect(pulse.mock.calls.length).toBe(pulseBefore + 1));
    await waitFor(() => expect(listTickets.mock.calls.length).toBe(ticketsBefore + 1));
    // Il dettaglio del progetto è UNA query letta da due sezioni (repository e
    // impostazioni): si ricarica una volta sola.
    await waitFor(() => expect(getProject.mock.calls.length).toBe(projectBefore + 1));
    await waitFor(() => expect(listServers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(milestones).toHaveBeenCalledTimes(2));
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
    expect(screen.getByText("fermo 9g")).toBeTruthy();
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
