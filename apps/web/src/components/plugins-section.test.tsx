import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin, PluginInventory } from "../lib/api";
import { PluginsSection } from "./plugins-section";

/**
 * Sezione "Plugin" delle impostazioni (solo admin): registro d'istanza dei
 * plugin di Claude Code. Lista con badge di stato e smoke, form di
 * registrazione, inventario espandibile (skill, comandi, agenti, hook col
 * comando in chiaro) e azioni Aggiorna / Riprova smoke / Rimuovi.
 * La rete è mockata via `fetch` globale (come ai-providers-section.test).
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

function makeInventory(overrides: Partial<PluginInventory> = {}): PluginInventory {
  return {
    name: "superpowers",
    version: "4.0.3",
    description: "Skill di sviluppo",
    skills: [{ name: "test-driven-development", description: "TDD sempre", bytes: 4096 }],
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
    hasMcp: true,
    ...overrides,
  };
}

function makePlugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    id: "11111111-1111-4111-8111-111111111111",
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

function registry(plugins: Plugin[], recommendations: Record<string, string[]> = {}) {
  return { plugins, recommendations };
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PluginsSection />
    </QueryClientProvider>,
  );
}

/** L'`li` del plugin col nome dato: le asserzioni di riga partono da qui. */
async function rowOf(name: string): Promise<HTMLElement> {
  return (await screen.findByText(name)).closest("li") as HTMLElement;
}

describe("PluginsSection — lista", () => {
  it("mostra slug, ref, pin e i badge di stato e smoke", async () => {
    mockApi({
      "GET /api/plugins": () =>
        jsonResponse(
          200,
          registry([
            makePlugin(),
            makePlugin({
              id: "22222222-2222-4222-8222-222222222222",
              slug: "altro",
              name: "altro",
              status: "materializing",
              smokeStatus: "idle",
              resolvedSha: null,
              inventory: null,
              materializedAt: null,
              pendingJobKind: "materialize",
            }),
          ]),
        ),
    });

    renderSection();

    const ready = await rowOf("superpowers");
    expect(within(ready).getByText("Ready")).toBeInTheDocument();
    expect(within(ready).getByText(/Smoke passed/)).toBeInTheDocument();
    expect(within(ready).getByText(/ref v4\.0\.3/)).toBeInTheDocument();
    expect(within(ready).getByText(/pin abc1234/)).toBeInTheDocument();

    const pending = await rowOf("altro");
    expect(within(pending).getByText("Materializing…")).toBeInTheDocument();
    expect(within(pending).getByText(/never materialized/)).toBeInTheDocument();
  });

  it("un plugin appena registrato è 'in attesa di materializzazione', non uno stato di quiete", async () => {
    mockApi({
      "GET /api/plugins": () =>
        jsonResponse(
          200,
          registry([
            makePlugin({
              status: "none",
              resolvedSha: null,
              inventory: null,
              smokeStatus: "idle",
              materializedAt: null,
              pendingJobKind: "materialize",
            }),
          ]),
        ),
    });

    renderSection();
    const row = await rowOf("superpowers");
    expect(within(row).getByText("Waiting for materialization")).toBeInTheDocument();
  });

  it("senza plugin mostra il vuoto", async () => {
    mockApi({ "GET /api/plugins": () => jsonResponse(200, registry([])) });
    renderSection();
    expect(await screen.findByText(/no plugins registered/i)).toBeInTheDocument();
  });

  it("un plugin failed mostra l'errore SENZA perdere l'inventario last-known-good", async () => {
    mockApi({
      "GET /api/plugins": () =>
        jsonResponse(
          200,
          registry([
            makePlugin({
              status: "failed",
              error: "git fetch: repository not found",
              // Semantica last-known-good: sha e inventario della revisione
              // precedente restano.
              resolvedSha: "abc1234def5678",
              inventory: makeInventory(),
            }),
          ]),
        ),
    });

    renderSection();
    const row = await rowOf("superpowers");
    expect(within(row).getByText("Failed")).toBeInTheDocument();
    expect(within(row).getByText(/repository not found/)).toBeInTheDocument();
    // L'inventario buono è ancora consultabile.
    expect(within(row).getByRole("button", { name: /inventory/i })).toBeInTheDocument();
  });

  it("uno smoke fallito mostra il suo errore", async () => {
    mockApi({
      "GET /api/plugins": () =>
        jsonResponse(
          200,
          registry([
            makePlugin({ smokeStatus: "failed", smokeError: "skill not visible to the CLI" }),
          ]),
        ),
    });

    renderSection();
    const row = await rowOf("superpowers");
    expect(within(row).getByText(/skill not visible to the CLI/)).toBeInTheDocument();
  });
});

describe("PluginsSection — inventario", () => {
  it("espanso elenca skill con descrizione e KB, comandi, agenti, hook col comando e la nota .mcp.json", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()])) });
    renderSection();

    const row = await rowOf("superpowers");
    await user.click(within(row).getByRole("button", { name: /inventory/i }));

    expect(within(row).getByText("test-driven-development")).toBeInTheDocument();
    expect(within(row).getByText(/TDD sempre/)).toBeInTheDocument();
    expect(within(row).getByText(/4\.0 KB/)).toBeInTheDocument();
    expect(within(row).getByText("brainstorm")).toBeInTheDocument();
    expect(within(row).getByText("code-reviewer")).toBeInTheDocument();
    expect(within(row).getByText("SessionStart")).toBeInTheDocument();
    // Un hook è codice che gira: il comando si legge in chiaro.
    expect(
      within(row).getByText("node ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.js"),
    ).toBeInTheDocument();
    expect(within(row).getByText(/\.mcp\.json present/)).toBeInTheDocument();
  });

  it("un plugin ready con inventario null non rompe la lista", async () => {
    mockApi({
      "GET /api/plugins": () =>
        jsonResponse(200, registry([makePlugin({ status: "ready", inventory: null })])),
    });

    renderSection();
    const row = await rowOf("superpowers");
    expect(within(row).getByText(/no inventory available/i)).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /inventory/i })).not.toBeInTheDocument();
  });

  it("un plugin senza skill, comandi, agenti o hook mostra le liste vuote", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/plugins": () =>
        jsonResponse(
          200,
          registry([
            makePlugin({
              inventory: makeInventory({
                skills: [],
                commands: [],
                agents: [],
                hooks: [],
                hasMcp: false,
              }),
            }),
          ]),
        ),
    });

    renderSection();
    const row = await rowOf("superpowers");
    await user.click(within(row).getByRole("button", { name: /inventory/i }));

    expect(within(row).getAllByText(/\/\/ none/)).toHaveLength(4);
    expect(within(row).queryByText(/\.mcp\.json present/)).not.toBeInTheDocument();
  });
});

describe("PluginsSection — registrazione", () => {
  it("il form invia il POST con sourceUrl, ref e subdir", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([])),
      "POST /api/plugins": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, makePlugin());
      },
    });

    renderSection();
    await user.click(await screen.findByRole("button", { name: /add plugin/i }));

    await user.type(screen.getByLabelText("Source URL"), "https://github.com/obra/superpowers");
    await user.type(screen.getByLabelText("Ref"), "v4.0.3");
    await user.type(screen.getByLabelText(/subdirectory/i), "plugins/superpowers");
    await user.click(screen.getByRole("button", { name: "Register plugin" }));

    await waitFor(() =>
      expect(postBody).toEqual({
        sourceUrl: "https://github.com/obra/superpowers",
        ref: "v4.0.3",
        sourceSubdir: "plugins/superpowers",
      }),
    );
  });

  it("subdir vuota: il campo NON viaggia (è opzionale, non una stringa vuota)", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([])),
      "POST /api/plugins": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, makePlugin());
      },
    });

    renderSection();
    await user.click(await screen.findByRole("button", { name: /add plugin/i }));
    await user.type(screen.getByLabelText("Source URL"), "https://github.com/obra/superpowers");
    await user.type(screen.getByLabelText("Ref"), "main");
    await user.click(screen.getByRole("button", { name: "Register plugin" }));

    await waitFor(() =>
      expect(postBody).toEqual({
        sourceUrl: "https://github.com/obra/superpowers",
        ref: "main",
      }),
    );
  });

  it("409 plugin_slug_taken: nomina lo slug in conflitto e dice come uscirne", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([])),
      "POST /api/plugins": () =>
        jsonResponse(409, {
          code: "plugin_slug_taken",
          message: 'A plugin with slug "superpowers" is already registered',
        }),
    });

    renderSection();
    await user.click(await screen.findByRole("button", { name: /add plugin/i }));
    await user.type(screen.getByLabelText("Source URL"), "https://github.com/obra/superpowers");
    await user.type(screen.getByLabelText("Ref"), "main");
    await user.click(screen.getByRole("button", { name: "Register plugin" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("superpowers");
    expect(alert).toHaveTextContent(/remove the existing plugin/i);
  });

  it("409 plugin_slug_taken senza virgolette nel messaggio: degrada al messaggio del server", async () => {
    // Il ramo difensivo di `creationErrorMessage`: lo slug viaggia SOLO dentro
    // il messaggio del server, quindi se un giorno quel messaggio cambia forma
    // l'estrazione fallisce — e l'utente deve vedere comunque ciò che il server
    // ha detto, non un errore muto.
    const user = userEvent.setup();
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([])),
      "POST /api/plugins": () =>
        jsonResponse(409, {
          code: "plugin_slug_taken",
          message: "A plugin with slug superpowers is already registered",
        }),
    });

    renderSection();
    await user.click(await screen.findByRole("button", { name: /add plugin/i }));
    await user.type(screen.getByLabelText("Source URL"), "https://github.com/obra/superpowers");
    await user.type(screen.getByLabelText("Ref"), "main");
    await user.click(screen.getByRole("button", { name: "Register plugin" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A plugin with slug superpowers is already registered",
    );
  });

  it("400 invalid_plugin_slug: messaggio tradotto dal code", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([])),
      "POST /api/plugins": () =>
        jsonResponse(400, { code: "invalid_plugin_slug", message: "Cannot derive a slug" }),
    });

    renderSection();
    await user.click(await screen.findByRole("button", { name: /add plugin/i }));
    await user.type(screen.getByLabelText("Source URL"), "https://github.com/obra/");
    await user.type(screen.getByLabelText("Ref"), "main");
    await user.click(screen.getByRole("button", { name: "Register plugin" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /cannot derive a valid plugin slug/i,
    );
  });
});

describe("PluginsSection — azioni", () => {
  it("Aggiorna invia POST /update col nuovo ref", async () => {
    const user = userEvent.setup();
    let updateBody: unknown;
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()])),
      "POST /api/plugins/11111111-1111-4111-8111-111111111111/update": (_url, init) => {
        updateBody = JSON.parse(String(init?.body));
        return jsonResponse(202, { queued: true });
      },
    });

    renderSection();
    const row = await rowOf("superpowers");
    await user.click(within(row).getByRole("button", { name: /update to ref/i }));

    const field = within(row).getByLabelText("New ref");
    await user.clear(field);
    await user.type(field, "v4.1.0");
    await user.click(within(row).getByRole("button", { name: "Update" }));

    await waitFor(() => expect(updateBody).toEqual({ ref: "v4.1.0" }));
  });

  it("Riprova smoke invia POST /smoke", async () => {
    const user = userEvent.setup();
    let smoked = false;
    mockApi({
      "GET /api/plugins": () =>
        jsonResponse(200, registry([makePlugin({ pendingJobKind: smoked ? "smoke" : null })])),
      "POST /api/plugins/11111111-1111-4111-8111-111111111111/smoke": () => {
        smoked = true;
        return jsonResponse(202, { queued: true });
      },
    });

    renderSection();
    const row = await rowOf("superpowers");
    await user.click(within(row).getByRole("button", { name: /retry smoke/i }));

    await waitFor(() => expect(smoked).toBe(true));
  });

  it("con un job in volo Aggiorna e Riprova smoke sono disabilitati (il 409 non si offre)", async () => {
    mockApi({
      "GET /api/plugins": () =>
        jsonResponse(200, registry([makePlugin({ pendingJobKind: "materialize" })])),
    });

    renderSection();
    const row = await rowOf("superpowers");
    expect(within(row).getByRole("button", { name: /update to ref/i })).toBeDisabled();
    expect(within(row).getByRole("button", { name: /retry smoke/i })).toBeDisabled();
  });

  it("un job accodato mentre il form di aggiornamento è aperto disabilita anche il submit", async () => {
    // Il bottone che APRE il form è gated su `pendingJobKind`, ma il form resta
    // aperto: se nel frattempo un job entra in coda (qui lo smoke, nella realtà
    // anche un altro admin) il submit prenderebbe un 409 `plugin_job_pending`.
    const user = userEvent.setup();
    let queued = false;
    mockApi({
      "GET /api/plugins": () =>
        jsonResponse(200, registry([makePlugin({ pendingJobKind: queued ? "smoke" : null })])),
      "POST /api/plugins/11111111-1111-4111-8111-111111111111/smoke": () => {
        queued = true;
        return jsonResponse(202, { queued: true });
      },
    });

    renderSection();
    const row = await rowOf("superpowers");
    await user.click(within(row).getByRole("button", { name: /update to ref/i }));
    expect(within(row).getByRole("button", { name: "Update" })).toBeEnabled();

    // Il job entra in coda e il refetch lo porta in pagina col form ancora aperto.
    await user.click(within(row).getByRole("button", { name: /retry smoke/i }));

    await waitFor(() => expect(within(row).getByRole("button", { name: "Update" })).toBeDisabled());
  });

  it("senza revisione materializzata lo smoke è disabilitato (sarebbe plugin_not_ready)", async () => {
    mockApi({
      "GET /api/plugins": () =>
        jsonResponse(
          200,
          registry([
            makePlugin({
              status: "failed",
              error: "git fetch KO",
              resolvedSha: null,
              inventory: null,
              smokeStatus: "idle",
              materializedAt: null,
            }),
          ]),
        ),
    });

    renderSection();
    const row = await rowOf("superpowers");
    expect(within(row).getByRole("button", { name: /retry smoke/i })).toBeDisabled();
    // L'aggiornamento invece resta possibile: è così che si riprova un fetch.
    expect(within(row).getByRole("button", { name: /update to ref/i })).toBeEnabled();
  });

  it("rimuove con conferma", async () => {
    const user = userEvent.setup();
    let deleted = false;
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry(deleted ? [] : [makePlugin()])),
      "DELETE /api/plugins/11111111-1111-4111-8111-111111111111": () => {
        deleted = true;
        return jsonResponse(204, null);
      },
    });

    renderSection();
    const row = await rowOf("superpowers");
    await user.click(within(row).getByRole("button", { name: "Remove" }));
    await user.click(within(row).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.queryByText("superpowers")).not.toBeInTheDocument());
  });

  it("409 plugin_in_use sulla rimozione: dice di disabilitarlo prima sui progetti", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()])),
      "DELETE /api/plugins/11111111-1111-4111-8111-111111111111": () =>
        jsonResponse(409, { code: "plugin_in_use", message: "The plugin is enabled" }),
    });

    renderSection();
    const row = await rowOf("superpowers");
    await user.click(within(row).getByRole("button", { name: "Remove" }));
    await user.click(within(row).getByRole("button", { name: "Confirm" }));

    expect(await within(row).findByRole("alert")).toHaveTextContent(
      /disable it there before removing it/i,
    );
  });

  it("l'errore di un'azione sparisce quando il polling porta una revisione nuova della riga", async () => {
    // Un 409 descrive lo STATO in cui il server ha rifiutato l'azione: quando
    // quello stato non c'è più (il worker ha scritto, `updatedAt` è avanzato)
    // il messaggio è stantio e va tolto da solo, senza un refresh a mano.
    const user = userEvent.setup();
    let settled = false;
    mockApi({
      // Il secondo plugin ha un job in volo: tiene acceso il polling del
      // registro (è una query sola) senza toccare le azioni del primo.
      "GET /api/plugins": () =>
        jsonResponse(
          200,
          registry([
            makePlugin({
              updatedAt: settled ? "2026-09-01T11:00:00.000Z" : "2026-09-01T10:00:00.000Z",
            }),
            makePlugin({
              id: "22222222-2222-4222-8222-222222222222",
              slug: "altro",
              name: "altro",
              pendingJobKind: "materialize",
            }),
          ]),
        ),
      "POST /api/plugins/11111111-1111-4111-8111-111111111111/smoke": () =>
        jsonResponse(409, { code: "plugin_job_pending", message: "A smoke job is running" }),
    });

    renderSection();
    const row = await rowOf("superpowers");
    await user.click(within(row).getByRole("button", { name: /retry smoke/i }));
    expect(await within(row).findByRole("alert")).toHaveTextContent(/wait for it to finish/i);

    settled = true;
    await waitFor(() => expect(within(row).queryByRole("alert")).not.toBeInTheDocument(), {
      timeout: 6_000,
    });
  });
});

describe("PluginsSection — diff dell'inventario dopo un aggiornamento", () => {
  it("al cambio di resolvedSha elenca skill e hook aggiunti, rimossi e cambiati", async () => {
    const user = userEvent.setup();
    let updated = false;
    mockApi({
      "GET /api/plugins": () =>
        jsonResponse(
          200,
          registry([
            updated
              ? makePlugin({
                  resolvedSha: "999888777",
                  inventory: makeInventory({
                    skills: [
                      { name: "test-driven-development", description: "TDD sempre", bytes: 8192 },
                      { name: "writing-plans", bytes: 1024 },
                    ],
                    hooks: [
                      {
                        key: "SessionStart#0",
                        event: "SessionStart",
                        command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/nuovo.js",
                      },
                    ],
                  }),
                })
              : makePlugin({
                  inventory: makeInventory({
                    skills: [
                      { name: "test-driven-development", description: "TDD sempre", bytes: 4096 },
                      { name: "using-git-worktrees", bytes: 2048 },
                    ],
                  }),
                }),
          ]),
        ),
      "POST /api/plugins/11111111-1111-4111-8111-111111111111/update": () => {
        updated = true;
        return jsonResponse(202, { queued: true });
      },
    });

    renderSection();
    const row = await rowOf("superpowers");
    await user.click(within(row).getByRole("button", { name: /update to ref/i }));
    await user.click(within(row).getByRole("button", { name: "Update" }));

    expect(await within(row).findByText(/Skills added: writing-plans/)).toBeInTheDocument();
    expect(within(row).getByText(/Skills removed: using-git-worktrees/)).toBeInTheDocument();
    // Cambiata la dimensione del SKILL.md: la skill c'è ancora ma non è la stessa.
    expect(within(row).getByText(/Skills changed: test-driven-development/)).toBeInTheDocument();
    expect(within(row).getByText(/Hooks changed: SessionStart#0/)).toBeInTheDocument();
  });

  it("senza cambio di sha non mostra nessun diff", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/plugins": () => jsonResponse(200, registry([makePlugin()])),
      "POST /api/plugins/11111111-1111-4111-8111-111111111111/update": () =>
        jsonResponse(202, { queued: true }),
    });

    renderSection();
    const row = await rowOf("superpowers");
    await user.click(within(row).getByRole("button", { name: /update to ref/i }));
    await user.click(within(row).getByRole("button", { name: "Update" }));

    await waitFor(() =>
      expect(within(row).queryByRole("button", { name: /update to ref/i })).toBeInTheDocument(),
    );
    expect(within(row).queryByText(/Inventory changes/i)).not.toBeInTheDocument();
  });
});
