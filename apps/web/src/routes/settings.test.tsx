import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * Pagina impostazioni: dati dell'account corrente e, per gli admin, le regole
 * di automazione AI. La gestione degli accessi (membri e inviti) è nella
 * pagina Team.
 */

const DEFAULT_AUTOMATION = {
  rules: [
    { type: "bug", autoFix: true, maxEffort: 3 },
    { type: "task", autoFix: true, maxEffort: 2 },
    { type: "feature", autoFix: false, maxEffort: 3 },
    { type: "feedback", autoFix: false, maxEffort: 3 },
  ],
};

const DEFAULT_NOTIFICATIONS = {
  webhookUrl: null,
  format: "slack",
  enabled: true,
  notifyTicketCreated: true,
  notifyPrOpened: true,
  notifyJobHeld: true,
  notifyJobFailed: true,
};

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

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: ["/settings"] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("impostazioni", () => {
  it("admin: mostra email e ruolo dell'account, niente gestione inviti", async () => {
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } }),
      "GET /api/settings/automation": () => jsonResponse(200, DEFAULT_AUTOMATION),
      "GET /api/settings/notifications": () => jsonResponse(200, DEFAULT_NOTIFICATIONS),
      // La sezione "Account Git" (solo admin) carica gli account.
      "GET /api/git-accounts": () => jsonResponse(200, []),
    });

    renderSettings();

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    // L'email compare nel pannello account (oltre che nella sidebar).
    expect(screen.getAllByText("ada@example.com").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    // La gestione degli inviti è migrata nella pagina Team.
    expect(screen.queryByRole("button", { name: "Crea invito" })).not.toBeInTheDocument();
    // La sezione "Account Git" è presente per gli admin.
    expect(screen.getByRole("heading", { name: "Account Git" })).toBeInTheDocument();
  });

  it("member: pannello account con ruolo Member, niente sezione Automazione AI", async () => {
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u2", email: "bea@example.com", role: "member" } }),
    });

    renderSettings();

    expect(await screen.findByText("Member")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crea invito" })).not.toBeInTheDocument();
    // La sezione automazione è riservata agli admin.
    expect(screen.queryByText("Automazione AI")).not.toBeInTheDocument();
    // Anche la sezione "Account Git" è riservata agli admin.
    expect(screen.queryByRole("heading", { name: "Account Git" })).not.toBeInTheDocument();
  });
});

describe("automazione AI (admin)", () => {
  it("rende le 4 regole con toggle e soglia di sforzo", async () => {
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } }),
      "GET /api/settings/automation": () => jsonResponse(200, DEFAULT_AUTOMATION),
      "GET /api/settings/notifications": () => jsonResponse(200, DEFAULT_NOTIFICATIONS),
      // La sezione "Account Git" (solo admin) carica gli account.
      "GET /api/git-accounts": () => jsonResponse(200, []),
    });

    renderSettings();

    const heading = await screen.findByText("Automazione AI");
    const section = heading.closest("section") as HTMLElement;
    const scope = within(section);
    // Un toggle e una soglia per ciascuno dei 4 tipi.
    expect(scope.getByLabelText("Auto-fix bug")).toBeChecked();
    expect(scope.getByLabelText("Auto-fix feature")).not.toBeChecked();
    expect((scope.getByLabelText("Soglia effort task") as HTMLSelectElement).value).toBe("2");
  });

  it("salva tutte le regole via PUT e mostra la conferma", async () => {
    let putBody: unknown = null;
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } }),
      "GET /api/settings/automation": () => jsonResponse(200, DEFAULT_AUTOMATION),
      "GET /api/settings/notifications": () => jsonResponse(200, DEFAULT_NOTIFICATIONS),
      "GET /api/git-accounts": () => jsonResponse(200, []),
      "PUT /api/settings/automation": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, {
          rules: DEFAULT_AUTOMATION.rules.map((r) =>
            r.type === "bug" ? { ...r, autoFix: false } : r,
          ),
        });
      },
    });

    renderSettings();

    const toggle = (await screen.findByLabelText("Auto-fix bug")) as HTMLInputElement;
    await userEvent.click(toggle); // bug: true → false
    // Scope al pannello Automazione: la pagina ha più pulsanti "Salva".
    const autoSection = (await screen.findByText("Automazione AI")).closest(
      "section",
    ) as HTMLElement;
    await userEvent.click(within(autoSection).getByRole("button", { name: "Salva" }));

    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as { rules: { type: string; autoFix: boolean }[] };
    expect(body.rules.find((r) => r.type === "bug")?.autoFix).toBe(false);
    // Conferma di salvataggio.
    expect(await within(autoSection).findByText("Salvato")).toBeInTheDocument();
  });
});

describe("notifiche (admin)", () => {
  function mockAdminBase(notifications: Record<string, unknown> = DEFAULT_NOTIFICATIONS) {
    return {
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } }),
      "GET /api/settings/automation": () => jsonResponse(200, DEFAULT_AUTOMATION),
      "GET /api/settings/notifications": () => jsonResponse(200, notifications),
      "GET /api/git-accounts": () => jsonResponse(200, []),
    } satisfies Record<string, Handler>;
  }

  function notificationsSection(): HTMLElement {
    return (screen.getByText("Notifiche").closest("section") as HTMLElement) ?? document.body;
  }

  it("rende la sezione con master switch, URL, formato e toggle per-evento", async () => {
    mockApi(mockAdminBase());
    renderSettings();

    const heading = await screen.findByText("Notifiche");
    const scope = within(heading.closest("section") as HTMLElement);
    expect(scope.getByLabelText("Abilitate")).toBeChecked();
    expect(scope.getByLabelText("URL webhook")).toBeInTheDocument();
    expect(scope.getByLabelText("Formato")).toBeInTheDocument();
    expect(scope.getByLabelText("Nuovo ticket SDK")).toBeChecked();
    expect(scope.getByLabelText("PR aperta")).toBeChecked();
    expect(scope.getByLabelText("In attesa")).toBeChecked();
    expect(scope.getByLabelText("Fix fallito")).toBeChecked();
  });

  it("salva via PUT con i valori del form", async () => {
    let putBody: unknown = null;
    mockApi({
      ...mockAdminBase(),
      "PUT /api/settings/notifications": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, {
          ...DEFAULT_NOTIFICATIONS,
          webhookUrl: "https://hooks.example.com/x",
          format: "discord",
        });
      },
    });
    renderSettings();

    await screen.findByText("Notifiche");
    const scope = within(notificationsSection());
    await userEvent.type(scope.getByLabelText("URL webhook"), "https://hooks.example.com/x");
    await userEvent.selectOptions(scope.getByLabelText("Formato"), "discord");
    await userEvent.click(scope.getByRole("button", { name: "Salva" }));

    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as { webhookUrl: string; format: string };
    expect(body.webhookUrl).toBe("https://hooks.example.com/x");
    expect(body.format).toBe("discord");
    expect(await scope.findByText("Salvato")).toBeInTheDocument();
  });

  it("il pulsante di test chiama l'API e mostra l'esito ok", async () => {
    mockApi({
      ...mockAdminBase({ ...DEFAULT_NOTIFICATIONS, webhookUrl: "https://hooks.example.com/x" }),
      "POST /api/settings/notifications/test": () =>
        jsonResponse(200, { ok: true, detail: "Notifica di test inviata correttamente." }),
    });
    renderSettings();

    await screen.findByText("Notifiche");
    const scope = within(notificationsSection());
    await userEvent.click(scope.getByRole("button", { name: "Invia notifica di test" }));

    expect(await scope.findByText(/inviata correttamente/i)).toBeInTheDocument();
  });

  it("il pulsante di test mostra l'errore quando il webhook fallisce", async () => {
    mockApi({
      ...mockAdminBase({ ...DEFAULT_NOTIFICATIONS, webhookUrl: "https://hooks.example.com/x" }),
      "POST /api/settings/notifications/test": () =>
        jsonResponse(200, { ok: false, detail: "Il webhook ha risposto con stato 500." }),
    });
    renderSettings();

    await screen.findByText("Notifiche");
    const scope = within(notificationsSection());
    await userEvent.click(scope.getByRole("button", { name: "Invia notifica di test" }));

    expect(await scope.findByText(/stato 500/i)).toBeInTheDocument();
  });

  it("member: niente sezione Notifiche", async () => {
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, { user: { id: "u2", email: "bea@example.com", role: "member" } }),
    });
    renderSettings();

    await screen.findByText("Member");
    expect(screen.queryByText("Notifiche")).not.toBeInTheDocument();
  });
});
