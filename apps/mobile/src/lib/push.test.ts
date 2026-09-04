import type { StubwiseClient } from "@stubwise/api-client";
import notifee, { EventType } from "@notifee/react-native";
import { getToken, onMessage, onTokenRefresh } from "@react-native-firebase/messaging";
import { Linking, Platform } from "react-native";
import { setupPush } from "./push";

jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Linking: { openURL: jest.fn() },
}));

const mockGetToken = getToken as jest.Mock;
const mockOnTokenRefresh = onTokenRefresh as jest.Mock;
const mockOnMessage = onMessage as jest.Mock;
const mockSetNotificationCategories = notifee.setNotificationCategories as jest.Mock;
const mockCreateChannel = notifee.createChannel as jest.Mock;
const mockOnForegroundEvent = notifee.onForegroundEvent as jest.Mock;
const mockDisplayNotification = notifee.displayNotification as jest.Mock;
const mockOpenURL = Linking.openURL as jest.Mock;

function fakeClient(): StubwiseClient {
  return {
    me: { registerDevice: jest.fn().mockResolvedValue(undefined) },
    inbox: {
      snooze: jest.fn().mockResolvedValue({ id: "n", snoozedUntil: null }),
      act: jest.fn(),
      answer: jest.fn(),
      list: jest.fn(),
    },
  } as unknown as StubwiseClient;
}

/**
 * Attende che le catene `void registerCurrentToken/registerCategories(...)`
 * fire-and-forget di `setupPush` finiscano — sono diverse `await` in
 * sequenza (token → registerDevice; categorie → un `createChannel` per
 * categoria), quindi un numero fisso di `Promise.resolve()` è fragile.
 * `setTimeout` è un MACROTASK: gira solo dopo che la coda dei microtask è
 * COMPLETAMENTE vuota, qualunque sia la sua profondità.
 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetToken.mockResolvedValue(null);
  mockOnTokenRefresh.mockReturnValue(jest.fn());
  mockOnMessage.mockReturnValue(jest.fn());
  mockOnForegroundEvent.mockReturnValue(jest.fn());
  Platform.OS = "ios";
});

describe("setupPush — registrazione del token", () => {
  test("con un token disponibile, registra il device (piattaforma + token) all'avvio", async () => {
    mockGetToken.mockResolvedValue("fcm-token-1");
    const client = fakeClient();

    const cleanup = setupPush(client);
    await flush();

    expect(client.me.registerDevice).toHaveBeenCalledWith({ platform: "ios", token: "fcm-token-1" });
    cleanup();
  });

  test("senza token (getToken → null), NON chiama registerDevice", async () => {
    mockGetToken.mockResolvedValue(null);
    const client = fakeClient();

    const cleanup = setupPush(client);
    await flush();

    expect(client.me.registerDevice).not.toHaveBeenCalled();
    cleanup();
  });

  // Mutazione da rompere apposta: se `setupPush` propagasse il rifiuto di
  // `registerDevice` invece di intercettarlo, l'eccezione non gestita
  // interromperebbe l'avvio dell'app per un problema che riguarda solo le
  // notifiche — vedi il docblock di `registerCurrentToken` in `push.ts`.
  test("un fallimento della registrazione (rete assente) non lancia — è silenzioso ma non un no-op nascosto: si logga", async () => {
    mockGetToken.mockResolvedValue("fcm-token-2");
    const client = fakeClient();
    (client.me.registerDevice as jest.Mock).mockRejectedValue(new Error("network down"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => setupPush(client)).not.toThrow();
    await flush();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("setupPush — refresh del token", () => {
  test("un nuovo token da onTokenRefresh viene registrato di nuovo (stessa piattaforma, token nuovo)", async () => {
    const client = fakeClient();
    setupPush(client);
    await flush();
    (client.me.registerDevice as jest.Mock).mockClear();

    // Il callback passato a `onTokenRefresh` è il primo argomento della
    // prima chiamata al mock — lo si invoca a mano per simulare la
    // rotazione del token del sistema operativo.
    // `onTokenRefresh(messaging, listener)`: il listener è il SECONDO
    // argomento nell'API modulare (il primo è l'istanza `Messaging`).
    const refreshHandler = mockOnTokenRefresh.mock.calls[0]?.[1] as (token: string) => void;
    refreshHandler("fcm-token-refreshed");
    await flush();

    expect(client.me.registerDevice).toHaveBeenCalledWith({ platform: "ios", token: "fcm-token-refreshed" });
  });

  test("un fallimento della registrazione al refresh non lancia (stesso trattamento della registrazione iniziale)", async () => {
    const client = fakeClient();
    setupPush(client);
    await flush();
    (client.me.registerDevice as jest.Mock).mockRejectedValueOnce(new Error("network down"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    // `onTokenRefresh(messaging, listener)`: il listener è il SECONDO
    // argomento nell'API modulare (il primo è l'istanza `Messaging`).
    const refreshHandler = mockOnTokenRefresh.mock.calls[0]?.[1] as (token: string) => void;
    expect(() => refreshHandler("fcm-token-x")).not.toThrow();
    await flush();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("il cleanup ritornato da setupPush disiscrive onTokenRefresh, onMessage e onForegroundEvent", async () => {
    const unsubscribeRefresh = jest.fn();
    const unsubscribeMessage = jest.fn();
    const unsubscribeForeground = jest.fn();
    mockOnTokenRefresh.mockReturnValue(unsubscribeRefresh);
    mockOnMessage.mockReturnValue(unsubscribeMessage);
    mockOnForegroundEvent.mockReturnValue(unsubscribeForeground);
    const client = fakeClient();

    const cleanup = setupPush(client);
    await flush();
    cleanup();

    expect(unsubscribeRefresh).toHaveBeenCalledTimes(1);
    expect(unsubscribeMessage).toHaveBeenCalledTimes(1);
    expect(unsubscribeForeground).toHaveBeenCalledTimes(1);
  });
});

describe("setupPush — categorie/canali", () => {
  test("registra le categorie iOS e un canale Android per OGNI categoria (incluso il default)", async () => {
    const client = fakeClient();
    const cleanup = setupPush(client);
    await flush();

    expect(mockSetNotificationCategories).toHaveBeenCalledTimes(1);
    const [categories] = mockSetNotificationCategories.mock.calls[0] as [{ id: string }[]];
    const ids = categories.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining(["job.awaiting_input", "job.plan_review", "project.pulse", "job.failed", "job.held", "default"]),
    );
    // Un canale Android per ogni categoria registrata su iOS: stesso insieme.
    expect(mockCreateChannel).toHaveBeenCalledTimes(categories.length);
    cleanup();
  });
});

describe("setupPush — azioni dalla notifica in primo piano", () => {
  test("un ACTION_PRESS con i dati della notifica esegue l'azione corrispondente", async () => {
    const client = fakeClient();
    const cleanup = setupPush(client);
    await flush();

    const foregroundHandler = mockOnForegroundEvent.mock.calls[0]?.[0] as (event: unknown) => void;
    foregroundHandler({
      type: EventType.ACTION_PRESS,
      detail: {
        notification: { data: { notificationId: "n1", kind: "job.awaiting_input" } },
        pressAction: { id: "snooze_1h" },
      },
    });
    await flush();

    expect(client.inbox.snooze).toHaveBeenCalledWith("n1", "1h");
    cleanup();
  });

  test("un tap semplice (PRESS, senza pressAction) apre la card", async () => {
    const client = fakeClient();
    const cleanup = setupPush(client);
    await flush();

    const foregroundHandler = mockOnForegroundEvent.mock.calls[0]?.[0] as (event: unknown) => void;
    foregroundHandler({
      type: EventType.PRESS,
      detail: { notification: { data: { notificationId: "n2", kind: "job.failed" } } },
    });
    await flush();

    expect(mockOpenURL).toHaveBeenCalledWith("stubwise://inbox/n2");
    expect(client.inbox.act).not.toHaveBeenCalled();
    cleanup();
  });

  test("un evento senza i dati custom (notifica non nostra) non chiama nulla", async () => {
    const client = fakeClient();
    const cleanup = setupPush(client);
    await flush();

    const foregroundHandler = mockOnForegroundEvent.mock.calls[0]?.[0] as (event: unknown) => void;
    foregroundHandler({ type: EventType.PRESS, detail: { notification: { data: undefined } } });
    await flush();

    expect(mockOpenURL).not.toHaveBeenCalled();
    expect(client.inbox.act).not.toHaveBeenCalled();
    cleanup();
  });

  test("un DELIVERED (o altro EventType non di interazione) non fa nulla", async () => {
    const client = fakeClient();
    const cleanup = setupPush(client);
    await flush();

    const foregroundHandler = mockOnForegroundEvent.mock.calls[0]?.[0] as (event: unknown) => void;
    foregroundHandler({
      type: EventType.DELIVERED,
      detail: { notification: { data: { notificationId: "n3", kind: "job.failed" } } },
    });
    await flush();

    expect(mockOpenURL).not.toHaveBeenCalled();
    cleanup();
  });
});

describe("setupPush — ridisegno Android in primo piano (onMessage)", () => {
  test("Android: onMessage ridisegna la notifica con canale e azioni della categoria del kind", async () => {
    Platform.OS = "android";
    const client = fakeClient();
    const cleanup = setupPush(client);
    await flush();

    const messageHandler = mockOnMessage.mock.calls[0]?.[1] as (message: unknown) => void;
    messageHandler({
      notification: { title: "Serve una risposta", body: "L'agente ha una domanda" },
      data: { notificationId: "n20", kind: "job.awaiting_input", deepLink: "stubwise://inbox/n20" },
    });
    await flush();

    expect(mockDisplayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "n20",
        title: "Serve una risposta",
        body: "L'agente ha una domanda",
        android: expect.objectContaining({
          channelId: "job.awaiting_input",
          actions: [
            expect.objectContaining({ pressAction: { id: "answer" } }),
            expect.objectContaining({ pressAction: { id: "snooze_1h" } }),
          ],
        }),
      }),
    );
    cleanup();
  });

  test("iOS: onMessage NON ridisegna nulla (il SO mostra già il banner via APNs — vedi AppDelegate)", async () => {
    Platform.OS = "ios";
    const client = fakeClient();
    const cleanup = setupPush(client);
    await flush();

    const messageHandler = mockOnMessage.mock.calls[0]?.[1] as (message: unknown) => void;
    messageHandler({
      notification: { title: "Serve una risposta", body: "L'agente ha una domanda" },
      data: { notificationId: "n21", kind: "job.awaiting_input", deepLink: "stubwise://inbox/n21" },
    });
    await flush();

    expect(mockDisplayNotification).not.toHaveBeenCalled();
    cleanup();
  });

  test("Android: un messaggio senza i dati custom (notifica non nostra) non ridisegna nulla", async () => {
    Platform.OS = "android";
    const client = fakeClient();
    const cleanup = setupPush(client);
    await flush();

    const messageHandler = mockOnMessage.mock.calls[0]?.[1] as (message: unknown) => void;
    messageHandler({ notification: { title: "t", body: "b" }, data: undefined });
    await flush();

    expect(mockDisplayNotification).not.toHaveBeenCalled();
    cleanup();
  });

  test("Android: un kind sconosciuto ridisegna comunque, con la categoria di riserva (solo Apri)", async () => {
    Platform.OS = "android";
    const client = fakeClient();
    const cleanup = setupPush(client);
    await flush();

    const messageHandler = mockOnMessage.mock.calls[0]?.[1] as (message: unknown) => void;
    messageHandler({
      notification: { title: "t", body: "b" },
      data: { notificationId: "n22", kind: "ticket.created" },
    });
    await flush();

    expect(mockDisplayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "n22",
        android: expect.objectContaining({
          channelId: "default",
          actions: [expect.objectContaining({ pressAction: { id: "open" } })],
        }),
      }),
    );
    cleanup();
  });
});
