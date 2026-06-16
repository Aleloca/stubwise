import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, getMe, getSetupStatus, postLogin, postLogout, postSetup } from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("api", () => {
  it("get: restituisce il body JSON parsato", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { needed: true }));

    await expect(api.get("/api/auth/setup")).resolves.toEqual({ needed: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/setup",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("post: serializza il body e imposta il content-type", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

    await api.post("/api/things", { name: "x" });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ name: "x" }));
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });

  it("post senza body: non manda body né content-type", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await api.post("/api/auth/logout");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  it("204: risolve senza tentare il parse del body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(api.post("/api/auth/logout")).resolves.toBeUndefined();
  });

  it("errore con body JSON: lancia ApiError con status e message del server", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { message: "Credenziali non valide" }));

    const error = await api.get("/api/auth/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe("Credenziali non valide");
  });

  it("errore senza body JSON: lancia ApiError con messaggio di fallback", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    const error = await api.get("/api/auth/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
    expect((error as ApiError).message).toBe("Error 500");
  });

  it("errore di rete (TypeError): lancia ApiError con status 0, code e messaggio dedicato", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const error = await api.get("/api/auth/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).code).toBe("network_error");
    expect((error as ApiError).message).toBe("Unable to reach the server");
  });

  it("errore non di rete (es. abort): riemerge senza essere incapsulato", async () => {
    const abort = new DOMException("annullata", "AbortError");
    fetchMock.mockRejectedValue(abort);

    await expect(api.get("/api/auth/me")).rejects.toBe(abort);
  });

  it("patch: usa il metodo PATCH", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await api.patch("/api/tickets/1", { status: "done" });

    expect(fetchMock.mock.calls[0]![1]?.method).toBe("PATCH");
  });
});

describe("funzioni auth", () => {
  it("getMe: GET /api/auth/me", async () => {
    const user = { id: "u1", email: "a@b.it", role: "admin" };
    fetchMock.mockResolvedValue(jsonResponse(200, { user }));

    await expect(getMe()).resolves.toEqual({ user });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/me");
  });

  it("getSetupStatus: GET /api/auth/setup", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { needed: false }));

    await expect(getSetupStatus()).resolves.toEqual({ needed: false });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/setup");
  });

  it("postLogin: POST /api/auth/login con le credenziali", async () => {
    const user = { id: "u1", email: "a@b.it", role: "member" };
    fetchMock.mockResolvedValue(jsonResponse(200, { user }));

    await expect(postLogin({ email: "a@b.it", password: "pw" })).resolves.toEqual({ user });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/login");
    expect(init?.body).toBe(JSON.stringify({ email: "a@b.it", password: "pw" }));
  });

  it("postSetup: POST /api/auth/setup con le credenziali", async () => {
    const user = { id: "u1", email: "a@b.it", role: "admin" };
    fetchMock.mockResolvedValue(jsonResponse(201, { user }));

    await expect(postSetup({ email: "a@b.it", password: "password1" })).resolves.toEqual({
      user,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/setup");
  });

  it("postLogout: POST /api/auth/logout, risolve su 204", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(postLogout()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/logout");
  });
});
