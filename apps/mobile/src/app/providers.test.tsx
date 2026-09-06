import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import notifee from "@notifee/react-native";
import NetInfo from "@react-native-community/netinfo";
import { AppState, Text } from "react-native";
import "../i18n";
import { createClient, onSessionExpired } from "../lib/client";
import { setupPush } from "../lib/push";
import { getLastSyncAt, loadSession } from "../lib/storage";
import { AppProviders } from "./providers";

jest.mock("../lib/storage", () => ({
  loadSession: jest.fn(),
  saveSession: jest.fn(),
  // Task 20: `AppProviders` ora legge/scrive anche queste due (banner
  // offline globale) a OGNI render — senza mockarle qui, ogni test di
  // QUESTO file (non solo quelli nuovi sotto) romperebbe su
  // "getLastSyncAt is not a function" al primo effect.
  getLastSyncAt: jest.fn().mockResolvedValue(null),
  setLastSyncAt: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../lib/client", () => ({
  createClient: jest.fn(),
  onSessionExpired: jest.fn(() => jest.fn()),
}));

// `setupPush` (lib/push.ts) è testata a fondo per conto suo in
// push.test.ts: qui interessa SOLO che `AppProviders` la chiami col client
// giusto quando lo stato diventa autenticato, e che ne disiscriva il
// cleanup quando smette di esserlo — non rifare gli stessi test.
jest.mock("../lib/push", () => ({
  setupPush: jest.fn(() => jest.fn()),
}));

const mockLoadSession = loadSession as jest.Mock;
const mockCreateClient = createClient as jest.Mock;
const mockOnSessionExpired = onSessionExpired as jest.Mock;
const mockSetupPush = setupPush as jest.Mock;
const mockAddEventListener = AppState.addEventListener as jest.Mock;
const mockSetBadgeCount = notifee.setBadgeCount as jest.Mock;

const session = {
  baseUrl: "https://stubwise.example",
  token: "stw_pat_x",
  patId: "pat-1",
  user: { id: "u1", email: "giulia@farmakom.it", role: "member", language: "it", avatarUrl: null, slackUserId: null },
};

function fakeClient(unreadCount = 0) {
  return {
    inbox: { unreadCount: jest.fn().mockResolvedValue({ count: unreadCount }) },
    me: {},
  };
}

/** L'ascoltatore `"change"` registrato più di recente su `AppState`. */
function latestChangeListener(): ((status: string) => void) | undefined {
  const call = [...mockAddEventListener.mock.calls].reverse().find(([event]) => event === "change");
  return call?.[1] as ((status: string) => void) | undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAddEventListener.mockReturnValue({ remove: jest.fn() });
  mockSetupPush.mockImplementation(() => jest.fn());
});

describe("AppProviders — badge OS al foreground", () => {
  test("una transizione AppState → 'active' aggiorna il badge OS dal contatore non letto", async () => {
    mockLoadSession.mockResolvedValue(session);
    mockCreateClient.mockReturnValue(fakeClient(5));

    await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );
    await waitFor(() => expect(mockAddEventListener).toHaveBeenCalledWith("change", expect.any(Function)));

    const listener = latestChangeListener();
    listener?.("active");

    await waitFor(() => expect(mockSetBadgeCount).toHaveBeenCalledWith(5));
  });

  // Mutazione da rompere apposta: se il guardiano `next === "active"` sparisse,
  // OGNI transizione (anche verso "background"/"inactive") aggiornerebbe il
  // badge — innocuo di per sé, ma sveste il senso di "AL FOREGROUND" del
  // design doc e farebbe una richiesta di rete a ogni cambio di stato.
  test("una transizione verso 'background' NON aggiorna il badge", async () => {
    mockLoadSession.mockResolvedValue(session);
    mockCreateClient.mockReturnValue(fakeClient(7));

    await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );
    await waitFor(() => expect(mockAddEventListener).toHaveBeenCalledWith("change", expect.any(Function)));

    const listener = latestChangeListener();
    listener?.("background");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mockSetBadgeCount).not.toHaveBeenCalled();
  });

  test("un fallimento di rete su unreadCount non lancia e non aggiorna il badge (si riprova al prossimo giro) — ma si logga (review fase 4, finding #4)", async () => {
    mockLoadSession.mockResolvedValue(session);
    const client = fakeClient();
    (client.inbox.unreadCount as jest.Mock).mockRejectedValue(new Error("network down"));
    mockCreateClient.mockReturnValue(client);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );
    await waitFor(() => expect(mockAddEventListener).toHaveBeenCalledWith("change", expect.any(Function)));

    const listener = latestChangeListener();
    expect(() => listener?.("active")).not.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mockSetBadgeCount).not.toHaveBeenCalled();
    // Un badge che smette di aggiornarsi senza che NESSUNO ne veda traccia è
    // lo stesso guasto (silenzioso, difficile da diagnosticare) già evitato
    // altrove nell'app (`lib/push.ts`) — il catch qui non deve restare vuoto.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("nessun client (non autenticato): AppState non viene ascoltato per il badge", async () => {
    mockLoadSession.mockResolvedValue(null);

    await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );
    await waitFor(() => expect(mockLoadSession).toHaveBeenCalled());

    expect(mockAddEventListener).not.toHaveBeenCalledWith("change", expect.any(Function));
  });
});

/**
 * Review fase 4, finding #2: una push ricevuta in primo piano deve
 * aggiornare inbox e badge, con la STESSA funzione del refresh al
 * foreground — non due implementazioni indipendenti. `onPushReceived` è il
 * secondo argomento con cui `AppProviders` chiama `setupPush` (verificato
 * sopra, "collegamento con setupPush"): qui si invoca quella callback
 * direttamente e si osserva che produce esattamente l'effetto del
 * foreground (badge + `refetchQueries` sull'inbox), non un percorso
 * separato che potrebbe divergere.
 *
 * Mutazione da rompere apposta: se `push.ts` smettesse di chiamare
 * `onPushReceived` (o se `providers.tsx` passasse `undefined`/una funzione
 * vuota invece di `refreshInboxAndBadge`), `mockSetBadgeCount` non
 * verrebbe mai chiamato da questo test — a differenza del test "al
 * foreground" sopra, che passa comunque perché usa `AppState`, non
 * `setupPush`.
 */
describe("AppProviders — una push in primo piano riusa lo stesso refresh del foreground", () => {
  test("invocare onPushReceived aggiorna il badge (stessa funzione del foreground, non un percorso separato)", async () => {
    mockLoadSession.mockResolvedValue(session);
    mockCreateClient.mockReturnValue(fakeClient(3));

    const { unmount } = await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );
    await waitFor(() => expect(mockSetupPush).toHaveBeenCalledWith(expect.anything(), expect.any(Function)));

    // `onPushReceived` è il secondo argomento con cui `AppProviders` chiama
    // `setupPush` — invocarlo a mano simula una push ricevuta.
    const onPushReceived = mockSetupPush.mock.calls[0]?.[1] as () => void;
    await act(async () => {
      onPushReceived();
    });

    // `mockSetBadgeCount` può essere chiamato SOLO da `refreshBadge` dentro
    // `refreshInboxAndBadge`: se questo test lo osserva a fronte della sola
    // `onPushReceived()` (nessuna transizione `AppState`), è la prova che
    // `push.ts` la chiama davvero e che è la STESSA funzione del foreground,
    // non un percorso separato che potrebbe divergere o mancare.
    await waitFor(() => expect(mockSetBadgeCount).toHaveBeenCalledWith(3));

    unmount();
  });
});

describe("AppProviders — intervallo di refresh (60s)", () => {
  /**
   * Verifica che il timer non sopravviva allo smontaggio, senza dipendere da
   * fake timer (fragili sotto contesa CPU su questa macchina): si confronta
   * l'id ritornato da `setInterval` con quello passato a `clearInterval` nel
   * cleanup. `setInterval` viene chiamato anche da React stesso per il
   * proprio scheduler interno (con un delay diverso, verificato: `50`, non
   * `60000`) — si isola quindi la chiamata di INTERESSE per delay.
   *
   * ⚠️ Il cleanup degli effect passivi di React NON è garantito sincrono con
   * `unmount()`: senza il giro di microtask sotto, la chiamata a
   * `clearInterval` potrebbe non essere ancora avvenuta quando si legge
   * `clearIntervalSpy.mock.calls` — verificato (falso negativo senza
   * quest'attesa).
   */
  test("l'intervallo (60s) registrato viene ripulito allo smontaggio", async () => {
    mockLoadSession.mockResolvedValue(session);
    mockCreateClient.mockReturnValue(fakeClient());
    const setIntervalSpy = jest.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = jest.spyOn(globalThis, "clearInterval");

    const { unmount } = await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );
    await waitFor(() => expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000));
    const callIndex = setIntervalSpy.mock.calls.findIndex((call) => call[1] === 60_000);
    const intervalId = setIntervalSpy.mock.results[callIndex]?.value;

    unmount();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});

describe("AppProviders — collegamento con setupPush (lib/push.ts)", () => {
  test("setupPush viene chiamata con LO STESSO client quando lo stato diventa 'authenticated'", async () => {
    mockLoadSession.mockResolvedValue(session);
    const client = fakeClient();
    mockCreateClient.mockReturnValue(client);

    await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );

    await waitFor(() => expect(mockSetupPush).toHaveBeenCalledWith(client, expect.any(Function)));
  });

  test("nessun client (non autenticato): setupPush non viene mai chiamata", async () => {
    mockLoadSession.mockResolvedValue(null);

    await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );
    await waitFor(() => expect(mockLoadSession).toHaveBeenCalled());

    expect(mockSetupPush).not.toHaveBeenCalled();
  });

  /**
   * Mutazione da rompere apposta (le stesse due verificate in revisione):
   * (a) togliere la chiamata a `setupPush(state.client)` dall'effetto in
   * `providers.tsx` fa fallire il test sopra; (b) togliere SOLO il `return`
   * davanti a quella chiamata (cleanup mai collegato all'effetto) fa fallire
   * QUESTO test, perché la funzione di cleanup ritornata da `setupPush` non
   * verrebbe più invocata da React alla transizione d'effetto.
   */
  test("il cleanup ritornato da setupPush viene invocato quando la sessione scade (401 → unauthenticated)", async () => {
    mockLoadSession.mockResolvedValue(session);
    const client = fakeClient();
    mockCreateClient.mockReturnValue(client);
    const unsubscribePush = jest.fn();
    mockSetupPush.mockReturnValue(unsubscribePush);

    await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );
    await waitFor(() => expect(mockSetupPush).toHaveBeenCalledWith(client, expect.any(Function)));
    expect(unsubscribePush).not.toHaveBeenCalled();

    // `onSessionExpired(listener)` — il listener è il solo argomento della
    // prima chiamata al mock: lo si invoca a mano per simulare un 401
    // (`lib/client.ts`), che porta lo stato a `unauthenticated`.
    const sessionExpiredListener = mockOnSessionExpired.mock.calls[0]?.[0] as () => void;
    await act(async () => {
      sessionExpiredListener();
    });

    await waitFor(() => expect(unsubscribePush).toHaveBeenCalledTimes(1));
  });

  test("il cleanup ritornato da setupPush viene invocato anche al semplice smontaggio", async () => {
    mockLoadSession.mockResolvedValue(session);
    mockCreateClient.mockReturnValue(fakeClient());
    const unsubscribePush = jest.fn();
    mockSetupPush.mockReturnValue(unsubscribePush);

    const { unmount } = await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );
    await waitFor(() => expect(mockSetupPush).toHaveBeenCalledTimes(1));

    unmount();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(unsubscribePush).toHaveBeenCalledTimes(1);
  });
});

describe("AppProviders — chrome globale (Task 20: avatar → Impostazioni, banner offline)", () => {
  test("il bottone Impostazioni (avatar) compare da autenticato", async () => {
    mockLoadSession.mockResolvedValue(session);
    mockCreateClient.mockReturnValue(fakeClient());

    await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );

    await waitFor(() => expect(screen.getByTestId("settings-avatar-button")).toBeTruthy());
  });

  // Accessibilità: l'avatar è SOLO glifo (l'iniziale dell'email) — senza
  // `accessibilityLabel` uno screen reader lo leggerebbe come una lettera
  // sciolta, non come "apri le Impostazioni".
  test("il bottone Impostazioni ha un accessibilityLabel (è solo glifo: l'iniziale dell'email)", async () => {
    mockLoadSession.mockResolvedValue(session);
    mockCreateClient.mockReturnValue(fakeClient());

    await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );

    await waitFor(() => {
      const button = screen.getByTestId("settings-avatar-button");
      expect(button.props.accessibilityLabel).toBe("Impostazioni");
      expect(button.props.accessibilityRole).toBe("button");
    });
  });

  test("nessun bottone Impostazioni prima del login (non autenticato)", async () => {
    mockLoadSession.mockResolvedValue(null);

    await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );
    await waitFor(() => expect(mockLoadSession).toHaveBeenCalled());

    expect(screen.queryByTestId("settings-avatar-button")).toBeNull();
  });

  test("il banner offline globale compare quando NetInfo segnala offline, su QUALSIASI schermo (non solo l'Inbox)", async () => {
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
    mockLoadSession.mockResolvedValue(session);
    mockCreateClient.mockReturnValue(fakeClient());

    await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );

    await waitFor(() => expect(screen.getByText(/Offline/)).toBeTruthy());
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
  });

  test("toccare l'avatar apre la sheet Impostazioni (Esci diventa raggiungibile)", async () => {
    mockLoadSession.mockResolvedValue(session);
    mockCreateClient.mockReturnValue(fakeClient());

    await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );
    await waitFor(() => expect(screen.getByTestId("settings-avatar-button")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("settings-avatar-button"));

    await waitFor(() => expect(screen.getByTestId("settings-logout-button")).toBeTruthy());
  });

  test("lastSyncAt: il banner lo rilegge da AsyncStorage (getLastSyncAt) quando compare offline", async () => {
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
    (getLastSyncAt as jest.Mock).mockResolvedValue("2026-09-02T09:00:00.000Z");
    mockLoadSession.mockResolvedValue(session);
    mockCreateClient.mockReturnValue(fakeClient());

    await render(
      <AppProviders>
        <Text>ok</Text>
      </AppProviders>,
    );

    await waitFor(() => expect(getLastSyncAt).toHaveBeenCalled());
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
  });
});
