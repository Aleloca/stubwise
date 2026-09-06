import { ApiError } from "@stubwise/api-client";
import type { StubwiseClient } from "@stubwise/api-client";
import type { InboxItem, Reader } from "@stubwise/shared";
import NetInfo from "@react-native-community/netinfo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { InboxCard } from "./InboxCard";

function item(overrides: Partial<Reader<InboxItem>> & Pick<InboxItem, "id" | "kind">): Reader<InboxItem> {
  return {
    status: "open",
    text: "Testo dell'evento",
    actions: [],
    projectId: null,
    ticketId: null,
    jobId: null,
    createdAt: "2026-09-02T09:48:00.000Z",
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
    ...overrides,
  } as Reader<InboxItem>;
}

function makeClient(overrides: Partial<StubwiseClient["inbox"]> = {}): StubwiseClient {
  return {
    inbox: {
      act: jest.fn(),
      snooze: jest.fn(),
      handled: jest.fn(),
      answer: jest.fn(),
      list: jest.fn(),
      unreadCount: jest.fn(),
      read: jest.fn(),
      ...overrides,
    },
  } as unknown as StubwiseClient;
}

async function renderCard(cardItem: Reader<InboxItem>, client: StubwiseClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: null,
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
  };
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <InboxCard item={cardItem} projectName="Portale B2B" />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const successResult = (kind: string, ids: string[]) => ({ kind, changedNotificationIds: ids });

beforeEach(() => {
  (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
});

describe("InboxCard", () => {
  describe("QuestionCard (job.awaiting_input)", () => {
    const QUESTION_ITEM = item({
      id: "q1",
      kind: "job.awaiting_input",
      text: "Sto lavorando ai resi parziali. Il reso può superare il pagato?",
      actions: ["answer", "open", "snooze"],
      url: "https://stubwise.example/tickets/tck-3",
      question: {
        questionId: "question-1",
        round: 1,
        question: "Il reso parziale può superare l'importo pagato?",
        options: [
          { label: "Blocca al totale pagato", consequence: "Nessun rischio contabile." },
          { label: "Consenti oltre, con avviso" },
        ],
        recommendedIndex: 0,
        allowFreeText: true,
      },
    });

    test("bottoni presenti solo se l'azione è in actions: niente 'Gestita' (non in actions)", async () => {
      const client = makeClient();
      await renderCard(QUESTION_ITEM, client);
      expect(screen.getByTestId("question-card-respond")).toBeTruthy();
      expect(screen.getByTestId("question-card-snooze")).toBeTruthy();
      expect(screen.queryByText("Gestita")).toBeNull();
    });

    test("'Rispondi' apre la QuestionSheet con opzioni, conseguenza e 'Altro (testo libero)'; 'Invia la risposta' chiama answer", async () => {
      const client = makeClient({
        act: jest.fn().mockResolvedValue(successResult("job.awaiting_input", ["q1"])),
      });
      await renderCard(QUESTION_ITEM, client);

      await fireEvent.press(screen.getByTestId("question-card-respond"));
      expect(screen.getByText("Il reso parziale può superare l'importo pagato?")).toBeTruthy();
      expect(screen.getByText("Nessun rischio contabile.")).toBeTruthy();
      expect(screen.getByText("Altro (testo libero)")).toBeTruthy();
      expect(screen.getByText("Invia la risposta")).toBeTruthy();

      await fireEvent.press(screen.getByTestId("question-sheet-option-1"));
      await fireEvent.press(screen.getByTestId("question-sheet-submit"));

      await waitFor(() => expect(client.inbox.act).toHaveBeenCalledWith("q1", "answer", { optionIndex: 1 }));
    });
  });

  describe("PulseProposalCard (project.pulse)", () => {
    const PULSE_ITEM = item({
      id: "p1",
      kind: "project.pulse",
      text: "Fermo da 6 giorni: da dove ripartire?",
      actions: ["answer", "open", "snooze", "handled"],
      url: "https://stubwise.example/backlog?projectId=1",
      question: {
        questionId: "pulse-1",
        question: "Da dove ripartire?",
        options: [
          { label: "Testi della pagina resi" },
          { label: "Banner cookie bloccato su mobile" },
          { label: "Refresh automatico del catalogo" },
        ],
        recommendedIndex: 0,
        allowFreeText: false,
      },
      pulse: {
        projectName: "Sito vetrina",
        idleDays: 6,
        proposals: [
          { backlogItemId: "b1", title: "Testi della pagina resi", urgency: "high", effort: 2, hasAnalysis: true },
          { backlogItemId: "b2", title: "Banner cookie bloccato su mobile", urgency: "medium", effort: 1, hasAnalysis: false },
          { backlogItemId: "b3", title: "Refresh automatico del catalogo", urgency: "low", effort: 3, hasAnalysis: false },
        ],
      },
    });

    test("bottoni presenti solo se l'azione è in actions", async () => {
      const client = makeClient();
      await renderCard(PULSE_ITEM, client);
      expect(screen.getByTestId("pulse-card-refine")).toBeTruthy();
      expect(screen.getByTestId("pulse-card-snooze")).toBeTruthy();
      expect(screen.getByTestId("pulse-card-handled")).toBeTruthy();
    });

    test("'Procedi con A' chiama answer con l'optionIndex della consigliata", async () => {
      const client = makeClient({
        act: jest.fn().mockResolvedValue(successResult("project.pulse", ["p1"])),
      });
      await renderCard(PULSE_ITEM, client);

      expect(screen.getByText("Procedi con A")).toBeTruthy();
      await fireEvent.press(screen.getByTestId("pulse-card-proceed"));

      await waitFor(() => expect(client.inbox.act).toHaveBeenCalledWith("p1", "answer", { optionIndex: 0 }));
    });

    test("senza l'azione 'answer' (già gestita da un collega, riga stantia) niente bottone 'Procedi'", async () => {
      const client = makeClient();
      await renderCard({ ...PULSE_ITEM, actions: ["open", "snooze", "handled"] }, client);
      expect(screen.queryByTestId("pulse-card-proceed")).toBeNull();
    });
  });

  describe("PlanReviewCard (job.plan_review, con decisione)", () => {
    const PLAN_ITEM = item({
      id: "pr1",
      kind: "job.plan_review",
      text: "Piano: cache delle immagini prodotto — Portale B2B",
      actions: ["approve_plan", "reject_plan", "open", "snooze", "handled"],
    });

    test("bottoni presenti solo se l'azione è in actions: niente 'Approva' senza approve_plan", async () => {
      const client = makeClient();
      await renderCard({ ...PLAN_ITEM, actions: ["reject_plan", "snooze", "handled"] }, client);
      expect(screen.queryByTestId("plan-review-card-approve")).toBeNull();
      expect(screen.getByTestId("plan-review-card-reject")).toBeTruthy();
    });

    test("'Approva' → conferma → chiama approve_plan (non subito al primo tap)", async () => {
      const client = makeClient({
        act: jest.fn().mockResolvedValue(successResult("job.plan_review", ["pr1"])),
      });
      await renderCard(PLAN_ITEM, client);

      await fireEvent.press(screen.getByTestId("plan-review-card-approve"));
      // Il primo tap chiede conferma: NESSUNA chiamata ancora.
      expect(client.inbox.act).not.toHaveBeenCalled();
      expect(screen.getByText("Confermi?")).toBeTruthy();

      await fireEvent.press(screen.getByTestId("plan-review-card-approve-confirm"));
      await waitFor(() => expect(client.inbox.act).toHaveBeenCalledWith("pr1", "approve_plan", undefined));
    });

    test("'Rifiuta con istruzioni' apre la RejectSheet: chip + testo → reject con le istruzioni concatenate", async () => {
      const client = makeClient({
        act: jest.fn().mockResolvedValue(successResult("job.plan_review", ["pr1"])),
      });
      await renderCard(PLAN_ITEM, client);

      await fireEvent.press(screen.getByTestId("plan-review-card-reject"));
      expect(screen.getByText("Cosa deve cambiare?")).toBeTruthy();

      await fireEvent.press(screen.getByTestId("reject-sheet-chip-scope"));
      await fireEvent.changeText(screen.getByTestId("reject-sheet-input"), "Riduci lo scope; usa la CDN che abbiamo già");
      await fireEvent.press(screen.getByTestId("reject-sheet-submit"));

      await waitFor(() =>
        expect(client.inbox.act).toHaveBeenCalledWith("pr1", "reject_plan", {
          instructions: "Riduci lo scope; usa la CDN che abbiamo già",
        }),
      );
    });

    test("offline: le azioni decisionali (non ottimistiche) restano disabilitate, mai eseguite", async () => {
      (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
      const client = makeClient({ act: jest.fn().mockResolvedValue(successResult("job.plan_review", ["pr1"])) });
      await renderCard(PLAN_ITEM, client);

      const approveButton = screen.getByTestId("plan-review-card-approve");
      expect(approveButton.props.accessibilityState?.disabled).toBe(true);

      await fireEvent.press(approveButton);
      // Il bottone disabilitato non fa scattare né la conferma né la mutazione.
      expect(screen.queryByText("Confermi?")).toBeNull();
      expect(client.inbox.act).not.toHaveBeenCalled();
    });
  });

  describe("PrReadyCard (job.pr_opened / review.completed)", () => {
    const PR_ITEM = item({
      id: "pro1",
      kind: "job.pr_opened",
      text: "Crash al checkout: pronto al rilascio",
      actions: ["open", "snooze", "handled"],
      url: "https://github.com/acme/negozio-web/pull/342",
    });

    test("bottoni presenti solo se l'azione è in actions, e MAI un bottone di rilascio (nessuna azione merge nel contratto)", async () => {
      const client = makeClient();
      await renderCard(PR_ITEM, client);
      expect(screen.getByTestId("pr-ready-card-open")).toBeTruthy();
      expect(screen.getByTestId("pr-ready-card-snooze")).toBeTruthy();
      expect(screen.getByTestId("pr-ready-card-handled")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /rilascia/i })).toBeNull();
    });

    test("'Apri il lavoro' apre l'URL della PR", async () => {
      const client = makeClient();
      const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
      await renderCard(PR_ITEM, client);
      await fireEvent.press(screen.getByTestId("pr-ready-card-open"));
      expect(openURL).toHaveBeenCalledWith("https://github.com/acme/negozio-web/pull/342");
      openURL.mockRestore();
    });

    test("review.completed usa lo stesso layout", async () => {
      const client = makeClient();
      await renderCard({ ...PR_ITEM, kind: "review.completed" }, client);
      expect(screen.getByText("Review completata")).toBeTruthy();
    });
  });

  describe("FailedCard (job.failed)", () => {
    const FAILED_ITEM = item({
      id: "f1",
      kind: "job.failed",
      text: "Non riesco a chiudere «Banner cookie»: test falliti dopo 2 tentativi.",
      actions: ["relaunch", "open", "snooze", "handled"],
      url: "https://stubwise.example/tickets/tck-9",
    });

    test("Riprova / Apri il lavoro / Rimanda presenti", async () => {
      const client = makeClient();
      await renderCard(FAILED_ITEM, client);
      expect(screen.getByTestId("failed-card-retry")).toBeTruthy();
      expect(screen.getByTestId("failed-card-open")).toBeTruthy();
      expect(screen.getByTestId("failed-card-snooze")).toBeTruthy();
    });

    test("bottoni presenti solo se l'azione è in actions: senza relaunch niente 'Riprova'", async () => {
      const client = makeClient();
      await renderCard({ ...FAILED_ITEM, actions: ["open", "snooze", "handled"] }, client);
      expect(screen.queryByTestId("failed-card-retry")).toBeNull();
    });

    test("'Riprova' chiama relaunch", async () => {
      const client = makeClient({
        act: jest.fn().mockResolvedValue(successResult("job.failed", ["f1"])),
      });
      await renderCard(FAILED_ITEM, client);
      await fireEvent.press(screen.getByTestId("failed-card-retry"));
      await waitFor(() => expect(client.inbox.act).toHaveBeenCalledWith("f1", "relaunch", undefined));
    });

    test("'Rimanda' apre lo sheet: scegliere un'opzione chiama snooze con il valore mappato", async () => {
      const client = makeClient({
        snooze: jest.fn().mockResolvedValue({ snoozedUntil: "2026-09-02T10:48:00.000Z" }),
      });
      await renderCard(FAILED_ITEM, client);
      await fireEvent.press(screen.getByTestId("failed-card-snooze"));
      // «Stasera» nel canvas invia il valore API "tomorrow" — mappatura label→value del Task 14.
      await fireEvent.press(screen.getByTestId("snooze-sheet-tomorrow"));
      await waitFor(() => expect(client.inbox.snooze).toHaveBeenCalledWith("f1", "tomorrow"));
    });

    // Revisione di qualità del Task 14: `useSnooze`/`useHandled` non
    // mostravano MAI un errore — il rollback della cache avveniva ma la card
    // tornava senza spiegazione, indistinguibile da un misclick. Verifica che
    // ora la card lo dica.
    test("'Rimanda' fallito mostra un messaggio d'errore sulla card (non sparisce in silenzio)", async () => {
      const client = makeClient({
        snooze: jest.fn().mockRejectedValue(new Error("network down")),
      });
      await renderCard(FAILED_ITEM, client);
      await fireEvent.press(screen.getByTestId("failed-card-snooze"));
      await fireEvent.press(screen.getByTestId("snooze-sheet-1h"));

      await waitFor(() => expect(screen.getByText("Qualcosa è andato storto. Riprova.")).toBeTruthy());
    });
  });

  describe("InfoCard (catch-all informativo)", () => {
    test("un aggiornamento generico (ticket.created) mostra i bottoni di igiene dichiarati", async () => {
      const client = makeClient();
      const TICKET_ITEM = item({
        id: "t1",
        kind: "ticket.created",
        text: "Nuovo ticket #128 aperto da un feedback via widget",
        actions: ["open", "snooze", "handled"],
        url: "https://stubwise.example/tickets/128",
      });
      await renderCard(TICKET_ITEM, client);
      expect(screen.getByTestId("info-card-open")).toBeTruthy();
      expect(screen.getByTestId("info-card-snooze")).toBeTruthy();
      expect(screen.getByTestId("info-card-handled")).toBeTruthy();
    });

    // Comportamento chiave del Task 14: un piano da approvare visto da chi
    // NON può approvarlo (nessun approve_plan/reject_plan in actions) degrada
    // a card puramente informativa — NESSUN bottone, nemmeno rinvia/archivia
    // (canvas `1b`, sezione "In attesa di altri").
    test("job.plan_review SENZA decisione per il viewer: informativa, senza bottoni, con «Aspetta un maintainer»", async () => {
      const client = makeClient();
      const WAITING_ITEM = item({
        id: "pr2",
        kind: "job.plan_review",
        text: "«Timeout immagini prodotto» — Portale B2B",
        actions: ["open", "snooze", "handled"],
        url: "https://stubwise.example/tickets/tck-7",
      });
      await renderCard(WAITING_ITEM, client);

      expect(screen.getByText("Aspetta un maintainer.")).toBeTruthy();
      expect(screen.queryByTestId("info-card-open")).toBeNull();
      expect(screen.queryByTestId("info-card-snooze")).toBeNull();
      expect(screen.queryByTestId("info-card-handled")).toBeNull();
      expect(screen.queryByText("Rimanda")).toBeNull();
      expect(screen.queryByText("Gestita")).toBeNull();
    });

    test("un kind sconosciuto (payload di un server più nuovo) non pianta: degrada a InfoCard generica", async () => {
      const client = makeClient();
      const UNKNOWN_ITEM = item({
        id: "u1",
        kind: "__unknown__" as InboxItem["kind"],
        text: "Un evento che questa build non conosce ancora",
        actions: ["open", "snooze", "handled"],
      });
      await renderCard(UNKNOWN_ITEM, client);
      expect(screen.getByText("Un evento che questa build non conosce ancora")).toBeTruthy();
      expect(screen.getByText("Aggiornamento")).toBeTruthy();
    });

    /**
     * IL CASO CONCRETO della fase 5: `project.brief` è un kind NUOVO del server,
     * e l'app gia' installata lo legge come `__unknown__` (readerSchema). La
     * card non deve sparire ne' restare muta: il testo della notifica lo porta
     * gia' il server (`notify.brief`, con progetto, periodo e headline), e
     * "Apri" porta alla roadmap. È l'ondata 1 della fase: il brief arriva sui
     * telefoni PRIMA del rilascio in store che ne conosce il kind.
     */
    test("un `project.brief` da un server piu' nuovo (kind UNKNOWN) resta leggibile e apribile", async () => {
      const client = makeClient();
      const BRIEF_ITEM = item({
        id: "b1",
        kind: "__unknown__" as InboxItem["kind"],
        text: "🗞️ Brief settimanale di Portale B2B (2026-08-31 → 2026-09-06): settimana di consolidamento.",
        actions: ["open", "snooze", "handled"],
        projectId: "11111111-1111-4111-8111-111111111111",
        // `openUrl` del server: il brief porta alla roadmap del progetto.
        url: "https://stubwise.example.com/projects/11111111-1111-4111-8111-111111111111/roadmap",
      });
      await renderCard(BRIEF_ITEM, client);

      expect(
        screen.getByText(
          "🗞️ Brief settimanale di Portale B2B (2026-08-31 → 2026-09-06): settimana di consolidamento.",
        ),
      ).toBeTruthy();
      // Informativa, non nascosta: le azioni d'igiene ci sono tutte.
      expect(screen.getByTestId("info-card-open")).toBeTruthy();
      expect(screen.getByTestId("info-card-snooze")).toBeTruthy();
      expect(screen.getByTestId("info-card-handled")).toBeTruthy();
    });
  });

  describe("conflitto (409 already_handled)", () => {
    test("un'azione decisionale che perde la corsa mostra 'ci ha pensato {{email}}'", async () => {
      const conflictError = new ApiError(409, "conflict", "already_handled", {
        details: {
          code: "already_handled",
          message: "conflict",
          handledBy: { id: "22222222-2222-4222-8222-222222222222", email: "marco@example.com" },
        },
      });
      const client = makeClient({ act: jest.fn().mockRejectedValue(conflictError) });
      const PLAN_ITEM = item({
        id: "pr3",
        kind: "job.plan_review",
        text: "Piano in approvazione",
        actions: ["approve_plan", "reject_plan", "snooze", "handled"],
      });
      await renderCard(PLAN_ITEM, client);

      await fireEvent.press(screen.getByTestId("plan-review-card-approve"));
      await fireEvent.press(screen.getByTestId("plan-review-card-approve-confirm"));

      await waitFor(() => expect(screen.getByText("Ci ha pensato marco@example.com.")).toBeTruthy());
    });
  });
});

/**
 * Fase 5: il server allega alle righe che ne hanno uno il riassunto "in breve"
 * (`inboxItemSchema.summary`, opzionale). Sta SOTTO il testo della notifica —
 * che resta il titolo di cosa è successo — e non lo sostituisce.
 */
describe("InboxCard — riassunto in breve", () => {
  test("PR pronta: il riassunto compare sotto il testo della notifica", async () => {
    await renderCard(
      item({
        id: "s1",
        kind: "job.pr_opened",
        text: "PR #12 aperta su shop",
        summary: "Aggiunge l'export CSV degli ordini. La review non ha chiesto modifiche.",
        actions: ["open", "snooze", "handled"],
        url: "https://example.com/pr/12",
      }),
      makeClient(),
    );
    expect(screen.getByText("PR #12 aperta su shop")).toBeTruthy();
    expect(screen.getByTestId("pr-ready-card-summary")).toBeTruthy();
    expect(screen.getByText(/Aggiunge l'export CSV degli ordini/)).toBeTruthy();
  });

  test("PR pronta senza riassunto: nessuna riga vuota in più", async () => {
    await renderCard(
      item({ id: "s2", kind: "job.pr_opened", text: "PR #12 aperta su shop", actions: ["open", "snooze", "handled"] }),
      makeClient(),
    );
    expect(screen.queryByTestId("pr-ready-card-summary")).toBeNull();
  });

  test("piano da approvare: il riassunto compare sopra i bottoni di decisione", async () => {
    await renderCard(
      item({
        id: "s3",
        kind: "job.plan_review",
        text: "Piano pronto per Export CSV degli ordini",
        summary: "Gli ordini si potranno scaricare in CSV. Tocca solo l'area ordini, non i pagamenti.",
        actions: ["approve_plan", "reject_plan", "open", "snooze", "handled"],
      }),
      makeClient(),
    );
    expect(screen.getByTestId("plan-review-card-summary")).toBeTruthy();
    expect(screen.getByText(/Gli ordini si potranno scaricare in CSV/)).toBeTruthy();
    expect(screen.getByTestId("plan-review-card-approve")).toBeTruthy();
  });

  test("piano da approvare senza riassunto: nessuna riga vuota in più", async () => {
    await renderCard(
      item({
        id: "s4",
        kind: "job.plan_review",
        text: "Piano pronto",
        actions: ["approve_plan", "reject_plan", "open", "snooze", "handled"],
      }),
      makeClient(),
    );
    expect(screen.queryByTestId("plan-review-card-summary")).toBeNull();
  });
});

/**
 * Fase 5, ondata 2: `project.brief` è ora un kind CONOSCIUTO da questa build —
 * non più `UNKNOWN` come nel test qui sopra, che continua a coprire l'app già
 * installata. Resta informativo (nessuna decisione da prendere): `InfoCard`,
 * etichetta propria invece di "Aggiornamento", e "Apri" verso la roadmap web.
 */
describe("InboxCard — brief settimanale (kind conosciuto)", () => {
  const BRIEF = item({
    id: "wb1",
    kind: "project.brief",
    text: "🗞️ Brief settimanale di Portale B2B (2026-08-31 → 2026-09-06): settimana di consolidamento.",
    actions: ["open", "snooze", "handled"],
    projectId: "11111111-1111-4111-8111-111111111111",
    url: "https://stubwise.example.com/projects/11111111-1111-4111-8111-111111111111/roadmap",
  });

  test("card informativa con la sua etichetta, non il generico 'Aggiornamento'", async () => {
    await renderCard(BRIEF, makeClient());
    expect(screen.getByTestId("info-card")).toBeTruthy();
    expect(screen.getByText("Brief settimanale")).toBeTruthy();
    expect(screen.queryByText("Aggiornamento")).toBeNull();
  });

  test("'Apri' porta alla roadmap del progetto sul web", async () => {
    await renderCard(BRIEF, makeClient());
    await fireEvent.press(screen.getByTestId("info-card-open"));
    expect(Linking.openURL).toHaveBeenCalledWith(
      "https://stubwise.example.com/projects/11111111-1111-4111-8111-111111111111/roadmap",
    );
  });

  test("nessun bottone di decisione: non c'è niente da decidere su un brief", async () => {
    await renderCard(BRIEF, makeClient());
    expect(screen.queryByTestId("info-card-retry")).toBeNull();
    expect(screen.queryByText("Approva")).toBeNull();
  });
});
