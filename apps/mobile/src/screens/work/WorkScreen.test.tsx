import type { StubwiseClient } from "@stubwise/api-client";
import { ApiError } from "@stubwise/api-client";
import type { AiJob, TicketDetail, TicketQuestion, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { WorkScreen } from "./WorkScreen";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

function ticket(overrides: Partial<Reader<TicketDetail>> = {}): Reader<TicketDetail> {
  return {
    id: TICKET_ID,
    projectId: "proj-1",
    number: 247,
    title: "Export CSV degli ordini",
    body: "Aggiunge l'esportazione CSV degli ordini per il gestionale.",
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
    lastSeenAt: "2026-08-12T09:00:00.000Z",
    createdAt: "2026-08-12T09:00:00.000Z",
    updatedAt: "2026-08-12T09:00:00.000Z",
    implementationPlan: null,
    originContent: null,
    repositories: [],
    ...overrides,
  } as Reader<TicketDetail>;
}

function job(overrides: Partial<Reader<AiJob>> = {}): Reader<AiJob> {
  return {
    id: JOB_ID,
    ticketId: TICKET_ID,
    status: "fixing",
    log: "",
    prUrl: null,
    error: null,
    createdAt: "2026-08-12T09:05:00.000Z",
    startedAt: null,
    finishedAt: null,
    providerLabel: null,
    providerKind: null,
    requestedByUserId: null,
    ...overrides,
  } as Reader<AiJob>;
}

function makeClient(overrides: {
  get?: jest.Mock;
  jobs?: jest.Mock;
  questions?: jest.Mock;
  approvePlan?: jest.Mock;
  rejectPlan?: jest.Mock;
} = {}): StubwiseClient {
  return {
    tickets: {
      get: overrides.get ?? jest.fn().mockResolvedValue(ticket()),
      jobs: overrides.jobs ?? jest.fn().mockResolvedValue([]),
      questions: overrides.questions ?? jest.fn().mockResolvedValue([] as Reader<TicketQuestion>[]),
      approvePlan: overrides.approvePlan ?? jest.fn().mockResolvedValue({ jobId: JOB_ID }),
      rejectPlan: overrides.rejectPlan ?? jest.fn().mockResolvedValue({ jobId: JOB_ID }),
    },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient, role: "admin" | "member" = "member") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const goBack = jest.fn();
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "viewer-1", email: "op@example.com", role, language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
  };
  const navigation = { goBack } as never;
  const rendered = await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <WorkScreen navigation={navigation} route={{ key: "Ticket", name: "Ticket", params: { id: TICKET_ID } }} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { rendered, goBack };
}

describe("WorkScreen — caricamento ed errori", () => {
  test("caricamento: mostra lo skeleton", async () => {
    const client = makeClient({ get: jest.fn(() => new Promise(() => {})) });
    await renderScreen(client);
    expect(screen.getByTestId("work-skeleton")).toBeTruthy();
  });

  test("404 sul ticket: stato 'non trovato', non un errore generico", async () => {
    const client = makeClient({ get: jest.fn().mockRejectedValue(new ApiError(404, "Not found", "ticket_not_found")) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("work-not-found")).toBeTruthy());
  });

  test("errore di rete: mostra Riprova, che ricarica", async () => {
    const get = jest.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(ticket());
    const client = makeClient({ get });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("work-error")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-retry"));
    await waitFor(() => expect(screen.getByText("Export CSV degli ordini")).toBeTruthy());
  });

  test("il tasto indietro chiama goBack (non un navigate fisso)", async () => {
    const client = makeClient();
    const { goBack } = await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Export CSV degli ordini")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-back"));
    expect(goBack).toHaveBeenCalled();
  });
});

describe("WorkScreen — corpo", () => {
  test("titolo, descrizione, badge di stato e numero", async () => {
    const client = makeClient({ jobs: jest.fn().mockResolvedValue([job({ status: "awaiting_input" })]) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Export CSV degli ordini")).toBeTruthy());
    expect(screen.getByText("Aggiunge l'esportazione CSV degli ordini per il gestionale.")).toBeTruthy();
    expect(screen.getByText("In attesa di risposta")).toBeTruthy();
    expect(screen.getByText("lavoro #247")).toBeTruthy();
  });

  test("nessuna descrizione: testo dedicato invece di una riga vuota", async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue(ticket({ body: "   " })) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Nessuna descrizione.")).toBeTruthy());
  });

  test("job 'fixing' con startedAt: mostra la WorkingPill", async () => {
    const client = makeClient({
      jobs: jest.fn().mockResolvedValue([job({ status: "fixing", startedAt: "2026-08-12T09:10:00.000Z" })]),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("working-pill")).toBeTruthy());
  });

  test("nessun job: niente WorkingPill, badge come 'proposed', timeline al passo 1", async () => {
    const client = makeClient();
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Export CSV degli ordini")).toBeTruthy());
    expect(screen.queryByTestId("working-pill")).toBeNull();
    expect(screen.getByText("In coda")).toBeTruthy();
    expect(screen.getByTestId("timeline-step-proposed-current")).toBeTruthy();
  });

  test("la timeline è quella di buildTimeline: job 'held' → passo 1 current", async () => {
    const client = makeClient({ jobs: jest.fn().mockResolvedValue([job({ status: "held" })]) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("timeline-step-proposed-current")).toBeTruthy());
  });
});

describe("WorkScreen — ruolo e gate di approvazione", () => {
  test("member: nessun 'Livello tecnico', nessun Approva/Rifiuta anche con piano in attesa", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(ticket({ implementationPlan: "1. Fai una cosa." })),
      jobs: jest.fn().mockResolvedValue([job({ status: "awaiting_plan_approval" })]),
    });
    await renderScreen(client, "member");
    await waitFor(() => expect(screen.getByText("Piano da approvare")).toBeTruthy());
    expect(screen.queryByText("Livello tecnico · solo maintainer")).toBeNull();
    expect(screen.queryByTestId("plan-section-approve")).toBeNull();
  });

  test("admin ma job NON awaiting_plan_approval: 'Livello tecnico' c'è, Approva/Rifiuta no", async () => {
    const client = makeClient({ jobs: jest.fn().mockResolvedValue([job({ status: "fixing" })]) });
    await renderScreen(client, "admin");
    await waitFor(() => expect(screen.getByText("Livello tecnico · solo maintainer")).toBeTruthy());
    expect(screen.queryByTestId("plan-section-approve")).toBeNull();
  });

  test("admin E job awaiting_plan_approval: Approva/Rifiuta presenti", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(ticket({ implementationPlan: "1. Fai una cosa." })),
      jobs: jest.fn().mockResolvedValue([job({ status: "awaiting_plan_approval" })]),
    });
    await renderScreen(client, "admin");
    await waitFor(() => expect(screen.getByTestId("plan-section-approve")).toBeTruthy());
    expect(screen.getByTestId("plan-section-reject")).toBeTruthy();
  });

  test("admin: 'Livello tecnico' mostra i rami delle repository", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(
        ticket({
          repositories: [
            {
              repositoryId: "repo-1",
              repositorySlug: "portale-b2b",
              branch: "stubwise/fix-245-image-cache",
              prUrl: null,
              prState: "open",
            },
          ],
        }),
      ),
    });
    await renderScreen(client, "admin");
    await waitFor(() => expect(screen.getByText("stubwise/fix-245-image-cache")).toBeTruthy());
  });
});
