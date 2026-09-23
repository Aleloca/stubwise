import type { StubwiseClient } from "@stubwise/api-client";
import { ApiError } from "@stubwise/api-client";
import type { AiJob, TicketComment, TicketDetail, TicketQuestion, Reader } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { WorkScreen } from "./WorkScreen";

/** Vedi `InboxScreen.test.tsx` per il perché di questo helper invece di `UNSAFE_getByType` (tolto in RTL v14). */
function findHostNode(tree: unknown, type: string): { props: Record<string, unknown> } | null {
  if (tree === null || tree === undefined) return null;
  if (Array.isArray(tree)) {
    for (const node of tree) {
      const found = findHostNode(node, type);
      if (found) return found;
    }
    return null;
  }
  const node = tree as { type?: string; children?: unknown; props?: Record<string, unknown> };
  if (node.type === type) return node as { props: Record<string, unknown> };
  return findHostNode(node.children, type);
}

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

function comment(overrides: Partial<Reader<TicketComment>> = {}): Reader<TicketComment> {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    ticketId: TICKET_ID,
    authorType: "user",
    authorId: "viewer-1",
    body: "Ho controllato io, manca il separatore.",
    createdAt: "2026-08-12T10:00:00.000Z",
    ...overrides,
  } as Reader<TicketComment>;
}

function question(overrides: Partial<Reader<TicketQuestion>> = {}): Reader<TicketQuestion> {
  return {
    questionId: "44444444-4444-4444-8444-444444444444",
    jobId: JOB_ID,
    round: 1,
    question: "Il CSV va separato da virgole o da punti e virgola?",
    options: [
      { label: "Virgole", consequence: "Standard, ma Excel italiano lo legge male." },
      { label: "Punti e virgola", consequence: "Excel italiano lo apre in colonne." },
    ],
    allowFreeText: false,
    askedAt: "2026-08-12T09:30:00.000Z",
    answer: null,
    answeredAt: null,
    answeredBy: null,
    ...overrides,
  } as Reader<TicketQuestion>;
}

/**
 * ⚠️ **Ogni metodo che la schermata chiama va elencato qui, anche quello di
 * cui un test non si occupa.** Il doppio è un cast (`as unknown as
 * StubwiseClient`), quindi il compilatore NON segnala un metodo mancante: la
 * query che lo chiama fallisce a runtime, e siccome le letture accessorie
 * stanno fuori dai gate `isPending`/`isError` la schermata resta intera e il
 * test passa lo stesso — verde senza aver provato niente. È la trappola
 * gemella di quella delle fixture incomplete (CLAUDE.md, 21 set 2026): là
 * manca un campo, qui manca un metodo, e in nessuno dei due casi il
 * fallimento nomina la causa.
 */
function makeClient(overrides: {
  get?: jest.Mock;
  jobs?: jest.Mock;
  questions?: jest.Mock;
  activity?: jest.Mock;
  comments?: jest.Mock;
  reviews?: jest.Mock;
  milestones?: jest.Mock;
  users?: jest.Mock;
  approvePlan?: jest.Mock;
  rejectPlan?: jest.Mock;
  preApprovePlan?: jest.Mock;
  revokePlanApproval?: jest.Mock;
  patch?: jest.Mock;
  comment?: jest.Mock;
  runAi?: jest.Mock;
  answerQuestion?: jest.Mock;
  deleteDesign?: jest.Mock;
  deletePlan?: jest.Mock;
} = {}): StubwiseClient {
  return {
    tickets: {
      get: overrides.get ?? jest.fn().mockResolvedValue(ticket()),
      jobs: overrides.jobs ?? jest.fn().mockResolvedValue([]),
      questions: overrides.questions ?? jest.fn().mockResolvedValue([] as Reader<TicketQuestion>[]),
      activity: overrides.activity ?? jest.fn().mockResolvedValue([]),
      comments: overrides.comments ?? jest.fn().mockResolvedValue([]),
      approvePlan: overrides.approvePlan ?? jest.fn().mockResolvedValue({ jobId: JOB_ID }),
      rejectPlan: overrides.rejectPlan ?? jest.fn().mockResolvedValue({ jobId: JOB_ID }),
      preApprovePlan: overrides.preApprovePlan ?? jest.fn().mockResolvedValue(ticket()),
      revokePlanApproval: overrides.revokePlanApproval ?? jest.fn().mockResolvedValue(ticket()),
      patch: overrides.patch ?? jest.fn().mockResolvedValue(ticket()),
      comment: overrides.comment ?? jest.fn().mockResolvedValue(comment()),
      runAi: overrides.runAi ?? jest.fn().mockResolvedValue({ jobId: JOB_ID, status: "queued" }),
      answerQuestion: overrides.answerQuestion ?? jest.fn().mockResolvedValue({ jobId: JOB_ID }),
      deleteDesign: overrides.deleteDesign ?? jest.fn().mockResolvedValue(ticket()),
      deletePlan: overrides.deletePlan ?? jest.fn().mockResolvedValue(ticket()),
    },
    projects: {
      reviews: overrides.reviews ?? jest.fn().mockResolvedValue([]),
      milestones: overrides.milestones ?? jest.fn().mockResolvedValue([]),
    },
    users: { list: overrides.users ?? jest.fn().mockResolvedValue([]) },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient, role: "admin" | "member" = "member", extraParams: { backLabel?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const goBack = jest.fn();
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "viewer-1", email: "op@example.com", role, language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
  const navigation = { goBack } as never;
  const rendered = await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <WorkScreen navigation={navigation} route={{ key: "Ticket", name: "Ticket", params: { id: TICKET_ID, ...extraParams } }} />
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
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(goBack).toHaveBeenCalled();
  });

  // Fix di review (App M1+M2, Task 2, 11 set 2026): rete anti-regressione —
  // l'avatar (unico accesso alle Impostazioni) deve restare raggiungibile su
  // OGNI schermata post-login, inclusa questa (dove si approva un piano —
  // prima del fix ne era priva del tutto).
  test("le Impostazioni sono raggiungibili (avatar presente)", async () => {
    const client = makeClient();
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("settings-avatar-button")).toBeTruthy());
  });

  // Fix di review (App M1+M2, Task 3, 11 set 2026): rete anti-regressione —
  // vedi il commento gemello in `InboxScreen.test.tsx` (compreso il perché
  // di `findHostNode` invece di `UNSAFE_getByType`, tolto in RTL v14).
  // Seconda schermata diversa, come richiesto dal piano dei fix.
  test("il margine sotto la barra include l'altezza reale della tab bar", async () => {
    (useBottomTabBarHeight as jest.Mock).mockReturnValue(80);
    const client = makeClient();
    const { rendered } = await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Export CSV degli ordini")).toBeTruthy());
    const scrollView = findHostNode(rendered.toJSON(), "RCTScrollView");
    expect(scrollView).not.toBeNull();
    const flat = StyleSheet.flatten(scrollView!.props.contentContainerStyle as never);
    expect(flat.paddingBottom).toBe(40 + 80);
    (useBottomTabBarHeight as jest.Mock).mockReturnValue(0);
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

/**
 * Fase 5, ondata 2: la schermata legge i tre campi nuovi — il riassunto "in
 * breve" del piano, le date reali dei passi dagli eventi del ticket, il
 * verdetto della review dalle review di progetto.
 */
describe("WorkScreen — i campi della fase 5", () => {
  test("il riassunto del piano arriva a PlanSection: si legge quello, non il piano tecnico", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(
        ticket({
          implementationPlan: "Passo 1: aggiungere un indice sul listino.",
          planSummary: "Gli ordini si potranno scaricare in CSV. Non tocca i pagamenti.",
        }),
      ),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("plan-section-summary")).toBeTruthy());
    expect(screen.getByText(/Gli ordini si potranno scaricare in CSV/)).toBeTruthy();
    expect(screen.queryByText(/Passo 1: aggiungere un indice/)).toBeNull();
  });

  test("le date dei passi 'piano approvato' e 'PR e review' vengono dagli eventi del ticket", async () => {
    const activity = jest.fn().mockResolvedValue([
      {
        kind: "event",
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        eventKind: "status_changed",
        payload: { from: "triaged", to: "in_progress" },
        createdAt: "2026-08-12T12:00:00.000Z",
      },
      {
        kind: "event",
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        eventKind: "status_changed",
        payload: { from: "in_progress", to: "in_review" },
        createdAt: "2026-08-12T14:00:00.000Z",
      },
    ]);
    const client = makeClient({
      activity,
      jobs: jest.fn().mockResolvedValue([job({ status: "pr_opened", startedAt: "2026-08-12T10:00:00.000Z" })]),
    });
    await renderScreen(client);
    await waitFor(() => expect(activity).toHaveBeenCalledWith(TICKET_ID));
    await waitFor(() => expect(screen.getByTestId("timeline-step-planApproved-at")).toBeTruthy());
    expect(screen.getByTestId("timeline-step-prReview-at")).toBeTruthy();
  });

  test("il verdetto della review del PROGETTO compare sul passo 'PR e review'", async () => {
    const reviews = jest.fn().mockResolvedValue([
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        repositoryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        repositoryName: "shop",
        ticketId: TICKET_ID,
        prNumber: 12,
        prUrl: "https://example.com/pr/12",
        prTitle: "Export CSV",
        status: "completed",
        verdict: "approve",
        prSummary: null,
        createdAt: "2026-08-12T15:00:00.000Z",
        finishedAt: "2026-08-12T15:10:00.000Z",
      },
    ]);
    const client = makeClient({ reviews, jobs: jest.fn().mockResolvedValue([job({ status: "pr_opened" })]) });
    await renderScreen(client);
    await waitFor(() => expect(reviews).toHaveBeenCalledWith("proj-1"));
    await waitFor(() => expect(screen.getByText("approvata")).toBeTruthy());
  });

  /**
   * Le due query nuove sono DECORAZIONE: datano dei passi e aggiungono un
   * verdetto. Un loro guasto non deve portarsi via la schermata — che il
   * ticket, i job e le domande hanno già caricato.
   */
  test("eventi e review che falliscono: la schermata resta viva, senza date né verdetto", async () => {
    const client = makeClient({
      activity: jest.fn().mockRejectedValue(new Error("down")),
      reviews: jest.fn().mockRejectedValue(new Error("down")),
      jobs: jest.fn().mockResolvedValue([job({ status: "pr_opened" })]),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Export CSV degli ordini")).toBeTruthy());
    expect(screen.queryByTestId("work-error")).toBeNull();
    expect(screen.getByTestId("timeline")).toBeTruthy();
    expect(screen.queryByTestId("timeline-step-planApproved-at")).toBeNull();
    expect(screen.queryByTestId("timeline-step-prReview-verdict")).toBeNull();
  });
});

/**
 * Pre-approvazione del piano (fase 7, App M3 Fase B): qui si verifica solo
 * il CABLAGGIO da `ticket` a `PlanSection` (i tre campi, `isAdmin`,
 * `isClosed`) — gli stati e le loro regole sono già coperti a fondo in
 * `PlanSection.test.tsx`.
 */
describe("WorkScreen — pre-approvazione del piano", () => {
  test("la riga di stato arriva ANCHE all'operatore (member), non solo al maintainer", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(
        ticket({
          implementationPlan: "Piano",
          planApprovedAt: "2026-08-12T09:00:00.000Z",
          planApprovedBy: { id: "u-admin", email: "maintainer@example.com" },
          planApprovalStale: false,
        }),
      ),
    });
    await renderScreen(client, "member");
    await waitFor(() => expect(screen.getByTestId("plan-section-approval-status")).toBeTruthy());
    expect(screen.getByText(/Piano approvato da maintainer@example\.com/)).toBeTruthy();
    // Il bottone resta del maintainer, anche se la riga si vede.
    expect(screen.queryByTestId("plan-section-pre-approve")).toBeNull();
  });

  test("il bottone di pre-approvazione arriva al maintainer con un piano presente", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(ticket({ implementationPlan: "Piano", planApprovedAt: null })),
    });
    await renderScreen(client, "admin");
    await waitFor(() => expect(screen.getByTestId("plan-section-pre-approve")).toBeTruthy());
  });

  test("un ticket chiuso: `isClosed` arriva a PlanSection, niente bottone anche per il maintainer", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(ticket({ implementationPlan: "Piano", status: "closed", planApprovedAt: null })),
    });
    await renderScreen(client, "admin");
    await waitFor(() => expect(screen.getByText("Export CSV degli ordini")).toBeTruthy());
    expect(screen.queryByTestId("plan-section-pre-approve")).toBeNull();
  });

  /**
   * 21 set 2026: aprendo un ticket DA un progetto, la riga «indietro» diceva
   * «‹ Progetti» — ma tornando indietro si finisce sul PROGETTO, non sulla
   * lista. Il maintainer l'ha segnalato guardandolo: l'etichetta prometteva
   * una destinazione diversa da quella vera.
   */
  it("la riga «indietro» dice dove si torna davvero, non «Progetti»", async () => {
    const client = makeClient();
    await renderScreen(client, "member", { backLabel: "Portale B2B" });
    expect(await screen.findByText("‹ Portale B2B")).toBeTruthy();
  });

  it("senza un progetto di provenienza resta il ripiego", async () => {
    // Dalla ricerca si entra nello stack Projects: lì «‹ Progetti» è corretto,
    // perché tornare indietro porta davvero alla lista.
    const client = makeClient();
    await renderScreen(client);
    expect(await screen.findByText("‹ Progetti")).toBeTruthy();
  });

});

describe("WorkScreen — rispondere a una domanda dell'agente", () => {
  test("la domanda APERTA si vede, e si risponde da qui", async () => {
    // ⚠️ Prima di questo batch una domanda aperta non compariva da nessuna
    // parte: `buildTimeline` legge solo quelle RISPOSTE (`answeredAt !==
    // null`) e le usa per datare un passo. Il job restava fermo finché
    // qualcuno non apriva il web. Questo test fissa il caso che mancava.
    const answerQuestion = jest.fn().mockResolvedValue({ jobId: JOB_ID });
    const client = makeClient({
      jobs: jest.fn().mockResolvedValue([job({ status: "awaiting_input", requestedByUserId: "viewer-1" })]),
      questions: jest.fn().mockResolvedValue([question()]),
      answerQuestion,
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("work-question")).toBeTruthy());
    expect(screen.getByText("Il CSV va separato da virgole o da punti e virgola?")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("work-question-option-1"));
    await fireEvent.press(screen.getByTestId("work-question-submit"));

    await waitFor(() =>
      expect(answerQuestion).toHaveBeenCalledWith(TICKET_ID, "44444444-4444-4444-8444-444444444444", {
        optionIndex: 1,
      }),
    );
  });

  test("dopo l'invio la domanda non è più in attesa", async () => {
    // Il test sopra prova che la chiamata parte; questo prova ciò che conta
    // per chi guarda: il blocco sparisce. L'invalidazione di `workKeys.all`
    // rilegge le domande, e al secondo giro quella è risposta — se la
    // mutazione non invalidasse, il form resterebbe lì a chiedere una cosa
    // già decisa.
    const questions = jest
      .fn()
      .mockResolvedValueOnce([question()])
      .mockResolvedValue([question({ answeredAt: "2026-08-12T09:40:00.000Z" })]);
    const client = makeClient({
      jobs: jest.fn().mockResolvedValue([job({ status: "awaiting_input", requestedByUserId: "viewer-1" })]),
      questions,
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("work-question")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-question-option-0"));
    await fireEvent.press(screen.getByTestId("work-question-submit"));

    await waitFor(() => expect(screen.queryByTestId("work-question")).toBeNull());
  });

  test("domanda GIÀ risposta: nessun blocco di risposta", async () => {
    // `answer` è null anche su una risposta che il server non riesce più a
    // rileggere: è `answeredAt` a dire che una decisione è stata presa, ed è
    // quello che la schermata deve guardare.
    const client = makeClient({
      jobs: jest.fn().mockResolvedValue([job({ status: "fixing", requestedByUserId: "viewer-1" })]),
      questions: jest
        .fn()
        .mockResolvedValue([question({ answeredAt: "2026-08-12T09:40:00.000Z", answer: null })]),
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("timeline")).toBeTruthy());
    expect(screen.queryByTestId("work-question")).toBeNull();
  });

  test("né maintainer né richiedente: la domanda si legge, non si risponde", async () => {
    // Stessa regola di `actorAllows` lato server, dove resta l'autorità.
    const client = makeClient({
      jobs: jest.fn().mockResolvedValue([job({ status: "awaiting_input", requestedByUserId: "un-altro" })]),
      questions: jest.fn().mockResolvedValue([question()]),
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("work-question")).toBeTruthy());
    expect(screen.getByTestId("work-question-read-only")).toBeTruthy();
    expect(screen.queryByTestId("work-question-submit")).toBeNull();
  });

  test("un maintainer sblocca la domanda di un collega", async () => {
    const answerQuestion = jest.fn().mockResolvedValue({ jobId: JOB_ID });
    const client = makeClient({
      jobs: jest.fn().mockResolvedValue([job({ status: "awaiting_input", requestedByUserId: "un-altro" })]),
      questions: jest.fn().mockResolvedValue([question()]),
      answerQuestion,
    });

    await renderScreen(client, "admin");

    await waitFor(() => expect(screen.getByTestId("work-question-submit")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-question-option-0"));
    await fireEvent.press(screen.getByTestId("work-question-submit"));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalled());
  });
});

describe("WorkScreen — avviare il lavoro", () => {
  test("nessun job: un OPERATORE può avviare il lavoro", async () => {
    // Il divieto dell'operatore non è "non avviare", è "non approvare da solo
    // il piano": quel gate vive in `jobs.ts` lato server, che per un member fa
    // nascere il run già fermo sul gate. Nascondere il bottone qui gli
    // toglierebbe il lavoro quotidiano senza proteggere nulla.
    const runAi = jest.fn().mockResolvedValue({ jobId: JOB_ID, status: "queued" });
    const client = makeClient({ jobs: jest.fn().mockResolvedValue([]), runAi });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("work-run-start")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-run-start"));
    await waitFor(() => expect(runAi).toHaveBeenCalledWith(TICKET_ID, undefined));
  });

  test("job in volo: niente bottone di avvio", async () => {
    const client = makeClient({ jobs: jest.fn().mockResolvedValue([job({ status: "fixing" })]) });
    await renderScreen(client, "admin");
    await waitFor(() => expect(screen.getByTestId("timeline")).toBeTruthy());
    expect(screen.queryByTestId("work-run-start")).toBeNull();
  });

  test("job fallito CON un commento di una persona: si riprende dalle istruzioni", async () => {
    const runAi = jest.fn().mockResolvedValue({ jobId: JOB_ID, status: "queued" });
    const client = makeClient({
      jobs: jest.fn().mockResolvedValue([job({ status: "failed" })]),
      comments: jest.fn().mockResolvedValue([comment()]),
      runAi,
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("work-run-with-instructions")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-run-with-instructions"));
    await waitFor(() => expect(runAi).toHaveBeenCalledWith(TICKET_ID, { withInstructions: true }));
  });

  test("job fallito SENZA commenti: nessun 'riprendi', non avrebbe istruzioni da leggere", async () => {
    const client = makeClient({
      jobs: jest.fn().mockResolvedValue([job({ status: "failed" })]),
      comments: jest.fn().mockResolvedValue([]),
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("work-run-start")).toBeTruthy());
    expect(screen.queryByTestId("work-run-with-instructions")).toBeNull();
  });
});

describe("WorkScreen — modificare i campi", () => {
  test("un OPERATORE cambia lo stato: la PATCH porta SOLO quel campo", async () => {
    // La rotta è `requireAuth`: nessun gate di ruolo nel client, o sarebbe una
    // seconda copia della regola dalla parte che si aggiorna dagli store.
    const patch = jest.fn().mockResolvedValue(ticket());
    const client = makeClient({ patch });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("ticket-field-status")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("ticket-field-status"));
    await fireEvent.press(screen.getByTestId("ticket-field-status-choice-in_review"));

    await waitFor(() => expect(patch).toHaveBeenCalledWith(TICKET_ID, { status: "in_review" }));
  });

  test("scegliere il valore che c'è già non manda nessuna PATCH", async () => {
    // Una patch che non cambia niente sarebbe comunque un `updated_at` toccato
    // e una riga di audit: rumore su una timeline che si legge per capire cosa
    // è successo.
    const patch = jest.fn().mockResolvedValue(ticket());
    const client = makeClient({ patch });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("ticket-field-status")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("ticket-field-status"));
    await fireEvent.press(screen.getByTestId("ticket-field-status-choice-in_progress"));

    expect(patch).not.toHaveBeenCalled();
  });

  test("assegnatario: l'elenco arriva, e azzerarlo manda `null` (non un campo assente)", async () => {
    const patch = jest.fn().mockResolvedValue(ticket());
    const client = makeClient({
      get: jest.fn().mockResolvedValue(ticket({ assigneeId: "viewer-1" })),
      users: jest.fn().mockResolvedValue([{ id: "viewer-1", email: "op@example.com", role: "member" }]),
      patch,
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByText("op@example.com")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("ticket-field-assignee"));
    await fireEvent.press(screen.getByTestId("ticket-field-assignee-choice-none"));

    await waitFor(() => expect(patch).toHaveBeenCalledWith(TICKET_ID, { assigneeId: null }));
  });

  test("elenco utenti in errore: la riga resta leggibile ma non premibile, e la schermata vive", async () => {
    const client = makeClient({
      users: jest.fn().mockRejectedValue(new Error("down")),
      milestones: jest.fn().mockRejectedValue(new Error("down")),
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("ticket-fields")).toBeTruthy());
    expect(screen.getByTestId("timeline")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("ticket-field-assignee"));
    expect(screen.queryByTestId("ticket-field-assignee-choice-none")).toBeNull();
  });
});

/**
 * LE ETICHETTE (23 set 2026): la quinta cosa che il web modifica dal
 * pannello del ticket, rimasta fuori dalla parità del 21 settembre (§4.1 del
 * suo design). Tutti i test girano come OPERATORE: come gli altri quattro
 * campi, la rotta è `requireAuth` e non `requireAdmin`.
 */
describe("WorkScreen — etichette", () => {
  async function openLabels(labels: string[], patch = jest.fn().mockResolvedValue(ticket())) {
    const client = makeClient({ get: jest.fn().mockResolvedValue(ticket({ labels })), patch });
    await renderScreen(client, "member");
    await waitFor(() => expect(screen.getByTestId("ticket-field-labels")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("ticket-field-labels"));
    return patch;
  }

  test("le etichette si leggono nel campo, separate da virgola", async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue(ticket({ labels: ["ios", "checkout"] })) });
    await renderScreen(client, "member");
    await waitFor(() => expect(screen.getByText("ios, checkout")).toBeTruthy());
  });

  test("aggiungere: la PATCH porta l'elenco COMPLETO, con la nuova in fondo e senza spazi ai bordi", async () => {
    // La PATCH delle etichette SOSTITUISCE l'insieme: mandare solo la nuova
    // cancellerebbe le altre.
    const patch = await openLabels(["ios"]);
    await fireEvent.changeText(screen.getByTestId("ticket-field-labels-input"), "  checkout  ");
    await fireEvent.press(screen.getByTestId("ticket-field-labels-add"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(TICKET_ID, { labels: ["ios", "checkout"] }));
  });

  test("aggiungere anche dal tasto «fatto» della tastiera", async () => {
    const patch = await openLabels([]);
    const input = screen.getByTestId("ticket-field-labels-input");
    await fireEvent.changeText(input, "ios");
    await fireEvent(input, "submitEditing");
    await waitFor(() => expect(patch).toHaveBeenCalledWith(TICKET_ID, { labels: ["ios"] }));
  });

  test("togliere: la PATCH porta l'elenco senza quella", async () => {
    const patch = await openLabels(["ios", "checkout"]);
    await fireEvent.press(screen.getByTestId("ticket-field-labels-remove-ios"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(TICKET_ID, { labels: ["checkout"] }));
  });

  test("un doppione identico non parte, e la sheet DICE perché", async () => {
    // Il web lo scarta in silenzio; su un telefono un tocco che non fa niente
    // sembra un guasto.
    const patch = await openLabels(["ios"]);
    await fireEvent.changeText(screen.getByTestId("ticket-field-labels-input"), "ios");
    await fireEvent.press(screen.getByTestId("ticket-field-labels-add"));
    expect(screen.getByTestId("ticket-field-labels-notice")).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
  });

  test("solo spazi: niente PATCH, né dal bottone né dalla tastiera", async () => {
    const patch = await openLabels(["ios"]);
    const input = screen.getByTestId("ticket-field-labels-input");
    await fireEvent.changeText(input, "   ");
    await fireEvent.press(screen.getByTestId("ticket-field-labels-add"));
    await fireEvent(input, "submitEditing");
    expect(patch).not.toHaveBeenCalled();
  });

  test("al limite di 20 non si può aggiungere, e si dice perché", async () => {
    // Il limite lo impone il SERVER (`labelsSchema`): qui si dice prima,
    // invece di far partire una richiesta che torna 400.
    const twenty = Array.from({ length: 20 }, (_, index) => `e${index}`);
    const patch = await openLabels(twenty);
    expect(screen.getByTestId("ticket-field-labels-full")).toBeTruthy();
    expect(screen.queryByTestId("ticket-field-labels-input")).toBeNull();
    // Togliere resta possibile: è il modo di fare spazio.
    await fireEvent.press(screen.getByTestId("ticket-field-labels-remove-e0"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(TICKET_ID, { labels: twenty.slice(1) }));
  });
});

describe("WorkScreen — commentare", () => {
  test("i commenti si VEDONO, con l'autore e il testo", async () => {
    // Prima di questo batch l'app non li mostrava da nessuna parte: la
    // timeline ha sei passi fissi, e `ticketActivityEntrySchema` spoglia
    // autore e corpo di un commento.
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([comment()]),
      users: jest.fn().mockResolvedValue([{ id: "viewer-1", email: "op@example.com", role: "member" }]),
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByText("Ho controllato io, manca il separatore.")).toBeTruthy());
    expect(screen.getByText("op@example.com")).toBeTruthy();
  });

  test("un OPERATORE scrive un commento: il corpo arriva sfrondato", async () => {
    const commentFn = jest.fn().mockResolvedValue(comment());
    const client = makeClient({ comment: commentFn });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("work-comment-input")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("work-comment-input"), "  Ci penso io  ");
    await fireEvent.press(screen.getByTestId("work-comment-send"));

    await waitFor(() => expect(commentFn).toHaveBeenCalledWith(TICKET_ID, "Ci penso io"));
  });

  test("un commento vuoto (o di soli spazi) non parte", async () => {
    const commentFn = jest.fn().mockResolvedValue(comment());
    const client = makeClient({ comment: commentFn });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("work-comment-input")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("work-comment-input"), "   ");
    await fireEvent.press(screen.getByTestId("work-comment-send"));

    expect(commentFn).not.toHaveBeenCalled();
  });

  test("un commento dell'agente porta la sua origine, non un'email inventata", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([comment({ authorType: "ai", authorId: null, body: "Ho aperto la PR." })]),
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByText("Ho aperto la PR.")).toBeTruthy());
    expect(screen.getByText("agente")).toBeTruthy();
  });

  test("commenti che non arrivano: lo dice, e il resto della schermata resta", async () => {
    const client = makeClient({ comments: jest.fn().mockRejectedValue(new Error("down")) });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("work-comments-unavailable")).toBeTruthy());
    expect(screen.getByTestId("timeline")).toBeTruthy();
  });
});

describe("WorkScreen — le due cancellazioni", () => {
  test("UN SOLO tocco non cancella niente: serve la conferma", async () => {
    // ⚠️ È la proprietà che il design chiede (§4): design e piano cancellati
    // non si recuperano, e su un telefono si tocca per sbaglio più che su un
    // computer.
    const deleteDesign = jest.fn().mockResolvedValue(ticket());
    const client = makeClient({
      get: jest.fn().mockResolvedValue(ticket({ originContent: "Il design originale" })),
      deleteDesign,
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("work-delete-design")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-delete-design"));

    expect(deleteDesign).not.toHaveBeenCalled();
    expect(screen.getByTestId("work-delete-confirm-yes")).toBeTruthy();
  });

  test("il secondo tocco NON cade dove è caduto il primo", async () => {
    // Sul web i due passi si sovrappongono (`ConfirmDeleteButton` sostituisce
    // il bottone in loco): con un mouse va bene, con un pollice no. Qui la
    // conferma vive in una modale, quindi un doppio tap sullo stesso punto
    // non può arrivare in fondo — e "Annulla" è lì accanto.
    const client = makeClient({
      get: jest.fn().mockResolvedValue(ticket({ originContent: "Il design originale" })),
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("work-delete-design")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-delete-design"));

    expect(screen.getByTestId("work-delete-confirm")).toBeTruthy();
    expect(screen.getByTestId("work-delete-cancel")).toBeTruthy();
  });

  test("confermando, il design si cancella", async () => {
    const deleteDesign = jest.fn().mockResolvedValue(ticket());
    const client = makeClient({
      get: jest.fn().mockResolvedValue(ticket({ originContent: "Il design originale" })),
      deleteDesign,
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("work-delete-design")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-delete-design"));
    await fireEvent.press(screen.getByTestId("work-delete-confirm-yes"));

    await waitFor(() => expect(deleteDesign).toHaveBeenCalledWith(TICKET_ID));
  });

  test("annullando non si cancella niente", async () => {
    const deletePlan = jest.fn().mockResolvedValue(ticket());
    const client = makeClient({
      get: jest.fn().mockResolvedValue(ticket({ implementationPlan: "## Piano\n1. Fare" })),
      deletePlan,
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("work-delete-plan")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-delete-plan"));
    await fireEvent.press(screen.getByTestId("work-delete-cancel"));

    expect(deletePlan).not.toHaveBeenCalled();
  });

  test("niente design e niente piano: nessun bottone da premere per sbaglio", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(ticket({ originContent: null, implementationPlan: null })),
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("timeline")).toBeTruthy());
    expect(screen.queryByTestId("work-destructive")).toBeNull();
  });
});

describe("WorkScreen — i permessi che il server NON ha, il client non li inventa", () => {
  test("un OPERATORE vede e può usare tutte e sei le azioni non-admin", async () => {
    // ⚠️ Design §3: solo le QUATTRO azioni sul piano sono `requireAdmin`. Le
    // altre sei sono `requireAuth`, e un controllo di ruolo aggiunto qui
    // sarebbe una seconda copia della regola — dalla parte che si aggiorna
    // dagli store, non dai nostri deploy.
    const client = makeClient({
      get: jest.fn().mockResolvedValue(
        ticket({ originContent: "Design", implementationPlan: "## Piano" }),
      ),
      jobs: jest.fn().mockResolvedValue([job({ status: "awaiting_input", requestedByUserId: "viewer-1" })]),
      questions: jest.fn().mockResolvedValue([question()]),
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("ticket-fields")).toBeTruthy());
    expect(screen.getByTestId("work-question-submit")).toBeTruthy(); // rispondere
    expect(screen.getByTestId("work-comment-send")).toBeTruthy(); // commentare
    expect(screen.getByTestId("ticket-field-status")).toBeTruthy(); // modificare i campi
    expect(screen.getByTestId("work-delete-design")).toBeTruthy(); // cancellare il design
    expect(screen.getByTestId("work-delete-plan")).toBeTruthy(); // cancellare il piano
  });

  test("le QUATTRO azioni sul piano restano al maintainer, come oggi", async () => {
    // Questo batch passa vicino a quel codice: il test lo dice a voce alta.
    const client = makeClient({
      get: jest.fn().mockResolvedValue(ticket({ implementationPlan: "## Piano" })),
      jobs: jest.fn().mockResolvedValue([job({ status: "awaiting_plan_approval" })]),
    });

    await renderScreen(client, "member");

    await waitFor(() => expect(screen.getByTestId("timeline")).toBeTruthy());
    expect(screen.queryByTestId("plan-section-approve")).toBeNull();
    expect(screen.queryByTestId("plan-section-reject")).toBeNull();
    expect(screen.queryByTestId("plan-section-pre-approve")).toBeNull();
  });
});
