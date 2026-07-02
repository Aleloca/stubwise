import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { createAppRouter } from "../router";

/**
 * Impostazioni: ora suddivise in sotto-pagine sotto /settings con una
 * sotto-navigazione. /settings/account è per tutti; automazione AI, notifiche e
 * account git sono solo per gli admin. La gestione degli accessi (membri e
 * inviti) vive nella pagina Team.
 */

const DEFAULT_AUTOMATION = {
  rules: [
    { type: "bug", autoFix: true, maxEffort: 3, planApprovalMinEffort: null, maxCostUsd: null },
    { type: "task", autoFix: true, maxEffort: 2, planApprovalMinEffort: 4, maxCostUsd: 1.5 },
    { type: "feature", autoFix: false, maxEffort: 3, planApprovalMinEffort: null, maxCostUsd: null },
    { type: "feedback", autoFix: false, maxEffort: 3, planApprovalMinEffort: null, maxCostUsd: null },
    { type: "review", autoFix: false, maxEffort: 3, planApprovalMinEffort: null, maxCostUsd: null },
  ],
  prReview: { enabled: false, maxCostUsd: null },
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
  notifyBudgetHeld: true,
  notifyReviewCompleted: true,
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

function adminBase(
  notifications: Record<string, unknown> = DEFAULT_NOTIFICATIONS,
  contentLanguage: "en" | "it" = "en",
  monthlyBudgetUsd: number | null = null,
) {
  return {
    "GET /api/auth/me": () =>
      jsonResponse(200, {
        user: { id: "u1", email: "ada@example.com", role: "admin", language: "en" },
      }),
    "GET /api/settings/automation": () => jsonResponse(200, DEFAULT_AUTOMATION),
    "GET /api/settings/notifications": () => jsonResponse(200, notifications),
    "GET /api/settings/instance": () => jsonResponse(200, { contentLanguage, monthlyBudgetUsd }),
    "GET /api/git-accounts": () => jsonResponse(200, []),
  } satisfies Record<string, Handler>;
}

function memberBase() {
  return {
    "GET /api/auth/me": () =>
      jsonResponse(200, {
        user: { id: "u2", email: "bea@example.com", role: "member", language: "en" },
      }),
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

    const nav = await screen.findByRole("navigation", { name: /settings/i });
    const scope = within(nav);
    expect(scope.getByRole("link", { name: "Account" })).toBeInTheDocument();
    expect(scope.getByRole("link", { name: "AI automation" })).toBeInTheDocument();
    expect(scope.getByRole("link", { name: "Notifications" })).toBeInTheDocument();
    expect(scope.getByRole("link", { name: "Git accounts" })).toBeInTheDocument();

    // Su mobile la sotto-nav è una tab bar orizzontale scrollabile; da `lg`
    // torna alla colonna laterale verticale (desktop invariato).
    expect(nav.className).toContain("overflow-x-auto");
    expect(nav.className).toContain("lg:flex-col");
  });

  it("member: la sotto-nav mostra solo Account", async () => {
    mockApi(memberBase());
    renderAt("/settings/account");

    const nav = await screen.findByRole("navigation", { name: /settings/i });
    const scope = within(nav);
    expect(scope.getByRole("link", { name: "Account" })).toBeInTheDocument();
    expect(scope.queryByRole("link", { name: "AI automation" })).not.toBeInTheDocument();
    expect(scope.queryByRole("link", { name: "Notifications" })).not.toBeInTheDocument();
    expect(scope.queryByRole("link", { name: "Git accounts" })).not.toBeInTheDocument();
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

  it("selettore lingua: cambia → PATCH /me, changeLanguage e cache me aggiornata", async () => {
    // Torna allo stato di default (en) anche se un test precedente ha cambiato lingua.
    await i18n.changeLanguage("en");
    let patchBody: unknown = null;
    mockApi({
      ...adminBase(),
      "PATCH /api/auth/me": (_url, init) => {
        patchBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { language: "it" });
      },
    });

    renderAt("/settings/account");

    const select = (await screen.findByLabelText("Language")) as HTMLSelectElement;
    expect(select.value).toBe("en");
    await userEvent.selectOptions(select, "it");

    // PATCH inviato con la nuova lingua.
    await waitFor(() => expect(patchBody).toEqual({ language: "it" }));
    // UI live: i18n cambia lingua → la label del campo diventa "Lingua".
    await waitFor(() => expect(i18n.language).toBe("it"));
    expect(await screen.findByLabelText("Lingua")).toBeInTheDocument();

    // Ripristina la lingua di default per non sporcare gli altri test.
    await i18n.changeLanguage("en");
  });
});

describe("impostazioni: /settings/automation (admin)", () => {
  it("rende le 4 regole con toggle e soglia di sforzo", async () => {
    mockApi(adminBase());
    renderAt("/settings/automation");

    const heading = await screen.findByRole("heading", { name: "AI automation" });
    const section = heading.closest("section") as HTMLElement;
    const scope = within(section);
    expect(scope.getByLabelText("Auto-fix bug")).toBeChecked();
    expect(scope.getByLabelText("Auto-fix feature")).not.toBeChecked();
    expect((scope.getByLabelText("Effort threshold task") as HTMLSelectElement).value).toBe("2");
    // Soglia approvazione piano: bug = Never (null → ""), task = 4.
    expect((scope.getByLabelText("Plan approval bug") as HTMLSelectElement).value).toBe("");
    expect((scope.getByLabelText("Plan approval task") as HTMLSelectElement).value).toBe("4");
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
          prReview: DEFAULT_AUTOMATION.prReview,
        });
      },
    });

    renderAt("/settings/automation");

    const toggle = (await screen.findByLabelText("Auto-fix bug")) as HTMLInputElement;
    await userEvent.click(toggle); // bug: true → false
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as { rules: { type: string; autoFix: boolean }[] };
    expect(body.rules.find((r) => r.type === "bug")?.autoFix).toBe(false);
    expect(await screen.findByText("Saved")).toBeInTheDocument();
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

    // bug parte da "Never" (null) → impostalo a 3.
    const bugSelect = (await screen.findByLabelText("Plan approval bug")) as HTMLSelectElement;
    await userEvent.selectOptions(bugSelect, "3");
    // task parte da 4 → riportalo a "Never" (null).
    const taskSelect = screen.getByLabelText("Plan approval task") as HTMLSelectElement;
    await userEvent.selectOptions(taskSelect, "");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as {
      rules: { type: string; planApprovalMinEffort: number | null }[];
    };
    expect(body.rules.find((r) => r.type === "bug")?.planApprovalMinEffort).toBe(3);
    expect(body.rules.find((r) => r.type === "task")?.planApprovalMinEffort).toBeNull();
  });

  it("il tetto di costo per ticket (vuoto↔numero) entra nel payload PUT", async () => {
    let putBody: unknown = null;
    mockApi({
      ...adminBase(),
      "PUT /api/settings/automation": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, DEFAULT_AUTOMATION);
      },
    });

    renderAt("/settings/automation");

    // bug parte vuoto (null) → impostalo a 2.5.
    const bugCost = (await screen.findByLabelText("Max cost per ticket bug")) as HTMLInputElement;
    expect(bugCost.value).toBe("");
    await userEvent.type(bugCost, "2.5");
    // task parte da 1.5 → svuotalo (torna a nessun tetto).
    const taskCost = screen.getByLabelText("Max cost per ticket task") as HTMLInputElement;
    expect(taskCost.value).toBe("1.5");
    await userEvent.clear(taskCost);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as { rules: { type: string; maxCostUsd: number | null }[] };
    expect(body.rules.find((r) => r.type === "bug")?.maxCostUsd).toBe(2.5);
    expect(body.rules.find((r) => r.type === "task")?.maxCostUsd).toBeNull();
  });

  it("mostra la sezione PR Review e salva enabled + max cost nel PUT", async () => {
    let putBody: unknown = null;
    mockApi({
      ...adminBase(),
      "PUT /api/settings/automation": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, {
          rules: DEFAULT_AUTOMATION.rules,
          prReview: { enabled: true, maxCostUsd: 2 },
        });
      },
    });

    renderAt("/settings/automation");

    // La sezione parte dai dati del server: disabilitata e senza tetto.
    const toggle = (await screen.findByLabelText("PR review enabled")) as HTMLInputElement;
    expect(toggle).not.toBeChecked();
    const cost = screen.getByLabelText("Max cost per review ($)") as HTMLInputElement;
    expect(cost.value).toBe("");

    await userEvent.click(toggle);
    await userEvent.type(cost, "2");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as {
      rules: unknown[];
      prReview: { enabled: boolean; maxCostUsd: number | null };
    };
    expect(body.prReview).toEqual({ enabled: true, maxCostUsd: 2 });
    // Le regole per-tipo restano invariate nel payload.
    expect(body.rules).toEqual(DEFAULT_AUTOMATION.rules);
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("member: non raggiunge la rotta admin, viene rimandato ad account", async () => {
    mockApi(memberBase());
    const router = renderAt("/settings/automation");

    expect(await screen.findByText("Member")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/account"));
    expect(screen.queryByText("AI automation")).not.toBeInTheDocument();
  });
});

describe("impostazioni: /settings/git-accounts (admin)", () => {
  it("admin: rende la sezione Account Git", async () => {
    mockApi(adminBase());
    renderAt("/settings/git-accounts");

    expect(await screen.findByRole("heading", { name: "Git accounts" })).toBeInTheDocument();
  });

  it("member: non raggiunge la rotta admin, viene rimandato ad account", async () => {
    mockApi(memberBase());
    const router = renderAt("/settings/git-accounts");

    expect(await screen.findByText("Member")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/account"));
    expect(screen.queryByRole("heading", { name: "Git accounts" })).not.toBeInTheDocument();
  });
});

describe("impostazioni: /settings/notifications (admin)", () => {
  function notificationsSection(): HTMLElement {
    // "Notifications" compare anche nella sotto-nav: ci si àncora all'h2 della sezione.
    const heading = screen.getByRole("heading", { name: "Notifications" });
    return (heading.closest("section") as HTMLElement) ?? document.body;
  }

  it("rende la sezione con master switch, URL, formato e toggle per-evento", async () => {
    mockApi(adminBase());
    renderAt("/settings/notifications");

    const heading = await screen.findByRole("heading", { name: "Notifications" });
    const scope = within(heading.closest("section") as HTMLElement);
    expect(scope.getByLabelText("Enabled")).toBeChecked();
    expect(scope.getByLabelText("Webhook URL")).toBeInTheDocument();
    expect(scope.getByLabelText("Format")).toBeInTheDocument();
    expect(scope.getByLabelText("New SDK ticket")).toBeChecked();
    expect(scope.getByLabelText("PR opened")).toBeChecked();
    expect(scope.getByLabelText("PR closed without merge (ticket reopened)")).toBeChecked();
    expect(scope.getByLabelText("On hold")).toBeChecked();
    expect(scope.getByLabelText("AI plan awaiting approval")).toBeChecked();
    expect(scope.getByLabelText("Budget exceeded (job held)")).toBeChecked();
    expect(scope.getByLabelText("PR review completed")).toBeChecked();
    expect(scope.getByLabelText("Fix failed")).toBeChecked();
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

    await screen.findByRole("heading", { name: "Notifications" });
    const scope = within(notificationsSection());
    await userEvent.type(scope.getByLabelText("Webhook URL"), "https://hooks.example.com/x");
    await userEvent.selectOptions(scope.getByLabelText("Format"), "discord");
    // Disattiva alcuni toggle (incluso il budget) per verificarli nel payload.
    await userEvent.click(scope.getByLabelText("PR closed without merge (ticket reopened)"));
    await userEvent.click(scope.getByLabelText("AI plan awaiting approval"));
    await userEvent.click(scope.getByLabelText("Budget exceeded (job held)"));
    await userEvent.click(scope.getByLabelText("PR review completed"));
    await userEvent.click(scope.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as {
      webhookUrl: string;
      format: string;
      notifyPrClosed: boolean;
      notifyPlanReview: boolean;
      notifyBudgetHeld: boolean;
      notifyReviewCompleted: boolean;
    };
    expect(body.webhookUrl).toBe("https://hooks.example.com/x");
    expect(body.format).toBe("discord");
    expect(body.notifyPrClosed).toBe(false);
    expect(body.notifyPlanReview).toBe(false);
    expect(body.notifyBudgetHeld).toBe(false);
    expect(body.notifyReviewCompleted).toBe(false);
    expect(await scope.findByText("Saved")).toBeInTheDocument();
  });

  it("il pulsante di test chiama l'API e mostra l'esito ok", async () => {
    mockApi({
      ...adminBase({ ...DEFAULT_NOTIFICATIONS, webhookUrl: "https://hooks.example.com/x" }),
      "POST /api/settings/notifications/test": () =>
        jsonResponse(200, { ok: true, detail: "Notifica di test inviata correttamente." }),
    });
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifications" });
    const scope = within(notificationsSection());
    await userEvent.click(scope.getByRole("button", { name: "Send test notification" }));

    expect(await scope.findByText(/inviata correttamente/i)).toBeInTheDocument();
  });

  it("il pulsante di test mostra l'errore quando il webhook fallisce", async () => {
    mockApi({
      ...adminBase({ ...DEFAULT_NOTIFICATIONS, webhookUrl: "https://hooks.example.com/x" }),
      "POST /api/settings/notifications/test": () =>
        jsonResponse(200, { ok: false, detail: "Il webhook ha risposto con stato 500." }),
    });
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifications" });
    const scope = within(notificationsSection());
    await userEvent.click(scope.getByRole("button", { name: "Send test notification" }));

    expect(await scope.findByText(/stato 500/i)).toBeInTheDocument();
  });

  it("mostra la guida di setup giusta e cambia col formato", async () => {
    mockApi(adminBase());
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifications" });
    const scope = within(notificationsSection());

    await userEvent.click(scope.getByRole("button", { name: /How to configure/i }));
    expect(scope.getByText(/api\.slack\.com\/apps/i)).toBeInTheDocument();

    await userEvent.selectOptions(scope.getByLabelText("Format"), "discord");
    expect(scope.getByText(/Channel settings/i)).toBeInTheDocument();
    expect(scope.queryByText(/api\.slack\.com\/apps/i)).not.toBeInTheDocument();

    await userEvent.selectOptions(scope.getByLabelText("Format"), "generic");
    expect(scope.getByText(/Content-Type: application\/json/i)).toBeInTheDocument();
    expect(scope.getByText("event")).toBeInTheDocument();
  });

  it("l'anteprima dal vivo rende il messaggio per ogni formato", async () => {
    mockApi(adminBase());
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifications" });
    const scope = within(notificationsSection());

    // L'anteprima usa la lingua dei contenuti d'istanza (mock: "en").
    const slackPreview = scope.getByTestId("notification-preview");
    expect(slackPreview.textContent).toContain("PR opened");
    expect(slackPreview.textContent).toContain("|View PR>");

    await userEvent.selectOptions(scope.getByLabelText("Format"), "discord");
    expect(scope.getByTestId("notification-preview").textContent).toContain("[View PR](");

    await userEvent.selectOptions(scope.getByLabelText("Format"), "generic");
    const genericPreview = scope.getByTestId("notification-preview");
    expect(genericPreview.textContent).toContain('"event": "job.pr_opened"');
    expect(genericPreview.textContent).toContain('"prUrl"');

    await userEvent.click(scope.getByRole("button", { name: "New ticket" }));
    expect(scope.getByTestId("notification-preview").textContent).toContain(
      '"event": "ticket.created"',
    );
  });

  it("l'anteprima usa la lingua dei contenuti d'istanza ('it' → testo italiano)", async () => {
    mockApi(adminBase(DEFAULT_NOTIFICATIONS, "it"));
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifications" });
    const scope = within(notificationsSection());

    // Content language = it: l'anteprima Slack è in italiano ("PR aperta", "Vedi PR").
    const preview = scope.getByTestId("notification-preview");
    expect(preview.textContent).toContain("PR aperta");
    expect(preview.textContent).toContain("|Vedi PR>");
  });

  it("il selettore della lingua dei contenuti salva via PUT /api/settings/instance", async () => {
    let putBody: unknown = null;
    mockApi({
      ...adminBase(),
      "PUT /api/settings/instance": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { contentLanguage: "it", monthlyBudgetUsd: null });
      },
    });
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifications" });
    const scope = within(notificationsSection());
    const select = scope.getByLabelText("Generated content language") as HTMLSelectElement;
    expect(select.value).toBe("en");
    await userEvent.selectOptions(select, "it");

    // Il PUT riscrive sempre entrambi i campi: cambiando lingua si re-invia il
    // budget corrente (null) per non azzerarlo.
    await waitFor(() => expect(putBody).toEqual({ contentLanguage: "it", monthlyBudgetUsd: null }));
    // L'anteprima riflette subito la nuova lingua (cache aggiornata).
    await waitFor(() =>
      expect(scope.getByTestId("notification-preview").textContent).toContain("PR aperta"),
    );
  });

  it("cambiando SOLO la lingua, il budget non-null corrente viene preservato nel PUT", async () => {
    // Non-regressione chiave: l'instance ha già un budget (250); cambiando la
    // lingua dei contenuti il PUT deve re-inviare quel budget, non azzerarlo.
    let putBody: unknown = null;
    mockApi({
      ...adminBase(DEFAULT_NOTIFICATIONS, "en", 250),
      "PUT /api/settings/instance": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { contentLanguage: "it", monthlyBudgetUsd: 250 });
      },
    });
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifications" });
    const scope = within(notificationsSection());
    const select = scope.getByLabelText("Generated content language") as HTMLSelectElement;
    expect(select.value).toBe("en");
    await userEvent.selectOptions(select, "it");

    // Il budget (250) resta intatto: il PUT riscrive entrambi i campi.
    await waitFor(() =>
      expect(putBody).toEqual({ contentLanguage: "it", monthlyBudgetUsd: 250 }),
    );
  });

  it("salvando il budget mentre la lingua è già 'it', il PUT mantiene la lingua corrente", async () => {
    // Speculare: la lingua è già impostata (it); salvando il budget il PUT deve
    // re-inviare la lingua corrente, non azzerarla a default.
    let putBody: unknown = null;
    mockApi({
      ...adminBase(DEFAULT_NOTIFICATIONS, "it", null),
      "PUT /api/settings/instance": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { contentLanguage: "it", monthlyBudgetUsd: 250 });
      },
    });
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifications" });
    const scope = within(notificationsSection());
    const budget = scope.getByLabelText("Monthly budget ($)") as HTMLInputElement;
    expect(budget.value).toBe("");
    await userEvent.type(budget, "250");
    await userEvent.click(scope.getByRole("button", { name: "Save budget" }));

    await waitFor(() =>
      expect(putBody).toEqual({ contentLanguage: "it", monthlyBudgetUsd: 250 }),
    );
  });

  it("il budget mensile salva via PUT con lingua corrente + budget", async () => {
    let putBody: unknown = null;
    mockApi({
      ...adminBase(DEFAULT_NOTIFICATIONS, "en", null),
      "PUT /api/settings/instance": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { contentLanguage: "en", monthlyBudgetUsd: 250 });
      },
    });
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifications" });
    const scope = within(notificationsSection());
    const budget = scope.getByLabelText("Monthly budget ($)") as HTMLInputElement;
    expect(budget.value).toBe("");
    await userEvent.type(budget, "250");
    await userEvent.click(scope.getByRole("button", { name: "Save budget" }));

    await waitFor(() =>
      expect(putBody).toEqual({ contentLanguage: "en", monthlyBudgetUsd: 250 }),
    );
  });

  it("svuotando il budget mensile il PUT invia null", async () => {
    let putBody: unknown = null;
    mockApi({
      ...adminBase(DEFAULT_NOTIFICATIONS, "en", 250),
      "PUT /api/settings/instance": (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { contentLanguage: "en", monthlyBudgetUsd: null });
      },
    });
    renderAt("/settings/notifications");

    await screen.findByRole("heading", { name: "Notifications" });
    const scope = within(notificationsSection());
    const budget = scope.getByLabelText("Monthly budget ($)") as HTMLInputElement;
    expect(budget.value).toBe("250");
    await userEvent.clear(budget);
    await userEvent.click(scope.getByRole("button", { name: "Save budget" }));

    await waitFor(() =>
      expect(putBody).toEqual({ contentLanguage: "en", monthlyBudgetUsd: null }),
    );
  });

  it("member: non raggiunge la rotta admin, viene rimandato ad account", async () => {
    mockApi(memberBase());
    const router = renderAt("/settings/notifications");

    expect(await screen.findByText("Member")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/account"));
    expect(screen.queryByText("Notifications")).not.toBeInTheDocument();
  });
});

describe("impostazioni: /settings/usage (admin)", () => {
  const USAGE_COSTS = {
    range: { from: "2026-05-10T00:00:00.000Z", to: "2026-06-09T23:59:59.999Z" },
    totals: {
      costUsd: 4.05,
      inputTokens: 3800,
      outputTokens: 950,
      cacheReadTokens: 185,
      jobs: 3,
    },
    byDay: [
      { day: "2026-05-10", costUsd: 1.5, inputTokens: 1300, outputTokens: 300, cacheReadTokens: 60, jobs: 1 },
      { day: "2026-05-11", costUsd: 2.55, inputTokens: 2500, outputTokens: 650, cacheReadTokens: 125, jobs: 2 },
    ],
    byModel: [
      { model: "claude-haiku", costUsd: 0.3, inputTokens: 800, outputTokens: 250, cacheReadTokens: 35 },
      { model: "claude-opus", costUsd: 3.75, inputTokens: 3000, outputTokens: 700, cacheReadTokens: 150 },
    ],
    byProject: [
      { projectId: "p-a", projectName: "Project A", costUsd: 3.75, inputTokens: 3000, outputTokens: 700, cacheReadTokens: 150 },
      { projectId: "p-b", projectName: "Project B", costUsd: 0.3, inputTokens: 500, outputTokens: 150, cacheReadTokens: 25 },
    ],
    byProvider: [
      { providerId: "x", providerLabel: "Provider X", costUsd: 1.5, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50 },
      { providerId: null, providerLabel: null, costUsd: 0.3, inputTokens: 500, outputTokens: 150, cacheReadTokens: 25 },
    ],
  };

  function adminWithUsage() {
    return {
      ...adminBase(),
      "GET /api/ai-usage/costs": () => jsonResponse(200, USAGE_COSTS),
    } satisfies Record<string, Handler>;
  }

  it("rende i totali e le tabelle per modello/progetto/provider", async () => {
    mockApi(adminWithUsage());
    renderAt("/settings/usage");

    const heading = await screen.findByRole("heading", { name: "Usage & costs" });
    const section = heading.closest("section") as HTMLElement;
    const scope = within(section);

    // Totali del periodo.
    const totals = scope.getByTestId("usage-totals");
    expect(within(totals).getByText("$4.0500")).toBeInTheDocument();

    // Ripartizioni: modello, progetto, provider (incluso "Default / env").
    expect(within(scope.getByTestId("usage-by-model")).getByText("claude-opus")).toBeInTheDocument();
    expect(within(scope.getByTestId("usage-by-project")).getByText("Project A")).toBeInTheDocument();
    const byProvider = within(scope.getByTestId("usage-by-provider"));
    expect(byProvider.getByText("Provider X")).toBeInTheDocument();
    expect(byProvider.getByText("Default / env")).toBeInTheDocument();

    // Serie per giorno.
    expect(within(scope.getByTestId("usage-by-day")).getByText("2026-05-10")).toBeInTheDocument();
  });

  it("il filtro di range cambia il parametro 'from' della query", async () => {
    const calls: string[] = [];
    mockApi({
      ...adminBase(),
      "GET /api/ai-usage/costs": (url) => {
        calls.push(url.searchParams.get("from") ?? "");
        return jsonResponse(200, USAGE_COSTS);
      },
    });
    renderAt("/settings/usage");

    await screen.findByRole("heading", { name: "Usage & costs" });
    // La prima chiamata usa il default 30 giorni.
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1));
    const firstFrom = calls[0];

    // Cambiando a 7 giorni il 'from' si avvicina a oggi (stringa maggiore).
    await userEvent.selectOptions(screen.getByLabelText("Period"), "7");
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    const lastFrom = calls[calls.length - 1] ?? "";
    expect(lastFrom > (firstFrom ?? "")).toBe(true);
  });

  it("nessun consumo: mostra lo stato vuoto", async () => {
    mockApi({
      ...adminBase(),
      "GET /api/ai-usage/costs": () =>
        jsonResponse(200, {
          range: USAGE_COSTS.range,
          totals: { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, jobs: 0 },
          byDay: [],
          byModel: [],
          byProject: [],
          byProvider: [],
        }),
    });
    renderAt("/settings/usage");

    expect(await screen.findByText("No AI consumption in this period.")).toBeInTheDocument();
  });

  it("member: non raggiunge la rotta admin, viene rimandato ad account", async () => {
    mockApi(memberBase());
    const router = renderAt("/settings/usage");

    expect(await screen.findByText("Member")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/account"));
    expect(screen.queryByRole("heading", { name: "Usage & costs" })).not.toBeInTheDocument();
  });
});
