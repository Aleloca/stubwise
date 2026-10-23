import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../../router";
import { legacyMemberPermissions } from "../../test/me";

const startRegistrationMock = vi.hoisted(() => vi.fn());
vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: startRegistrationMock,
  startAuthentication: vi.fn(),
}));

vi.mock("qrcode", () => ({
  default: { toString: vi.fn(async () => "<svg></svg>") },
}));

/**
 * Impostazioni → Sicurezza (`/settings/security`) col router vero e la fetch
 * mockata: stato dell'app, passkey, codici di riserva e registro. Nessun
 * «disattiva»: il secondo fattore non si spegne.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
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
  startRegistrationMock.mockReset();
});

type Handler = (url: URL, init?: RequestInit) => Response;

function mockApi(handlers: Record<string, Handler>) {
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`fetch non mockata per ${method} ${raw}`);
    return Promise.resolve(handler(url, init));
  });
}

const ME = () =>
  jsonResponse(200, {
    user: { id: "u1", email: "ada@example.com", role: "member", language: "en" },
    ...legacyMemberPermissions(),
  });

const PASSKEY = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Laptop",
  createdAt: "2026-10-01T10:00:00.000Z",
  lastUsedAt: null,
};

function security(overrides: Record<string, unknown> = {}) {
  return {
    totp: { configured: true, confirmedAt: "2026-10-01T09:00:00.000Z" },
    passkeys: [PASSKEY],
    backupCodesRemaining: 2,
    events: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        kind: "second_factor_reset",
        actorEmail: "admin@acme.test",
        createdAt: "2026-10-02T10:00:00.000Z",
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        kind: "login",
        actorEmail: null,
        createdAt: "2026-10-03T10:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: ["/settings/security"] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

function section(name: RegExp): HTMLElement {
  return screen.getByRole("heading", { name }).closest("section")!;
}

describe("Impostazioni → Sicurezza", () => {
  it("mostra app, passkey, codici rimasti (con l'avviso a ≤ 3) e il registro, senza chiavi grezze", async () => {
    mockApi({ "GET /api/auth/me": ME, "GET /api/me/security": () => jsonResponse(200, security()) });
    renderPage();

    await screen.findByRole("heading", { name: /authenticator app/i });
    expect(within(section(/authenticator app/i)).getByText(/set up on/i)).toBeInTheDocument();
    expect(
      within(section(/authenticator app/i)).getByRole("button", { name: /reconfigure app/i }),
    ).toBeInTheDocument();

    expect(within(section(/passkeys/i)).getByText("Laptop")).toBeInTheDocument();

    const codes = section(/backup codes/i);
    expect(within(codes).getByText(/2 backup codes left/i)).toBeInTheDocument();
    expect(within(codes).getByText(/few codes left/i)).toBeInTheDocument();

    const log = section(/security log/i);
    expect(within(log).getByText(/two-step verification reset/i)).toBeInTheDocument();
    expect(within(log).getByText(/by admin@acme\.test/i)).toBeInTheDocument();
    expect(within(log).getByText(/signed in/i)).toBeInTheDocument();

    expect(document.body.textContent).not.toMatch(/settings:|errors:/);
    // La voce di navigazione c'è per tutti.
    expect(screen.getByRole("link", { name: "Security" })).toHaveAttribute(
      "href",
      "/settings/security",
    );
  });

  it("con più di 3 codici niente avviso", async () => {
    mockApi({
      "GET /api/auth/me": ME,
      "GET /api/me/security": () => jsonResponse(200, security({ backupCodesRemaining: 4 })),
    });
    renderPage();
    expect(await screen.findByText(/4 backup codes left/i)).toBeInTheDocument();
    expect(screen.queryByText(/few codes left/i)).not.toBeInTheDocument();
  });

  it("nessun bottone per disattivare il secondo fattore", async () => {
    mockApi({ "GET /api/auth/me": ME, "GET /api/me/security": () => jsonResponse(200, security()) });
    renderPage();
    await screen.findByRole("heading", { name: /authenticator app/i });
    expect(
      screen.queryByRole("button", { name: /disable|turn off|deactivate/i }),
    ).not.toBeInTheDocument();
  });

  it("una risposta senza passkey né registro (il web non parsa) non rompe la pagina", async () => {
    // Fixture SENZA `passkeys` ed `events` apposta: la difesa è nel punto di
    // lettura, non nello schema.
    const partial: Record<string, unknown> = security();
    delete partial.passkeys;
    delete partial.events;
    mockApi({ "GET /api/auth/me": ME, "GET /api/me/security": () => jsonResponse(200, partial) });
    renderPage();
    expect(await screen.findByText(/no passkeys yet/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing recorded yet/i)).toBeInTheDocument();
  });

  it("«Rigenera» mostra i codici nuovi UNA volta, poi li toglie e rilegge lo stato", async () => {
    const user = userEvent.setup();
    let remaining = 2;
    let regenerated = 0;
    mockApi({
      "GET /api/auth/me": ME,
      "GET /api/me/security": () =>
        jsonResponse(200, security({ backupCodesRemaining: remaining })),
      "POST /api/me/security/backup-codes": () => {
        regenerated += 1;
        remaining = 10;
        return jsonResponse(200, { codes: ["aaaaa-bbbbb", "ccccc-ddddd"] });
      },
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: /regenerate codes/i }));
    // Conferma: i codici attuali smettono di valere.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/stop working/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^generate$/i }));

    expect(await screen.findByText("aaaaa-bbbbb")).toBeInTheDocument();
    expect(screen.getByText("ccccc-ddddd")).toBeInTheDocument();
    expect(regenerated).toBe(1);
    expect(await screen.findByText(/10 backup codes left/i)).toBeInTheDocument();

    await user.click(screen.getByLabelText(/i saved the codes/i));
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(screen.queryByText("aaaaa-bbbbb")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /regenerate codes/i })).toBeInTheDocument();
    expect(regenerated).toBe(1);
  });

  it("cassaforte: «Aggiungi questa passkey alla cassaforte» solo accanto a una passkey senza sigillo", async () => {
    const PHONE = { ...PASSKEY, id: "55555555-5555-4555-8555-555555555555", name: "Phone" };
    mockApi({
      "GET /api/auth/me": ME,
      "GET /api/me/security": () => jsonResponse(200, security({ passkeys: [PASSKEY, PHONE] })),
      "GET /api/vault/status": () =>
        jsonResponse(200, {
          activated: true,
          myKey: { id: "66666666-6666-4666-8666-666666666666", status: "confirmed", createdAt: PASSKEY.createdAt },
          seals: [{ passkeyId: PASSKEY.id, credentialIdB64url: "Y3JlZC1h" }],
          passkeys: [
            { passkeyId: PASSKEY.id, credentialIdB64url: "Y3JlZC1h" },
            { passkeyId: PHONE.id, credentialIdB64url: "Y3JlZC1i" },
          ],
        }),
    });
    renderPage();

    expect(
      await screen.findByRole("button", { name: "Add passkey Phone to the vault" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add passkey Laptop to the vault" }),
    ).not.toBeInTheDocument();
  });

  it("aggiunge una passkey col nome scelto: opzioni → browser → registrazione", async () => {
    const user = userEvent.setup();
    let posted: unknown = null;
    let passkeys = [PASSKEY];
    const browserResponse = { id: "cred", rawId: "cred", type: "public-key", response: {} };
    startRegistrationMock.mockResolvedValue(browserResponse);
    mockApi({
      "GET /api/auth/me": ME,
      "GET /api/me/security": () => jsonResponse(200, security({ passkeys })),
      // Il server chiede la PRF (`prf: {}`): la web la passa al browser così
      // com'è, perché la passkey nuova possa aprire la cassaforte.
      "POST /api/me/security/passkeys/options": () =>
        jsonResponse(200, { challenge: "c", rp: { name: "Stubwise" }, extensions: { prf: {} } }),
      "POST /api/me/security/passkeys": (_url, init) => {
        posted = JSON.parse(String(init?.body));
        const created = { ...PASSKEY, id: "44444444-4444-4444-8444-444444444444", name: "YubiKey" };
        passkeys = [...passkeys, created];
        return jsonResponse(201, created);
      },
    });
    renderPage();

    await user.type(await screen.findByLabelText(/passkey name/i), "YubiKey");
    await user.click(screen.getByRole("button", { name: /add passkey/i }));

    expect(await screen.findByText("YubiKey")).toBeInTheDocument();
    expect(startRegistrationMock).toHaveBeenCalledWith({
      optionsJSON: { challenge: "c", rp: { name: "Stubwise" }, extensions: { prf: {} } },
    });
    expect(posted).toEqual({ name: "YubiKey", response: browserResponse });
  });

  it("passkey annullata dal browser: messaggio, nessuna registrazione", async () => {
    const user = userEvent.setup();
    let registered = false;
    startRegistrationMock.mockRejectedValue(new Error("NotAllowedError"));
    mockApi({
      "GET /api/auth/me": ME,
      "GET /api/me/security": () => jsonResponse(200, security()),
      "POST /api/me/security/passkeys/options": () =>
        jsonResponse(200, { challenge: "c", rp: { name: "Stubwise" } }),
      "POST /api/me/security/passkeys": () => {
        registered = true;
        return jsonResponse(201, PASSKEY);
      },
    });
    renderPage();

    await user.type(await screen.findByLabelText(/passkey name/i), "Phone");
    await user.click(screen.getByRole("button", { name: /add passkey/i }));

    expect(await screen.findByText(/did not create the passkey/i)).toBeInTheDocument();
    expect(registered).toBe(false);
  });

  it("rinomina e toglie una passkey", async () => {
    const user = userEvent.setup();
    let passkeys = [PASSKEY];
    let renamedTo: unknown = null;
    let deleted = false;
    mockApi({
      "GET /api/auth/me": ME,
      "GET /api/me/security": () => jsonResponse(200, security({ passkeys })),
      [`PATCH /api/me/security/passkeys/${PASSKEY.id}`]: (_url, init) => {
        renamedTo = JSON.parse(String(init?.body));
        passkeys = [{ ...PASSKEY, name: "Work laptop" }];
        return jsonResponse(200, passkeys[0]);
      },
      [`DELETE /api/me/security/passkeys/${PASSKEY.id}`]: () => {
        deleted = true;
        passkeys = [];
        return jsonResponse(204, null);
      },
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Rename passkey Laptop" }));
    const input = screen.getByLabelText("New name for Laptop");
    await user.clear(input);
    await user.type(input, "Work laptop");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText("Work laptop")).toBeInTheDocument();
    expect(renamedTo).toEqual({ name: "Work laptop" });

    await user.click(screen.getByRole("button", { name: "Remove passkey Work laptop" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^remove$/i }));
    expect(await screen.findByText(/no passkeys yet/i)).toBeInTheDocument();
    expect(deleted).toBe(true);
  });

  it("«Riconfigura app»: QR nuovo, primo codice, l'app è sostituita", async () => {
    const user = userEvent.setup();
    let confirmed: unknown = null;
    mockApi({
      "GET /api/auth/me": ME,
      "GET /api/me/security": () => jsonResponse(200, security()),
      "POST /api/me/security/totp/setup": () =>
        jsonResponse(200, { secret: "NEWSECRET", otpauthUrl: "otpauth://totp/x?secret=NEWSECRET" }),
      "POST /api/me/security/totp/setup/confirm": (_url, init) => {
        confirmed = JSON.parse(String(init?.body));
        return jsonResponse(200, { backupCodes: null });
      },
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: /reconfigure app/i }));
    expect(await screen.findByText("NEWSECRET")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/authenticator code/i), "123456");
    await user.click(screen.getByRole("button", { name: /^confirm$/i }));

    expect(await screen.findByText(/authenticator app updated/i)).toBeInTheDocument();
    expect(screen.queryByText("NEWSECRET")).not.toBeInTheDocument();
    expect(confirmed).toEqual({ code: "123456" });
  });
});
