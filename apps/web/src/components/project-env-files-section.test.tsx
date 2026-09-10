import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEnvironment } from "@stubwise/shared";
import type { ProjectEnvFile } from "../lib/api";
import { ProjectEnvFilesSection } from "./project-env-files-section";

/**
 * Sezione "File d'ambiente" del dettaglio REPOSITORY (solo admin): lista dei
 * file con le sole CHIAVI (valori mai esposti, mascherati), creazione di un
 * file, import via incolla e via upload, sostituzione/eliminazione di una
 * variabile, eliminazione di un file. I valori non transitano MAI in lettura
 * dall'API. La rete è mockata via `fetch` globale (come ai-providers-section.test).
 *
 * Fase 8: i file si organizzano per AMBIENTE del progetto — la sezione carica
 * anche `GET /api/projects/:projectId/environments`.
 */

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REPOSITORY_ID = "22222222-2222-4222-8222-222222222222";
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

function makeFile(overrides: Partial<ProjectEnvFile> = {}): ProjectEnvFile {
  return {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    environmentId: TEST_ENV_ID,
    path: ".env",
    vars: [],
    ...overrides,
  };
}

/** Handler di default per gli ambienti: SOLO `test`, a meno di override. */
function environmentsHandler(environments: ProjectEnvironment[] = [makeEnvironment()]): Handler {
  return () => jsonResponse(200, environments);
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectEnvFilesSection repositoryId={REPOSITORY_ID} projectId={PROJECT_ID} />
    </QueryClientProvider>,
  );
}

const filesBase = `/api/repositories/${REPOSITORY_ID}/env-files`;
const envBase = `/api/projects/${PROJECT_ID}/environments`;

describe("ProjectEnvFilesSection — lista", () => {
  it("mostra i file per path e le variabili con valore mascherato (mai il valore)", async () => {
    mockApi({
      [`GET ${envBase}`]: environmentsHandler(),
      [`GET ${filesBase}`]: () =>
        jsonResponse(200, [
          makeFile({
            id: "file-1",
            path: ".env",
            vars: [
              { key: "DATABASE_URL", valueSet: true },
              { key: "API_TOKEN", valueSet: true },
            ],
          }),
        ]),
    });

    renderSection();

    expect(await screen.findByText(".env")).toBeInTheDocument();
    expect(screen.getByText("DATABASE_URL")).toBeInTheDocument();
    expect(screen.getByText("API_TOKEN")).toBeInTheDocument();
    // Il valore reale non compare mai: solo il segnaposto mascherato.
    expect(screen.queryByText(/postgres:\/\//)).not.toBeInTheDocument();
    const masked = screen.getAllByText(/[•*]{4,}/);
    expect(masked.length).toBeGreaterThanOrEqual(2);
  });

  it("senza file mostra il vuoto", async () => {
    mockApi({
      [`GET ${envBase}`]: environmentsHandler(),
      [`GET ${filesBase}`]: () => jsonResponse(200, []),
    });
    renderSection();
    expect(await screen.findByText(/no environment files/i)).toBeInTheDocument();
  });

  it("fase 8: raggruppa per ambiente — `test` dice che la pipeline legge i valori, `staging` dice il contrario", async () => {
    mockApi({
      [`GET ${envBase}`]: environmentsHandler([
        makeEnvironment(),
        makeEnvironment({ id: STAGING_ENV_ID, name: "staging", kind: "staging" }),
      ]),
      [`GET ${filesBase}`]: () =>
        jsonResponse(200, [
          makeFile({ id: "file-test", path: ".env", environmentId: TEST_ENV_ID }),
          makeFile({ id: "file-staging", path: ".env", environmentId: STAGING_ENV_ID }),
        ]),
    });

    renderSection();

    await screen.findByText("test");
    expect(screen.getByText("staging")).toBeInTheDocument();
    expect(screen.getByText(/pipeline di fix legge queste variabili|fix pipeline reads/i)).toBeInTheDocument();
    expect(
      screen.getByText(/mai usate automaticamente|never used automatically/i),
    ).toBeInTheDocument();

    // Ogni gruppo ha il SUO file ".env", e sono due righe distinte.
    expect(screen.getAllByText(".env")).toHaveLength(2);
  });
});

describe("ProjectEnvFilesSection — aggiungi file", () => {
  it("crea un file nel gruppo TEST inviando POST { path, environmentId } e lo mostra", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    let created = false;
    mockApi({
      [`GET ${envBase}`]: environmentsHandler(),
      [`GET ${filesBase}`]: () =>
        jsonResponse(200, created ? [makeFile({ id: "file-1", path: ".env.local" })] : []),
      [`POST ${filesBase}`]: (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        created = true;
        return jsonResponse(201, makeFile({ id: "file-1", path: ".env.local" }));
      },
    });

    renderSection();

    await user.click(await screen.findByRole("button", { name: /add file/i }));
    await user.type(screen.getByLabelText(/path/i), ".env.local");
    await user.click(screen.getByRole("button", { name: /create file/i }));

    await waitFor(() => expect(postBody).toEqual({ path: ".env.local", environmentId: TEST_ENV_ID }));
    expect(await screen.findByText(".env.local")).toBeInTheDocument();
  });

  it("non invia il POST con path vuoto", async () => {
    const user = userEvent.setup();
    let posted = false;
    mockApi({
      [`GET ${envBase}`]: environmentsHandler(),
      [`GET ${filesBase}`]: () => jsonResponse(200, []),
      [`POST ${filesBase}`]: () => {
        posted = true;
        return jsonResponse(201, makeFile());
      },
    });

    renderSection();

    await user.click(await screen.findByRole("button", { name: /add file/i }));
    // Path lasciato vuoto: il submit non parte.
    await user.click(screen.getByRole("button", { name: /create file/i }));

    await waitFor(() => expect(screen.getByLabelText(/path/i)).toBeInTheDocument());
    expect(posted).toBe(false);
  });
});

describe("ProjectEnvFilesSection — import via incolla", () => {
  it("incolla A=1\\nB=2, conferma e mostra A e B dopo l'invalidate", async () => {
    const user = userEvent.setup();
    let importBody: unknown;
    let imported = false;
    mockApi({
      [`GET ${envBase}`]: environmentsHandler(),
      [`GET ${filesBase}`]: () =>
        jsonResponse(200, [
          makeFile({
            id: "file-1",
            path: ".env",
            vars: imported
              ? [
                  { key: "A", valueSet: true },
                  { key: "B", valueSet: true },
                ]
              : [],
          }),
        ]),
      [`POST ${filesBase}/file-1/import`]: (_url, init) => {
        importBody = JSON.parse(String(init?.body));
        imported = true;
        return jsonResponse(200, { count: 2, imported: ["A", "B"] });
      },
    });

    renderSection();

    const row = (await screen.findByText(".env")).closest("li") as HTMLElement;
    await user.type(within(row).getByLabelText(/paste/i), "A=1\nB=2");
    await user.click(within(row).getByRole("button", { name: /import/i }));

    await waitFor(() => expect(importBody).toEqual({ content: "A=1\nB=2" }));
    expect(await screen.findByText("A")).toBeInTheDocument();
    expect(await screen.findByText("B")).toBeInTheDocument();
  });
});

describe("ProjectEnvFilesSection — import via upload", () => {
  it("legge file.text() e chiama import con il contenuto del file", async () => {
    const user = userEvent.setup();
    let importBody: unknown;
    mockApi({
      [`GET ${envBase}`]: environmentsHandler(),
      [`GET ${filesBase}`]: () => jsonResponse(200, [makeFile({ id: "file-1", path: ".env" })]),
      [`POST ${filesBase}/file-1/import`]: (_url, init) => {
        importBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { count: 2, imported: ["X", "Y"] });
      },
    });

    renderSection();

    const row = (await screen.findByText(".env")).closest("li") as HTMLElement;
    const file = new File(["X=1\nY=2"], ".env.local", { type: "text/plain" });
    const input = within(row).getByTestId("env-file-upload") as HTMLInputElement;
    await user.upload(input, file);

    await waitFor(() => expect(importBody).toEqual({ content: "X=1\nY=2" }));
  });
});

describe("ProjectEnvFilesSection — variabili", () => {
  it("sostituisci valore invia PUT { value }", async () => {
    const user = userEvent.setup();
    let putBody: unknown;
    mockApi({
      [`GET ${envBase}`]: environmentsHandler(),
      [`GET ${filesBase}`]: () =>
        jsonResponse(200, [
          makeFile({ id: "file-1", path: ".env", vars: [{ key: "API_TOKEN", valueSet: true }] }),
        ]),
      [`PUT ${filesBase}/file-1/vars/API_TOKEN`]: (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { key: "API_TOKEN", valueSet: true });
      },
    });

    renderSection();

    const varRow = (await screen.findByText("API_TOKEN")).closest("li") as HTMLElement;
    await user.click(within(varRow).getByRole("button", { name: /replace/i }));
    await user.type(within(varRow).getByLabelText(/value/i), "new-secret");
    await user.click(within(varRow).getByRole("button", { name: /save/i }));

    await waitFor(() => expect(putBody).toEqual({ value: "new-secret" }));
  });

  it("elimina variabile invia DELETE sulla chiave", async () => {
    const user = userEvent.setup();
    let deleted = false;
    mockApi({
      [`GET ${envBase}`]: environmentsHandler(),
      [`GET ${filesBase}`]: () =>
        jsonResponse(200, [
          makeFile({
            id: "file-1",
            path: ".env",
            vars: deleted ? [] : [{ key: "API_TOKEN", valueSet: true }],
          }),
        ]),
      [`DELETE ${filesBase}/file-1/vars/API_TOKEN`]: () => {
        deleted = true;
        return jsonResponse(204, null);
      },
    });

    renderSection();

    const varRow = (await screen.findByText("API_TOKEN")).closest("li") as HTMLElement;
    await user.click(within(varRow).getByRole("button", { name: /remove/i }));

    await waitFor(() => expect(screen.queryByText("API_TOKEN")).not.toBeInTheDocument());
  });
});

describe("ProjectEnvFilesSection — elimina file", () => {
  it("elimina il file con conferma", async () => {
    const user = userEvent.setup();
    let deleted = false;
    mockApi({
      [`GET ${envBase}`]: environmentsHandler(),
      [`GET ${filesBase}`]: () =>
        jsonResponse(200, deleted ? [] : [makeFile({ id: "file-1", path: ".env" })]),
      [`DELETE ${filesBase}/file-1`]: () => {
        deleted = true;
        return jsonResponse(204, null);
      },
    });

    renderSection();

    const row = (await screen.findByText(".env")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /delete file/i }));
    await user.click(within(row).getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(screen.queryByText(".env")).not.toBeInTheDocument());
  });
});
