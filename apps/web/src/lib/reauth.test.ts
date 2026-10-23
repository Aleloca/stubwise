import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { currentReauthRequest, requestReauth, settleReauth, subscribeReauth } from "./reauth";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const reauthRequired = () =>
  jsonResponse(403, { code: "reauth_required", message: "Recent confirmation required" });

const fetchMock = vi.fn<typeof fetch>();
let unsubscribe: (() => void) | null = null;
let notified: number;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  // Il «dialogo» dei test: un iscritto che conta le aperture. Senza iscritti
  // `requestReauth` risponde `false` da sola (nessun dialogo montato).
  notified = 0;
  unsubscribe = subscribeReauth(() => {
    if (currentReauthRequest()) notified += 1;
  });
});

afterEach(() => {
  // Nessuna richiesta lasciata appesa fra un test e l'altro.
  if (currentReauthRequest()) settleReauth(false);
  unsubscribe?.();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

/** Aspetta che il trasporto abbia chiesto la riconferma. */
async function waitForRequest() {
  await vi.waitFor(() => expect(currentReauthRequest()).not.toBeNull());
  return currentReauthRequest()!;
}

describe("riconferma dal client API", () => {
  it("un 403 `reauth_required` apre il dialogo e, confermato, la richiesta è ripetuta una volta", async () => {
    fetchMock
      .mockResolvedValueOnce(reauthRequired())
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = api.post("/api/pats", { name: "ci", expiresAt: null });
    expect((await waitForRequest()).reason).toBe("reauth_required");
    settleReauth(true);

    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Lo STESSO corpo, ripetuto così com'era.
    const [first, second] = fetchMock.mock.calls;
    expect(second![0]).toBe(first![0]);
    expect(second![1]?.method).toBe("POST");
    expect(second![1]?.body).toBe(JSON.stringify({ name: "ci", expiresAt: null }));
    expect(currentReauthRequest()).toBeNull();
  });

  it("annullato → l'errore originale arriva al chiamante, senza ripetere", async () => {
    fetchMock.mockResolvedValueOnce(reauthRequired());

    const result = api.delete("/api/pats/p1");
    await waitForRequest();
    settleReauth(false);

    const error = await result.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).code).toBe("reauth_required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("due richieste insieme → un dialogo, e l'esito vale per entrambe", async () => {
    fetchMock.mockImplementation(async (_input, init) =>
      fetchMock.mock.calls.length <= 2 ? reauthRequired() : jsonResponse(200, { m: init?.method }),
    );

    const a = api.post("/api/roles", { name: "a" });
    const b = api.delete("/api/pats/p1");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitForRequest();
    // Il secondo 403 è arrivato mentre il dialogo era già aperto.
    await Promise.resolve();
    expect(notified).toBe(1);
    settleReauth(true);

    await expect(a).resolves.toEqual({ m: "POST" });
    await expect(b).resolves.toEqual({ m: "DELETE" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(notified).toBe(1);
  });

  it("`second_factor_setup_required` chiede la configurazione", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { code: "second_factor_setup_required", message: "Setup required" }),
    );
    const result = api.post("/api/pats", { name: "ci", expiresAt: null });
    expect((await waitForRequest()).reason).toBe("second_factor_setup_required");
    settleReauth(false);
    await expect(result).rejects.toMatchObject({ code: "second_factor_setup_required" });
  });

  it("si ripete UNA volta: un secondo 403 arriva al chiamante senza un altro dialogo", async () => {
    fetchMock.mockImplementation(async () => reauthRequired());
    const result = api.post("/api/pats", { name: "ci", expiresAt: null });
    await waitForRequest();
    settleReauth(true);

    await expect(result).rejects.toMatchObject({ code: "reauth_required" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(notified).toBe(1);
  });

  it("le rotte della riconferma non sono mai intercettate", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { code: "second_factor_setup_required", message: "Setup required" }),
    );
    await expect(api.post("/api/me/security/reauth", { code: "123456" })).rejects.toMatchObject({
      code: "second_factor_setup_required",
    });
    expect(currentReauthRequest()).toBeNull();
    expect(notified).toBe(0);
  });

  it("gli altri 403 passano così come sono", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { code: "forbidden", message: "No" }));
    await expect(api.post("/api/roles", {})).rejects.toMatchObject({ code: "forbidden" });
    expect(notified).toBe(0);
  });

  it("senza un dialogo montato l'errore originale arriva subito", async () => {
    unsubscribe?.();
    unsubscribe = null;
    await expect(requestReauth("reauth_required")).resolves.toBe(false);
    fetchMock.mockResolvedValueOnce(reauthRequired());
    await expect(api.post("/api/pats", {})).rejects.toMatchObject({ code: "reauth_required" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
