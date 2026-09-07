import type { StubwiseClient } from "@stubwise/api-client";
import type { ProjectBriefWeekly, ProjectPulseSummary, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
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
    lastReportDate: null,
    ...overrides,
  };
}

function brief(overrides: Partial<Reader<ProjectBriefWeekly>> = {}): Reader<ProjectBriefWeekly> {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    projectId: PROJECT_ID,
    periodStart: "2026-08-31",
    periodEnd: "2026-09-06",
    status: "done",
    summary: "Il **checkout** è tornato stabile.",
    sections: null,
    notificationId: null,
    createdAt: "2026-09-07T09:00:00.000Z",
    finishedAt: "2026-09-07T09:02:00.000Z",
    ...overrides,
  } as Reader<ProjectBriefWeekly>;
}

function makeClient(
  overrides: { pulse?: jest.Mock; activityForDate?: jest.Mock; briefs?: jest.Mock } = {},
): StubwiseClient {
  return {
    projects: {
      pulse: overrides.pulse ?? jest.fn().mockResolvedValue([summary()]),
      briefs: overrides.briefs ?? jest.fn().mockResolvedValue([]),
    },
    activity: { forDate: overrides.activityForDate ?? jest.fn().mockResolvedValue({ date: "2026-08-31", projects: [] }) },
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

  test("il tasto indietro naviga a List", async () => {
    const navigate = jest.fn();
    const client = makeClient();
    await renderScreen(client, navigate);
    await waitFor(() => expect(screen.getByText("Portale B2B")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-detail-back"));
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
    expect(navigate).toHaveBeenCalledWith("Ticket", { id: TICKET_A });
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
    expect(navigate).toHaveBeenCalledWith("Ticket", { id: TICKET_B });
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
    expect(navigate).toHaveBeenCalledWith("Ticket", { id: TICKET_A });
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

    const flat = JSON.stringify(rendered.toJSON());
    const waitingIndex = flat.indexOf("Aspetta qualcuno · 1");
    const nowIndex = flat.indexOf("Adesso · 1");
    const backlogIndex = flat.indexOf("Pronto nel backlog · 1");
    expect(waitingIndex).toBeGreaterThan(-1);
    expect(nowIndex).toBeGreaterThan(waitingIndex);
    expect(backlogIndex).toBeGreaterThan(nowIndex);
  });

  test("'Report di ieri': assente quando lastReportDate è null", async () => {
    const client = makeClient({ pulse: jest.fn().mockResolvedValue([summary({ lastReportDate: null })]) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Portale B2B")).toBeTruthy());
    expect(screen.queryByText("Report di ieri")).toBeNull();
  });

  test("'Report di ieri': tap carica e mostra il riassunto del giorno per QUESTO progetto", async () => {
    const activityForDate = jest.fn().mockResolvedValue({
      date: "2026-08-31",
      projects: [
        { project: { id: PROJECT_ID, name: "Portale B2B", slug: "portale-b2b" }, status: "done", summary: "3 commit, un fix." },
        { project: { id: "altro", name: "Altro progetto", slug: "altro" }, status: "done", summary: "non pertinente" },
      ],
    });
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([summary({ lastReportDate: "2026-08-31" })]),
      activityForDate,
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Report di ieri")).toBeTruthy());
    expect(activityForDate).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByText("Report di ieri"));
    expect(activityForDate).toHaveBeenCalledWith("2026-08-31");
    await waitFor(() => expect(screen.getByText("3 commit, un fix.")).toBeTruthy());
    expect(screen.queryByText("non pertinente")).toBeNull();
  });

  test("'Report di ieri': nessun riassunto ancora generato per QUESTO progetto in quel giorno", async () => {
    const activityForDate = jest.fn().mockResolvedValue({ date: "2026-08-31", projects: [] });
    const client = makeClient({
      pulse: jest.fn().mockResolvedValue([summary({ lastReportDate: "2026-08-31" })]),
      activityForDate,
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Report di ieri")).toBeTruthy());
    await fireEvent.press(screen.getByText("Report di ieri"));
    await waitFor(() => expect(screen.getByText("Nessun riassunto per questo giorno.")).toBeTruthy());
  });
});

/**
 * Fase 5, ondata 2: il brief settimanale — il resoconto per chi non legge
 * codice — nel dettaglio del progetto. Stesso schema del "Report di ieri" qui
 * accanto: riga sempre presente, fetch PIGRO al primo tocco (la maggior parte
 * delle visite al dettaglio non lo apre), markdown vero nel corpo.
 */
describe("ProjectDetailScreen — brief settimanale", () => {
  async function openBrief() {
    await waitFor(() => expect(screen.getByTestId("project-detail-brief-toggle")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-detail-brief-toggle"));
  }

  test("la riga c'è ma il brief NON viene caricato finché non la si tocca", async () => {
    const briefs = jest.fn().mockResolvedValue([brief()]);
    await renderScreen(makeClient({ briefs }));
    await waitFor(() => expect(screen.getByTestId("project-detail-brief-toggle")).toBeTruthy());
    expect(screen.getByText("Brief settimanale")).toBeTruthy();
    expect(briefs).not.toHaveBeenCalled();
  });

  test("al tocco chiede l'ULTIMO brief del progetto e ne mostra il testo", async () => {
    const briefs = jest.fn().mockResolvedValue([brief()]);
    await renderScreen(makeClient({ briefs }));
    await openBrief();
    await waitFor(() => expect(briefs).toHaveBeenCalledWith(PROJECT_ID, { limit: 1 }));
    // Markdown VERO: gli asterischi del grassetto non compaiono a schermo.
    await waitFor(() => expect(screen.getByText("checkout")).toBeTruthy());
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  test("nessun brief ancora generato: lo stato vuoto, non un errore", async () => {
    await renderScreen(makeClient({ briefs: jest.fn().mockResolvedValue([]) }));
    await openBrief();
    await waitFor(() => expect(screen.getByText("Nessun brief ancora.")).toBeTruthy());
  });

  test("brief senza testo (istanza senza provider AI): lo stesso stato vuoto, mai una card muta", async () => {
    await renderScreen(makeClient({ briefs: jest.fn().mockResolvedValue([brief({ summary: null })]) }));
    await openBrief();
    await waitFor(() => expect(screen.getByText("Nessun brief ancora.")).toBeTruthy());
  });

  test("brief fallito: lo dice, invece di far credere che non ce ne sia mai stato uno", async () => {
    await renderScreen(
      makeClient({ briefs: jest.fn().mockResolvedValue([brief({ status: "failed", summary: null })]) }),
    );
    await openBrief();
    await waitFor(() => expect(screen.getByText("Il brief di questa settimana non è stato generato.")).toBeTruthy());
  });

  test("errore di rete: un messaggio, non una schermata rotta", async () => {
    await renderScreen(makeClient({ briefs: jest.fn().mockRejectedValue(new Error("down")) }));
    await openBrief();
    await waitFor(() => expect(screen.getByText("Non riesco a caricare il brief.")).toBeTruthy());
  });
});
