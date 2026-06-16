import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MilestoneWithCounts } from "../lib/api";
import { MilestoneManager } from "./milestone-manager";

/**
 * Test del gestore milestone con fetch mockata a livello di rete: il
 * componente carica le milestone, e crea/rinomina/chiude/elimina con PATCH/
 * POST/DELETE reali sul mock.
 */

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeMilestone(overrides: Partial<MilestoneWithCounts>): MilestoneWithCounts {
  return {
    id: M1,
    projectId: PROJECT_ID,
    name: "v1.0",
    dueDate: null,
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    counts: { total: 4, completed: 1, byStatus: {} },
    ...overrides,
  };
}

const fetchMock = vi.fn<typeof fetch>();

interface MockState {
  milestones: MilestoneWithCounts[];
  created: unknown[];
  patches: { id: string; patch: unknown }[];
  deleted: string[];
}

function installMock(state: MockState) {
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";

    if (url.pathname === "/api/milestones" && method === "GET") {
      return Promise.resolve(jsonResponse(200, state.milestones));
    }
    if (url.pathname === "/api/milestones" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { name: string; dueDate?: string | null };
      state.created.push(body);
      const created = makeMilestone({
        id: M2,
        name: body.name,
        dueDate: body.dueDate ?? null,
        counts: { total: 0, completed: 0, byStatus: {} },
      });
      state.milestones = [...state.milestones, created];
      return Promise.resolve(jsonResponse(201, created));
    }
    const patchMatch = url.pathname.match(/^\/api\/milestones\/([^/]+)$/);
    if (patchMatch && method === "PATCH") {
      const id = patchMatch[1]!;
      const patch = JSON.parse(String(init?.body)) as Partial<MilestoneWithCounts>;
      state.patches.push({ id, patch });
      state.milestones = state.milestones.map((m) =>
        m.id === id ? { ...m, ...patch } : m,
      );
      const updated = state.milestones.find((m) => m.id === id)!;
      return Promise.resolve(jsonResponse(200, updated));
    }
    if (patchMatch && method === "DELETE") {
      const id = patchMatch[1]!;
      state.deleted.push(id);
      state.milestones = state.milestones.filter((m) => m.id !== id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    throw new Error(`fetch non mockata per ${method} ${url.pathname}`);
  });
}

function renderManager(milestones: MilestoneWithCounts[]): MockState {
  const state: MockState = { milestones, created: [], patches: [], deleted: [] };
  installMock(state);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MilestoneManager projectId={PROJECT_ID} />
    </QueryClientProvider>,
  );
  return state;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

describe("MilestoneManager", () => {
  it("rende le milestone con nome, stato e avanzamento", async () => {
    renderManager([
      makeMilestone({ id: M1, name: "v1.0", counts: { total: 4, completed: 1, byStatus: {} } }),
      makeMilestone({ id: M2, name: "v2.0", status: "closed", counts: { total: 2, completed: 2, byStatus: {} } }),
    ]);

    expect(await screen.findByText("v1.0")).toBeInTheDocument();
    expect(screen.getByText("v2.0")).toBeInTheDocument();
    expect(screen.getByText("1/4 done")).toBeInTheDocument();
    expect(screen.getByText("2/2 done")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("stato vuoto quando non ci sono milestone", async () => {
    renderManager([]);
    expect(await screen.findByText("// no milestones yet")).toBeInTheDocument();
  });

  it("crea una milestone: POST con nome e dueDate, e la lista si aggiorna", async () => {
    const state = renderManager([]);

    await screen.findByText("// no milestones yet");
    await userEvent.type(screen.getByLabelText("Milestone name"), "v3.0");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(state.created).toEqual([{ projectId: PROJECT_ID, name: "v3.0", dueDate: null }]),
    );
    expect(await screen.findByText("v3.0")).toBeInTheDocument();
  });

  it("rinomina una milestone: PATCH con il nuovo nome", async () => {
    const state = renderManager([makeMilestone({ id: M1, name: "v1.0" })]);

    const row = (await screen.findByText("v1.0")).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Rename" }));
    const input = within(row).getByDisplayValue("v1.0");
    await userEvent.clear(input);
    await userEvent.type(input, "v1.1");
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(state.patches).toEqual([{ id: M1, patch: { name: "v1.1" } }]),
    );
  });

  it("chiude una milestone aperta: PATCH status closed", async () => {
    const state = renderManager([makeMilestone({ id: M1, name: "v1.0", status: "open" })]);

    const row = (await screen.findByText("v1.0")).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(state.patches).toEqual([{ id: M1, patch: { status: "closed" } }]),
    );
  });

  it("riapre una milestone chiusa: PATCH status open", async () => {
    const state = renderManager([makeMilestone({ id: M1, name: "v1.0", status: "closed" })]);

    const row = (await screen.findByText("v1.0")).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Reopen" }));

    await waitFor(() =>
      expect(state.patches).toEqual([{ id: M1, patch: { status: "open" } }]),
    );
  });

  it("elimina una milestone solo dopo la conferma a due click", async () => {
    const state = renderManager([makeMilestone({ id: M1, name: "v1.0" })]);

    const row = (await screen.findByText("v1.0")).closest("li")!;
    const del = within(row).getByRole("button", { name: "Delete" });

    await userEvent.click(del);
    expect(state.deleted).toEqual([]);
    expect(within(row).getByRole("button", { name: "Confirm?" })).toBeInTheDocument();

    await userEvent.click(within(row).getByRole("button", { name: "Confirm?" }));
    await waitFor(() => expect(state.deleted).toEqual([M1]));
  });
});
