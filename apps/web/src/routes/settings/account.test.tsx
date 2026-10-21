import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../../router";

/**
 * Sotto-pagina Impostazioni → Account (`/settings/account`) col router vero
 * (memory history) e fetch mockata, limitatamente alle sezioni PERSONALI
 * aggiunte in fase 0: progetti seguiti e preferenze di notifica. Email, ruolo e
 * lingua restano coperti da `routes/settings.test.tsx`.
 */

const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
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
});

type Handler = (url: URL, init?: RequestInit) => Response;

interface AccountMockState {
  /** Insieme dei progetti seguiti, sostituito da ogni PUT. */
  followed: string[];
  /** Body inviati a PUT /api/me/follows (l'insieme COMPLETO, mai un delta). */
  followPuts: unknown[];
  /** Preferenze di notifica correnti (`slackLinked` è contesto del server). */
  prefs: { slackDm: boolean; push: boolean; slackLinked: boolean };
  /** Body inviati a PATCH /api/me/notification-prefs. */
  prefsPatches: unknown[];
  /** Body inviati a POST /api/auth/me/password. */
  passwordPosts: unknown[];
}

function mockAccountApi(
  overrides: {
    followed?: string[];
    prefs?: { slackDm: boolean; push: boolean; slackLinked: boolean };
    /** Risposta di POST /api/auth/me/password (default 204). */
    passwordResponse?: () => Response;
  } = {},
): AccountMockState {
  const state: AccountMockState = {
    followed: overrides.followed ?? [],
    followPuts: [],
    prefs: overrides.prefs ?? { slackDm: false, push: true, slackLinked: true },
    prefsPatches: [],
    passwordPosts: [],
  };

  const handlers: Record<string, Handler> = {
    "GET /api/auth/me": () =>
      jsonResponse(200, {
        user: { id: "u1", email: "ada@example.com", role: "member", language: "en" },
      }),
    "GET /api/projects": () =>
      jsonResponse(200, [
        {
          id: PROJECT_A,
          name: "Acme Platform",
          slug: "acme-platform",
          description: null,
          aiProviderId: null,
          docAutoUpdate: false,
          dailyReportEnabled: false,
          backlogEnabled: false,
          ingestionKey: "0123456789abcdef0123456789abcdef",
          nextTicketNumber: 1,
          repositoryCount: 1,
          createdAt: "2026-06-01T10:00:00.000Z",
        },
        {
          id: PROJECT_B,
          name: "Beta Shop",
          slug: "beta-shop",
          description: null,
          aiProviderId: null,
          docAutoUpdate: false,
          dailyReportEnabled: false,
          backlogEnabled: false,
          ingestionKey: "fedcba9876543210fedcba9876543210",
          nextTicketNumber: 1,
          repositoryCount: 0,
          createdAt: "2026-06-02T10:00:00.000Z",
        },
      ]),
    "GET /api/me/follows": () => jsonResponse(200, { projectIds: state.followed }),
    "PUT /api/me/follows": (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { projectIds: string[] };
      state.followPuts.push(body);
      state.followed = body.projectIds;
      return new Response(null, { status: 204 });
    },
    // La sezione "Caselle Google" (fase 6) vive su questa pagina: senza queste
    // due handler la route esplode con "fetch non mockata".
    "GET /api/me/google/accounts": () => jsonResponse(200, []),
    "GET /api/me/google/workspaces": () => jsonResponse(200, []),
    "GET /api/me/notification-prefs": () => jsonResponse(200, state.prefs),
    "POST /api/auth/me/password": (_url, init) => {
      state.passwordPosts.push(JSON.parse(String(init?.body)));
      return overrides.passwordResponse?.() ?? new Response(null, { status: 204 });
    },
    "PATCH /api/me/notification-prefs": (_url, init) => {
      // Il server applica una PATCH: i campi assenti restano come sono.
      const body = JSON.parse(String(init?.body)) as { slackDm?: boolean; push?: boolean };
      state.prefsPatches.push(body);
      state.prefs = { ...state.prefs, ...body };
      return new Response(null, { status: 204 });
    },
  };

  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`fetch non mockata per ${method} ${raw}`);
    return Promise.resolve(handler(url, init));
  });

  return state;
}

function renderAccount(path = "/settings/account") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("account: progetti seguiti", () => {
  it("una checkbox per progetto, spuntata per quelli già seguiti", async () => {
    mockAccountApi({ followed: [PROJECT_B] });
    renderAccount();

    expect(await screen.findByText("Followed projects")).toBeInTheDocument();
    expect(screen.getByLabelText(/Acme Platform/)).not.toBeChecked();
    expect(screen.getByLabelText(/Beta Shop/)).toBeChecked();
  });

  it("spuntare un progetto salva subito l'insieme COMPLETO", async () => {
    const state = mockAccountApi({ followed: [PROJECT_B] });
    renderAccount();

    await userEvent.click(await screen.findByLabelText(/Acme Platform/));

    // PUT di sostituzione: l'insieme parte intero, non come delta.
    await waitFor(() => expect(state.followPuts).toEqual([{ projectIds: [PROJECT_B, PROJECT_A] }]));
    expect(screen.getByLabelText(/Acme Platform/)).toBeChecked();
  });

  it("togliere la spunta manda l'insieme senza quel progetto", async () => {
    const state = mockAccountApi({ followed: [PROJECT_A, PROJECT_B] });
    renderAccount();

    await userEvent.click(await screen.findByLabelText(/Beta Shop/));

    await waitFor(() => expect(state.followPuts).toEqual([{ projectIds: [PROJECT_A] }]));
  });
});

describe("account: preferenze di notifica", () => {
  it("il toggle del DM Slack salva la preferenza", async () => {
    const state = mockAccountApi({ prefs: { slackDm: false, push: true, slackLinked: true } });
    renderAccount();

    const toggle = await screen.findByLabelText(/Slack DM/i);
    expect(toggle).toBeEnabled();
    await userEvent.click(toggle);

    // Si manda il SOLO campo toccato: `push` non compare nel body.
    await waitFor(() => expect(state.prefsPatches).toEqual([{ slackDm: true }]));
    expect(toggle).toBeChecked();
  });

  it("il toggle delle push salva la preferenza senza toccare il DM Slack", async () => {
    const state = mockAccountApi({ prefs: { slackDm: true, push: true, slackLinked: true } });
    renderAccount();

    const toggle = await screen.findByLabelText(/push/i);
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);

    await waitFor(() => expect(state.prefsPatches).toEqual([{ push: false }]));
    expect(toggle).not.toBeChecked();
    // Il canale che non si è toccato resta acceso: è la proprietà della PATCH.
    expect(state.prefs.slackDm).toBe(true);
  });

  it("il toggle delle push è attivo anche senza identità Slack collegata", async () => {
    // Non c'è un vincolo simmetrico a quello del DM: le push non dipendono da
    // Slack, e chi non ha ancora installato l'app può comunque decidere ora.
    mockAccountApi({ prefs: { slackDm: false, push: false, slackLinked: false } });
    renderAccount();

    expect(await screen.findByLabelText(/push/i)).toBeEnabled();
  });

  it("senza identità Slack collegata il toggle è disabilitato, con l'hint", async () => {
    const state = mockAccountApi({ prefs: { slackDm: false, push: true, slackLinked: false } });
    renderAccount();

    const toggle = await screen.findByLabelText(/Slack DM/i);
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/Link your Slack account first/i)).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(state.prefsPatches).toEqual([]);
  });
});

/**
 * Il cablaggio fra il callback OAuth (una rotta del SERVER, che rimanda a
 * `/settings/account?google=<esito>`) e la sezione che lo mostra. Il
 * comportamento della sezione è coperto da
 * `components/google-accounts-section.test.tsx`: qui si verifica solo che il
 * query param arrivi — cioè `validateSearch` sulla route più la prop — perché
 * è l'unico pezzo che i test del componente, che gira senza router, non
 * possono esercitare.
 */
describe("account: esito del collegamento Google", () => {
  it("il param ?google=ok arriva alla sezione e diventa un banner", async () => {
    mockAccountApi();
    renderAccount("/settings/account?google=ok");

    expect(await screen.findByText("Mailbox connected.")).toBeInTheDocument();
  });

  it("senza param nessun banner, e la sezione c'è comunque", async () => {
    mockAccountApi();
    renderAccount();

    expect(await screen.findByText("Google mailboxes")).toBeInTheDocument();
    expect(screen.queryByText("Mailbox connected.")).not.toBeInTheDocument();
  });

  it("un param inventato non rompe la route", async () => {
    mockAccountApi();
    renderAccount("/settings/account?google=%7B%7Bnope");

    expect(await screen.findByText("Google mailboxes")).toBeInTheDocument();
  });
});

describe("account: cambio password", () => {
  async function fill(current: string, next: string, confirm: string) {
    await userEvent.type(await screen.findByLabelText("Current password"), current);
    await userEvent.type(screen.getByLabelText("New password"), next);
    await userEvent.type(screen.getByLabelText("Confirm new password"), confirm);
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
  }

  it("manda attuale e nuova, poi conferma e svuota i campi", async () => {
    const state = mockAccountApi();
    renderAccount();

    await fill("password-vecchia", "password-nuova", "password-nuova");

    expect(await screen.findByText("Password changed.")).toBeInTheDocument();
    expect(state.passwordPosts).toEqual([
      { currentPassword: "password-vecchia", newPassword: "password-nuova" },
    ]);
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(screen.getByLabelText("New password")).toHaveValue("");
  });

  it("conferma diversa: errore locale e nessuna richiesta", async () => {
    const state = mockAccountApi();
    renderAccount();

    await fill("password-vecchia", "password-nuova", "password-altra");

    expect(await screen.findByText("Passwords do not match")).toBeInTheDocument();
    expect(state.passwordPosts).toEqual([]);
  });

  it("password attuale sbagliata: il messaggio tradotto del server", async () => {
    mockAccountApi({
      passwordResponse: () =>
        jsonResponse(400, { code: "invalid_current_password", message: "Current password is incorrect" }),
    });
    renderAccount();

    await fill("sbagliata", "password-nuova", "password-nuova");

    expect(await screen.findByText("The current password is not correct")).toBeInTheDocument();
    expect(screen.queryByText("Password changed.")).not.toBeInTheDocument();
  });
});
