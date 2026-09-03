import type { StubwiseClient } from "@stubwise/api-client";
import notifee from "@notifee/react-native";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { OnboardingScreen } from "./OnboardingScreen";

const projects = [
  { id: "p1", name: "Portale B2B" },
  { id: "p2", name: "Piattaforma Acme" },
  { id: "p3", name: "Sito vetrina" },
  { id: "p4", name: "Gestionale interno" },
];

function makeClient(overrides: Partial<StubwiseClient> = {}): StubwiseClient {
  return {
    projects: {
      list: jest.fn().mockResolvedValue(projects),
    },
    me: {
      follows: jest.fn().mockResolvedValue({ projectIds: ["p1", "p2", "p3"] }),
      registerDevice: jest.fn().mockResolvedValue(undefined),
      setFollows: jest.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as unknown as StubwiseClient;
}

// `render()` di @testing-library/react-native è ASINCRONO: senza `await`
// qui `screen` non è ancora legato al render appena fatto (vedi il
// commento gemello in LoginScreen.test.tsx — stessa causa, stesso fix).
async function renderOnboarding(client: StubwiseClient, completeOnboarding = jest.fn()) {
  const value: AuthContextValue = {
    status: "authenticated",
    client,
    user: null,
    justLoggedIn: true,
    login: jest.fn(),
    completeOnboarding,
  };
  await render(
    <AuthContext.Provider value={value}>
      <OnboardingScreen />
    </AuthContext.Provider>,
  );
  return { completeOnboarding };
}

beforeEach(() => {
  jest.clearAllMocks();
  (notifee.requestPermission as jest.Mock).mockResolvedValue({ authorizationStatus: 1 });
});

describe("OnboardingScreen", () => {
  test("mostra i progetti con i toggle preselezionati dai follow", async () => {
    const client = makeClient();
    await renderOnboarding(client);

    await waitFor(() => expect(screen.getByText("Portale B2B")).toBeTruthy());
    expect(screen.getByText("Piattaforma Acme")).toBeTruthy();
    expect(screen.getByText("Sito vetrina")).toBeTruthy();
    expect(screen.getByText("Gestionale interno")).toBeTruthy();

    // I 3 seguiti sono ON, il quarto (non in `follows`) è OFF.
    expect(screen.getByLabelText("Portale B2B").props.value).toBe(true);
    expect(screen.getByLabelText("Gestionale interno").props.value).toBe(false);
  });

  test("'Attiva le notifiche e inizia': chiede il permesso, registra il device (se c'è un token), salva i follow e completa l'onboarding", async () => {
    const client = makeClient();
    const { completeOnboarding } = await renderOnboarding(client);
    await waitFor(() => expect(screen.getByText("Portale B2B")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("onboarding-activate"));

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledTimes(1));
    expect(notifee.requestPermission).toHaveBeenCalledTimes(1);
    // Nessun provider push cablato in questo task (vedi lib/push-token.ts):
    // getPushToken() risolve sempre null, quindi registerDevice NON parte.
    expect(client.me.registerDevice).not.toHaveBeenCalled();
    expect(client.me.setFollows).toHaveBeenCalledWith(["p1", "p2", "p3"]);
  });

  test("togliere un progetto dal toggle cambia l'insieme mandato a setFollows", async () => {
    const client = makeClient();
    await renderOnboarding(client);
    await waitFor(() => expect(screen.getByText("Portale B2B")).toBeTruthy());

    await fireEvent(screen.getByLabelText("Portale B2B"), "valueChange", false);
    await fireEvent(screen.getByLabelText("Gestionale interno"), "valueChange", true);
    await fireEvent.press(screen.getByTestId("onboarding-activate"));

    await waitFor(() => expect(client.me.setFollows).toHaveBeenCalled());
    const [sent] = (client.me.setFollows as jest.Mock).mock.calls[0] as [string[]];
    expect(new Set(sent)).toEqual(new Set(["p2", "p3", "p4"]));
  });

  test("'Più tardi': salta SOLO il permesso — niente notifee, niente registerDevice — ma salva comunque i follow", async () => {
    const client = makeClient();
    const { completeOnboarding } = await renderOnboarding(client);
    await waitFor(() => expect(screen.getByText("Portale B2B")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("onboarding-later"));

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledTimes(1));
    expect(notifee.requestPermission).not.toHaveBeenCalled();
    expect(client.me.registerDevice).not.toHaveBeenCalled();
    expect(client.me.setFollows).toHaveBeenCalledWith(["p1", "p2", "p3"]);
  });

  test("errore nel caricamento dei progetti: mostra Riprova, che ricarica", async () => {
    const client = makeClient();
    (client.projects.list as jest.Mock)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(projects);
    await renderOnboarding(client);

    await waitFor(() => expect(screen.getByText("Non riesco a caricare i progetti.")).toBeTruthy());
    await fireEvent.press(screen.getByText("Riprova"));

    await waitFor(() => expect(screen.getByText("Portale B2B")).toBeTruthy());
  });
});
