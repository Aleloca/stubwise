import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  decryptPassword,
  encryptForInsert,
  parseRecoveryKit,
  PRF_INPUT,
  unwrapItemKey,
} from "@stubwise/vault-crypto";
import { actorChallengeDouble } from "../test/vault-actor-challenge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultProvider } from "../lib/vault/vault-context";
import { VaultSetupPage } from "./vault-setup";

const startAuthenticationMock = vi.hoisted(() => vi.fn());
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: startAuthenticationMock,
}));

// La pagina monta un `<Link>` nell'avviso «passkey senza PRF» e verso il recupero.
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
/** La pubblica della chiave che il browser ha creato (la sfida si cifra per lei). */
let createdPublicKey: string;
/** L'anteprima della rotazione: credenziali con la copia dell'admin, e quelle che mancano. */
let preview: () => Promise<unknown>;
let rotations: { recoveryPublicKey: string; copies: { credentialId: string; wrappedKey: string }[]; actorProof: unknown }[];
const actor = actorChallengeDouble(() => ({ personKeyId: KEY_ID, publicKey: createdPublicKey }));
const HETZNER = "60000000-0000-4000-8000-000000000001";
const GITHUB = "60000000-0000-4000-8000-000000000002";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

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
      createdPublicKey = (body as { publicKey: string }).publicKey;
      return jsonResponse(201, { id: KEY_ID, status: "confirmed", createdAt: "2026-10-23T10:00:00.000Z" });
    case "POST /api/vault/actor-challenge":
      return actor.respond();
    case "GET /api/vault/recovery-key/preview":
      return jsonResponse(200, await preview());
    case "POST /api/vault/recovery-key":
      rotations.push(body as (typeof rotations)[number]);
      return jsonResponse(204, null);
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
  rotations = [];
  preview = async () => ({ personKeyId: KEY_ID, credentials: [], missing: [] });
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

  /** Attiva come nel primo test: la cassaforte resta aperta con la chiave (vera) dell'admin. */
  async function activateAndOpen() {
    startAuthenticationMock.mockImplementation(async () => assertion(true));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Generate the recovery kit" }));
    await screen.findByTestId("recovery-kit-text");
    await userEvent.click(screen.getByRole("checkbox", { name: "I printed/saved the kit" }));
    await userEvent.click(screen.getByRole("button", { name: "Activate the vault" }));
    await screen.findByText("The vault is open in this tab.");
  }

  it("rigenera il kit: anteprima, kit nuovo mostrato una volta, ricifratura di OGNI credenziale e prova della propria chiave", async () => {
    await activateAndOpen();
    // Due credenziali con la copia dell'admin (per la chiave appena creata).
    const passwords: Record<string, string> = { [HETZNER]: "hetzner-pw", [GITHUB]: "github-pw" };
    const ciphertexts: Record<string, string> = {};
    const adminCopies: Record<string, string> = {};
    for (const id of [HETZNER, GITHUB]) {
      const encrypted = await encryptForInsert({
        credentialId: id,
        password: passwords[id]!,
        recipients: [{ recipientId: KEY_ID, publicKey: createdPublicKey }],
      });
      ciphertexts[id] = encrypted.passwordCiphertext;
      adminCopies[id] = encrypted.copies[0]!.wrappedKey;
    }
    preview = async () => ({
      personKeyId: KEY_ID,
      credentials: [HETZNER, GITHUB].map((id) => ({
        id,
        projectId: PROJECT_ID,
        service: id === HETZNER ? "Hetzner" : "GitHub",
        label: null,
        wrappedKey: adminCopies[id],
      })),
      missing: [],
    });

    await userEvent.click(screen.getByRole("button", { name: "Regenerate the recovery kit" }));
    const kitNode = await screen.findByTestId("recovery-kit-text");
    const kitText = kitNode.textContent ?? "";
    expect(screen.getByText(/the old kit stops working/i)).toBeInTheDocument();
    const replace = screen.getByRole("button", { name: "Replace the recovery kit" });
    expect(replace).toBeDisabled();
    expect(rotations).toEqual([]);
    await userEvent.click(screen.getByRole("checkbox", { name: "I printed/saved the new kit" }));
    await userEvent.click(replace);

    expect(await screen.findByText(/recovery kit was replaced/i)).toBeInTheDocument();
    expect(screen.queryByTestId("recovery-kit-text")).not.toBeInTheDocument();
    expect(rotations).toHaveLength(1);
    const sent = rotations[0]!;
    expect(actor.valid(sent.actorProof)).toBe(true);
    expect(sent.copies.map((c) => c.credentialId).sort()).toEqual([HETZNER, GITHUB].sort());
    // Le copie nuove si aprono col kit NUOVO (destinatario `recovery`).
    const kitKey = await parseRecoveryKit(kitText);
    for (const copy of sent.copies) {
      const itemKey = await unwrapItemKey(copy.wrappedKey, kitKey, copy.credentialId, "recovery");
      expect(await decryptPassword(copy.credentialId, ciphertexts[copy.credentialId]!, itemKey)).toBe(
        passwords[copy.credentialId],
      );
    }
    for (const r of requests) expect(JSON.stringify(r.body ?? null)).not.toContain(kitText.slice(0, 20));
    expect(JSON.stringify(rotations)).not.toContain("hetzner-pw");
  });

  it("rigenerare il kit senza la copia di qualche credenziale: le elenca e si ferma, nessun kit e nulla inviato", async () => {
    await activateAndOpen();
    preview = async () => ({
      personKeyId: KEY_ID,
      credentials: [],
      missing: [{ id: GITHUB, projectId: PROJECT_ID, service: "GitHub", label: "Org" }],
    });
    await userEvent.click(screen.getByRole("button", { name: "Regenerate the recovery kit" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/needs ALL of them/);
    expect(within(alert).getByText("GitHub · Org")).toBeInTheDocument();
    expect(screen.queryByTestId("recovery-kit-text")).not.toBeInTheDocument();
    await waitFor(() => expect(requests.some((r) => r.path === "/api/vault/recovery-key/preview")).toBe(true));
    expect(rotations).toEqual([]);
  });

  it("già attiva: niente kit da generare", async () => {
    activated = true;
    renderPage();
    expect(await screen.findByText("The vault is active on this instance.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate the recovery kit" })).not.toBeInTheDocument();
    // Da qui si arriva al recupero col kit.
    expect(screen.getByRole("link", { name: "Use the recovery kit" })).toHaveAttribute(
      "href",
      "/settings/vault/recovery",
    );
  });
});
