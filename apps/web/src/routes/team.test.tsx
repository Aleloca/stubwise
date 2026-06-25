import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * Pagina Team: roster dei membri per tutti, gestione inviti solo per gli
 * admin. Router reale + memory history, API mockata via fetch.
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

function renderTeam() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ["/team"] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const ADMIN = {
  id: "u1",
  email: "ada@example.com",
  role: "admin" as const,
  avatarUrl: null,
  slackUserId: null,
};
const MEMBER = {
  id: "u2",
  email: "bea@example.com",
  role: "member" as const,
  avatarUrl: null,
  slackUserId: null,
};

const USERS = [
  { ...ADMIN, createdAt: "2026-01-01T10:00:00.000Z" },
  { ...MEMBER, createdAt: "2026-02-01T10:00:00.000Z" },
];

// Membri del workspace Slack per il picker (admin).
const SLACK_USERS = [
  {
    id: "W001",
    displayName: "Bea Smith",
    email: "bea@example.com",
    avatarUrl: "https://slack/bea.png",
    linkedUserId: null,
  },
  {
    id: "W002",
    displayName: "Carl Jung",
    email: "carl@example.com",
    avatarUrl: "https://slack/carl.png",
    linkedUserId: "u9", // già collegato ad un altro utente
  },
];

describe("pagina team", () => {
  it("admin: vede il roster e la sezione inviti, crea e revoca un invito", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    let deletedToken: string | null = null;
    let invites = [
      {
        token: "tok-pending",
        email: "in-sospeso@example.com",
        createdAt: "2026-06-01T10:00:00.000Z",
        expiresAt: "2026-06-08T10:00:00.000Z",
        slackUserId: null,
        slackAvatarUrl: null,
      },
    ];

    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
      "GET /api/slack/workspace-users": () => jsonResponse(200, SLACK_USERS),
      "GET /api/auth/invites": () => jsonResponse(200, invites),
      "POST /api/auth/invites": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        invites = [
          {
            token: "tok-nuovo",
            email: "collega@example.com",
            createdAt: "2026-06-10T10:00:00.000Z",
            expiresAt: "2026-06-17T10:00:00.000Z",
            slackUserId: null,
            slackAvatarUrl: null,
          },
          ...invites,
        ];
        return jsonResponse(201, {
          token: "tok-nuovo",
          expiresAt: "2026-06-17T10:00:00.000Z",
        });
      },
      "DELETE /api/auth/invites/tok-pending": () => {
        deletedToken = "tok-pending";
        invites = invites.filter((i) => i.token !== "tok-pending");
        return jsonResponse(204, null);
      },
    });

    renderTeam();

    expect(await screen.findByRole("heading", { name: "Team" })).toBeInTheDocument();
    // Roster: entrambi i membri compaiono.
    expect(screen.getByText("bea@example.com")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Members" })).toBeInTheDocument();
    // Sezione inviti visibile e invito in sospeso elencato.
    expect(screen.getByRole("heading", { name: "Pending invites" })).toBeInTheDocument();
    expect(await screen.findByText("in-sospeso@example.com")).toBeInTheDocument();

    // Crea un invito → chiama postInvite e mostra il link.
    await user.type(screen.getByLabelText("Invite a user"), "collega@example.com");
    await user.click(screen.getByRole("button", { name: "Create invite" }));
    expect(postBody).toEqual({ email: "collega@example.com" });
    const link = await screen.findByTestId("invite-url");
    expect(link.textContent).toContain("/register?token=tok-nuovo");

    // Revoca l'invito in sospeso (confirm accettato) → chiama deleteInvite.
    // Si individua il bottone "Revoca" della riga giusta tramite il suo <li>.
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const pendingRow = screen.getByText("in-sospeso@example.com").closest("li");
    expect(pendingRow).not.toBeNull();
    const revokeButton = within(pendingRow!).getByRole("button", { name: "Revoke" });
    await user.click(revokeButton);
    await waitFor(() => expect(deletedToken).toBe("tok-pending"));
    await waitFor(() =>
      expect(screen.queryByText("in-sospeso@example.com")).not.toBeInTheDocument(),
    );
  });

  it("member: vede solo il roster, niente gestione inviti", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...MEMBER, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
    });

    renderTeam();

    expect(await screen.findByRole("heading", { name: "Members" })).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    // Niente sezione né form di gestione inviti.
    expect(screen.queryByRole("heading", { name: "Pending invites" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create invite" })).not.toBeInTheDocument();
    // Niente azioni Slack (riservate agli admin).
    expect(screen.queryByRole("button", { name: "Link Slack" })).not.toBeInTheDocument();
  });

  it("admin: collega un membro a Slack tramite il picker", async () => {
    const user = userEvent.setup();
    let linkBody: unknown;
    let linkedUserId: string | null = null;

    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () =>
        jsonResponse(
          200,
          linkedUserId === "u2"
            ? [USERS[0], { ...USERS[1], slackUserId: "W001", avatarUrl: "https://slack/bea.png" }]
            : USERS,
        ),
      "GET /api/slack/workspace-users": () => jsonResponse(200, SLACK_USERS),
      "GET /api/auth/invites": () => jsonResponse(200, []),
      "PUT /api/users/u2/slack": (_url, init) => {
        linkBody = JSON.parse(String(init?.body));
        linkedUserId = "u2";
        return jsonResponse(200, {
          ...USERS[1],
          slackUserId: "W001",
          avatarUrl: "https://slack/bea.png",
        });
      },
    });

    renderTeam();

    // Il membro non collegato mostra "Not linked".
    const beaRow = (await screen.findByText("bea@example.com")).closest("li")!;
    expect(within(beaRow).getByText("Not linked")).toBeInTheDocument();

    // Apri il picker, filtra per nome e seleziona il membro Slack disponibile.
    await user.click(within(beaRow).getByRole("button", { name: "Link Slack" }));
    const search = within(beaRow).getByRole("combobox", { name: "Pick a Slack member" });
    await user.type(search, "Bea");
    const listbox = within(beaRow).getByRole("listbox");
    // L'opzione già collegata ad un altro è marcata come disabilitata.
    expect(within(listbox).queryByRole("option", { name: /Carl Jung/ })).not.toBeInTheDocument();
    await user.click(within(listbox).getByRole("option", { name: /Bea Smith/ }));

    await waitFor(() => expect(linkBody).toEqual({ slackUserId: "W001" }));
    // Dopo l'invalidazione il membro risulta collegato.
    await waitFor(() => expect(within(beaRow).queryByText("Not linked")).not.toBeInTheDocument());
  });

  it("admin: scollega un membro da Slack", async () => {
    const user = userEvent.setup();
    let unlinked = false;
    const linkedMember = {
      ...USERS[1],
      slackUserId: "W001",
      avatarUrl: "https://slack/bea.png",
    };

    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, unlinked ? USERS : [USERS[0], linkedMember]),
      "GET /api/slack/workspace-users": () => jsonResponse(200, SLACK_USERS),
      "GET /api/auth/invites": () => jsonResponse(200, []),
      "DELETE /api/users/u2/slack": () => {
        unlinked = true;
        return jsonResponse(204, null);
      },
    });

    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderTeam();

    const beaRow = (await screen.findByText("bea@example.com")).closest("li")!;
    // Stato collegato (arricchito col displayName Slack quando disponibile).
    expect(within(beaRow).getByText(/^Linked/)).toBeInTheDocument();
    await user.click(within(beaRow).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(unlinked).toBe(true));
    await waitFor(() => expect(within(beaRow).getByText("Not linked")).toBeInTheDocument());
  });

  it("admin: errore slack_identity_taken mostra il messaggio i18n", async () => {
    const user = userEvent.setup();

    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
      "GET /api/slack/workspace-users": () => jsonResponse(200, SLACK_USERS),
      "GET /api/auth/invites": () => jsonResponse(200, []),
      "PUT /api/users/u2/slack": () =>
        jsonResponse(409, {
          code: "slack_identity_taken",
          message: "taken",
        }),
    });

    renderTeam();

    const beaRow = (await screen.findByText("bea@example.com")).closest("li")!;
    await user.click(within(beaRow).getByRole("button", { name: "Link Slack" }));
    const search = within(beaRow).getByRole("combobox", { name: "Pick a Slack member" });
    await user.type(search, "Bea");
    const listbox = within(beaRow).getByRole("listbox");
    await user.click(within(listbox).getByRole("option", { name: /Bea Smith/ }));

    expect(
      await screen.findByText("This Slack identity is already linked to another member"),
    ).toBeInTheDocument();
  });

  it("admin: Slack non configurato → azioni disabilitate con hint, niente crash", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
      "GET /api/slack/workspace-users": () =>
        jsonResponse(400, { code: "slack_not_configured", message: "off" }),
      "GET /api/auth/invites": () => jsonResponse(200, []),
    });

    renderTeam();

    // La pagina si monta senza crash e mostra il roster.
    expect(await screen.findByText("bea@example.com")).toBeInTheDocument();
    const beaRow = screen.getByText("bea@example.com").closest("li")!;
    // L'azione di link è disabilitata.
    expect(within(beaRow).getByRole("button", { name: "Link Slack" })).toBeDisabled();
    // Hint di configurazione presente.
    expect(screen.getAllByText("Configure Slack in Settings").length).toBeGreaterThan(0);
  });

  it("admin: invito da Slack precompila l'email e invia lo slackUserId", async () => {
    const user = userEvent.setup();
    let postBody: unknown;

    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
      "GET /api/slack/workspace-users": () => jsonResponse(200, SLACK_USERS),
      "GET /api/auth/invites": () => jsonResponse(200, []),
      "POST /api/auth/invites": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, { token: "tok-slack", expiresAt: "2026-06-17T10:00:00.000Z" });
      },
    });

    renderTeam();

    await user.click(await screen.findByRole("button", { name: "Invite from Slack" }));
    // Il picker mostra solo i membri non ancora collegati (Bea, non Carl).
    const search = screen.getByRole("combobox", { name: "Pick a Slack member" });
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).queryByRole("option", { name: /Carl Jung/ })).not.toBeInTheDocument();
    await user.type(search, "bea@example.com");
    await user.click(within(listbox).getByRole("option", { name: /Bea Smith/ }));

    await waitFor(() =>
      expect(postBody).toEqual({ email: "bea@example.com", slackUserId: "W001" }),
    );
  });

  it("admin: il picker filtra per email e mostra il no-results", async () => {
    const user = userEvent.setup();

    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
      "GET /api/slack/workspace-users": () => jsonResponse(200, SLACK_USERS),
      "GET /api/auth/invites": () => jsonResponse(200, []),
    });

    renderTeam();

    const beaRow = (await screen.findByText("bea@example.com")).closest("li")!;
    await user.click(within(beaRow).getByRole("button", { name: "Link Slack" }));
    const search = within(beaRow).getByRole("combobox", { name: "Pick a Slack member" });
    const listbox = within(beaRow).getByRole("listbox");

    // Filtra per email: solo Bea (carl è collegato ad altri e comunque non matcha).
    await user.type(search, "bea@");
    expect(within(listbox).getByRole("option", { name: /Bea Smith/ })).toBeInTheDocument();
    expect(within(listbox).queryByRole("option", { name: /Carl/ })).not.toBeInTheDocument();

    // Query senza match → messaggio no-results, nessuna opzione.
    await user.clear(search);
    await user.type(search, "zzzznope");
    expect(within(listbox).queryAllByRole("option")).toHaveLength(0);
    expect(within(beaRow).getByText("No matching members")).toBeInTheDocument();
  });

  it("admin: una voce già collegata non è selezionabile", async () => {
    const user = userEvent.setup();
    let putCalled = false;

    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
      "GET /api/slack/workspace-users": () => jsonResponse(200, SLACK_USERS),
      "GET /api/auth/invites": () => jsonResponse(200, []),
      "PUT /api/users/u2/slack": () => {
        putCalled = true;
        return jsonResponse(200, USERS[1]);
      },
    });

    renderTeam();

    const beaRow = (await screen.findByText("bea@example.com")).closest("li")!;
    await user.click(within(beaRow).getByRole("button", { name: "Link Slack" }));
    const search = within(beaRow).getByRole("combobox", { name: "Pick a Slack member" });
    await user.type(search, "Carl");
    const listbox = within(beaRow).getByRole("listbox");
    const taken = within(listbox).getByRole("option", { name: /Carl Jung/ });
    expect(taken).toHaveAttribute("aria-disabled", "true");
    expect(within(taken).getByText(/already linked/)).toBeInTheDocument();

    // Click non scatena la mutation.
    await user.click(taken);
    expect(putCalled).toBe(false);
  });

  it("admin: seleziona da tastiera con ArrowDown + Enter", async () => {
    const user = userEvent.setup();
    let linkBody: unknown;

    // Tre membri non collegati così ArrowDown sposta l'indice attivo.
    const slackUsers = [
      {
        id: "W001",
        displayName: "Bea Smith",
        email: "bea@example.com",
        avatarUrl: null,
        linkedUserId: null,
      },
      {
        id: "W010",
        displayName: "Bea Jones",
        email: "bea.jones@example.com",
        avatarUrl: null,
        linkedUserId: null,
      },
    ];

    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
      "GET /api/slack/workspace-users": () => jsonResponse(200, slackUsers),
      "GET /api/auth/invites": () => jsonResponse(200, []),
      "PUT /api/users/u2/slack": (_url, init) => {
        linkBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { ...USERS[1], slackUserId: "W010" });
      },
    });

    renderTeam();

    const beaRow = (await screen.findByText("bea@example.com")).closest("li")!;
    await user.click(within(beaRow).getByRole("button", { name: "Link Slack" }));
    const search = within(beaRow).getByRole("combobox", { name: "Pick a Slack member" });
    await user.type(search, "Bea");
    // ArrowDown porta dalla prima voce (Bea Smith) alla seconda (Bea Jones),
    // Enter la seleziona.
    await user.keyboard("{ArrowDown}{Enter}");

    await waitFor(() => expect(linkBody).toEqual({ slackUserId: "W010" }));
  });

  it("admin: le frecce saltano la voce già collegata e Enter non la seleziona", async () => {
    const user = userEvent.setup();
    let linkBody: unknown;

    // L'ordine mette la voce collegata in mezzo: ArrowDown da Bea Smith deve
    // saltare Carl (collegato) e atterrare su Dora.
    const slackUsers = [
      {
        id: "W001",
        displayName: "Bea Smith",
        email: "bea@example.com",
        avatarUrl: null,
        linkedUserId: null,
      },
      {
        id: "W002",
        displayName: "Bea Carl",
        email: "carl@example.com",
        avatarUrl: null,
        linkedUserId: "u9", // collegato ad altri → disabilitata
      },
      {
        id: "W003",
        displayName: "Bea Dora",
        email: "dora@example.com",
        avatarUrl: null,
        linkedUserId: null,
      },
    ];

    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
      "GET /api/slack/workspace-users": () => jsonResponse(200, slackUsers),
      "GET /api/auth/invites": () => jsonResponse(200, []),
      "PUT /api/users/u2/slack": (_url, init) => {
        linkBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { ...USERS[1], slackUserId: "W003" });
      },
    });

    renderTeam();

    const beaRow = (await screen.findByText("bea@example.com")).closest("li")!;
    await user.click(within(beaRow).getByRole("button", { name: "Link Slack" }));
    const search = within(beaRow).getByRole("combobox", { name: "Pick a Slack member" });
    await user.type(search, "Bea");
    // Un solo ArrowDown deve saltare la voce collegata (Carl) e attivare Dora.
    await user.keyboard("{ArrowDown}{Enter}");

    await waitFor(() => expect(linkBody).toEqual({ slackUserId: "W003" }));
  });

  it("admin: il picker limita i risultati renderizzati e mostra '+N altri'", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 80 }, (_, i) => ({
      id: `W${i}`,
      displayName: `User Number ${i}`,
      email: `user${i}@example.com`,
      avatarUrl: null,
      linkedUserId: null,
    }));

    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
      "GET /api/slack/workspace-users": () => jsonResponse(200, many),
      "GET /api/auth/invites": () => jsonResponse(200, []),
    });

    renderTeam();

    const beaRow = (await screen.findByText("bea@example.com")).closest("li")!;
    await user.click(within(beaRow).getByRole("button", { name: "Link Slack" }));
    const search = within(beaRow).getByRole("combobox", { name: "Pick a Slack member" });
    // "User" matcha tutti gli 80 → cap a 50, +30 altri.
    await user.type(search, "User");
    const listbox = within(beaRow).getByRole("listbox");
    expect(within(listbox).getAllByRole("option")).toHaveLength(50);
    expect(within(beaRow).getByText("+30 more — refine your search")).toBeInTheDocument();
  });

  it("la lista inviti mostra l'identità Slack quando presente", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
      "GET /api/slack/workspace-users": () => jsonResponse(200, SLACK_USERS),
      "GET /api/auth/invites": () =>
        jsonResponse(200, [
          {
            token: "tok-s",
            email: "dan@example.com",
            createdAt: "2026-06-01T10:00:00.000Z",
            expiresAt: "2026-06-08T10:00:00.000Z",
            slackUserId: "W003",
            slackAvatarUrl: "https://slack/dan.png",
          },
        ]),
    });

    renderTeam();

    const row = (await screen.findByText("dan@example.com")).closest("li")!;
    expect(within(row).getByText("via Slack")).toBeInTheDocument();
    expect(within(row).getByRole("img", { name: "dan@example.com" })).toBeInTheDocument();
  });

  it("admin: vede il selettore di ruolo per gli altri, solo il badge per sé", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
      "GET /api/slack/workspace-users": () => jsonResponse(200, SLACK_USERS),
      "GET /api/auth/invites": () => jsonResponse(200, []),
    });

    renderTeam();

    // Altro utente (Bea): selettore di ruolo presente.
    const beaRow = (await screen.findByText("bea@example.com")).closest("li")!;
    expect(
      within(beaRow).getByRole("combobox", { name: "Role of bea@example.com" }),
    ).toBeInTheDocument();

    // Sé stesso (Ada/admin): niente selettore, solo il badge read-only.
    expect(
      screen.queryByRole("combobox", { name: "Role of ada@example.com" }),
    ).not.toBeInTheDocument();
  });

  it("admin: cambiare il selettore invia la PATCH col ruolo giusto", async () => {
    const user = userEvent.setup();
    let patchBody: unknown;
    let patchedPath: string | null = null;

    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
      "GET /api/slack/workspace-users": () => jsonResponse(200, SLACK_USERS),
      "GET /api/auth/invites": () => jsonResponse(200, []),
      "PATCH /api/users/u2/role": (url, init) => {
        patchedPath = url.pathname;
        patchBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { ...USERS[1], role: "admin" });
      },
    });

    renderTeam();

    const beaRow = (await screen.findByText("bea@example.com")).closest("li")!;
    const roleSelect = within(beaRow).getByRole("combobox", { name: "Role of bea@example.com" });
    await user.selectOptions(roleSelect, "admin");

    await waitFor(() => expect(patchBody).toEqual({ role: "admin" }));
    expect(patchedPath).toBe("/api/users/u2/role");
  });

  it("member: non vede il selettore di ruolo per nessuno (solo badge)", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...MEMBER, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
    });

    renderTeam();

    await screen.findByText("ada@example.com");
    expect(screen.queryByRole("combobox", { name: /^Role of/ })).not.toBeInTheDocument();
  });

  it("admin: errore last_admin dalla PATCH mostra il messaggio i18n", async () => {
    const user = userEvent.setup();

    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: { ...ADMIN, language: "en" } }),
      "GET /api/users": () => jsonResponse(200, USERS),
      "GET /api/slack/workspace-users": () => jsonResponse(200, SLACK_USERS),
      "GET /api/auth/invites": () => jsonResponse(200, []),
      "PATCH /api/users/u2/role": () =>
        jsonResponse(409, { code: "last_admin", message: "cannot demote" }),
    });

    renderTeam();

    const beaRow = (await screen.findByText("bea@example.com")).closest("li")!;
    const roleSelect = within(beaRow).getByRole("combobox", { name: "Role of bea@example.com" });
    await user.selectOptions(roleSelect, "admin");

    expect(
      await screen.findByText("You cannot demote the last admin"),
    ).toBeInTheDocument();
  });
});
