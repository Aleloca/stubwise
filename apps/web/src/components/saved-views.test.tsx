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
  updated: { id: string; patch: { name?: string; filters?: SavedViewFilters; shared?: boolean } }[];
  deleted: string[];
  conflictOnCreate: boolean;
  conflictOnUpdate: boolean;
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
    const idMatch = url.pathname.match(/^\/api\/saved-views\/([^/]+)$/);
    if (idMatch && method === "PATCH") {
      const id = idMatch[1]!;
      const patch = JSON.parse(String(init?.body)) as MockState["updated"][number]["patch"];
      if (state.conflictOnUpdate) {
        return Promise.resolve(jsonResponse(409, { code: "view_exists", message: "exists" }));
      }
      state.updated.push({ id, patch });
      state.views = state.views.map((v) =>
        v.id === id ? { ...v, ...patch } : v,
      );
      const view = state.views.find((v) => v.id === id)!;
      return Promise.resolve(jsonResponse(200, view));
    }
    if (idMatch && method === "DELETE") {
      const id = idMatch[1]!;
      state.deleted.push(id);
      state.views = state.views.filter((v) => v.id !== id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    throw new Error(`fetch non mockata per ${method} ${url.pathname}`);
  });
}

function renderViews(
  views: SavedView[],
  opts?: {
    currentFilters?: SavedViewFilters;
    conflictOnCreate?: boolean;
    conflictOnUpdate?: boolean;
  },
) {
  const state: MockState = {
    views,
    created: [],
    updated: [],
    deleted: [],
    conflictOnCreate: opts?.conflictOnCreate ?? false,
    conflictOnUpdate: opts?.conflictOnUpdate ?? false,
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
    // La condivisa altrui mostra un'etichetta neutra (mai l'UUID del proprietario).
    expect(screen.getByText("Shared by a teammate")).toBeInTheDocument();

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

  it("le viste condivise altrui non hanno il bottone Modifica", async () => {
    renderViews([
      makeView({ id: SHARED, name: "Team view", isOwn: false, shared: true, ownerId: "bob" }),
    ]);

    const row = (await screen.findByText("Team view")).closest("li")!;
    expect(within(row).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("modifica la propria vista: rinomina + toggle shared → PATCH con { name, shared }", async () => {
    const { state } = renderViews([
      makeView({ id: OWN, name: "Mine", isOwn: true, shared: false, filters: { status: "open" } }),
    ]);

    const row = (await screen.findByText("Mine")).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));

    // L'editor inline rimpiazza la riga: lo si individua dal nome precompilato.
    const editor = screen.getByDisplayValue("Mine").closest("li")!;
    const nameInput = within(editor).getByLabelText("View name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Renamed");
    await userEvent.click(within(editor).getByLabelText("Share with team"));
    await userEvent.click(within(editor).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(state.updated).toEqual([{ id: OWN, patch: { name: "Renamed", shared: true } }]),
    );
    // L'inline si chiude dopo il salvataggio: niente più campo precompilato aperto.
    await waitFor(() =>
      expect(screen.queryByDisplayValue("Renamed")).not.toBeInTheDocument(),
    );
  });

  it("modifica: 409 view_exists mostra il messaggio i18n e non chiude l'inline", async () => {
    renderViews(
      [makeView({ id: OWN, name: "Mine", isOwn: true, shared: false })],
      { conflictOnUpdate: true },
    );

    const row = (await screen.findByText("Mine")).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));

    const editor = screen.getByDisplayValue("Mine").closest("li")!;
    const nameInput = within(editor).getByLabelText("View name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Dup");
    await userEvent.click(within(editor).getByRole("button", { name: "Save" }));

    expect(
      await within(editor).findByText("A saved view with this name already exists"),
    ).toBeInTheDocument();
    // L'inline resta aperto perché si possa correggere il nome.
    expect(within(editor).getByDisplayValue("Dup")).toBeInTheDocument();
  });

  it("modifica: Cancel chiude l'inline senza chiamare PATCH", async () => {
    const { state } = renderViews([
      makeView({ id: OWN, name: "Mine", isOwn: true, shared: false }),
    ]);

    const row = (await screen.findByText("Mine")).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));

    const editor = screen.getByDisplayValue("Mine").closest("li")!;
    const nameInput = within(editor).getByLabelText("View name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Discarded");
    await userEvent.click(within(editor).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByDisplayValue("Discarded")).not.toBeInTheDocument();
    expect(state.updated).toEqual([]);
  });
});
