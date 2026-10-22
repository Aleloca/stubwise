import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "../../lib/api";
import { createAppRouter } from "../../router";
import { FULL_ADMIN_PERMISSIONS, legacyMemberPermissions } from "../../test/me";

/**
 * Impostazioni → Ruoli (`/settings/roles`) col router vero e fetch mockata:
 * elenco per tipo, crea/modifica/duplica/elimina, e gli errori del server
 * (ruolo in uso, ultimo full admin, preset di sistema, anti-escalation) detti
 * in chiaro. Senza `roles.manage` la rotta e la voce di menu non ci sono.
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

function role(overrides: Partial<Role> & Pick<Role, "id" | "name" | "scope">): Role {
  return {
    permissions: [],
    presetKey: null,
    assignmentCount: 0,
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-22T10:00:00.000Z",
    ...overrides,
  };
}

const ADMIN_ROLE = role({
  id: "10000000-0000-4000-8000-000000000001",
  name: "Admin",
  scope: "instance",
  presetKey: "admin",
  permissions: ["instance.full_admin"],
  assignmentCount: 1,
});
const LEAD_ROLE = role({
  id: "10000000-0000-4000-8000-000000000002",
  name: "Project Lead",
  scope: "project",
  presetKey: "project_lead",
  permissions: ["project.members.manage", "plans.approve"],
  assignmentCount: 3,
});
const QA_ROLE = role({
  id: "10000000-0000-4000-8000-000000000003",
  name: "QA",
  scope: "project",
  permissions: ["tickets.create"],
});

const ROLES = [ADMIN_ROLE, LEAD_ROLE, QA_ROLE];

const ME_ADMIN = () =>
  jsonResponse(200, {
    user: { id: "u1", email: "ada@example.com", role: "admin", language: "en" },
    ...FULL_ADMIN_PERMISSIONS,
  });

function renderApp(path = "/settings/roles") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function bodyOf(init?: RequestInit): unknown {
  return JSON.parse(String(init?.body));
}

describe("Impostazioni — ruoli", () => {
  it("elenca i ruoli divisi per tipo, con preset e assegnazioni", async () => {
    mockApi({ "GET /api/auth/me": ME_ADMIN, "GET /api/roles": () => jsonResponse(200, ROLES) });
    renderApp();

    const instance = await screen.findByRole("region", { name: "Instance roles" });
    const project = screen.getByRole("region", { name: "Project roles" });
    expect(within(instance).getByText("Admin")).toBeInTheDocument();
    expect(within(instance).queryByText("QA")).not.toBeInTheDocument();
    const lead = within(project).getByRole("listitem", { name: "Project Lead" });
    expect(within(lead).getByText("preset")).toBeInTheDocument();
    expect(within(lead).getByText(/2 permissions · 3 memberships/)).toBeInTheDocument();
    expect(within(project).getByText("QA")).toBeInTheDocument();
    // Voce di menu presente per chi ha roles.manage.
    expect(screen.getByRole("link", { name: "Roles" })).toHaveAttribute("href", "/settings/roles");
  });

  it("crea un ruolo di progetto con i permessi scelti fra le caselle raggruppate", async () => {
    const user = userEvent.setup();
    let posted: unknown;
    mockApi({
      "GET /api/auth/me": ME_ADMIN,
      "GET /api/roles": () => jsonResponse(200, ROLES),
      "POST /api/roles": (_url, init) => {
        posted = bodyOf(init);
        return jsonResponse(201, role({ id: "10000000-0000-4000-8000-000000000009", name: "Reviewer", scope: "project" }));
      },
    });
    renderApp();

    await user.click(await screen.findByRole("button", { name: "+ New project role" }));
    const project = screen.getByRole("region", { name: "Project roles" });
    await user.type(within(project).getByLabelText("Name"), "Reviewer");
    // Gruppi per area, etichette i18n; nessuna chiave d'istanza fra quelle di progetto.
    const runs = within(project).getByRole("group", { name: "AI runs and releases" });
    await user.click(within(runs).getByLabelText("Approve plans"));
    await user.click(within(project).getByLabelText("View docs"));
    expect(within(project).queryByLabelText("Full administration")).not.toBeInTheDocument();
    await user.click(within(project).getByRole("button", { name: "Save role" }));

    await waitFor(() =>
      expect(posted).toEqual({
        name: "Reviewer",
        scope: "project",
        permissions: ["plans.approve", "docs.view"],
      }),
    );
  });

  it("modifica nome e permessi con una PATCH; l'escalation è detta col nome del permesso", async () => {
    const user = userEvent.setup();
    let patched: unknown;
    mockApi({
      "GET /api/auth/me": ME_ADMIN,
      "GET /api/roles": () => jsonResponse(200, ROLES),
      [`PATCH /api/roles/${QA_ROLE.id}`]: (_url, init) => {
        patched = bodyOf(init);
        // Il codice decide, non il testo: il message qui è apposta diverso.
        return jsonResponse(403, {
          code: "escalation",
          message: "nope",
          permission: "release.merge",
        });
      },
    });
    renderApp();

    await user.click(await screen.findByRole("button", { name: "Edit role QA" }));
    const row = screen.getByRole("listitem", { name: "QA" });
    const name = within(row).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "QA team");
    await user.click(within(row).getByLabelText("Create tickets"));
    await user.click(within(row).getByLabelText("Merge pull requests"));
    await user.click(within(row).getByRole("button", { name: "Save role" }));

    await waitFor(() =>
      expect(patched).toEqual({ name: "QA team", permissions: ["release.merge"] }),
    );
    expect(
      await within(row).findByText(
        "You cannot grant a permission you don't have: «Merge pull requests».",
      ),
    ).toBeInTheDocument();
  });

  it("il full admin di un ruolo d'istanza spiega che comprende tutto; last_full_admin in chiaro", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/me": ME_ADMIN,
      "GET /api/roles": () => jsonResponse(200, ROLES),
      [`PATCH /api/roles/${ADMIN_ROLE.id}`]: () =>
        jsonResponse(409, { code: "last_full_admin", message: "At least one" }),
    });
    renderApp();

    await user.click(await screen.findByRole("button", { name: "Edit role Admin" }));
    const row = screen.getByRole("listitem", { name: "Admin" });
    expect(within(row).getByText(/includes every permission/)).toBeInTheDocument();
    await user.click(within(row).getByLabelText("Full administration"));
    expect(within(row).queryByText(/includes every permission/)).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Save role" }));

    expect(
      await within(row).findByText("At least one user must keep full administration."),
    ).toBeInTheDocument();
  });

  it("duplica un ruolo", async () => {
    const user = userEvent.setup();
    let duplicated = false;
    mockApi({
      "GET /api/auth/me": ME_ADMIN,
      "GET /api/roles": () => jsonResponse(200, ROLES),
      [`POST /api/roles/${LEAD_ROLE.id}/duplicate`]: () => {
        duplicated = true;
        return jsonResponse(201, { ...LEAD_ROLE, id: "10000000-0000-4000-8000-00000000000a", name: "Project Lead (copy)", presetKey: null });
      },
    });
    renderApp();

    await user.click(await screen.findByRole("button", { name: "Duplicate role Project Lead" }));
    await waitFor(() => expect(duplicated).toBe(true));
  });

  it("Admin/User non hanno Elimina (R9) e un ruolo in uso lo ha spento, col motivo", async () => {
    mockApi({ "GET /api/auth/me": ME_ADMIN, "GET /api/roles": () => jsonResponse(200, ROLES) });
    renderApp();

    const admin = await screen.findByRole("listitem", { name: "Admin" });
    expect(within(admin).queryByRole("button", { name: "Delete role Admin" })).toBeNull();
    expect(within(admin).getByText(/can be renamed or its permissions changed/)).toBeInTheDocument();
    // Rinominare e modificare restano possibili.
    expect(within(admin).getByRole("button", { name: "Edit role Admin" })).toBeEnabled();

    const lead = screen.getByRole("listitem", { name: "Project Lead" });
    expect(within(lead).getByRole("button", { name: "Delete role Project Lead" })).toBeDisabled();
    expect(
      within(lead).getByText("// assigned to 3 people: move them to another role before deleting"),
    ).toBeInTheDocument();
  });

  it("se il conteggio è vecchio, il 409 role_in_use del server resta la rete: dice quante persone", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/me": ME_ADMIN,
      "GET /api/roles": () => jsonResponse(200, ROLES),
      [`DELETE /api/roles/${QA_ROLE.id}`]: () =>
        jsonResponse(409, { code: "role_in_use", message: "The role is still assigned", count: 2 }),
    });
    renderApp();

    await user.click(await screen.findByRole("button", { name: "Delete role QA" }));
    await user.click(screen.getByRole("button", { name: "Confirm deleting role QA" }));
    const qa = screen.getByRole("listitem", { name: "QA" });
    expect(
      await within(qa).findByText(
        "The role is still assigned to 2 people: move them to another role first.",
      ),
    ).toBeInTheDocument();
  });

  it("senza roles.manage: niente voce di menu, e la rotta torna ad Account", async () => {
    mockApi({
      "GET /api/auth/me": () =>
        jsonResponse(200, {
          user: { id: "u2", email: "bea@example.com", role: "member", language: "en" },
          ...legacyMemberPermissions(),
        }),
      "GET /api/auth/me/password": () => jsonResponse(200, { hasPassword: true }),
    });
    const router = renderApp();

    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/account"));
    expect(screen.queryByRole("link", { name: "Roles" })).not.toBeInTheDocument();
  });
});
