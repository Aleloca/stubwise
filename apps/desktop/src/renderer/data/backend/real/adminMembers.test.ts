import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealMembers, type MembersApi } from "./adminMembers";

// Area 9, F1, R8: Members sulle letture calcolate del server.

const P = "11111111-1111-4111-8111-111111111111";
const MARCO = "33333333-3333-4333-8333-333333333333";
const DEV = "66666666-6666-4666-8666-666666666666";
const LEAD = "77777777-7777-4777-8777-777777777777";

const refusing = (status: number, code: string, details?: unknown) => async () => {
  throw new ApiError(status, code, code, { details: details ?? { code } });
};

function fakeApi(over: Partial<MembersApi> = {}) {
  const calls: string[] = [];
  const api: MembersApi = {
    view: async () => ({
      projectId: P,
      canManage: true,
      roleChoices: [{ roleId: DEV, name: "Developer", permissionCount: 9, missing: [] }],
      grantable: [{ permission: "servers.operate", allowed: true }],
      addable: [],
      addableMissing: {},
      members: [
        {
          personId: MARCO,
          name: "Marco Bellini",
          email: "marco@example.com",
          avatarUrl: null,
          status: "active",
          role: { id: DEV, name: "Developer", permissions: ["tickets.create"] },
          extra: [],
          granted: ["servers.operate"],
        },
      ],
    }),
    preview: async () => ({
      permissions: [
        {
          permission: "tickets.create",
          sources: [{ kind: "role", roleId: DEV, roleName: "Developer" }],
        },
        {
          permission: "release.merge",
          sources: [{ kind: "grant", grantedById: null, origin: "draft" }],
        },
      ],
      removing: [
        {
          permission: "servers.operate",
          source: {
            kind: "grant",
            grantedById: "u9",
            grantedByName: "Roberta",
            at: "2026-11-01T09:00:00.000Z",
            origin: "given",
          },
        },
      ],
      roleChoices: [],
      missing: ["release.merge"],
      block: null,
      removeBlock: "last_members_manager",
      viewerLoses: [],
    }),
    put: async (p, u, body) => {
      calls.push(`put ${u} ${JSON.stringify(body)}`);
    },
    remove: async (p, u) => {
      calls.push(`remove ${u}`);
    },
    ...over,
  };
  return { api, calls };
}

describe("Members dal server (area 9, R8)", () => {
  it("la vista: le iniziali, il ruolo nella forma del prototipo, i permessi dati a mano", async () => {
    const v = await createRealMembers(fakeApi().api).listProjectMembers(P);
    expect(v.canManage).toBe(true);
    expect(v.members[0]).toMatchObject({
      avatar: "MB",
      role: { id: DEV, name: "Developer", scope: "project", permissions: ["tickets.create"] },
      granted: ["servers.operate"],
    });
  });

  it("l'anteprima della bozza: fonti nell'unione del prototipo, ciò che si toglie, missing e blocchi dal server", async () => {
    const p = await createRealMembers(fakeApi().api).previewMember(P, MARCO, {
      roleId: DEV,
      granted: ["release.merge"],
    });
    expect(p.missing).toEqual(["release.merge"]);
    expect(p.removeBlock).toBe("last_members_manager");
    expect(p.permissions[1]!.sources[0]).toMatchObject({ kind: "grant", origin: "draft" });
    expect(p.removing[0]).toEqual({
      permission: "servers.operate",
      source: {
        kind: "grant",
        grantedById: "u9",
        grantedByName: "Roberta",
        at: "2026-11-01T09:00:00.000Z",
        origin: "given",
      },
    });
  });

  it("le scritture: salvare manda ruolo e permessi; il ruolo da solo li lascia; dare e togliere partono da quelli di adesso", async () => {
    const { api, calls } = fakeApi();
    const m = createRealMembers(api);
    expect(await m.saveMember(P, MARCO, { roleId: LEAD, granted: [] })).toEqual({ ok: true });
    expect(await m.setMemberRole(P, MARCO, LEAD)).toEqual({ ok: true });
    expect(await m.grantMemberPermission(P, MARCO, "release.merge")).toEqual({ ok: true });
    expect(await m.revokeMemberPermission(P, MARCO, "servers.operate")).toEqual({ ok: true });
    expect(await m.removeMember(P, MARCO)).toEqual({ ok: true });
    expect(calls).toEqual([
      `put ${MARCO} {"roleId":"${LEAD}","permissions":[]}`,
      `put ${MARCO} {"roleId":"${LEAD}"}`,
      `put ${MARCO} {"roleId":"${DEV}","permissions":["servers.operate","release.merge"]}`,
      `put ${MARCO} {"roleId":"${DEV}","permissions":[]}`,
      `remove ${MARCO}`,
    ]);
  });

  it("i rifiuti: l'ultimo gestore, l'escalation col permesso, la riconferma", async () => {
    const last = createRealMembers(fakeApi({ remove: refusing(409, "last_manager") }).api);
    expect(await last.removeMember(P, MARCO)).toEqual({
      ok: false,
      error: "invalid",
      reason: "last_members_manager",
    });
    const esc = createRealMembers(
      fakeApi({
        put: refusing(403, "escalation", { code: "escalation", permission: "release.merge" }),
      }).api,
    );
    expect(await esc.saveMember(P, MARCO, { roleId: DEV, granted: ["release.merge"] })).toEqual({
      ok: false,
      error: "escalation",
      missing: ["release.merge"],
    });
    const reauth = createRealMembers(fakeApi({ put: refusing(403, "reauth_required") }).api);
    expect(await reauth.addMember(P, MARCO, DEV)).toEqual({ ok: false, error: "reauth_required" });
  });
});
