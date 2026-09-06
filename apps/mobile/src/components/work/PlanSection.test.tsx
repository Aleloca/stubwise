import type { StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import type { ComponentProps } from "react";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { PlanSection } from "./PlanSection";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";

function makeClient(overrides: { approvePlan?: jest.Mock; rejectPlan?: jest.Mock } = {}): StubwiseClient {
  return {
    tickets: {
      approvePlan: overrides.approvePlan ?? jest.fn().mockResolvedValue({ jobId: "job-1" }),
      rejectPlan: overrides.rejectPlan ?? jest.fn().mockResolvedValue({ jobId: "job-1" }),
    },
  } as unknown as StubwiseClient;
}

async function renderSection(props: Partial<ComponentProps<typeof PlanSection>>, client: StubwiseClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const authValue: AuthContextValue = {
    status: "authenticated",
    client,
    user: { id: "u1", email: "a@example.com", role: "admin", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <PlanSection
          ticketId={TICKET_ID}
          ticketTitle="Cache delle immagini prodotto"
          plan={null}
          planSummary={null}
          canDecide={false}
          {...props}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe("PlanSection — nessun piano", () => {
  test("mostra l'empty state, nessun link 'leggi il piano', nessun bottone", async () => {
    await renderSection({ plan: null, canDecide: false }, makeClient());
    expect(screen.getByText("Nessun piano collegato.")).toBeTruthy();
    expect(screen.queryByText("Leggi il piano completo →")).toBeNull();
    expect(screen.queryByTestId("plan-section-approve")).toBeNull();
  });
});

describe("PlanSection — piano presente, canDecide false", () => {
  test("mostra il piano e il link, MA nessun bottone Approva/Rifiuta", async () => {
    await renderSection({ plan: "Passo 1: fai una cosa.", canDecide: false }, makeClient());
    expect(screen.getByText(/Passo 1: fai una cosa/)).toBeTruthy();
    expect(screen.getByText("Leggi il piano completo →")).toBeTruthy();
    expect(screen.queryByTestId("plan-section-approve")).toBeNull();
    expect(screen.queryByTestId("plan-section-reject")).toBeNull();
  });

  test("'Leggi il piano completo' apre il piano intero in una modale", async () => {
    await renderSection({ plan: "Passo 1: fai una cosa.\n\nPasso 2: fai un'altra cosa." }, makeClient());
    await fireEvent.press(screen.getByText("Leggi il piano completo →"));
    await waitFor(() => expect(screen.getByText(/Passo 2: fai un'altra cosa/)).toBeTruthy());
  });

  test("è markdown VERO: la sintassi **grassetto** viene interpretata (asterischi rimossi), a differenza del tag HTML", async () => {
    await renderSection({ plan: "Un **piano** importante." }, makeClient());
    await fireEvent.press(screen.getByText("Leggi il piano completo →"));
    const modal = within(screen.getByTestId("plan-section-modal"));
    await waitFor(() => expect(modal.getByText("piano")).toBeTruthy());
    expect(modal.queryByText(/\*\*/)).toBeNull();
  });

  test("markdown sanitizzato: un tag HTML nel piano appare come testo letterale, non interpretato", async () => {
    await renderSection({ plan: "Testo <b>non in grassetto via HTML</b> qui." }, makeClient());
    await fireEvent.press(screen.getByText("Leggi il piano completo →"));
    const modal = within(screen.getByTestId("plan-section-modal"));
    await waitFor(() => expect(modal.getByText(/non in grassetto via HTML/)).toBeTruthy());
    // Il tag stesso deve comparire com'è scritto (escape), non sparire come farebbe un parser HTML vero.
    expect(modal.getByText(/<b>/)).toBeTruthy();
  });
});

describe("PlanSection — canDecide true", () => {
  test("'Approva' → conferma → chiama client.tickets.approvePlan", async () => {
    const approvePlan = jest.fn().mockResolvedValue({ jobId: "job-1" });
    const client = makeClient({ approvePlan });
    await renderSection({ plan: "Piano", canDecide: true }, client);

    await fireEvent.press(screen.getByTestId("plan-section-approve"));
    expect(screen.getByText("Confermi?")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("plan-section-approve-confirm"));

    await waitFor(() => expect(approvePlan).toHaveBeenCalledWith(TICKET_ID));
  });

  test("'Rifiuta con istruzioni' apre la sheet e chiama rejectPlan con le istruzioni", async () => {
    const rejectPlan = jest.fn().mockResolvedValue({ jobId: "job-1" });
    const client = makeClient({ rejectPlan });
    await renderSection({ plan: "Piano", canDecide: true }, client);

    await fireEvent.press(screen.getByTestId("plan-section-reject"));
    await fireEvent.changeText(screen.getByTestId("reject-sheet-input"), "Usa la CDN che abbiamo già");
    await fireEvent.press(screen.getByTestId("reject-sheet-submit"));

    await waitFor(() =>
      expect(rejectPlan).toHaveBeenCalledWith(TICKET_ID, { instructions: "Usa la CDN che abbiamo già" }),
    );
  });
});

/**
 * Fase 5: il worker genera un riassunto "in breve" del piano (`plan_summary`)
 * per chi non legge codice. La card lo preferisce SEMPRE al piano tecnico
 * troncato — che resta il fallback, dichiarato come tale — e "Leggi il piano
 * completo" continua ad aprire il piano VERO, non il riassunto.
 */
describe("PlanSection — riassunto in breve", () => {
  test("con riassunto: mostra il riassunto, non il piano tecnico, e nessuna nota di fallback", async () => {
    await renderSection(
      {
        plan: "Passo 1: aggiungere l'indice. Passo 2: migrare i dati.",
        planSummary: "Le immagini dei prodotti si caricheranno subito. Tocca solo il listino, non il checkout.",
      },
      makeClient(),
    );
    expect(screen.getByText(/Le immagini dei prodotti si caricheranno subito/)).toBeTruthy();
    expect(screen.queryByText(/Passo 1: aggiungere l'indice/)).toBeNull();
    expect(screen.queryByTestId("plan-section-summary-fallback")).toBeNull();
  });

  test("con riassunto: 'Leggi il piano completo' apre comunque il PIANO, non il riassunto", async () => {
    await renderSection(
      { plan: "Passo 1: aggiungere un indice sul listino.", planSummary: "Le immagini si caricheranno subito." },
      makeClient(),
    );
    await fireEvent.press(screen.getByText("Leggi il piano completo →"));
    const modal = within(screen.getByTestId("plan-section-modal"));
    await waitFor(() => expect(modal.getByText(/Passo 1: aggiungere un indice sul listino/)).toBeTruthy());
  });

  test("senza riassunto: ricade sul piano troncato E lo dichiara", async () => {
    await renderSection({ plan: "Passo 1: aggiungere l'indice.", planSummary: null }, makeClient());
    expect(screen.getByText(/Passo 1: aggiungere l'indice/)).toBeTruthy();
    expect(screen.getByText("Riassunto non disponibile: qui sotto il piano tecnico.")).toBeTruthy();
  });

  test("nessun piano e nessun riassunto: resta l'empty state, nessuna nota di fallback", async () => {
    await renderSection({ plan: null, planSummary: null }, makeClient());
    expect(screen.getByText("Nessun piano collegato.")).toBeTruthy();
    expect(screen.queryByTestId("plan-section-summary-fallback")).toBeNull();
  });

  /**
   * Difensivo: `plan_summary` vive e muore con `plan_text` (il rifiuto del
   * piano azzera entrambi nello stesso UPDATE), quindi un riassunto senza
   * piano non dovrebbe esistere. Se una risposta lo portasse comunque, si
   * mostra ciò che c'è invece dell'empty state — senza offrire un link a un
   * piano che non c'è.
   */
  test("riassunto senza piano: mostra il riassunto, ma nessun 'Leggi il piano completo'", async () => {
    await renderSection({ plan: null, planSummary: "Il listino si carica subito." }, makeClient());
    expect(screen.getByText("Il listino si carica subito.")).toBeTruthy();
    expect(screen.queryByText("Leggi il piano completo →")).toBeNull();
  });
});
