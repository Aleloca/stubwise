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
        <PlanSection ticketId={TICKET_ID} ticketTitle="Cache delle immagini prodotto" plan={null} canDecide={false} {...props} />
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
