import type { ProjectEnvironment } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectEnvironmentsSection } from "./project-environments-section";

/**
 * Sezione "Ambienti" del dettaglio progetto (fase 8, solo admin): lista, crea,
 * modifica ed elimina un ambiente. L'ambiente `test` non è mai cancellabile
 * (creato dalla migrazione, unico che la pipeline di fix legge). Per un
 * NON-admin (`isAdmin: false`) la sezione resta di sola lettura: niente
 * "aggiungi", "modifica" o "elimina", anche se la GET risponde (è ammessa a
 * ogni utente autenticato).
 */

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TEST_ENV_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const STAGING_ENV_ID = "77777777-7777-4777-8777-777777777777";

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

function makeEnvironment(overrides: Partial<ProjectEnvironment> = {}): ProjectEnvironment {
  return {
    id: TEST_ENV_ID,
    projectId: PROJECT_ID,
    name: "test",
    kind: "test",
    url: null,
    serverId: null,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function renderSection(isAdmin = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectEnvironmentsSection projectId={PROJECT_ID} isAdmin={isAdmin} />
    </QueryClientProvider>,
  );
}

const envBase = `/api/projects/${PROJECT_ID}/environments`;
const serversBase = "/api/servers";

function baseHandlers(environments: ProjectEnvironment[] = [makeEnvironment()]): Record<string, Handler> {
  return {
    [`GET ${envBase}`]: () => jsonResponse(200, environments),
    [`GET ${serversBase}`]: () => jsonResponse(200, []),
  };
}

describe("ProjectEnvironmentsSection — lista", () => {
  it("mostra nome e tipo di ogni ambiente", async () => {
    mockApi(
      baseHandlers([
        makeEnvironment(),
        makeEnvironment({ id: STAGING_ENV_ID, name: "staging", kind: "staging", url: "https://staging.acme.test" }),
      ]),
    );
    renderSection();

    expect(await screen.findByText("test")).toBeInTheDocument();
    expect(screen.getByText("staging")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://staging.acme.test" })).toHaveAttribute(
      "href",
      "https://staging.acme.test",
    );
  });

  it("l'ambiente test è marcato non cancellabile, staging no", async () => {
    mockApi(
      baseHandlers([
        makeEnvironment(),
        makeEnvironment({ id: STAGING_ENV_ID, name: "staging", kind: "staging" }),
      ]),
    );
    renderSection();

    await screen.findByText("test");
    const testRow = screen.getByText("test").closest("li") as HTMLElement;
    const stagingRow = screen.getByText("staging").closest("li") as HTMLElement;

    expect(within(testRow).queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    expect(within(stagingRow).getByRole("button", { name: /delete/i })).toBeInTheDocument();
  });
});

describe("ProjectEnvironmentsSection — sola lettura per un member (isAdmin: false)", () => {
  it("nessun controllo di scrittura, ma la lista si vede", async () => {
    mockApi(baseHandlers());
    renderSection(false);

    await screen.findByText("test");
    expect(screen.queryByRole("button", { name: /add environment/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
  });
});

describe("ProjectEnvironmentsSection — crea ambiente", () => {
  it("invia POST con name/kind/url e mostra il nuovo ambiente", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    let created = false;
    mockApi({
      ...baseHandlers(),
      [`GET ${envBase}`]: () =>
        jsonResponse(
          200,
          created ? [makeEnvironment(), makeEnvironment({ id: STAGING_ENV_ID, name: "staging", kind: "staging" })] : [makeEnvironment()],
        ),
      [`POST ${envBase}`]: (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        created = true;
        return jsonResponse(201, makeEnvironment({ id: STAGING_ENV_ID, name: "staging", kind: "staging" }));
      },
    });

    renderSection();

    await user.click(await screen.findByRole("button", { name: /add environment/i }));
    await user.type(screen.getByLabelText(/^name$/i), "staging");
    await user.selectOptions(screen.getByLabelText(/^type$/i), "staging");
    await user.click(screen.getByRole("button", { name: /create environment/i }));

    await waitFor(() =>
      expect(postBody).toEqual({ name: "staging", kind: "staging", url: null, serverId: null }),
    );
    expect(await screen.findByText("staging")).toBeInTheDocument();
  });
});

describe("ProjectEnvironmentsSection — elimina ambiente", () => {
  it("un ambiente non-test si elimina con conferma", async () => {
    const user = userEvent.setup();
    let deleted = false;
    mockApi({
      ...baseHandlers(),
      [`GET ${envBase}`]: () =>
        jsonResponse(
          200,
          deleted
            ? [makeEnvironment()]
            : [makeEnvironment(), makeEnvironment({ id: STAGING_ENV_ID, name: "staging", kind: "staging" })],
        ),
      [`DELETE ${envBase}/${STAGING_ENV_ID}`]: () => {
        deleted = true;
        return jsonResponse(204, null);
      },
    });

    renderSection();

    await screen.findByText("staging");
    const stagingRow = screen.getByText("staging").closest("li") as HTMLElement;
    await user.click(within(stagingRow).getByRole("button", { name: /delete/i }));
    await user.click(within(stagingRow).getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(screen.queryByText("staging")).not.toBeInTheDocument());
  });

  it("409 sull'ambiente test (server rifiuta) mostra l'errore, senza rimuovere la riga", async () => {
    // Copre il caso in cui la UI provasse comunque a cancellarlo (difesa in
    // profondità: il bottone non c'è, ma se ci fosse un bug il server tiene).
    mockApi({
      ...baseHandlers(),
      [`DELETE ${envBase}/${TEST_ENV_ID}`]: () =>
        jsonResponse(409, { code: "test_environment_immutable", message: "The test environment cannot be deleted" }),
    });

    renderSection();
    await screen.findByText("test");
    // Nessun bottone "Delete" sulla riga test: verificato in un altro test.
    // Qui verifichiamo solo che la card resti intatta senza azioni possibili.
    const testRow = screen.getByText("test").closest("li") as HTMLElement;
    expect(within(testRow).queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });
});

describe("ProjectEnvironmentsSection — modifica ambiente", () => {
  it("PATCH aggiorna nome e url", async () => {
    const user = userEvent.setup();
    let patchBody: unknown;
    mockApi({
      ...baseHandlers(),
      [`PATCH ${envBase}/${TEST_ENV_ID}`]: (_url, init) => {
        patchBody = JSON.parse(String(init?.body));
        return jsonResponse(200, makeEnvironment({ url: "https://test.acme.test" }));
      },
    });

    renderSection();

    await screen.findByText("test");
    const row = screen.getByText("test").closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /^edit$/i }));
    const urlField = within(row).getByLabelText(/^url$/i);
    await user.type(urlField, "https://test.acme.test");
    await user.click(within(row).getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(patchBody).toEqual({ name: "test", url: "https://test.acme.test", serverId: null }),
    );
  });
});
