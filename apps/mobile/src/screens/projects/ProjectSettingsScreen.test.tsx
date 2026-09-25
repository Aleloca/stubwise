import { ApiError } from "@stubwise/api-client";
import type { StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../app/auth-context";
import type { AuthContextValue } from "../../app/providers";
import "../../i18n";
import { ProjectSettingsScreen } from "./ProjectSettingsScreen";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function projectDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PROJECT_ID,
    name: "Portale B2B",
    slug: "portale-b2b",
    description: "Il portale dei rivenditori",
    aiProviderId: null,
    docAutoUpdate: false,
    dailyReportEnabled: true,
    backlogEnabled: true,
    pulseEnabled: true,
    pulseEveryDays: 3,
    weeklyBriefEnabled: false,
    ingestionKey: "ik_test",
    nextTicketNumber: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    repositories: [],
    ...overrides,
  };
}

function makeClient(overrides: { get?: jest.Mock; patch?: jest.Mock } = {}): StubwiseClient {
  return {
    projects: {
      get: overrides.get ?? jest.fn().mockResolvedValue(projectDetail()),
      patch: overrides.patch ?? jest.fn().mockResolvedValue(projectDetail()),
    },
  } as unknown as StubwiseClient;
}

async function renderScreen(client: StubwiseClient, role: "admin" | "member") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  const navigation = { goBack: jest.fn(), navigate: jest.fn() } as never;
  await render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <ProjectSettingsScreen
          navigation={navigation}
          route={{
            key: "ProjectSettings",
            name: "ProjectSettings",
            params: { projectId: PROJECT_ID, projectName: "Portale B2B" },
          }}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { queryClient };
}

beforeEach(() => jest.clearAllMocks());

describe("ProjectSettingsScreen — operatore", () => {
  test("legge in sola lettura, con la riga che spiega perché", async () => {
    await renderScreen(makeClient(), "member");
    await waitFor(() => expect(screen.getByTestId("project-settings-read-only-hint")).toBeTruthy());
    expect(screen.queryByTestId("project-settings-save")).toBeNull();
    expect(screen.queryByTestId("project-settings-backlog")).toBeNull();
    expect(screen.getByTestId("project-settings-pulse-value").props.children).toBe("Ogni 3 giorni");
  });

  /** ⚠️ Pulse acceso senza backlog: muto. Si dice come sul web, non con una cadenza. */
  test("pulse acceso senza backlog: in attesa del backlog", async () => {
    await renderScreen(makeClient({ get: jest.fn().mockResolvedValue(projectDetail({ backlogEnabled: false })) }), "member");
    await waitFor(() => expect(screen.getByTestId("project-settings-pulse-value")).toBeTruthy());
    expect(screen.getByTestId("project-settings-pulse-value").props.children).toBe(
      "Attivo (in attesa del backlog di discovery)",
    );
  });
});

describe("ProjectSettingsScreen — maintainer", () => {
  test("il form c'è, e Salva è spento finché non cambia niente", async () => {
    await renderScreen(makeClient(), "admin");
    await waitFor(() => expect(screen.getByTestId("project-settings-save")).toBeTruthy());
    expect(screen.getByTestId("project-settings-save").props.accessibilityState.disabled).toBe(true);
    expect(screen.queryByTestId("project-settings-read-only-hint")).toBeNull();
  });

  /**
   * ⚠️ Il cuore della regola: la patch porta SOLO il campo toccato. Due
   * persone che salvano dalla stessa schermata non si sovrascrivono i campi
   * che nessuna delle due ha cambiato.
   */
  test("salva SOLO il campo cambiato", async () => {
    const patch = jest.fn().mockResolvedValue(projectDetail({ weeklyBriefEnabled: true }));
    await renderScreen(makeClient({ patch }), "admin");
    await waitFor(() => expect(screen.getByTestId("project-settings-weekly-brief")).toBeTruthy());
    await fireEvent(screen.getByTestId("project-settings-weekly-brief"), "valueChange", true);
    await fireEvent.press(screen.getByTestId("project-settings-save"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(PROJECT_ID, { weeklyBriefEnabled: true });
  });

  test("la cadenza cambia coi bottoni e viaggia da sola", async () => {
    const patch = jest.fn().mockResolvedValue(projectDetail());
    await renderScreen(makeClient({ patch }), "admin");
    await waitFor(() => expect(screen.getByTestId("project-settings-pulse-days-plus")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("project-settings-pulse-days-plus"));
    await fireEvent.press(screen.getByTestId("project-settings-pulse-days-plus"));
    expect(screen.getByTestId("project-settings-pulse-days").props.children).toBe(5);
    await fireEvent.press(screen.getByTestId("project-settings-save"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(PROJECT_ID, { pulseEveryDays: 5 }));
  });

  /**
   * ⚠️ Il salvataggio deve INVALIDARE ciò che mostra le impostazioni: l'app
   * non ha refetch-on-focus, e l'hub montato sotto mostrerebbe il valore
   * vecchio al ritorno. Qui la prova è che il dettaglio si rilegge.
   */
  test("dopo il salvataggio il progetto si rilegge (chiave invalidata)", async () => {
    const get = jest.fn().mockResolvedValue(projectDetail());
    await renderScreen(makeClient({ get }), "admin");
    await waitFor(() => expect(screen.getByTestId("project-settings-doc-auto-update")).toBeTruthy());
    expect(get).toHaveBeenCalledTimes(1);
    await fireEvent(screen.getByTestId("project-settings-doc-auto-update"), "valueChange", true);
    await fireEvent.press(screen.getByTestId("project-settings-save"));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("project-settings-saved")).toBeTruthy());
  });

  test("senza backlog il pulse non si accende da qui, e lo dice", async () => {
    await renderScreen(makeClient({ get: jest.fn().mockResolvedValue(projectDetail({ backlogEnabled: false, pulseEnabled: false })) }), "admin");
    await waitFor(() => expect(screen.getByTestId("project-settings-pulse")).toBeTruthy());
    expect(screen.getByTestId("project-settings-pulse").props.disabled).toBe(true);
    expect(screen.getByText("serve il backlog di discovery: senza, non c'è nulla da proporre")).toBeTruthy();
  });

  test("accendendo il backlog nello stesso passaggio il pulse diventa accendibile", async () => {
    await renderScreen(makeClient({ get: jest.fn().mockResolvedValue(projectDetail({ backlogEnabled: false, pulseEnabled: false })) }), "admin");
    await waitFor(() => expect(screen.getByTestId("project-settings-backlog")).toBeTruthy());
    await fireEvent(screen.getByTestId("project-settings-backlog"), "valueChange", true);
    expect(screen.getByTestId("project-settings-pulse").props.disabled).toBe(false);
  });

  /** ⚠️ Un 403 si MOSTRA, non si ingoia. */
  test("un 403 dal server si mostra", async () => {
    const patch = jest.fn().mockRejectedValue(new ApiError(403, "Forbidden", "forbidden"));
    await renderScreen(makeClient({ patch }), "admin");
    await waitFor(() => expect(screen.getByTestId("project-settings-backlog")).toBeTruthy());
    await fireEvent(screen.getByTestId("project-settings-backlog"), "valueChange", false);
    await fireEvent.press(screen.getByTestId("project-settings-save"));
    await waitFor(() => expect(screen.getByTestId("project-settings-save-error")).toBeTruthy());
    expect(screen.getByTestId("project-settings-save-error").props.children).toBe(
      "Solo un maintainer può modificare le impostazioni.",
    );
  });

  test("nome svuotato: non si salva", async () => {
    await renderScreen(makeClient(), "admin");
    await waitFor(() => expect(screen.getByTestId("project-settings-name")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("project-settings-name"), "   ");
    expect(screen.getByTestId("project-settings-save").props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText("Il nome non può essere vuoto.")).toBeTruthy();
  });
});

/**
 * ⚠️ La pagina scorre fino al campo in uso quando sale la tastiera (25 set
 * 2026, segnalato dal maintainer: «la tastiera va sopra l'input del
 * commento»). Il layout vero non si misura in Jest; questo test tiene il
 * CABLAGGIO — la `ScrollView` della pagina ha la gestione nativa accesa.
 */
describe("ProjectSettingsScreen — tastiera", () => {
  test("la pagina che scorre ha la gestione nativa della tastiera", async () => {
    await renderScreen(makeClient(), "admin");
    const scroll = await waitFor(() => screen.getByTestId("keyboard-aware-scroll"));
    expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(true);
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
  });
});
