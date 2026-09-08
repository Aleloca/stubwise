import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsGooglePage } from "./google";

/**
 * Sotto-pagina Google: dalla fase 6c monta `MailAdmissionSection` SEMPRE
 * (lettura per tutti) e `GoogleWorkspacesSection` SOLO per un admin (quella
 * rotta è admin-only, vedi il commento in `google.tsx`). Questo test copre
 * la composizione condizionata dal ruolo; il comportamento di ciascuna
 * sezione è coperto dai rispettivi test unitari.
 */

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

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsGooglePage />
    </QueryClientProvider>,
  );
}

describe("SettingsGooglePage", () => {
  it("un admin vede sia il registro dei Workspace sia la posta ammessa", async () => {
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u1", email: "admin@example.com", role: "admin" } }),
      "GET /api/settings/google-workspaces": () => jsonResponse(200, []),
      "GET /api/settings/mail-admission": () =>
        jsonResponse(200, {
          admitWorkspaceDomains: true,
          denyLabels: ["SPAM"],
          denyAutomated: true,
        }),
    });
    renderPage();

    expect(await screen.findByText("Google Workspace")).toBeInTheDocument();
    expect(screen.getByText("Admitted mail")).toBeInTheDocument();
  });

  it("un member vede solo la posta ammessa, in sola lettura", async () => {
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u2", email: "member@example.com", role: "member" } }),
      "GET /api/settings/mail-admission": () =>
        jsonResponse(200, {
          admitWorkspaceDomains: true,
          denyLabels: ["SPAM"],
          denyAutomated: true,
        }),
    });
    renderPage();

    expect(await screen.findByText("Admitted mail")).toBeInTheDocument();
    expect(screen.queryByText("Google Workspace")).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /admit mail from registered workspace domains/i }),
    ).toBeDisabled();
    // Nessuna GET admin-only: se `GoogleWorkspacesSection` montasse comunque
    // per un member, `mockApi` lancerebbe (nessun handler registrato) e il
    // test fallirebbe.
  });
});
