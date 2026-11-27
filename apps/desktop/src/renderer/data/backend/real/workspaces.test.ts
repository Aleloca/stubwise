import { ApiError } from "@stubwise/api-client";
import { describe, expect, it, vi } from "vitest";
import { createRealWorkspaces, type WorkspacesApi } from "./workspaces";

// L'adattatore delle workspace sulle rotte `/api/workspaces` (lotto 3 di 54):
// le viste del server nelle forme del prototipo, l'effetto coi codici, i
// rifiuti come quelli del prototipo.

const W1 = "11111111-1111-4111-8111-111111111111";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const P2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const P3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const NICOLA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const MARCO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const VIEWER = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const DEV = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const IRENE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
const SARA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";

const view = {
  id: W1,
  name: "Clienti storici",
  colorToken: "--dept-1",
  projectIds: [P1, P2],
  people: [
    { userId: NICOLA, name: "Nicola Orlando", roleId: VIEWER, roleName: "Viewer", email: "nicola@example.com", status: "deactivated" },
    { userId: MARCO, name: "Marco Bellini", roleId: DEV, roleName: "Developer" },
  ],
  isMember: false,
  canManage: true,
  canManagePeople: true,
};

const fail = (status: number, code: string, details?: unknown) => () => {
  throw new ApiError(status, code, code, { details: details ?? { code } });
};

function fakeApi(overrides: Partial<WorkspacesApi> = {}): WorkspacesApi {
  return {
    list: vi.fn(async () => ({ items: [view], canManage: true })),
    get: vi.fn(async () => view),
    create: vi.fn(async () => ({ ...view, id: "new-id" })),
    update: vi.fn(async () => view),
    remove: vi.fn(async () => undefined),
    putProject: vi.fn(async () => view),
    removeProject: vi.fn(async () => undefined),
    previewMember: vi.fn(async () => ({ projects: [], escalation: [], lastManager: { blocked: false, projectId: null }, block: null })),
    putMember: vi.fn(async () => view),
    removeMember: vi.fn(async () => undefined),
    effect: vi.fn(async () => ({ projects: [], lastManager: [], escalation: [] })),
    candidates: vi.fn(async () => ({
      candidates: [
        { userId: IRENE, name: "Irene Caruso", email: "irene@example.com", missing: [] },
        { userId: SARA, name: "Sara Montanari", email: "sara@example.com", missing: ["support.manage"] },
      ],
      roles: [
        { roleId: VIEWER, name: "Viewer", missing: [] },
        { roleId: DEV, name: "Developer", missing: ["release.merge"] },
      ],
      defaultRoleId: VIEWER,
    })),
    membersView: vi.fn(async (projectId: string) => ({
      members: [
        ...(projectId === P1 ? [{ personId: MARCO, name: "Marco Bellini", status: "active", role: { id: DEV, name: "Developer" } }] : []),
        // Dal lotto 4 la vista ha anche chi vede il progetto SOLO dalla workspace:
        // `explicit: false`, col ruolo di workspace. Non è un ruolo per progetto.
        { personId: NICOLA, name: "Nicola Orlando", status: "active", role: { id: VIEWER, name: "Viewer" }, explicit: false },
      ],
      roleChoices: [
        { roleId: VIEWER, name: "Viewer", permissionCount: 5, missing: [] },
        { roleId: DEV, name: "Developer", permissionCount: 24, missing: projectId === P2 ? ["release.merge"] : [] },
      ],
    })),
    projects: vi.fn(async () => [
      { id: P1, code: "ORT", name: "Ortofrutta" },
      { id: P2, code: "SPZ", name: "Spezieria" },
      { id: P3, code: "MKX", name: "Mix" },
    ]),
    ...overrides,
  };
}

describe("le letture", () => {
  it("l'elenco: lo slug è l'id, i conteggi dei progetti visibili, No workspace e la mappa dei progetti", async () => {
    const list = await createRealWorkspaces(fakeApi()).listWorkspaces();
    expect(list.workspaces).toEqual([{ id: W1, slug: W1, name: "Clienti storici", projectCount: 2, isMember: false }]);
    expect(list.noWorkspaceCount).toBe(1);
    expect(list.workspaceOfProject).toEqual({ [P1]: W1, [P2]: W1 });
    expect(list.canManage).toBe(true);
  });

  it("People: il ruolo di workspace, i ruoli per progetto dalla vista dei membri, le scelte con l'escalation del server", async () => {
    const v = await createRealWorkspaces(fakeApi()).listWorkspaceMembers(W1);
    const marco = v.members.find((m) => m.personId === MARCO)!;
    expect(marco.roleName).toBe("Developer");
    expect(marco.projectRoles).toEqual([{ projectId: P1, code: "ORT", roleName: "Developer" }]);
    expect(v.members.find((m) => m.personId === NICOLA)!.projectRoles).toEqual([]);
    const dev = v.roleChoices.find((c) => c.roleId === DEV)!;
    expect(dev).toMatchObject({ missing: ["release.merge"], missingIn: ["SPZ"] });
    expect(v.defaultRoleId).toBe(VIEWER);
    expect(v.canManage).toBe(true);
  });
});

describe("l'effetto", () => {
  it("i kind del prototipo diventano quelli del server; codici al posto degli id; l'escalation per progetto", async () => {
    const effect = vi.fn(async (body: { kind: string }) =>
      body.kind === "deleteWorkspace"
        ? {
            projects: [{ projectId: P1, startSeeing: [], stopSeeing: [{ userId: NICOLA, name: "Nicola Orlando" }] }],
            lastManager: [P2],
            escalation: [{ projectId: P2, permission: "release.merge" }],
          }
        : { projects: [], lastManager: [], escalation: [] },
    );
    const real = createRealWorkspaces(fakeApi({ effect }));
    const e = await real.previewWorkspace({ kind: "delete", workspaceId: W1 });
    expect(effect).toHaveBeenCalledWith({ kind: "deleteWorkspace", workspaceId: W1 });
    expect(e.projects[0]).toMatchObject({ code: "ORT", stopSeeing: [{ personId: NICOLA, name: "Nicola Orlando" }] });
    expect(e.lastManager).toEqual(["SPZ"]);
    expect(e.escalation).toEqual([{ code: "SPZ", missing: ["release.merge"] }]);
  });

  it("«Add projects…»: un effetto per progetto, sommati", async () => {
    const effect = vi.fn(async (body: { projectId?: string }) => ({
      projects: [{ projectId: body.projectId, startSeeing: [{ userId: NICOLA, name: "Nicola Orlando" }], stopSeeing: [] }],
      lastManager: [],
      escalation: [],
    }));
    const e = await createRealWorkspaces(fakeApi({ effect })).previewWorkspace({
      kind: "addProjects",
      workspaceId: W1,
      projectIds: [P3, P2],
    });
    expect(effect).toHaveBeenCalledTimes(2);
    expect(e.projects.map((p) => p.code)).toEqual(["MKX", "SPZ"]);
  });

  it("invitare: l'anteprima del membro; dove guadagna qualcosa, comincia a vedere", async () => {
    const previewMember = vi.fn(async () => ({
      projects: [
        { projectId: P1, gains: ["docs.view"] },
        { projectId: P2, gains: [] },
      ],
      escalation: [],
      lastManager: { blocked: false, projectId: null },
      block: null,
    }));
    const e = await createRealWorkspaces(fakeApi({ previewMember })).previewWorkspace({
      kind: "addMember",
      workspaceId: W1,
      personId: NICOLA,
      roleId: VIEWER,
    });
    expect(previewMember).toHaveBeenCalledWith(W1, NICOLA, { roleId: VIEWER });
    expect(e.projects.map((p) => [p.code, p.startSeeing.map((x) => x.personId)])).toEqual([["ORT", [NICOLA]]]);
  });
});

describe("le scritture", () => {
  it("togliere un progetto: il DELETE sulla sua workspace di adesso", async () => {
    const api = fakeApi();
    expect(await createRealWorkspaces(api).setProjectWorkspace(P1, null)).toEqual({ ok: true });
    expect(api.removeProject).toHaveBeenCalledWith(W1, P1);
  });

  it("i rifiuti del server come quelli del prototipo: riconferma, escalation, last_manager", async () => {
    const real = (o: Partial<WorkspacesApi>) => createRealWorkspaces(fakeApi(o));
    expect(await real({ putMember: fail(403, "reauth_required") as never }).addWorkspaceMember(W1, NICOLA)).toEqual({
      ok: false,
      error: "reauth_required",
    });
    expect(
      await real({ putMember: fail(403, "escalation", { code: "escalation", missing: ["release.merge"] }) as never }).setWorkspaceMemberRole(W1, NICOLA, DEV),
    ).toEqual({ ok: false, error: "escalation", missing: ["release.merge"] });
    expect(await real({ removeMember: fail(409, "last_manager") as never }).removeWorkspaceMember(W1, MARCO)).toEqual({
      ok: false,
      error: "invalid",
      reason: "last_manager",
    });
  });

  it("D12 e D3 passano come il server li vuole: alsoProjects, nessun roleId per Viewer", async () => {
    const api = fakeApi();
    const real = createRealWorkspaces(api);
    await real.removeWorkspaceMember(W1, MARCO, true);
    expect(api.removeMember).toHaveBeenCalledWith(W1, MARCO, true);
    await real.addWorkspaceMember(W1, NICOLA);
    expect(api.putMember).toHaveBeenCalledWith(W1, NICOLA, {});
    expect(await real.createWorkspace("  Nuova ", [P3])).toEqual({ ok: true, slug: "new-id" });
    expect(api.create).toHaveBeenCalledWith({ name: "Nuova", projectIds: [P3] });
  });
});

describe("i tre limiti chiusi (lotto 5 di 54)", () => {
  it("People: email e stato dalla vista, i candidati dal server col reparto che manca, Viewer di base", async () => {
    const v = await createRealWorkspaces(fakeApi()).listWorkspaceMembers(W1);
    expect(v.members.find((m) => m.personId === NICOLA)).toMatchObject({ email: "nicola@example.com", status: "deactivated" });
    expect(v.addable).toEqual([
      { personId: IRENE, name: "Irene Caruso", missing: [] },
      { personId: SARA, name: "Sara Montanari", missing: ["support.manage"] },
    ]);
    expect(v.defaultRoleId).toBe(VIEWER);
    expect(v.roleChoices.find((c) => c.roleId === DEV)!.missing).toContain("release.merge");
  });

  it("chi non gestisce le persone: nessuna chiamata ai candidati, nessun candidato", async () => {
    const api = fakeApi({ get: vi.fn(async () => ({ ...view, canManagePeople: false })) });
    const v = await createRealWorkspaces(api).listWorkspaceMembers(W1);
    expect(api.candidates).not.toHaveBeenCalled();
    expect(v.addable).toEqual([]);
  });

  it("l'effetto di una workspace nuova: kind create coi progetti; senza progetti nessuna chiamata", async () => {
    const effect = vi.fn(async () => ({
      projects: [{ projectId: P1, startSeeing: [], stopSeeing: [{ userId: NICOLA, name: "Nicola Orlando" }] }],
      lastManager: [],
      escalation: [],
    }));
    const real = createRealWorkspaces(fakeApi({ effect }));
    const e = await real.previewWorkspace({ kind: "create", projectIds: [P1] });
    expect(effect).toHaveBeenCalledWith({ kind: "create", projectIds: [P1] });
    expect(e.projects[0]).toMatchObject({ code: "ORT", stopSeeing: [{ personId: NICOLA }] });
    effect.mockClear();
    expect((await real.previewWorkspace({ kind: "create", projectIds: [] })).projects).toEqual([]);
    expect(effect).not.toHaveBeenCalled();
  });
});

describe("revisione d'insieme", () => {
  it("I2: le righe `explicit: false` della vista dei membri non sono ruoli per progetto", async () => {
    const v = await createRealWorkspaces(fakeApi()).listWorkspaceMembers(W1);
    const nicola = v.members.find((m) => m.personId === NICOLA)!;
    expect(nicola.projectRoles).toEqual([]);
    expect(nicola.projects.every((p) => p.roles.every((r) => r.source === "workspace"))).toBe(true);
  });

  it("I3: senza workspace «New workspace» lo decide il SERVER (`canManage` dell'elenco), non i permessi del viewer", async () => {
    const no = await createRealWorkspaces(fakeApi({ list: vi.fn(async () => ({ items: [], canManage: false })) })).listWorkspaces();
    expect(no.canManage).toBe(false);
    const yes = await createRealWorkspaces(fakeApi({ list: vi.fn(async () => ({ items: [], canManage: true })) })).listWorkspaces();
    expect(yes.canManage).toBe(true);
  });

  it("I3: un progetto fuori da ogni workspace si può mettere in una solo se l'elenco dice `canManage`", async () => {
    const api = fakeApi({ list: vi.fn(async () => ({ items: [], canManage: false })) });
    expect((await createRealWorkspaces(api).workspaceOfProject(P1)).canChange).toBe(false);
    const ok = fakeApi({ list: vi.fn(async () => ({ items: [], canManage: true })) });
    expect((await createRealWorkspaces(ok).workspaceOfProject(P1)).canChange).toBe(true);
  });
});
