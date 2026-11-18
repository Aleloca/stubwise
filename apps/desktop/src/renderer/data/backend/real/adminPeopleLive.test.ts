import { beforeEach, describe, expect, it, vi } from "vitest";

// I percorsi del collegamento vero di People, inviti e Roles (area 9, R7).

const request = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  id: "r",
  token: "t",
  expiresAt: "x",
  events: [],
}));
const { session, whatCan } = vi.hoisted(() => ({
  session: { personId: "me" as string | null },
  whatCan: vi.fn(async () => ({ instance: [], projects: [] })),
}));
vi.mock("./client", () => ({ appClient: () => ({ request, access: { whatCan } }), session }));

beforeEach(() => request.mockClear());

describe("People e Roles, i percorsi veri", () => {
  it("le scritture vanno sulle rotte di /api/users, /api/roles, /api/auth/invites e delle identità", async () => {
    const { liveAdminPeopleApiForTest: api } = await import("./adminPeople");
    await api.createInvite({ email: "n@example.com", instanceRoleId: "r1", projects: [] });
    await api.setInstanceRole("u1", "r1");
    await api.resetSecondFactor("u1");
    await api.securityEvents("u1");
    await api.observedAuthors();
    await api.linkGitIdentity("u1", "k@example.com");
    await api.unlinkGitIdentity("u1", "k@example.com");
    await api.setBitbucket("u1", "kev");
    await api.setBitbucket("u1", null);
    await api.createRole({ name: "R", scope: "project", permissions: [] });
    await api.duplicateRole("r1");
    await api.updateRole("r1", { name: "R2" });
    await api.deleteRole("r1");
    expect(request.mock.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual([
      "POST /api/auth/invites",
      "PATCH /api/users/u1/instance-role",
      "DELETE /api/users/u1/second-factor",
      "GET /api/users/u1/security-events",
      "GET /api/git/observed-authors",
      "POST /api/users/u1/git-identities",
      "DELETE /api/users/u1/git-identities/k%40example.com",
      "PUT /api/users/u1/bitbucket",
      "DELETE /api/users/u1/bitbucket",
      "POST /api/roles",
      "POST /api/roles/r1/duplicate",
      "PATCH /api/roles/r1",
      "DELETE /api/roles/r1",
    ]);
  });

  it("cosa perde chi guarda: i permessi di chi è in sessione; senza sessione nessuna chiamata con userId vuoto (review F1, M1)", async () => {
    const { liveAdminPeopleApiForTest: api } = await import("./adminPeople");
    session.personId = "me";
    await api.myPermissions();
    expect(whatCan).toHaveBeenCalledWith({ userId: "me" });
    whatCan.mockClear();
    session.personId = null;
    await expect(api.myPermissions()).rejects.toThrow("no_session");
    expect(whatCan).not.toHaveBeenCalled();
    session.personId = "me";
  });
});
