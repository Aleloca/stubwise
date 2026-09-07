import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleWorkspace } from "../lib/api";
import { GoogleWorkspacesSection } from "./google-workspaces-section";

/**
 * Sezione "Google Workspace" delle impostazioni (solo admin): elenco, form di
 * creazione/modifica e box con i valori da incollare nella Google Cloud
 * Console. Il client secret è write-only: mai mostrato, e in modifica un campo
 * lasciato vuoto NON deve finire nel body (altrimenti azzererebbe il segreto).
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

function makeWorkspace(overrides: Partial<GoogleWorkspace> = {}): GoogleWorkspace {
  return {
    id: "0f2c6d6e-6e4a-4d9b-9d6a-2f5b4c8e1a11",
    name: "Acme",
    domains: ["acme.com"],
    clientId: "123.apps.googleusercontent.com",
    clientSecretSet: true,
    accountCount: 0,
    redirectUri: "https://stubwise.example.com/api/me/google/callback",
    createdAt: "2026-09-07T10:00:00.000Z",
    ...overrides,
  };
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <GoogleWorkspacesSection />
    </QueryClientProvider>,
  );
}

const LIST = "GET /api/settings/google-workspaces";

describe("GoogleWorkspacesSection", () => {
  it("elenca i Workspace con domini, client id e badge del segreto", async () => {
    mockApi({
      [LIST]: () =>
        jsonResponse(200, [
          makeWorkspace({ domains: ["acme.com", "sub.acme.com"], accountCount: 3 }),
        ]),
    });
    renderSection();

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("acme.com, sub.acme.com")).toBeInTheDocument();
    expect(screen.getByText("123.apps.googleusercontent.com")).toBeInTheDocument();
    expect(screen.getByText("Secret set")).toBeInTheDocument();
    expect(screen.getByText("Connected mailboxes: 3")).toBeInTheDocument();
  });

  it("mostra il segreto come mancante quando non è impostato", async () => {
    mockApi({ [LIST]: () => jsonResponse(200, [makeWorkspace({ clientSecretSet: false })]) });
    renderSection();

    expect(await screen.findByText("Secret missing")).toBeInTheDocument();
  });

  it("mostra il redirect URI e gli scope da incollare nella Console", async () => {
    mockApi({ [LIST]: () => jsonResponse(200, [makeWorkspace()]) });
    renderSection();

    expect(
      await screen.findByText("https://stubwise.example.com/api/me/google/callback"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Internal app/)).toBeInTheDocument();
  });

  it("crea un Workspace: i domini si scrivono separati da virgola", async () => {
    const user = userEvent.setup();
    let posted: unknown;
    mockApi({
      [LIST]: () => jsonResponse(200, []),
      "POST /api/settings/google-workspaces": (_url, init) => {
        posted = JSON.parse(String(init?.body));
        return jsonResponse(201, makeWorkspace());
      },
    });
    renderSection();

    await user.click(await screen.findByRole("button", { name: "New Workspace" }));
    await user.type(screen.getByLabelText("Name"), "Acme");
    await user.type(screen.getByLabelText("Email domains"), "Acme.com, sub.acme.com");
    await user.type(screen.getByLabelText("Client ID"), "123.apps.googleusercontent.com");
    await user.type(screen.getByLabelText("Client secret"), "GOCSPX-x");
    await user.click(screen.getByRole("button", { name: "Create Workspace" }));

    await waitFor(() => expect(posted).toBeDefined());
    expect(posted).toEqual({
      name: "Acme",
      domains: ["Acme.com", "sub.acme.com"],
      clientId: "123.apps.googleusercontent.com",
      clientSecret: "GOCSPX-x",
    });
  });

  it("in modifica, un client secret lasciato vuoto NON viene inviato", async () => {
    const user = userEvent.setup();
    let patched: unknown;
    mockApi({
      [LIST]: () => jsonResponse(200, [makeWorkspace()]),
      "PATCH /api/settings/google-workspaces/0f2c6d6e-6e4a-4d9b-9d6a-2f5b4c8e1a11": (
        _url,
        init,
      ) => {
        patched = JSON.parse(String(init?.body));
        return jsonResponse(200, makeWorkspace({ name: "Acme Inc." }));
      },
    });
    renderSection();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Acme Inc.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patched).toBeDefined());
    expect(patched).toEqual({
      name: "Acme Inc.",
      domains: ["acme.com"],
      clientId: "123.apps.googleusercontent.com",
    });
    expect(patched).not.toHaveProperty("clientSecret");
  });

  it("la casella «rimuovi» invia il client secret vuoto (azzeramento esplicito)", async () => {
    const user = userEvent.setup();
    let patched: Record<string, unknown> | undefined;
    mockApi({
      [LIST]: () => jsonResponse(200, [makeWorkspace()]),
      "PATCH /api/settings/google-workspaces/0f2c6d6e-6e4a-4d9b-9d6a-2f5b4c8e1a11": (
        _url,
        init,
      ) => {
        patched = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(200, makeWorkspace({ clientSecretSet: false }));
      },
    });
    renderSection();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByLabelText("Remove stored client secret"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patched).toBeDefined());
    expect(patched?.clientSecret).toBe("");
  });

  it("una DELETE con caselle collegate mostra il motivo del 409", async () => {
    const user = userEvent.setup();
    mockApi({
      [LIST]: () => jsonResponse(200, [makeWorkspace({ accountCount: 2 })]),
      "DELETE /api/settings/google-workspaces/0f2c6d6e-6e4a-4d9b-9d6a-2f5b4c8e1a11": () =>
        jsonResponse(409, { code: "workspace_in_use", message: "in use" }),
    });
    renderSection();

    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /still has connected mailboxes/i,
    );
  });

  it("senza Workspace mostra lo stato vuoto ma il redirect URI resta leggibile", async () => {
    mockApi({ [LIST]: () => jsonResponse(200, []) });
    renderSection();

    expect(await screen.findByText("No Google Workspace configured")).toBeInTheDocument();
    // Il registro vuoto è proprio il momento in cui serve incollare l'URI nella
    // Console: senza righe da cui leggerlo si ripiega sull'origin corrente.
    expect(screen.getByText(/\/api\/me\/google\/callback$/)).toBeInTheDocument();
  });
});
