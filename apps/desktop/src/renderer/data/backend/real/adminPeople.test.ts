import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealAdminPeople, type AdminPeopleApi } from "./adminPeople";

// Area 9, F1, R7: People, inviti e Roles sulle letture calcolate del server.

const MARCO = "33333333-3333-4333-8333-333333333333";
const ROLE = "66666666-6666-4666-8666-666666666666";

const refusing = (status: number, code: string, details?: unknown) => async () => {
  throw new ApiError(status, code, code, { details: details ?? { code } });
};

function fakeApi(over: Partial<AdminPeopleApi> = {}) {
  const calls: string[] = [];
  const log = (s: string) => async () => {
    calls.push(s);
  };
  const api: AdminPeopleApi = {
    people: async () => [
      {
        personId: MARCO,
        name: "Marco Bellini",
        email: "marco@example.com",
        avatarUrl: null,
        instanceRole: { id: ROLE, name: "User" },
        departments: [{ id: "d1", name: "Dev", colorToken: "--dept-1" }],
        projects: [{ code: "ACQ", role: "Developer" }],
        status: "active",
        deactivatedAt: null,
        invite: null,
      },
      {
        personId: "i_abc",
        name: "",
        email: "nora@example.com",
        avatarUrl: null,
        instanceRole: null,
        departments: [],
        projects: [],
        status: "invited",
        deactivatedAt: null,
        invite: {
          id: "i_abc",
          expiresAt: "2026-11-23T09:00:00.000Z",
          expired: false,
          invitedByName: null,
        },
      },
    ],
    person: async () => ({
      personId: MARCO,
      name: "Marco Bellini",
      email: "marco@example.com",
      avatarUrl: null,
      projects: [
        {
          projectId: "p1",
          code: "ACQ",
          name: "Acquedotto",
          role: { id: ROLE, name: "Developer" },
          extra: [
            {
              permission: "servers.operate",
              granted: true,
              sources: [
                {
                  kind: "grant",
                  roleId: null,
                  roleName: null,
                  grantedById: "u9",
                  grantedByName: "Roberta",
                  at: "2026-11-01T09:00:00.000Z",
                  origin: "given",
                  departmentId: null,
                  departmentName: null,
                },
              ],
            },
          ],
          canManage: true,
        },
      ],
      actions: { setInstanceRole: null, resetPassword: null, changeEmail: "self" },
    }),
    roles: async () => [
      {
        id: ROLE,
        name: "Developer",
        scope: "project",
        permissions: ["tickets.create"],
        presetKey: "developer",
        reach: "anywhere",
      },
      {
        id: "r-custom",
        name: "Release",
        scope: "project",
        permissions: ["release.merge"],
        presetKey: null,
        reach: "anywhere",
      },
    ],
    invites: async () => [],
    inviteChoices: async () => ({ instanceRoles: [], defaultInstanceRoleId: ROLE, projects: [] }),
    revokeInvite: log("revoke"),
    createInvite: async () => ({ token: "tok123", expiresAt: "2026-11-23T09:00:00.000Z" }),
    setInstanceRole: log("role"),
    passwordReset: async () => ({ token: "rst456", expiresAt: "2026-11-17T09:00:00.000Z" }),
    resetSecondFactor: log("2fa"),
    deactivate: async (id, reassign) => {
      calls.push(`deactivate ${id} ${JSON.stringify(reassign)}`);
    },
    reactivate: log("reactivate"),
    changeEmail: log("email"),
    securityEvents: async () => ({
      events: [
        { id: "e1", kind: "login", actorEmail: null, createdAt: "2026-11-16T09:00:00.000Z" },
      ],
    }),
    observedAuthors: async () => [
      {
        email: "kevin@example.com",
        authorName: "Kevin",
        lastSeenAt: "2026-11-15T09:00:00.000Z",
        linkedUserId: null,
      },
      {
        email: "marco@example.com",
        authorName: "Marco",
        lastSeenAt: "2026-11-15T09:00:00.000Z",
        linkedUserId: MARCO,
      },
    ],
    linkGitIdentity: log("link"),
    unlinkGitIdentity: log("unlink"),
    setBitbucket: async (id, username) => {
      calls.push(`bitbucket ${username}`);
    },
    createRole: async (body) => {
      calls.push(`create ${JSON.stringify(body)}`);
      return { id: "r-new" };
    },
    duplicateRole: async () => ({ id: "r-copy" }),
    updateRole: log("update"),
    deleteRole: log("delete"),
    myPermissions: async () => ({
      instance: [],
      projects: [
        {
          permissions: [
            { permission: "tickets.create", reasons: [{ kind: "role", roleId: ROLE }] },
            {
              permission: "release.merge",
              reasons: [
                { kind: "role", roleId: ROLE },
                { kind: "grant", roleId: null },
              ],
            },
          ],
        },
      ],
    }),
    origin: async () => "https://stubwise.acme.test",
    ...over,
  };
  return { api, calls };
}

describe("People, inviti e Roles dal server (area 9, R7)", () => {
  it("l'elenco: le iniziali per l'avatar, l'invito con l'id opaco; il filtro nel client", async () => {
    const people = createRealAdminPeople(fakeApi().api);
    const rows = await people.listPeople();
    expect(rows.map((r) => [r.personId, r.avatar, r.status])).toEqual([
      [MARCO, "MB", "active"],
      ["i_abc", "N", "invited"],
    ]);
    expect(rows[1]!.invite!.invitedByName).toBe("");
    expect((await people.listPeople({ q: "nora" })).map((r) => r.personId)).toEqual(["i_abc"]);
    expect((await people.listPeople({ statuses: ["active"] })).map((r) => r.personId)).toEqual([
      MARCO,
    ]);
  });

  it("la pagina della persona: le fonti piatte del server diventano l'unione del prototipo; azioni dal server", async () => {
    const d = await createRealAdminPeople(fakeApi().api).getPerson(MARCO);
    expect(d.avatar).toBe("MB");
    expect(d.actions.changeEmail).toBe("self");
    expect(d.projects[0]!.extra[0]).toEqual({
      permission: "servers.operate",
      granted: true,
      sources: [
        {
          kind: "grant",
          grantedById: "u9",
          grantedByName: "Roberta",
          at: "2026-11-01T09:00:00.000Z",
          origin: "given",
        },
      ],
    });
    const hidden = createRealAdminPeople(fakeApi({ person: refusing(404, "not_found") }).api);
    await expect(hidden.getPerson(MARCO)).rejects.toThrow("not_found");
  });

  it("i link di reset e d'invito puntano alla web «app» col token; l'id dell'invito è opaco", async () => {
    const people = createRealAdminPeople(fakeApi().api);
    expect(await people.createPasswordResetLink(MARCO)).toEqual({
      ok: true,
      link: "https://stubwise.acme.test/app/#/reset-password/rst456",
      expiresAt: "2026-11-17T09:00:00.000Z",
    });
    const r = await people.createInvite({
      email: "nora@example.com",
      instanceRoleId: ROLE,
      projects: [],
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.link).toBe("https://stubwise.acme.test/app/#/register/tok123");
    expect(r.inviteId).toMatch(/^i_[0-9a-f]{32}$/);
    expect(r.inviteId).not.toContain("tok123");
  });

  it("i rifiuti del server nelle parole del prototipo: escalation col permesso, riconferma, regole", async () => {
    const esc = createRealAdminPeople(
      fakeApi({
        setInstanceRole: refusing(403, "escalation", {
          code: "escalation",
          permission: "users.manage",
        }),
      }).api,
    );
    expect(await esc.setInstanceRole(MARCO, ROLE)).toEqual({
      ok: false,
      error: "escalation",
      missing: ["users.manage"],
    });
    const reauth = createRealAdminPeople(
      fakeApi({ resetSecondFactor: refusing(403, "reauth_required") }).api,
    );
    expect(await reauth.resetSecondFactor(MARCO)).toEqual({ ok: false, error: "reauth_required" });
    const inUse = createRealAdminPeople(fakeApi({ deleteRole: refusing(409, "in_use") }).api);
    expect(await inUse.deleteRole(ROLE)).toEqual({ ok: false, error: "invalid", reason: "in_use" });
    const self = createRealAdminPeople(
      fakeApi({ changeEmail: refusing(400, "cannot_change_own_email") }).api,
    );
    expect(await self.changeEmail(MARCO, "x@example.com")).toEqual({
      ok: false,
      error: "invalid",
      reason: "self",
    });
  });

  it("disattivare: quante task spostate dalle righe; una riga non valida col suo id", async () => {
    const { api, calls } = fakeApi();
    expect(
      await createRealAdminPeople(api).deactivatePerson(MARCO, { t1: "u2", t2: null }),
    ).toEqual({
      ok: true,
      reassigned: 1,
    });
    expect(calls).toEqual([`deactivate ${MARCO} {"t1":"u2","t2":null}`]);
    const bad = createRealAdminPeople(
      fakeApi({
        deactivate: refusing(422, "invalid_reassignment", {
          code: "invalid_reassignment",
          taskId: "t1",
        }),
      }).api,
    );
    expect(await bad.deactivatePerson(MARCO, { t1: "u2" })).toEqual({
      ok: false,
      error: "invalid",
      reason: "invalid_reassignment",
      taskId: "t1",
    });
  });

  it("i ruoli: chiave e preset dal presetKey; cosa perde chi guarda viene dalle fonti del server", async () => {
    const people = createRealAdminPeople(fakeApi().api);
    const roles = await people.listRoles();
    expect(roles.map((r) => [r.key, r.preset])).toEqual([
      ["developer", true],
      ["r-custom", false],
    ]);
    // tickets.create gli viene solo da quel ruolo; release.merge anche da una concessione.
    expect(await people.viewerLosesIf(ROLE, [])).toEqual(["tickets.create"]);
    expect(await people.viewerLosesIf(ROLE, ["tickets.create"])).toEqual([]);
  });

  it("autori osservati: solo quelli non collegati; registro di sicurezza coi tipi del prototipo", async () => {
    const people = createRealAdminPeople(fakeApi().api);
    expect((await people.listObservedAuthors()).map((a) => a.name)).toEqual(["kevin@example.com"]);
    expect((await people.listSecurityEvents(MARCO))[0]).toMatchObject({
      kind: "signed_in",
      personId: MARCO,
    });
  });
});
