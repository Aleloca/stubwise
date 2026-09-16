import type { StubwiseClient } from "@stubwise/api-client";
import type { Reader, SessionUser } from "@stubwise/shared";
import { getToken } from "@react-native-firebase/messaging";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import i18n from "../../i18n";
import "../../i18n";
import { clearSession, loadSession } from "../../lib/storage";
import { SettingsSectionScreen } from "./SettingsSectionScreen";

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
  opts: { user?: Reader<SessionUser>; onBack?: jest.Mock; section?: "profile" | "notifications" | "instance" | "language" | "mailboxes" } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onBack = opts.onBack ?? jest.fn();
  const rendered = await render(
    <QueryClientProvider client={queryClient}>
      <SettingsSectionScreen
        section={opts.section ?? "notifications"}
        onBack={onBack}
        client={client}
        user={opts.user ?? USER}
      />
    </QueryClientProvider>,
  );
  return { ...rendered, onBack };
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

describe("SettingsSectionScreen — profilo", () => {
  test("mostra l'email e il ruolo (Operatore per member)", async () => {
    await renderSheet(makeClient(), { section: "profile" });
    expect(screen.getByText("giulia@farmakom.it")).toBeTruthy();
    expect(screen.getByText("Operatore")).toBeTruthy();
  });

  test("mostra 'Admin' per un ruolo admin", async () => {
    await renderSheet(makeClient(), { user: ADMIN_USER, section: "profile" });
    expect(screen.getByText("Admin")).toBeTruthy();
  });

  test("il tasto indietro dell'intestazione chiama onBack", async () => {
    // Era «toccare lo sfondo»: una PAGINA non ha uno sfondo da toccare, ha un
    // indietro — lo stesso `screen-header-back` di ogni altro dettaglio.
    const onBack = jest.fn();
    await renderSheet(makeClient(), { onBack });
    await fireEvent.press(screen.getByTestId("screen-header-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test("l'avatar NON compare: questa è la pagina a cui l'avatar porta", async () => {
    await renderSheet(makeClient());
    expect(screen.queryByTestId("settings-avatar-button")).toBeNull();
  });
});

describe("SettingsSectionScreen — notifiche push", () => {
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

  // Query fallita (non la mutazione): niente switch bloccato senza spiegazione
  // — un messaggio + un modo di riprovare, sullo stesso modello già stabilito
  // da InboxScreen/ProjectDetailScreen (`isError` → titolo/testo + retry).
  test("me.notificationPrefs() fallita: messaggio + retry al posto dell'interruttore", async () => {
    const notificationPrefs = jest.fn().mockRejectedValue(new Error("network down"));
    await renderSheet(makeClient({ notificationPrefs }));

    await waitFor(() => expect(screen.getByTestId("settings-push-error")).toBeTruthy());
    expect(screen.queryByTestId("settings-push-switch")).toBeNull();

    notificationPrefs.mockResolvedValue({ push: true, slackDm: false, slackLinked: false });
    await fireEvent.press(screen.getByTestId("settings-push-retry"));
    await waitFor(() => expect(screen.getByTestId("settings-push-switch")).toBeTruthy());
  });

  // Mutazione fallita (non la query): lo switch "scatta indietro" da solo
  // (pilotato dal valore invariato di `prefsQuery.data`, nessuno stato
  // ottimistico) — SENZA il testo sotto, l'utente non avrebbe alcun modo di
  // sapere perché. Stesso principio "mai silenzioso" già applicato al
  // logout in questo file.
  test("setNotificationPrefs() fallita: messaggio visibile, il valore resta quello del server", async () => {
    const setNotificationPrefs = jest.fn().mockRejectedValue(new Error("network down"));
    await renderSheet(makeClient({ setNotificationPrefs }));
    await waitFor(() => expect(screen.getByTestId("settings-push-switch")).toBeTruthy());

    await fireEvent(screen.getByTestId("settings-push-switch"), "valueChange", false);

    await waitFor(() => expect(screen.getByTestId("settings-push-mutation-error")).toBeTruthy());
    // Nessuno stato ottimistico: il valore mostrato resta quello letto dalla
    // GET (true), non il `false` mai confermato dal server.
    expect(screen.getByTestId("settings-push-switch").props.value).toBe(true);
  });
});

describe("SettingsSectionScreen — progetti seguiti", () => {
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

  // Query fallita (projects.list): niente elenco muto — messaggio + retry,
  // che rilancia ENTRAMBE le query della sezione (progetti E follow).
  test("projects.list() fallita: messaggio + retry al posto dell'elenco", async () => {
    const projectsList = jest.fn().mockRejectedValue(new Error("network down"));
    await renderSheet(makeClient({ projectsList }));

    await waitFor(() => expect(screen.getByTestId("settings-projects-error")).toBeTruthy());
    expect(screen.queryByLabelText("Farmakom")).toBeNull();

    projectsList.mockResolvedValue([PROJECT_A, PROJECT_B]);
    await fireEvent.press(screen.getByTestId("settings-projects-retry"));
    await waitFor(() => expect(screen.getByLabelText("Farmakom")).toBeTruthy());
  });

  // Mutazione fallita: stesso principio del push — il toggle torna da solo
  // al valore del server, e senza il testo sotto nessuno spiegherebbe perché.
  test("setFollows() fallita: messaggio visibile, l'insieme resta quello del server", async () => {
    const setFollows = jest.fn().mockRejectedValue(new Error("network down"));
    await renderSheet(makeClient({ setFollows }));
    await waitFor(() => expect(screen.getByLabelText("Audin")).toBeTruthy());

    await fireEvent(screen.getByLabelText("Audin"), "valueChange", true);

    await waitFor(() => expect(screen.getByTestId("settings-follows-mutation-error")).toBeTruthy());
    // Nessuno stato ottimistico: "Audin" resta non seguito (il PUT non è mai
    // stato confermato dal server).
    expect(screen.getByLabelText("Audin").props.value).toBe(false);
  });
});

describe("SettingsSectionScreen — istanza (server + lingua)", () => {
  test("mostra l'host del server, sola lettura", async () => {
    await renderSheet(makeClient(), { section: "instance" });
    await waitFor(() => expect(screen.getByText("stubwise.farmakom.it")).toBeTruthy());
  });

  test("scegliere 'English' persiste la lingua sul server E la applica subito in locale", async () => {
    const setLanguage = jest.fn().mockResolvedValue({ language: "en" });
    await renderSheet(makeClient({ setLanguage }), { section: "instance" });
    await fireEvent.press(screen.getByTestId("settings-language-en"));
    await waitFor(() => expect(setLanguage).toHaveBeenCalledWith("en"));
    await waitFor(() => expect(i18n.language).toBe("en"));
  });

  // Mutazione fallita: `i18n.changeLanguage` gira SOLO in `onSuccess`, quindi
  // un fallimento del server non deve MAI applicare la lingua in locale — ma
  // senza il testo sotto l'utente non avrebbe alcun segnale del perché il
  // tap su "English" non ha avuto effetto.
  test("client.auth.setLanguage() fallita: messaggio visibile, la lingua locale NON cambia", async () => {
    const setLanguage = jest.fn().mockRejectedValue(new Error("network down"));
    await renderSheet(makeClient({ setLanguage }), { section: "instance" });

    await fireEvent.press(screen.getByTestId("settings-language-en"));

    await waitFor(() => expect(screen.getByTestId("settings-language-mutation-error")).toBeTruthy());
    expect(i18n.language).toBe("it");
  });
});


describe("SettingsSectionScreen — accessibilità", () => {
  test("i bottoni/controlli con solo glifo hanno un accessibilityLabel", async () => {
    // Il backdrop senza testo non c'è più (era della sheet), e dal 16 set 2026
    // i due controlli vivono in SEZIONI diverse: si verificano dove stanno.
    await renderSheet(makeClient(), { section: "notifications" });
    await waitFor(() => expect(screen.getByTestId("settings-push-switch").props.accessibilityLabel).toBeTruthy());

    await renderSheet(makeClient(), { section: "instance" });
    expect(screen.getByTestId("settings-language-it").props.accessibilityRole).toBe("radio");
    expect(screen.getByTestId("settings-language-en").props.accessibilityRole).toBe("radio");
  });
});
