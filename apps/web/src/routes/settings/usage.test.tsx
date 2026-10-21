import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsUsagePage } from "./usage";

/**
 * Pagina Utilizzo (solo admin). Rete mockata via `fetch`. Le fixture OMETTONO
 * apposta `cacheCreationTokens` (e `subKey`): il web non parsa le risposte,
 * quindi la difesa `?? 0` / `?? null` nel punto di lettura deve reggere da sola.
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

const costs = {
  range: { from: "2026-09-21", to: "2026-10-21" },
  totals: { costUsd: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, jobs: 2 },
  byDay: [],
  byModel: [],
  byProject: [
    {
      projectId: null,
      projectName: null,
      costUsd: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
    },
  ],
  byProvider: [],
};

function breakdownRows() {
  return {
    rows: [
      {
        key: "fix_execute",
        label: null,
        subKey: "claude-opus-5-5",
        subLabel: null,
        runs: 3,
        inputTokens: 3000,
        outputTokens: 600,
        cacheReadTokens: 12,
        costUsd: 0.5,
        avgTokensPerRun: 1200,
      },
      {
        key: "usage_probe",
        label: null,
        subKey: "haiku",
        subLabel: null,
        runs: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        costUsd: null,
        avgTokensPerRun: 2,
      },
    ],
  };
}

function urls(): string[] {
  return fetchMock.mock.calls.map(([u]) => String(u));
}

function mockApi(rows: unknown = breakdownRows()) {
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/api/ai-usage/breakdown")) return Promise.resolve(jsonResponse(rows));
    return Promise.resolve(jsonResponse(costs));
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SettingsUsagePage />
    </QueryClientProvider>,
  );
}

describe("SettingsUsagePage", () => {
  it("operazione x modello: etichette tradotte, 0 per il campo mancante, trattino senza costo", async () => {
    mockApi();
    renderPage();
    const fix = (await screen.findByText("Fix execution")).closest("tr")!;
    expect(within(fix).getByText("claude-opus-5-5")).toBeInTheDocument();
    expect(within(fix).getByText("3")).toBeInTheDocument();
    // cacheCreationTokens assente nella fixture: 0, non "NaN"/vuoto.
    expect(within(fix).getAllByText("0").length).toBeGreaterThan(0);
    expect(within(fix).getByText("$0.5000")).toBeInTheDocument();

    const probe = screen.getByText("Usage probe").closest("tr")!;
    expect(within(probe).getByText("—")).toBeInTheDocument();
    expect(urls().some((u) => u.includes("groupBy=operation") && u.includes("thenBy=model"))).toBe(
      true,
    );
  });

  it("una chiave null per progetto mostra «No project»", async () => {
    mockApi({
      rows: [
        {
          key: null,
          label: null,
          runs: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          costUsd: 0.1,
          avgTokensPerRun: 2,
        },
      ],
    });
    renderPage();
    const select = await screen.findByLabelText("Group by");
    await userEvent.selectOptions(select, "project");
    await userEvent.selectOptions(screen.getByLabelText("Then by"), "");
    await waitFor(() =>
      expect(urls().some((u) => u.includes("groupBy=project") && !u.includes("thenBy"))).toBe(true),
    );
    const table = await screen.findByTestId("usage-breakdown");
    expect(within(table).getByText("No project")).toBeInTheDocument();
    // E anche la tabella esistente per progetto, con projectId null.
    expect(
      within(screen.getByTestId("usage-by-project")).getByText("No project"),
    ).toBeInTheDocument();
  });

  it("un intervallo libero manda from e to", async () => {
    mockApi();
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText("Period"), "custom");
    const from = screen.getByLabelText("From");
    await userEvent.clear(from);
    await userEvent.type(from, "2026-10-01");
    const to = screen.getByLabelText("To");
    await userEvent.clear(to);
    await userEvent.type(to, "2026-10-10");
    await waitFor(() =>
      expect(urls().some((u) => u.includes("from=2026-10-01") && u.includes("to=2026-10-10"))).toBe(
        true,
      ),
    );
  });
});
