import type { StubwiseClient } from "@stubwise/api-client";
import type { Reader, SessionUser } from "@stubwise/shared";
import { deleteToken, getToken } from "@react-native-firebase/messaging";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import i18n from "../../i18n";
import "../../i18n";
import { clearSession, loadSession } from "../../lib/storage";
import { SettingsScreen } from "./SettingsScreen";
import { useLogout } from "./use-logout";

// Isolato da Keychain/AsyncStorage veri: qui interessa SOLO che `SettingsScreen`
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

/**
 * Monta l'INDICE come lo monta la rotta vera: l'hook del logout fuori, il suo
 * stato passato alla pagina. Così questi test coprono il wiring che il
 * maintainer usa davvero, non un bottone scollegato.
 *
 * ⚠️ `await render(...)`: in questo progetto va atteso, o l'albero non viene
 * montato e `screen` resta vuoto.
 */
function Host({ client, onLoggedOut }: { client: StubwiseClient; onLoggedOut: () => void }) {
  const { logout, loggingOut } = useLogout(client, onLoggedOut);
  return (
    <SettingsScreen
      user={USER}
      onOpenSection={jest.fn()}
      onBack={jest.fn()}
      onLogout={logout}
      loggingOut={loggingOut}
    />
  );
}

async function renderSheet(
  client: StubwiseClient,
  opts: { onLoggedOut?: jest.Mock } = {},
) {
  const onLoggedOut = opts.onLoggedOut ?? jest.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = await render(
    <QueryClientProvider client={queryClient}>
      <Host client={client} onLoggedOut={onLoggedOut} />
    </QueryClientProvider>,
  );
  return { ...rendered, onLoggedOut };
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


describe("SettingsScreen — indice", () => {
  test("elenca i gruppi e le voci, con WIP su quelle non ancora fatte", async () => {
    await renderSheet(makeClient());
    // Una voce pronta e una segnata: il catalogo (`sections.ts`) è l'unica
    // fonte, quindi basta verificarne due per sapere che l'indice lo legge.
    expect(screen.getByTestId("settings-row-notifications")).toBeTruthy();
    expect(screen.getByTestId("settings-row-quietHours")).toBeTruthy();
    expect(screen.getAllByText("WIP").length).toBeGreaterThan(0);
  });

  test("toccare una riga apre la sua sezione", async () => {
    const onOpenSection = jest.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={queryClient}>
        <SettingsScreen
          user={USER}
          onOpenSection={onOpenSection}
          onBack={jest.fn()}
          onLogout={jest.fn()}
          loggingOut={false}
        />
      </QueryClientProvider>,
    );
    await fireEvent.press(screen.getByTestId("settings-row-language"));
    expect(onOpenSection).toHaveBeenCalledWith("language");
  });

  test("«Esci» sta sull'indice, non sepolto in una sezione", async () => {
    await renderSheet(makeClient());
    expect(screen.getByTestId("settings-logout-button")).toBeTruthy();
  });
});

describe("SettingsScreen — Esci (logout)", () => {
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

  /**
   * Review fase 4, finding #3: le tre chiamate remote giravano in PARALLELO
   * (`Promise.allSettled`). Se `deleteToken` finiva PRIMA, un `getToken`
   * successivo poteva generare un token NUOVO — e `deleteDevice` avrebbe
   * cancellato quello SBAGLIATO, lasciando il vecchio (quello davvero
   * registrato sul server) orfano. Il fix legge il token UNA sola volta,
   * PRIMA di qualunque chiamata distruttiva, e sequenzia il resto.
   *
   * Il mock di `getToken` restituisce un valore DIVERSO alla seconda
   * chiamata (`fcm-token-nuovo-dopo-delete`) apposta: se `handleLogout`
   * richiamasse `getPushToken()`/`getToken` una seconda volta dopo
   * `deleteToken`, questo test lo scoprirebbe — `deleteDevice` riceverebbe
   * il token nuovo invece di quello vecchio già registrato.
   */
  test("ordine: deleteDevice → revoca PAT → deleteToken → clearSession, con il token letto PRIMA di deleteToken", async () => {
    mockGetToken.mockResolvedValueOnce("fcm-token-vecchio").mockResolvedValue("fcm-token-nuovo-dopo-delete");
    const order: string[] = [];
    const deleteDevice = jest.fn().mockImplementation(async (token: string) => {
      order.push(`deleteDevice:${token}`);
    });
    const patsRevoke = jest.fn().mockImplementation(async () => {
      order.push("patsRevoke");
    });
    mockDeleteToken.mockImplementation(async () => {
      order.push("deleteToken");
    });
    mockClearSession.mockImplementation(async () => {
      order.push("clearSession");
    });
    const onLoggedOut = jest.fn();
    await renderSheet(makeClient({ deleteDevice, patsRevoke }), { onLoggedOut });

    await fireEvent.press(screen.getByTestId("settings-logout-button"));

    await waitFor(() => expect(onLoggedOut).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["deleteDevice:fcm-token-vecchio", "patsRevoke", "deleteToken", "clearSession"]);
  });
});
