import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitAccount } from "../lib/api";
import { GitAccountsSection } from "./git-accounts-section";

/**
 * Sezione "Account Git" delle impostazioni (solo admin): lista degli account,
 * creazione (POST), validazione (render dei check) ed eliminazione (409 inline).
 * La rete è mockata via `fetch` globale (come settings.test): le queryOptions
 * catturano i fetcher all'import, quindi spiare il modulo non basterebbe.
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

function makeAccount(overrides: Partial<GitAccount> = {}): GitAccount {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Account Demo",
    provider: "github",
    workspace: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <GitAccountsSection />
    </QueryClientProvider>,
  );
}

describe("GitAccountsSection — lista", () => {
  it("mostra gli account con nome, provider e data di creazione", async () => {
    mockApi({
      "GET /api/git-accounts": () =>
        jsonResponse(200, [
          makeAccount(),
          makeAccount({
            id: "22222222-2222-4222-8222-222222222222",
            name: "Bitbucket Prod",
            provider: "bitbucket",
          }),
        ]),
    });

    renderSection();

    expect(await screen.findByText("Account Demo")).toBeInTheDocument();
    expect(screen.getByText("Bitbucket Prod")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Bitbucket")).toBeInTheDocument();
  });

  it("senza account mostra il vuoto", async () => {
    mockApi({ "GET /api/git-accounts": () => jsonResponse(200, []) });
    renderSection();
    expect(await screen.findByText(/no git accounts/i)).toBeInTheDocument();
  });
});

describe("GitAccountsSection — creazione", () => {
  it("il form invia il POST col payload giusto", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, []),
      "POST /api/git-accounts": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, makeAccount());
      },
    });

    renderSection();

    await user.click(await screen.findByRole("button", { name: /new git account/i }));

    await user.type(screen.getByLabelText("Name"), "Account Demo");
    await user.selectOptions(screen.getByLabelText("Provider"), "bitbucket");
    await user.type(screen.getByLabelText("Workspace"), "mio-workspace");
    await user.type(screen.getByLabelText("Username"), "acme-bot");
    await user.type(screen.getByLabelText("Email"), "bot@acme.io");
    await user.type(screen.getByLabelText("Token di accesso"), "api-token");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(postBody).toEqual({
        name: "Account Demo",
        provider: "bitbucket",
        credentials: { username: "acme-bot", email: "bot@acme.io", token: "api-token" },
        workspace: "mio-workspace",
      }),
    );
  });

  it("il campo Workspace è mostrato solo per Bitbucket, non per GitHub", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /api/git-accounts": () => jsonResponse(200, []) });

    renderSection();

    await user.click(await screen.findByRole("button", { name: /new git account/i }));

    // Default provider = Bitbucket: il campo Workspace c'è.
    expect(screen.getByLabelText("Workspace")).toBeInTheDocument();

    // Passando a GitHub il campo sparisce.
    await user.selectOptions(screen.getByLabelText("Provider"), "github");
    expect(screen.queryByLabelText("Workspace")).not.toBeInTheDocument();
  });
});

describe("GitAccountsSection — validazione", () => {
  it("clic su Valida mostra i check ✓/✗ con dettaglio", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, [makeAccount()]),
      "POST /api/git-accounts/11111111-1111-4111-8111-111111111111/validate": () =>
        jsonResponse(200, {
          ok: false,
          checks: [
            { name: "Accesso git (push)", ok: true, detail: "autenticazione git e push ok" },
            { name: "Accesso REST API (PR)", ok: false, detail: "401: serve l'email" },
          ],
        }),
    });

    renderSection();

    const row = (await screen.findByText("Account Demo")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Validate" }));

    expect(await screen.findByText("Problemi rilevati")).toBeInTheDocument();
    expect(screen.getByText(/autenticazione git e push ok/)).toBeInTheDocument();
    expect(screen.getByText(/serve l'email/)).toBeInTheDocument();
  });
});

describe("GitAccountsSection — eliminazione", () => {
  it("su 409 mostra il messaggio 'account usato' inline", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, [makeAccount()]),
      "DELETE /api/git-accounts/11111111-1111-4111-8111-111111111111": () =>
        jsonResponse(409, { message: "Account git in uso da uno o più progetti" }),
    });

    renderSection();

    const row = (await screen.findByText("Account Demo")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(within(row).getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText(/used by one or more projects/i)).toBeInTheDocument();
  });

  it("elimina con conferma quando non è in uso", async () => {
    const user = userEvent.setup();
    let deleted = false;
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, deleted ? [] : [makeAccount()]),
      "DELETE /api/git-accounts/11111111-1111-4111-8111-111111111111": () => {
        deleted = true;
        return jsonResponse(204, null);
      },
    });

    renderSection();

    const row = (await screen.findByText("Account Demo")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(within(row).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.queryByText("Account Demo")).not.toBeInTheDocument());
  });
});
