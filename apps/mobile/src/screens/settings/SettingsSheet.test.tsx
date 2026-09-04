import type { StubwiseClient } from "@stubwise/api-client";
import type { Reader, SessionUser } from "@stubwise/shared";
import { deleteToken, getToken } from "@react-native-firebase/messaging";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import i18n from "../../i18n";
import "../../i18n";
import { clearSession, loadSession } from "../../lib/storage";
import { SettingsSheet } from "./SettingsSheet";

// Isolato da Keychain/AsyncStorage veri: qui interessa SOLO che `SettingsSheet`
// chiami `loadSession`/`clearSession` nel modo giusto, non la persistenza
// reale (già coperta da `lib/storage.test.ts`).
jest.mock("../../lib/storage", () => ({
  loadSession: jest.fn(),
  clearSession: jest.fn(),
}));

const mockLoadSession = loadSession as jest.Mock;
const mockClearSession = clearSession as jest.Mock;
const mockGetToken = getToken as jest.Mock;
const mockDeleteToken = deleteToken as jest.Mock;

const USER: Reader<SessionUser> = {
  id: "u1",
  email: "giulia@farmakom.it",
  role: "member",
  language: "it",
  avatarUrl: null,
  slackUserId: null,
};

const ADMIN_USER: Reader<SessionUser> = { ...USER, id: "u2", email: "admin@farmakom.it", role: "admin" };

const PROJECT_A = { id: "p1", name: "Farmakom" };
const PROJECT_B = { id: "p2", name: "Audin" };

interface ClientOverrides {
  notificationPrefs?: jest.Mock;
  setNotificationPrefs?: jest.Mock;
  follows?: jest.Mock;
  setFollows?: jest.Mock;
  deleteDevice?: jest.Mock;
  projectsList?: jest.Mock;
  setLanguage?: jest.Mock;
  patsRevoke?: jest.Mock;
}

function makeClient(overrides: ClientOverrides = {}): StubwiseClient {
  return {
    me: {
      notificationPrefs:
        overrides.notificationPrefs ?? jest.fn().mockResolvedValue({ push: true, slackDm: false, slackLinked: false }),
      setNotificationPrefs: overrides.setNotificationPrefs ?? jest.fn().mockResolvedValue(undefined),
      follows: overrides.follows ?? jest.fn().mockResolvedValue({ projectIds: [PROJECT_A.id] }),
      setFollows: overrides.setFollows ?? jest.fn().mockResolvedValue(undefined),
      deleteDevice: overrides.deleteDevice ?? jest.fn().mockResolvedValue(undefined),
    },
    projects: {
      list: overrides.projectsList ?? jest.fn().mockResolvedValue([PROJECT_A, PROJECT_B]),
    },
    auth: {
      setLanguage: overrides.setLanguage ?? jest.fn().mockResolvedValue({ language: "en" }),
    },
    pats: {
      revoke: overrides.patsRevoke ?? jest.fn().mockResolvedValue(undefined),
    },
  } as unknown as StubwiseClient;
}

async function renderSheet(
  client: StubwiseClient,
  opts: { visible?: boolean; user?: Reader<SessionUser>; onRequestClose?: jest.Mock; onLoggedOut?: jest.Mock } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onRequestClose = opts.onRequestClose ?? jest.fn();
  const onLoggedOut = opts.onLoggedOut ?? jest.fn();
  const rendered = await render(
    <QueryClientProvider client={queryClient}>
      <SettingsSheet
        visible={opts.visible ?? true}
        onRequestClose={onRequestClose}
        client={client}
        user={opts.user ?? USER}
        onLoggedOut={onLoggedOut}
      />
    </QueryClientProvider>,
  );
  return { ...rendered, onRequestClose, onLoggedOut };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadSession.mockResolvedValue({
    baseUrl: "https://stubwise.farmakom.it",
    token: "stw_pat_x",
    patId: "pat-1",
    user: USER,
  });
  mockGetToken.mockResolvedValue(null);
  mockClearSession.mockResolvedValue(undefined);
});

afterEach(async () => {
  await i18n.changeLanguage("it");
});

describe("SettingsSheet — visibilità e profilo", () => {
  test("nascosta quando visible=false", async () => {
    await renderSheet(makeClient(), { visible: false });
    expect(screen.queryByTestId("settings-logout-button")).toBeNull();
  });

  test("mostra l'email e il ruolo (Operator per member)", async () => {
    await renderSheet(makeClient());
    expect(screen.getByText("giulia@farmakom.it")).toBeTruthy();
    expect(screen.getByText("Operator")).toBeTruthy();
  });

  test("mostra 'Admin' per un ruolo admin", async () => {
    await renderSheet(makeClient(), { user: ADMIN_USER });
    expect(screen.getByText("Admin")).toBeTruthy();
  });

  test("toccare lo sfondo chiama onRequestClose", async () => {
    const onRequestClose = jest.fn();
    await renderSheet(makeClient(), { onRequestClose });
    await fireEvent.press(screen.getByLabelText("Chiudi"));
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsSheet — notifiche push", () => {
  test("riflette lo stato letto da me.notificationPrefs()", async () => {
    const notificationPrefs = jest.fn().mockResolvedValue({ push: true, slackDm: false, slackLinked: false });
    await renderSheet(makeClient({ notificationPrefs }));
    await waitFor(() => expect(notificationPrefs).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("settings-push-switch").props.value).toBe(true));
  });

  test("toccare il toggle manda SOLO il campo push (PATCH mirata)", async () => {
    const setNotificationPrefs = jest.fn().mockResolvedValue(undefined);
    await renderSheet(makeClient({ setNotificationPrefs }));
    await waitFor(() => expect(screen.getByTestId("settings-push-switch")).toBeTruthy());
    await fireEvent(screen.getByTestId("settings-push-switch"), "valueChange", false);
    await waitFor(() => expect(setNotificationPrefs).toHaveBeenCalledWith({ push: false }));
  });
});

describe("SettingsSheet — progetti seguiti", () => {
  test("mostra ogni progetto con lo stato di follow corrente", async () => {
    await renderSheet(makeClient());
    await waitFor(() => expect(screen.getByLabelText("Farmakom").props.value).toBe(true));
    expect(screen.getByLabelText("Audin").props.value).toBe(false);
  });

  test("attivare il follow di un progetto manda l'insieme COMPLETO aggiornato", async () => {
    const setFollows = jest.fn().mockResolvedValue(undefined);
    await renderSheet(makeClient({ setFollows }));
    await waitFor(() => expect(screen.getByLabelText("Audin")).toBeTruthy());
    await fireEvent(screen.getByLabelText("Audin"), "valueChange", true);
    await waitFor(() => expect(setFollows).toHaveBeenCalledWith([PROJECT_A.id, PROJECT_B.id]));
  });

  test("disattivare il follow di un progetto lo toglie dall'insieme mandato", async () => {
    const setFollows = jest.fn().mockResolvedValue(undefined);
    await renderSheet(makeClient({ setFollows }));
    await waitFor(() => expect(screen.getByLabelText("Farmakom")).toBeTruthy());
    await fireEvent(screen.getByLabelText("Farmakom"), "valueChange", false);
    await waitFor(() => expect(setFollows).toHaveBeenCalledWith([]));
  });
});

describe("SettingsSheet — istanza (server + lingua)", () => {
  test("mostra l'host del server, sola lettura", async () => {
    await renderSheet(makeClient());
    await waitFor(() => expect(screen.getByText("stubwise.farmakom.it")).toBeTruthy());
  });

  test("scegliere 'English' persiste la lingua sul server E la applica subito in locale", async () => {
    const setLanguage = jest.fn().mockResolvedValue({ language: "en" });
    await renderSheet(makeClient({ setLanguage }));
    await fireEvent.press(screen.getByTestId("settings-language-en"));
    await waitFor(() => expect(setLanguage).toHaveBeenCalledWith("en"));
    await waitFor(() => expect(i18n.language).toBe("en"));
  });
});

describe("SettingsSheet — Esci (logout)", () => {
  test("felice: revoca device e PAT, invalida il token push, cancella la sessione locale", async () => {
    mockGetToken.mockResolvedValue("fcm-token-1");
    const deleteDevice = jest.fn().mockResolvedValue(undefined);
    const patsRevoke = jest.fn().mockResolvedValue(undefined);
    const onLoggedOut = jest.fn();
    await renderSheet(makeClient({ deleteDevice, patsRevoke }), { onLoggedOut });

    await fireEvent.press(screen.getByTestId("settings-logout-button"));

    await waitFor(() => expect(onLoggedOut).toHaveBeenCalledTimes(1));
    expect(deleteDevice).toHaveBeenCalledWith("fcm-token-1");
    expect(patsRevoke).toHaveBeenCalledWith("pat-1");
    expect(mockDeleteToken).toHaveBeenCalledTimes(1);
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });

  // ⚠️ Il comportamento contrattuale del task: "best-effort ma sempre
  // locale". Fa fallire UNA delle tre chiamate remote (qui: deleteDevice) e
  // verifica che le ALTRE DUE partano comunque, e che la sessione locale
  // venga comunque cancellata — non un `await` sequenziale che si ferma al
  // primo errore.
  test("best-effort: un fallimento di deleteDevice non impedisce revoca PAT, deleteToken e clearSession", async () => {
    mockGetToken.mockResolvedValue("fcm-token-1");
    const deleteDevice = jest.fn().mockRejectedValue(new Error("network down"));
    const patsRevoke = jest.fn().mockResolvedValue(undefined);
    const onLoggedOut = jest.fn();
    await renderSheet(makeClient({ deleteDevice, patsRevoke }), { onLoggedOut });

    await fireEvent.press(screen.getByTestId("settings-logout-button"));

    await waitFor(() => expect(onLoggedOut).toHaveBeenCalledTimes(1));
    expect(patsRevoke).toHaveBeenCalledWith("pat-1");
    expect(mockDeleteToken).toHaveBeenCalledTimes(1);
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });

  test("best-effort: un fallimento della revoca PAT non impedisce deleteDevice, deleteToken e clearSession", async () => {
    mockGetToken.mockResolvedValue("fcm-token-1");
    const deleteDevice = jest.fn().mockResolvedValue(undefined);
    const patsRevoke = jest.fn().mockRejectedValue(new Error("pat already gone"));
    const onLoggedOut = jest.fn();
    await renderSheet(makeClient({ deleteDevice, patsRevoke }), { onLoggedOut });

    await fireEvent.press(screen.getByTestId("settings-logout-button"));

    await waitFor(() => expect(onLoggedOut).toHaveBeenCalledTimes(1));
    expect(deleteDevice).toHaveBeenCalledWith("fcm-token-1");
    expect(mockDeleteToken).toHaveBeenCalledTimes(1);
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });

  test("best-effort: un fallimento di deleteToken (FCM) non impedisce deleteDevice, revoca PAT e clearSession", async () => {
    mockGetToken.mockResolvedValue("fcm-token-1");
    mockDeleteToken.mockRejectedValue(new Error("fcm unavailable"));
    const deleteDevice = jest.fn().mockResolvedValue(undefined);
    const patsRevoke = jest.fn().mockResolvedValue(undefined);
    const onLoggedOut = jest.fn();
    await renderSheet(makeClient({ deleteDevice, patsRevoke }), { onLoggedOut });

    await fireEvent.press(screen.getByTestId("settings-logout-button"));

    await waitFor(() => expect(onLoggedOut).toHaveBeenCalledTimes(1));
    expect(deleteDevice).toHaveBeenCalledWith("fcm-token-1");
    expect(patsRevoke).toHaveBeenCalledWith("pat-1");
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });

  test("nessun token push registrato: deleteDevice non parte, ma revoca PAT + deleteToken + clearSession sì", async () => {
    mockGetToken.mockResolvedValue(null);
    const deleteDevice = jest.fn().mockResolvedValue(undefined);
    const patsRevoke = jest.fn().mockResolvedValue(undefined);
    const onLoggedOut = jest.fn();
    await renderSheet(makeClient({ deleteDevice, patsRevoke }), { onLoggedOut });

    await fireEvent.press(screen.getByTestId("settings-logout-button"));

    await waitFor(() => expect(onLoggedOut).toHaveBeenCalledTimes(1));
    expect(deleteDevice).not.toHaveBeenCalled();
    expect(patsRevoke).toHaveBeenCalledWith("pat-1");
    expect(mockDeleteToken).toHaveBeenCalledTimes(1);
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsSheet — accessibilità", () => {
  test("i bottoni/controlli con solo glifo hanno un accessibilityLabel", async () => {
    await renderSheet(makeClient());
    // Avatar-glifo (iniziale email) nel profilo: non presente qui (vive nel
    // bottone globale di `providers.tsx`) — quel che vive DENTRO la sheet è
    // il backdrop (nessun testo visibile) e i chip lingua (IT/EN, testo
    // breve ma comunque etichettati).
    expect(screen.getByLabelText("Chiudi")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("settings-push-switch").props.accessibilityLabel).toBeTruthy());
    expect(screen.getByTestId("settings-language-it").props.accessibilityRole).toBe("radio");
    expect(screen.getByTestId("settings-language-en").props.accessibilityRole).toBe("radio");
  });
});
