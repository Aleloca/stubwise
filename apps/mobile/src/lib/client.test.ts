import { createClient, createClientFromSession, onSessionExpired } from "./client";
import { clearSession, loadSession } from "./storage";

jest.mock("./storage", () => ({
  loadSession: jest.fn(),
  clearSession: jest.fn(),
}));

const mockLoadSession = loadSession as jest.Mock;
const mockClearSession = clearSession as jest.Mock;

const session = {
  baseUrl: "https://stubwise.example",
  token: "stw_pat_abc123",
  patId: "pat-1",
  user: { id: "u1", email: "a@b.it", role: "member", language: "it", avatarUrl: null, slackUserId: null },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadSession.mockResolvedValue(null);
});

describe("createClient", () => {
  test("manda le richieste con la baseUrl data e nessun header prima del login", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { needed: true }));
    const client = createClient("https://stubwise.example");

    await client.auth.setupStatus();

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://stubwise.example/api/auth/setup",
      expect.objectContaining({ headers: expect.not.objectContaining({ authorization: expect.anything() }) }),
    );
  });

  test("legge il token dal Keychain (via loadSession) a ogni richiesta", async () => {
    mockLoadSession.mockResolvedValue(session);
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { needed: false }));
    const client = createClient("https://stubwise.example");

    await client.auth.setupStatus();

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer stw_pat_abc123" }) }),
    );
  });

  test("su 401 pulisce la sessione ed emette session:expired, poi propaga comunque l'errore", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "invalid_credentials", message: "Invalid credentials" }), {
        status: 401,
      }),
    );
    const listener = jest.fn();
    const unsubscribe = onSessionExpired(listener);
    const client = createClient("https://stubwise.example");

    await expect(client.auth.setupStatus()).rejects.toMatchObject({ status: 401 });

    expect(mockClearSession).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  // Mutazione da rompere apposta: se il wrapper reagisse solo a status !== 200
  // invece che === 401, un normale 404 applicativo (non un problema di
  // sessione) svuoterebbe il Keychain e disconnetterebbe l'utente per errore.
  test("un errore diverso da 401 NON tocca la sessione", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(404, { code: "not_found", message: "Not found" }));
    const listener = jest.fn();
    const unsubscribe = onSessionExpired(listener);
    const client = createClient("https://stubwise.example");

    await expect(client.auth.setupStatus()).rejects.toMatchObject({ status: 404 });

    expect(mockClearSession).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  test("un ascoltatore disiscritto non riceve più l'evento", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
    const listener = jest.fn();
    const unsubscribe = onSessionExpired(listener);
    unsubscribe();
    const client = createClient("https://stubwise.example");

    await expect(client.auth.setupStatus()).rejects.toBeDefined();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("createClientFromSession", () => {
  test("ritorna null quando non c'è nessuna sessione salvata", async () => {
    mockLoadSession.mockResolvedValue(null);

    await expect(createClientFromSession()).resolves.toBeNull();
  });

  test("costruisce il client sulla baseUrl della sessione salvata", async () => {
    mockLoadSession.mockResolvedValue(session);
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { needed: false }));

    const client = await createClientFromSession();
    expect(client).not.toBeNull();
    await client?.auth.setupStatus();

    expect(fetchSpy).toHaveBeenCalledWith("https://stubwise.example/api/auth/setup", expect.anything());
  });
});
