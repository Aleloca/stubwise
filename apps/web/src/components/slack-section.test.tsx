import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceSettings } from "../lib/api";
import { SlackSection } from "./slack-section";

/**
 * Sezione "Slack" delle impostazioni (solo admin): form signing secret + bot
 * token + salvataggio (PUT) e badge enabled/disabled. I segreti sono write-only:
 * mai mostrati in lettura. Rete mockata via `fetch` globale come le altre section.
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

function makeInstance(overrides: Partial<InstanceSettings> = {}): InstanceSettings {
  return {
    contentLanguage: "en",
    monthlyBudgetUsd: null,
    s3Endpoint: null,
    s3Region: null,
    s3Bucket: null,
    s3AccessKey: null,
    s3SecretKeySet: false,
    attachmentsEnabled: false,
    slackSigningSecretSet: false,
    slackBotTokenSet: false,
    slackEnabled: false,
    ...overrides,
  };
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SlackSection />
    </QueryClientProvider>,
  );
}

describe("SlackSection — render", () => {
  it("mostra i campi del form e il badge 'disabled' quando non configurato", async () => {
    mockApi({ "GET /api/settings/instance": () => jsonResponse(200, makeInstance()) });
    renderSection();

    expect(await screen.findByLabelText("Signing secret")).toBeInTheDocument();
    expect(screen.getByLabelText("Bot token")).toBeInTheDocument();
    expect(screen.getByText(/slack disabled/i)).toBeInTheDocument();
  });

  it("mostra il badge 'enabled' e NON espone i segreti salvati", async () => {
    mockApi({
      "GET /api/settings/instance": () =>
        jsonResponse(
          200,
          makeInstance({
            slackSigningSecretSet: true,
            slackBotTokenSet: true,
            slackEnabled: true,
          }),
        ),
    });
    renderSection();

    expect(await screen.findByText(/slack enabled/i)).toBeInTheDocument();
    // I campi segreti restano vuoti: i segreti salvati non sono mai inviati al client.
    expect((screen.getByLabelText("Signing secret") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Bot token") as HTMLInputElement).value).toBe("");
    // Nessun nodo del DOM contiene un eventuale valore segreto.
    expect(document.body.textContent).not.toContain("super-secret");
  });
});

describe("SlackSection — salvataggio", () => {
  it("invia il PUT coi due segreti quando inseriti", async () => {
    const user = userEvent.setup();
    let putBody: Record<string, unknown> | undefined;
    mockApi({
      "GET /api/settings/instance": () => jsonResponse(200, makeInstance()),
      "PUT /api/settings/instance": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(
          200,
          makeInstance({ slackSigningSecretSet: true, slackBotTokenSet: true, slackEnabled: true }),
        );
      },
    });
    renderSection();

    await user.type(await screen.findByLabelText("Signing secret"), "my-sig");
    await user.type(screen.getByLabelText("Bot token"), "xoxb-tok");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody?.slackSigningSecret).toBe("my-sig");
    expect(putBody?.slackBotToken).toBe("xoxb-tok");
  });

  it("campi vuoti → i segreti NON sono nel body (non modificare)", async () => {
    const user = userEvent.setup();
    let putBody: Record<string, unknown> | undefined;
    mockApi({
      "GET /api/settings/instance": () =>
        jsonResponse(
          200,
          makeInstance({ slackSigningSecretSet: true, slackBotTokenSet: true, slackEnabled: true }),
        ),
      "PUT /api/settings/instance": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(
          200,
          makeInstance({ slackSigningSecretSet: true, slackBotTokenSet: true, slackEnabled: true }),
        );
      },
    });
    renderSection();

    // Segreti lasciati vuoti di proposito.
    await user.click(await screen.findByRole("button", { name: /save/i }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect("slackSigningSecret" in (putBody ?? {})).toBe(false);
    expect("slackBotToken" in (putBody ?? {})).toBe(false);
  });

  it("checkbox Remove → invia '' per azzerare il segreto", async () => {
    const user = userEvent.setup();
    let putBody: Record<string, unknown> | undefined;
    mockApi({
      "GET /api/settings/instance": () =>
        jsonResponse(
          200,
          makeInstance({ slackSigningSecretSet: true, slackBotTokenSet: true, slackEnabled: true }),
        ),
      "PUT /api/settings/instance": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, makeInstance({ slackBotTokenSet: true }));
      },
    });
    renderSection();

    await user.click(await screen.findByLabelText(/remove stored signing secret/i));
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody?.slackSigningSecret).toBe("");
    expect("slackBotToken" in (putBody ?? {})).toBe(false);
  });
});
