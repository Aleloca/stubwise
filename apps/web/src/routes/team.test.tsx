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

    // Apri il picker e seleziona il membro Slack disponibile.
    await user.click(within(beaRow).getByRole("button", { name: "Link Slack" }));
    const select = within(beaRow).getByRole("combobox", { name: "Pick a Slack member" });
    // L'opzione già collegata ad un altro è disabilitata.
    const takenOption = within(select).getByRole("option", { name: /Carl Jung/ });
    expect(takenOption).toBeDisabled();
    await user.selectOptions(select, "W001");

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
    const select = within(beaRow).getByRole("combobox", { name: "Pick a Slack member" });
    await user.selectOptions(select, "W001");

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
    const select = screen.getByRole("combobox", { name: "Pick a Slack member" });
    expect(within(select).queryByRole("option", { name: /Carl Jung/ })).not.toBeInTheDocument();
    await user.selectOptions(select, "W001");

    await waitFor(() =>
      expect(postBody).toEqual({ email: "bea@example.com", slackUserId: "W001" }),
    );
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
});
