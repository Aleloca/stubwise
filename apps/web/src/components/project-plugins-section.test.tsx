import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin, PluginInventory, ProjectPlugin } from "../lib/api";
import { presetSkills, ProjectPluginsSection } from "./project-plugins-section";

/**
 * Sezione "Plugin" della pagina progetto (solo admin): quali plugin del
 * registro d'istanza entrano nei run di QUESTO progetto e quali skill/hook
 * spegnerci. Il salvataggio è immediato e manda l'INSIEME COMPLETO.
 *
 * La rete è mockata via `fetch` globale (come plugins-section.test).
 */

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUPERPOWERS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const PROJECT_PLUGINS_PATH = `/api/projects/${PROJECT_ID}/plugins`;

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

/** Body JSON della n-esima chiamata con quel metodo e path. */
function bodiesOf(method: string, path: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return (
        new URL(raw, "http://test.local").pathname === path && (init?.method ?? "GET") === method
      );
    })
    .map(([, init]) => JSON.parse(String(init?.body)) as unknown);
}

function callCount(method: string, path: string): number {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return (
      new URL(raw, "http://test.local").pathname === path && (init?.method ?? "GET") === method
    );
  }).length;
}

function makeInventory(overrides: Partial<PluginInventory> = {}): PluginInventory {
  return {
    name: "superpowers",
    version: "4.0.3",
    description: "Skill di sviluppo",
    skills: [
      { name: "test-driven-development", description: "TDD sempre", bytes: 4096 },
      { name: "using-git-worktrees", description: "Worktree isolati", bytes: 2048 },
    ],
    commands: [{ name: "brainstorm" }],
    agents: [{ name: "code-reviewer" }],
    hooks: [
      {
        key: "SessionStart#0",
        event: "SessionStart",
        matcher: "startup",
        command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.js",
      },
    ],
    hasMcp: false,
    ...overrides,
  };
}

function makePlugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    id: SUPERPOWERS_ID,
    slug: "superpowers",
    name: "superpowers",
    sourceUrl: "https://github.com/obra/superpowers",
    sourceSubdir: null,
    ref: "v4.0.3",
    resolvedSha: "abc1234def5678",
    status: "ready",
    inventory: makeInventory(),
    error: null,
    smokeStatus: "passed",
    smokeError: null,
    pendingJobKind: null,
    materializedAt: "2026-09-01T10:00:00.000Z",
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function makeRow(overrides: Partial<ProjectPlugin> = {}): ProjectPlugin {
  return {
    pluginId: SUPERPOWERS_ID,
    enabled: true,
    disabledSkills: [],
    disabledHooks: [],
    ...overrides,
  };
}

/** Le raccomandazioni sono indicizzate per `inventory.name`, non per slug. */
const RECOMMENDED = {
  superpowers: [
    "using-git-worktrees",
    "finishing-a-development-branch",
    "dispatching-parallel-agents",
    "subagent-driven-development",
  ],
};

function registry(plugins: Plugin[], recommendations: Record<string, string[]> = {}) {
  return { plugins, recommendations };
}

/**
 * La sezione monta un `<Link to="/settings/plugins">` nello stato vuoto, quindi
 * serve il contesto di un router: lo si costruisce minimale (pattern di
 * docs-tree.test) con la sola rotta target del link.
 */
function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <ProjectPluginsSection projectId={PROJECT_ID} />
      </QueryClientProvider>
    ),
  });
  const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/plugins" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

/** L'`li` del plugin col nome dato: le asserzioni di riga partono da qui. */
async function rowOf(name: string): Promise<HTMLElement> {
  return (await screen.findByText(name)).closest("li") as HTMLElement;
}

describe("ProjectPluginsSection — lettura", () => {
  it("avvisa che i run di deep dive e analisi non caricano le impostazioni del repo", async () => {
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()])),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () => jsonResponse(200, { plugins: [] }),
    });
    renderSection();

    expect(await screen.findByText(/\.claude\/settings\.json/)).toBeInTheDocument();
  });

  it("riflette lo stato del server sul toggle di ogni plugin", async () => {
    mockApi({
      "GET /api/plugins": () =>
        jsonResponse(
          200,
          registry([makePlugin(), makePlugin({ id: OTHER_ID, slug: "altro", name: "altro" })]),
        ),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () => jsonResponse(200, { plugins: [makeRow()] }),
    });
    renderSection();

    const superpowers = await rowOf("superpowers");
    expect(
      within(superpowers).getByRole("checkbox", { name: /enabled in this project/i }),
    ).toBeChecked();

    const altro = await rowOf("altro");
    expect(
      within(altro).getByRole("checkbox", { name: /enabled in this project/i }),
    ).not.toBeChecked();
  });

  it("mostra skill e hook (col comando in chiaro) di un plugin abilitato", async () => {
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()])),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () =>
        jsonResponse(200, { plugins: [makeRow({ disabledSkills: ["using-git-worktrees"] })] }),
    });
    renderSection();

    expect(await screen.findByRole("checkbox", { name: /test-driven-development/ })).toBeChecked();
    // Spenta lato server ⇒ casella non selezionata (selezionata = gira).
    expect(screen.getByRole("checkbox", { name: /using-git-worktrees/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /SessionStart/ })).toBeChecked();
    expect(screen.getByText(/hooks\/session-start\.js/)).toBeInTheDocument();
  });

  it("non mostra skill né hook di un plugin non abilitato sul progetto", async () => {
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()])),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () => jsonResponse(200, { plugins: [] }),
    });
    renderSection();

    await screen.findByRole("checkbox", { name: /enabled in this project/i });
    expect(screen.queryByRole("checkbox", { name: /test-driven-development/ })).toBeNull();
  });

  it("su un plugin senza revisione materializzata offre il toggle ma nessuna casella", async () => {
    mockApi({
      "GET /api/plugins": () =>
        jsonResponse(
          200,
          registry([makePlugin({ status: "failed", inventory: null, resolvedSha: null })]),
        ),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () => jsonResponse(200, { plugins: [makeRow()] }),
    });
    renderSection();

    const row = await rowOf("superpowers");
    expect(within(row).getByRole("checkbox", { name: /enabled in this project/i })).toBeChecked();
    expect(within(row).queryByRole("checkbox", { name: /test-driven-development/ })).toBeNull();
    expect(within(row).getByText(/no materialized revision/i)).toBeInTheDocument();
  });

  it("mostra uno stato vuoto quando il registro d'istanza è vuoto", async () => {
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([])),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () => jsonResponse(200, { plugins: [] }),
    });
    renderSection();

    expect(await screen.findByText(/no plugins registered/i)).toBeInTheDocument();
  });

  it("degrada a un messaggio se il caricamento fallisce", async () => {
    mockApi({
      "GET /api/plugins": () => jsonResponse(500, { code: "generic", message: "boom" }),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () => jsonResponse(200, { plugins: [] }),
    });
    renderSection();

    expect(await screen.findByText(/could not load the plugins/i)).toBeInTheDocument();
  });
});

describe("ProjectPluginsSection — salvataggio", () => {
  it("abilitando un plugin manda l'insieme completo, conservando le altre righe", async () => {
    const user = userEvent.setup();
    const server = [makeRow({ disabledSkills: ["using-git-worktrees"] })];
    mockApi({
      "GET /api/plugins": () =>
        jsonResponse(
          200,
          registry([makePlugin(), makePlugin({ id: OTHER_ID, slug: "altro", name: "altro" })]),
        ),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () => jsonResponse(200, { plugins: server }),
      [`PUT ${PROJECT_PLUGINS_PATH}`]: (_url, init) =>
        jsonResponse(200, JSON.parse(String(init?.body))),
    });
    renderSection();

    const altro = await rowOf("altro");
    await user.click(within(altro).getByRole("checkbox", { name: /enabled in this project/i }));

    await waitFor(() => expect(callCount("PUT", PROJECT_PLUGINS_PATH)).toBe(1));
    expect(bodiesOf("PUT", PROJECT_PLUGINS_PATH)[0]).toEqual({
      plugins: [
        {
          pluginId: SUPERPOWERS_ID,
          enabled: true,
          disabledSkills: ["using-git-worktrees"],
          disabledHooks: [],
        },
        { pluginId: OTHER_ID, enabled: true, disabledSkills: [], disabledHooks: [] },
      ],
    });
  });

  it("disabilitando un plugin manda la riga con enabled false, non la omette", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()])),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () =>
        jsonResponse(200, {
          plugins: [
            makeRow({ disabledSkills: ["using-git-worktrees"], disabledHooks: ["SessionStart#0"] }),
          ],
        }),
      [`PUT ${PROJECT_PLUGINS_PATH}`]: (_url, init) =>
        jsonResponse(200, JSON.parse(String(init?.body))),
    });
    renderSection();

    await user.click(await screen.findByRole("checkbox", { name: /enabled in this project/i }));

    await waitFor(() => expect(callCount("PUT", PROJECT_PLUGINS_PATH)).toBe(1));
    expect(bodiesOf("PUT", PROJECT_PLUGINS_PATH)[0]).toEqual({
      plugins: [
        {
          pluginId: SUPERPOWERS_ID,
          enabled: false,
          disabledSkills: ["using-git-worktrees"],
          disabledHooks: ["SessionStart#0"],
        },
      ],
    });
  });

  it("deselezionando una skill la manda fra quelle spente", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()])),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () => jsonResponse(200, { plugins: [makeRow()] }),
      [`PUT ${PROJECT_PLUGINS_PATH}`]: (_url, init) =>
        jsonResponse(200, JSON.parse(String(init?.body))),
    });
    renderSection();

    await user.click(await screen.findByRole("checkbox", { name: /test-driven-development/ }));

    await waitFor(() => expect(callCount("PUT", PROJECT_PLUGINS_PATH)).toBe(1));
    expect(bodiesOf("PUT", PROJECT_PLUGINS_PATH)[0]).toEqual({
      plugins: [
        {
          pluginId: SUPERPOWERS_ID,
          enabled: true,
          disabledSkills: ["test-driven-development"],
          disabledHooks: [],
        },
      ],
    });
  });

  it("deselezionando un hook manda la sua chiave fra quelli spenti", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()])),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () => jsonResponse(200, { plugins: [makeRow()] }),
      [`PUT ${PROJECT_PLUGINS_PATH}`]: (_url, init) =>
        jsonResponse(200, JSON.parse(String(init?.body))),
    });
    renderSection();

    await user.click(await screen.findByRole("checkbox", { name: /SessionStart/ }));

    await waitFor(() => expect(callCount("PUT", PROJECT_PLUGINS_PATH)).toBe(1));
    expect(bodiesOf("PUT", PROJECT_PLUGINS_PATH)[0]).toEqual({
      plugins: [
        {
          pluginId: SUPERPOWERS_ID,
          enabled: true,
          disabledSkills: [],
          disabledHooks: ["SessionStart#0"],
        },
      ],
    });
  });
});

describe("ProjectPluginsSection — preset consigliato", () => {
  it("manda solo le skill del preset che esistono davvero nell'inventario", async () => {
    const user = userEvent.setup();
    mockApi({
      // L'inventario ha una sola delle quattro skill consigliate.
      "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()], RECOMMENDED)),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () => jsonResponse(200, { plugins: [makeRow()] }),
      [`PUT ${PROJECT_PLUGINS_PATH}`]: (_url, init) =>
        jsonResponse(200, JSON.parse(String(init?.body))),
    });
    renderSection();

    await user.click(await screen.findByRole("button", { name: /recommended preset/i }));

    await waitFor(() => expect(callCount("PUT", PROJECT_PLUGINS_PATH)).toBe(1));
    expect(bodiesOf("PUT", PROJECT_PLUGINS_PATH)[0]).toEqual({
      plugins: [
        {
          pluginId: SUPERPOWERS_ID,
          enabled: true,
          disabledSkills: ["using-git-worktrees"],
          disabledHooks: [],
        },
      ],
    });
  });

  it("conserva gli spegnimenti già fatti a mano quando applica il preset", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()], RECOMMENDED)),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () =>
        jsonResponse(200, { plugins: [makeRow({ disabledSkills: ["test-driven-development"] })] }),
      [`PUT ${PROJECT_PLUGINS_PATH}`]: (_url, init) =>
        jsonResponse(200, JSON.parse(String(init?.body))),
    });
    renderSection();

    await user.click(await screen.findByRole("button", { name: /recommended preset/i }));

    await waitFor(() => expect(callCount("PUT", PROJECT_PLUGINS_PATH)).toBe(1));
    expect(bodiesOf("PUT", PROJECT_PLUGINS_PATH)[0]).toEqual({
      plugins: [
        {
          pluginId: SUPERPOWERS_ID,
          enabled: true,
          disabledSkills: ["test-driven-development", "using-git-worktrees"],
          disabledHooks: [],
        },
      ],
    });
  });

  it("non offre il preset per un plugin senza raccomandazioni", async () => {
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()], {})),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () => jsonResponse(200, { plugins: [makeRow()] }),
    });
    renderSection();

    await screen.findByRole("checkbox", { name: /test-driven-development/ });
    expect(screen.queryByRole("button", { name: /recommended preset/i })).toBeNull();
  });
});

describe("ProjectPluginsSection — errori del salvataggio", () => {
  it("su inventario cambiato ricarica e NON riprova scartando la voce sconosciuta", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()])),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () => jsonResponse(200, { plugins: [makeRow()] }),
      [`PUT ${PROJECT_PLUGINS_PATH}`]: () =>
        jsonResponse(400, {
          code: "unknown_plugin_skill",
          message: "Unknown skill in the plugin inventory (superpowers: test-driven-development)",
        }),
    });
    renderSection();

    const skill = await screen.findByRole("checkbox", { name: /test-driven-development/ });
    await user.click(skill);

    expect(await screen.findByRole("alert")).toHaveTextContent(/inventory/i);
    // Un solo PUT: nessun retry che scarterebbe in silenzio lo spegnimento.
    expect(callCount("PUT", PROJECT_PLUGINS_PATH)).toBe(1);
    // Registro e abilitazioni ricaricati: il form si ricostruisce dal fresco.
    await waitFor(() => expect(callCount("GET", "/api/plugins")).toBeGreaterThan(1));
    await waitFor(() => expect(callCount("GET", PROJECT_PLUGINS_PATH)).toBeGreaterThan(1));
  });

  it("su errore riporta le caselle alla foto del server", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()])),
      [`GET ${PROJECT_PLUGINS_PATH}`]: () => jsonResponse(200, { plugins: [makeRow()] }),
      [`PUT ${PROJECT_PLUGINS_PATH}`]: () =>
        jsonResponse(500, { code: "generic", message: "boom" }),
    });
    renderSection();

    const toggle = await screen.findByRole("checkbox", { name: /enabled in this project/i });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /enabled in this project/i })).toBeChecked(),
    );
  });
});

describe("presetSkills", () => {
  it("tiene solo le skill consigliate presenti nell'inventario", () => {
    expect(presetSkills(makeInventory(), RECOMMENDED)).toEqual(["using-git-worktrees"]);
  });

  it("è vuoto se l'inventario non ha nessuna delle skill consigliate", () => {
    const inventory = makeInventory({ skills: [{ name: "brainstorming", bytes: 100 }] });
    expect(presetSkills(inventory, RECOMMENDED)).toEqual([]);
  });

  it("cerca per nome del manifest, non per slug del registro", () => {
    // Stesso inventario, ma il manifest si chiama diversamente: nessun preset.
    expect(presetSkills(makeInventory({ name: "altro-nome" }), RECOMMENDED)).toEqual([]);
  });

  it("è vuoto senza inventario", () => {
    expect(presetSkills(null, RECOMMENDED)).toEqual([]);
  });
});
