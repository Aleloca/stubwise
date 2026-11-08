import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  decryptPassword,
  encryptForInsert,
  generatePersonKeyPair,
  keyFingerprint,
  unwrapItemKey,
} from "@stubwise/vault-crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { actorChallengeDouble } from "../../test/vault-actor-challenge";
import { PendingAccessPanel } from "./pending-access";

/**
 * «Accessi da confermare» (design «Lettori che arrivano dopo, e la
 * conferma»). La cassaforte è un doppio controllabile; la crittografia è
 * VERA, così il test prova che le copie mandate al server si aprono con la
 * chiave della persona confermata.
 */

const vaultMock = vi.hoisted(() => ({
  state: "locked" as string,
  privateKey: null as CryptoKey | null,
  personKeyId: null as string | null,
  unlockKey: null as { privateKey: CryptoKey; personKeyId: string } | null,
  version: 0,
  listeners: new Set<() => void>(),
}));

function setVault(patch: Partial<typeof vaultMock>) {
  Object.assign(vaultMock, patch);
  vaultMock.version += 1;
  vaultMock.listeners.forEach((listener) => listener());
}

const unlockSpy = vi.hoisted(() => vi.fn());

vi.mock("../../lib/vault/vault-context", async () => {
  const React = await import("react");
  return {
    useVault: () => {
      React.useSyncExternalStore(
        (listener: () => void) => {
          vaultMock.listeners.add(listener);
          return () => vaultMock.listeners.delete(listener);
        },
        () => vaultMock.version,
      );
      return {
        state: vaultMock.state,
        privateKey: vaultMock.privateKey,
        personKeyId: vaultMock.personKeyId,
        unlock: async () => {
          unlockSpy();
          const key = vaultMock.unlockKey!;
          setVault({ state: "unlocked", privateKey: key.privateKey, personKeyId: key.personKeyId });
        },
        lock: () => setVault({ state: "locked", privateKey: null, personKeyId: null }),
        activate: async () => undefined,
        recreateKey: async () => undefined,
      };
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const BEA_ID = "40000000-0000-4000-8000-000000000002";
const CARL_ID = "40000000-0000-4000-8000-000000000003";
const MY_KEY_ID = "50000000-0000-4000-8000-000000000001";
const BEA_KEY_ID = "50000000-0000-4000-8000-000000000002";
const CARL_KEY_ID = "50000000-0000-4000-8000-000000000003";
const HETZNER = "60000000-0000-4000-8000-000000000001";
const GITHUB = "60000000-0000-4000-8000-000000000002";
const PASSWORDS: Record<string, string> = { [HETZNER]: "hetzner-pw", [GITHUB]: "github-pw" };

let mine: Awaited<ReturnType<typeof generatePersonKeyPair>>;
let bea: Awaited<ReturnType<typeof generatePersonKeyPair>>;
let carl: Awaited<ReturnType<typeof generatePersonKeyPair>>;
/** Le password cifrate, come le tiene il server (per verificare le copie). */
const ciphertexts: Record<string, string> = {};
/** Le MIE copie della chiave di ogni credenziale. */
const myCopies: Record<string, string> = {};

beforeAll(async () => {
  mine = await generatePersonKeyPair();
  bea = await generatePersonKeyPair();
  carl = await generatePersonKeyPair();
  for (const id of [HETZNER, GITHUB]) {
    const { passwordCiphertext, copies } = await encryptForInsert({
      credentialId: id,
      password: PASSWORDS[id]!,
      recipients: [{ recipientId: MY_KEY_ID, publicKey: mine.publicKey }],
    });
    ciphertexts[id] = passwordCiphertext;
    myCopies[id] = copies[0]!.wrappedKey;
  }
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();
let requests: { method: string; path: string; body: unknown }[];
/** La sfida di possesso della MIA chiave: il server finto la cifra davvero per lei. */
const actor = actorChallengeDouble(() => ({ personKeyId: MY_KEY_ID, publicKey: mine.publicKey }));

function mockApi(handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  handlers = { "POST /api/vault/actor-challenge": () => actor.respond(), ...handlers };
  fetchMock.mockImplementation(async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) return jsonResponse(500, { message: `fetch non mockata per ${method} ${raw}` });
    return handler(init);
  });
}

/**
 * Una persona in attesa. `device` è assente apposta in Carl: il web non parsa
 * le risposte, quindi un campo che manca va difeso a lettura (CLAUDE.md).
 */
function pendingItems() {
  return {
    items: [
      {
        user: { id: BEA_ID, email: "bea@example.com" },
        personKey: {
          id: BEA_KEY_ID,
          status: "pending",
          createdAt: "2026-10-22T08:30:00.000Z",
          device: "Firefox su macOS",
          fingerprintSource: bea.publicKey,
        },
        credentials: [
          { id: HETZNER, projectId: PROJECT_ID, service: "Hetzner", label: "Main", wrappedKey: myCopies[HETZNER], keyVersion: "v-h" },
          { id: GITHUB, projectId: PROJECT_ID, service: "GitHub", label: null, wrappedKey: myCopies[GITHUB], keyVersion: "v-g" },
        ],
      },
      {
        user: { id: CARL_ID, email: "carl@example.com" },
        personKey: {
          id: CARL_KEY_ID,
          status: "pending",
          createdAt: "2026-10-21T08:30:00.000Z",
          fingerprintSource: carl.publicKey,
        },
        credentials: [
          { id: GITHUB, projectId: PROJECT_ID, service: "GitHub", label: null, wrappedKey: myCopies[GITHUB], keyVersion: "v-g" },
        ],
      },
    ],
  };
}

beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", fetchMock);
  unlockSpy.mockReset();
  vaultMock.unlockKey = { privateKey: mine.privateKey, personKeyId: MY_KEY_ID };
  setVault({ state: "locked", privateKey: null, personKeyId: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PendingAccessPanel />
    </QueryClientProvider>,
  );
  return queryClient;
}

function personCard(email: string) {
  return screen.getByRole("group", { name: email });
}

describe("accessi da confermare", () => {
  it("mostra persona, data della chiave, dispositivo, impronta e numero di credenziali, con l'invito a verificare", async () => {
    mockApi({ "GET /api/vault/pending": () => jsonResponse(200, pendingItems()) });
    renderPanel();

    const panel = await screen.findByRole("region", { name: /Access to confirm/ });
    // Il conteggio delle persone in attesa.
    expect(within(panel).getByTestId("pending-access-count")).toHaveTextContent("2");
    expect(within(panel).getByText(/check with the person/i)).toBeInTheDocument();

    const beaCard = personCard("bea@example.com");
    expect(within(beaCard).getByText(/22\/10\/2026/)).toBeInTheDocument();
    expect(within(beaCard).getByText(/Firefox su macOS/)).toBeInTheDocument();
    expect(within(beaCard).getByText(/2 credentials/)).toBeInTheDocument();
    expect(within(beaCard).getByText(/Hetzner · Main/)).toBeInTheDocument();
    const fingerprint = await keyFingerprint(bea.publicKey);
    expect(await within(beaCard).findByText(fingerprint)).toBeInTheDocument();

    // Campo assente: dispositivo sconosciuto, nessun crash.
    const carlCard = personCard("carl@example.com");
    expect(within(carlCard).getByText(/unknown device/i)).toBeInTheDocument();
    expect(within(carlCard).getByText(/1 credential\b/)).toBeInTheDocument();
    expect(await within(carlCard).findByText(await keyFingerprint(carl.publicKey))).toBeInTheDocument();
  });

  it("niente in attesa: il pannello non c'è", async () => {
    mockApi({ "GET /api/vault/pending": () => jsonResponse(200, { items: [] }) });
    renderPanel();
    await waitFor(() => expect(requests.some((r) => r.path === "/api/vault/pending")).toBe(true));
    expect(screen.queryByRole("region", { name: /Access to confirm/ })).not.toBeInTheDocument();
  });

  it("«Conferma» chiede la verifica, sblocca, ricifra le chiavi per la persona e chiama confirm", async () => {
    let listed = pendingItems();
    mockApi({
      "GET /api/vault/pending": () => jsonResponse(200, listed),
      [`POST /api/vault/pending/${BEA_KEY_ID}/confirm`]: () => {
        listed = { items: listed.items.filter((p) => p.personKey.id !== BEA_KEY_ID) };
        return jsonResponse(200, {
          personKeyId: BEA_KEY_ID,
          status: "confirmed",
          saved: [HETZNER, GITHUB],
          skipped: [],
        });
      },
    });
    const user = userEvent.setup();
    renderPanel();

    const card = await screen.findByRole("group", { name: "bea@example.com" });
    await user.click(within(card).getByRole("button", { name: "Confirm bea@example.com" }));
    // Prima la domanda esplicita: nulla è partito.
    expect(requests.some((r) => r.method === "POST")).toBe(false);
    await user.click(within(card).getByRole("button", { name: "Yes, I checked: confirm" }));

    // Cassaforte chiusa: prima lo sblocco.
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Use passkey" }));
    expect(unlockSpy).toHaveBeenCalledTimes(1);

    await waitFor(() =>
      expect(requests.some((r) => r.path === `/api/vault/pending/${BEA_KEY_ID}/confirm`)).toBe(true),
    );
    const body = requests.find((r) => r.path === `/api/vault/pending/${BEA_KEY_ID}/confirm`)!.body as {
      copies: { credentialId: string; wrappedKey: string; keyVersion: string }[];
      viaRecovery?: unknown;
      actorProof?: unknown;
    };
    expect(body.viaRecovery).toBeUndefined();
    // La prova che la MIA chiave è aperta: la sfida aperta con la mia privata.
    expect(actor.valid(body.actorProof)).toBe(true);
    expect(body.copies.map((c) => [c.credentialId, c.keyVersion])).toEqual([
      [HETZNER, "v-h"],
      [GITHUB, "v-g"],
    ]);
    // Le copie si aprono con la chiave di Bea (AAD = credenziale + chiave di Bea).
    for (const copy of body.copies) {
      const itemKey = await unwrapItemKey(copy.wrappedKey, bea.privateKey, copy.credentialId, BEA_KEY_ID);
      expect(await decryptPassword(copy.credentialId, ciphertexts[copy.credentialId]!, itemKey)).toBe(
        PASSWORDS[copy.credentialId],
      );
    }
    // Nessuna password in chiaro in nessun corpo.
    const sent = JSON.stringify(requests.map((r) => r.body));
    expect(sent).not.toContain("hetzner-pw");
    expect(sent).not.toContain("github-pw");

    expect(await screen.findByText(/bea@example.com now reads 2 credentials/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("group", { name: "bea@example.com" })).not.toBeInTheDocument());
  });

  it("annullare lo sblocco annulla la conferma: niente parte, niente errore, si può riprovare", async () => {
    mockApi({ "GET /api/vault/pending": () => jsonResponse(200, pendingItems()) });
    const user = userEvent.setup();
    renderPanel();
    const card = await screen.findByRole("group", { name: "bea@example.com" });
    await user.click(within(card).getByRole("button", { name: "Confirm bea@example.com" }));
    await user.click(within(card).getByRole("button", { name: "Yes, I checked: confirm" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Yes, I checked: confirm" })).toBeEnabled();
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("una credenziale cambiata nel frattempo resta in attesa, e lo dice", async () => {
    setVault({ state: "unlocked", privateKey: mine.privateKey, personKeyId: MY_KEY_ID });
    mockApi({
      "GET /api/vault/pending": () => jsonResponse(200, pendingItems()),
      [`POST /api/vault/pending/${CARL_KEY_ID}/confirm`]: () =>
        jsonResponse(200, {
          personKeyId: CARL_KEY_ID,
          status: "confirmed",
          saved: [],
          skipped: [{ credentialId: GITHUB, reason: "key_changed" }],
        }),
    });
    const user = userEvent.setup();
    renderPanel();
    const card = await screen.findByRole("group", { name: "carl@example.com" });
    await user.click(within(card).getByRole("button", { name: "Confirm carl@example.com" }));
    await user.click(within(card).getByRole("button", { name: "Yes, I checked: confirm" }));
    expect(await screen.findByText(/changed in the meantime/)).toBeInTheDocument();
    expect(unlockSpy).not.toHaveBeenCalled();
  });

  it("«Rifiuta» chiede conferma e chiama reject, senza mandare copie", async () => {
    setVault({ state: "unlocked", privateKey: mine.privateKey, personKeyId: MY_KEY_ID });
    mockApi({
      "GET /api/vault/pending": () => jsonResponse(200, pendingItems()),
      [`POST /api/vault/pending/${BEA_KEY_ID}/reject`]: () => jsonResponse(204, null),
    });
    const user = userEvent.setup();
    renderPanel();
    const card = await screen.findByRole("group", { name: "bea@example.com" });
    await user.click(within(card).getByRole("button", { name: "Reject bea@example.com" }));
    expect(requests.some((r) => r.method === "POST")).toBe(false);
    await user.click(within(card).getByRole("button", { name: "Yes, reject the key" }));
    await waitFor(() =>
      expect(requests.some((r) => r.method === "POST" && r.path === `/api/vault/pending/${BEA_KEY_ID}/reject`)).toBe(
        true,
      ),
    );
    expect(requests.some((r) => r.path.endsWith("/confirm"))).toBe(false);
    const sent = requests.find((r) => r.path === `/api/vault/pending/${BEA_KEY_ID}/reject`)!.body as {
      actorProof?: unknown;
      copies?: unknown;
    };
    expect(actor.valid(sent.actorProof)).toBe(true);
    expect(sent.copies).toBeUndefined();
  });

  it("nessuna copia si apre in questo browser: la conferma NON parte, e lo spiega", async () => {
    setVault({ state: "unlocked", privateKey: mine.privateKey, personKeyId: MY_KEY_ID });
    const broken = pendingItems();
    // Le copie di Carl sono per un'altra chiave: non si aprono con la mia.
    broken.items[1]!.credentials = broken.items[1]!.credentials.map((c) => ({ ...c, wrappedKey: myCopies[HETZNER]! }));
    mockApi({ "GET /api/vault/pending": () => jsonResponse(200, broken) });
    const user = userEvent.setup();
    renderPanel();
    const card = await screen.findByRole("group", { name: "carl@example.com" });
    await user.click(within(card).getByRole("button", { name: "Confirm carl@example.com" }));
    await user.click(within(card).getByRole("button", { name: "Yes, I checked: confirm" }));
    expect(await within(card).findByText(/None of the credentials opened in this browser/)).toBeInTheDocument();
    expect(requests.some((r) => r.path.endsWith("/confirm"))).toBe(false);
    expect(requests.some((r) => r.path === "/api/vault/actor-challenge")).toBe(false);
  });

  it("cassaforte non attiva: nessuna richiesta", () => {
    setVault({ state: "inactive" });
    mockApi({});
    renderPanel();
    expect(requests).toEqual([]);
  });
});
