import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceSettings } from "../lib/api";
import { StorageSection } from "./storage-section";

/**
 * Sezione "Storage (S3)" delle impostazioni (solo admin): form endpoint/region/
 * bucket/accessKey/secret + salvataggio (PUT) e badge allegati on/off. La secret
 * è write-only: mai mostrata in lettura. Rete mockata via `fetch` globale come le
 * altre section.
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

function makeInstance(overrides: Partial<InstanceSettings> = {}): InstanceSettings {
  return {
    contentLanguage: "en",
    monthlyBudgetUsd: null,
    s3Endpoint: null,
    s3Region: null,
    s3Bucket: null,
    s3AccessKey: null,
    s3SecretKeySet: false,
    attachmentsEnabled: false,
    ...overrides,
  };
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <StorageSection />
    </QueryClientProvider>,
  );
}

describe("StorageSection — render", () => {
  it("mostra i campi del form e il badge 'disabled' quando non configurato", async () => {
    mockApi({ "GET /api/settings/instance": () => jsonResponse(200, makeInstance()) });
    renderSection();

    expect(await screen.findByLabelText(/endpoint/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/region/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/bucket/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/access key/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Secret key")).toBeInTheDocument();
    expect(screen.getByText(/attachments disabled/i)).toBeInTheDocument();
  });

  it("mostra il badge 'enabled' e NON espone la secret salvata", async () => {
    mockApi({
      "GET /api/settings/instance": () =>
        jsonResponse(
          200,
          makeInstance({
            s3Endpoint: "https://s3.example.com",
            s3Region: "eu-central",
            s3Bucket: "my-bucket",
            s3AccessKey: "AKIA",
            s3SecretKeySet: true,
            attachmentsEnabled: true,
          }),
        ),
    });
    renderSection();

    expect(await screen.findByText(/attachments enabled/i)).toBeInTheDocument();
    // I campi non-secret sono prepopolati.
    expect((screen.getByLabelText(/endpoint/i) as HTMLInputElement).value).toBe(
      "https://s3.example.com",
    );
    // Il campo secret resta vuoto: la secret salvata non è mai inviata al client.
    const secret = screen.getByLabelText("Secret key") as HTMLInputElement;
    expect(secret.value).toBe("");
    // Nessun nodo del DOM contiene un eventuale valore segreto.
    expect(document.body.textContent).not.toContain("super-secret");
  });
});

describe("StorageSection — salvataggio", () => {
  it("invia il PUT coi campi non-secret + secret quando inserita", async () => {
    const user = userEvent.setup();
    let putBody: Record<string, unknown> | undefined;
    mockApi({
      "GET /api/settings/instance": () => jsonResponse(200, makeInstance()),
      "PUT /api/settings/instance": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(
          200,
          makeInstance({
            s3Endpoint: "https://s3.example.com",
            s3Bucket: "my-bucket",
            s3AccessKey: "AKIA",
            s3SecretKeySet: true,
            attachmentsEnabled: true,
          }),
        );
      },
    });
    renderSection();

    await user.type(await screen.findByLabelText(/endpoint/i), "https://s3.example.com");
    await user.type(screen.getByLabelText(/bucket/i), "my-bucket");
    await user.type(screen.getByLabelText(/access key/i), "AKIA");
    await user.type(screen.getByLabelText("Secret key"), "super-secret");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody?.s3Endpoint).toBe("https://s3.example.com");
    expect(putBody?.s3Bucket).toBe("my-bucket");
    expect(putBody?.s3AccessKey).toBe("AKIA");
    expect(putBody?.s3SecretKey).toBe("super-secret");
  });

  it("secret lasciata vuota → s3SecretKey NON è nel body (non modificare)", async () => {
    const user = userEvent.setup();
    let putBody: Record<string, unknown> | undefined;
    mockApi({
      "GET /api/settings/instance": () =>
        jsonResponse(
          200,
          makeInstance({
            s3Endpoint: "https://s3.example.com",
            s3Bucket: "my-bucket",
            s3AccessKey: "AKIA",
            s3SecretKeySet: true,
            attachmentsEnabled: true,
          }),
        ),
      "PUT /api/settings/instance": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(
          200,
          makeInstance({
            s3Endpoint: "https://s3.example.com",
            s3Bucket: "changed",
            s3AccessKey: "AKIA",
            s3SecretKeySet: true,
            attachmentsEnabled: true,
          }),
        );
      },
    });
    renderSection();

    const bucket = await screen.findByLabelText(/bucket/i);
    await user.clear(bucket);
    await user.type(bucket, "changed");
    // Secret lasciata vuota di proposito.
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect("s3SecretKey" in (putBody ?? {})).toBe(false);
    expect(putBody?.s3Bucket).toBe("changed");
  });
});
