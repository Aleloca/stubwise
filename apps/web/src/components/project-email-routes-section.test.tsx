import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailRoute } from "../lib/api";
import { classifySender, ProjectEmailRoutesSection } from "./project-email-routes-section";

/**
 * Sezione «Posta» della pagina progetto: le regole che decidono quali email
 * parlano di questo progetto.
 *
 * Il salvataggio è immediato e manda l'INSIEME COMPLETO: i test che contano
 * sono quelli che guardano il BODY del PUT, perché è lì che si vedrebbe una
 * regola di un altro gruppo cancellata per sbaglio. La rete è mockata via
 * `fetch` globale (come `project-plugins-section.test`).
 */

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROUTES_PATH = `/api/projects/${PROJECT_ID}/email-routes`;
const LABELS_PATH = `/api/projects/${PROJECT_ID}/email-labels`;

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

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

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

/** I corpi dei PUT sulle regole, nell'ordine in cui sono partiti. */
function putBodies(): { routes: EmailRoute[] }[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new URL(raw, "http://test.local").pathname === ROUTES_PATH && init?.method === "PUT";
    })
    .map(([, init]) => JSON.parse(String(init?.body)) as { routes: EmailRoute[] });
}

function renderSection(isAdmin = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectEmailRoutesSection projectId={PROJECT_ID} isAdmin={isAdmin} />
    </QueryClientProvider>,
  );
}

/** Il campo "nuova etichetta" del gruppo col titolo dato. */
async function addChipIn(groupLabel: RegExp, value: string) {
  const group = await screen.findByRole("region", { name: groupLabel });
  const input = group.querySelector("input") as HTMLInputElement;
  await userEvent.type(input, `${value}{Enter}`);
}

describe("ProjectEmailRoutesSection", () => {
  it("avvisa che le regole attribuiscono, non ammettono (fase 6c)", async () => {
    mockApi({ [`GET ${ROUTES_PATH}`]: () => jsonResponse(200, { routes: [] }) });
    renderSection();

    expect(
      await screen.findByText(/already admitted to the system/i),
    ).toBeInTheDocument();
  });

  it("un progetto senza regole lo dice invece di sembrare configurato", async () => {
    mockApi({ [`GET ${ROUTES_PATH}`]: () => jsonResponse(200, { routes: [] }) });
    renderSection();

    expect(await screen.findByText(/no rules/i)).toBeInTheDocument();
  });

  it("mostra le regole raggruppate per criterio", async () => {
    mockApi({
      [`GET ${ROUTES_PATH}`]: () =>
        jsonResponse(200, {
          routes: [
            { kind: "sender_domain", value: "acme.com" },
            { kind: "sender_address", value: "mario@acme.com" },
            { kind: "gmail_label", value: "clienti" },
            { kind: "keyword", value: "portale" },
          ],
        }),
    });
    renderSection();

    const senders = await screen.findByRole("region", { name: /senders and recipients/i });
    expect(senders).toHaveTextContent("acme.com");
    expect(senders).toHaveTextContent("mario@acme.com");
    const labels = await screen.findByRole("region", { name: /gmail labels/i });
    expect(labels).toHaveTextContent("clienti");
    const keywords = await screen.findByRole("region", { name: /keywords/i });
    expect(keywords).toHaveTextContent("portale");
  });

  it("aggiungere un mittente manda l'INSIEME COMPLETO, non solo la regola nuova", async () => {
    mockApi({
      [`GET ${ROUTES_PATH}`]: () =>
        jsonResponse(200, { routes: [{ kind: "keyword", value: "portale" }] }),
      [`PUT ${ROUTES_PATH}`]: (_url, init) =>
        jsonResponse(200, JSON.parse(String(init?.body)) as unknown),
    });
    renderSection();

    await addChipIn(/senders and recipients/i, "acme.com");

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]!.routes).toEqual(
      expect.arrayContaining([
        { kind: "keyword", value: "portale" },
        { kind: "sender_domain", value: "acme.com" },
      ]),
    );
    expect(putBodies()[0]!.routes).toHaveLength(2);
  });

  it("un valore con la chiocciola diventa un indirizzo, uno senza un dominio", async () => {
    mockApi({
      [`GET ${ROUTES_PATH}`]: () => jsonResponse(200, { routes: [] }),
      [`PUT ${ROUTES_PATH}`]: (_url, init) =>
        jsonResponse(200, JSON.parse(String(init?.body)) as unknown),
    });
    renderSection();

    await addChipIn(/senders and recipients/i, "mario@acme.com");
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]!.routes).toEqual([{ kind: "sender_address", value: "mario@acme.com" }]);
  });

  it("i chip mostrano i valori NORMALIZZATI dal server, non quelli digitati", async () => {
    mockApi({
      [`GET ${ROUTES_PATH}`]: () => jsonResponse(200, { routes: [] }),
      // Il server risponde con la forma canonica: è quella la verità.
      [`PUT ${ROUTES_PATH}`]: () =>
        jsonResponse(200, { routes: [{ kind: "sender_domain", value: "acme.com" }] }),
    });
    renderSection();

    await addChipIn(/senders and recipients/i, "@Acme.COM");

    const senders = await screen.findByRole("region", { name: /senders and recipients/i });
    await waitFor(() => expect(senders).toHaveTextContent("acme.com"));
    expect(senders).not.toHaveTextContent("@Acme.COM");
  });

  it("un errore del server torna indietro sulle regole di prima e lo dice", async () => {
    mockApi({
      [`GET ${ROUTES_PATH}`]: () =>
        jsonResponse(200, { routes: [{ kind: "keyword", value: "portale" }] }),
      [`PUT ${ROUTES_PATH}`]: () =>
        jsonResponse(400, { code: "invalid_route_value", message: "Not a usable routing value" }),
    });
    renderSection();

    await addChipIn(/senders and recipients/i, "@");

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    const keywords = await screen.findByRole("region", { name: /keywords/i });
    expect(keywords).toHaveTextContent("portale");
  });

  it("il picker propone le etichette osservate e le aggiunge come regola", async () => {
    mockApi({
      [`GET ${ROUTES_PATH}`]: () => jsonResponse(200, { routes: [] }),
      [`GET ${LABELS_PATH}`]: () => jsonResponse(200, { labels: ["INBOX", "Label_clienti"] }),
      [`PUT ${ROUTES_PATH}`]: (_url, init) =>
        jsonResponse(200, JSON.parse(String(init?.body)) as unknown),
    });
    renderSection();

    await userEvent.click(await screen.findByRole("button", { name: /pick from observed labels/i }));
    await userEvent.click(await screen.findByText("Label_clienti"));

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]!.routes).toEqual([{ kind: "gmail_label", value: "Label_clienti" }]);
  });

  it("senza etichette osservate lo dice, e il campo a testo libero resta usabile", async () => {
    mockApi({
      [`GET ${ROUTES_PATH}`]: () => jsonResponse(200, { routes: [] }),
      [`GET ${LABELS_PATH}`]: () => jsonResponse(200, { labels: [] }),
      [`PUT ${ROUTES_PATH}`]: (_url, init) =>
        jsonResponse(200, JSON.parse(String(init?.body)) as unknown),
    });
    renderSection();

    await userEvent.click(await screen.findByRole("button", { name: /pick from observed labels/i }));
    expect(await screen.findByText(/no label observed yet/i)).toBeInTheDocument();

    await addChipIn(/gmail labels/i, "clienti");
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]!.routes).toEqual([{ kind: "gmail_label", value: "clienti" }]);
  });

  it("a un member i campi sono disabilitati e il picker non c'è", async () => {
    mockApi({
      [`GET ${ROUTES_PATH}`]: () =>
        jsonResponse(200, { routes: [{ kind: "keyword", value: "portale" }] }),
    });
    renderSection(false);

    const keywords = await screen.findByRole("region", { name: /keywords/i });
    expect(keywords).toHaveTextContent("portale");
    expect(keywords.querySelector("input")).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /pick from observed labels/i }),
    ).not.toBeInTheDocument();
  });

  it("un errore di caricamento degrada solo qui", async () => {
    mockApi({
      [`GET ${ROUTES_PATH}`]: () => jsonResponse(500, { code: "boom", message: "boom" }),
    });
    renderSection();

    expect(await screen.findByText(/could not load the mail routing rules/i)).toBeInTheDocument();
  });
});

describe("classifySender", () => {
  it("distingue un dominio da un indirizzo su come è scritto", () => {
    expect(classifySender("acme.com")).toBe("sender_domain");
    // La grafia mentale del dominio: nessuna parte locale davanti alla @.
    expect(classifySender("@acme.com")).toBe("sender_domain");
    expect(classifySender("mario@acme.com")).toBe("sender_address");
  });
});
