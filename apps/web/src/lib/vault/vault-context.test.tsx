import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openPrivateKey, PRF_INPUT } from "@stubwise/vault-crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VAULT_IDLE_MS } from "./idle";
import { useVault, VaultProvider } from "./vault-context";

const startAuthenticationMock = vi.hoisted(() => vi.fn());
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: startAuthenticationMock,
}));

const PASSKEY_ID = "11111111-1111-4111-8111-111111111111";
const CRED_ID = "Y3JlZC1h";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = "2026-10-23T10:00:00.000Z";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Un server finto con lo stato della cassaforte, che cambia con le scritture. */
interface FakeServer {
  activated: boolean;
  key: { id: string; status: "pending" | "confirmed"; publicKey: string; sealed: string } | null;
}
let server: FakeServer;
let requests: { method: string; path: string; body: unknown }[];

function toB64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
  const method = init?.method ?? "GET";
  const path = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ method, path, body });
  const seals = server.key ? [{ passkeyId: PASSKEY_ID, credentialIdB64url: CRED_ID }] : [];
  switch (`${method} ${path}`) {
    case "GET /api/vault/status":
      // `passkeys` presente: il server nuovo lo manda sempre.
      return jsonResponse(200, {
        activated: server.activated,
        myKey: server.key ? { id: server.key.id, status: server.key.status, createdAt: CREATED_AT } : null,
        seals,
        passkeys: [{ passkeyId: PASSKEY_ID, credentialIdB64url: CRED_ID }],
      });
    case "POST /api/me/security/reauth/passkey/options":
      return jsonResponse(200, {
        challenge: "Y2hhbGxlbmdl",
        allowCredentials: [
          { id: CRED_ID, type: "public-key" },
          { id: "b3RoZXI", type: "public-key" },
        ],
        extensions: body?.purpose === "vault" ? { prf: { eval: { first: toB64Url(PRF_INPUT) } } } : undefined,
      });
    case "POST /api/me/security/reauth/passkey/verify":
      return jsonResponse(204, null);
    case "POST /api/vault/keys": {
      const b = body as { publicKey: string; seals: { sealedPrivateKey: string }[] };
      server.key = { id: KEY_ID, status: "pending", publicKey: b.publicKey, sealed: b.seals[0]!.sealedPrivateKey };
      return jsonResponse(201, { id: KEY_ID, status: "pending", createdAt: CREATED_AT });
    }
    case "GET /api/vault/keys/mine":
      if (!server.key) return jsonResponse(404, { code: "vault_key_not_found", message: "no" });
      return jsonResponse(200, {
        id: server.key.id,
        publicKey: server.key.publicKey,
        status: server.key.status,
        seals: [{ ...seals[0], sealedPrivateKey: server.key.sealed }],
      });
    default:
      return jsonResponse(500, { message: `unexpected ${method} ${path}` });
  }
});

/** Il segreto PRF che la passkey finta produce (sempre lo stesso, come una vera). */
const PRF_SECRET = new Uint8Array(32).map((_, i) => i + 7);

function assertion(prf: boolean) {
  return {
    id: CRED_ID,
    rawId: CRED_ID,
    type: "public-key",
    response: { authenticatorData: "a", clientDataJSON: "b", signature: "c" },
    clientExtensionResults: prf ? { prf: { results: { first: PRF_SECRET.slice().buffer } } } : {},
  };
}

function writes() {
  return requests.filter((r) => r.method !== "GET");
}

beforeEach(() => {
  server = { activated: true, key: null };
  requests = [];
  fetchMock.mockClear();
  startAuthenticationMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

let latest: ReturnType<typeof useVault> | null = null;
let unlockError: unknown = null;

function Probe() {
  const vault = useVault();
  latest = vault;
  return (
    <div>
      <p data-testid="state">{vault.state}</p>
      <p data-testid="key">{vault.privateKey ? "key" : "none"}</p>
      <button
        type="button"
        onClick={() => {
          vault.unlock().catch((e: unknown) => {
            unlockError = e;
          });
        }}
      >
        unlock
      </button>
      <button type="button" onClick={vault.lock}>
        lock
      </button>
    </div>
  );
}

function renderVault() {
  unlockError = null;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <VaultProvider>
        <Probe />
      </VaultProvider>
    </QueryClientProvider>,
  );
}

const state = () => screen.getByTestId("state").textContent;

describe("VaultProvider", () => {
  it("passkey senza PRF → unsupported, nessuna verifica e NESSUNA chiave creata (Review Focus 5)", async () => {
    startAuthenticationMock.mockResolvedValue(assertion(false));
    renderVault();
    await waitFor(() => expect(state()).toBe("no_key"));

    await userEvent.click(screen.getByRole("button", { name: "unlock" }));
    await waitFor(() => expect(state()).toBe("unsupported"));

    expect(unlockError).toBeNull();
    expect(screen.getByTestId("key")).toHaveTextContent("none");
    // Solo le opzioni: né la verifica, né una chiave.
    expect(writes().map((r) => r.path)).toEqual(["/api/me/security/reauth/passkey/options"]);
  });

  it("prima apertura: chiede la PRF in byte, crea la chiave sigillata col segreto, e la cassaforte è aperta", async () => {
    startAuthenticationMock.mockResolvedValue(assertion(true));
    renderVault();
    await waitFor(() => expect(state()).toBe("no_key"));

    await userEvent.click(screen.getByRole("button", { name: "unlock" }));
    await waitFor(() => expect(state()).toBe("unlocked"));
    expect(unlockError).toBeNull();
    expect(latest?.privateKey).not.toBeNull();
    expect(latest?.personKeyId).toBe(KEY_ID);

    // Opzioni con `purpose: "vault"`, PRF passata al browser come BYTE.
    const options = writes()[0]!;
    expect(options).toMatchObject({ path: "/api/me/security/reauth/passkey/options", body: { purpose: "vault" } });
    const passed = startAuthenticationMock.mock.calls[0]![0].optionsJSON;
    expect(passed.extensions.prf.eval.first).toBeInstanceOf(Uint8Array);
    expect(Array.from(passed.extensions.prf.eval.first as Uint8Array)).toEqual(Array.from(PRF_INPUT));

    // La verifica NON porta il segreto PRF.
    const verify = writes().find((r) => r.path === "/api/me/security/reauth/passkey/verify")!;
    expect(JSON.stringify(verify.body)).not.toContain("prf");

    // La chiave: pubblica JWK senza `d`, un sigillo per la passkey usata, il dispositivo.
    const created = writes().find((r) => r.path === "/api/vault/keys")!.body as {
      publicKey: string;
      seals: { passkeyId: string; sealedPrivateKey: string }[];
      device: string;
    };
    expect(JSON.parse(created.publicKey)).not.toHaveProperty("d");
    expect(created.seals).toHaveLength(1);
    expect(created.seals[0]!.passkeyId).toBe(PASSKEY_ID);
    expect(typeof created.device).toBe("string");
    // Il sigillo si riapre col segreto della passkey (crittografia vera).
    await expect(openPrivateKey(PRF_SECRET.slice().buffer, created.seals[0]!.sealedPrivateKey)).resolves.toBeDefined();
  });

  it("chiave già creata: la riapre col sigillo della passkey usata, senza crearne un'altra", async () => {
    startAuthenticationMock.mockResolvedValue(assertion(true));
    const first = renderVault();
    await waitFor(() => expect(state()).toBe("no_key"));
    await userEvent.click(screen.getByRole("button", { name: "unlock" }));
    await waitFor(() => expect(state()).toBe("unlocked"));
    first.unmount();

    // Nuova scheda: la chiave c'è, chiusa.
    requests = [];
    renderVault();
    await waitFor(() => expect(state()).toBe("locked"));
    await userEvent.click(screen.getByRole("button", { name: "unlock" }));
    await waitFor(() => expect(state()).toBe("unlocked"));
    expect(latest?.personKeyId).toBe(KEY_ID);
    expect(requests.some((r) => r.path === "/api/vault/keys/mine")).toBe(true);
    expect(writes().some((r) => r.path === "/api/vault/keys")).toBe(false);
    // Solo le passkey che aprono la chiave sono offerte.
    const passed = startAuthenticationMock.mock.calls.at(-1)![0].optionsJSON;
    expect(passed.allowCredentials.map((c: { id: string }) => c.id)).toEqual([CRED_ID]);
  });

  it("15 minuti senza interazione → locked e chiave azzerata", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    startAuthenticationMock.mockResolvedValue(assertion(true));
    renderVault();
    await waitFor(() => expect(state()).toBe("no_key"));
    await act(async () => {
      await latest!.unlock();
    });
    expect(state()).toBe("unlocked");

    act(() => {
      vi.advanceTimersByTime(VAULT_IDLE_MS - 1000);
    });
    expect(state()).toBe("unlocked");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(state()).toBe("locked");
    expect(latest?.privateKey).toBeNull();
    expect(latest?.personKeyId).toBeNull();
  });

  it("lock() la chiude subito", async () => {
    startAuthenticationMock.mockResolvedValue(assertion(true));
    renderVault();
    await waitFor(() => expect(state()).toBe("no_key"));
    await userEvent.click(screen.getByRole("button", { name: "unlock" }));
    await waitFor(() => expect(state()).toBe("unlocked"));
    await userEvent.click(screen.getByRole("button", { name: "lock" }));
    expect(state()).toBe("locked");
    expect(screen.getByTestId("key")).toHaveTextContent("none");
  });

  it("la chiave privata non finisce mai nello storage del browser", async () => {
    startAuthenticationMock.mockResolvedValue(assertion(true));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderVault();
    await waitFor(() => expect(state()).toBe("no_key"));
    await userEvent.click(screen.getByRole("button", { name: "unlock" }));
    await waitFor(() => expect(state()).toBe("unlocked"));
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("cassaforte non attiva → inactive", async () => {
    server.activated = false;
    renderVault();
    await waitFor(() => expect(requests.some((r) => r.path === "/api/vault/status")).toBe(true));
    expect(state()).toBe("inactive");
  });

  it("server vecchio senza `passkeys`: la prima apertura fallisce con un errore, senza creare nulla", async () => {
    startAuthenticationMock.mockResolvedValue(assertion(true));
    fetchMock.mockImplementationOnce(async (input) => {
      requests.push({ method: "GET", path: String(input), body: undefined });
      return jsonResponse(200, { activated: true, myKey: null, seals: [] });
    });
    renderVault();
    await waitFor(() => expect(state()).toBe("no_key"));
    fetchMock.mockImplementationOnce(async (input) => {
      requests.push({ method: "GET", path: String(input), body: undefined });
      return jsonResponse(200, { activated: true, myKey: null, seals: [] });
    });
    await userEvent.click(screen.getByRole("button", { name: "unlock" }));
    await waitFor(() => expect(unlockError).not.toBeNull());
    expect((unlockError as { code?: string }).code).toBe("passkey_unknown");
    expect(writes().some((r) => r.path === "/api/vault/keys")).toBe(false);
  });
});
