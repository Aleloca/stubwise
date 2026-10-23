import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedMe } from "../test/me";
import { MyCredentialsPage } from "./credentials";

/**
 * «Le mie credenziali» (design «Dove sta nella web»): tutte quelle che puoi
 * leggere, di tutti i progetti, raggruppate per progetto e servizio. Qui si
 * leggono e basta: modifica, lettori e registro stanno nel progetto.
 */

const vaultState = vi.hoisted(() => ({ state: "locked" as string }));

vi.mock("../lib/vault/vault-context", () => ({
  useVault: () => ({
    state: vaultState.state,
    privateKey: null,
    personKeyId: null,
    unlock: async () => undefined,
    lock: () => undefined,
    activate: async () => undefined,
    recreateKey: async () => undefined,
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => <a href={params ? to.replace("$projectId", params.projectId ?? "") : to}>{children}</a>,
}));

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";

function credential(id: string, projectId: string, service: string, access: "read" | "pending") {
  return {
    id,
    projectId,
    service,
    label: null,
    url: null,
    username: "ops",
    notes: null,
    createdByUserId: null,
    createdAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
    updatedByUserId: null,
    access,
    // Anche con i permessi, qui niente gestione.
    canEdit: true,
    canShare: true,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();
let paths: string[];
let pendingItems: unknown[];

beforeEach(() => {
  paths = [];
  pendingItems = [];
  vaultState.state = "locked";
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (input, init) => {
    const path = new URL(String(input), "http://test.local").pathname;
    paths.push(`${init?.method ?? "GET"} ${path}`);
    switch (path) {
      case "/api/vault/credentials":
        return jsonResponse(200, {
          items: [
            credential("60000000-0000-4000-8000-000000000001", ALPHA, "Hetzner", "read"),
            credential("60000000-0000-4000-8000-000000000002", BETA, "GitHub", "pending"),
          ],
        });
      case "/api/projects":
        return jsonResponse(200, [
          { id: ALPHA, name: "Alpha", slug: "alpha" },
          { id: BETA, name: "Beta", slug: "beta" },
        ]);
      case "/api/vault/pending":
        return jsonResponse(200, { items: pendingItems });
      case "/api/vault/status":
        return jsonResponse(200, { activated: true, myKey: null, seals: [] });
      default:
        return jsonResponse(500, { message: `unexpected ${path}` });
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedMe(queryClient, { instancePermissions: [], projectPermissions: {} });
  render(
    <QueryClientProvider client={queryClient}>
      <MyCredentialsPage />
    </QueryClientProvider>,
  );
}

describe("Le mie credenziali", () => {
  it("raggruppa per progetto e servizio, con Mostra/Copia e senza gestione", async () => {
    renderPage();

    const alpha = await screen.findByRole("region", { name: "Alpha" });
    const hetzner = within(alpha).getByRole("listitem", { name: "Hetzner" });
    expect(
      within(hetzner).getByRole("button", { name: "Show the password of Hetzner" }),
    ).toBeInTheDocument();
    expect(
      within(hetzner).getByRole("button", { name: "Copy the password of Hetzner" }),
    ).toBeInTheDocument();
    expect(within(alpha).getByRole("link", { name: "Open the project" })).toHaveAttribute(
      "href",
      `/projects/${ALPHA}`,
    );

    const beta = screen.getByRole("region", { name: "Beta" });
    expect(within(beta).getByText("Waiting for confirmation")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Readers of / })).not.toBeInTheDocument();
    expect(paths.some((p) => p.endsWith("/reveal"))).toBe(false);
  });

  it("in cima mostra gli accessi da confermare, quando ce ne sono", async () => {
    pendingItems = [
      {
        user: { id: "40000000-0000-4000-8000-000000000002", email: "bea@example.com" },
        personKey: {
          id: "50000000-0000-4000-8000-000000000002",
          status: "pending",
          createdAt: "2026-10-22T08:30:00.000Z",
          device: null,
          fingerprintSource: "non-una-chiave",
        },
        credentials: [],
      },
    ];
    renderPage();
    const panel = await screen.findByRole("region", { name: "Access to confirm" });
    expect(within(panel).getByRole("group", { name: "bea@example.com" })).toBeInTheDocument();
  });

  it("a cassaforte non attivata lo dice e non chiede l'elenco", async () => {
    vaultState.state = "inactive";
    renderPage();
    expect(
      await screen.findByText("The vault has not been activated on this instance yet."),
    ).toBeInTheDocument();
    expect(paths).not.toContain("GET /api/vault/credentials");
    expect(paths).not.toContain("GET /api/vault/pending");
  });
});
