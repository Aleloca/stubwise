import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PRF_INPUT } from "@stubwise/vault-crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultProvider } from "../lib/vault/vault-context";
import { VaultSetupPage } from "./vault-setup";

const startAuthenticationMock = vi.hoisted(() => vi.fn());
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: startAuthenticationMock,
}));

// La pagina monta un `<Link>` solo nell'avviso «passkey senza PRF».
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const PASSKEY_ID = "11111111-1111-4111-8111-111111111111";
const CRED_ID = "Y3JlZC1h";
const KEY_ID = "22222222-2222-4222-8222-222222222222";

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

let activated: boolean;
let keyCreated: boolean;
let requests: { method: string; path: string; body: unknown }[];

const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
  const method = init?.method ?? "GET";
  const path = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ method, path, body });
  switch (`${method} ${path}`) {
    case "GET /api/vault/status":
      return jsonResponse(200, {
        activated,
        myKey: keyCreated ? { id: KEY_ID, status: "confirmed", createdAt: "2026-10-23T10:00:00.000Z" } : null,
        seals: keyCreated ? [{ passkeyId: PASSKEY_ID, credentialIdB64url: CRED_ID }] : [],
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
    case "POST /api/vault/activate":
      activated = true;
      return jsonResponse(204, null);
    case "POST /api/vault/keys":
      keyCreated = true;
      return jsonResponse(201, { id: KEY_ID, status: "confirmed", createdAt: "2026-10-23T10:00:00.000Z" });
    default:
      return jsonResponse(500, { message: `unexpected ${method} ${path}` });
  }
});

function assertion(prf: boolean) {
  return {
    id: CRED_ID,
    rawId: CRED_ID,
    type: "public-key",
    response: { authenticatorData: "a", clientDataJSON: "b", signature: "c" },
    clientExtensionResults: prf ? { prf: { results: { first: new Uint8Array(32).fill(9).buffer } } } : {},
  };
}

beforeEach(() => {
  activated = false;
  keyCreated = false;
  requests = [];
  fetchMock.mockClear();
  startAuthenticationMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <VaultProvider>
        <VaultSetupPage />
      </VaultProvider>
    </QueryClientProvider>,
  );
}

const writes = () => requests.filter((r) => r.method !== "GET").map((r) => r.path);

describe("VaultSetupPage", () => {
  it("il kit si mostra una volta, serve la conferma, poi attiva e crea la chiave dell'admin", async () => {
    startAuthenticationMock.mockImplementation(async () => assertion(true));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Generate the recovery kit" }));

    const kit = await screen.findByTestId("recovery-kit-text");
    const kitText = kit.textContent ?? "";
    expect(kitText).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{1,5})+$/);
    expect(screen.getByText(/whoever has the kit and the database/i)).toBeInTheDocument();

    // Senza «Ho stampato/salvato il kit» non si prosegue, e niente è partito.
    const activate = screen.getByRole("button", { name: "Activate the vault" });
    expect(activate).toBeDisabled();
    expect(writes()).toEqual([]);

    await userEvent.click(screen.getByRole("checkbox", { name: "I printed/saved the kit" }));
    expect(activate).toBeEnabled();
    await userEvent.click(activate);

    await screen.findByText("The vault is open in this tab.");
    // Ordine: passkey (PRF) e verifica, POI attivazione, POI la chiave.
    expect(writes()).toEqual([
      "/api/me/security/reauth/passkey/options",
      "/api/me/security/reauth/passkey/verify",
      "/api/vault/activate",
      "/api/vault/keys",
    ]);
    // Al server la sola chiave PUBBLICA di recupero; il testo del kit no.
    const body = requests.find((r) => r.path === "/api/vault/activate")!.body as {
      recoveryPublicKey: string;
    };
    expect(JSON.parse(body.recoveryPublicKey)).not.toHaveProperty("d");
    for (const r of requests) expect(JSON.stringify(r.body ?? null)).not.toContain(kitText.slice(0, 20));
    // Una volta sola: dopo l'attivazione il kit non c'è più.
    expect(screen.queryByTestId("recovery-kit-text")).not.toBeInTheDocument();
  });

  it("passkey senza PRF: si ferma PRIMA di attivare, lo dice, e il kit sparisce", async () => {
    startAuthenticationMock.mockImplementation(async () => assertion(false));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Generate the recovery kit" }));
    await screen.findByTestId("recovery-kit-text");
    await userEvent.click(screen.getByRole("checkbox", { name: "I printed/saved the kit" }));
    await userEvent.click(screen.getByRole("button", { name: "Activate the vault" }));

    expect(await screen.findByText(/does not support the PRF extension/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings → Security" })).toHaveAttribute(
      "href",
      "/settings/security",
    );
    expect(writes()).toEqual(["/api/me/security/reauth/passkey/options"]);
    expect(screen.queryByTestId("recovery-kit-text")).not.toBeInTheDocument();
  });

  it("già attiva: niente kit da generare", async () => {
    activated = true;
    renderPage();
    expect(await screen.findByText("The vault is active on this instance.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate the recovery kit" })).not.toBeInTheDocument();
  });
});
