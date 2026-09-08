import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleWorkspace, MailAdmission, MailAdmissionPatch } from "../lib/api";
import { MailAdmissionSection } from "./mail-admission-section";

/**
 * Sezione «Posta ammessa» di Impostazioni → Google (fase 6c): l'ammissione
 * d'istanza, separata dalle regole di attribuzione per progetto (quelle sono
 * `ProjectEmailRoutesSection`). Lettura per tutti, scrittura solo admin.
 */

const ADMISSION_PATH = "/api/settings/mail-admission";
const WORKSPACES_PATH = "/api/settings/google-workspaces";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
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

function makeAdmission(overrides: Partial<MailAdmission> = {}): MailAdmission {
  return {
    admitWorkspaceDomains: true,
    denyLabels: ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "SPAM"],
    denyAutomated: true,
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<GoogleWorkspace> = {}): GoogleWorkspace {
  return {
    id: "0f2c6d6e-6e4a-4d9b-9d6a-2f5b4c8e1a11",
    name: "Acme",
    domains: ["acme.com"],
    clientId: "123.apps.googleusercontent.com",
    clientSecretSet: true,
    accountCount: 0,
    redirectUri: "https://stubwise.example.com/api/me/google/callback",
    createdAt: "2026-09-07T10:00:00.000Z",
    ...overrides,
  };
}

/** I corpi delle PATCH sull'ammissione, nell'ordine in cui sono partite. */
function patchBodies(): MailAdmissionPatch[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return (
        new URL(raw, "http://test.local").pathname === ADMISSION_PATH && init?.method === "PATCH"
      );
    })
    .map(([, init]) => JSON.parse(String(init?.body)) as MailAdmissionPatch);
}

function renderSection(isAdmin = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MailAdmissionSection isAdmin={isAdmin} />
    </QueryClientProvider>,
  );
}

describe("MailAdmissionSection", () => {
  it("dichiara che di ogni email ammessa si leggono oggetto e corpo, inviati al provider di analisi", async () => {
    mockApi({
      [`GET ${ADMISSION_PATH}`]: () => jsonResponse(200, makeAdmission()),
      [`GET ${WORKSPACES_PATH}`]: () => jsonResponse(200, []),
    });
    renderSection();

    expect(
      await screen.findByText(
        /the subject and body are downloaded and sent to the ai analysis provider configured on this instance/i,
      ),
    ).toBeInTheDocument();
  });

  it("mostra lo stato attuale dell'ammissione", async () => {
    mockApi({
      [`GET ${ADMISSION_PATH}`]: () => jsonResponse(200, makeAdmission()),
      [`GET ${WORKSPACES_PATH}`]: () => jsonResponse(200, []),
    });
    renderSection();

    expect(
      await screen.findByRole("checkbox", { name: /admit mail from registered workspace domains/i }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /discard automated mail/i }),
    ).toBeChecked();
    expect(screen.getByText("CATEGORY_PROMOTIONS")).toBeInTheDocument();
    expect(screen.getByText("CATEGORY_SOCIAL")).toBeInTheDocument();
    expect(screen.getByText("SPAM")).toBeInTheDocument();
  });

  it("un admin ci vede sotto l'elenco dei domini dei Workspace registrati", async () => {
    mockApi({
      [`GET ${ADMISSION_PATH}`]: () => jsonResponse(200, makeAdmission()),
      [`GET ${WORKSPACES_PATH}`]: () =>
        jsonResponse(200, [
          makeWorkspace({ domains: ["acme.com", "sub.acme.com"] }),
          makeWorkspace({ id: "1a2b3c4d-1a2b-4a2b-8a2b-1a2b3c4d5e6f", domains: ["beta.dev"] }),
        ]),
    });
    renderSection();

    expect(await screen.findByText("acme.com")).toBeInTheDocument();
    expect(screen.getByText("sub.acme.com")).toBeInTheDocument();
    expect(screen.getByText("beta.dev")).toBeInTheDocument();
  });

  it("un admin senza Workspace registrati lo dice invece di una lista vuota", async () => {
    mockApi({
      [`GET ${ADMISSION_PATH}`]: () => jsonResponse(200, makeAdmission()),
      [`GET ${WORKSPACES_PATH}`]: () => jsonResponse(200, []),
    });
    renderSection();

    expect(await screen.findByText(/no google workspace registered yet/i)).toBeInTheDocument();
  });

  it("cambiare il toggle dei domini manda la PATCH col solo campo toccato", async () => {
    mockApi({
      [`GET ${ADMISSION_PATH}`]: () => jsonResponse(200, makeAdmission({ admitWorkspaceDomains: true })),
      [`GET ${WORKSPACES_PATH}`]: () => jsonResponse(200, []),
      [`PATCH ${ADMISSION_PATH}`]: (_url, init) =>
        jsonResponse(200, {
          ...makeAdmission(),
          ...(JSON.parse(String(init?.body)) as MailAdmissionPatch),
        }),
    });
    renderSection();

    const toggle = await screen.findByRole("checkbox", {
      name: /admit mail from registered workspace domains/i,
    });
    await userEvent.click(toggle);

    await waitFor(() => expect(patchBodies()).toEqual([{ admitWorkspaceDomains: false }]));
  });

  it("cambiare il toggle della posta automatica manda la PATCH col solo campo toccato", async () => {
    mockApi({
      [`GET ${ADMISSION_PATH}`]: () => jsonResponse(200, makeAdmission({ denyAutomated: true })),
      [`GET ${WORKSPACES_PATH}`]: () => jsonResponse(200, []),
      [`PATCH ${ADMISSION_PATH}`]: (_url, init) =>
        jsonResponse(200, {
          ...makeAdmission(),
          ...(JSON.parse(String(init?.body)) as MailAdmissionPatch),
        }),
    });
    renderSection();

    const toggle = await screen.findByRole("checkbox", { name: /discard automated mail/i });
    await userEvent.click(toggle);

    await waitFor(() => expect(patchBodies()).toEqual([{ denyAutomated: false }]));
  });

  it("aggiungere un'etichetta esclusa manda l'INSIEME COMPLETO", async () => {
    mockApi({
      [`GET ${ADMISSION_PATH}`]: () =>
        jsonResponse(200, makeAdmission({ denyLabels: ["SPAM"] })),
      [`GET ${WORKSPACES_PATH}`]: () => jsonResponse(200, []),
      [`PATCH ${ADMISSION_PATH}`]: (_url, init) =>
        jsonResponse(200, {
          ...makeAdmission(),
          ...(JSON.parse(String(init?.body)) as MailAdmissionPatch),
        }),
    });
    renderSection();

    await screen.findByText("SPAM");
    const input = await screen.findByRole("textbox", { name: /new label/i });
    await userEvent.type(input, "PROMOTIONS{Enter}");

    await waitFor(() =>
      expect(patchBodies()).toEqual([{ denyLabels: ["SPAM", "PROMOTIONS"] }]),
    );
  });

  it("un errore del server torna indietro sul valore di prima", async () => {
    mockApi({
      [`GET ${ADMISSION_PATH}`]: () => jsonResponse(200, makeAdmission({ denyAutomated: true })),
      [`GET ${WORKSPACES_PATH}`]: () => jsonResponse(200, []),
      [`PATCH ${ADMISSION_PATH}`]: () =>
        jsonResponse(403, { code: "forbidden", message: "Admins only" }),
    });
    renderSection();

    const toggle = await screen.findByRole("checkbox", { name: /discard automated mail/i });
    await userEvent.click(toggle);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it("a un member i controlli sono disabilitati e l'elenco dei domini non compare", async () => {
    mockApi({
      [`GET ${ADMISSION_PATH}`]: () => jsonResponse(200, makeAdmission()),
    });
    renderSection(false);

    const domainsToggle = await screen.findByRole("checkbox", {
      name: /admit mail from registered workspace domains/i,
    });
    expect(domainsToggle).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /discard automated mail/i })).toBeDisabled();
    // Per un member `LabelsEditor` riceve `disabled`: niente bottone di
    // rimozione funzionante (resta nel DOM ma disabilitato).
    expect(
      screen.getByText("CATEGORY_PROMOTIONS").closest("li")?.querySelector("button"),
    ).toBeDisabled();
    // Niente elenco domini: la rotta è admin-only e questa sezione non la
    // interroga per un member (nessuna GET /google-workspaces mockata sopra:
    // se il componente la chiamasse, `mockApi` lancerebbe e il test fallirebbe).
    expect(screen.queryByText(/domains that would be admitted/i)).not.toBeInTheDocument();
  });
});
