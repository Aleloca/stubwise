import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  return router;
}

// Email di sessione distinte dai dati del report: l'AppLayout mostra l'email
// dell'utente loggato nella sidebar e collidere con il report romperebbe le
// query per testo.
const ADMIN = { id: "u1", email: "me-admin@corp.example", role: "admin" as const, language: "en" };
const MEMBER = { id: "u2", email: "me-member@corp.example", role: "member" as const, language: "en" };

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

// Report con un progetto: un'entry con membro risolto e una con email grezza.
const REPORT = {
  date: "2026-07-14",
  projects: [
    {
      project: { id: "p1", name: "Apollo", slug: "apollo" },
      date: "2026-07-14",
      status: "done",
      entries: [
        {
          gitEmail: "ada@git.example",
          authorName: "Ada Dev",
          resolvedUser: { id: "u1", email: "ada@example.com", avatarUrl: null },
          commitCount: 2,
          additions: 40,
          deletions: 5,
          commits: [
            { sha: "abcdef1234567890", subject: "Add login form", repoId: "r1" },
            { sha: "1122334455667788", subject: "Fix header", repoId: "r1" },
          ],
          aiSummary: "Worked on authentication and layout fixes.",
        },
        {
          gitEmail: "ghost@git.example",
          authorName: null,
          resolvedUser: null,
          commitCount: 1,
          additions: 3,
          deletions: 1,
          commits: [{ sha: "9988776655443322", subject: "Tweak copy", repoId: "r1" }],
          aiSummary: null,
        },
      ],
    },
  ],
  developers: [
    {
      resolvedUser: { id: "u1", email: "ada@example.com", avatarUrl: null },
      gitEmail: "ada@git.example",
      authorName: "Ada Dev",
      totalCommits: 2,
      totalAdditions: 40,
      totalDeletions: 5,
      perProject: [
        {
          projectId: "p1",
          projectName: "Apollo",
          commitCount: 2,
          aiSummary: "Auth + layout.",
          commits: [{ sha: "abcdef1234567890", subject: "Add login form", repoId: "r1" }],
        },
      ],
    },
    {
      resolvedUser: null,
      gitEmail: "ghost@git.example",
      authorName: null,
      totalCommits: 1,
      totalAdditions: 3,
      totalDeletions: 1,
      perProject: [
        {
          projectId: "p1",
          projectName: "Apollo",
          commitCount: 1,
          aiSummary: null,
          commits: [{ sha: "9988776655443322", subject: "Tweak copy", repoId: "r1" }],
        },
      ],
    },
  ],
};

const EMPTY_REPORT = { date: "2026-01-01", projects: [], developers: [] };

describe("sezione attività", () => {
  it("admin: vista per progetto (default) con membro risolto ed email grezza", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, REPORT),
    });

    renderActivity();

    // Header e blocco progetto.
    expect(await screen.findByRole("heading", { name: "Activity" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Apollo" })).toBeInTheDocument();

    // Autore risolto: email del membro. Autore non risolto: email git grezza.
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    const ghost = screen.getByText("ghost@git.example");
    expect(ghost).toBeInTheDocument();
    // L'email non risolta è in corsivo (degradazione).
    expect(ghost.className).toContain("italic");

    // Riassunto AI e commit.
    expect(screen.getByText("Worked on authentication and layout fixes.")).toBeInTheDocument();
    expect(screen.getByText("Add login form")).toBeInTheDocument();
    // Il repo è etichettato col nome, non con l'id grezzo.
    expect(screen.getAllByText("web").length).toBeGreaterThan(0);

    // Hint "Link in Team" (solo admin) accanto all'autore non risolto.
    expect(screen.getByRole("link", { name: "Link in Team" })).toBeInTheDocument();
  });

  it("member: niente hint 'Link in Team' sull'autore non risolto", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: MEMBER }),
      "GET /api/repositories": () => jsonResponse(200, REPOS),
      "GET /api/activity": () => jsonResponse(200, REPORT),
    });

    renderActivity();

    expect(await screen.findByText("ghost@git.example")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Link in Team" })).not.toBeInTheDocument();
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

    // Il blocco dev mostra l'autore risolto e i totali (2 commit).
    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getAllByText("2 commits").length).toBeGreaterThan(0);
    // Il sotto-blocco per progetto compare col nome del progetto.
    expect(screen.getAllByText("Apollo").length).toBeGreaterThan(0);
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

  it("non crasha se la lista repository fallisce (fallback all'id repo)", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/repositories": () => jsonResponse(500, { code: "boom", message: "down" }),
      "GET /api/activity": () => jsonResponse(200, REPORT),
    });

    renderActivity();

    // La pagina si monta e mostra i commit; il repo ripiega sull'id grezzo.
    expect(await screen.findByText("Add login form")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("r1").length).toBeGreaterThan(0));
  });
});
