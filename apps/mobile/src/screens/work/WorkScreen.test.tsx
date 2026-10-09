import type { StubwiseClient } from "@stubwise/api-client";
import { ApiError } from "@stubwise/api-client";
import { UNKNOWN, readerSchema, ticketRepositorySchema } from "@stubwise/shared";
import type {
  AiJob,
  PrCycle,
  TicketComment,
  TicketDetail,
  TicketHistoryEvent,
  TicketQuestion,
  Reader,
} from "@stubwise/shared";
import { NavigationContext } from "@react-navigation/native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { Keyboard, ScrollView, StyleSheet } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { workKeys } from "../../lib/work-mutations";
import type { TicketTab } from "../../lib/ticket-tabs";
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
const CORRECTION_ID = "66666666-6666-4666-8666-666666666666";
const HELD_JOB_ID = "77777777-7777-4777-8777-777777777777";
const PR_URL = "https://bitbucket.org/acme/portale-b2b/pull-requests/10";

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
    // I campi del piano (fase 5/7): COMPLETI, la trappola delle fixture
    // dell'app — dietro il cast il compilatore non li chiede.
    planSummary: null,
    planApprovedAt: null,
    planApprovedBy: null,
    planApprovalStale: false,
    // Adozione (6 ott 2026): null per ogni ticket che non è review.
    prAdoption: null,
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
    // 0083: COMPLETA anche qui (trappola delle fixture): il parse non gira nei
    // test, e un `replyTo` assente arriverebbe `undefined` alla riga.
    replyTo: null,
    // 0084: COMPLETA anche qui, per la stessa ragione.
    editedAt: null,
    deletedAt: null,
    deletedBy: null,
    canEdit: false,
    canDelete: false,
    inDecisionLog: false,
    ...overrides,
  } as Reader<TicketComment>;
}

/** Un evento della storia, COMPLETO: il parse non gira nei test (trappola delle fixture). */
function historyEvent(i: number, overrides: Partial<Reader<TicketHistoryEvent>> = {}): Reader<TicketHistoryEvent> {
  return {
    id: `run_started:${i}`,
    kind: "run_started",
    at: new Date(Date.UTC(2026, 7, 12, 12, 0) - i * 60_000).toISOString(),
    actor: null,
    prNumber: null,
    prUrl: null,
    round: null,
    detail: null,
    fromStatus: null,
    ...overrides,
  };
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
  history?: jest.Mock;
  comments?: jest.Mock;
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
  requestCorrection?: jest.Mock;
  adoptPr?: jest.Mock;
  releasePrAdoption?: jest.Mock;
  editComment?: jest.Mock;
  deleteComment?: jest.Mock;
  agentSessions?: jest.Mock;
} = {}): StubwiseClient {
  return {
    tickets: {
      get: overrides.get ?? jest.fn().mockResolvedValue(ticket()),
      jobs: overrides.jobs ?? jest.fn().mockResolvedValue([]),
      questions: overrides.questions ?? jest.fn().mockResolvedValue([] as Reader<TicketQuestion>[]),
      history: overrides.history ?? jest.fn().mockResolvedValue({ events: [], total: 0 }),
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
      requestCorrection: overrides.requestCorrection ?? jest.fn().mockResolvedValue({ correctionId: CORRECTION_ID }),
      // Adozione (6 ott 2026): nel doppio PRIMA dei test che li usano.
      adoptPr: overrides.adoptPr ?? jest.fn().mockResolvedValue({ correctionId: CORRECTION_ID }),
      releasePrAdoption: overrides.releasePrAdoption ?? jest.fn().mockResolvedValue(undefined),
      // 0084: nel doppio PRIMA dei test che li usano (trappola del doppio).
      editComment: overrides.editComment ?? jest.fn().mockResolvedValue(comment()),
      deleteComment: overrides.deleteComment ?? jest.fn().mockResolvedValue(undefined),
    },
    projects: {
      milestones: overrides.milestones ?? jest.fn().mockResolvedValue([]),
    },
    users: { list: overrides.users ?? jest.fn().mockResolvedValue([]) },
    // Piano C, Task 8: la ricerca della sessione del job («Guarda la
    // sessione»), nel doppio PRIMA dei test che la usano (trappola del doppio).
    agentSessions: { list: overrides.agentSessions ?? jest.fn().mockResolvedValue({ live: [], recent: [] }) },
  } as unknown as StubwiseClient;
}

const clients: QueryClient[] = [];
afterEach(() => {
  // Niente QueryClient vivi a fine test: i timer di gc (e il polling della
  // ricerca della sessione) tengono aperto il processo.
  clients.splice(0).forEach((c) => c.clear());
});

type ScreenParams = { id?: string; backLabel?: string; tab?: TicketTab };

async function renderScreen(
  client: StubwiseClient,
  role: "admin" | "member" = "member",
  extraParams: ScreenParams = {},
  focusNavigation?: object,
) {
  // `gcTime: Infinity` su query e mutazioni: lo smontaggio di fine test
  // (dopo il `clear()` qui sopra) programmerebbe i timer di raccolta da 5
  // minuti, e il processo di Jest non uscirebbe («worker failed to exit»).
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  clients.push(queryClient);
  const goBack = jest.fn();
  const navigate = jest.fn();
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
  const navigation = { goBack, navigate } as never;
  // I params come li dà react-navigation: un OGGETTO NUOVO a ogni `navigate`
  // (`createParamsFromAction`, routers 7), lo STESSO oggetto ai render che non
  // vengono da una navigazione (un refetch, un genitore che ridisegna).
  let current: { id: string } & ScreenParams = { id: TICKET_ID, ...extraParams };
  const screenEl = () => <WorkScreen navigation={navigation} route={{ key: "Ticket", name: "Ticket", params: current }} />;
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        {focusNavigation ? (
          <NavigationContext.Provider value={focusNavigation as never}>{screenEl()}</NavigationContext.Provider>
        ) : (
          screenEl()
        )}
      </AuthContext.Provider>
    </QueryClientProvider>
  );
  const rendered = await render(tree());
  /** Un `navigate` nuovo sulla schermata montata: params NUOVI, anche se con gli stessi valori. */
  const rerenderWith = (params: ScreenParams) => {
    current = { id: TICKET_ID, ...params };
    return rendered.rerender(tree());
  };
  /** Un render che NON è una navigazione: gli STESSI params, lo stesso oggetto. */
  const rerenderSame = () => rendered.rerender(tree());
  return { rendered, goBack, navigate, rerenderWith, rerenderSame, queryClient };
}

/**
 * Pagina del ticket a tab (2 ott 2026): Stato, Contenuto, Attività, Dettagli.
 * Le tab non attive restano montate ma nascoste (`display: "none"`), e le
 * query di default di RNTL ESCLUDONO gli elementi nascosti: un test che cerca
 * qualcosa fuori da Stato deve prima premere la sua tab. Mai
 * `includeHiddenElements`: il test verificherebbe una cosa che chi guarda non
 * vede.
 */
async function openTab(tab: "status" | "content" | "activity" | "details") {
  await waitFor(() => expect(screen.getByTestId(`work-tab-${tab}`)).toBeTruthy());
  await fireEvent.press(screen.getByTestId(`work-tab-${tab}`));
}

/** Aspetta che il ticket sia caricato: le tab compaiono solo allora. */
async function loaded() {
  await waitFor(() => expect(screen.getByTestId("work-panel-status")).toBeTruthy());
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
    // Badge e numero stanno nell'intestazione FISSA, visibili da ogni tab.
    expect(screen.getByText("In attesa di risposta")).toBeTruthy();
    expect(screen.getByText("lavoro #247")).toBeTruthy();
    // La descrizione sta in Contenuto. L'apostrofo è quello TIPOGRAFICO (’):
    // dal 24 set 2026 il corpo passa dal markdown, che lo converte come fa già
    // nel piano e nelle pagine di Docs.
    await openTab("content");
    expect(screen.getByText("Aggiunge l’esportazione CSV degli ordini per il gestionale.")).toBeTruthy();
  });

  /**
   * ⚠️ IL CORPO È MARKDOWN (24 set 2026, segnalato dal maintainer sul
   * telefono): si leggeva come testo grezzo, con `##` e `**` a vista. Il test
   * asserisce che la sintassi SPARISCA, non solo che il testo ci sia: un
   * `<Text>` grezzo mostrerebbe comunque «Contesto» dentro «## Contesto», e
   * un test che cercasse solo la parola passerebbe anche col difetto.
   */
  test("il corpo è markdown vero: intestazioni, grassetto ed elenchi senza la sintassi a vista", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(
        ticket({ body: "## Contesto\n\nIl checkout è **lento**.\n\n- primo punto\n- secondo punto" }),
      ),
    });
    await renderScreen(client);
    await openTab("content");
    const body = await waitFor(() => within(screen.getByTestId("work-body")));
    expect(body.getByText("Contesto")).toBeTruthy();
    expect(body.getByText("lento")).toBeTruthy();
    expect(body.getByText("primo punto")).toBeTruthy();
    expect(body.queryByText(/##/)).toBeNull();
    expect(body.queryByText(/\*\*/)).toBeNull();
  });

  test("nessuna descrizione: testo dedicato invece di una riga vuota", async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue(ticket({ body: "   " })) });
    await renderScreen(client);
    await openTab("content");
    await waitFor(() => expect(screen.getByText("Nessuna descrizione.")).toBeTruthy());
  });

  test("job 'fixing' con startedAt: mostra la WorkingPill", async () => {
    const client = makeClient({
      jobs: jest.fn().mockResolvedValue([job({ status: "fixing", startedAt: "2026-08-12T09:10:00.000Z" })]),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("working-pill")).toBeTruthy());
  });

  test("nessun job: niente WorkingPill, badge come 'proposed', storia vuota in Attività", async () => {
    const client = makeClient();
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Export CSV degli ordini")).toBeTruthy());
    expect(screen.queryByTestId("working-pill")).toBeNull();
    expect(screen.getByText("In coda")).toBeTruthy();
    await openTab("activity");
    await waitFor(() => expect(screen.getByTestId("work-history-empty")).toBeTruthy());
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
    expect(screen.queryByTestId("plan-section-approve")).toBeNull();
    // Il livello tecnico vivrebbe in Dettagli: lo si cerca LÌ, o l'assenza
    // sarebbe solo quella di una tab nascosta.
    await openTab("details");
    expect(screen.getByTestId("ticket-fields")).toBeTruthy();
    expect(screen.queryByText("Livello tecnico · solo maintainer")).toBeNull();
  });

  test("admin ma job NON awaiting_plan_approval: 'Livello tecnico' c'è, Approva/Rifiuta no", async () => {
    const client = makeClient({ jobs: jest.fn().mockResolvedValue([job({ status: "fixing" })]) });
    await renderScreen(client, "admin");
    await loaded();
    expect(screen.queryByTestId("plan-section-approve")).toBeNull();
    await openTab("details");
    await waitFor(() => expect(screen.getByText("Livello tecnico · solo maintainer")).toBeTruthy());
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
              cycle: null,
            },
          ],
        }),
      ),
    });
    await renderScreen(client, "admin");
    await openTab("details");
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

});

/**
 * La storia VERA del ticket (piano B3, 5 ott 2026): viene da
 * `tickets.history`, sta in Attività fuori dai gate della schermata, e un suo
 * guasto — o un server più vecchio della rotta, 404 — costa solo la sezione.
 */
describe("WorkScreen — la storia del ticket", () => {
  test("la storia viene da tickets.history del ticket aperto, una riga per evento", async () => {
    const history = jest.fn().mockResolvedValue({
      events: [
        historyEvent(0, { id: "ticket_closed:1", kind: "ticket_closed", detail: "done" }),
        historyEvent(1, {
          id: "correction_pushed:1",
          kind: "correction_pushed",
          prNumber: 4,
          round: 3,
          prUrl: "https://bitbucket.org/acme/r/pull-requests/4",
        }),
      ],
      total: 2,
    });
    await renderScreen(makeClient({ history }));
    await waitFor(() => expect(history).toHaveBeenCalledWith(TICKET_ID));
    await openTab("activity");
    await waitFor(() => expect(screen.getByText("Ticket chiuso (done)")).toBeTruthy());
    expect(screen.getByText("PR #4 · correzione 3")).toBeTruthy();
  });

  test("12 eventi: 8 righe e «Mostra tutto (12)»", async () => {
    const events = Array.from({ length: 12 }, (_, i) => historyEvent(i));
    await renderScreen(makeClient({ history: jest.fn().mockResolvedValue({ events, total: 12 }) }));
    await openTab("activity");
    await waitFor(() => expect(screen.getByText("Mostra tutto (12)")).toBeTruthy());
    expect(screen.getAllByTestId(/^work-history-row-/)).toHaveLength(8);
  });

  test("server vecchio (404 su /history): «Storia non disponibile», composer e commenti ci sono", async () => {
    const client = makeClient({
      history: jest.fn().mockRejectedValue(new ApiError(404, "Not found", "not_found")),
      comments: jest.fn().mockResolvedValue([comment()]),
    });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByText("Export CSV degli ordini")).toBeTruthy());
    expect(screen.queryByTestId("work-error")).toBeNull();
    await openTab("activity");
    await waitFor(() => expect(screen.getByText("Storia non disponibile.")).toBeTruthy());
    expect(screen.getByTestId("work-comment-composer")).toBeTruthy();
    expect(screen.getByText("Ho controllato io, manca il separatore.")).toBeTruthy();
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
    // parte: `buildTimeline` (la vecchia timeline a sei passi, tolta il 5 ott
    // 2026) leggeva solo quelle RISPOSTE (`answeredAt !== null`) e le usava
    // per datare un passo. Il job restava fermo finché
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

    // La domanda vivrebbe in Stato, la tab aperta: la si cerca lì.
    await loaded();
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
    await loaded();
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

describe("WorkScreen — perché l'ultimo job si è fermato", () => {
  test("job fallito: in Stato c'è la spiegazione in parole semplici, non solo il badge", async () => {
    const client = makeClient({
      jobs: jest.fn().mockResolvedValue([
        job({ status: "failed", error: "push rifiutato", failureSummary: "Qualcuno ha modificato il branch nel frattempo." }),
      ]),
    });
    await renderScreen(client, "admin");
    await waitFor(() =>
      expect(screen.getByTestId("work-failure-text")).toHaveTextContent("Qualcuno ha modificato il branch nel frattempo."),
    );
  });

  test("senza riassunto (cache di prima del campo): resta l'errore tecnico", async () => {
    const failed = job({ status: "failed", error: "push rifiutato" });
    delete (failed as { failureSummary?: unknown }).failureSummary;
    const client = makeClient({ jobs: jest.fn().mockResolvedValue([failed]) });
    await renderScreen(client, "admin");
    await waitFor(() => expect(screen.getByTestId("work-failure-text")).toHaveTextContent("push rifiutato"));
  });

  test("job non fallito: nessun blocco", async () => {
    const client = makeClient({ jobs: jest.fn().mockResolvedValue([job({ status: "pr_opened", failureSummary: "vecchio" })]) });
    await renderScreen(client, "admin");
    await loaded();
    expect(screen.queryByTestId("work-failure")).toBeNull();
  });
});

describe("WorkScreen — modificare i campi", () => {
  test("un OPERATORE cambia lo stato: la PATCH porta SOLO quel campo", async () => {
    // La rotta è `requireAuth`: nessun gate di ruolo nel client, o sarebbe una
    // seconda copia della regola dalla parte che si aggiorna dagli store.
    const patch = jest.fn().mockResolvedValue(ticket());
    const client = makeClient({ patch });

    await renderScreen(client, "member");

    await openTab("details");
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

    await openTab("details");
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

    await openTab("details");
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

    await openTab("details");
    await waitFor(() => expect(screen.getByTestId("ticket-fields")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("ticket-field-assignee"));
    expect(screen.queryByTestId("ticket-field-assignee-choice-none")).toBeNull();
    // E la schermata vive: la storia, in Attività, c'è.
    await openTab("activity");
    expect(screen.getByTestId("work-history")).toBeTruthy();
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
    await openTab("details");
    await waitFor(() => expect(screen.getByTestId("ticket-field-labels")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("ticket-field-labels"));
    return patch;
  }

  test("le etichette si leggono nel campo, separate da virgola", async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue(ticket({ labels: ["ios", "checkout"] })) });
    await renderScreen(client, "member");
    await openTab("details");
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
    // vecchia timeline aveva sei passi fissi, e `ticketActivityEntrySchema` spoglia
    // autore e corpo di un commento.
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([comment()]),
      users: jest.fn().mockResolvedValue([{ id: "viewer-1", email: "op@example.com", role: "member" }]),
    });

    await renderScreen(client, "member");

    await openTab("activity");
    await waitFor(() => expect(screen.getByText("Ho controllato io, manca il separatore.")).toBeTruthy());
    expect(screen.getByText("op@example.com")).toBeTruthy();
  });

  test("un OPERATORE scrive un commento: il corpo arriva sfrondato", async () => {
    const commentFn = jest.fn().mockResolvedValue(comment());
    const client = makeClient({ comment: commentFn });

    await renderScreen(client, "member");

    await openTab("activity");
    await waitFor(() => expect(screen.getByTestId("work-comment-input")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("work-comment-input"), "  Ci penso io  ");
    await fireEvent.press(screen.getByTestId("work-comment-send"));

    await waitFor(() => expect(commentFn).toHaveBeenCalledWith(TICKET_ID, "Ci penso io"));
    // SENZA terzo argomento: un commento che non risponde a nessuno manda il
    // corpo di sempre (l'api-client lo traduce in `{ body }` esatto).
    expect(commentFn.mock.calls[0]).toHaveLength(2);
  });

  test("un commento vuoto (o di soli spazi) non parte", async () => {
    const commentFn = jest.fn().mockResolvedValue(comment());
    const client = makeClient({ comment: commentFn });

    await renderScreen(client, "member");

    await openTab("activity");
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

    await openTab("activity");
    await waitFor(() => expect(screen.getByText("Ho aperto la PR.")).toBeTruthy());
    expect(screen.getByText("agente")).toBeTruthy();
  });

  test("commenti che non arrivano: lo dice, e il resto della schermata resta", async () => {
    const client = makeClient({ comments: jest.fn().mockRejectedValue(new Error("down")) });

    await renderScreen(client, "member");

    await openTab("activity");
    await waitFor(() => expect(screen.getByTestId("work-comments-unavailable")).toBeTruthy());
    expect(screen.getByTestId("work-history")).toBeTruthy();
  });
});

/**
 * Rispondere a un commento (piano B4): «Rispondi» su ogni commento, la riga
 * «Rispondendo a …» sopra il campo, la riga «In risposta a …» sopra la
 * risposta, premibile solo se l'originale è nell'elenco.
 */
describe("WorkScreen — rispondere a un commento", () => {
  const ORIGINAL_ID = "33333333-3333-4333-8333-3333333333a1";
  const REPLY_ID = "33333333-3333-4333-8333-3333333333a2";

  test("«Rispondi» apre il campo SOTTO il commento, senza scorrere in cima; Annulla lo chiude", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([
        comment({ id: ORIGINAL_ID, authorType: "ai", authorId: null, body: "Fix **automatico** pronto." }),
      ]),
    });
    await renderScreen(client, "member");
    await openTab("activity");
    await waitFor(() => expect(screen.getByTestId(`work-comment-reply-${ORIGINAL_ID}`)).toBeTruthy());

    const scrollTo = jest.spyOn(ScrollView.prototype, "scrollTo");
    scrollTo.mockClear();
    try {
      await fireEvent.press(screen.getByTestId(`work-comment-reply-${ORIGINAL_ID}`));
      // Il campo è DENTRO la riga del commento a cui si risponde…
      const row = within(screen.getByTestId(`work-comment-${ORIGINAL_ID}`));
      expect(row.getByTestId("work-reply-input")).toBeTruthy();
      // …al posto del bottone, e la pagina non salta in cima.
      expect(row.queryByTestId(`work-comment-reply-${ORIGINAL_ID}`)).toBeNull();
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      scrollTo.mockClear();
    }

    await fireEvent.press(screen.getByTestId("work-reply-cancel"));
    expect(screen.queryByTestId("work-reply-input")).toBeNull();
    expect(screen.getByTestId(`work-comment-reply-${ORIGINAL_ID}`)).toBeTruthy();
  });

  test("inviata in risposta: comment(id, corpo, { replyToCommentId }), poi il campo si chiude", async () => {
    const commentFn = jest.fn().mockResolvedValue(comment());
    const client = makeClient({
      comment: commentFn,
      comments: jest.fn().mockResolvedValue([comment({ id: ORIGINAL_ID })]),
    });
    await renderScreen(client, "member");
    await openTab("activity");
    await waitFor(() => expect(screen.getByTestId(`work-comment-reply-${ORIGINAL_ID}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`work-comment-reply-${ORIGINAL_ID}`));
    await fireEvent.changeText(screen.getByTestId("work-reply-input"), "  Concordo  ");
    await fireEvent.press(screen.getByTestId("work-reply-send"));

    await waitFor(() =>
      expect(commentFn).toHaveBeenCalledWith(TICKET_ID, "Concordo", { replyToCommentId: ORIGINAL_ID }),
    );
    await waitFor(() => expect(screen.queryByTestId("work-reply-input")).toBeNull());
  });

  test("invio fallito (422): il campo della risposta e la bozza RESTANO", async () => {
    const commentFn = jest
      .fn()
      .mockRejectedValue(new ApiError(422, "Reply target is not a comment of this ticket", "reply_target_invalid"));
    const client = makeClient({
      comment: commentFn,
      comments: jest.fn().mockResolvedValue([comment({ id: ORIGINAL_ID })]),
    });
    await renderScreen(client, "member");
    await openTab("activity");
    await waitFor(() => expect(screen.getByTestId(`work-comment-reply-${ORIGINAL_ID}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`work-comment-reply-${ORIGINAL_ID}`));
    await fireEvent.changeText(screen.getByTestId("work-reply-input"), "Concordo");
    await fireEvent.press(screen.getByTestId("work-reply-send"));

    await waitFor(() => expect(screen.getByTestId("work-reply-error")).toBeTruthy());
    expect(screen.getByTestId("work-reply-input").props.value).toBe("Concordo");
  });

  test("accessibilità: «Rispondi a {nome}» sul bottone, e il campo dice a chi si risponde", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([
        comment({ id: ORIGINAL_ID, authorType: "ai", authorId: null, body: "Fix pronto." }),
      ]),
    });
    await renderScreen(client, "member");
    await openTab("activity");
    const reply = await waitFor(() => screen.getByTestId(`work-comment-reply-${ORIGINAL_ID}`));
    expect(reply.props.accessibilityLabel).toBe("Rispondi a agente");
    expect(screen.getByTestId("work-comment-input").props.accessibilityLabel).toBe("Scrivi un commento…");
    await fireEvent.press(reply);
    expect(screen.getByTestId("work-reply-input").props.accessibilityLabel).toBe("La tua risposta a agente");
  });

  test("la risposta mostra «In risposta a …», premibile se l'originale è nell'elenco", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([
        comment({ id: ORIGINAL_ID, createdAt: "2026-08-12T10:00:00.000Z" }),
        comment({
          id: REPLY_ID,
          body: "Concordo.",
          createdAt: "2026-08-12T11:00:00.000Z",
          replyTo: {
            id: ORIGINAL_ID,
            authorType: "user",
            authorName: "op@example.com",
            excerpt: "Ho controllato io, manca il separatore.",
            deleted: false,
          },
        }),
      ]),
    });
    await renderScreen(client, "member");
    await openTab("activity");
    const line = await waitFor(() => screen.getByTestId(`work-comment-in-reply-${REPLY_ID}`));
    expect(line.props.accessibilityRole).toBe("button");
    expect(
      screen.getByText("In risposta a op@example.com: “Ho controllato io, manca il separatore.”"),
    ).toBeTruthy();
    // Premerla SCORRE all'originale: posizione dell'elenco nella pagina più
    // quella della riga nell'elenco, misurate con `onLayout` (qui a mano).
    // `scrollTo` del mock di ScrollView è un `jest.fn` condiviso sul
    // prototipo: si filtra per CHI scorre (`mock.contexts`).
    // `mockClear` nel `finally` (e mai `mockRestore`, che toglierebbe il
    // mock condiviso del preset): lo storico non passa al test dopo anche
    // se un'asserzione qui fallisce.
    const scrollTo = jest.spyOn(ScrollView.prototype, "scrollTo");
    scrollTo.mockClear();
    try {
      await fireEvent(screen.getByTestId("work-comments-section"), "layout", {
        nativeEvent: { layout: { x: 0, y: 500, width: 335, height: 400 } },
      });
      await fireEvent(screen.getByTestId(`work-comment-${ORIGINAL_ID}`), "layout", {
        nativeEvent: { layout: { x: 0, y: 120, width: 335, height: 60 } },
      });
      await fireEvent.press(line);
      const ofActivity = scrollTo.mock.calls.filter((_call, index) => {
        const context = scrollTo.mock.contexts[index] as { props?: { testID?: string } } | undefined;
        return context?.props?.testID === "work-panel-activity";
      });
      expect(ofActivity).toEqual([[{ y: 620, animated: true }]]);
    } finally {
      scrollTo.mockClear();
    }
  });

  test("sotto l'originale, la card della risposta: «La tua risposta» se è di chi guarda, e premuta porta alla risposta", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([
        comment({ id: ORIGINAL_ID, createdAt: "2026-08-12T10:00:00.000Z" }),
        comment({
          id: REPLY_ID,
          authorId: "viewer-1",
          body: "Concordo, **lo sistemo** io.",
          createdAt: "2026-08-12T11:00:00.000Z",
          replyTo: { id: ORIGINAL_ID, authorType: "user", authorName: "op@example.com", excerpt: "Ho controllato.", deleted: false },
        }),
      ]),
    });
    await renderScreen(client, "member");
    await openTab("activity");
    const original = within(await waitFor(() => screen.getByTestId(`work-comment-${ORIGINAL_ID}`)));
    const card = original.getByTestId(`work-comment-reply-card-${REPLY_ID}`);
    expect(within(card).getByText(/La tua risposta/)).toBeTruthy();
    expect(within(card).getByText("Concordo, lo sistemo io.")).toBeTruthy();

    const scrollTo = jest.spyOn(ScrollView.prototype, "scrollTo");
    scrollTo.mockClear();
    try {
      await fireEvent(screen.getByTestId("work-comments-section"), "layout", {
        nativeEvent: { layout: { x: 0, y: 500, width: 335, height: 400 } },
      });
      await fireEvent(screen.getByTestId(`work-comment-${REPLY_ID}`), "layout", {
        nativeEvent: { layout: { x: 0, y: 40, width: 335, height: 60 } },
      });
      await fireEvent.press(card);
      const ofActivity = scrollTo.mock.calls.filter((_call, index) => {
        const context = scrollTo.mock.contexts[index] as { props?: { testID?: string } } | undefined;
        return context?.props?.testID === "work-panel-activity";
      });
      expect(ofActivity).toEqual([[{ y: 540, animated: true }]]);
    } finally {
      scrollTo.mockClear();
    }
  });

  test("originale non più nell'elenco: la riga c'è, ma non è premibile", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([
        comment({
          id: REPLY_ID,
          replyTo: { id: ORIGINAL_ID, authorType: "system", authorName: null, excerpt: "PR mergiata", deleted: false },
        }),
      ]),
    });
    await renderScreen(client, "member");
    await openTab("activity");
    const line = await waitFor(() => screen.getByTestId(`work-comment-in-reply-${REPLY_ID}`));
    expect(line.props.accessibilityRole).toBeUndefined();
    expect(screen.getByText("In risposta a sistema: “PR mergiata”")).toBeTruthy();
  });

  test("un authorType ignoto nel replyTo: «qualcuno», nessun crash", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([
        comment({
          id: REPLY_ID,
          replyTo: { id: ORIGINAL_ID, authorType: UNKNOWN, authorName: null, excerpt: "boh", deleted: false },
        }),
      ]),
    });
    await renderScreen(client, "member");
    await openTab("activity");
    await waitFor(() => expect(screen.getByText("In risposta a qualcuno: “boh”")).toBeTruthy());
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

    await openTab("details");
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

    await openTab("details");
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

    await openTab("details");
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

    await openTab("details");
    await waitFor(() => expect(screen.getByTestId("work-delete-plan")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-delete-plan"));
    await fireEvent.press(screen.getByTestId("work-delete-cancel"));

    expect(deletePlan).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ La conferma è un FOGLIO NATIVO dal 24 set 2026, e si trascina via:
   * quel gesto deve valere «no», mai «sì». Un gesto distratto annulla, non
   * esegue. Il foglio si chiude e nessuna cancellazione parte — verificato
   * facendo partire la cancellazione su `onClose`: questo test diventa rosso.
   */
  test("trascinare via la conferma è un «no»: niente si cancella", async () => {
    const deleteDesign = jest.fn().mockResolvedValue(ticket());
    const client = makeClient({
      get: jest.fn().mockResolvedValue(ticket({ originContent: "Il design originale" })),
      deleteDesign,
    });

    await renderScreen(client, "member");

    await openTab("details");
    await waitFor(() => expect(screen.getByTestId("work-delete-design")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-delete-design"));
    expect(screen.getByTestId("work-delete-confirm")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("true-sheet-dismiss"));

    expect(screen.queryByTestId("work-delete-confirm")).toBeNull();
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 20);
    });
    expect(deleteDesign).not.toHaveBeenCalled();
  });

  test("niente design e niente piano: nessun bottone da premere per sbaglio", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(ticket({ originContent: null, implementationPlan: null })),
    });

    await renderScreen(client, "member");

    await openTab("details");
    await waitFor(() => expect(screen.getByTestId("ticket-fields")).toBeTruthy());
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

    await loaded();
    expect(screen.getByTestId("work-question-submit")).toBeTruthy(); // rispondere (Stato)
    await openTab("activity");
    expect(screen.getByTestId("work-comment-send")).toBeTruthy(); // commentare (Attività)
    await openTab("details");
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

    await waitFor(() => expect(screen.getByTestId("plan-section-read")).toBeTruthy());
    expect(screen.queryByTestId("plan-section-approve")).toBeNull();
    expect(screen.queryByTestId("plan-section-reject")).toBeNull();
    expect(screen.queryByTestId("plan-section-pre-approve")).toBeNull();
  });
});

/**
 * ⚠️ La pagina scorre fino al campo in uso quando sale la tastiera (25 set
 * 2026, segnalato dal maintainer: «la tastiera va sopra l'input del
 * commento»). Il layout vero non si misura in Jest; questo test tiene il
 * CABLAGGIO — la `ScrollView` della pagina ha la gestione nativa accesa.
 */
describe("WorkScreen — tastiera", () => {
  test("la pagina che scorre ha la gestione nativa della tastiera", async () => {
    await renderScreen(makeClient(), "member");
    // Il campo del commento sta in Attività: è la SUA pagina a scorrere (e
    // quella di Dettagli, che ha le etichette da scrivere).
    await openTab("activity");
    const scroll = await waitFor(() => screen.getByTestId("work-panel-activity"));
    expect(within(scroll).getByTestId("work-comment-input")).toBeTruthy();
    expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(true);
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
    await openTab("details");
    expect(screen.getByTestId("work-panel-details").props.automaticallyAdjustKeyboardInsets).toBe(true);
  });

  /**
   * ⚠️ Anche STATO ha un campo da scrivere: la risposta libera a una domanda
   * dell'agente (`allowFreeText`, `QuestionForm`) col suo «Invia». Senza la
   * gestione della tastiera il campo resta sotto la tastiera e il primo tocco
   * su «Invia» la chiude soltanto — il difetto corretto il 25 set 2026, che le
   * tab avevano riaperto. TUTTI i pannelli la hanno.
   */
  test("Stato con una domanda a risposta libera: la pagina scorre sopra la tastiera e il tocco su «Invia» arriva", async () => {
    await renderScreen(
      makeClient({
        jobs: jest.fn().mockResolvedValue([job({ status: "awaiting_input", requestedByUserId: "viewer-1" })]),
        questions: jest.fn().mockResolvedValue([question({ allowFreeText: true })]),
      }),
      "member",
    );
    await waitFor(() => expect(screen.getByTestId("work-question")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-question-other"));
    const status = screen.getByTestId("work-panel-status");
    // Il campo libero sta DENTRO il pannello di Stato: è quella pagina a dover scorrere.
    expect(within(status).getByTestId("work-question-free-text")).toBeTruthy();
    expect(status.props.automaticallyAdjustKeyboardInsets).toBe(true);
    expect(status.props.keyboardShouldPersistTaps).toBe("handled");
  });

  test("tutti e quattro i pannelli gestiscono la tastiera", async () => {
    await renderScreen(makeClient());
    for (const tab of ["status", "content", "activity", "details"] as const) {
      await openTab(tab);
      expect([tab, screen.getByTestId(`work-panel-${tab}`).props.keyboardShouldPersistTaps]).toEqual([tab, "handled"]);
    }
  });
});

/**
 * Un ciclo COMPLETO (trappola delle fixture dell'app, CLAUDE.md): nei test il
 * client è un doppio e `readerSchema` non gira, quindi ogni campo dello schema
 * c'è, anche quelli che in produzione arriverebbero dai `.default()`.
 */
function prCycle(overrides: Partial<Reader<PrCycle>> = {}): Reader<PrCycle> {
  return {
    state: "reviewing",
    round: 0,
    maxRounds: 3,
    pendingRequest: false,
    lastRequest: null,
    canRequestCorrection: true,
    heldReason: null,
    canResume: false,
    heldJobId: null,
    blockedReason: null,
    ...overrides,
  };
}

function prRepo(cycle: Reader<PrCycle> | null): Reader<TicketDetail>["repositories"][number] {
  return {
    repositoryId: "repo-1",
    repositorySlug: "portale-b2b",
    repositoryName: "Portale B2B",
    branch: "stubwise/ticket-247",
    prUrl: PR_URL,
    prState: "open",
    cycle,
  };
}

/**
 * Correzioni post-PR (30 set 2026): la schermata mostra le PR del ticket con lo
 * stato del ciclo e «Chiedi modifiche». Il ciclo arriva COL ticket
 * (`repositories[].cycle`), nessuna query in più.
 */
describe("WorkScreen — il ciclo di correzione della PR", () => {
  /**
   * TRAPPOLA 2 (CLAUDE.md): SOLO i campi nuovi popolati — ticket spoglio,
   * nessun job, niente `repositoryName`, e il ciclo con i suoi campi nuovi
   * accesi. Una fixture completata a zero non produce mai questo scenario.
   */
  test("SOLO i campi nuovi popolati: ticket spoglio, nessun job, una PR col suo ciclo", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(
        ticket({
          repositories: [
            {
              repositoryId: "repo-1",
              repositorySlug: "portale-b2b",
              branch: "stubwise/ticket-247",
              prUrl: PR_URL,
              prState: "open",
              cycle: {
                state: "correcting",
                round: 2,
                maxRounds: 3,
                pendingRequest: true,
                lastRequest: {
                  via: "provider",
                  platform: "bitbucket",
                  name: "mario.rossi",
                  at: "2026-09-30T10:00:00.000Z",
                },
                canRequestCorrection: false,
                heldReason: "budget",
                canResume: true,
                heldJobId: HELD_JOB_ID,
                blockedReason: null,
              },
            },
          ],
        }),
      ),
    });
    await renderScreen(client, "admin");
    await waitFor(() => expect(screen.getByTestId("pr-cycle-section")).toBeTruthy());
    expect(screen.getByTestId("work-pr-row")).toBeTruthy();
    expect(screen.getByTestId("pr-cycle-title-repo-1")).toHaveTextContent("portale-b2b · PR #10 ↗");
    expect(screen.getByTestId("pr-cycle-chip-repo-1")).toHaveTextContent("Correzione ferma");
    expect(screen.getByTestId("pr-cycle-detail-repo-1")).toHaveTextContent("Giro 2 di 3 · budget esaurito");
    expect(screen.getByTestId("pr-cycle-asked-repo-1")).toHaveTextContent(
      /^Modifiche richieste da mario\.rossi su Bitbucket · .+ · in coda · parte quando finisce il lavoro in corso sul ticket$/,
    );
    expect(screen.getByTestId("pr-cycle-request-repo-1").props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByTestId("pr-cycle-resume-repo-1")).toBeTruthy();
  });

  test("un OPERATORE chiede la correzione dalla schermata: parte, senza gate di ruolo", async () => {
    const requestCorrection = jest.fn().mockResolvedValue({ correctionId: CORRECTION_ID });
    const client = makeClient({
      requestCorrection,
      get: jest.fn().mockResolvedValue(
        ticket({ repositories: [prRepo(prCycle({ state: "changes_requested", maxRounds: 0 }))] }),
      ),
    });
    await renderScreen(client, "member");
    await waitFor(() => expect(screen.getByTestId("pr-cycle-request-repo-1")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("pr-cycle-request-repo-1"));
    await waitFor(() => expect(screen.getByTestId("correction-sheet-confirm")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("correction-sheet-confirm"));

    await waitFor(() => expect(requestCorrection).toHaveBeenCalledWith(TICKET_ID, "repo-1", {}));
  });

  test("dopo la richiesta il ticket si rilegge: la riga dice chi l'ha chiesta e che corregge", async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce(ticket({ repositories: [prRepo(prCycle({ state: "approved" }))] }))
      .mockResolvedValue(
        ticket({
          repositories: [
            prRepo(
              prCycle({
                state: "correcting",
                lastRequest: { via: "stubwise", platform: null, name: "op@example.com", at: "2026-09-30T10:00:00.000Z" },
                canRequestCorrection: false,
              }),
            ),
          ],
        }),
      );
    const client = makeClient({ get });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("pr-cycle-request-repo-1")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("pr-cycle-request-repo-1"));
    await waitFor(() => expect(screen.getByTestId("correction-sheet-confirm")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("correction-sheet-confirm"));

    await waitFor(() => expect(screen.getByTestId("pr-cycle-chip-repo-1")).toHaveTextContent("Correzione in corso"));
    expect(screen.getByTestId("pr-cycle-asked-repo-1")).toHaveTextContent(
      /^Modifiche richieste da op@example\.com su Stubwise · /,
    );
  });

  test("nessuna PR sul ticket: nessuna sezione", async () => {
    // Un repository col branch ma senza PR: la sezione non ha niente da dire.
    const client = makeClient({
      get: jest.fn().mockResolvedValue(
        ticket({ repositories: [{ ...prRepo(null), prUrl: null }] }),
      ),
    });
    await renderScreen(client);
    await loaded();
    expect(screen.queryByTestId("pr-cycle-section")).toBeNull();
    // Nemmeno il contenitore col margine: niente spazio vuoto sotto il ticket.
    expect(screen.queryByTestId("work-pr-row")).toBeNull();
  });
});

/**
 * Il rilancio generico non tocca una correzione ferma (gemella di
 * `latestJobIsHeldCorrection` del web): se l'ultimo job del ticket è il
 * `heldJobId` di un ciclo, «Avvia il lavoro» non si offre e resta solo
 * «Riprendi» della sezione PR. In tutti e tre i casi l'ultimo job è `held`,
 * cioè uno stato da cui il rilancio generico si offrirebbe: la regola è
 * l'unica cosa che lo toglie, e il test arriva davvero al suo ramo.
 */
describe("WorkScreen — una correzione ferma si riprende, non si rilancia", () => {
  const heldJob = () => job({ id: HELD_JOB_ID, status: "held" });

  test("l'ultimo job È la correzione ferma: niente rilancio generico, «Riprendi» sì", async () => {
    const client = makeClient({
      jobs: jest.fn().mockResolvedValue([heldJob()]),
      get: jest.fn().mockResolvedValue(
        ticket({
          repositories: [
            prRepo(
              prCycle({
                state: "correcting",
                canRequestCorrection: false,
                heldReason: "budget",
                canResume: true,
                heldJobId: HELD_JOB_ID,
              }),
            ),
          ],
        }),
      ),
    });
    await renderScreen(client, "admin");
    await waitFor(() => expect(screen.getByTestId("pr-cycle-resume-repo-1")).toBeTruthy());
    expect(screen.queryByTestId("work-run")).toBeNull();
    expect(screen.queryByTestId("work-run-start")).toBeNull();
  });

  test.each([
    ["nessun ciclo sulla PR", () => prRepo(null)],
    [
      "un ciclo fermo su un ALTRO job",
      () =>
        prRepo(
          prCycle({
            state: "correcting",
            canRequestCorrection: false,
            heldReason: "budget",
            canResume: true,
            heldJobId: "88888888-8888-4888-8888-888888888888",
          }),
        ),
    ],
  ])("%s: il rilancio generico c'è", async (_title, makeRepo) => {
    const client = makeClient({
      jobs: jest.fn().mockResolvedValue([heldJob()]),
      get: jest.fn().mockResolvedValue(ticket({ repositories: [makeRepo()] })),
    });
    await renderScreen(client, "admin");
    await waitFor(() => expect(screen.getByTestId("work-run-start")).toBeTruthy());
  });

  test("server vecchio, senza i campi nuovi del ciclo: il rilancio generico c'è", async () => {
    // La voce GREZZA di un server di prima di G5, passata da `readerSchema`
    // come l'app la riceve: `heldJobId` (e `heldReason`/`canResume`) arrivano
    // dai `.default()`. Il ciclo c'è ed è `correcting`, così la regola guarda
    // davvero dentro `cycle` e non si ferma a un `null`.
    const repository = readerSchema(ticketRepositorySchema).parse({
      repositoryId: "33333333-3333-4333-8333-333333333333",
      repositorySlug: "portale-b2b",
      branch: "stubwise/ticket-247",
      prUrl: PR_URL,
      prState: "open",
      cycle: {
        state: "correcting",
        round: 1,
        maxRounds: 3,
        pendingRequest: false,
        lastRequest: null,
        canRequestCorrection: false,
      },
    });
    expect(repository.cycle?.heldJobId).toBeNull();
    const client = makeClient({
      jobs: jest.fn().mockResolvedValue([heldJob()]),
      get: jest.fn().mockResolvedValue(ticket({ repositories: [repository] })),
    });
    await renderScreen(client, "admin");
    await waitFor(() => expect(screen.getByTestId("work-run-start")).toBeTruthy());
    expect(screen.getByTestId("pr-cycle-chip-33333333-3333-4333-8333-333333333333")).toBeTruthy();
    expect(screen.queryByTestId("pr-cycle-resume-33333333-3333-4333-8333-333333333333")).toBeNull();
  });
});

/**
 * LA PAGINA A TAB (2 ott 2026, design `2026-10-02-app-ticket-tabs-design.md`):
 * intestazione fissa, quattro tab, ognuna con il suo scorrimento.
 */
describe("WorkScreen — le quattro tab", () => {
  test("si apre su Stato: la tab selezionata, il suo pannello visibile, gli altri nascosti", async () => {
    await renderScreen(makeClient());
    await loaded();
    expect(screen.getByTestId("work-tab-status").props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId("work-tab-content").props.accessibilityState).toEqual({ selected: false });
    expect(screen.getByTestId("work-panel-status")).toBeTruthy();
    // Montati ma nascosti: le query di default non li trovano.
    expect(screen.queryByTestId("work-panel-content")).toBeNull();
    expect(screen.queryByTestId("work-panel-activity")).toBeNull();
    expect(screen.queryByTestId("work-panel-details")).toBeNull();
  });

  test("un ticket REVIEW si apre su Contenuto, col badge «Review», senza piano né avvio del lavoro", async () => {
    // 6 ott 2026: la review automatica di una PR esterna (es. Changesets) si
    // legge, non si lavora. Prima si apriva su Stato con «In coda» e «Avvia».
    const client = makeClient({ get: jest.fn().mockResolvedValue(ticket({ type: "review" })) });
    await renderScreen(client, "admin", { tab: "status" });
    await waitFor(() => expect(screen.getByTestId("work-tab-content").props.accessibilityState).toEqual({ selected: true }));
    expect(screen.getByTestId("status-badge")).toHaveTextContent("Review");
    await openTab("status");
    expect(screen.getByTestId("work-review-note")).toBeTruthy();
    expect(screen.queryByTestId("work-run-start")).toBeNull();
    expect(screen.queryByText("Il piano, in breve")).toBeNull();
  });

  test("un ticket REVIEW ADOTTATO si apre su Stato, con la nota dell'adozione e la sezione, senza avvio", async () => {
    const adopted = ticket({
      type: "review",
      prAdoption: {
        repositoryId: "22222222-2222-4222-8222-222222222222",
        prNumber: 7,
        prUrl: "https://github.com/acme/repo/pull/7",
        branch: "feature/login",
        state: "adopted",
        unavailableReason: null,
        adoptedAt: "2026-10-06T09:00:00.000Z",
        adoptedBy: "mario@acme.test",
        canManage: true,
      },
    });
    await renderScreen(makeClient({ get: jest.fn().mockResolvedValue(adopted) }), "admin", { tab: "status" });
    await waitFor(() => expect(screen.getByTestId("work-tab-status").props.accessibilityState).toEqual({ selected: true }));
    expect(screen.getByTestId("work-review-note")).toHaveTextContent(/Un maintainer gliel'ha affidata/);
    expect(screen.getByTestId("pr-adoption-adopted")).toHaveTextContent(/affidata da mario@acme.test/);
    expect(screen.getByTestId("pr-adoption-release")).toBeTruthy();
    expect(screen.queryByTestId("work-run-start")).toBeNull();
  });

  test("un ticket REVIEW non adottato, maintainer: il bottone «Fai correggere a Stubwise» in Stato", async () => {
    const reviewTicket = ticket({
      type: "review",
      prAdoption: {
        repositoryId: "22222222-2222-4222-8222-222222222222",
        prNumber: 7,
        prUrl: "https://github.com/acme/repo/pull/7",
        branch: "feature/login",
        state: "available",
        unavailableReason: null,
        adoptedAt: null,
        adoptedBy: null,
        canManage: true,
      },
    });
    await renderScreen(makeClient({ get: jest.fn().mockResolvedValue(reviewTicket) }), "admin");
    await openTab("status");
    expect(screen.getByTestId("pr-adoption-adopt")).toBeTruthy();
  });

  test("un ticket non review resta com'era: Stato, «In coda», avvio presente", async () => {
    await renderScreen(makeClient({ get: jest.fn().mockResolvedValue(ticket({ type: "bug" })) }), "admin");
    await loaded();
    expect(screen.getByTestId("work-tab-status").props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId("status-badge")).toHaveTextContent("In coda");
    expect(screen.getByTestId("work-run-start")).toBeTruthy();
    expect(screen.queryByTestId("work-review-note")).toBeNull();
  });

  test("le quattro etichette, e Stato contiene domanda/piano/run, non i campi", async () => {
    await renderScreen(makeClient());
    await loaded();
    expect(screen.getByText("Stato")).toBeTruthy();
    expect(screen.getByText("Contenuto")).toBeTruthy();
    expect(screen.getByText("Attività")).toBeTruthy();
    expect(screen.getByText("Dettagli")).toBeTruthy();
    const status = within(screen.getByTestId("work-panel-status"));
    expect(status.getByTestId("work-run-start")).toBeTruthy();
    expect(status.getByText("Il piano, in breve")).toBeTruthy();
    expect(status.queryByTestId("ticket-fields")).toBeNull();
    expect(status.queryByTestId("work-history")).toBeNull();
  });

  test("Attività: in cima il campo e la storia, poi i commenti", async () => {
    await renderScreen(makeClient({ comments: jest.fn().mockResolvedValue([comment()]) }));
    await openTab("activity");
    await waitFor(() => expect(screen.getByText("Ho controllato io, manca il separatore.")).toBeTruthy());
    const panel = within(screen.getByTestId("work-panel-activity"));
    const order = panel
      .getAllByTestId(/^(work-comment-composer|work-comments|work-history)$/)
      .map((node) => node.props.testID);
    expect(order).toEqual(["work-comment-composer", "work-history", "work-comments"]);
  });

  test("un commento dalla CACHE di una versione precedente, senza `replyTo`: la schermata regge", async () => {
    // La cache persistita (`app/providers.tsx`) non ripassa dallo schema: il
    // 5 ott 2026 un commento salvato prima di `replyTo` faceva crashare
    // l'app all'apertura del ticket ("Cannot read property 'id' of undefined").
    const legacy: Record<string, unknown> = { ...comment({ body: "Salvato dalla versione vecchia." }) };
    delete legacy.replyTo;
    await renderScreen(
      makeClient({ comments: jest.fn().mockResolvedValue([legacy as unknown as Reader<TicketComment>]) }),
    );
    await openTab("activity");
    await waitFor(() => expect(screen.getByText("Salvato dalla versione vecchia.")).toBeTruthy());
  });

  test("Attività: i commenti dal più recente", async () => {
    const older = comment({ id: "33333333-3333-4333-8333-333333333331", body: "Il primo.", createdAt: "2026-08-12T10:00:00.000Z" });
    const newer = comment({ id: "33333333-3333-4333-8333-333333333332", body: "Il secondo.", createdAt: "2026-08-13T10:00:00.000Z" });
    // Il server li manda dal più vecchio.
    await renderScreen(makeClient({ comments: jest.fn().mockResolvedValue([older, newer]) }));
    await openTab("activity");
    await waitFor(() => expect(screen.getByText("Il primo.")).toBeTruthy());
    const panel = within(screen.getByTestId("work-panel-activity"));
    const ids = panel.getAllByTestId(/^work-comment-3/).map((node) => node.props.testID);
    expect(ids).toEqual([`work-comment-${newer.id}`, `work-comment-${older.id}`]);
  });

  test("Attività: il corpo di un commento è markdown", async () => {
    await renderScreen(
      makeClient({ comments: jest.fn().mockResolvedValue([comment({ body: "Manca **il separatore** nel totale." })]) }),
    );
    await openTab("activity");
    await waitFor(() => expect(screen.getByText("il separatore")).toBeTruthy());
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  test("Contenuto: la descrizione e il piano INTERO in markdown", async () => {
    const client = makeClient({
      get: jest.fn().mockResolvedValue(ticket({ implementationPlan: "## Passi\n\n1. Aggiungere **l'indice**." })),
    });
    await renderScreen(client);
    await openTab("content");
    const plan = within(screen.getByTestId("work-plan-full"));
    expect(plan.getByText("Passi")).toBeTruthy();
    expect(plan.queryByText(/\*\*/)).toBeNull();
  });

  test("Contenuto senza piano: lo dice, invece di un vuoto", async () => {
    await renderScreen(makeClient());
    await openTab("content");
    expect(screen.getByTestId("work-plan-full-empty")).toHaveTextContent("Nessun piano ancora.");
  });

  test("«Leggi il piano completo» porta alla tab Contenuto, sul piano intero", async () => {
    const client = makeClient({ get: jest.fn().mockResolvedValue(ticket({ implementationPlan: "1. Fai una cosa." })) });
    await renderScreen(client);
    await waitFor(() => expect(screen.getByTestId("plan-section-read")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("plan-section-read"));
    expect(screen.getByTestId("work-tab-content").props.accessibilityState).toEqual({ selected: true });
    expect(within(screen.getByTestId("work-plan-full")).getByText(/Fai una cosa/)).toBeTruthy();
    // Non la modale: quella resta per chi usa PlanSection senza tab.
    expect(screen.queryByTestId("plan-section-modal")).toBeNull();
  });

  describe("«Leggi il piano completo» porta SUL piano, non in cima alla descrizione", () => {
    // Sui ticket nati da un design la descrizione è un documento intero: il
    // piano sta sotto, e aprire Contenuto in cima non porterebbe da nessuna
    // parte. Il mock di ScrollView ha `scrollTo` sul prototipo: la spia dice
    // CHI ha scorrolato (`mock.contexts`) e dove.
    const scrollsOfContent = (spy: jest.SpyInstance) =>
      spy.mock.calls.filter((_call, index) => {
        const context = spy.mock.contexts[index] as { props?: { testID?: string } } | undefined;
        return context?.props?.testID === "work-panel-content";
      });

    const longTicket = () =>
      makeClient({
        get: jest.fn().mockResolvedValue(
          ticket({ body: "## Design\n\nUn documento lungo.", implementationPlan: "1. Fai una cosa." }),
        ),
      });

    /**
     * L'ordine fra il layout di Contenuto e il ripiego in `requestAnimationFrame`
     * lo decide il test, non il caso: i frame si raccolgono e si eseguono a
     * mano (`runFrames`).
     */
    let frames: ((time: number) => void)[] = [];
    let scrollTo: jest.SpyInstance;
    let raf: jest.SpyInstance;
    beforeEach(() => {
      frames = [];
      raf = jest.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      // `scrollTo` del mock di ScrollView è GIÀ un `jest.fn` condiviso fra le
      // istanze: `spyOn` restituisce lui, e lo storico delle chiamate passa da
      // un test all'altro se non lo si azzera qui.
      scrollTo = jest.spyOn(ScrollView.prototype, "scrollTo");
      scrollTo.mockClear();
    });
    // Solo le spie di QUESTI test: `jest.restoreAllMocks()` azzererebbe anche
    // i mock di modulo del resto del file (la tab bar, la rete).
    // I frame rimasti in coda si eseguono prima di restituire la funzione
    // vera: nessuna richiesta resta a metà fra un test e l'altro.
    afterEach(async () => {
      await runFrames();
      raf.mockRestore();
      scrollTo.mockClear();
    });
    const runFrames = async () => {
      const pending = frames;
      frames = [];
      await act(async () => {
        for (const frame of pending) frame(0);
      });
    };
    const layoutPlanAt = (y: number) =>
      fireEvent(screen.getByTestId("work-plan-block"), "layout", {
        nativeEvent: { layout: { x: 0, y, width: 335, height: 200 } },
      });

    test("posizione nota ma STANTIA: si aspetta il layout dopo il cambio di tab, e si usa quella nuova", async () => {
      await renderScreen(longTicket());
      await openTab("content");
      await layoutPlanAt(640);
      await openTab("status");
      await fireEvent.press(screen.getByTestId("plan-section-read"));
      // Il layout di Contenuto arriva PRIMA del frame, con una posizione nuova.
      await layoutPlanAt(700);
      await runFrames();
      expect(scrollsOfContent(scrollTo)).toEqual([[{ y: 700, animated: false }]]);
    });

    test("il layout non arriva: il ripiego del frame scorre sulla posizione nota", async () => {
      await renderScreen(longTicket());
      await openTab("content");
      await layoutPlanAt(640);
      await openTab("status");
      await fireEvent.press(screen.getByTestId("plan-section-read"));
      expect(scrollsOfContent(scrollTo)).toEqual([]);
      await runFrames();
      expect(scrollsOfContent(scrollTo)).toEqual([[{ y: 640, animated: false }]]);
    });

    test("con la posizione che arriva DOPO il frame (Contenuto mai aperto): scorre appena la conosce", async () => {
      await renderScreen(longTicket());
      await waitFor(() => expect(screen.getByTestId("plan-section-read")).toBeTruthy());
      await fireEvent.press(screen.getByTestId("plan-section-read"));
      await runFrames();
      expect(scrollsOfContent(scrollTo)).toEqual([]);
      await layoutPlanAt(512);
      expect(scrollsOfContent(scrollTo)).toEqual([[{ y: 512, animated: false }]]);
    });

    test("il contenuto cambia misura (onContentSizeChange) dopo il cambio di tab: scorre sulla posizione nota", async () => {
      await renderScreen(longTicket());
      await openTab("content");
      await layoutPlanAt(640);
      await openTab("status");
      await fireEvent.press(screen.getByTestId("plan-section-read"));
      await fireEvent(screen.getByTestId("work-panel-content"), "contentSizeChange", 335, 2000);
      expect(scrollsOfContent(scrollTo)).toEqual([[{ y: 640, animated: false }]]);
      // Richiesta chiusa: il frame dopo non scorre di nuovo.
      await runFrames();
      expect(scrollsOfContent(scrollTo)).toHaveLength(1);
    });

    test("aprire Contenuto dalla sua tab NON scorre: si parte dalla descrizione", async () => {
      await renderScreen(longTicket());
      await openTab("content");
      await layoutPlanAt(640);
      await runFrames();
      expect(scrollsOfContent(scrollTo)).toEqual([]);
    });
  });

  test("cambiare tab e tornare: il pannello è lo STESSO, non rimontato (lo scorrimento resta)", async () => {
    await renderScreen(makeClient({ comments: jest.fn().mockResolvedValue([comment()]) }));
    await openTab("activity");
    const first = screen.getByTestId("work-panel-activity");
    // Lo scroll qui è DECORATIVO: il mock di ScrollView non tiene un offset da
    // rileggere. Ciò che il test prova è l'IDENTITÀ del nodo — stesso nodo
    // vuol dire non rimontato, e un pannello non rimontato conserva la sua
    // posizione sul telefono.
    await fireEvent.scroll(first, { nativeEvent: { contentOffset: { x: 0, y: 320 } } });
    await openTab("status");
    await openTab("activity");
    // Confronto d'identità come booleano: un `toBe` fra due nodi, se fallisce,
    // prova a stampare l'albero intero e porta via il processo.
    expect(screen.getByTestId("work-panel-activity") === first).toBe(true);
  });

  test("ogni pannello scorre da sé, col pull-to-refresh", async () => {
    await renderScreen(makeClient());
    await loaded();
    for (const tab of ["status", "content", "activity", "details"] as const) {
      await openTab(tab);
      expect(screen.getByTestId(`work-panel-${tab}`).props.refreshControl).toBeTruthy();
    }
  });

  /**
   * UN solo pull-to-refresh montato, sul pannello ATTIVO: con lo stesso
   * `refreshControl` su quattro ScrollView, `refreshing` arrivava anche a
   * quelle nascoste (su iOS `beginRefreshing` ne sposta l'offset) e il testID
   * era quadruplicato. Qui si leggono anche i pannelli nascosti, quindi
   * `includeHiddenElements` serve davvero: non verifica cosa si vede, verifica
   * che negli altri pannelli il pull-to-refresh non ci sia.
   */
  test("il pull-to-refresh sta solo sul pannello attivo", async () => {
    await renderScreen(makeClient());
    await loaded();
    const tabs = ["status", "content", "activity", "details"] as const;
    for (const tab of tabs) {
      await openTab(tab);
      const withRefresh = tabs.filter(
        (other) => screen.getByTestId(`work-panel-${other}`, { includeHiddenElements: true }).props.refreshControl,
      );
      expect([tab, withRefresh]).toEqual([tab, [tab]]);
    }
  });

  test("cambiare tab chiude la tastiera (un campo aperto in un pannello che sparisce non resta a coprire l'altro)", async () => {
    const dismiss = jest.spyOn(Keyboard, "dismiss");
    // `finally`: se l'asserzione fallisce la spia non deve restare sui test dopo.
    try {
      await renderScreen(makeClient());
      await loaded();
      dismiss.mockClear();
      await openTab("activity");
      expect(dismiss).toHaveBeenCalledTimes(1);
    } finally {
      dismiss.mockRestore();
    }
  });

  test("un piano di soli spazi è «nessun piano» sia in Stato sia in Contenuto", async () => {
    await renderScreen(makeClient({ get: jest.fn().mockResolvedValue(ticket({ implementationPlan: "   \n  " })) }));
    await loaded();
    // In Stato: niente «Leggi il piano completo» che porterebbe a un vuoto.
    expect(within(screen.getByTestId("work-panel-status")).getByText("Nessun piano collegato.")).toBeTruthy();
    expect(screen.queryByTestId("plan-section-read")).toBeNull();
    await openTab("content");
    expect(screen.getByTestId("work-plan-full-empty")).toBeTruthy();
  });

  test("un ALTRO ticket sulla stessa schermata riparte da Stato", async () => {
    const OTHER_ID = "99999999-9999-4999-8999-999999999999";
    const { rerenderWith, queryClient } = await renderScreen(makeClient());
    await openTab("activity");
    expect(screen.getByTestId("work-tab-activity").props.accessibilityState).toEqual({ selected: true });
    // L'altro ticket è GIÀ in cache (visto poco fa): senza attesa la schermata
    // non passa dallo skeleton, quindi niente smonta le tab per conto suo — è
    // il caso in cui solo la `key` sull'id le fa ripartire.
    queryClient.setQueryData(workKeys.ticket(OTHER_ID), ticket({ id: OTHER_ID, number: 248, title: "Un altro ticket" }));
    queryClient.setQueryData(workKeys.jobs(OTHER_ID), []);
    queryClient.setQueryData(workKeys.questions(OTHER_ID), []);
    await rerenderWith({ id: OTHER_ID });
    expect(screen.getByText("Un altro ticket")).toBeTruthy();
    await loaded();
    expect(screen.getByTestId("work-tab-status").props.accessibilityState).toEqual({ selected: true });
  });
});

describe("WorkScreen — il pallino di Stato (serve una tua azione)", () => {
  const dot = () => screen.queryByTestId("work-tab-status-dot");

  test("una domanda dell'agente che chi guarda ha chiesto", async () => {
    await renderScreen(
      makeClient({
        jobs: jest.fn().mockResolvedValue([job({ status: "awaiting_input", requestedByUserId: "viewer-1" })]),
        questions: jest.fn().mockResolvedValue([question()]),
      }),
      "member",
    );
    await waitFor(() => expect(dot()).toBeTruthy());
    expect(dot()!.props.accessibilityLabel).toBe("Serve una tua azione");
  });

  test("un piano da approvare, visto da un maintainer", async () => {
    await renderScreen(
      makeClient({
        get: jest.fn().mockResolvedValue(ticket({ implementationPlan: "1. Fai." })),
        jobs: jest.fn().mockResolvedValue([job({ status: "awaiting_plan_approval" })]),
      }),
      "admin",
    );
    await waitFor(() => expect(dot()).toBeTruthy());
  });

  test.each([
    ["fermo al tetto", prCycle({ state: "stopped_at_cap", round: 3 })],
    ["la review chiede modifiche", prCycle({ state: "changes_requested" })],
    [
      "correzione ferma per budget, riprendibile",
      prCycle({ state: "correcting", heldReason: "budget", canResume: true, heldJobId: HELD_JOB_ID, canRequestCorrection: false }),
    ],
  ])("una PR che aspetta una persona: %s", async (_name, cycle) => {
    await renderScreen(makeClient({ get: jest.fn().mockResolvedValue(ticket({ repositories: [prRepo(cycle)] })) }));
    await waitFor(() => expect(dot()).toBeTruthy());
  });

  test("niente da fare: nessun pallino", async () => {
    await renderScreen(
      makeClient({ get: jest.fn().mockResolvedValue(ticket({ repositories: [prRepo(prCycle({ state: "reviewing" }))] })) }),
    );
    await loaded();
    expect(dot()).toBeNull();
  });

  test("una domanda vista da un operatore che NON l'ha chiesta: nessun pallino", async () => {
    await renderScreen(
      makeClient({
        jobs: jest.fn().mockResolvedValue([job({ status: "awaiting_input", requestedByUserId: "un-altro" })]),
        questions: jest.fn().mockResolvedValue([question()]),
      }),
      "member",
    );
    await waitFor(() => expect(screen.getByTestId("work-question")).toBeTruthy());
    expect(dot()).toBeNull();
  });

  test("un piano da approvare visto da un operatore: nessun pallino", async () => {
    await renderScreen(
      makeClient({
        get: jest.fn().mockResolvedValue(ticket({ implementationPlan: "1. Fai." })),
        jobs: jest.fn().mockResolvedValue([job({ status: "awaiting_plan_approval" })]),
      }),
      "member",
    );
    await waitFor(() => expect(screen.getByText("Piano da approvare")).toBeTruthy());
    expect(dot()).toBeNull();
  });
});

describe("WorkScreen — il contatore di Attività", () => {
  test("tre commenti: «3», con l'etichetta per lo screen reader", async () => {
    const comments = jest.fn().mockResolvedValue([
      comment({ id: "c1111111-1111-4111-8111-111111111111" }),
      comment({ id: "c2222222-2222-4222-8222-222222222222" }),
      comment({ id: "c3333333-3333-4333-8333-333333333333" }),
    ]);
    await renderScreen(makeClient({ comments }));
    await waitFor(() => expect(screen.getByTestId("work-tab-activity-count")).toBeTruthy());
    expect(screen.getByTestId("work-tab-activity-count")).toHaveTextContent("3");
    expect(screen.getByTestId("work-tab-activity-count").props.accessibilityLabel).toBe("3 commenti");
  });

  test("commenti che non arrivano: nessun numero inventato, e la schermata resta intera", async () => {
    await renderScreen(makeClient({ comments: jest.fn().mockRejectedValue(new Error("down")) }));
    await openTab("activity");
    await waitFor(() => expect(screen.getByTestId("work-comments-unavailable")).toBeTruthy());
    expect(screen.queryByTestId("work-tab-activity-count")).toBeNull();
    await openTab("status");
    expect(screen.getByTestId("work-run-start")).toBeTruthy();
  });
});

/**
 * Il parametro `tab` della rotta (Task 7): chi apre il ticket può dire su
 * quale tab (una card d'inbox, un deep link). Senza, o sconosciuto, Stato.
 */
describe("WorkScreen — il parametro `tab`", () => {
  const selected = (tab: TicketTab) => screen.getByTestId(`work-tab-${tab}`).props.accessibilityState?.selected;

  test.each(["status", "content", "activity", "details"] as const)("tab=%s: si apre lì", async (tab) => {
    await renderScreen(makeClient(), "member", { tab });
    await waitFor(() => expect(screen.getByTestId(`work-panel-${tab}`)).toBeTruthy());
    expect(selected(tab)).toBe(true);
  });

  test("senza parametro: Stato", async () => {
    await renderScreen(makeClient());
    await loaded();
    expect(selected("status")).toBe(true);
  });

  test("un valore sconosciuto (da un deep link): Stato, mai nessuna tab selezionata", async () => {
    // Arriva così solo da fuori (un link): `JSON.parse` lo porta nel test
    // senza un cast, col tipo largo che ha davvero a runtime.
    const unknownTab: TicketTab = JSON.parse('"foo"');
    await renderScreen(makeClient(), "member", { tab: unknownTab });
    await loaded();
    expect(selected("status")).toBe(true);
  });

  test("il parametro CAMBIA con la schermata montata (stesso ticket): si passa a quella tab", async () => {
    const { rerenderWith } = await renderScreen(makeClient(), "member", { tab: "status" });
    await loaded();
    await rerenderWith({ tab: "activity" });
    await waitFor(() => expect(selected("activity")).toBe(true));
  });

  test("una scelta a mano resta ai render che NON sono una navigazione (stessi params)", async () => {
    const { rerenderSame } = await renderScreen(makeClient(), "member", { tab: "status" });
    await openTab("details");
    await rerenderSame();
    expect(selected("details")).toBe(true);
  });

  test("una scelta a mano resta anche quando i dati si ricaricano (refetch)", async () => {
    const get = jest.fn().mockResolvedValue(ticket());
    const { queryClient } = await renderScreen(makeClient({ get }), "member", { tab: "status" });
    await openTab("details");
    await queryClient.invalidateQueries();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(selected("details")).toBe(true);
  });

  /**
   * ⚠️ «Apri» due volte sullo stesso ticket (I1 della review finale): Inbox →
   * Apri → Stato, a mano su Attività, di nuovo Inbox → Apri su un'altra card
   * dello stesso ticket. react-navigation aggiorna i params della rotta già in
   * primo piano con gli stessi VALORI (`tab: "status"`): un effetto legato al
   * solo valore non ripartiva, e la schermata restava su Attività. È un
   * oggetto params NUOVO, ed è quello che conta.
   */
  test("un navigate NUOVO con gli stessi valori torna sulla tab chiesta", async () => {
    const { rerenderWith } = await renderScreen(makeClient(), "member", { tab: "status" });
    await openTab("activity");
    await rerenderWith({ tab: "status" });
    await waitFor(() => expect(selected("status")).toBe(true));
  });
});

describe("WorkScreen — commenti modificati ed eliminati (0084, B3)", () => {
  const ORIGINAL_ID = "33333333-3333-4333-8333-3333333333b1";
  const REPLY_ID = "33333333-3333-4333-8333-3333333333b2";
  const DELETED_AT = new Date(Date.now() - 5 * 60_000).toISOString();

  test("un eliminato: segnaposto con chi e quando, niente testo, niente Rispondi né ⋯", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([
        comment({
          id: ORIGINAL_ID,
          body: "",
          deletedAt: DELETED_AT,
          deletedBy: { name: "admin@example.com" },
          // Anche se il server dicesse altro, un eliminato non offre azioni.
          canEdit: true,
          canDelete: true,
        }),
      ]),
    });
    await renderScreen(client, "member");
    await openTab("activity");
    const placeholder = await waitFor(() => screen.getByTestId(`work-comment-deleted-${ORIGINAL_ID}`));
    expect(within(placeholder).getByText("Commento eliminato · da admin@example.com · 5 min")).toBeTruthy();
    const row = within(screen.getByTestId(`work-comment-${ORIGINAL_ID}`));
    expect(row.queryByTestId(`work-comment-reply-${ORIGINAL_ID}`)).toBeNull();
    expect(row.queryByTestId(`work-comment-edit-${ORIGINAL_ID}`)).toBeNull();
    expect(row.queryByTestId(`work-comment-delete-${ORIGINAL_ID}`)).toBeNull();
  });

  test("le risposte ricevute da un eliminato restano sotto il segnaposto", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([
        comment({ id: ORIGINAL_ID, body: "", deletedAt: DELETED_AT, deletedBy: { name: null } }),
        comment({
          id: REPLY_ID,
          body: "Ci penso io.",
          createdAt: "2026-08-12T11:00:00.000Z",
          replyTo: { id: ORIGINAL_ID, authorType: "user", authorName: "op@example.com", excerpt: "", deleted: true },
        }),
      ]),
    });
    await renderScreen(client, "member");
    await openTab("activity");
    const original = within(await waitFor(() => screen.getByTestId(`work-comment-${ORIGINAL_ID}`)));
    expect(original.getByText("Commento eliminato · da qualcuno · 5 min")).toBeTruthy();
    expect(original.getByTestId(`work-comment-reply-card-${REPLY_ID}`)).toBeTruthy();
  });

  test("una risposta a un eliminato dice «un commento eliminato», ed è premibile verso il segnaposto", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([
        comment({ id: ORIGINAL_ID, body: "", deletedAt: DELETED_AT, deletedBy: { name: null } }),
        comment({
          id: REPLY_ID,
          body: "Ci penso io.",
          createdAt: "2026-08-12T11:00:00.000Z",
          replyTo: { id: ORIGINAL_ID, authorType: "user", authorName: "op@example.com", excerpt: "", deleted: true },
        }),
      ]),
    });
    await renderScreen(client, "member");
    await openTab("activity");
    const line = await waitFor(() => screen.getByTestId(`work-comment-in-reply-${REPLY_ID}`));
    expect(within(line).getByText("In risposta a un commento eliminato")).toBeTruthy();
    expect(line.props.accessibilityRole).toBe("button");
  });

  test("una RISPOSTA eliminata, sotto l'originale, si legge «Commento eliminato» e non mostra il vecchio testo", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([
        comment({ id: ORIGINAL_ID, body: "Originale." }),
        comment({
          id: REPLY_ID,
          body: "",
          deletedAt: DELETED_AT,
          deletedBy: { name: "op@example.com" },
          createdAt: "2026-08-12T11:00:00.000Z",
          replyTo: { id: ORIGINAL_ID, authorType: "user", authorName: "op@example.com", excerpt: "Originale.", deleted: false },
        }),
      ]),
    });
    await renderScreen(client, "member");
    await openTab("activity");
    const card = within(await waitFor(() => screen.getByTestId(`work-comment-reply-card-${REPLY_ID}`)));
    expect(card.getByText("Commento eliminato")).toBeTruthy();
  });

  test("un modificato mostra «modificato» accanto all'orario, con l'ora della modifica per lo screen reader", async () => {
    const editedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([comment({ id: ORIGINAL_ID, body: "Corretto.", editedAt })]),
    });
    await renderScreen(client, "member");
    await openTab("activity");
    const edited = await waitFor(() => screen.getByTestId(`work-comment-edited-${ORIGINAL_ID}`));
    expect(edited.props.children).toBe("· modificato");
    expect(edited.props.accessibilityLabel).toBe("Modificato 2 h fa");
  });

  test("CACHE PERSISTITA: un commento della forma 0083 (senza i campi nuovi) si disegna come prima", async () => {
    // Così arriva da AsyncStorage: non ripassa dallo schema, i campi nuovi sono
    // `undefined`, non `null`/`false`. Il codice li legge con `??`.
    const legacy = {
      id: ORIGINAL_ID,
      ticketId: TICKET_ID,
      authorType: "user",
      authorId: "viewer-1",
      body: "Scritto prima della versione nuova.",
      createdAt: "2026-08-12T10:00:00.000Z",
      replyTo: { id: REPLY_ID, authorType: "user", authorName: "op@example.com", excerpt: "Vecchio" },
    } as Reader<TicketComment>;
    const client = makeClient({ comments: jest.fn().mockResolvedValue([legacy]) });
    await renderScreen(client, "member");
    await openTab("activity");
    const row = within(await waitFor(() => screen.getByTestId(`work-comment-${ORIGINAL_ID}`)));
    expect(row.getByText("Scritto prima della versione nuova.")).toBeTruthy();
    expect(row.queryByTestId(`work-comment-deleted-${ORIGINAL_ID}`)).toBeNull();
    expect(row.queryByTestId(`work-comment-edited-${ORIGINAL_ID}`)).toBeNull();
    expect(row.queryByTestId(`work-comment-edit-${ORIGINAL_ID}`)).toBeNull();
    expect(row.queryByTestId(`work-comment-delete-${ORIGINAL_ID}`)).toBeNull();
    expect(row.getByText("In risposta a op@example.com: “Vecchio”")).toBeTruthy();
    expect(row.getByTestId(`work-comment-reply-${ORIGINAL_ID}`)).toBeTruthy();
  });

  test("«Rilancia con istruzioni» sparisce se l'unico commento di una persona è eliminato", async () => {
    const client = makeClient({
      jobs: jest.fn().mockResolvedValue([job({ status: "failed" })]),
      comments: jest.fn().mockResolvedValue([
        comment({ id: ORIGINAL_ID, body: "", deletedAt: DELETED_AT, deletedBy: { name: null } }),
      ]),
    });
    await renderScreen(client, "member");
    await waitFor(() => expect(screen.getByTestId("work-run-start")).toBeTruthy());
    expect(screen.queryByTestId("work-run-with-instructions")).toBeNull();
  });
});

describe("WorkScreen — Modifica ed Elimina sulla riga del commento (0084, 6 ott 2026)", () => {
  const MINE = "33333333-3333-4333-8333-3333333333c1";
  const OTHER = "33333333-3333-4333-8333-3333333333c2";

  async function press(action: "edit" | "delete", commentId: string) {
    await openTab("activity");
    const button = await waitFor(() => screen.getByTestId(`work-comment-${action}-${commentId}`));
    await fireEvent.press(button);
  }

  test("né Modifica né Elimina se il server non dà permessi (canEdit e canDelete falsi)", async () => {
    const client = makeClient({ comments: jest.fn().mockResolvedValue([comment({ id: MINE })]) });
    await renderScreen(client, "admin");
    await openTab("activity");
    await waitFor(() => expect(screen.getByTestId(`work-comment-reply-${MINE}`)).toBeTruthy());
    expect(screen.queryByTestId(`work-comment-edit-${MINE}`)).toBeNull();
    expect(screen.queryByTestId(`work-comment-delete-${MINE}`)).toBeNull();
  });

  test("solo canDelete (admin su un commento altrui): sulla riga c'è solo «Elimina»", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([comment({ id: OTHER, authorId: "someone-else", canDelete: true })]),
    });
    await renderScreen(client, "admin");
    await openTab("activity");
    await waitFor(() => expect(screen.getByTestId(`work-comment-delete-${OTHER}`)).toBeTruthy());
    expect(screen.queryByTestId(`work-comment-edit-${OTHER}`)).toBeNull();
  });

  test("«Modifica»: il pannello scende, il campo si apre col testo; Salva chiama editComment(id, commentId, testo)", async () => {
    const editComment = jest.fn().mockResolvedValue(comment({ id: MINE, body: "Nuovo testo" }));
    const client = makeClient({
      editComment,
      comments: jest.fn().mockResolvedValue([
        comment({ id: MINE, body: "Testo vecchio", canEdit: true, canDelete: true }),
      ]),
    });
    await renderScreen(client, "member");
    await press("edit", MINE);

    // Il campo si apre subito, DENTRO la riga: nessun pannello in mezzo.
    const input = await waitFor(() => screen.getByTestId("work-edit-input"));
    expect(within(screen.getByTestId(`work-comment-${MINE}`)).getByTestId("work-edit-input")).toBeTruthy();
    expect(input.props.value).toBe("Testo vecchio");

    await fireEvent.changeText(input, "Nuovo testo");
    await fireEvent.press(screen.getByTestId("work-edit-save"));
    await waitFor(() => expect(editComment).toHaveBeenCalledWith(TICKET_ID, MINE, "Nuovo testo"));
    await waitFor(() => expect(screen.queryByTestId("work-edit-input")).toBeNull());
  });

  test("«Annulla» chiude la modifica senza chiamare il server", async () => {
    const editComment = jest.fn().mockResolvedValue(comment());
    const client = makeClient({
      editComment,
      comments: jest.fn().mockResolvedValue([comment({ id: MINE, canEdit: true })]),
    });
    await renderScreen(client, "member");
    await press("edit", MINE);
    await waitFor(() => expect(screen.getByTestId("work-edit-input")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-edit-cancel"));
    expect(screen.queryByTestId("work-edit-input")).toBeNull();
    expect(editComment).not.toHaveBeenCalled();
  });

  test("risposta e modifica si escludono: aprire «Rispondi» chiude la modifica, e viceversa", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([
        comment({ id: MINE, canEdit: true, createdAt: "2026-08-12T11:00:00.000Z" }),
        comment({ id: OTHER, authorId: "someone-else" }),
      ]),
    });
    await renderScreen(client, "member");
    await press("edit", MINE);
    await waitFor(() => expect(screen.getByTestId("work-edit-input")).toBeTruthy());

    // «Rispondi» su un altro commento: la modifica si chiude.
    await fireEvent.press(screen.getByTestId(`work-comment-reply-${OTHER}`));
    expect(screen.getByTestId("work-reply-input")).toBeTruthy();
    expect(screen.queryByTestId("work-edit-input")).toBeNull();

    // E dalla risposta aperta, «Modifica» chiude la risposta.
    await fireEvent.press(screen.getByTestId(`work-comment-edit-${MINE}`));
    await waitFor(() => expect(screen.getByTestId("work-edit-input")).toBeTruthy());
    expect(screen.queryByTestId("work-reply-input")).toBeNull();
  });

  test("«Elimina» → conferma → «Elimina» chiama deleteComment(id, commentId)", async () => {
    const deleteComment = jest.fn().mockResolvedValue(undefined);
    const client = makeClient({
      deleteComment,
      comments: jest.fn().mockResolvedValue([comment({ id: MINE, canEdit: true, canDelete: true })]),
    });
    await renderScreen(client, "member");
    await press("delete", MINE);

    await waitFor(() => expect(screen.getByTestId("work-comment-delete-confirm")).toBeTruthy());
    expect(screen.getAllByTestId("true-sheet")).toHaveLength(1);
    expect(screen.getByText("Eliminare il commento?")).toBeTruthy();
    expect(screen.queryByText(/registro decisioni/)).toBeNull();

    await fireEvent.press(screen.getByTestId("work-comment-delete-yes"));
    await waitFor(() => expect(deleteComment).toHaveBeenCalledWith(TICKET_ID, MINE));
    await waitFor(() => expect(screen.queryByTestId("work-comment-delete-confirm")).toBeNull());
  });

  test("conferma, «Annulla»: niente chiamata", async () => {
    const deleteComment = jest.fn().mockResolvedValue(undefined);
    const client = makeClient({
      deleteComment,
      comments: jest.fn().mockResolvedValue([comment({ id: MINE, canDelete: true })]),
    });
    await renderScreen(client, "member");
    await press("delete", MINE);
    await waitFor(() => expect(screen.getByTestId("work-comment-delete-cancel")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-comment-delete-cancel"));
    await waitFor(() => expect(screen.queryByTestId("work-comment-delete-confirm")).toBeNull());
    expect(deleteComment).not.toHaveBeenCalled();
  });

  test("L1: le istruzioni di un rifiuto del piano — la conferma dice che il testo resta nel registro decisioni", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([comment({ id: MINE, canDelete: true, inDecisionLog: true })]),
    });
    await renderScreen(client, "member");
    await press("delete", MINE);
    await waitFor(() => expect(screen.getByTestId("work-comment-delete-confirm")).toBeTruthy());
    expect(
      screen.getByText(
        "Questo testo era l'istruzione di un piano rifiutato: resta nel registro decisioni, che non si riscrive.",
      ),
    ).toBeTruthy();
  });

  test("409 comment_deleted alla modifica: il campo si chiude e il motivo resta sotto il commento", async () => {
    const editComment = jest
      .fn()
      .mockRejectedValue(new ApiError(409, "Comment has been deleted", "comment_deleted"));
    const client = makeClient({
      editComment,
      comments: jest.fn().mockResolvedValue([comment({ id: MINE, body: "Testo", canEdit: true })]),
    });
    await renderScreen(client, "member");
    await press("edit", MINE);
    const input = await waitFor(() => screen.getByTestId("work-edit-input"));
    await fireEvent.changeText(input, "Altro");
    await fireEvent.press(screen.getByTestId("work-edit-save"));
    const error = await waitFor(() => screen.getByTestId(`work-comment-action-error-${MINE}`));
    expect(within(error).getByText("Questo commento è stato eliminato nel frattempo.")).toBeTruthy();
    expect(screen.queryByTestId("work-edit-input")).toBeNull();
  });

  test("errore della cancellazione: sotto il commento, fuori dal pannello", async () => {
    const deleteComment = jest.fn().mockRejectedValue(new ApiError(403, "Not allowed", "forbidden"));
    const client = makeClient({
      deleteComment,
      comments: jest.fn().mockResolvedValue([comment({ id: MINE, canDelete: true })]),
    });
    await renderScreen(client, "member");
    await press("delete", MINE);
    await waitFor(() => expect(screen.getByTestId("work-comment-delete-yes")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("work-comment-delete-yes"));
    await waitFor(() => expect(screen.getByTestId(`work-comment-action-error-${MINE}`)).toBeTruthy());
    expect(screen.queryByTestId("work-comment-delete-confirm")).toBeNull();
  });



  test("«Elimina» porta il nome dell'autore nell'etichetta per lo screen reader", async () => {
    const client = makeClient({
      comments: jest.fn().mockResolvedValue([comment({ id: OTHER, authorId: "u-2", canDelete: true })]),
      users: jest.fn().mockResolvedValue([{ id: "u-2", email: "ada@example.com" }]),
    });
    await renderScreen(client, "admin");
    await openTab("activity");
    const del = await waitFor(() => screen.getByTestId(`work-comment-delete-${OTHER}`));
    expect(del.props.accessibilityLabel).toBe("Elimina il commento di ada@example.com");
  });

  test("«Annulla» della modifica è disabilitato mentre il salvataggio è in volo", async () => {
    let resolveEdit: (value: unknown) => void = () => {};
    const editComment = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEdit = resolve;
        }),
    );
    const client = makeClient({
      editComment,
      comments: jest.fn().mockResolvedValue([comment({ id: MINE, body: "Testo", canEdit: true })]),
    });
    await renderScreen(client, "member");
    await press("edit", MINE);
    const input = await waitFor(() => screen.getByTestId("work-edit-input"));
    await fireEvent.changeText(input, "Altro");
    await fireEvent.press(screen.getByTestId("work-edit-save"));
    await waitFor(() => expect(editComment).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId("work-edit-cancel").props.accessibilityState).toMatchObject({ disabled: true }),
    );
    await act(async () => {
      resolveEdit(comment({ id: MINE, body: "Altro" }));
    });
  });

  test("CACHE PERSISTITA: un commento SENZA canEdit/canDelete non mostra Modifica né Elimina", async () => {
    const legacy = {
      id: MINE,
      ticketId: TICKET_ID,
      authorType: "user",
      authorId: "viewer-1",
      body: "Vecchio",
      createdAt: "2026-08-12T10:00:00.000Z",
      replyTo: null,
    } as Reader<TicketComment>;
    const client = makeClient({ comments: jest.fn().mockResolvedValue([legacy]) });
    await renderScreen(client, "member");
    await openTab("activity");
    await waitFor(() => expect(screen.getByTestId(`work-comment-reply-${MINE}`)).toBeTruthy());
    expect(screen.queryByTestId(`work-comment-edit-${MINE}`)).toBeNull();
    expect(screen.queryByTestId(`work-comment-delete-${MINE}`)).toBeNull();
  });
});

/**
 * «Guarda la sessione» / «Rivedi la sessione» (piano C, Task 8; gemello del
 * link sulla pagina del ticket del web). Lettura ACCESSORIA: un errore o un
 * server senza le rotte costano la sola riga. Lo stato dell'ultimo job sta
 * nella chiave, e la ricerca si ripete ogni 10 s SOLO finché il job è in
 * cammino, la sessione non c'è ancora e la schermata è a fuoco (preflight M5).
 */
describe("WorkScreen — la sessione dell'agente", () => {
  const LIVE_SESSION = { id: "s-live", state: "working" };
  const ENDED_SESSION = { id: "s-ended", state: "ended" };

  test("sessione viva: «Guarda la sessione» apre la sessione nello stesso stack", async () => {
    const agentSessions = jest.fn().mockResolvedValue({ live: [LIVE_SESSION], recent: [] });
    const client = makeClient({ jobs: jest.fn().mockResolvedValue([job()]), agentSessions });
    const { navigate } = await renderScreen(client);
    await loaded();
    await waitFor(() => expect(screen.getByTestId("work-session-link")).toBeTruthy());
    expect(screen.getByText("Guarda la sessione")).toBeTruthy();
    expect(agentSessions).toHaveBeenCalledWith({ aiJobId: JOB_ID });
    await fireEvent.press(screen.getByTestId("work-session-link"));
    expect(navigate).toHaveBeenCalledWith("AgentSession", { id: "s-live" });
  });

  test("sessione conclusa: «Rivedi la sessione»", async () => {
    const agentSessions = jest.fn().mockResolvedValue({ live: [], recent: [ENDED_SESSION] });
    const client = makeClient({ jobs: jest.fn().mockResolvedValue([job({ status: "pr_opened" })]), agentSessions });
    await renderScreen(client);
    await loaded();
    await waitFor(() => expect(screen.getByText("Rivedi la sessione")).toBeTruthy());
  });

  test("server senza le rotte (404 senza code): nessuna riga, il resto della pagina c'è", async () => {
    const agentSessions = jest.fn().mockRejectedValue(new ApiError(404, "not found"));
    const client = makeClient({ jobs: jest.fn().mockResolvedValue([job({ status: "pr_opened" })]), agentSessions });
    await renderScreen(client);
    await loaded();
    await waitFor(() => expect(agentSessions).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByTestId("work-session-link")).toBeNull();
    expect(screen.queryByTestId("work-error")).toBeNull();
    expect(screen.getByTestId("work-panel-status")).toBeTruthy();
  });

  test("nessun job: nessuna ricerca", async () => {
    const agentSessions = jest.fn().mockResolvedValue({ live: [LIVE_SESSION], recent: [] });
    await renderScreen(makeClient({ agentSessions }));
    await loaded();
    await act(async () => {});
    expect(agentSessions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("work-session-link")).toBeNull();
  });

  test("job da `queued` a `triaging`: lo stato nella chiave rifà la ricerca, e la riga compare", async () => {
    const jobs = jest.fn().mockResolvedValue([job({ status: "queued" })]);
    const agentSessions = jest.fn().mockResolvedValue({ live: [], recent: [] });
    const client = makeClient({ jobs, agentSessions });
    const { queryClient } = await renderScreen(client);
    await loaded();
    await waitFor(() => expect(agentSessions).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("work-session-link")).toBeNull();

    jobs.mockResolvedValue([job({ status: "triaging" })]);
    agentSessions.mockResolvedValue({ live: [LIVE_SESSION], recent: [] });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: workKeys.jobs(TICKET_ID) });
    });
    await waitFor(() => expect(screen.getByTestId("work-session-link")).toBeTruthy());
    expect(agentSessions).toHaveBeenCalledTimes(2);
  });

  describe("il polling ogni 10 s, e le tre condizioni che lo fermano", () => {
    function focusNav() {
      const handlers: Record<string, () => void> = {};
      const nav = {
        isFocused: () => true,
        addListener: (event: string, callback: () => void) => {
          handlers[event] = callback;
          return () => {};
        },
      };
      return { nav, handlers };
    }

    async function advance(ms: number) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
      });
    }

    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    test("a fuoco, job in cammino e nessuna sessione: ripete la ricerca", async () => {
      const agentSessions = jest.fn().mockResolvedValue({ live: [], recent: [] });
      const client = makeClient({ jobs: jest.fn().mockResolvedValue([job({ status: "fixing" })]), agentSessions });
      await renderScreen(client, "member", {}, focusNav().nav);
      await waitFor(() => expect(agentSessions).toHaveBeenCalledTimes(1));
      await advance(10_100);
      expect(agentSessions).toHaveBeenCalledTimes(2);
    });

    test("si ferma quando il job diventa terminale", async () => {
      const jobs = jest.fn().mockResolvedValue([job({ status: "fixing" })]);
      const agentSessions = jest.fn().mockResolvedValue({ live: [], recent: [] });
      const { queryClient } = await renderScreen(makeClient({ jobs, agentSessions }), "member", {}, focusNav().nav);
      await waitFor(() => expect(agentSessions).toHaveBeenCalledTimes(1));

      jobs.mockResolvedValue([job({ status: "failed" })]);
      await act(async () => {
        await queryClient.refetchQueries({ queryKey: workKeys.jobs(TICKET_ID) });
      });
      // Lo stato nuovo nella chiave: UNA ricerca, poi più niente.
      await waitFor(() => expect(agentSessions).toHaveBeenCalledTimes(2));
      await advance(30_000);
      expect(agentSessions).toHaveBeenCalledTimes(2);
    });

    test("si ferma quando la sessione è trovata", async () => {
      const agentSessions = jest
        .fn()
        .mockResolvedValueOnce({ live: [], recent: [] })
        .mockResolvedValue({ live: [LIVE_SESSION], recent: [] });
      const client = makeClient({ jobs: jest.fn().mockResolvedValue([job({ status: "fixing" })]), agentSessions });
      await renderScreen(client, "member", {}, focusNav().nav);
      await waitFor(() => expect(agentSessions).toHaveBeenCalledTimes(1));
      await advance(10_100);
      expect(agentSessions).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(screen.getByTestId("work-session-link")).toBeTruthy());
      await advance(30_000);
      expect(agentSessions).toHaveBeenCalledTimes(2);
    });

    test("si ferma quando la schermata perde il fuoco", async () => {
      const agentSessions = jest.fn().mockResolvedValue({ live: [], recent: [] });
      const { nav, handlers } = focusNav();
      const client = makeClient({ jobs: jest.fn().mockResolvedValue([job({ status: "fixing" })]), agentSessions });
      await renderScreen(client, "member", {}, nav);
      await waitFor(() => expect(agentSessions).toHaveBeenCalledTimes(1));
      await act(async () => {
        handlers["blur"]?.();
      });
      await advance(30_000);
      expect(agentSessions).toHaveBeenCalledTimes(1);
    });
  });
});
