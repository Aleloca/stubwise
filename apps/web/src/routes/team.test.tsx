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
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: ["/team"] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const ADMIN = { id: "u1", email: "ada@example.com", role: "admin" as const };
const MEMBER = { id: "u2", email: "bea@example.com", role: "member" as const };

const USERS = [
  { ...ADMIN, createdAt: "2026-01-01T10:00:00.000Z" },
  { ...MEMBER, createdAt: "2026-02-01T10:00:00.000Z" },
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
      },
    ];

    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: ADMIN }),
      "GET /api/users": () => jsonResponse(200, USERS),
      "GET /api/auth/invites": () => jsonResponse(200, invites),
      "POST /api/auth/invites": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        invites = [
          {
            token: "tok-nuovo",
            email: "collega@example.com",
            createdAt: "2026-06-10T10:00:00.000Z",
            expiresAt: "2026-06-17T10:00:00.000Z",
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
    expect(screen.getByRole("heading", { name: "Membri" })).toBeInTheDocument();
    // Sezione inviti visibile e invito in sospeso elencato.
    expect(screen.getByRole("heading", { name: "Inviti in sospeso" })).toBeInTheDocument();
    expect(await screen.findByText("in-sospeso@example.com")).toBeInTheDocument();

    // Crea un invito → chiama postInvite e mostra il link.
    await user.type(screen.getByLabelText("Invita un utente"), "collega@example.com");
    await user.click(screen.getByRole("button", { name: "Crea invito" }));
    expect(postBody).toEqual({ email: "collega@example.com" });
    const link = await screen.findByTestId("invite-url");
    expect(link.textContent).toContain("/register?token=tok-nuovo");

    // Revoca l'invito in sospeso (confirm accettato) → chiama deleteInvite.
    // Si individua il bottone "Revoca" della riga giusta tramite il suo <li>.
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const pendingRow = screen.getByText("in-sospeso@example.com").closest("li");
    expect(pendingRow).not.toBeNull();
    const revokeButton = within(pendingRow!).getByRole("button", { name: "Revoca" });
    await user.click(revokeButton);
    await waitFor(() => expect(deletedToken).toBe("tok-pending"));
    await waitFor(() =>
      expect(screen.queryByText("in-sospeso@example.com")).not.toBeInTheDocument(),
    );
  });

  it("member: vede solo il roster, niente gestione inviti", async () => {
    mockApi({
      "GET /api/auth/me": () => jsonResponse(200, { user: MEMBER }),
      "GET /api/users": () => jsonResponse(200, USERS),
    });

    renderTeam();

    expect(await screen.findByRole("heading", { name: "Membri" })).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    // Niente sezione né form di gestione inviti.
    expect(screen.queryByRole("heading", { name: "Inviti in sospeso" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crea invito" })).not.toBeInTheDocument();
  });
});
