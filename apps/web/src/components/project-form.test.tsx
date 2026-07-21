import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProvider } from "../lib/api";
import { ProjectForm } from "./project-form";

/**
 * Form di impostazioni del PROGETTO (gruppo): nome, descrizione, provider AI e
 * toggle auto-update Docs. Provider e auto-update vivevano sul repository: ora
 * sono qui, al progetto. Il form legge i provider con `useSuspenseQuery`.
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

const PROVIDER_A: AiProvider = {
  id: "33333333-3333-4333-8333-333333333333",
  kind: "api_key",
  label: "Claude API",
  position: 0,
  enabled: true,
  secretSet: true,
  createdAt: "2026-06-01T10:00:00.000Z",
  testStatus: "idle",
  testRequestedAt: null,
  testCheckedAt: null,
  testError: null,
};

const PROVIDER_B: AiProvider = {
  id: "44444444-4444-4444-8444-444444444444",
  kind: "account",
  label: "Max subscription",
  position: 1,
  enabled: false,
  secretSet: true,
  createdAt: "2026-06-02T10:00:00.000Z",
  testStatus: "idle",
  testRequestedAt: null,
  testCheckedAt: null,
  testError: null,
};

const initial: {
  name: string;
  description: string | null;
  aiProviderId: string | null;
  docAutoUpdate: boolean;
  dailyReportEnabled: boolean;
  backlogEnabled: boolean;
} = {
  name: "Acme Platform",
  description: null,
  aiProviderId: null,
  docAutoUpdate: false,
  dailyReportEnabled: false,
  backlogEnabled: false,
};

function mockProviders() {
  fetchMock.mockImplementation((input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    if (url.pathname === "/api/ai-providers") {
      return Promise.resolve(jsonResponse(200, [PROVIDER_A, PROVIDER_B]));
    }
    throw new Error(`fetch non mockata per ${raw}`);
  });
}

async function renderForm(
  props: { onSubmit: (values: unknown) => Promise<void> },
  init = initial,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectForm initial={init} onSubmit={props.onSubmit as never} />
    </QueryClientProvider>,
  );
  await screen.findByLabelText("Name");
}

describe("ProjectForm (impostazioni del gruppo)", () => {
  it("mostra nome, descrizione, provider AI e toggle auto-update", async () => {
    mockProviders();
    await renderForm({ onSubmit: vi.fn() });

    expect(screen.getByLabelText("Name")).toHaveValue("Acme Platform");
    expect(screen.getByLabelText("Description (optional)")).toBeInTheDocument();
    const providerSelect = screen.getByLabelText("Project AI provider");
    expect(providerSelect).toHaveValue("");
    expect(screen.getByRole("option", { name: "Automatic (failover chain)" })).toBeInTheDocument();
    expect(
      screen.getByLabelText("Auto-update documentation on every push"),
    ).not.toBeChecked();
    // Nessun campo git: la configurazione del repo vive altrove.
    expect(screen.queryByLabelText("Repository URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Git account")).not.toBeInTheDocument();
  });

  it("scegliendo un provider, il PATCH invia aiProviderId", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockProviders();
    await renderForm({ onSubmit });

    await user.selectOptions(screen.getByLabelText("Project AI provider"), PROVIDER_A.id);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.aiProviderId).toBe(PROVIDER_A.id);
  });

  it("attivando l'auto-update, il PATCH invia docAutoUpdate true", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockProviders();
    await renderForm({ onSubmit });

    await user.click(screen.getByLabelText("Auto-update documentation on every push"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.docAutoUpdate).toBe(true);
  });

  it("attivando il report giornaliero, il PATCH invia dailyReportEnabled true", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockProviders();
    await renderForm({ onSubmit });

    await user.click(screen.getByLabelText("Daily activity report"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.dailyReportEnabled).toBe(true);
  });

  it("attivando il backlog, il PATCH invia backlogEnabled true", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockProviders();
    await renderForm({ onSubmit });

    await user.click(screen.getByLabelText("Discovery backlog"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.backlogEnabled).toBe(true);
  });

  it("riportando il provider su 'Automatico', il PATCH invia aiProviderId null", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockProviders();
    await renderForm({ onSubmit }, { ...initial, aiProviderId: PROVIDER_B.id });

    expect(await screen.findByLabelText("Project AI provider")).toHaveValue(PROVIDER_B.id);
    await user.selectOptions(screen.getByLabelText("Project AI provider"), "");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.aiProviderId).toBeNull();
  });

  it("senza modifiche il PATCH è vuoto", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockProviders();
    await renderForm({ onSubmit });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(payload)).toHaveLength(0);
  });

  it("impostando una descrizione, il PATCH la include", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mockProviders();
    await renderForm({ onSubmit });

    await user.type(screen.getByLabelText("Description (optional)"), "Il monorepo Acme");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.description).toBe("Il monorepo Acme");
  });
});
