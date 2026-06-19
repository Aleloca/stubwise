import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProvider } from "../lib/api";
import { AiProvidersSection } from "./ai-providers-section";

/**
 * Sezione "AI providers" delle impostazioni (solo admin): lista ordinata delle
 * credenziali, creazione (POST), riordino (POST /reorder con l'insieme
 * completo), enable/disable (PATCH), eliminazione (DELETE con conferma) e
 * avviso ToS con ≥2 account. La secret è write-only: non compare MAI.
 * La rete è mockata via `fetch` globale (come git-accounts-section.test).
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

function makeProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    kind: "api_key",
    label: "Console primaria",
    position: 0,
    enabled: true,
    secretSet: true,
    createdAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AiProvidersSection />
    </QueryClientProvider>,
  );
}

describe("AiProvidersSection — lista", () => {
  it("mostra le credenziali con label, kind ed enabled, mai la secret", async () => {
    mockApi({
      "GET /api/ai-providers": () =>
        jsonResponse(200, [
          makeProvider({ kind: "api_key", label: "Console primaria", enabled: true }),
          makeProvider({
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            kind: "account",
            label: "Account Max",
            position: 1,
            enabled: false,
          }),
        ]),
    });

    renderSection();

    expect(await screen.findByText("Console primaria")).toBeInTheDocument();
    expect(screen.getByText("Account Max")).toBeInTheDocument();
    // Badge kind: API key + Account.
    expect(screen.getByText("API key")).toBeInTheDocument();
    expect(screen.getByText("Account")).toBeInTheDocument();
    // La secret non compare da nessuna parte (è write-only): nessun valore
    // secret renderizzato, né come testo né come valore di un campo.
    expect(screen.queryByText(/sk-/)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(/sk-/)).not.toBeInTheDocument();
  });

  it("senza credenziali mostra il vuoto", async () => {
    mockApi({ "GET /api/ai-providers": () => jsonResponse(200, []) });
    renderSection();
    expect(await screen.findByText(/no ai providers/i)).toBeInTheDocument();
  });
});

describe("AiProvidersSection — creazione", () => {
  it("il form invia il POST con kind, label e secret", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    mockApi({
      "GET /api/ai-providers": () => jsonResponse(200, []),
      "POST /api/ai-providers": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, makeProvider());
      },
    });

    renderSection();

    await user.click(await screen.findByRole("button", { name: /new ai provider/i }));

    await user.selectOptions(screen.getByLabelText("Type"), "account");
    await user.type(screen.getByLabelText("Label"), "Account Max");
    await user.type(screen.getByLabelText("Secret"), "sk-ant-xyz");
    await user.click(screen.getByRole("button", { name: "Create provider" }));

    await waitFor(() =>
      expect(postBody).toEqual({
        kind: "account",
        label: "Account Max",
        secret: "sk-ant-xyz",
      }),
    );
  });
});

describe("AiProvidersSection — riordino", () => {
  it("muovere giù la prima credenziale invia /reorder con l'ordine completo", async () => {
    const user = userEvent.setup();
    let reorderBody: unknown;
    mockApi({
      "GET /api/ai-providers": () =>
        jsonResponse(200, [
          makeProvider({ id: "id-1", label: "Prima", position: 0 }),
          makeProvider({ id: "id-2", label: "Seconda", position: 1 }),
        ]),
      "POST /api/ai-providers/reorder": (_url, init) => {
        reorderBody = JSON.parse(String(init?.body));
        return jsonResponse(200, [
          makeProvider({ id: "id-2", label: "Seconda", position: 0 }),
          makeProvider({ id: "id-1", label: "Prima", position: 1 }),
        ]);
      },
    });

    renderSection();

    const firstRow = (await screen.findByText("Prima")).closest("li") as HTMLElement;
    await user.click(within(firstRow).getByRole("button", { name: /move down/i }));

    await waitFor(() => expect(reorderBody).toEqual({ orderedIds: ["id-2", "id-1"] }));
  });
});

describe("AiProvidersSection — enable/disable", () => {
  it("il toggle invia PATCH { enabled }", async () => {
    const user = userEvent.setup();
    let patchBody: unknown;
    mockApi({
      "GET /api/ai-providers": () =>
        jsonResponse(200, [makeProvider({ id: "id-1", enabled: true })]),
      "PATCH /api/ai-providers/id-1": (_url, init) => {
        patchBody = JSON.parse(String(init?.body));
        return jsonResponse(200, makeProvider({ id: "id-1", enabled: false }));
      },
    });

    renderSection();

    const row = (await screen.findByText("Console primaria")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /disable/i }));

    await waitFor(() => expect(patchBody).toEqual({ enabled: false }));
  });
});

describe("AiProvidersSection — eliminazione", () => {
  it("elimina con conferma", async () => {
    const user = userEvent.setup();
    let deleted = false;
    mockApi({
      "GET /api/ai-providers": () =>
        jsonResponse(200, deleted ? [] : [makeProvider({ id: "id-1" })]),
      "DELETE /api/ai-providers/id-1": () => {
        deleted = true;
        return jsonResponse(204, null);
      },
    });

    renderSection();

    const row = (await screen.findByText("Console primaria")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(within(row).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.queryByText("Console primaria")).not.toBeInTheDocument());
  });
});

describe("AiProvidersSection — avviso ToS", () => {
  it("appare con ≥2 credenziali di tipo account", async () => {
    mockApi({
      "GET /api/ai-providers": () =>
        jsonResponse(200, [
          makeProvider({ id: "id-1", kind: "account", label: "Account A", position: 0 }),
          makeProvider({ id: "id-2", kind: "account", label: "Account B", position: 1 }),
        ]),
    });

    renderSection();

    expect(await screen.findByRole("alert")).toHaveTextContent(/terms of service/i);
  });

  it("è assente con meno di 2 account", async () => {
    mockApi({
      "GET /api/ai-providers": () =>
        jsonResponse(200, [
          makeProvider({ id: "id-1", kind: "account", label: "Account A", position: 0 }),
          makeProvider({ id: "id-2", kind: "api_key", label: "Console", position: 1 }),
        ]),
    });

    renderSection();

    await screen.findByText("Account A");
    expect(screen.queryByText(/terms of service/i)).not.toBeInTheDocument();
  });
});
