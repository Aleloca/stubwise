import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSettingsSection } from "./model-settings-section";

/**
 * Sezione «Modelli» di Automazione (solo admin). Rete mockata via `fetch`.
 * La fixture OMETTE `workerDefault` apposta: il web non parsa le risposte,
 * quindi la difesa `?? null` nel punto di lettura deve reggere da sola.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
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

const choices = ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5"];

function view(extra: Record<string, unknown> = {}) {
  return {
    operations: [
      { operation: "fix_plan", configurable: true, model: null },
      { operation: "fix_execute", configurable: true, model: "sonnet", ...extra },
      { operation: "usage_probe", configurable: false, model: null },
    ],
    choices,
  };
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ModelSettingsSection />
    </QueryClientProvider>,
  );
}

function patchCalls() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
}

describe("ModelSettingsSection", () => {
  it("regge una risposta senza workerDefault e nasconde le operazioni tecniche", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(view())));
    renderSection();
    expect(await screen.findByLabelText("Fix plan")).toBeInTheDocument();
    expect(screen.getAllByText(/worker default/i).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/usage_probe/)).toBeNull();
  });

  it("cambiare fix_execute e salvare invia solo la riga cambiata", async () => {
    fetchMock.mockImplementation((_i, init) =>
      Promise.resolve(
        jsonResponse(init?.method === "PATCH" ? view({ model: "claude-opus-5-5" }) : view()),
      ),
    );
    const user = userEvent.setup();
    renderSection();
    const select = await screen.findByLabelText("Fix execution");
    await user.selectOptions(select, "claude-opus-5-5");
    await user.click(screen.getByRole("button", { name: /Save models/i }));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(JSON.parse(String(patchCalls()[0]![1]!.body))).toEqual({
      models: { fix_execute: "claude-opus-5-5" },
    });
  });

  it("scegliere «Predefinito» invia null", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(view())));
    const user = userEvent.setup();
    renderSection();
    const select = await screen.findByLabelText("Fix execution");
    await user.selectOptions(select, "");
    await user.click(screen.getByRole("button", { name: /Save models/i }));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(JSON.parse(String(patchCalls()[0]![1]!.body))).toEqual({
      models: { fix_execute: null },
    });
  });
});
