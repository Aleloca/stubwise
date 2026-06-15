import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * Impostazioni: ora suddivise in sotto-pagine sotto /settings con una
 * sotto-navigazione. /settings/account è per tutti; automazione AI, notifiche e
 * account git sono solo per gli admin. La gestione degli accessi (membri e
 * inviti) vive nella pagina Team.
 */

const DEFAULT_AUTOMATION = {
  rules: [
    { type: "bug", autoFix: true, maxEffort: 3, planApprovalMinEffort: null },
    { type: "task", autoFix: true, maxEffort: 2, planApprovalMinEffort: 4 },
    { type: "feature", autoFix: false, maxEffort: 3, planApprovalMinEffort: null },
    { type: "feedback", autoFix: false, maxEffort: 3, planApprovalMinEffort: null },
  ],
};

const DEFAULT_NOTIFICATIONS = {
  webhookUrl: null,
  format: "slack",
  enabled: true,
  notifyTicketCreated: true,
  notifyPrOpened: true,
  notifyPrClosed: true,
  notifyJobHeld: true,
  notifyPlanReview: true,
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

function adminBase(notifications: Record<string, unknown> = DEFAULT_NOTIFICATIONS) {
  return {
    "GET /api/auth/me": () =>
      jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } }),
    "GET /api/settings/automation": () => jsonResponse(200, DEFAULT_AUTOMATION),
    "GET /api/settings/notifications": () => jsonResponse(200, notifications),
    "GET /api/git-accounts": () => jsonResponse(200, []),
  } satisfies Record<string, Handler>;
}

function memberBase() {
  return {
    "GET /api/auth/me": () =>
      jsonResponse(200, { user: { id: "u2", email: "bea@example.com", role: "member" } }),
  } satisfies Record<string, Handler>;
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("impostazioni: routing e sotto-navigazione", () => {
  it("/settings reindirizza a /settings/account", async () => {
    mockApi(adminBase());
    const router = renderAt("/settings");

    expect(await screen.findByRole("heading", { name: "Account" })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/account"));
  });

  it("admin: la sotto-nav mostra tutte e quattro le voci", async () => {
    mockApi(adminBase());
    renderAt("/settings/account");

    const nav = await screen.findByRole("navigation", { name: /impostazioni/i });
    const scope = within(nav);
    expect(scope.getByRole("link", { name: "Account" })).toBeInTheDocument();
    expect(scope.getByRole("link", { name: "Automazione AI" })).toBeInTheDocument();
    expect(scope.getByRole("link", { name: "Notifiche" })).toBeInTheDocument();
    expect(scope.getByRole("link", { name: "Account Git" })).toBeInTheDocument();
  });

  it("member: la sotto-nav mostra solo Account", async () => {
    mockApi(memberBase());
    renderAt("/settings/account");

    const nav = await screen.findByRole("navigation", { name: /impostazioni/i });
    const scope = within(nav);
    expect(scope.getByRole("link", { name: "Account" })).toBeInTheDocument();
    expect(scope.queryByRole("link", { name: "Automazione AI" })).not.toBeInTheDocument();
    expect(scope.queryByRole("link", { name: "Notifiche" })).not.toBeInTheDocument();
    expect(scope.queryByRole("link", { name: "Account Git" })).not.toBeInTheDocument();
  });
});

describe("impostazioni: /settings/account", () => {
  it("admin: mostra email e ruolo, niente gestione inviti", async () => {
    mockApi(adminBase());
    renderAt("/settings/account");

    expect(await screen.findByRole("heading", { name: "Account" })).toBeInTheDocument();
    // L'email compare nel pannello account (oltre che nella sidebar).
    expect(screen.getAllByText("ada@example.com").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    // La gestione degli inviti è migrata nella pagina Team.
    expect(screen.queryByRole("button", { name: "Crea invito" })).not.toBeInTheDocument();
  });

  it("member: pannello account con ruolo Member", async () => {
    mockApi(memberBase());
    renderAt("/settings/account");

    expect(await screen.findByText("Member")).toBeInTheDocument();
    // L'email compare nel pannello account (oltre che nella sidebar).
    expect(screen.getAllByText("bea@example.com").length).toBeGreaterThanOrEqual(2);
  });
});

describe("impostazioni: /settings/automation (admin)", () => {
  it("rende le 4 regole con toggle e soglia di sforzo", async () => {
    mockApi(adminBase());
    renderAt("/settings/automation");

    const heading = await screen.findByRole("heading", { name: "Automazione AI" });
    const section = heading.closest("section") as HTMLElement;
    const scope = within(section);
    expect(scope.getByLabelText("Auto-fix bug")).toBeChecked();
    expect(scope.getByLabelText("Auto-fix feature")).not.toBeChecked();
    expect((scope.getByLabelText("Soglia effort task") as HTMLSelectElement).value).toBe("2");
    // Soglia approvazione piano: bug = Mai (null → ""), task = 4.
    expect((scope.getByLabelText("Approvazione piano bug") as HTMLSelectElement).value).toBe("");
    expect((scope.getByLabelText("Approvazione piano task") as HTMLSelectElement).value).toBe("4");
  });

  it("salva tutte le regole via PUT e mostra la conferma", async () => {
    let putBody: unknown = null;
    mockApi({
      ...adminBase(),
      "PUT /api/settings/automation": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, {
          rules: DEFAULT_AUTOMATION.rules.map((r) =>
            r.type === "bug" ? { ...r, autoFix: false } : r,
          ),
        });
      },
    });

    renderAt("/settings/automation");

    const toggle = (await screen.findByLabelText("Auto-fix bug")) as HTMLInputElement;
    await userEvent.click(toggle); // bug: true → false
    await userEvent.click(screen.getByRole("button", { name: "Salva" }));

    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as { rules: { type: string; autoFix: boolean }[] };
    expect(body.rules.find((r) => r.type === "bug")?.autoFix).toBe(false);
    expect(await screen.findByText("Salvato")).toBeInTheDocument();
  });

  it("la soglia di approvazione piano (Mai/1-5) entra nel payload PUT", async () => {
    let putBody: unknown = null;
    mockApi({
      ...adminBase(),
      "PUT /api/settings/automation": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, DEFAULT_AUTOMATION);
      },
    });

    renderAt("/settings/automation");

    // bug parte da "Mai" (null) → impostalo a 3.
    const bugSelect = (await screen.findByLabelText("Approvazione piano bug")) as HTMLSelectElement;
    await userEvent.selectOptions(bugSelect, "3");
    // task parte da 4 → riportalo a "Mai" (null).
    const taskSelect = screen.getByLabelText("Approvazione piano task") as HTMLSelectElement;
    await userEvent.selectOptions(taskSelect, "");
    await userEvent.click(screen.getByRole("button", { name: "Salva" }));

    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as {
      rules: { type: string; planApprovalMinEffort: number | null }[];
    };
    expect(body.rules.find((r) => r.type === "bug")?.planApprovalMinEffort).toBe(3);
    expect(body.rules.find((r) => r.type === "task")?.planApprovalMinEffort).toBeNull();
  });

  it("member: non raggiunge la rotta admin, viene rimandato ad account", async () => {
    mockApi(memberBase());
    const router = renderAt("/settings/automation");

    expect(await screen.findByText("Member")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/account"));
    expect(screen.queryByText("Automazione AI")).not.toBeInTheDocument();
  });
});

describe("impostazioni: /settings/git-accounts (admin)", () => {
  it("admin: rende la sezione Account Git", async () => {
    mockApi(adminBase());
    renderAt("/settings/git-accounts");

    expect(await screen.findByRole("heading", { name: "Account Git" })).toBeInTheDocument();
  });

  it("member: non raggiunge la rotta admin, viene rimandato ad account", async () => {
    mockApi(memberBase());
    const router = renderAt("/settings/git-accounts");

    expect(await screen.findByText("Member")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/account"));
    expect(screen.queryByRole("heading", { name: "Account Git" })).not.toBeInTheDocument();
  });
});

describe("impostazioni: /settings/notifications (admin)", () => {
  function notificationsSection(): HTMLElement {
    // "Notifiche" compare anche nella sotto-nav: ci si àncora all'h2 della sezione.
    const heading = screen.getByRole("heading", { name: "Notifiche" });
    return (heading.closest("section") as HTMLElement) ?? document.body;
  }

  it("rende la sezione con master switch, URL, formato e toggle per-evento", async () => {
    mockApi(adminBase());
    renderAt("/settings/notifications");

    const heading = await screen.findByRole("heading", { name: "Notifiche" });
    const scope = within(heading.closest("section") as HTMLElement);
    expect(scope.getByLabelText("Abilitate")).toBeChecked();
    expect(scope.getByLabelText("URL webhook")).toBeInTheDocument();
    expect(scope.getByLabelText("Formato")).toBeInTheDocument();
    expect(scope.getByLabelText("Nuovo ticket SDK")).toBeChecked();
    expect(scope.getByLabelText("PR aperta")).toBeChecked();
    expect(scope.getByLabelText("PR chiusa senza merge (ticket riaperto)")).toBeChecked();
    expect(scope.getByLabelText("In attesa")).toBeChecked();
    expect(scope.getByLabelText("Piano AI in attesa di approvazione")).toBeChecked();
    expect(scope.getByLabelText("Fix fallito")).toBeChecked();
  });

  it("salva via PUT con i valori del form", async () => {
    let putBody: unknown = null;
    mockApi({
      ...adminBase(),
      "PUT /api/settings/notifications": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, {
          ...DEFAULT_NOTIFICATIONS,
          webhookUrl: "https://hooks.example.com/x",
          format: "discord",
        });
      },
    });
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifiche" });
    const scope = within(notificationsSection());
    await userEvent.type(scope.getByLabelText("URL webhook"), "https://hooks.example.com/x");
    await userEvent.selectOptions(scope.getByLabelText("Formato"), "discord");
    // Disattiva i due nuovi toggle per verificarli nel payload.
    await userEvent.click(scope.getByLabelText("PR chiusa senza merge (ticket riaperto)"));
    await userEvent.click(scope.getByLabelText("Piano AI in attesa di approvazione"));
    await userEvent.click(scope.getByRole("button", { name: "Salva" }));

    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as {
      webhookUrl: string;
      format: string;
      notifyPrClosed: boolean;
      notifyPlanReview: boolean;
    };
    expect(body.webhookUrl).toBe("https://hooks.example.com/x");
    expect(body.format).toBe("discord");
    expect(body.notifyPrClosed).toBe(false);
    expect(body.notifyPlanReview).toBe(false);
    expect(await scope.findByText("Salvato")).toBeInTheDocument();
  });

  it("il pulsante di test chiama l'API e mostra l'esito ok", async () => {
    mockApi({
      ...adminBase({ ...DEFAULT_NOTIFICATIONS, webhookUrl: "https://hooks.example.com/x" }),
      "POST /api/settings/notifications/test": () =>
        jsonResponse(200, { ok: true, detail: "Notifica di test inviata correttamente." }),
    });
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifiche" });
    const scope = within(notificationsSection());
    await userEvent.click(scope.getByRole("button", { name: "Invia notifica di test" }));

    expect(await scope.findByText(/inviata correttamente/i)).toBeInTheDocument();
  });

  it("il pulsante di test mostra l'errore quando il webhook fallisce", async () => {
    mockApi({
      ...adminBase({ ...DEFAULT_NOTIFICATIONS, webhookUrl: "https://hooks.example.com/x" }),
      "POST /api/settings/notifications/test": () =>
        jsonResponse(200, { ok: false, detail: "Il webhook ha risposto con stato 500." }),
    });
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifiche" });
    const scope = within(notificationsSection());
    await userEvent.click(scope.getByRole("button", { name: "Invia notifica di test" }));

    expect(await scope.findByText(/stato 500/i)).toBeInTheDocument();
  });

  it("mostra la guida di setup giusta e cambia col formato", async () => {
    mockApi(adminBase());
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifiche" });
    const scope = within(notificationsSection());

    await userEvent.click(scope.getByRole("button", { name: /Come configurare/i }));
    expect(scope.getByText(/api\.slack\.com\/apps/i)).toBeInTheDocument();

    await userEvent.selectOptions(scope.getByLabelText("Formato"), "discord");
    expect(scope.getByText(/Impostazioni del canale/i)).toBeInTheDocument();
    expect(scope.queryByText(/api\.slack\.com\/apps/i)).not.toBeInTheDocument();

    await userEvent.selectOptions(scope.getByLabelText("Formato"), "generic");
    expect(scope.getByText(/Content-Type: application\/json/i)).toBeInTheDocument();
    expect(scope.getByText("event")).toBeInTheDocument();
  });

  it("l'anteprima dal vivo rende il messaggio per ogni formato", async () => {
    mockApi(adminBase());
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifiche" });
    const scope = within(notificationsSection());

    // NOTA: l'anteprima usa la lingua d'istanza; finché il Task 13 non la passa al componente, il default è "en". Quando il Task 13 wira instance content_language alla preview, aggiornare queste asserzioni.
    const slackPreview = scope.getByTestId("notification-preview");
    expect(slackPreview.textContent).toContain("PR opened");
    expect(slackPreview.textContent).toContain("|View PR>");

    await userEvent.selectOptions(scope.getByLabelText("Formato"), "discord");
    expect(scope.getByTestId("notification-preview").textContent).toContain("[View PR](");

    await userEvent.selectOptions(scope.getByLabelText("Formato"), "generic");
    const genericPreview = scope.getByTestId("notification-preview");
    expect(genericPreview.textContent).toContain('"event": "job.pr_opened"');
    expect(genericPreview.textContent).toContain('"prUrl"');

    await userEvent.click(scope.getByRole("button", { name: "Nuovo ticket" }));
    expect(scope.getByTestId("notification-preview").textContent).toContain(
      '"event": "ticket.created"',
    );
  });

  it("member: non raggiunge la rotta admin, viene rimandato ad account", async () => {
    mockApi(memberBase());
    const router = renderAt("/settings/notifications");

    expect(await screen.findByText("Member")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/account"));
    expect(screen.queryByText("Notifiche")).not.toBeInTheDocument();
  });
});
