import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PRF_INPUT } from "@stubwise/vault-crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultProvider } from "../../lib/vault/vault-context";
import { UnlockDialog } from "./unlock-dialog";

const startAuthenticationMock = vi.hoisted(() => vi.fn());
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: startAuthenticationMock,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const PASSKEY_ID = "11111111-1111-4111-8111-111111111111";
const CRED_ID = "Y3JlZC1h";
const OLD_KEY = "44444444-4444-4444-8444-444444444444";
const NEW_KEY = "22222222-2222-4222-8222-222222222222";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function toB64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

let keyId: string;
let requests: { method: string; path: string }[];

const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
  const method = init?.method ?? "GET";
  const path = String(input);
  requests.push({ method, path });
  switch (`${method} ${path}`) {
    case "GET /api/vault/status":
      return jsonResponse(200, {
        activated: true,
        myKey: { id: keyId, status: keyId === OLD_KEY ? "confirmed" : "pending", createdAt: "2026-10-23T10:00:00.000Z" },
        // La chiave vecchia non ha più sigilli: le sue passkey sono state tolte.
        seals: keyId === OLD_KEY ? [] : [{ passkeyId: PASSKEY_ID, credentialIdB64url: CRED_ID }],
        passkeys: [{ passkeyId: PASSKEY_ID, credentialIdB64url: CRED_ID }],
      });
    case "POST /api/me/security/reauth/passkey/options":
      return jsonResponse(200, {
        challenge: "Y2hhbGxlbmdl",
        allowCredentials: [{ id: CRED_ID, type: "public-key" }],
        extensions: { prf: { eval: { first: toB64Url(PRF_INPUT) } } },
      });
    case "POST /api/me/security/reauth/passkey/verify":
      return jsonResponse(204, null);
    case "POST /api/vault/keys":
      keyId = NEW_KEY;
      return jsonResponse(201, { id: NEW_KEY, status: "pending", createdAt: "2026-10-23T10:00:00.000Z" });
    default:
      return jsonResponse(500, { message: `unexpected ${method} ${path}` });
  }
});

beforeEach(() => {
  keyId = OLD_KEY;
  requests = [];
  fetchMock.mockClear();
  startAuthenticationMock.mockReset();
  startAuthenticationMock.mockImplementation(async () => ({
    id: CRED_ID,
    rawId: CRED_ID,
    type: "public-key",
    response: { authenticatorData: "a", clientDataJSON: "b", signature: "c" },
    clientExtensionResults: { prf: { results: { first: new Uint8Array(32).fill(5).buffer } } },
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UnlockDialog", () => {
  it("nessuna passkey apre più la chiave: lo dice, avverte, e «Ricrea la chiave» la ricrea", async () => {
    const onClose = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <VaultProvider>
          <UnlockDialog onClose={onClose} />
        </VaultProvider>
      </QueryClientProvider>,
    );

    const use = await screen.findByRole("button", { name: "Use passkey" });
    await vi.waitFor(() => expect(use).toBeEnabled());
    await userEvent.click(use);
    expect(await screen.findByText(/No passkey opens your key any more/)).toBeInTheDocument();
    expect(screen.getByText(/go back to «pending» until someone confirms the new key/)).toBeInTheDocument();
    expect(startAuthenticationMock).not.toHaveBeenCalled();
    expect(requests.some((r) => r.path === "/api/vault/keys")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Recreate the vault key" }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([
      "/api/me/security/reauth/passkey/options",
      "/api/me/security/reauth/passkey/verify",
      "/api/vault/keys",
    ]);
  });

  it("senza no_seal non offre di ricreare la chiave", async () => {
    keyId = NEW_KEY;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    startAuthenticationMock.mockRejectedValue(new Error("NotAllowedError"));
    render(
      <QueryClientProvider client={queryClient}>
        <VaultProvider>
          <UnlockDialog onClose={vi.fn()} />
        </VaultProvider>
      </QueryClientProvider>,
    );
    const use = await screen.findByRole("button", { name: "Use passkey" });
    await vi.waitFor(() => expect(use).toBeEnabled());
    await userEvent.click(use);
    expect(await screen.findByText(/Passkey cancelled or failed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recreate the vault key" })).not.toBeInTheDocument();
  });
});
