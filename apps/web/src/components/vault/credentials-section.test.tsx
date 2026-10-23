import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  decryptPassword,
  encryptForInsert,
  generatePersonKeyPair,
  generateRecoveryKit,
  unwrapItemKey,
} from "@stubwise/vault-crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialItem } from "../../lib/api";
import { seedMe } from "../../test/me";
import { CredentialsSection } from "./credentials-section";

/**
 * Sezione «Credenziali» del progetto (design «Mostrare e copiare», «Revoca»,
 * «Dove sta nella web»). La cassaforte è un doppio controllabile
 * (`useVault`); la crittografia è VERA (`@stubwise/vault-crypto`), così i
 * test provano che le copie inviate al server si aprono con la chiave giusta.
 */

type FakeVaultState = "inactive" | "locked" | "unlocked" | "no_key" | "unsupported";

const vaultMock = vi.hoisted(() => ({
  state: "locked" as FakeVaultState,
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
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ME_ID = "40000000-0000-4000-8000-000000000001";
const BEA_ID = "40000000-0000-4000-8000-000000000002";
const CARL_ID = "40000000-0000-4000-8000-000000000003";
const MY_KEY_ID = "50000000-0000-4000-8000-000000000001";
const BEA_KEY_ID = "50000000-0000-4000-8000-000000000002";
const CARL_KEY_ID = "50000000-0000-4000-8000-000000000003";
const HETZNER_MAIN = "60000000-0000-4000-8000-000000000001";
const HETZNER_RO = "60000000-0000-4000-8000-000000000002";
const GITHUB = "60000000-0000-4000-8000-000000000003";
const PASSWORD = "s3cret-Hetzner!";

let mine: Awaited<ReturnType<typeof generatePersonKeyPair>>;
let bea: Awaited<ReturnType<typeof generatePersonKeyPair>>;
let carl: Awaited<ReturnType<typeof generatePersonKeyPair>>;
let recoveryPublicKey: string;

beforeAll(async () => {
  mine = await generatePersonKeyPair();
  bea = await generatePersonKeyPair();
  carl = await generatePersonKeyPair();
  recoveryPublicKey = (await generateRecoveryKit()).publicKey;
});

/**
 * Una credenziale dell'elenco. Senza `canEdit`/`canShare`: sono campi
 * aggiunti dopo e il web, che non parsa, li deve difendere a lettura
 * (CLAUDE.md) — i test che li vogliono li aggiungono.
 */
function item(
  overrides: Partial<CredentialItem> & { id: string; service: string },
): CredentialItem {
  return {
    projectId: PROJECT_ID,
    label: null,
    url: null,
    username: null,
    notes: null,
    createdByUserId: ME_ID,
    createdAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
    updatedByUserId: ME_ID,
    access: "read",
    ...overrides,
  } as CredentialItem;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();
let requests: { method: string; path: string; body: unknown }[];

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function mockApi(handlers: Record<string, Handler>) {
  fetchMock.mockImplementation(async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    requests.push({
      method,
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) return jsonResponse(500, { message: `fetch non mockata per ${method} ${raw}` });
    return handler(url, init);
  });
}

const listPath = `/api/projects/${PROJECT_ID}/credentials`;
const statusConfirmed = () =>
  jsonResponse(200, {
    activated: true,
    myKey: { id: MY_KEY_ID, status: "confirmed", createdAt: "2026-10-23T09:00:00.000Z" },
    seals: [],
  });

beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", fetchMock);
  unlockSpy.mockReset();
  vaultMock.unlockKey = { privateKey: mine.privateKey, personKeyId: MY_KEY_ID };
  setVault({ state: "locked", privateKey: null, personKeyId: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function renderSection(projectPermissions: string[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedMe(
    queryClient,
    { instancePermissions: [], projectPermissions: { [PROJECT_ID]: projectPermissions } },
    { id: ME_ID, email: "ada@example.com", role: "member" },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <CredentialsSection projectId={PROJECT_ID} />
    </QueryClientProvider>,
  );
  return queryClient;
}

/** La password cifrata e la copia per la mia chiave, come le darebbe `reveal`. */
async function revealFor(credentialId: string, password = PASSWORD) {
  const { passwordCiphertext, copies } = await encryptForInsert({
    credentialId,
    password,
    recipients: [{ recipientId: MY_KEY_ID, publicKey: mine.publicKey }],
  });
  return { passwordCiphertext, wrappedKey: copies[0]!.wrappedKey, personKeyId: MY_KEY_ID };
}

describe("sezione Credenziali del progetto", () => {
  it("elenca le credenziali raggruppate per servizio con etichetta, utente e URL — mai la password", async () => {
    mockApi({
      "GET /api/vault/status": statusConfirmed,
      [`GET ${listPath}`]: () =>
        jsonResponse(200, {
          items: [
            item({
              id: HETZNER_MAIN,
              service: "Hetzner",
              label: "Main account",
              username: "ops@example.com",
              url: "https://console.hetzner.cloud",
            }),
            item({
              id: HETZNER_RO,
              service: "Hetzner",
              label: "Read only",
              username: "ro@example.com",
            }),
            item({ id: GITHUB, service: "GitHub", username: "bot" }),
          ],
        }),
    });
    renderSection();

    const hetzner = await screen.findByRole("region", { name: "Hetzner" });
    expect(within(hetzner).getAllByRole("listitem")).toHaveLength(2);
    const main = within(hetzner).getByRole("listitem", { name: "Hetzner · Main account" });
    expect(within(main).getByText("ops@example.com")).toBeInTheDocument();
    expect(
      within(main).getByRole("link", { name: "https://console.hetzner.cloud" }),
    ).toHaveAttribute("href", "https://console.hetzner.cloud");
    const github = screen.getByRole("region", { name: "GitHub" });
    expect(within(github).getByText("bot")).toBeInTheDocument();
    // Nessuna lettura senza un gesto: la password non c'è, e reveal non è partita.
    expect(screen.queryByText(PASSWORD)).not.toBeInTheDocument();
    expect(requests.some((r) => r.path.endsWith("/reveal"))).toBe(false);
  });

  it("«Mostra» a cassaforte chiusa chiede lo sblocco, poi mostra la password; chiudendo la cassaforte sparisce", async () => {
    const user = userEvent.setup();
    const revealed = await revealFor(HETZNER_MAIN);
    mockApi({
      "GET /api/vault/status": statusConfirmed,
      [`GET ${listPath}`]: () =>
        jsonResponse(200, {
          items: [item({ id: HETZNER_MAIN, service: "Hetzner", label: "Main account" })],
        }),
      [`POST /api/credentials/${HETZNER_MAIN}/reveal`]: () => jsonResponse(200, revealed),
    });
    renderSection();

    await user.click(
      await screen.findByRole("button", { name: "Show the password of Hetzner · Main account" }),
    );
    // Chiusa: prima il dialogo della passkey, nessuna lettura ancora.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Open the vault")).toBeInTheDocument();
    expect(requests.some((r) => r.path.endsWith("/reveal"))).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Use passkey" }));
    expect(unlockSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(PASSWORD)).toBeInTheDocument();
    expect(requests.find((r) => r.path.endsWith("/reveal"))?.body).toEqual({ action: "show" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    setVault({ state: "locked", privateKey: null, personKeyId: null });
    await waitFor(() => expect(screen.queryByText(PASSWORD)).not.toBeInTheDocument());
  });

  it("«Copia» scrive negli appunti e li svuota dopo 30 secondi, solo se contengono ancora la password", async () => {
    const revealed = await revealFor(HETZNER_MAIN);
    mockApi({
      "GET /api/vault/status": statusConfirmed,
      [`GET ${listPath}`]: () =>
        jsonResponse(200, {
          items: [
            item({ id: HETZNER_MAIN, service: "Hetzner", label: "Main account" }),
            item({ id: GITHUB, service: "GitHub" }),
          ],
        }),
      [`POST /api/credentials/${HETZNER_MAIN}/reveal`]: () => jsonResponse(200, revealed),
      [`POST /api/credentials/${GITHUB}/reveal`]: async () =>
        jsonResponse(200, await revealFor(GITHUB, "gh-pass")),
    });
    let clipboard = "";
    const writeText = vi.fn(async (text: string) => {
      clipboard = text;
    });
    const readText = vi.fn(async () => clipboard);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText, readText },
      configurable: true,
    });
    setVault({ state: "unlocked", privateKey: mine.privateKey, personKeyId: MY_KEY_ID });
    renderSection();

    const copy = await screen.findByRole("button", {
      name: "Copy the password of Hetzner · Main account",
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(copy);
    await vi.waitFor(() => expect(clipboard).toBe(PASSWORD));
    expect(requests.find((r) => r.path.endsWith("/reveal"))?.body).toEqual({ action: "copy" });
    // Copiare non la mostra.
    expect(screen.queryByText(PASSWORD)).not.toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(29_000);
    expect(clipboard).toBe(PASSWORD);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(clipboard).toBe(""));

    // Se nel frattempo la persona ha copiato altro, gli appunti restano suoi.
    fireEvent.click(screen.getByRole("button", { name: "Copy the password of GitHub" }));
    await vi.waitFor(() => expect(clipboard).toBe("gh-pass"));
    clipboard = "something else";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clipboard).toBe("something else");
  });

  it("se il browser non lascia rileggere gli appunti, li svuota comunque", async () => {
    const revealed = await revealFor(GITHUB, "gh-pass");
    mockApi({
      "GET /api/vault/status": statusConfirmed,
      [`GET ${listPath}`]: () =>
        jsonResponse(200, { items: [item({ id: GITHUB, service: "GitHub" })] }),
      [`POST /api/credentials/${GITHUB}/reveal`]: () => jsonResponse(200, revealed),
    });
    let clipboard = "";
    const writeText = vi.fn(async (text: string) => {
      clipboard = text;
    });
    const readText = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText, readText },
      configurable: true,
    });
    setVault({ state: "unlocked", privateKey: mine.privateKey, personKeyId: MY_KEY_ID });
    renderSection();

    const copy = await screen.findByRole("button", { name: "Copy the password of GitHub" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(copy);
    await vi.waitFor(() => expect(clipboard).toBe("gh-pass"));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(clipboard).toBe(""));
  });

  it("creazione: cifra per i destinatari del server; su 409 recipients_changed ricifra per i nuovi e riprova una volta", async () => {
    const user = userEvent.setup();
    const posts: Record<string, unknown>[] = [];
    const first = {
      people: [
        {
          userId: ME_ID,
          email: "ada@example.com",
          personKeyId: MY_KEY_ID,
          publicKey: mine.publicKey,
        },
      ],
      recoveryPublicKey,
    };
    const current = {
      people: [
        ...first.people,
        {
          userId: BEA_ID,
          email: "bea@example.com",
          personKeyId: BEA_KEY_ID,
          publicKey: bea.publicKey,
        },
      ],
      recoveryPublicKey,
    };
    mockApi({
      "GET /api/vault/status": statusConfirmed,
      [`GET ${listPath}`]: () => jsonResponse(200, { items: [] }),
      [`GET ${listPath}/recipients`]: () => jsonResponse(200, first),
      [`POST ${listPath}`]: (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        posts.push(body);
        if (posts.length === 1) {
          return jsonResponse(409, {
            code: "recipients_changed",
            message: "The recipients changed",
            recipients: current,
          });
        }
        return jsonResponse(201, item({ id: String(body.id), service: "Hetzner" }));
      },
    });
    renderSection(["credentials.create"]);

    await user.click(await screen.findByRole("button", { name: "New credential" }));
    const form = screen.getByRole("form", { name: "New credential" });
    await user.type(within(form).getByLabelText("Service"), "Hetzner");
    await user.type(within(form).getByLabelText("Label"), "Main account");
    await user.type(within(form).getByLabelText("Username"), "ops@example.com");
    await user.type(within(form).getByLabelText("Password"), PASSWORD);
    await user.type(within(form).getByLabelText("Notes"), "2FA on the phone");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(posts).toHaveLength(2));
    // Nessuna richiesta porta la password in chiaro.
    for (const request of requests)
      expect(JSON.stringify(request.body ?? "")).not.toContain(PASSWORD);

    const [attempt1, attempt2] = posts as Array<{
      id: string;
      service: string;
      label: string;
      username: string;
      notes: string;
      passwordCiphertext: string;
      copies: { recipientId: string; wrappedKey: string }[];
      recoveryPublicKey: string;
    }>;
    expect(attempt1!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(attempt2!.id).toBe(attempt1!.id);
    expect(attempt1!.copies.map((c) => c.recipientId)).toEqual([MY_KEY_ID, "recovery"]);
    expect(attempt2!.copies.map((c) => c.recipientId)).toEqual([MY_KEY_ID, BEA_KEY_ID, "recovery"]);
    expect(attempt2!.recoveryPublicKey).toBe(recoveryPublicKey);
    expect(attempt2).toMatchObject({
      service: "Hetzner",
      label: "Main account",
      username: "ops@example.com",
      notes: "2FA on the phone",
    });

    // La copia per Bea (arrivata col 409) apre davvero la password.
    const beaCopy = attempt2!.copies.find((c) => c.recipientId === BEA_KEY_ID)!;
    const itemKey = await unwrapItemKey(
      beaCopy.wrappedKey,
      bea.privateKey,
      attempt2!.id,
      BEA_KEY_ID,
    );
    expect(await decryptPassword(attempt2!.id, attempt2!.passwordCiphertext, itemKey)).toBe(
      PASSWORD,
    );

    // Lo sblocco non serve per creare: solo chiavi pubbliche.
    expect(unlockSpy).not.toHaveBeenCalled();
  });

  it("il form dice, accanto alle note, che non sono cifrate", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/vault/status": statusConfirmed,
      [`GET ${listPath}`]: () => jsonResponse(200, { items: [] }),
    });
    renderSection(["credentials.create"]);

    await user.click(await screen.findByRole("button", { name: "New credential" }));
    const notes = screen.getByLabelText("Notes");
    expect(notes).toHaveAccessibleDescription(
      "Notes are not encrypted: do not write secrets here.",
    );
  });

  it("senza credentials.create non c'è «Nuova credenziale»", async () => {
    mockApi({
      "GET /api/vault/status": statusConfirmed,
      [`GET ${listPath}`]: () =>
        jsonResponse(200, { items: [item({ id: GITHUB, service: "GitHub" })] }),
    });
    renderSection();
    await screen.findByRole("region", { name: "GitHub" });
    expect(screen.queryByRole("button", { name: "New credential" })).not.toBeInTheDocument();
  });

  it("il pannello lettori c'è solo con canShare (share + lettore, calcolato dal server)", async () => {
    mockApi({
      "GET /api/vault/status": statusConfirmed,
      [`GET ${listPath}`]: () =>
        jsonResponse(200, {
          items: [
            // Fixture senza canShare: il web lo difende a lettura.
            item({ id: GITHUB, service: "GitHub" }),
            item({ id: HETZNER_RO, service: "Hetzner", label: "Read only", canShare: false }),
            item({ id: HETZNER_MAIN, service: "Hetzner", label: "Main account", canShare: true }),
          ],
        }),
    });
    renderSection(["credentials.share"]);

    await screen.findByRole("region", { name: "GitHub" });
    expect(screen.queryByRole("button", { name: "Readers of GitHub" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Readers of Hetzner · Read only" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Readers of Hetzner · Main account" }),
    ).toBeInTheDocument();
  });

  it("condividere con una persona: sblocca, apre la propria copia e la ricifra per lei", async () => {
    const user = userEvent.setup();
    const shared: Record<string, unknown>[] = [];
    const encrypted = await encryptForInsert({
      credentialId: HETZNER_MAIN,
      password: PASSWORD,
      recipients: [{ recipientId: MY_KEY_ID, publicKey: mine.publicKey }],
    });
    const readersView = {
      readers: [
        {
          id: "70000000-0000-4000-8000-000000000001",
          userId: ME_ID,
          email: "ada@example.com",
          roleId: null,
          roleName: null,
          createdAt: "2026-10-23T10:00:00.000Z",
        },
      ],
      people: [
        {
          userId: ME_ID,
          email: "ada@example.com",
          fullAdmin: false,
          status: "can_read",
          keyStatus: "confirmed",
        },
      ],
    };
    mockApi({
      "GET /api/vault/status": statusConfirmed,
      [`GET ${listPath}`]: () =>
        jsonResponse(200, {
          items: [item({ id: HETZNER_MAIN, service: "Hetzner", canShare: true })],
        }),
      [`GET /api/projects/${PROJECT_ID}/members`]: () =>
        jsonResponse(200, [
          {
            userId: ME_ID,
            email: "ada@example.com",
            avatarUrl: null,
            roleId: "r1",
            roleName: "Project Lead",
            createdAt: "2026-10-22T10:00:00.000Z",
          },
          {
            userId: CARL_ID,
            email: "carl@example.com",
            avatarUrl: null,
            roleId: "r2",
            roleName: "Developer",
            createdAt: "2026-10-22T10:00:00.000Z",
          },
        ]),
      [`GET /api/credentials/${HETZNER_MAIN}/readers`]: () => jsonResponse(200, readersView),
      [`GET /api/credentials/${HETZNER_MAIN}/readers/preview`]: (url) => {
        expect(url.searchParams.get("userId")).toBe(CARL_ID);
        return jsonResponse(200, {
          people: [
            {
              userId: CARL_ID,
              email: "carl@example.com",
              personKeyId: CARL_KEY_ID,
              publicKey: carl.publicKey,
            },
          ],
          waiting: [],
          wrappedKey: encrypted.copies[0]!.wrappedKey,
          keyVersion: "v-1",
        });
      },
      [`POST /api/credentials/${HETZNER_MAIN}/readers`]: (_url, init) => {
        shared.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse(200, readersView);
      },
    });
    renderSection(["credentials.share"]);

    await user.click(await screen.findByRole("button", { name: "Readers of Hetzner" }));
    const panel = await screen.findByRole("region", { name: "Readers of Hetzner" });
    await waitFor(() =>
      expect(within(panel).getByRole("option", { name: "carl@example.com" })).toBeInTheDocument(),
    );
    await user.selectOptions(within(panel).getByLabelText("Share with"), `user:${CARL_ID}`);
    await user.click(within(panel).getByRole("button", { name: "Share" }));

    // Chiusa: prima lo sblocco.
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Use passkey" }));

    await waitFor(() => expect(shared).toHaveLength(1));
    const body = shared[0] as {
      userId: string;
      keyVersion: string;
      copies: { recipientId: string; wrappedKey: string }[];
    };
    expect(body.userId).toBe(CARL_ID);
    expect(body.keyVersion).toBe("v-1");
    expect(body.copies.map((c) => c.recipientId)).toEqual([CARL_KEY_ID]);
    const itemKey = await unwrapItemKey(
      body.copies[0]!.wrappedKey,
      carl.privateKey,
      HETZNER_MAIN,
      CARL_KEY_ID,
    );
    expect(await decryptPassword(HETZNER_MAIN, encrypted.passwordCiphertext, itemKey)).toBe(
      PASSWORD,
    );
  });

  it("dopo una revoca propone di cambiare la password", async () => {
    const user = userEvent.setup();
    const readerId = "70000000-0000-4000-8000-000000000002";
    const before = {
      readers: [
        {
          id: readerId,
          userId: BEA_ID,
          email: "bea@example.com",
          roleId: null,
          roleName: null,
          createdAt: "2026-10-23T10:00:00.000Z",
        },
      ],
      people: [
        {
          userId: ME_ID,
          email: "ada@example.com",
          fullAdmin: false,
          status: "can_read",
          keyStatus: "confirmed",
        },
        {
          userId: BEA_ID,
          email: "bea@example.com",
          fullAdmin: false,
          status: "can_read",
          keyStatus: "confirmed",
        },
      ],
    };
    const after = { readers: [], people: [before.people[0]] };
    let deleted = false;
    mockApi({
      "GET /api/vault/status": statusConfirmed,
      [`GET ${listPath}`]: () =>
        jsonResponse(200, {
          items: [item({ id: HETZNER_MAIN, service: "Hetzner", canShare: true, canEdit: true })],
        }),
      [`GET /api/projects/${PROJECT_ID}/members`]: () => jsonResponse(200, []),
      [`GET /api/credentials/${HETZNER_MAIN}/readers`]: () =>
        jsonResponse(200, deleted ? after : before),
      [`DELETE /api/credentials/${HETZNER_MAIN}/readers/${readerId}`]: () => {
        deleted = true;
        return jsonResponse(200, after);
      },
    });
    renderSection(["credentials.share", "credentials.edit"]);

    await user.click(await screen.findByRole("button", { name: "Readers of Hetzner" }));
    const panel = await screen.findByRole("region", { name: "Readers of Hetzner" });
    await user.click(await within(panel).findByRole("button", { name: "Remove bea@example.com" }));

    const notice = await within(panel).findByRole("status");
    expect(notice).toHaveTextContent("bea@example.com no longer reads this credential");
    await user.click(within(notice).getByRole("button", { name: "Change the password" }));
    const form = await screen.findByRole("form", { name: "Edit Hetzner" });
    expect(within(form).getByLabelText("New password")).toHaveFocus();
  });

  it("cambiare la password: cifra per i destinatari attuali della credenziale", async () => {
    const user = userEvent.setup();
    const puts: Record<string, unknown>[] = [];
    mockApi({
      "GET /api/vault/status": statusConfirmed,
      [`GET ${listPath}`]: () =>
        jsonResponse(200, {
          items: [item({ id: HETZNER_MAIN, service: "Hetzner", canEdit: true })],
        }),
      [`PATCH /api/credentials/${HETZNER_MAIN}`]: () =>
        jsonResponse(200, item({ id: HETZNER_MAIN, service: "Hetzner" })),
      [`GET /api/credentials/${HETZNER_MAIN}/recipients`]: () =>
        jsonResponse(200, {
          people: [
            {
              userId: BEA_ID,
              email: "bea@example.com",
              personKeyId: BEA_KEY_ID,
              publicKey: bea.publicKey,
            },
          ],
          recoveryPublicKey,
        }),
      [`PUT /api/credentials/${HETZNER_MAIN}/password`]: (_url, init) => {
        puts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse(200, item({ id: HETZNER_MAIN, service: "Hetzner" }));
      },
    });
    renderSection(["credentials.edit"]);

    await user.click(await screen.findByRole("button", { name: "Edit Hetzner" }));
    const form = screen.getByRole("form", { name: "Edit Hetzner" });
    await user.type(within(form).getByLabelText("New password"), "new-pass");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(puts).toHaveLength(1));
    const body = puts[0] as {
      passwordCiphertext: string;
      copies: { recipientId: string; wrappedKey: string }[];
      recoveryPublicKey: string;
    };
    expect(body.copies.map((c) => c.recipientId)).toEqual([BEA_KEY_ID, "recovery"]);
    expect(body.recoveryPublicKey).toBe(recoveryPublicKey);
    const itemKey = await unwrapItemKey(
      body.copies[0]!.wrappedKey,
      bea.privateKey,
      HETZNER_MAIN,
      BEA_KEY_ID,
    );
    expect(await decryptPassword(HETZNER_MAIN, body.passwordCiphertext, itemKey)).toBe("new-pass");
  });

  it("il registro delle letture si vede solo con credentials.share o credentials.edit", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/vault/status": statusConfirmed,
      [`GET ${listPath}`]: () =>
        jsonResponse(200, { items: [item({ id: GITHUB, service: "GitHub" })] }),
      [`GET ${listPath}/log`]: () =>
        jsonResponse(200, {
          items: [
            {
              id: "80000000-0000-4000-8000-000000000001",
              credentialId: GITHUB,
              credentialSnapshot: "GitHub",
              userId: BEA_ID,
              userEmail: "bea@example.com",
              action: "copy",
              createdAt: "2026-10-23T11:00:00.000Z",
            },
          ],
        }),
    });
    renderSection(["credentials.share"]);

    await user.click(await screen.findByRole("button", { name: "Access log" }));
    const log = await screen.findByRole("table", { name: "Access log" });
    const row = await within(log).findByRole("row", { name: /bea@example.com/ });
    expect(row).toHaveTextContent("GitHub");
    expect(row).toHaveTextContent("copied");
  });

  it("senza permessi di gestione il registro non c'è e non si chiede", async () => {
    mockApi({
      "GET /api/vault/status": statusConfirmed,
      [`GET ${listPath}`]: () =>
        jsonResponse(200, { items: [item({ id: GITHUB, service: "GitHub" })] }),
    });
    renderSection(["credentials.create"]);
    await screen.findByRole("region", { name: "GitHub" });
    expect(screen.queryByRole("button", { name: "Access log" })).not.toBeInTheDocument();
    expect(requests.some((r) => r.path.endsWith("/log"))).toBe(false);
  });

  it("una chiave in attesa lo dice, e una credenziale in attesa non offre Mostra/Copia", async () => {
    mockApi({
      "GET /api/vault/status": () =>
        jsonResponse(200, {
          activated: true,
          myKey: { id: MY_KEY_ID, status: "pending", createdAt: "2026-10-23T09:00:00.000Z" },
          seals: [],
        }),
      [`GET ${listPath}`]: () =>
        jsonResponse(200, {
          items: [
            item({ id: GITHUB, service: "GitHub", access: "pending" }),
            item({ id: HETZNER_MAIN, service: "Hetzner", access: "manage" }),
          ],
        }),
    });
    renderSection(["credentials.edit"]);

    expect(
      await screen.findByText(/Your vault key is waiting for confirmation/),
    ).toBeInTheDocument();
    const github = await screen.findByRole("listitem", { name: "GitHub" });
    expect(within(github).getByText("Waiting for confirmation")).toBeInTheDocument();
    expect(
      within(github).queryByRole("button", { name: /Show the password/ }),
    ).not.toBeInTheDocument();
    const hetzner = screen.getByRole("listitem", { name: "Hetzner" });
    expect(within(hetzner).getByText("You do not read this one")).toBeInTheDocument();
    expect(
      within(hetzner).queryByRole("button", { name: /Copy the password/ }),
    ).not.toBeInTheDocument();
  });

  it("a cassaforte non attivata la sezione non c'è", async () => {
    mockApi({
      "GET /api/vault/status": () =>
        jsonResponse(200, { activated: false, myKey: null, seals: [] }),
    });
    setVault({ state: "inactive" });
    renderSection(["credentials.create"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("region", { name: "Credentials" })).not.toBeInTheDocument();
    expect(requests.some((r) => r.path === listPath)).toBe(false);
  });
});
