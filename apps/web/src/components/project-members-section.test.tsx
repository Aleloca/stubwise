import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMember, Role } from "../lib/api";
import { seedMe } from "../test/me";
import { ProjectMembersSection } from "./project-members-section";

/**
 * Sezione «Membri» del dettaglio progetto: l'elenco lo vede ogni membro; con
 * `project.members.manage` NEL PROGETTO si aggiunge, si cambia ruolo e si
 * toglie, e gli errori del server (anti-escalation, bersaglio protetto) si
 * leggono in chiaro sulla riga.
 */

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";

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

function projectRole(id: string, name: string): Role {
  return {
    id,
    name,
    scope: "project",
    permissions: [],
    presetKey: null,
    assignmentCount: 1,
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-22T10:00:00.000Z",
  };
}

const LEAD = projectRole("30000000-0000-4000-8000-000000000001", "Project Lead");
const DEV = projectRole("30000000-0000-4000-8000-000000000002", "Developer");

const BEA: ProjectMember = {
  userId: "40000000-0000-4000-8000-000000000002",
  email: "bea@example.com",
  avatarUrl: null,
  roleId: DEV.id,
  roleName: "Developer",
  createdAt: "2026-10-22T10:00:00.000Z",
};

const USERS = [
  { id: "40000000-0000-4000-8000-000000000001", email: "ada@example.com" },
  { id: BEA.userId, email: "bea@example.com" },
  { id: "40000000-0000-4000-8000-000000000003", email: "carl@example.com" },
].map((u) => ({
  ...u,
  role: "member",
  avatarUrl: null,
  slackUserId: null,
  bitbucketUsername: null,
  gitIdentities: [],
  createdAt: "2026-10-01T10:00:00.000Z",
}));

const membersPath = `/api/projects/${PROJECT_ID}/members`;

function renderSection(projectPermissions: Record<string, string[]>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedMe(queryClient, { instancePermissions: ["users.view_all"], projectPermissions });
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectMembersSection projectId={PROJECT_ID} />
    </QueryClientProvider>,
  );
}

function bodyOf(init?: RequestInit): unknown {
  return JSON.parse(String(init?.body));
}

describe("sezione Membri del progetto", () => {
  it("un membro senza project.members.manage vede l'elenco in sola lettura (e non chiede i ruoli)", async () => {
    mockApi({ [`GET ${membersPath}`]: () => jsonResponse(200, [BEA]) });
    // Gestisce i membri di UN ALTRO progetto: qui non conta.
    renderSection({ [PROJECT_ID]: ["docs.view"], [OTHER_PROJECT]: ["project.members.manage"] });

    const row = await screen.findByRole("listitem", { name: "bea@example.com" });
    expect(within(row).getByText("Developer")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Add a member" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContainEqual(
      expect.stringContaining("/api/roles"),
    );
  });

  it("chi gestisce i membri cambia ruolo, toglie e aggiunge", async () => {
    const user = userEvent.setup();
    const puts: { path: string; body: unknown }[] = [];
    let deleted: string | null = null;
    mockApi({
      [`GET ${membersPath}`]: () => jsonResponse(200, [BEA]),
      "GET /api/roles": (url) => {
        expect(url.searchParams.get("scope")).toBe("project");
        return jsonResponse(200, [LEAD, DEV]);
      },
      "GET /api/users": () => jsonResponse(200, USERS),
      [`PUT ${membersPath}/${BEA.userId}`]: (url, init) => {
        puts.push({ path: url.pathname, body: bodyOf(init) });
        return jsonResponse(200, { ...BEA, roleId: LEAD.id, roleName: LEAD.name });
      },
      [`PUT ${membersPath}/${USERS[2]!.id}`]: (url, init) => {
        puts.push({ path: url.pathname, body: bodyOf(init) });
        return jsonResponse(200, { ...BEA, userId: USERS[2]!.id, email: "carl@example.com" });
      },
      [`DELETE ${membersPath}/${BEA.userId}`]: (url) => {
        deleted = url.pathname;
        return jsonResponse(204, null);
      },
    });
    renderSection({ [PROJECT_ID]: ["project.members.manage"] });

    const roleSelect = await screen.findByRole("combobox", {
      name: "Role of bea@example.com in this project",
    });
    await user.selectOptions(roleSelect, LEAD.id);
    await waitFor(() => expect(puts[0]?.body).toEqual({ roleId: LEAD.id }));

    await user.click(screen.getByRole("button", { name: "Remove bea@example.com from the project" }));
    await user.click(screen.getByRole("button", { name: "Confirm removing bea@example.com" }));
    await waitFor(() => expect(deleted).toBe(`${membersPath}/${BEA.userId}`));

    const form = screen.getByRole("form", { name: "Add a member" });
    const userSelect = within(form).getByLabelText("User") as HTMLSelectElement;
    // I membri attuali non si ripropongono.
    await waitFor(() =>
      expect([...userSelect.options].map((o) => o.textContent)).toContain("carl@example.com"),
    );
    expect([...userSelect.options].map((o) => o.textContent)).not.toContain("bea@example.com");
    const addButton = within(form).getByRole("button", { name: "Add member" });
    expect(addButton).toBeDisabled();
    await user.selectOptions(userSelect, USERS[2]!.id);
    await user.selectOptions(within(form).getByLabelText("Role"), DEV.id);
    await user.click(addButton);
    await waitFor(() =>
      expect(puts[1]).toEqual({ path: `${membersPath}/${USERS[2]!.id}`, body: { roleId: DEV.id } }),
    );
  });

  it("l'errore del server (bersaglio con più permessi) si legge in chiaro sulla riga", async () => {
    const user = userEvent.setup();
    mockApi({
      [`GET ${membersPath}`]: () => jsonResponse(200, [BEA]),
      "GET /api/roles": () => jsonResponse(200, [LEAD, DEV]),
      "GET /api/users": () => jsonResponse(200, USERS),
      [`PUT ${membersPath}/${BEA.userId}`]: () =>
        jsonResponse(403, {
          code: "target_above",
          message: "nope",
          permission: "release.merge",
        }),
    });
    renderSection({ [PROJECT_ID]: ["project.members.manage"] });

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Role of bea@example.com in this project" }),
      LEAD.id,
    );
    const row = screen.getByRole("listitem", { name: "bea@example.com" });
    expect(
      await within(row).findByText(
        "You cannot change someone with more permissions than you: «Merge pull requests».",
      ),
    ).toBeInTheDocument();
  });
});
