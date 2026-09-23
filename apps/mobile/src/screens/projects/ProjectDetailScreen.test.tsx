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

  test("intestazione: nome del progetto e la riga di polso", async () => {
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          waitingForYou: [
            { kind: "question", ticketId: TICKET_A, ticketNumber: 245, title: "Cache immagini", notificationId: "x" },
          ],
        }),
      ]),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Portale B2B")).toBeTruthy());
    expect(screen.getByText("aspetta te — 1 domanda dell'agente")).toBeTruthy();
  });

  test("nessun gruppo popolato e nessun report: solo l'intestazione, niente in più", async () => {
    const client = makeClient();
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Portale B2B")).toBeTruthy());
    expect(screen.queryByText(/Aspetta qualcuno/)).toBeNull();
    expect(screen.queryByText(/Adesso/)).toBeNull();
    expect(screen.queryByText(/Pronto nel backlog/)).toBeNull();
    // `stalled` vuoto: nessun «Fermo · 0». Un secchio a zero è rumore su una
    // schermata che deve dire cosa fare.
    expect(screen.queryByText(/Fermo/)).toBeNull();
    expect(screen.queryByText("Report di ieri")).toBeNull();
  });

  test("gruppo 'Aspetta qualcuno': combina waitingForYou e waitingForOthers, conteggio nell'header", async () => {
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          waitingForYou: [
            { kind: "question", ticketId: TICKET_A, ticketNumber: 245, title: "Domanda dell'agente", notificationId: "x" },
          ],
          waitingForOthers: [
            {
              kind: "plan_approval",
              ticketId: TICKET_B,
              ticketNumber: 246,
              title: "Piano «cache immagini»",
              who: { kind: "maintainer" },
            },
          ],
        }),
      ]),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Aspetta qualcuno · 2")).toBeTruthy());
    expect(screen.getByText("Domanda dell'agente")).toBeTruthy();
    expect(screen.getByText("Piano «cache immagini»")).toBeTruthy();
    expect(screen.getByText("→ te")).toBeTruthy();
    expect(screen.getByText("→ un maintainer")).toBeTruthy();
  });

  test("un tap su una riga 'Aspetta qualcuno' naviga al ticket", async () => {
    const navigate = jest.fn();
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          waitingForYou: [{ kind: "question", ticketId: TICKET_A, ticketNumber: 245, title: "Domanda", notificationId: "x" }],
        }),
      ]),
    });
    await renderScreen(client, navigate);
    await waitFor(() => expect(screen.getByText("Domanda")).toBeTruthy());
    await fireEvent.press(screen.getByText("Domanda"));
    expect(navigate).toHaveBeenCalledWith("Ticket", { id: TICKET_A, backLabel: "Portale B2B" });
  });

  test("'Aspetta qualcuno': un tap su una riga waitingForOthers naviga anch'esso al ticket", async () => {
    const navigate = jest.fn();
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          waitingForOthers: [
            { kind: "plan_approval", ticketId: TICKET_B, ticketNumber: 246, title: "Piano da approvare", who: { kind: "maintainer" } },
          ],
        }),
      ]),
    });
    await renderScreen(client, navigate);
    await waitFor(() => expect(screen.getByText("Piano da approvare")).toBeTruthy());
    await fireEvent.press(screen.getByText("Piano da approvare"));
    expect(navigate).toHaveBeenCalledWith("Ticket", { id: TICKET_B, backLabel: "Portale B2B" });
  });

  test("'Aspetta qualcuno': who.kind 'requester' mostra 'chi l'ha richiesto'", async () => {
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          waitingForOthers: [
            { kind: "question", ticketId: TICKET_A, ticketNumber: 245, title: "Domanda", who: { kind: "requester" } },
          ],
        }),
      ]),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("→ chi l'ha richiesto")).toBeTruthy());
    // NON deve comparire l'arrow del maintainer: sono due testi distinti.
    expect(screen.queryByText("→ un maintainer")).toBeNull();
  });

  test("'Aspetta qualcuno': who.kind ignoto (UNKNOWN, server più nuovo) degrada allo stesso fallback del richiedente, mai un valore grezzo", async () => {
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          waitingForOthers: [
            {
              kind: "question",
              ticketId: TICKET_A,
              ticketNumber: 245,
              title: "Domanda",
              who: { kind: "UNKNOWN" as unknown as "requester" },
            },
          ],
        }),
      ]),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("→ chi l'ha richiesto")).toBeTruthy());
    expect(screen.queryByText("UNKNOWN")).toBeNull();
    expect(screen.queryByText("→ un maintainer")).toBeNull();
  });

  test("gruppo 'Adesso': una riga per lavoro in esecuzione, tap naviga al ticket", async () => {
    const navigate = jest.fn();
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({ running: [{ ticketId: TICKET_A, ticketNumber: 247, title: "Export CSV degli ordini", sinceMinutes: 18 }] }),
      ]),
    });
    await renderScreen(client, navigate);
    await waitFor(() => expect(screen.getByText("Adesso · 1")).toBeTruthy());
    expect(screen.getByText("Export CSV degli ordini")).toBeTruthy();
    await fireEvent.press(screen.getByText("Export CSV degli ordini"));
    expect(navigate).toHaveBeenCalledWith("Ticket", { id: TICKET_A, backLabel: "Portale B2B" });
  });

  test("gruppo 'Pronto nel backlog': il conteggio è quello del polso", async () => {
    const client = makeClient({ pulse: jest.fn().mockResolvedValue([summary({ backlogReadyCount: 4 })]) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Pronto nel backlog · 4")).toBeTruthy());
  });

  test("ordine dei gruppi: Aspetta qualcuno, poi Adesso, poi Pronto nel backlog — urgenza umana, non l'ordine dei campi dello schema", async () => {
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          waitingForYou: [{ kind: "question", ticketId: TICKET_A, ticketNumber: 1, title: "D", notificationId: "x" }],
          running: [{ ticketId: TICKET_B, ticketNumber: 2, title: "R", sinceMinutes: 1 }],
          backlogReadyCount: 1,
        }),
      ]),
    });
    const { rendered } = await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Aspetta qualcuno · 1")).toBeTruthy());

    // Senza la prop `refreshControl` (23 set 2026): è un ELEMENTO React
    // passato allo `ScrollView`, con dentro un riferimento circolare che
    // `JSON.stringify` non sa attraversare. Qui interessa solo l'ordine dei
    // testi.
    const flat = JSON.stringify(rendered.toJSON(), (key, value: unknown) => (key === "refreshControl" ? undefined : value));
    const waitingIndex = flat.indexOf("Aspetta qualcuno · 1");
    const nowIndex = flat.indexOf("Adesso · 1");
    const backlogIndex = flat.indexOf("Pronto nel backlog · 1");
    expect(waitingIndex).toBeGreaterThan(-1);
    expect(nowIndex).toBeGreaterThan(waitingIndex);
    expect(backlogIndex).toBeGreaterThan(nowIndex);
  });

  /**
   * ⚠️ BRIEF SETTIMANALE E REPORT DI IERI NON STANNO PIÙ QUI (23 set 2026,
   * richiesta del maintainer). Il test li cerca in un progetto che ha un
   * report (`lastReportDate` valorizzato): con il codice di prima la riga
   * sarebbe comparsa, quindi un risultato vuoto qui non è un caso fortunato.
   * E controlla che nessuno dei due venga nemmeno CHIESTO al server.
   */
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
 * Il polso nel dettaglio: i secchi dei fermi e delle PR, e le righe ricche
 * dei ticket. Questo blocco si chiamava «brief settimanale» perché ci era
 * nato; i test del brief sono usciti il 23 set 2026 insieme alla riga del
 * brief, e gli altri sono rimasti qui.
 */
describe("ProjectDetailScreen — polso", () => {
  // ----------------------------------------------------------------------
  // IL QUARTO SECCHIO (21 set 2026)
  // ----------------------------------------------------------------------

  /** `stalledSince` a N giorni esatti da adesso: i giorni li conta il client. */
  /**
   * Una data di N giorni fa. La usano sia `stalledSince` (l'ultimo MOVIMENTO)
   * sia `createdAt` (l'ETÀ) — sono due date diverse sulla stessa voce, e i
   * test che le mettono a valori diversi sono quelli che provano che non si
   * confondono.
   */
  function fermoDa(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  test("«Fermo · N»: ogni voce porta i giorni e il motivo, e apre il ticket", async () => {
    const navigate = jest.fn();
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          stalled: [
            {
              ticketId: TICKET_A,
              ticketNumber: 18,
              title: "Export CSV degli ordini",
              stalledSince: fermoDa(21),
              reason: "to_prepare",
            },
          ],
        }),
      ]),
    });
    await renderScreen(client, navigate);

    await waitFor(() => expect(screen.getByText("Fermo · 1")).toBeTruthy());
    expect(screen.getByText("21g · da preparare")).toBeTruthy();
    await fireEvent.press(screen.getByText("Export CSV degli ordini"));
    expect(navigate).toHaveBeenCalledWith("Ticket", { id: TICKET_A, backLabel: "Portale B2B" });
  });

  test("l'ordine del server (dal più fermo) NON viene riordinato qui", async () => {
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          stalled: [
            { ticketId: TICKET_A, ticketNumber: 18, title: "Il più fermo", stalledSince: fermoDa(21), reason: "to_prepare" },
            { ticketId: TICKET_B, ticketNumber: 27, title: "Fermo da poco", stalledSince: fermoDa(1), reason: "interrupted" },
          ],
        }),
      ]),
    });
    await renderScreen(client);

    await waitFor(() => expect(screen.getByText("Fermo · 2")).toBeTruthy());
    expect(screen.getByText("21g · da preparare")).toBeTruthy();
    expect(screen.getByText("1g · interrotto")).toBeTruthy();
  });

  /**
   * ⚠️ IL DIVIETO DELL'OPERATORE IN LETTURA. `canMerge` arriva dal server:
   * l'app NON lo deduce dal ruolo di chi guarda (qui è sempre `member`, e non
   * cambia nulla). Con `true` la PR sta fra le cose che aspettano TE, con
   * `false` fra quelle che aspettano altri — stessa riga, due posti.
   */
  test("PR da mergiare, `canMerge: true`: riga «da mergiare» in «Aspetta qualcuno»", async () => {
    const navigate = jest.fn();
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          waitingForMerge: [
            {
              ticketId: TICKET_A,
              ticketNumber: 20,
              title: "Coda di rilascio",
              prUrl: "https://example.com/pr/20",
              canMerge: true,
            },
          ],
        }),
      ]),
    });
    await renderScreen(client, navigate);

    await waitFor(() => expect(screen.getByText("Aspetta qualcuno · 1")).toBeTruthy());
    expect(screen.getByText("→ da mergiare")).toBeTruthy();
    await fireEvent.press(screen.getByText("Coda di rilascio"));
    expect(navigate).toHaveBeenCalledWith("Ticket", { id: TICKET_A, backLabel: "Portale B2B" });
  });

  test("PR da mergiare, `canMerge: false`: la stessa riga dice che aspetta un maintainer", async () => {
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          waitingForMerge: [
            {
              ticketId: TICKET_A,
              ticketNumber: 20,
              title: "Coda di rilascio",
              prUrl: "https://example.com/pr/20",
              canMerge: false,
            },
          ],
        }),
      ]),
    });
    await renderScreen(client);

    await waitFor(() => expect(screen.getByText("Aspetta qualcuno · 1")).toBeTruthy());
    expect(screen.getByText("→ un maintainer")).toBeTruthy();
    expect(screen.queryByText("→ da mergiare")).toBeNull();
  });

  test("una PR aperta non entra MAI fra i fermi: è un'attesa, non un abbandono", async () => {
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          waitingForMerge: [
            { ticketId: TICKET_A, ticketNumber: 20, title: "Coda di rilascio", prUrl: "https://example.com/pr/20", canMerge: true },
          ],
        }),
      ]),
    });
    await renderScreen(client);

    await waitFor(() => expect(screen.getByText("Aspetta qualcuno · 1")).toBeTruthy());
    expect(screen.queryByText(/Fermo/)).toBeNull();
  });

  /**
   * ⚠️ LA CONTRADDIZIONE CHE LA REVIEW HA COLTO. Il blocco «Fermo · N» e la
   * riga di polso stanno sulla STESSA schermata: finché `pulseLineFor` non
   * conosceva `stalled`, l'intestazione diceva «tutto tranquillo»
   * esattamente sopra l'elenco dei ticket fermi. Il blocco nuovo non basta —
   * va aggiornato anche ciò che già si mostrava e che ora sarebbe incompleto.
   */
  test("con dei ticket fermi l'intestazione NON dice «tutto tranquillo»", async () => {
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          stalled: [
            { ticketId: TICKET_A, ticketNumber: 18, title: "Export CSV", stalledSince: fermoDa(21), reason: "to_prepare" },
            { ticketId: TICKET_B, ticketNumber: 27, title: "Riconciliazione", stalledSince: fermoDa(3), reason: "declared_no_work" },
          ],
        }),
      ]),
    });
    await renderScreen(client);

    await waitFor(() => expect(screen.getByText("Fermo · 2")).toBeTruthy());
    expect(screen.getByText("2 ticket fermi")).toBeTruthy();
    expect(screen.queryByText("tutto tranquillo")).toBeNull();
  });

  test("una PR da mergiare è «aspetta te» anche nell'intestazione, non solo nel gruppo", async () => {
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          waitingForMerge: [
            { ticketId: TICKET_A, ticketNumber: 20, title: "Coda di rilascio", prUrl: "https://example.com/pr/20", canMerge: true },
          ],
        }),
      ]),
    });
    await renderScreen(client);

    await waitFor(() => expect(screen.getByText("aspetta te — 1 PR da mergiare")).toBeTruthy());
  });

  // ------------------------------------------------------------------------
  // LA RIGA GRIGIA DI TESTA (22 set 2026)
  // ------------------------------------------------------------------------

  test("un ticket fermo mostra `#numero · priorità · tipo · aperto …` sopra il titolo", async () => {
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          stalled: [
            {
              ticketId: TICKET_A,
              ticketNumber: 27,
              title: "Error: write EPIPE",
              stalledSince: fermoDa(19),
              reason: "to_prepare",
              priority: "urgent",
              type: "bug",
              createdAt: fermoDa(8),
            },
          ],
        }),
      ]),
    });
    await renderScreen(client);

    await waitFor(() => expect(screen.getByText("Error: write EPIPE")).toBeTruthy());
    expect(screen.getByText("#27 · urgente · guasto · aperto 8 g fa")).toBeTruthy();
  });

  test("oltre i due mesi l'età si dice in mesi, non in giorni", async () => {
    // È il motivo per cui `openedSince` esiste accanto a
    // `relativeTimeCompact` invece che dentro: quella direbbe «75 g».
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          stalled: [
            {
              ticketId: TICKET_A,
              ticketNumber: 27,
              title: "Un ticket vecchio",
              stalledSince: fermoDa(19),
              reason: "to_prepare",
              priority: "high",
              type: "feature",
              createdAt: fermoDa(75),
            },
          ],
        }),
      ]),
    });
    await renderScreen(client);

    await waitFor(() => expect(screen.getByText("#27 · alta · richiesta · aperto 2 mesi")).toBeTruthy());
  });

  test("SERVER PIÙ VECCHIO: senza i tre campi la riga c'è comunque, col numero e il titolo", async () => {
    // ⚠️ Vale quanto il test qui sopra. I tre campi sono `.optional()` perché
    // un'app nuova può parlare con un server più vecchio (un rollback,
    // un'istanza self-hosted indietro): lì l'intestazione deve degradare al
    // solo `#numero`, non sparire e non mostrare segnaposti.
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          stalled: [
            {
              ticketId: TICKET_A,
              ticketNumber: 27,
              title: "Error: write EPIPE",
              stalledSince: fermoDa(19),
              reason: "to_prepare",
            },
          ],
        }),
      ]),
    });
    await renderScreen(client);

    await waitFor(() => expect(screen.getByText("Error: write EPIPE")).toBeTruthy());
    expect(screen.getByText("#27")).toBeTruthy();
  });

  test("un campo che manca non lascia un separatore vuoto", async () => {
    // `#27 · · guasto` è peggio di `#27 · guasto`: il pezzo assente se ne
    // porta via il separatore.
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          stalled: [
            {
              ticketId: TICKET_A,
              ticketNumber: 27,
              title: "Senza priorità",
              stalledSince: fermoDa(19),
              reason: "to_prepare",
              type: "bug",
            },
          ],
        }),
      ]),
    });
    await renderScreen(client);

    await waitFor(() => expect(screen.getByText("#27 · guasto")).toBeTruthy());
  });

  test("le DUE date non si confondono: l'età dice «aperto», il fermo dice i giorni col motivo", async () => {
    // ⚠️ È il difetto corretto sul web il 21 settembre, in forma di test:
    // `createdAt` mostrato dove si leggeva «ultima attività». Qui le due
    // convivono sulla stessa voce, e ognuna tiene la sua parola — un numero
    // nudo le renderebbe scambiabili.
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([
        summary({
          stalled: [
            {
              ticketId: TICKET_A,
              ticketNumber: 27,
              title: "Due date",
              stalledSince: fermoDa(19),
              reason: "to_prepare",
              priority: "urgent",
              type: "bug",
              createdAt: fermoDa(75),
            },
          ],
        }),
      ]),
    });
    await renderScreen(client);

    // L'ETÀ, in alto, con la sua parola.
    await waitFor(() => expect(screen.getByText("#27 · urgente · guasto · aperto 2 mesi")).toBeTruthy());
    // Il FERMO, a destra, coi giorni e il motivo — dove è sempre stato.
    expect(screen.getByText("19g · da preparare")).toBeTruthy();
  });

  test("la riga «backlog pronto» NON è un ticket: nessuna intestazione", async () => {
    // L'intestazione è opzionale apposta: una voce che non è un ticket non ha
    // un numero da mostrare, e un ramo speciale non serve.
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([summary({ backlogReadyCount: 3 })]),
    });
    await renderScreen(client);

    await waitFor(() => expect(screen.getByText("3 voci pronte alla conversione")).toBeTruthy());
    expect(screen.queryByText(/^#/)).toBeNull();
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

    navigate.mockClear();
    await fireEvent.press(screen.getByTestId("backlog-ready-row"));
    expect(navigate).toHaveBeenCalledWith("ProjectBacklog", toBacklog);
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
