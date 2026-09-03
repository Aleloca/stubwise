import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Keychain from "react-native-keychain";
import { clearSession, getLastSyncAt, loadSession, saveSession, setLastSyncAt } from "./storage";

const session = {
  baseUrl: "https://stubwise.example",
  token: "stw_pat_abc123",
  patId: "pat-1",
  user: {
    id: "user-1",
    email: "giulia@farmakom.it",
    role: "member" as const,
    language: "it" as const,
    avatarUrl: null,
    slackUserId: null,
  },
};

beforeEach(async () => {
  jest.clearAllMocks();
  // Il mock ufficiale di AsyncStorage è un singleton in-memory (non uno
  // jest.fn()): jest.clearAllMocks() non lo tocca, va svuotato a mano perché
  // i test su lastSyncAt non dipendano dall'ordine di esecuzione.
  await AsyncStorage.clear();
});

describe("saveSession / loadSession / clearSession", () => {
  test("saveSession scrive nel Keychain un blob JSON sotto il service dell'app", async () => {
    await saveSession(session);

    expect(Keychain.setGenericPassword).toHaveBeenCalledTimes(1);
    const [username, password, options] = (Keychain.setGenericPassword as jest.Mock).mock.calls[0];
    expect(typeof username).toBe("string");
    expect(JSON.parse(password)).toEqual(session);
    expect(options).toMatchObject({ service: "com.app.aleloca.stubwise.session" });
  });

  test("loadSession ritorna la sessione salvata (round trip)", async () => {
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
      username: "stubwise-session",
      password: JSON.stringify(session),
      service: "com.app.aleloca.stubwise.session",
      storage: "keychain",
    });

    await expect(loadSession()).resolves.toEqual(session);
  });

  test("loadSession ritorna null quando il Keychain non ha nulla", async () => {
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue(false);

    await expect(loadSession()).resolves.toBeNull();
  });

  // Mutazione da rompere apposta: se loadSession() lasciasse propagare
  // l'eccezione di JSON.parse invece di intercettarla, un Keychain corrotto
  // farebbe crashare l'avvio dell'app invece di riportare "nessuna sessione".
  test("loadSession ritorna null (non lancia) su un blob non-JSON", async () => {
    (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({
      username: "stubwise-session",
      password: "{ non è json",
      service: "com.app.aleloca.stubwise.session",
      storage: "keychain",
    });

    await expect(loadSession()).resolves.toBeNull();
  });

  test("clearSession cancella la voce del Keychain per il service dell'app", async () => {
    await clearSession();

    expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({
      service: "com.app.aleloca.stubwise.session",
    });
  });
});

describe("lastSyncAt (AsyncStorage)", () => {
  test("getLastSyncAt ritorna null prima di ogni sincronizzazione", async () => {
    await expect(getLastSyncAt()).resolves.toBeNull();
  });

  test("setLastSyncAt poi getLastSyncAt ritorna lo stesso valore", async () => {
    await setLastSyncAt("2026-09-03T10:00:00.000Z");
    await expect(getLastSyncAt()).resolves.toBe("2026-09-03T10:00:00.000Z");
  });

  test("setLastSyncAt scrive sotto una chiave dedicata di AsyncStorage", async () => {
    await setLastSyncAt("2026-09-03T10:00:00.000Z");
    await expect(AsyncStorage.getItem("stubwise:lastSyncAt")).resolves.toBe("2026-09-03T10:00:00.000Z");
  });
});
