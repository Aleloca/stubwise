import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedView, SavedViewFilters } from "../lib/api";
import { SavedViews } from "./saved-views";

/**
 * Test della barra delle viste salvate con fetch mockata a livello di rete: il
 * componente carica le viste, salva quella corrente (POST con i filtri/shared
 * giusti), applica una vista (callback onApply) ed elimina le proprie (DELETE).
 */

const OWN = "11111111-1111-4111-8111-111111111111";
const SHARED = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeView(overrides: Partial<SavedView>): SavedView {
  return {
    id: OWN,
    name: "My view",
    filters: { status: "open" },
    shared: false,
    ownerId: "me",
    isOwn: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const fetchMock = vi.fn<typeof fetch>();

interface MockState {
  views: SavedView[];
  created: { name: string; filters: SavedViewFilters; shared?: boolean }[];
  deleted: string[];
  conflictOnCreate: boolean;
}

function installMock(state: MockState) {
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";

    if (url.pathname === "/api/saved-views" && method === "GET") {
      return Promise.resolve(jsonResponse(200, state.views));
    }
    if (url.pathname === "/api/saved-views" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as MockState["created"][number];
      if (state.conflictOnCreate) {
        return Promise.resolve(
          jsonResponse(409, { code: "view_exists", message: "exists" }),
        );
      }
      state.created.push(body);
      const created = makeView({ id: SHARED, name: body.name, filters: body.filters, shared: body.shared ?? false });
      state.views = [...state.views, created];
      return Promise.resolve(jsonResponse(201, created));
    }
    const deleteMatch = url.pathname.match(/^\/api\/saved-views\/([^/]+)$/);
    if (deleteMatch && method === "DELETE") {
      const id = deleteMatch[1]!;
      state.deleted.push(id);
      state.views = state.views.filter((v) => v.id !== id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    throw new Error(`fetch non mockata per ${method} ${url.pathname}`);
  });
}

function renderViews(
  views: SavedView[],
  opts?: { currentFilters?: SavedViewFilters; conflictOnCreate?: boolean },
) {
  const state: MockState = {
    views,
    created: [],
    deleted: [],
    conflictOnCreate: opts?.conflictOnCreate ?? false,
  };
  installMock(state);
  const onApply = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SavedViews currentFilters={opts?.currentFilters ?? { status: "open" }} onApply={onApply} />
    </QueryClientProvider>,
  );
  return { state, onApply };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

describe("SavedViews", () => {
  it("stato vuoto quando non ci sono viste", async () => {
    renderViews([]);
    expect(await screen.findByText("// no saved views yet")).toBeInTheDocument();
  });

  it("salva la vista corrente: POST con i filtri correnti e shared", async () => {
    const { state } = renderViews([], {
      currentFilters: { projectId: PROJECT_ID, status: "open", q: "crash" },
    });

    await screen.findByText("// no saved views yet");
    await userEvent.type(screen.getByLabelText("View name"), "My open crashes");
    await userEvent.click(screen.getByLabelText("Share with team"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(state.created).toEqual([
        {
          name: "My open crashes",
          filters: { projectId: PROJECT_ID, status: "open", q: "crash" },
          shared: true,
        },
      ]),
    );
  });

  it("409 view_exists mostra il messaggio i18n «name exists»", async () => {
    renderViews([], { conflictOnCreate: true });

    await userEvent.type(await screen.findByLabelText("View name"), "Dup");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("A saved view with this name already exists"),
    ).toBeInTheDocument();
  });

  it("distingue le proprie dalle condivise altrui (badge) e applica al click", async () => {
    const { onApply } = renderViews([
      makeView({ id: OWN, name: "Mine", isOwn: true, shared: false, filters: { status: "open" } }),
      makeView({
        id: SHARED,
        name: "Team view",
        isOwn: false,
        shared: true,
        ownerId: "bob",
        filters: { type: "bug", priority: "urgent" },
      }),
    ]);

    expect(await screen.findByText("Mine")).toBeInTheDocument();
    expect(screen.getByText("Team view")).toBeInTheDocument();
    // La condivisa altrui mostra il badge owner; la propria no.
    expect(screen.getByText("Shared by bob")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /apply.*team view/i }));
    expect(onApply).toHaveBeenCalledWith({ type: "bug", priority: "urgent" });
  });

  it("elimina la propria vista dopo la conferma a due click", async () => {
    const { state } = renderViews([
      makeView({ id: OWN, name: "Mine", isOwn: true }),
    ]);

    const row = (await screen.findByText("Mine")).closest("li")!;
    const del = within(row).getByRole("button", { name: "Delete" });
    await userEvent.click(del);
    expect(state.deleted).toEqual([]);
    await userEvent.click(within(row).getByRole("button", { name: "Confirm?" }));
    await waitFor(() => expect(state.deleted).toEqual([OWN]));
  });

  it("le viste condivise altrui non hanno il bottone Elimina", async () => {
    renderViews([
      makeView({ id: SHARED, name: "Team view", isOwn: false, shared: true, ownerId: "bob" }),
    ]);

    const row = (await screen.findByText("Team view")).closest("li")!;
    expect(within(row).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});
