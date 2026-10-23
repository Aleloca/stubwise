import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  decryptPassword,
  encryptForInsert,
  generatePersonKeyPair,
  generateRecoveryKit,
  unwrapItemKey,
  wrapRecoveryChallenge,
} from "@stubwise/vault-crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRecoveryPage } from "./vault-recovery";

/**
 * Pagina di recupero (design «Kit di recupero»): il kit si incolla, si legge
 * nel browser e non viaggia mai; al server va solo la prova (il segreto di
 * una sfida aperta col kit). Il server qui è un doppio che fa le stesse
 * verifiche di quello vero: prova giusta, sfida consumata dalla conferma.
 */

const BEA_ID = "40000000-0000-4000-8000-000000000002";
const CARL_ID = "40000000-0000-4000-8000-000000000003";
const BEA_KEY_ID = "50000000-0000-4000-8000-000000000002";
const CARL_KEY_ID = "50000000-0000-4000-8000-000000000003";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const HETZNER = "60000000-0000-4000-8000-000000000001";
const PASSWORD = "hetzner-pw";

let kit: { publicKey: string; kitText: string };
let otherKit: { publicKey: string; kitText: string };
let bea: Awaited<ReturnType<typeof generatePersonKeyPair>>;
let carl: Awaited<ReturnType<typeof generatePersonKeyPair>>;
let ciphertext: string;
let recoveryCopy: string;

beforeAll(async () => {
  kit = await generateRecoveryKit();
  otherKit = await generateRecoveryKit();
  bea = await generatePersonKeyPair();
  carl = await generatePersonKeyPair();
  const encrypted = await encryptForInsert({
    credentialId: HETZNER,
    password: PASSWORD,
    recipients: [{ recipientId: "recovery", publicKey: kit.publicKey }],
  });
  ciphertext = encrypted.passwordCiphertext;
  recoveryCopy = encrypted.copies[0]!.wrappedKey;
});

function toB64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function person(userId: string, email: string, keyId: string, publicKey: string) {
  return {
    user: { id: userId, email },
    personKey: {
      id: keyId,
      status: "pending",
      createdAt: "2026-10-22T08:30:00.000Z",
      device: "Safari su iPhone",
      fingerprintSource: publicKey,
    },
    credentials: [
      { id: HETZNER, projectId: PROJECT_ID, service: "Hetzner", label: null, wrappedKey: recoveryCopy, keyVersion: "v1" },
    ],
  };
}

const fetchMock = vi.fn<typeof fetch>();
let requests: { method: string; path: string; body: unknown; raw: string }[];
/** Le sfide emesse: id → prova attesa, e se una conferma l'ha consumata. */
let challenges: Map<string, { proof: string; used: boolean }>;
let waiting: string[];

function proofOk(body: { challengeId?: string; proof?: string }): boolean {
  const challenge = challenges.get(body.challengeId ?? "");
  return !!challenge && !challenge.used && challenge.proof === body.proof;
}

beforeEach(() => {
  requests = [];
  challenges = new Map();
  waiting = [BEA_KEY_ID, CARL_KEY_ID];
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://test.local");
    const method = init?.method ?? "GET";
    const raw = init?.body ? String(init.body) : "";
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method, path: url.pathname, body, raw });
    if (method === "POST" && url.pathname === "/api/vault/recovery/challenge") {
      const challengeId = crypto.randomUUID();
      const secret = crypto.getRandomValues(new Uint8Array(32));
      challenges.set(challengeId, { proof: toB64Url(secret), used: false });
      return jsonResponse(201, {
        challengeId,
        wrapped: await wrapRecoveryChallenge(secret, kit.publicKey, challengeId),
        expiresAt: "2026-10-23T12:05:00.000Z",
      });
    }
    if (method === "POST" && url.pathname === "/api/vault/recovery/pending") {
      if (!proofOk(body)) return jsonResponse(403, { code: "recovery_proof_invalid", message: "no" });
      const all = [
        person(BEA_ID, "bea@example.com", BEA_KEY_ID, bea.publicKey),
        person(CARL_ID, "carl@example.com", CARL_KEY_ID, carl.publicKey),
      ];
      return jsonResponse(200, { items: all.filter((p) => waiting.includes(p.personKey.id)) });
    }
    const confirm = url.pathname.match(/^\/api\/vault\/recovery\/confirm\/(.+)$/);
    if (method === "POST" && confirm) {
      if (!proofOk(body)) return jsonResponse(403, { code: "recovery_proof_invalid", message: "no" });
      challenges.get(body.challengeId)!.used = true;
      waiting = waiting.filter((id) => id !== confirm[1]);
      return jsonResponse(200, {
        personKeyId: confirm[1],
        status: "confirmed",
        saved: [HETZNER],
        skipped: [],
      });
    }
    return jsonResponse(500, { message: `unexpected ${method} ${url.pathname}` });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <VaultRecoveryPage />
    </QueryClientProvider>,
  );
}

function pasteKit(text: string) {
  fireEvent.change(screen.getByLabelText("Recovery kit"), { target: { value: text } });
}

/** Nessuna richiesta ha portato il kit, in nessuna forma. */
function expectKitNeverSent(text: string) {
  const compact = text.replace(/-/g, "");
  for (const request of requests) {
    expect(request.raw).not.toContain(text);
    expect(request.raw).not.toContain(compact);
    expect(request.raw.toUpperCase()).not.toContain(compact.slice(0, 40));
  }
}

describe("recupero col kit", () => {
  it("incolla il kit, prova di averlo e mostra chi verrà confermato — il kit non lascia il browser", async () => {
    renderPage();
    pasteKit(kit.kitText);
    fireEvent.click(screen.getByRole("button", { name: "Use the kit" }));

    const beaCard = await screen.findByRole("group", { name: "bea@example.com" });
    expect(within(beaCard).getByText("Hetzner")).toBeInTheDocument();
    expect(within(beaCard).getByText(/Safari su iPhone/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "carl@example.com" })).toBeInTheDocument();
    // Il recupero conferma soltanto.
    expect(screen.queryByRole("button", { name: /^Reject / })).not.toBeInTheDocument();

    // Il testo è sparito dal campo appena letto.
    expect(screen.queryByLabelText("Recovery kit")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(kit.kitText);
    expectKitNeverSent(kit.kitText);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("conferma due persone col kit: ogni conferma ha la sua sfida, e le copie si aprono con la chiave della persona", async () => {
    const user = userEvent.setup();
    renderPage();
    pasteKit(kit.kitText);
    await user.click(screen.getByRole("button", { name: "Use the kit" }));

    for (const [email, keyId, keyPair] of [
      ["bea@example.com", BEA_KEY_ID, () => bea],
      ["carl@example.com", CARL_KEY_ID, () => carl],
    ] as const) {
      const card = await screen.findByRole("group", { name: email });
      await user.click(within(card).getByRole("button", { name: `Confirm ${email}` }));
      await user.click(within(card).getByRole("button", { name: "Yes, I checked: confirm" }));
      await waitFor(() => expect(screen.queryByRole("group", { name: email })).not.toBeInTheDocument());

      const sent = requests.find((r) => r.path === `/api/vault/recovery/confirm/${keyId}`)!;
      expect(sent.body).toMatchObject({ challengeId: expect.any(String), proof: expect.any(String) });
      const { copies } = sent.body as { copies: { credentialId: string; wrappedKey: string; keyVersion: string }[] };
      expect(copies).toHaveLength(1);
      expect(copies[0]!.keyVersion).toBe("v1");
      const itemKey = await unwrapItemKey(copies[0]!.wrappedKey, keyPair().privateKey, HETZNER, keyId);
      expect(await decryptPassword(HETZNER, ciphertext, itemKey)).toBe(PASSWORD);
    }

    // Nessuna conferma è stata respinta per una sfida già usata.
    const confirms = requests.filter((r) => r.path.startsWith("/api/vault/recovery/confirm/"));
    expect(confirms).toHaveLength(2);
    const ids = confirms.map((r) => (r.body as { challengeId: string }).challengeId);
    expect(new Set(ids).size).toBe(2);
    expect(requests.some((r) => r.path.startsWith("/api/vault/pending/"))).toBe(false);
    expect(await screen.findByText("No access is waiting for a confirmation.")).toBeInTheDocument();
    expectKitNeverSent(kit.kitText);
    expect(JSON.stringify(requests.map((r) => r.body))).not.toContain(PASSWORD);
  });

  it("un testo che non è un kit si ferma nel browser, senza nessuna richiesta", async () => {
    renderPage();
    pasteKit("AAAAA-BBBBB-CCCCC");
    fireEvent.click(screen.getByRole("button", { name: "Use the kit" }));
    expect(await screen.findByText(/not a valid recovery kit/)).toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it("un kit che non è quello della cassaforte non apre la sfida: nessun elenco", async () => {
    renderPage();
    pasteKit(otherKit.kitText);
    fireEvent.click(screen.getByRole("button", { name: "Use the kit" }));
    expect(await screen.findByText(/does not open the vault's recovery key/)).toBeInTheDocument();
    expect(requests.map((r) => r.path)).toEqual(["/api/vault/recovery/challenge"]);
    expectKitNeverSent(otherKit.kitText);
  });

  it("«Ho finito» dimentica il kit", async () => {
    renderPage();
    pasteKit(kit.kitText);
    fireEvent.click(screen.getByRole("button", { name: "Use the kit" }));
    await screen.findByRole("group", { name: "bea@example.com" });

    fireEvent.click(screen.getByRole("button", { name: "Done: forget the kit" }));
    expect(screen.queryByRole("group", { name: "bea@example.com" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Recovery kit")).toHaveValue("");
    // Senza kit in memoria non si conferma più niente: va reincollato.
    expect(screen.queryByRole("button", { name: /^Confirm / })).not.toBeInTheDocument();
  });

  it("rientrando nella pagina non resta niente del kit", async () => {
    const first = renderPage();
    pasteKit(kit.kitText);
    fireEvent.click(screen.getByRole("button", { name: "Use the kit" }));
    await screen.findByRole("group", { name: "bea@example.com" });
    first.unmount();

    renderPage();
    expect(screen.getByLabelText("Recovery kit")).toHaveValue("");
    expect(screen.queryByRole("group", { name: "bea@example.com" })).not.toBeInTheDocument();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
