import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as Keychain from "react-native-keychain";
import { AppProviders } from "../../app/providers";
import "../../i18n";
import { LoginScreen } from "./LoginScreen";

const navigate = jest.fn();
const fakeNavigation = { navigate } as unknown as Parameters<typeof LoginScreen>[0]["navigation"];
const fakeRoute = { key: "Login", name: "Login" as const, params: undefined };

// `render()` di @testing-library/react-native è ASINCRONO in questa
// versione (avvolge il render iniziale in `act()` e risolve solo a valle):
// senza `await` qui, `screen` resta legato al binding di default
// ("`render` function has not been called") finché la promise non si
// risolve — verificato, era la causa di OGNI fallimento intermittente di
// questo file prima di questa riga.
async function renderLogin() {
  return render(
    <AppProviders>
      <LoginScreen navigation={fakeNavigation} route={fakeRoute} />
    </AppProviders>,
  );
}

const successUser = {
  // UUID vero, non un placeholder ("user-1"): la risposta passa da
  // mobileLoginResponseSchema (via readerSchema), che valida `user.id` come
  // z.uuid() — un id "leggibile" ma non-UUID fa fallire il parse con
  // invalid_response, mascherato dietro il ramo generico "unexpected" del
  // catch (nessun testo mostrato). Trovato rompendo un test apposta.
  id: "33333333-3333-4333-8333-333333333333",
  email: "giulia@farmakom.it",
  role: "member",
  language: "it",
  avatarUrl: null,
  slackUserId: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  jest.clearAllMocks();
  (Keychain.getGenericPassword as jest.Mock).mockResolvedValue(false);
});

describe("LoginScreen", () => {
  test("mostra il form con le etichette del canvas", async () => {
    await renderLogin();
    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());

    // Le etichette sono maiuscole SOLO visivamente (textTransform: "uppercase"
    // sullo style): il testo vero nell'albero resta quello di it.json — è
    // quello, non la versione tutta maiuscola, che deve trovare `getByText`.
    expect(screen.getByText("URL dell'istanza")).toBeTruthy();
    expect(screen.getByText("Email")).toBeTruthy();
    expect(screen.getByText("Password")).toBeTruthy();
    expect(screen.getByText("Accedi")).toBeTruthy();
  });

  test("successo: chiama mobileLogin con deviceName, salva la sessione e naviga a Onboarding", async () => {
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { token: "stw_pat_abc", patId: "11111111-1111-4111-8111-111111111111", user: successUser }));
    await renderLogin();
    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("login-url"), "stubwise.example");
    await fireEvent.changeText(screen.getByTestId("login-email"), "giulia@farmakom.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "hunter2");
    await fireEvent.press(screen.getByTestId("login-submit"));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("Onboarding"));

    const [requestUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe("https://stubwise.example/api/auth/mobile-login");
    const body = JSON.parse(init.body as string) as { email: string; password: string; deviceName: string };
    expect(body).toEqual({ email: "giulia@farmakom.it", password: "hunter2", deviceName: "unknown" });

    expect(Keychain.setGenericPassword).toHaveBeenCalledTimes(1);
    const [, savedPassword] = (Keychain.setGenericPassword as jest.Mock).mock.calls[0];
    expect(JSON.parse(savedPassword)).toEqual({
      baseUrl: "https://stubwise.example",
      token: "stw_pat_abc",
      patId: "11111111-1111-4111-8111-111111111111",
      user: successUser,
    });
  });

  test("antepone https:// quando l'utente non scrive uno schema", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { token: "t", patId: "22222222-2222-4222-8222-222222222222", user: successUser }));
    await renderLogin();
    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("login-url"), "  stubwise.example/  ");
    await fireEvent.changeText(screen.getByTestId("login-email"), "a@b.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "x");
    await fireEvent.press(screen.getByTestId("login-submit"));

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const [, savedPassword] = (Keychain.setGenericPassword as jest.Mock).mock.calls[0];
    expect(JSON.parse(savedPassword).baseUrl).toBe("https://stubwise.example");
  });

  test("401: mostra 'Credenziali non valide', NON naviga e NON salva nulla", async () => {
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(401, { code: "invalid_credentials", message: "Invalid credentials" }));
    await renderLogin();
    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("login-url"), "stubwise.example");
    await fireEvent.changeText(screen.getByTestId("login-email"), "giulia@farmakom.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "wrong");
    await fireEvent.press(screen.getByTestId("login-submit"));

    await waitFor(() => expect(screen.getByText("Credenziali non valide")).toBeTruthy());
    expect(navigate).not.toHaveBeenCalled();
    expect(Keychain.setGenericPassword).not.toHaveBeenCalled();
  });

  test("istanza irraggiungibile: mostra lo stato dedicato con Riprova, non l'errore di credenziali", async () => {
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Network request failed"));
    await renderLogin();
    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("login-url"), "stubwise.example");
    await fireEvent.changeText(screen.getByTestId("login-email"), "giulia@farmakom.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "hunter2");
    await fireEvent.press(screen.getByTestId("login-submit"));

    await waitFor(() => expect(screen.getByText("Riprova")).toBeTruthy());
    expect(screen.queryByText("Credenziali non valide")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  // Il ramo "unexpected" (status diverso da 401 e da 0 — qui: 200 con un
  // body che non passa mobileLoginResponseSchema) era rimasto MUTO fino a
  // che non l'ho scoperto rompendo un test per un altro motivo (fixture
  // "u1" al posto di un UUID vero — vedi il commento su `successUser`
  // sopra). Riuso lo stesso meccanismo apposta: un `user.id` non-UUID fa
  // fallire il parse lato client con ApiError status 200/invalid_response,
  // che LoginScreen deve mostrare con un messaggio, non ignorare in
  // silenzio.
  test("risposta inattesa (200 ma non valida lo schema): mostra un errore generico, NON naviga", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        token: "stw_pat_x",
        patId: "77777777-7777-4777-8777-777777777777",
        user: { ...successUser, id: "non-e-un-uuid" },
      }),
    );
    await renderLogin();
    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("login-url"), "stubwise.example");
    await fireEvent.changeText(screen.getByTestId("login-email"), "giulia@farmakom.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "hunter2");
    await fireEvent.press(screen.getByTestId("login-submit"));

    await waitFor(() => expect(screen.getByText("Qualcosa è andato storto. Riprova.")).toBeTruthy());
    expect(navigate).not.toHaveBeenCalled();
    expect(Keychain.setGenericPassword).not.toHaveBeenCalled();
  });

  test("Riprova rilancia la stessa richiesta di login", async () => {
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValueOnce(jsonResponse(200, { token: "t", patId: "22222222-2222-4222-8222-222222222222", user: successUser }));
    await renderLogin();
    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("login-url"), "stubwise.example");
    await fireEvent.changeText(screen.getByTestId("login-email"), "giulia@farmakom.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "hunter2");
    await fireEvent.press(screen.getByTestId("login-submit"));
    await waitFor(() => expect(screen.getByText("Riprova")).toBeTruthy());

    await fireEvent.press(screen.getByText("Riprova"));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("Onboarding"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // Mutazione da rompere apposta: se resolveDeviceName() lasciasse propagare
  // il rifiuto di getDeviceName() invece di ripiegare su Platform+modello,
  // un device che nega quel permesso non riuscirebbe MAI a fare login.
  test("se DeviceInfo.getDeviceName() fallisce, usa il fallback Platform+modello e il login funziona comunque", async () => {
    const deviceInfo = jest.requireMock("react-native-device-info") as {
      getDeviceName: jest.Mock;
      getModel: jest.Mock;
    };
    deviceInfo.getDeviceName.mockRejectedValueOnce(new Error("permesso negato"));
    deviceInfo.getModel.mockReturnValue("iPhone15,3");

    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { token: "t", patId: "22222222-2222-4222-8222-222222222222", user: successUser }));
    await renderLogin();
    await waitFor(() => expect(screen.getByTestId("login-url")).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId("login-url"), "stubwise.example");
    await fireEvent.changeText(screen.getByTestId("login-email"), "giulia@farmakom.it");
    await fireEvent.changeText(screen.getByTestId("login-password"), "hunter2");
    await fireEvent.press(screen.getByTestId("login-submit"));

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { deviceName: string };
    expect(body.deviceName).toContain("iPhone15,3");
  });
});
