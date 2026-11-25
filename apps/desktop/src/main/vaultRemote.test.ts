// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createVaultRemote } from "./vaultRemote";

// Lotto 10 (72, la forma delle rotte del sigillo): le tre rotte del PAT
// desktop, chiamate dal main col suo token. Il token non esce dal main.

const BASE = "https://stubwise.example";
const DEVICE = "dddddddd-0000-4000-8000-000000000001";
const PERSON_KEY = "eeeeeeee-0000-4000-8000-000000000001";

function remote(respond: (url: string, init: RequestInit) => Response) {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    respond(String(url), init ?? {}),
  );
  const r = createVaultRemote({ instanceUrl: () => BASE, token: () => "stw_pat_desktop", fetch });
  return { r, fetch };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("le rotte del sigillo del dispositivo, dal main", () => {
  it("l'accoppiamento: la pubblica e il nome col bearer; risponde state e id del dispositivo", async () => {
    const { r, fetch } = remote(() =>
      json(201, { state: "s-1", deviceId: DEVICE, expiresAt: "2026-11-24T10:10:00Z" }),
    );
    expect(await r.pair('{"kty":"EC"}', "MacBook Pro")).toEqual({
      state: "s-1",
      deviceId: DEVICE,
      expiresAt: "2026-11-24T10:10:00Z",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/vault/device-pairings`);
    expect(init).toMatchObject({ method: "POST" });
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer stw_pat_desktop");
    expect(JSON.parse(init!.body as string)).toEqual({
      devicePublicKey: '{"kty":"EC"}',
      deviceName: "MacBook Pro",
    });
  });

  it("l'accoppiamento rifiutato: il codice del server", async () => {
    const { r } = remote(() => json(409, { code: "vault_not_active", message: "x" }));
    await expect(r.pair("{}", "Mac")).rejects.toThrow("vault_not_active");
  });

  it("il sigillo: la forma della rotta; un 404 `device_seal_not_found` è la revoca", async () => {
    const seal = {
      id: DEVICE,
      deviceName: "Mac",
      personKeyId: PERSON_KEY,
      personPublicKey: "{}",
      seal: "env",
    };
    expect(await remote(() => json(200, seal)).r.fetchSeal()).toEqual(seal);
    expect(
      await remote(() => json(404, { code: "device_seal_not_found", message: "x" })).r.fetchSeal(),
    ).toEqual({
      revoked: true,
    });
    // Un altro errore non è una revoca: chi chiama non cancella niente.
    await expect(
      remote(() => json(500, { code: "internal", message: "x" })).r.fetchSeal(),
    ).rejects.toThrow();
  });

  it("una risposta che non ha la forma degli schemi (`@stubwise/shared`) è un errore, non un sigillo", async () => {
    const bad = { id: "not-a-uuid", deviceName: "Mac", personKeyId: PERSON_KEY, personPublicKey: "{}", seal: "env" };
    await expect(remote(() => json(200, bad)).r.fetchSeal()).rejects.toThrow("invalid_response");
    await expect(
      remote(() => json(201, { state: "s-1", deviceId: DEVICE })).r.pair("{}", "Mac"),
    ).rejects.toThrow("invalid_response");
  });

  it("«Dimentica»: DELETE del proprio sigillo; 204 anche se non c'è", async () => {
    const { r, fetch } = remote(() => new Response(null, { status: 204 }));
    await r.forgetRemote();
    expect(fetch.mock.calls[0]![0]).toBe(`${BASE}/api/vault/device-seals/mine`);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "DELETE" });
  });

  it("senza istanza o senza token non parte niente", async () => {
    const fetch = vi.fn();
    const r = createVaultRemote({ instanceUrl: () => null, token: () => null, fetch });
    await expect(r.fetchSeal()).rejects.toThrow("no_session");
    expect(fetch).not.toHaveBeenCalled();
  });
});
