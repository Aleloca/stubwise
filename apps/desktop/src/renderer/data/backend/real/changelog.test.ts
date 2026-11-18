import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import { createRealChangelog, type ChangelogApi } from "./changelog";

// Area 9, F2: il registro delle modifiche sulla lettura del server (72,
// 23eff4ae1 + d11411167). Il server filtra chi legge cosa e toglie le persone
// invisibili; frase, link e prima/dopo li compone il client da `type` e `data`.

const ME = "11111111-1111-4111-8111-111111111111";
const ROBERTA = "22222222-2222-4222-8222-222222222222";
const MARCO = "33333333-3333-4333-8333-333333333333";
const ROLE = "44444444-4444-4444-8444-444444444444";
const DEPT = "55555555-5555-4555-8555-555555555555";
const PRJ = "66666666-6666-4666-8666-666666666666";

const entry = (over: Record<string, unknown>) => ({
  id: "77777777-7777-4777-8777-777777777777",
  type: "role.updated",
  at: "2026-11-18T09:00:00.000Z",
  actor: { id: ROBERTA, name: "Roberta Fontana", kind: "user" },
  projectId: null,
  projectCode: null,
  scope: "instance",
  group: "roles",
  data: {
    object: { type: "role", id: ROLE, label: "Release" },
    before: null,
    after: null,
    params: {},
  },
  objectDeleted: false,
  ...over,
});

function fakeApi(over: Partial<ChangelogApi> = {}) {
  const queries: unknown[] = [];
  const api: ChangelogApi = {
    list: async (q) => {
      queries.push(q);
      return { entries: [], nextCursor: null };
    },
    listProject: async (p, q) => {
      queries.push({ project: p, ...q });
      return { entries: [], nextCursor: null };
    },
    filters: async () => ({
      everything: true,
      people: [{ personId: MARCO, name: "Marco Bellini" }],
      projects: [{ projectId: PRJ, code: "ACQ", name: "Acquedotto" }],
      groups: ["people", "roles"],
    }),
    viewer: async () => ({
      personId: ME,
      instancePermissions: ["roles.manage", "changelog.view"],
      projectPermissions: {},
      departmentPermissions: {},
    }),
    ...over,
  };
  return { api, queries };
}

const withEntries = (...entries: unknown[]) =>
  fakeApi({ list: async () => ({ entries, nextCursor: null }) as never });

describe("il registro delle modifiche dal server (area 9, F2)", () => {
  it("una voce: frase dal tipo, attore per nome, i permessi aggiunti e tolti, il link al ruolo", async () => {
    const { api } = withEntries(
      entry({
        data: {
          object: { type: "role", id: ROLE, label: "Release" },
          before: null,
          after: null,
          params: { added: ["release.merge"], removed: ["plans.approve"] },
        },
      }),
    );
    const [v] = await createRealChangelog(api).listChanges();
    expect(v).toMatchObject({
      kind: "role.updated",
      templateKey: "changelog.kinds.role.updated",
      actorId: ROBERTA,
      actorName: "Roberta Fontana",
      scope: "instance",
      group: "roles",
      objectLink: { to: "role", roleId: ROLE },
      undoOf: null,
      diff: {
        kind: "permissions",
        added: ["release.merge"],
        removed: ["plans.approve"],
        role: null,
      },
    });
  });

  it("il link solo se l'oggetto c'è ancora e chi guarda lo gestisce", async () => {
    const deleted = await createRealChangelog(
      withEntries(entry({ objectDeleted: true })).api,
    ).listChanges();
    expect(deleted[0]).toMatchObject({ objectDeleted: true, objectLink: null });
    const noManage = await createRealChangelog(
      fakeApi({
        list: async () => ({ entries: [entry({})], nextCursor: null }) as never,
        viewer: async () => ({
          personId: ME,
          instancePermissions: ["changelog.view"],
          projectPermissions: {},
          departmentPermissions: {},
        }),
      }).api,
    ).listChanges();
    expect(noManage[0]!.objectLink).toBeNull();
  });

  it("i membri di un reparto per nome (quelli di allora, già senza gli invisibili)", async () => {
    const { api } = withEntries(
      entry({
        type: "department.members_changed",
        group: "departments",
        data: {
          object: { type: "department", id: DEPT, label: "Support" },
          before: null,
          after: null,
          params: {
            added: [MARCO],
            removed: [],
            addedNames: ["marco@example.com"],
            removedNames: [],
          },
        },
      }),
    );
    const [v] = await createRealChangelog(api).listChanges();
    expect(v!.diff).toEqual({ kind: "people", added: ["marco@example.com"], removed: [] });
  });

  it("una voce di membro porta al pannello del membro; una d'uscita alla persona", async () => {
    const member = (type: string) =>
      entry({
        type,
        scope: "project",
        group: "members",
        projectId: PRJ,
        projectCode: "ACQ",
        data: {
          object: { type: "person", id: MARCO, label: "Marco Bellini" },
          before: null,
          after: null,
          params: { permission: "release.merge" },
        },
      });
    const views = await createRealChangelog(
      withEntries(member("member.permission_granted"), member("member.removed")).api,
    ).listChanges();
    expect(views[0]).toMatchObject({
      projectCode: "ACQ",
      objectLink: { to: "member", projectCode: "ACQ", personId: MARCO },
      diff: { kind: "permissions", added: ["release.merge"], removed: [] },
    });
    expect(views[1]!.objectLink).toEqual({ to: "person", personId: MARCO });
  });

  it("i filtri nella query; le voci d'istanza con project=instance; si leggono le pagine fino all'ultima", async () => {
    const queries: unknown[] = [];
    const pages: Record<string, { entries: unknown[]; nextCursor: string | null }> = {
      first: { entries: [entry({ id: "a1111111-1111-4111-8111-111111111111" })], nextCursor: "c2" },
      c2: { entries: [entry({ id: "a2222222-2222-4222-8222-222222222222" })], nextCursor: null },
    };
    const { api } = fakeApi({
      list: async (q) => {
        queries.push(q);
        return pages[(q as { cursor?: string }).cursor ?? "first"] as never;
      },
    });
    const v = await createRealChangelog(api).listChanges({
      personId: MARCO,
      projectId: null,
      group: "roles",
      withinDays: 30,
    });
    expect(v.map((e) => e.id)).toEqual([
      "a1111111-1111-4111-8111-111111111111",
      "a2222222-2222-4222-8222-222222222222",
    ]);
    expect(queries).toEqual([
      { person: MARCO, project: "instance", group: "roles", withinDays: 30 },
      { person: MARCO, project: "instance", group: "roles", withinDays: 30, cursor: "c2" },
    ]);
  });

  it("«By Claude» non ha ancora voci sul server (F7): nessuna chiamata, nessuna voce", async () => {
    const { api, queries } = fakeApi();
    expect(await createRealChangelog(api).listChanges({ via: "claude" })).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("il registro di un progetto: 404 è not_found, 403 è forbidden, come il prototipo", async () => {
    const refusing = (status: number, code: string) =>
      createRealChangelog(
        fakeApi({
          listProject: async () => {
            throw new ApiError(status, code, code);
          },
        }).api,
      );
    await expect(refusing(404, "not_found").listProjectChanges(PRJ)).rejects.toThrow("not_found");
    await expect(refusing(403, "forbidden").listProjectChanges(PRJ)).rejects.toThrow("forbidden");
  });

  it("le scelte dei filtri: dal server, «By Claude» spento finché non c'è (F7)", async () => {
    expect(await createRealChangelog(fakeApi().api).listChangeFilterChoices()).toEqual({
      everything: true,
      people: [{ personId: MARCO, name: "Marco Bellini" }],
      projects: [{ projectId: PRJ, code: "ACQ", name: "Acquedotto" }],
      groups: ["people", "roles"],
      claude: false,
    });
  });
});
