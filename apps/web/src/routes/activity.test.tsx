import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityReportQueryOptions } from "../lib/queries";
import { createAppRouter } from "../router";

/**
 * Sezione Attività: standup giornaliero con selettore data e due viste
 * (per progetto / per sviluppatore). Router reale + memory history, API mockata
 * via fetch. Le asserzioni sono sulle stringhe inglesi (i18n init in en).
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

function renderActivity() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: ["/activity"] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

// Email di sessione distinte dai dati del report: l'AppLayout mostra l'email
// dell'utente loggato nella sidebar e collidere con il report romperebbe le
// query per testo.
const ADMIN = { id: "u1", email: "me-admin@corp.example", role: "admin" as const, language: "en" };
const MEMBER = { id: "u2", email: "me-member@corp.example", role: "member" as const, language: "en" };

// Membri del team per il picker "Link team member" (endpoint /api/users).
const MEMBERS = [
  {
    id: "u1",
    email: "ada@example.com",
    role: "admin",
    avatarUrl: null,
    slackUserId: null,
    createdAt: "2026-01-01T10:00:00.000Z",
    bitbucketUsername: null,
    gitIdentities: [],
  },
  {
    id: "u9",
    email: "newdev@corp.example",
    role: "member",
    avatarUrl: null,
    slackUserId: null,
    createdAt: "2026-01-01T10:00:00.000Z",
    bitbucketUsername: null,
    gitIdentities: [],
  },
];

const REPOS = [
  {
    id: "r1",
    projectId: "p1",
    name: "web",
    slug: "web",
    provider: "github",
    repoUrl: "https://x/web",
    defaultBranch: "main",
    gitAccountId: "ga1",
    gitAccountName: "acct",
    webhookConfiguredAt: null,
    testCommand: null,
    installCommand: null,
    createdAt: "2026-01-01T10:00:00.000Z",
  },
];

// Report PER-COMMIT con un progetto: un commit di un membro risolto (con
// descrizione AI markdown) e uno di un'email git non risolta (senza descrizione).
const REPORT = {
  date: "2026-07-14",
  developersSummaryPending: false,
  staleCommitTotal: 0,
  projects: [
    {
      project: { id: "p1", name: "Apollo", slug: "apollo" },
      status: "done",
      summary: "Delivered auth improvements across the board.",
      staleCommitCount: 0,
      header: { commitCount: 2, additions: 43, deletions: 6, authorCount: 2 },
      commits: [
        {
          sha: "abcdef1234567890",
          authorEmail: "ada@git.example",
          authorName: "Ada Dev",
          resolvedUser: { id: "u1", email: "ada@example.com", avatarUrl: null },
          committedAt: "2026-07-14T09:00:00.000Z",
          subject: "Add login form",
          additions: 40,
          deletions: 5,
          aiDescription: "Implemented the `login` handler and wired the form.",
        },
        {
          sha: "9988776655443322",
          authorEmail: "ghost@git.example",
          authorName: null,
          resolvedUser: null,
          committedAt: "2026-07-14T10:00:00.000Z",
          subject: "Tweak copy",
          additions: 3,
          deletions: 1,
          aiDescription: null,
        },
      ],
    },
  ],
  developers: [
    {
      resolvedUser: { id: "u1", email: "ada@example.com", avatarUrl: null },
      gitEmail: "ada@git.example",
      authorName: "Ada Dev",
      summary: "Ada focused on authentication.",
      header: { commitCount: 1, additions: 40, deletions: 5, projectCount: 1 },
      byProject: [
        {
          project: { id: "p1", name: "Apollo", slug: "apollo" },
          commits: [
            {
              sha: "abcdef1234567890",
              committedAt: "2026-07-14T09:00:00.000Z",
              subject: "Add login form",
              additions: 40,
              deletions: 5,
              aiDescription: "Auth work in the `web` app.",
            },
          ],
        },
      ],
    },
    {
      resolvedUser: null,
      gitEmail: "ghost@git.example",
      authorName: null,
      summary: null,
      header: { commitCount: 1, additions: 3, deletions: 1, projectCount: 1 },
      byProject: [
        {
          project: { id: "p1", name: "Apollo", slug: "apollo" },
          commits: [
            {
              sha: "9988776655443322",
              committedAt: "2026-07-14T10:00:00.000Z",
              subject: "Tweak copy",
              additions: 3,
              deletions: 1,
              aiDescription: null,
            },
          ],
        },
      ],
    },
  ],
};

const EMPTY_REPORT = {
  date: "2026-01-01",
  projects: [],
  developers: [],
  developersSummaryPending: false,
  staleCommitTotal: 0,
};

// Report appena accodato: un progetto in stato "queued" senza commit (il worker
// non l'ha ancora finalizzato) e nessun riassunto ancora prodotto.
const QUEUED_REPORT = {
  date: "2026-07-14",
  developersSummaryPending: false,
  staleCommitTotal: 0,
  projects: [
    {
      project: { id: "p1", name: "Apollo", slug: "apollo" },
      status: "queued",
      summary: null,
      staleCommitCount: 0,
      header: { commitCount: 0, additions: 0, deletions: 0, authorCount: 0 },
      commits: [],
    },
  ],
  developers: [],
};

// Report con commit mancanti: sono arrivati nuovi commit dopo l'ultima
// generazione (staleCommitTotal > 0, il progetto ne ha staleCommitCount > 0).
const STALE_REPORT = {
  ...REPORT,
  staleCommitTotal: 4,
  projects: [{ ...REPORT.projects[0], staleCommitCount: 3 }],
};

describe("sezione attività", () => {
  it("admin: vista per progetto (default) con membro risolto ed email grezza", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, REPORT),
    });

    renderActivity();

    // Header e blocco progetto.
    expect(await screen.findByRole("heading", { name: "Activity" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Apollo" })).toBeInTheDocument();

    // Il riassunto narrativo del giorno è mostrato in cima alla card.
    expect(
      screen.getByText("Delivered auth improvements across the board."),
    ).toBeInTheDocument();

    // Intestazione coi numeri dell'header per-commit.
    expect(screen.getByText("2 commits")).toBeInTheDocument();
    expect(screen.getByText("2 authors")).toBeInTheDocument();

    // Autore risolto: email del membro. Autore non risolto: authorName grezzo…
    // qui il secondo commit ha authorName null → segnaposto "Unknown author".
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    const ghost = screen.getByText("Unknown author");
    expect(ghost).toBeInTheDocument();
    // L'autore non risolto è in corsivo (degradazione).
    expect(ghost.className).toContain("italic");

    // I commit del giorno: SHA breve (7 char) e oggetto.
    expect(screen.getByText("abcdef1")).toBeInTheDocument();
    expect(screen.getByText("Add login form")).toBeInTheDocument();
    expect(screen.getByText("Tweak copy")).toBeInTheDocument();

    // La descrizione AI è COLLASSATA di default: non visibile finché non si
    // espande la riga del commit.
    expect(screen.queryByText("login")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Show description for Add login form" }),
    );

    // Espansa: la descrizione è resa come MARKDOWN e sanitizzata (il backtick
    // `login` diventa un elemento <code>, non testo grezzo con i backtick).
    const code = screen.getByText("login");
    expect(code.tagName).toBe("CODE");

    // Pulsante "Link team member" (solo admin) accanto all'autore non risolto.
    expect(screen.getByRole("button", { name: "Link team member" })).toBeInTheDocument();
  });

  it("member: niente pulsante 'Link team member' sull'autore non risolto", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: MEMBER }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, REPORT),
    });

    renderActivity();

    expect(await screen.findByText("Unknown author")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link team member" })).not.toBeInTheDocument();
  });

  it("admin: 'Link team member' apre il picker e associa l'email git al membro scelto", async () => {
    const user = userEvent.setup();
    let linkBody: unknown = null;
    let linkedUserId: string | null = null;
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, REPORT),
      "GET /api/users": () => jsonResponse(200, MEMBERS),
      "POST /api/users/u9/git-identities": (_url, init) => {
        linkedUserId = "u9";
        linkBody = JSON.parse(String(init?.body));
        return jsonResponse(200, []);
      },
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    // Apre il picker accanto all'autore non risolto (email git ghost@git.example).
    await user.click(screen.getByRole("button", { name: "Link team member" }));

    // Il combobox carica i membri (query abilitata all'apertura) e li filtra.
    const combo = await screen.findByRole("combobox", { name: "Pick a team member" });
    await user.type(combo, "newdev");
    const listbox = screen.getByRole("listbox");
    await user.click(within(listbox).getByRole("option", { name: /newdev@corp\.example/ }));

    // Il POST associa l'email git dell'autore (non l'email del membro) al membro scelto.
    await waitFor(() => expect(linkBody).toEqual({ email: "ghost@git.example" }));
    expect(linkedUserId).toBe("u9");
  });

  it("collapse: il toggle di un blocco nasconde e riespone il contenuto", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, REPORT),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    // Espanso di default: il contenuto (un commit) è visibile.
    expect(screen.getByText("Add login form")).toBeInTheDocument();

    // Il toggle è il nome del progetto stesso (cliccabile), non solo il chevron.
    const toggle = screen.getByRole("button", { name: "Apollo" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle);

    // Collassato: il contenuto sparisce, l'header coi numeri resta visibile.
    expect(screen.queryByText("Add login form")).not.toBeInTheDocument();
    expect(screen.getByText("2 commits")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Apollo" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await user.click(screen.getByRole("button", { name: "Apollo" }));

    // Ri-espanso: il contenuto riappare.
    expect(screen.getByText("Add login form")).toBeInTheDocument();
  });

  it("switch alla vista per sviluppatore: mostra i blocchi per-dev coi totali", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, REPORT),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    await user.click(screen.getByRole("tab", { name: "By developer" }));

    // Il blocco dev mostra l'autore risolto e i totali per-commit.
    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    // Il riassunto narrativo del dev è in cima alla card.
    expect(screen.getByText("Ada focused on authentication.")).toBeInTheDocument();
    // Totali dell'header dev: 1 commit su 1 progetto.
    expect(screen.getAllByText("1 commit").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 project").length).toBeGreaterThan(0);
    // Il sotto-blocco per progetto compare col nome del progetto e i suoi commit.
    expect(screen.getAllByText("Apollo").length).toBeGreaterThan(0);
    expect(screen.getByText("Add login form")).toBeInTheDocument();
    // La descrizione del commit è collassata: si espande la riga (un solo commit
    // espandibile) e il backtick `web` diventa <code>.
    expect(screen.queryByText("web")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Show description for Add login form" }),
    );
    const code = screen.getByText("web");
    expect(code.tagName).toBe("CODE");
  });

  it("cambio data nell'input → nuova query con la data scelta", async () => {
    const seen: string[] = [];
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": (url) => {
        seen.push(url.searchParams.get("date") ?? "");
        return jsonResponse(200, REPORT);
      },
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    // Date input: fireEvent.change è affidabile in happy-dom (il typing su
    // type=date è fragile).
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-07-01" } });

    await waitFor(() => expect(seen).toContain("2026-07-01"));
  });

  it("prev/next → fetch con la data spostata di ±1 giorno in UTC", async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": (url) => {
        seen.push(url.searchParams.get("date") ?? "");
        return jsonResponse(200, REPORT);
      },
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });

    // Fissa una data nota (l'input evita la dipendenza dal default "ieri"),
    // poi verifica lo shift esatto di -1 giorno cliccando "giorno precedente".
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-05-15" } });
    await waitFor(() => expect(seen).toContain("2026-05-15"));
    await user.click(screen.getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(seen).toContain("2026-05-14"));

    // Da un'altra data nota, "giorno successivo" spinge di +1 giorno in UTC.
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-05-20" } });
    await waitFor(() => expect(seen).toContain("2026-05-20"));
    await user.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => expect(seen).toContain("2026-05-21"));
  });

  it("errore della query attività → messaggio nel corpo, controlli montati, retry recupera", async () => {
    const user = userEvent.setup();
    let fail = true;
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () =>
        fail ? jsonResponse(500, { code: "boom", message: "down" }) : jsonResponse(200, REPORT),
    });

    renderActivity();

    // Il messaggio d'errore i18n compare NEL CORPO (l'error boundary locale non
    // smonta la pagina).
    expect(
      await screen.findByText("Could not load the report for this date."),
    ).toBeInTheDocument();
    // Selettore data e tab restano montati: l'utente può cambiare data / riprovare.
    expect(screen.getByLabelText("Date")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "By project" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "By developer" })).toBeInTheDocument();

    // "Riprova" con la data corrente: la seconda risposta è 200 → il corpo si riprende.
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Apollo" })).toBeInTheDocument();
    expect(
      screen.queryByText("Could not load the report for this date."),
    ).not.toBeInTheDocument();
  });

  it("giorno senza report → messaggio 'No report for this date'", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, EMPTY_REPORT),
    });

    renderActivity();

    expect(await screen.findByText("No report for this date")).toBeInTheDocument();
  });

  it("giorno vuoto + admin: pulsante genera → POST /generate, poi stato 'Generating…'", async () => {
    const user = userEvent.setup();
    let generateBody: unknown = null;
    let queued = false;
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, queued ? QUEUED_REPORT : EMPTY_REPORT),
      "POST /api/activity/generate": (_url, init) => {
        generateBody = JSON.parse(String(init?.body));
        queued = true;
        return jsonResponse(200, { queued: 2 });
      },
    });

    renderActivity();

    const button = await screen.findByRole("button", {
      name: "Generate report for this day",
    });
    await user.click(button);

    // Il body del POST contiene la data selezionata (default: ieri UTC).
    await waitFor(() => expect(generateBody).not.toBeNull());
    expect(generateBody).toHaveProperty("date");

    // Dopo l'invalidazione la vista mostra il report accodato "in generazione".
    expect(await screen.findByText("Generating…")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Apollo" })).toBeInTheDocument();
  });

  it("giorno vuoto + member: nessun pulsante genera (solo 'No report')", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: MEMBER }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, EMPTY_REPORT),
    });

    renderActivity();

    expect(await screen.findByText("No report for this date")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Generate report for this day" }),
    ).not.toBeInTheDocument();
  });

  it("giorno vuoto + admin: generate con queued=0 → hint 'nessun progetto abilitato'", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, EMPTY_REPORT),
      "POST /api/activity/generate": () => jsonResponse(200, { queued: 0 }),
    });

    renderActivity();

    await user.click(
      await screen.findByRole("button", { name: "Generate report for this day" }),
    );

    expect(
      await screen.findByText("No project has the activity report enabled"),
    ).toBeInTheDocument();
    // Nessun report: resta l'empty state.
    expect(screen.getByText("No report for this date")).toBeInTheDocument();
  });

  it("report in stato queued/running → mostra 'Generating…'", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, QUEUED_REPORT),
    });

    renderActivity();

    expect(await screen.findByRole("heading", { name: "Apollo" })).toBeInTheDocument();
    expect(screen.getByText("Generating…")).toBeInTheDocument();
    // Non c'è il pulsante genera quando esiste già un report accodato.
    expect(
      screen.queryByRole("button", { name: "Generate report for this day" }),
    ).not.toBeInTheDocument();
  });

  it("report queued + vista per sviluppatore: niente pulsante genera, mostra 'Generating…'", async () => {
    // Regressione Issue 1: con `developers: []` ma `projects` popolato (report
    // accodato), la vista-dev NON deve riproporre l'empty state + il pulsante.
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, QUEUED_REPORT),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    await user.click(screen.getByRole("tab", { name: "By developer" }));

    // Il ramo dev mostra il placeholder "in generazione", non l'empty state.
    expect(await screen.findByText("Generating…")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Generate report for this day" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("No report for this date")).not.toBeInTheDocument();
  });

  it("giorno vuoto + admin: generate fallisce (500) → errore con role=alert", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, EMPTY_REPORT),
      "POST /api/activity/generate": () =>
        jsonResponse(500, { code: "boom", message: "Generation failed" }),
    });

    renderActivity();

    await user.click(
      await screen.findByRole("button", { name: "Generate report for this day" }),
    );

    // translateApiError ripiega sul message del server (nessuna chiave errors:boom).
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Generation failed");
  });

  it("descrizione AI multi-elemento: la lista markdown rende più <li>", async () => {
    // Il caso "commit grosso → descrizione strutturata": una lista markdown deve
    // produrre elementi <li> distinti, non testo grezzo con i trattini.
    const user = userEvent.setup();
    const listReport = {
      date: "2026-07-14",
      developersSummaryPending: false,
      projects: [
        {
          project: { id: "p1", name: "Apollo", slug: "apollo" },
          status: "done",
          summary: null,
          header: { commitCount: 1, additions: 10, deletions: 2, authorCount: 1 },
          commits: [
            {
              sha: "aabbccddeeff0011",
              authorName: "Ada Dev",
              resolvedUser: { id: "u1", email: "ada@example.com", avatarUrl: null },
              committedAt: "2026-07-14T09:00:00.000Z",
              subject: "Big refactor",
              additions: 10,
              deletions: 2,
              aiDescription: "- first change\n- second change",
            },
          ],
        },
      ],
      developers: [],
    };
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, listReport),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    // Espande la riga del commit (collassata di default) per rivelare la lista.
    await user.click(screen.getByRole("button", { name: "Show description for Big refactor" }));
    const first = screen.getByText("first change");
    const second = screen.getByText("second change");
    expect(first.tagName).toBe("LI");
    expect(second.tagName).toBe("LI");
  });

  it("vista per sviluppatore con >1 progetto: rende entrambi i sotto-gruppi", async () => {
    const user = userEvent.setup();
    const multiReport = {
      date: "2026-07-14",
      // `projects` con attività: la vista-progetto mostra "Apollo" (i progetti
      // `done` con zero commit verrebbero invece filtrati via).
      projects: [
        {
          project: { id: "p1", name: "Apollo", slug: "apollo" },
          status: "done",
          header: { commitCount: 1, additions: 10, deletions: 2, authorCount: 1 },
          commits: [
            {
              sha: "1111111aaaabbbb",
              authorName: "Ada Dev",
              authorEmail: "ada@git.example",
              resolvedUser: { id: "u1", email: "ada@example.com", avatarUrl: null },
              committedAt: "2026-07-14T09:00:00.000Z",
              subject: "Apollo work",
              additions: 10,
              deletions: 2,
              aiDescription: null,
            },
          ],
        },
      ],
      developers: [
        {
          resolvedUser: { id: "u1", email: "ada@example.com", avatarUrl: null },
          gitEmail: "ada@git.example",
          authorName: "Ada Dev",
          header: { commitCount: 2, additions: 15, deletions: 3, projectCount: 2 },
          byProject: [
            {
              project: { id: "p1", name: "Apollo", slug: "apollo" },
              commits: [
                {
                  sha: "1111111aaaabbbb",
                  committedAt: "2026-07-14T09:00:00.000Z",
                  subject: "Apollo work",
                  additions: 10,
                  deletions: 2,
                  aiDescription: null,
                },
              ],
            },
            {
              project: { id: "p2", name: "Zephyr", slug: "zephyr" },
              commits: [
                {
                  sha: "2222222ccccdddd",
                  committedAt: "2026-07-14T11:00:00.000Z",
                  subject: "Zephyr work",
                  additions: 5,
                  deletions: 1,
                  aiDescription: null,
                },
              ],
            },
          ],
        },
      ],
    };
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, multiReport),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    await user.click(screen.getByRole("tab", { name: "By developer" }));

    // Il developer è un heading di livello 2 (outline a11y).
    expect(
      await screen.findByRole("heading", { level: 2, name: /ada@example\.com/ }),
    ).toBeInTheDocument();
    // Entrambi i sotto-gruppi progetto sono heading di livello 3…
    expect(screen.getByRole("heading", { level: 3, name: "Apollo" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Zephyr" })).toBeInTheDocument();
    // …e i commit di ciascun progetto sono resi.
    expect(screen.getByText("Apollo work")).toBeInTheDocument();
    expect(screen.getByText("Zephyr work")).toBeInTheDocument();
  });

  it("vista progetto: autore non risolto con authorName non-null mostra il nome", async () => {
    const namedReport = {
      date: "2026-07-14",
      projects: [
        {
          project: { id: "p1", name: "Apollo", slug: "apollo" },
          status: "done",
          header: { commitCount: 1, additions: 4, deletions: 1, authorCount: 1 },
          commits: [
            {
              sha: "ffeeddccbbaa9988",
              authorName: "Mario Rossi",
              resolvedUser: null,
              committedAt: "2026-07-14T09:00:00.000Z",
              subject: "Fix typo",
              additions: 4,
              deletions: 1,
              aiDescription: null,
            },
          ],
        },
      ],
      developers: [],
    };
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, namedReport),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    // resolvedUser null ma authorName presente → si mostra il nome grezzo,
    // non il segnaposto "Unknown author".
    expect(screen.getByText("Mario Rossi")).toBeInTheDocument();
    expect(screen.queryByText("Unknown author")).not.toBeInTheDocument();
  });

  it("commit senza descrizione: rende l'oggetto ma nessun blocco markdown", async () => {
    const noDescReport = {
      date: "2026-07-14",
      projects: [
        {
          project: { id: "p1", name: "Apollo", slug: "apollo" },
          status: "done",
          header: { commitCount: 1, additions: 2, deletions: 0, authorCount: 1 },
          commits: [
            {
              sha: "0011223344556677",
              authorName: "Ada Dev",
              resolvedUser: { id: "u1", email: "ada@example.com", avatarUrl: null },
              committedAt: "2026-07-14T09:00:00.000Z",
              subject: "Bump version",
              additions: 2,
              deletions: 0,
              aiDescription: null,
            },
          ],
        },
      ],
      developers: [],
    };
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, noDescReport),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    // L'oggetto del commit è reso…
    expect(screen.getByText("Bump version")).toBeInTheDocument();
    // …ma senza `aiDescription` non c'è alcun contenitore markdown.
    expect(document.querySelector(".markdown")).toBeNull();
  });

  it("admin: 'Link team member' nella vista per sviluppatore associa l'email git del dev", async () => {
    // Ramo `linkEmail={dev.gitEmail}`: nella vista-dev un developer non risolto
    // (resolvedUser null, gitEmail valorizzato) espone il pulsante nell'header
    // dev; il POST usa l'email git del developer, non quella del membro scelto.
    const user = userEvent.setup();
    let linkBody: unknown = null;
    let linkedUserId: string | null = null;
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, REPORT),
      "GET /api/users": () => jsonResponse(200, MEMBERS),
      "POST /api/users/u9/git-identities": (_url, init) => {
        linkedUserId = "u9";
        linkBody = JSON.parse(String(init?.body));
        return jsonResponse(200, []);
      },
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    await user.click(screen.getByRole("tab", { name: "By developer" }));

    // Nel blocco del dev non risolto (ghost@git.example) c'è il pulsante di link.
    await user.click(screen.getByRole("button", { name: "Link team member" }));

    const combo = await screen.findByRole("combobox", { name: "Pick a team member" });
    await user.type(combo, "newdev");
    const listbox = screen.getByRole("listbox");
    await user.click(within(listbox).getByRole("option", { name: /newdev@corp\.example/ }));

    // Il POST associa l'email git del DEVELOPER (dev.gitEmail), non del membro.
    await waitFor(() => expect(linkBody).toEqual({ email: "ghost@git.example" }));
    expect(linkedUserId).toBe("u9");
  });

  it("admin: link membro con 409 git_identity_taken → errore inline, picker ancora utilizzabile", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, REPORT),
      "GET /api/users": () => jsonResponse(200, MEMBERS),
      "POST /api/users/u9/git-identities": () =>
        jsonResponse(409, { code: "git_identity_taken", message: "taken" }),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    await user.click(screen.getByRole("button", { name: "Link team member" }));

    const combo = await screen.findByRole("combobox", { name: "Pick a team member" });
    await user.type(combo, "newdev");
    await user.click(
      within(screen.getByRole("listbox")).getByRole("option", { name: /newdev@corp\.example/ }),
    );

    // Il messaggio i18n del codice 409 compare inline (role=alert)…
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This git email is already linked to a member");
    // …e il picker resta montato/utilizzabile (l'errore non lo chiude).
    expect(screen.getByRole("combobox", { name: "Pick a team member" })).toBeInTheDocument();
  });

  it("collapse persiste attraverso un refetch della query attività", async () => {
    // Invariante: la key stabile del blocco (project.id) preserva lo stato di
    // collapse quando la query attività viene invalidata e rifà il fetch (come
    // dopo un link membro). Nessun remount → il blocco resta collassato.
    const user = userEvent.setup();
    let activityCalls = 0;
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => {
        activityCalls += 1;
        return jsonResponse(200, REPORT);
      },
    });

    const { queryClient } = renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    await user.click(screen.getByRole("button", { name: "Apollo" }));
    expect(screen.queryByText("Add login form")).not.toBeInTheDocument();
    const callsBefore = activityCalls;

    // Invalidazione per prefisso → refetch della stessa key.
    await queryClient.invalidateQueries({ queryKey: ["activity"] });
    await waitFor(() => expect(activityCalls).toBeGreaterThan(callsBefore));

    // Dopo il refetch il blocco è ancora collassato (stato non perso).
    expect(screen.getByRole("button", { name: "Apollo" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("Add login form")).not.toBeInTheDocument();
  });

  it("nasconde i progetti 'done' senza attività, mostra quelli con commit", async () => {
    const mixed = {
      date: "2026-07-14",
      projects: [
        {
          project: { id: "p1", name: "Apollo", slug: "apollo" },
          status: "done",
          header: { commitCount: 1, additions: 3, deletions: 0, authorCount: 1 },
          commits: [
            {
              sha: "aaaaaaa1111",
              authorName: "A",
              authorEmail: "a@x.it",
              resolvedUser: null,
              committedAt: "2026-07-14T09:00:00.000Z",
              subject: "Real work",
              additions: 3,
              deletions: 0,
              aiDescription: null,
            },
          ],
        },
        {
          project: { id: "p2", name: "Zephyr", slug: "zephyr" },
          status: "done",
          header: { commitCount: 0, additions: 0, deletions: 0, authorCount: 0 },
          commits: [],
        },
      ],
      developers: [],
    };
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, mixed),
    });

    renderActivity();

    // Apollo (con attività) è mostrato; Zephyr (done, 0 commit) è nascosto.
    expect(await screen.findByRole("heading", { name: "Apollo" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Zephyr" })).not.toBeInTheDocument();
  });

  it("se tutti i progetti sono 'done' senza attività mostra il messaggio di giornata", async () => {
    const allEmpty = {
      date: "2026-07-14",
      projects: [
        {
          project: { id: "p1", name: "Apollo", slug: "apollo" },
          status: "done",
          header: { commitCount: 0, additions: 0, deletions: 0, authorCount: 0 },
          commits: [],
        },
      ],
      developers: [],
    };
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, allEmpty),
    });

    renderActivity();

    // Nessuna card progetto; messaggio a livello di giornata, niente pulsante genera.
    expect(await screen.findByText("No activity for this date")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Apollo" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Generate report for this day" }),
    ).not.toBeInTheDocument();
  });

  it("riassunto null + report queued → placeholder 'Summary in progress…'", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, QUEUED_REPORT),
    });

    renderActivity();

    // Progetto queued senza riassunto → placeholder in cima alla card.
    expect(await screen.findByRole("heading", { name: "Apollo" })).toBeInTheDocument();
    expect(screen.getByText("Summary in progress…")).toBeInTheDocument();
  });

  it("riassunto null + progetto done → nessun placeholder ingombrante", async () => {
    // Run finita senza riassunto (summary null, status done): non si mostra né il
    // markdown né il placeholder "in generazione".
    const doneNoSummary = {
      date: "2026-07-14",
      developersSummaryPending: false,
      projects: [
        {
          project: { id: "p1", name: "Apollo", slug: "apollo" },
          status: "done",
          summary: null,
          header: { commitCount: 1, additions: 2, deletions: 0, authorCount: 1 },
          commits: [
            {
              sha: "0011223344556677",
              authorName: "Ada Dev",
              resolvedUser: { id: "u1", email: "ada@example.com", avatarUrl: null },
              committedAt: "2026-07-14T09:00:00.000Z",
              subject: "Bump version",
              additions: 2,
              deletions: 0,
              aiDescription: null,
            },
          ],
        },
      ],
      developers: [],
    };
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, doneNoSummary),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    expect(screen.getByText("Bump version")).toBeInTheDocument();
    // Nessun placeholder e nessun blocco riassunto (markdown).
    expect(screen.queryByText("Summary in progress…")).not.toBeInTheDocument();
    expect(document.querySelector(".markdown")).toBeNull();
  });

  it("descrizione commit: collassata di default, espande e richiude con aria-expanded", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, REPORT),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    // Collassata: la descrizione non è nel DOM e la riga espone aria-expanded=false.
    const toggle = screen.getByRole("button", { name: "Show description for Add login form" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("login")).not.toBeInTheDocument();

    // Espande: la descrizione appare, aria-expanded passa a true (e l'etichetta cambia).
    await user.click(toggle);
    expect(screen.getByText("login").tagName).toBe("CODE");
    const expanded = screen.getByRole("button", { name: "Hide description for Add login form" });
    expect(expanded).toHaveAttribute("aria-expanded", "true");

    // Richiude: la descrizione sparisce di nuovo.
    await user.click(expanded);
    expect(screen.queryByText("login")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show description for Add login form" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("commit senza descrizione: riga non espandibile (nessun toggle), solo oggetto", async () => {
    const oneNullDesc = {
      date: "2026-07-14",
      developersSummaryPending: false,
      projects: [
        {
          project: { id: "p1", name: "Apollo", slug: "apollo" },
          status: "done",
          summary: null,
          header: { commitCount: 1, additions: 2, deletions: 0, authorCount: 1 },
          commits: [
            {
              sha: "0011223344556677",
              authorName: "Ada Dev",
              resolvedUser: { id: "u1", email: "ada@example.com", avatarUrl: null },
              committedAt: "2026-07-14T09:00:00.000Z",
              subject: "Bump version",
              additions: 2,
              deletions: 0,
              aiDescription: null,
            },
          ],
        },
      ],
      developers: [],
    };
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, oneNullDesc),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    // L'oggetto è reso, ma senza descrizione non c'è il toggle di espansione.
    expect(screen.getByText("Bump version")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Show description for/ }),
    ).not.toBeInTheDocument();
  });

  it("vista per sviluppatore: developersSummaryPending → placeholder riassunto per il dev", async () => {
    // Rollup dei riassunti dev ancora in corso: il dev senza summary mostra il
    // placeholder "in generazione" in cima alla propria card.
    const user = userEvent.setup();
    const pendingReport = {
      date: "2026-07-14",
      developersSummaryPending: true,
      projects: REPORT.projects,
      developers: [
        {
          resolvedUser: { id: "u1", email: "ada@example.com", avatarUrl: null },
          gitEmail: "ada@git.example",
          authorName: "Ada Dev",
          summary: null,
          header: { commitCount: 1, additions: 40, deletions: 5, projectCount: 1 },
          byProject: [
            {
              project: { id: "p1", name: "Apollo", slug: "apollo" },
              commits: [
                {
                  sha: "abcdef1234567890",
                  committedAt: "2026-07-14T09:00:00.000Z",
                  subject: "Add login form",
                  additions: 40,
                  deletions: 5,
                  aiDescription: null,
                },
              ],
            },
          ],
        },
      ],
    };
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, pendingReport),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    await user.click(screen.getByRole("tab", { name: "By developer" }));

    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("Summary in progress…")).toBeInTheDocument();
  });

  it("polling: refetchInterval attivo con report pending o developersSummaryPending", () => {
    const interval = activityReportQueryOptions("2026-07-14").refetchInterval as (query: {
      state: { data: unknown };
    }) => number | false;

    // Tutto done e nessun rollup pendente → nessun refetch periodico.
    expect(
      interval({
        state: {
          data: { projects: [{ status: "done" }], developers: [], developersSummaryPending: false },
        },
      }),
    ).toBe(false);

    // Un report queued → polling attivo.
    expect(
      interval({
        state: {
          data: { projects: [{ status: "queued" }], developers: [], developersSummaryPending: false },
        },
      }),
    ).toBe(10_000);

    // Report done ma rollup riassunti dev in corso → polling attivo.
    expect(
      interval({
        state: {
          data: { projects: [{ status: "done" }], developers: [], developersSummaryPending: true },
        },
      }),
    ).toBe(10_000);
  });

  it("espansione descrizione commit persiste attraverso un refetch della query", async () => {
    // Invariante: le righe commit sono keyate per sha → lo stato locale di
    // espansione si preserva quando la query attività viene invalidata e rifà il
    // fetch (nessun remount). La descrizione espansa resta visibile.
    const user = userEvent.setup();
    let activityCalls = 0;
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => {
        activityCalls += 1;
        return jsonResponse(200, REPORT);
      },
    });

    const { queryClient } = renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    // Espande la riga del commit: la descrizione markdown appare.
    await user.click(
      screen.getByRole("button", { name: "Show description for Add login form" }),
    );
    expect(screen.getByText("login").tagName).toBe("CODE");
    const callsBefore = activityCalls;

    // Invalidazione per prefisso → refetch della stessa key.
    await queryClient.invalidateQueries({ queryKey: ["activity"] });
    await waitFor(() => expect(activityCalls).toBeGreaterThan(callsBefore));

    // Dopo il refetch la descrizione è ancora espansa (stato non perso).
    expect(screen.getByText("login").tagName).toBe("CODE");
    expect(
      screen.getByRole("button", { name: "Hide description for Add login form" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("riassunto markdown multi-elemento: la lista rende più <li> in cima alla card", async () => {
    // Il riassunto del giorno può essere markdown strutturato: una lista deve
    // produrre elementi <li> distinti, non testo grezzo coi trattini.
    const listSummary = {
      date: "2026-07-14",
      developersSummaryPending: false,
      projects: [
        {
          project: { id: "p1", name: "Apollo", slug: "apollo" },
          status: "done",
          summary: "- shipped auth\n- fixed logout",
          header: { commitCount: 1, additions: 4, deletions: 1, authorCount: 1 },
          commits: [
            {
              sha: "0011223344556677",
              authorName: "Ada Dev",
              resolvedUser: { id: "u1", email: "ada@example.com", avatarUrl: null },
              committedAt: "2026-07-14T09:00:00.000Z",
              subject: "Bump version",
              additions: 4,
              deletions: 1,
              aiDescription: null,
            },
          ],
        },
      ],
      developers: [],
    };
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, listSummary),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    // Il riassunto in cima alla card è una region etichettata "Summary".
    const region = screen.getByRole("region", { name: "Summary" });
    // La lista markdown rende <li> distinti (non testo grezzo coi trattini).
    const shipped = within(region).getByText("shipped auth");
    const fixed = within(region).getByText("fixed logout");
    expect(shipped.tagName).toBe("LI");
    expect(fixed.tagName).toBe("LI");
  });

  it("badge sulla card quando staleCommitCount > 0; nessun badge se 0", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, STALE_REPORT),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    // Il progetto ha 3 commit non ancora inclusi → badge "3 new commits".
    expect(screen.getByText("3 new commits")).toBeInTheDocument();
  });

  it("nessun badge sulla card quando staleCommitCount è 0", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, REPORT),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    expect(screen.queryByText(/new commits?$/)).not.toBeInTheDocument();
  });

  it("avviso di giornata quando staleCommitTotal > 0 (col numero)", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: MEMBER }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, STALE_REPORT),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    // L'avviso di giornata (visibile anche ai member) riporta il totale.
    expect(
      screen.getByText(/4 new commits not included since the last generation/),
    ).toBeInTheDocument();
  });

  it("nessun avviso di giornata quando staleCommitTotal è 0", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: MEMBER }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, REPORT),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    expect(
      screen.queryByText(/not included since the last generation/),
    ).not.toBeInTheDocument();
  });

  it("admin: pulsante 'Regenerate' su report esistente → POST /generate con force:true", async () => {
    const user = userEvent.setup();
    let generateBody: unknown = null;
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, REPORT),
      "POST /api/activity/generate": (_url, init) => {
        generateBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { queued: 1 });
      },
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    await user.click(screen.getByRole("button", { name: "Regenerate" }));

    // Il body forza la rigenerazione dei report esistenti del giorno.
    await waitFor(() => expect(generateBody).not.toBeNull());
    expect(generateBody).toHaveProperty("force", true);
    expect(generateBody).toHaveProperty("date");
  });

  it("member: nessun pulsante 'Regenerate' su report esistente", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: MEMBER }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, REPORT),
    });

    renderActivity();

    await screen.findByRole("heading", { name: "Apollo" });
    expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
  });

  it("giorno vuoto: nessun 'Regenerate', resta il 'Generate' (non regredito)", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, EMPTY_REPORT),
    });

    renderActivity();

    // Su un giorno senza report c'è "Generate", non "Regenerate".
    expect(
      await screen.findByRole("button", { name: "Generate report for this day" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
  });
});
