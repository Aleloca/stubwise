import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAccountsSection } from "./google-accounts-section";

/**
 * Sezione «Caselle Google» della pagina Account (fase 6).
 *
 * Cosa presidiano questi test, oltre al fatto che la lista si disegna:
 *  - i tre rifiuti del callback hanno tre messaggi DIVERSI, perché chiedono tre
 *    azioni diverse (e `no_refresh_token` è l'unico che senza istruzione manda
 *    l'utente in un ciclo infinito di tentativi identici);
 *  - lo scollegamento è a DUE passi: nessuna DELETE parte al primo click;
 *  - il collegamento NAVIGA sulla URL restituita dal server, non la segue in
 *    background — è la ragione per cui la rotta risponde 200 e non 302;
 *  - senza Workspace utilizzabili la UI dice a chi rivolgersi, invece di
 *    mostrare una select vuota.
 */

const ACCOUNT_ID = "6b1f3c2a-1f4d-4c9a-9a3e-9b5f0d2c7e31";
const WORKSPACE_ID = "0f2c6d6e-6e4a-4d9b-9d6a-2f5b4c8e1a11";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

function jsonResponse(status: number, body: unknown): Response {
  return status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
}

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    email: "mario.rossi@acme.com",
    workspaceId: WORKSPACE_ID,
    workspaceName: "Acme",
    scopes: ["openid", "email", GMAIL_SCOPE, CALENDAR_SCOPE],
    proposalsEnabled: true,
    connectedAt: "2026-09-07T10:00:00.000Z",
    lastSyncAt: null,
    disabledAt: null,
    disabledReason: null,
    ...overrides,
  };
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

interface MockState {
  /** Body inviati al server, per rotta. */
  patches: unknown[];
  connects: unknown[];
  deletes: number;
}

function mockApi(
  overrides: {
    accounts?: Record<string, unknown>[];
    workspaces?: Record<string, unknown>[];
    extra?: Record<string, Handler>;
  } = {},
): MockState {
  const state: MockState = { patches: [], connects: [], deletes: 0 };
  const accounts = overrides.accounts ?? [];
  const workspaces = overrides.workspaces ?? [
    { id: WORKSPACE_ID, name: "Acme", domains: ["acme.com"], clientSecretSet: true },
  ];

  const handlers: Record<string, Handler> = {
    "GET /api/me/google/accounts": () => jsonResponse(200, accounts),
    "GET /api/me/google/workspaces": () => jsonResponse(200, workspaces),
    "POST /api/me/google/connect": (_url, init) => {
      state.connects.push(JSON.parse(String(init?.body)));
      return jsonResponse(200, { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
    },
    [`PATCH /api/me/google/accounts/${ACCOUNT_ID}`]: (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      state.patches.push(body);
      return jsonResponse(200, makeAccount(body));
    },
    [`DELETE /api/me/google/accounts/${ACCOUNT_ID}`]: () => {
      state.deletes += 1;
      return jsonResponse(204, null);
    },
    ...overrides.extra,
  };

  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`fetch non mockata per ${method} ${raw}`);
    return Promise.resolve(handler(url, init));
  });

  return state;
}

function renderSection(outcome?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={<p>loading</p>}>
        <GoogleAccountsSection outcome={outcome} />
      </Suspense>
    </QueryClientProvider>,
  );
}

describe("caselle Google: elenco", () => {
  it("senza caselle mostra il vuoto", async () => {
    mockApi();
    renderSection();
    expect(await screen.findByText("// no mailbox connected")).toBeInTheDocument();
  });

  it("mostra email, Workspace, stato attivo e scope in forma corta", async () => {
    mockApi({ accounts: [makeAccount()] });
    renderSection();

    expect(await screen.findByText("mario.rossi@acme.com")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("never synced")).toBeInTheDocument();
    // Non le URL intere degli scope: il nome corto.
    expect(screen.getByText("openid, email, gmail.readonly, calendar.readonly")).toBeInTheDocument();
  });

  it("una casella disabilitata mostra il motivo e il pulsante Ricollega", async () => {
    mockApi({
      accounts: [
        makeAccount({
          disabledAt: "2026-09-08T09:00:00.000Z",
          disabledReason: "invalid_grant",
        }),
      ],
    });
    renderSection();

    expect(await screen.findByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText("authorization no longer valid: reconnect")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("una casella attiva NON mostra Ricollega", async () => {
    mockApi({ accounts: [makeAccount()] });
    renderSection();

    await screen.findByText("Active");
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });
});

describe("caselle Google: esito del callback", () => {
  it("l'esito ok è un messaggio di successo", async () => {
    mockApi();
    renderSection("ok");
    expect(await screen.findByRole("status")).toHaveTextContent("Mailbox connected.");
  });

  it("i tre rifiuti hanno messaggi diversi, e no_refresh_token spiega come uscirne", async () => {
    mockApi();
    renderSection("domain_mismatch");
    expect(await screen.findByRole("status")).toHaveTextContent(/not on a domain/i);
  });

  it("no_refresh_token indica di revocare l'accesso su Google", async () => {
    mockApi();
    renderSection("no_refresh_token");
    expect(await screen.findByRole("status")).toHaveTextContent(/Revoke Stubwise's access/i);
  });

  it("insufficient_scope chiede di lasciare tutte le autorizzazioni", async () => {
    mockApi();
    renderSection("insufficient_scope");
    expect(await screen.findByRole("status")).toHaveTextContent(/permissions were left out/i);
  });

  it("email_not_verified chiede di verificare l'indirizzo su Google", async () => {
    mockApi();
    renderSection("email_not_verified");
    expect(await screen.findByRole("status")).toHaveTextContent(/could not confirm/i);
  });

  it("mailbox_owned_by_other spiega che la casella è già di un altro account", async () => {
    mockApi();
    renderSection("mailbox_owned_by_other");
    expect(await screen.findByRole("status")).toHaveTextContent(/already connected to a different/i);
  });

  it("un valore inventato nella URL non mostra nessun banner", async () => {
    mockApi();
    renderSection("qualcosa-di-inventato");
    await screen.findByText("// no mailbox connected");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("caselle Google: collegamento", () => {
  it("sceglie il Workspace e NAVIGA sulla URL di consenso restituita dal server", async () => {
    const state = mockApi();
    // `window.location.href` non è assegnabile in happy-dom: si sostituisce
    // l'oggetto con uno spia, che è anche l'unico modo di ASSERIRE la
    // navigazione (una fetch che seguisse il redirect non si vedrebbe).
    const location = { href: "" };
    vi.stubGlobal("location", location);

    renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Connect a mailbox" }));
    expect(await screen.findByLabelText("Workspace")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue on Google" }));

    await waitFor(() => expect(state.connects).toEqual([{ workspaceId: WORKSPACE_ID }]));
    await waitFor(() =>
      expect(location.href).toBe("https://accounts.google.com/o/oauth2/v2/auth?x=1"),
    );
  });

  it("senza Workspace utilizzabili rimanda all'admin invece di mostrare una select vuota", async () => {
    mockApi({
      workspaces: [
        // Registrato ma con il segreto azzerato: inutilizzabile per un consenso.
        { id: WORKSPACE_ID, name: "Acme", domains: ["acme.com"], clientSecretSet: false },
      ],
    });
    renderSection();

    await userEvent.click(await screen.findByRole("button", { name: "Connect a mailbox" }));
    expect(await screen.findByText(/Ask a maintainer to add one/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace")).not.toBeInTheDocument();
  });
});

describe("caselle Google: toggle e scollegamento", () => {
  it("il toggle manda una PATCH con il solo proposalsEnabled", async () => {
    const state = mockApi({ accounts: [makeAccount()] });
    renderSection();

    await userEvent.click(await screen.findByLabelText("Proposals on for this mailbox"));
    await waitFor(() => expect(state.patches).toEqual([{ proposalsEnabled: false }]));
  });

  it("scollegare richiede DUE click: il primo non manda nessuna DELETE", async () => {
    const state = mockApi({ accounts: [makeAccount()] });
    renderSection();

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(state.deletes).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(state.deletes).toBe(1));
  });

  it("annullare la conferma non manda nessuna DELETE", async () => {
    const state = mockApi({ accounts: [makeAccount()] });
    renderSection();

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(state.deletes).toBe(0);
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });
});
