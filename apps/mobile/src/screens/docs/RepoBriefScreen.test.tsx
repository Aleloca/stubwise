import { ApiError, type StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { RepoBriefScreen } from "./RepoBriefScreen";

/** Il brief di un repository, come la tab Brief del web (`DocsBriefView`). */
const REPO = "11111111-1111-4111-8111-111111111111";

async function renderScreen(brief: jest.Mock) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const authValue: AuthContextValue = {
    status: "authenticated",
    client: { docs: { brief } } as unknown as StubwiseClient,
    user: { id: "viewer-1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    loggedOut: jest.fn(),
  };
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <RepoBriefScreen
          navigation={{ goBack: jest.fn() } as never}
          route={{ key: "RepoBrief", name: "RepoBrief", params: { repositoryId: REPO, repositoryName: "portale-web" } }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe("RepoBriefScreen", () => {
  test("identità, attori, superfici, percorsi, glossario, invarianti e la generazione", async () => {
    await renderScreen(
      jest.fn().mockResolvedValue({
        brief: {
          identity: "Il portale per gli ordini B2B.",
          actors: [{ name: "Buyer", description: "Ordina per l'azienda.", internal: false }],
          surfaces: [{ name: "Web", type: "spa", rootPath: "apps/web", audience: "clienti", internal: false }],
          glossary: [{ term: "Listino", definition: "I prezzi del cliente." }],
          invariants: ["Un ordine non si modifica dopo la conferma."],
          confidentialFacts: [],
          journeys: [{ actor: "Buyer", title: "Riordino", summary: "Ripete un ordine passato." }],
          existingSources: [],
        },
        generation: { createdAt: "2026-09-25T10:30:00.000Z", commitSha: "abc1234def" },
        productExclusions: [],
      }),
    );
    await waitFor(() => expect(screen.getByText("Il portale per gli ordini B2B.")).toBeTruthy());
    // Due volte: l'attore, e l'attore del percorso «Riordino».
    expect(screen.getAllByText("Buyer")).toHaveLength(2);
    expect(screen.getByText("Web")).toBeTruthy();
    expect(screen.getByText("Riordino")).toBeTruthy();
    expect(screen.getByText("Listino")).toBeTruthy();
    expect(screen.getByText(/Un ordine non si modifica dopo la conferma\./)).toBeTruthy();
    expect(screen.getByText(/abc1234/)).toBeTruthy();
  });

  test("un repository senza brief (404) lo dice, non un errore", async () => {
    await renderScreen(jest.fn().mockRejectedValue(new ApiError(404, "Not found", "doc_brief_not_found")));
    await waitFor(() => expect(screen.getByTestId("repo-brief-empty")).toBeTruthy());
  });
});
