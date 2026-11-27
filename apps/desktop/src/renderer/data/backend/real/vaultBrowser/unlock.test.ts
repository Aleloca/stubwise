import { generatePersonKeyPair, sealPrivateKey } from "@stubwise/vault-crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Lo sblocco nella scheda (design §3, §5, §14): la passkey con la PRF, la
// verifica, la chiave viva aperta e consegnata a `key.ts`. Sopra un `fetch`
// e un `credentials.get` finti, catturati come in produzione al primo import.

const CRED = "Y3JlZC0x"; // base64url di «cred-1»
const ME = "p-ada";

let calls: { method: string; path: string; body: unknown }[];
let prf: Uint8Array<ArrayBuffer>;
let seal: { sealedPrivateKey: string; publicKey: string };
let extensionResults: () => unknown;

beforeEach(async () => {
  calls = [];
  prf = crypto.getRandomValues(new Uint8Array(32));
  const pair = await generatePersonKeyPair();
  seal = { sealedPrivateKey: await sealPrivateKey(prf.slice().buffer, pair.privateKeyPkcs8, pair.publicKey), publicKey: pair.publicKey };
  extensionResults = () => ({ prf: { results: { first: prf.slice().buffer } } });
  const routes: Record<string, () => unknown> = {
    "GET /api/vault/status": () => ({
      activated: true,
      myKey: { id: "11111111-1111-4111-8111-111111111111", status: "confirmed", createdAt: "2026-11-01T00:00:00.000Z" },
      seals: [{ passkeyId: "22222222-2222-4222-8222-222222222222", credentialIdB64url: CRED }],
      passkeys: [],
    }),
    "POST /api/me/security/reauth/passkey/options": () => ({
      challenge: "Y2hhbGxlbmdl",
      allowCredentials: [{ id: CRED, type: "public-key" }, { id: "b3RoZXI", type: "public-key" }],
      extensions: { prf: { eval: { first: "c3R1Yndpc2U" } } },
    }),
    "POST /api/me/security/reauth/passkey/verify": () => ({}),
    "GET /api/vault/keys/mine": () => ({
      id: "11111111-1111-4111-8111-111111111111",
      publicKey: seal.publicKey,
      status: "confirmed",
      seals: [{ passkeyId: "22222222-2222-4222-8222-222222222222", credentialIdB64url: CRED, sealedPrivateKey: seal.sealedPrivateKey }],
    }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      const key = `${init.method} ${path}`;
      calls.push({ method: init.method!, path, body: init.body ? JSON.parse(init.body as string) : undefined });
      const route = routes[key];
      return route ? new Response(JSON.stringify(route()), { status: 200 }) : new Response('{"code":"not_found"}', { status: 404 });
    }),
  );
  const get = vi.fn(async (options: CredentialRequestOptions) => {
    calls.push({ method: "WEBAUTHN", path: "get", body: options.publicKey?.allowCredentials?.length });
    return {
      id: CRED,
      rawId: new Uint8Array([1, 2, 3]).buffer,
      type: "public-key",
      authenticatorAttachment: null,
      response: {
        authenticatorData: new Uint8Array([4]).buffer,
        clientDataJSON: new Uint8Array([5]).buffer,
        signature: new Uint8Array([6]).buffer,
        userHandle: null,
      },
      getClientExtensionResults: extensionResults,
    };
  });
  vi.stubGlobal("navigator", { ...navigator, credentials: { get, create: vi.fn() } });
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const load = async () => {
  const { unlockInBrowser } = await import("./unlock");
  const key = await import("./key");
  key.__resetKeyForTests();
  return { unlockInBrowser, key };
};

describe("lo sblocco nella scheda", () => {
  it("apre la chiave viva col sigillo della passkey, e `key.ts` la tiene per persona e sessione", async () => {
    const { unlockInBrowser, key } = await load();
    expect(await unlockInBrowser(ME, "s-1")).toEqual({ ok: true });
    expect(key.status().state).toBe("open");
    expect(key.use(ME, "s-1").type).toBe("private");
    expect(key.use(ME, "s-1").extractable).toBe(false);
  });

  it("solo le passkey che aprono la chiave; il segreto PRF non va MAI al server", async () => {
    const { unlockInBrowser } = await load();
    await unlockInBrowser(ME, "s-1");
    expect(calls.find((c) => c.method === "WEBAUTHN")!.body).toBe(1);
    const verify = calls.find((c) => c.path.endsWith("/verify"))!.body as { response: { clientExtensionResults: unknown } };
    expect(verify.response.clientExtensionResults).toEqual({});
    expect(JSON.stringify(calls)).not.toContain(btoa(String.fromCharCode(...prf)).slice(0, 12));
  });

  it("§14: una passkey senza PRF non manda niente al server (nemmeno la verifica)", async () => {
    extensionResults = () => ({});
    const { unlockInBrowser, key } = await load();
    expect(await unlockInBrowser(ME, "s-1")).toEqual({ ok: false, code: "passkey_unsupported" });
    expect(calls.some((c) => c.path.endsWith("/verify"))).toBe(false);
    expect(calls.some((c) => c.path === "/api/vault/keys/mine")).toBe(false);
    expect(key.status().state).toBe("locked");
  });

  it("annullata dal browser: `passkey_failed`, chiusa", async () => {
    vi.stubGlobal("navigator", { ...navigator, credentials: { get: vi.fn(async () => Promise.reject(new Error("NotAllowedError"))), create: vi.fn() } });
    const { unlockInBrowser, key } = await load();
    expect(await unlockInBrowser(ME, "s-1")).toEqual({ ok: false, code: "passkey_failed" });
    expect(key.status().state).toBe("locked");
  });

  it("un sigillo che non si apre (la PRF di un'altra passkey): `open_failed`, chiusa", async () => {
    extensionResults = () => ({ prf: { results: { first: crypto.getRandomValues(new Uint8Array(32)).buffer } } });
    const { unlockInBrowser, key } = await load();
    expect(await unlockInBrowser(ME, "s-1")).toEqual({ ok: false, code: "open_failed" });
    expect(key.status().state).toBe("locked");
  });
});
