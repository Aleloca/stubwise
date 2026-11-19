import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { peekOneTimeSecret, stashOneTimeSecret } from "../lib/one-time-secrets";
import { ProjectIntegrationSection } from "./project-integration-section";

/**
 * Area 9, F5 (I2): l'Integrazione con la chiave MASCHERATA. La chiave intera
 * si vede solo dopo la rigenerazione; chi non può rigenerare vede le ultime 4
 * e il rimando a chi gestisce il progetto. La rete è un `fetch` finto.
 */
const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

// La fixture NON ha `createdAt`/`createdBy` né `gitWebhooks`: la difesa nel punto di lettura (CLAUDE.md, il web non parsa).
function integration(canRegenerateKey: boolean) {
  return { ingestion: { last4: "9f3a", dsnBase: "https://s.example.com/p/demo" }, inbound: { url: "https://s.example.com/api/inbound/demo/ticket" }, canRegenerateKey, canRegenerateWebhookSecret: false };
}
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function mockApi(canRegenerateKey: boolean, newKey = "0123456789abcdef0123456789abcdef") {
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "http://test.local").pathname;
    const method = init?.method ?? "GET";
    if (method === "GET" && path === `/api/projects/${PROJECT_ID}/integration`) return Promise.resolve(json(200, integration(canRegenerateKey)));
    if (method === "POST" && path === `/api/projects/${PROJECT_ID}/ingestion-key`) return Promise.resolve(json(200, { ingestionKey: newKey }));
    throw new Error(`fetch non mockata per ${method} ${raw}`);
  });
}
function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectIntegrationSection projectId={PROJECT_ID} slug="demo" projectName="Demo" />
    </QueryClientProvider>,
  );
}

describe("ProjectIntegrationSection", () => {
  it("decisione D: la chiave data dalla creazione si vede intera UNA volta; rimontato, torna mascherata", async () => {
    mockApi(false);
    stashOneTimeSecret(`ingestion-key:${PROJECT_ID}`, "fedcba9876543210fedcba9876543210");
    const first = renderSection();
    expect(await screen.findByText("fedcba9876543210fedcba9876543210")).toBeInTheDocument();
    expect(peekOneTimeSecret(`ingestion-key:${PROJECT_ID}`)).toBeNull();
    first.unmount();
    renderSection();
    expect(await screen.findByText("••••••••9f3a")).toBeInTheDocument();
    expect(screen.queryByText("fedcba9876543210fedcba9876543210")).not.toBeInTheDocument();
  });

  it("senza permesso: le ultime 4 mascherate, nessuna copia della chiave né guida, nessuna rigenerazione", async () => {
    mockApi(false);
    renderSection();
    expect(await screen.findByText("••••••••9f3a")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy ingestion key" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy SDK install guide" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate key" })).not.toBeInTheDocument();
    expect(screen.getByTestId("key-masked-hint").textContent).toContain("ask whoever manages the project");
  });

  it("chi può rigenera in due passi; la chiave nuova si vede intera e si copia, col DSN e la guida", async () => {
    const user = userEvent.setup();
    mockApi(true);
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Regenerate key" }));
    // Il primo click chiede la conferma: niente è ancora partito.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Regenerate: the current key stops working now" }));
    expect(await screen.findByText("0123456789abcdef0123456789abcdef")).toBeInTheDocument();
    expect(screen.getByText(`${window.location.protocol}//0123456789abcdef0123456789abcdef@${window.location.host}/p/demo`)).toBeInTheDocument();
    expect(screen.getByText("This is the only time you will see the new key: copy it now.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy ingestion key" }));
    expect(await navigator.clipboard.readText()).toBe("0123456789abcdef0123456789abcdef");
    expect(screen.getByRole("button", { name: "Copy SDK install guide" })).toBeInTheDocument();
  });
});
