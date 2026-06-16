import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MilestoneWithCounts, Project } from "../lib/api";
import { TicketFilters } from "./ticket-filters";

const projects: Project[] = [
  {
    id: "p1",
    name: "Progetto Alfa",
    slug: "progetto-alfa",
    provider: "github",
    repoUrl: "https://github.com/acme/alfa",
    defaultBranch: "main",
    ingestionKey: "key-alfa",
    gitAccountId: "acc-1",
    gitAccountName: "GitHub Demo",
    webhookConfiguredAt: null,
    testCommand: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "p2",
    name: "Progetto Beta",
    slug: "progetto-beta",
    provider: "bitbucket",
    repoUrl: "https://bitbucket.org/acme/beta",
    defaultBranch: "main",
    ingestionKey: "key-beta",
    gitAccountId: "acc-2",
    gitAccountName: "Bitbucket Prod",
    webhookConfiguredAt: null,
    testCommand: null,
    createdAt: "2026-01-02T00:00:00.000Z",
  },
];

const milestonesFixture: MilestoneWithCounts[] = [
  {
    id: "m1",
    projectId: "p1",
    name: "Milestone Uno",
    dueDate: null,
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    counts: { total: 0, completed: 0, byStatus: {} },
  },
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    if (url.pathname === "/api/milestones") {
      return Promise.resolve(jsonResponse(200, milestonesFixture));
    }
    throw new Error(`fetch non mockata per ${url.pathname}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function renderFilters(value: Parameters<typeof TicketFilters>[0]["value"] = {}) {
  const onChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TicketFilters value={value} projects={projects} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

describe("TicketFilters", () => {
  it("selezionare uno stato chiama onChange con il valore", async () => {
    const onChange = renderFilters();

    await userEvent.selectOptions(screen.getByLabelText(/status/i), "open");

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ status: "open" });
  });

  it("tornare a «Tutti» azzera il filtro (undefined, sparisce dall'URL)", async () => {
    const onChange = renderFilters({ status: "done" });

    expect(screen.getByLabelText(/status/i)).toHaveValue("done");
    await userEvent.selectOptions(screen.getByLabelText(/status/i), "");

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ status: undefined });
  });

  it("tipo, priorità e progetto chiamano onChange con la chiave giusta", async () => {
    const onChange = renderFilters();

    await userEvent.selectOptions(screen.getByLabelText(/type/i), "bug");
    await userEvent.selectOptions(screen.getByLabelText(/priority/i), "urgent");
    await userEvent.selectOptions(screen.getByLabelText(/project/i), "p2");

    expect(onChange).toHaveBeenNthCalledWith(1, { type: "bug" });
    expect(onChange).toHaveBeenNthCalledWith(2, { priority: "urgent" });
    expect(onChange).toHaveBeenNthCalledWith(3, { projectId: "p2" });
  });

  it("il select progetto elenca i progetti per nome", () => {
    renderFilters();

    const select = screen.getByLabelText(/project/i);
    expect(select).toContainHTML("Progetto Alfa");
    expect(select).toContainHTML("Progetto Beta");
  });

  it("il select milestone è disabilitato senza projectId", () => {
    renderFilters();
    expect(screen.getByLabelText(/milestone/i)).toBeDisabled();
  });

  it("con projectId il select milestone è abilitato, elenca le milestone e naviga col param", async () => {
    const onChange = renderFilters({ projectId: "p1" });

    const select = await screen.findByLabelText(/milestone/i);
    expect(select).toBeEnabled();
    await waitFor(() => expect(select).toContainHTML("Milestone Uno"));

    await userEvent.selectOptions(select, "m1");
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ milestoneId: "m1" });
  });

  it("cambiare progetto azzera il milestoneId (coerenza per-progetto)", async () => {
    const onChange = renderFilters({ projectId: "p1", milestoneId: "m1" });

    await userEvent.selectOptions(screen.getByLabelText(/^project/i), "p2");
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ projectId: "p2", milestoneId: undefined });
  });

  it("la ricerca è debounced: una sola onChange dopo la pausa, non una per tasto", async () => {
    const onChange = renderFilters();

    await userEvent.type(screen.getByRole("searchbox", { name: /search/i }), "login");

    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ q: "login" }), {
      timeout: 1000,
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("svuotare la ricerca manda q undefined", async () => {
    const onChange = renderFilters({ q: "login" });

    await userEvent.clear(screen.getByRole("searchbox", { name: /search/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ q: undefined }), {
      timeout: 1000,
    });
  });
});
