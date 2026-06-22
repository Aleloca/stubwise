import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEnvFile } from "../lib/api";
import { ProjectEnvFilesSection } from "./project-env-files-section";

/**
 * Sezione "File d'ambiente" del dettaglio progetto (solo admin): lista dei file
 * con le sole CHIAVI (valori mai esposti, mascherati), creazione di un file,
 * import via incolla e via upload, sostituzione/eliminazione di una variabile,
 * eliminazione di un file. I valori non transitano MAI in lettura dall'API.
 * La rete è mockata via `fetch` globale (come ai-providers-section.test).
 */

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

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

function makeFile(overrides: Partial<ProjectEnvFile> = {}): ProjectEnvFile {
  return {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    path: ".env",
    vars: [],
    ...overrides,
  };
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectEnvFilesSection projectId={PROJECT_ID} />
    </QueryClientProvider>,
  );
}

const base = `/api/projects/${PROJECT_ID}/env-files`;

describe("ProjectEnvFilesSection — lista", () => {
  it("mostra i file per path e le variabili con valore mascherato (mai il valore)", async () => {
    mockApi({
      [`GET ${base}`]: () =>
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
    mockApi({ [`GET ${base}`]: () => jsonResponse(200, []) });
    renderSection();
    expect(await screen.findByText(/no environment files/i)).toBeInTheDocument();
  });
});

describe("ProjectEnvFilesSection — aggiungi file", () => {
  it("crea un file inviando POST { path } e lo mostra", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    let created = false;
    mockApi({
      [`GET ${base}`]: () =>
        jsonResponse(200, created ? [makeFile({ id: "file-1", path: ".env.local" })] : []),
      [`POST ${base}`]: (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        created = true;
        return jsonResponse(201, makeFile({ id: "file-1", path: ".env.local" }));
      },
    });

    renderSection();

    await user.click(await screen.findByRole("button", { name: /add file/i }));
    await user.type(screen.getByLabelText(/path/i), ".env.local");
    await user.click(screen.getByRole("button", { name: /create file/i }));

    await waitFor(() => expect(postBody).toEqual({ path: ".env.local" }));
    expect(await screen.findByText(".env.local")).toBeInTheDocument();
  });

  it("non invia il POST con path vuoto", async () => {
    const user = userEvent.setup();
    let posted = false;
    mockApi({
      [`GET ${base}`]: () => jsonResponse(200, []),
      [`POST ${base}`]: () => {
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
      [`GET ${base}`]: () =>
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
      [`POST ${base}/file-1/import`]: (_url, init) => {
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
      [`GET ${base}`]: () => jsonResponse(200, [makeFile({ id: "file-1", path: ".env" })]),
      [`POST ${base}/file-1/import`]: (_url, init) => {
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
      [`GET ${base}`]: () =>
        jsonResponse(200, [
          makeFile({ id: "file-1", path: ".env", vars: [{ key: "API_TOKEN", valueSet: true }] }),
        ]),
      [`PUT ${base}/file-1/vars/API_TOKEN`]: (_url, init) => {
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
      [`GET ${base}`]: () =>
        jsonResponse(200, [
          makeFile({
            id: "file-1",
            path: ".env",
            vars: deleted ? [] : [{ key: "API_TOKEN", valueSet: true }],
          }),
        ]),
      [`DELETE ${base}/file-1/vars/API_TOKEN`]: () => {
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
      [`GET ${base}`]: () =>
        jsonResponse(200, deleted ? [] : [makeFile({ id: "file-1", path: ".env" })]),
      [`DELETE ${base}/file-1`]: () => {
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
