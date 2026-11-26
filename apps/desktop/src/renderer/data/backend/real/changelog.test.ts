import { ApiError } from "@stubwise/api-client";
import { describe, expect, it, vi } from "vitest";
import { createRealChangelog, type ChangelogApi } from "./changelog";

// Nella build app `@backend/access` è quello vero (`accessFacts.ts`): un
// progetto si vede se il server ne dà i permessi. Qui lo stesso, per i link
// alle sezioni di Settings (F5).
vi.mock("@backend/access", async () => {
  const real = await import("./accessFacts");
  return { ...real };
});

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
    const [v] = (await createRealChangelog(api).listChangesPage()).entries;
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

  // R.1414 (72, 86a5a1a55): chi chi guarda non conosce arriva come
  // `hidden-<n>` con il nome null; la pagina scrive «Someone».
  it("un attore che chi guarda non conosce: il segnaposto, senza nome", async () => {
    const { api } = withEntries(entry({ actor: { id: "hidden-1", name: null, kind: "user" } }));
    const [v] = (await createRealChangelog(api).listChangesPage()).entries;
    expect(v).toMatchObject({ actorId: "hidden-1", actorName: null });
  });

  it("il link solo se l'oggetto c'è ancora e chi guarda lo gestisce", async () => {
    const deleted = await createRealChangelog(
      withEntries(entry({ objectDeleted: true })).api,
    ).listChangesPage();
    expect(deleted.entries[0]).toMatchObject({ objectDeleted: true, objectLink: null });
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
    ).listChangesPage();
    expect(noManage.entries[0]!.objectLink).toBeNull();
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
    const [v] = (await createRealChangelog(api).listChangesPage()).entries;
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
    ).listChangesPage();
    expect(views.entries[0]).toMatchObject({
      projectCode: "ACQ",
      objectLink: { to: "member", projectCode: "ACQ", personId: MARCO },
      diff: { kind: "permissions", added: ["release.merge"], removed: [] },
    });
    expect(views.entries[1]!.objectLink).toEqual({ to: "person", personId: MARCO });
  });

  it("i filtri nella query (project=instance per le voci d'istanza); una pagina per volta, col cursore del server", async () => {
    const queries: unknown[] = [];
    const { api } = fakeApi({
      list: async (q) => {
        queries.push(q);
        return {
          entries: [entry({})],
          nextCursor: (q as { cursor?: string }).cursor ? null : "c2",
        } as never;
      },
    });
    const log = createRealChangelog(api);
    const filter = { personId: MARCO, projectId: null, group: "roles", withinDays: 30 };
    const first = await log.listChangesPage(filter);
    expect(first.nextCursor).toBe("c2");
    const second = await log.listChangesPage(filter, "c2");
    expect(second.nextCursor).toBeNull();
    expect(queries).toEqual([
      { person: MARCO, project: "instance", group: "roles", withinDays: 30 },
      { person: MARCO, project: "instance", group: "roles", withinDays: 30, cursor: "c2" },
    ]);
  });

  it("F7: «By Claude» chiede al server ?via=claude, e la voce dice che l'ha fatta Claude", async () => {
    const { api, queries } = fakeApi({
      list: async (q) => {
        queries.push(q);
        return { entries: [entry({ via: "claude" })], nextCursor: null } as never;
      },
    });
    const page = await createRealChangelog(api).listChangesPage({ via: "claude" });
    expect(queries).toEqual([{ via: "claude" }]);
    expect(page.entries[0]).toMatchObject({ via: "claude", undoOf: null });
    // Una voce a mano non ha `via`.
    const hand = await createRealChangelog(withEntries(entry({})).api).listChangesPage();
    expect(hand.entries[0]!.via).toBeUndefined();
  });

  it("«via Claude Code» (D4 della parità MCP): solo se il server lo dice vero", async () => {
    const { api } = withEntries(
      entry({ viaClaudeCode: true }),
      entry({ id: "99999999-9999-4999-8999-999999999999", viaClaudeCode: false }),
    );
    const [cc, hand] = (await createRealChangelog(api).listChangesPage()).entries;
    expect(cc).toMatchObject({ viaClaudeCode: true });
    expect(cc!.via).toBeUndefined();
    expect(hand).not.toHaveProperty("viaClaudeCode");
  });

  it("F7: «Undid…» porta la voce annullata (undoneEntry, solo se chi guarda la legge)", async () => {
    const undone = entry({ id: "88888888-8888-4888-8888-888888888888", via: "claude" });
    const { api } = withEntries(
      entry({ via: "claude", undoOf: undone.id, undoneEntry: undone }),
      entry({ id: "99999999-9999-4999-8999-999999999999", undoOf: null, undoneEntry: null }),
    );
    const [undo, plain] = (await createRealChangelog(api).listChangesPage()).entries;
    expect(undo).toMatchObject({
      undoOf: undone.id,
      undoneEntry: { id: undone.id, via: "claude" },
    });
    expect(plain!.undoOf).toBeNull();
    expect(plain!.undoneEntry).toBeUndefined();
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
    await expect(refusing(404, "not_found").listProjectChangesPage(PRJ)).rejects.toThrow(
      "not_found",
    );
    await expect(refusing(403, "forbidden").listProjectChangesPage(PRJ)).rejects.toThrow(
      "forbidden",
    );
  });

  it("le scelte dei filtri: dal server, «By Claude» compreso (F7, `claude`); senza il campo, spento", async () => {
    expect(await createRealChangelog(fakeApi().api).listChangeFilterChoices()).toEqual({
      everything: true,
      people: [{ personId: MARCO, name: "Marco Bellini" }],
      projects: [{ projectId: PRJ, code: "ACQ", name: "Acquedotto" }],
      groups: ["people", "roles"],
      claude: false,
    });
    const withClaude = fakeApi({
      filters: async () => ({
        everything: true,
        people: [],
        projects: [],
        groups: [],
        claude: true,
      }),
    });
    expect((await createRealChangelog(withClaude.api).listChangeFilterChoices()).claude).toBe(true);
  });

  // Area 9, F5: i tipi della 9c (impostazioni del progetto), coi prima/dopo in
  // valori stabili decodificati come nel prototipo e il link alla sezione di
  // Settings del progetto.
  it("una voce della 9c: il prima/dopo decodificato e il link alla sua sezione di Settings", async () => {
    const pulse = entry({
      type: "project.pulse_interval_changed",
      scope: "project",
      group: "automations",
      projectId: PRJ,
      projectCode: "ACQ",
      data: {
        object: { type: "project", id: PRJ, label: "Acquedotto" },
        before: "7",
        after: "14",
        params: {},
      },
    });
    const { api } = withEntries(pulse);
    const viewer = async () => ({
      personId: ME,
      instancePermissions: [],
      projectPermissions: { [PRJ]: ["project.settings.manage"] },
      departmentPermissions: {},
    });
    const [v] = (await createRealChangelog({ ...api, viewer: viewer as never }).listChangesPage())
      .entries;
    expect(v!.diff).toEqual({
      kind: "setting",
      before: { type: "number", value: 7 },
      after: { type: "number", value: 14 },
    });
    expect(v!.objectLink).toEqual({ to: "projectSettings", code: "ACQ", section: "automations" });
  });

  it("chi non vede la sezione di Settings non ha il link", async () => {
    const pulse = entry({
      type: "project.pulse_interval_changed",
      scope: "project",
      group: "automations",
      projectId: PRJ,
      projectCode: "ACQ",
      data: {
        object: { type: "project", id: PRJ, label: "Acquedotto" },
        before: "7",
        after: "14",
        params: {},
      },
    });
    const [v] = (await createRealChangelog(withEntries(pulse).api).listChangesPage()).entries;
    expect(v!.objectLink).toBeNull();
  });

  it("F6: project.deleted per chi non lo conosceva: «un progetto che non vedi», senza id; Repositories sì", async () => {
    // Come nel prototipo (`deletedProjectLinkOf`, review F6 M1): il link ad
    // Amministrazione → Repositories non nomina il progetto, e chi apre
    // Repositories ci ritrova i repository rimasti.
    const { api } = fakeApi({
      viewer: async () => ({
        personId: ME,
        instancePermissions: ["changelog.view"],
        projectPermissions: { [PRJ]: ["repos.manage"] },
        departmentPermissions: {},
      }),
      list: async () =>
        ({
          nextCursor: null,
          entries: [
            entry({
              type: "project.deleted",
              group: "project",
              hidden: true,
              data: {
                object: { type: "project", id: "hidden", label: "" },
                before: null,
                after: null,
                params: { detachedRepositories: "1" },
              },
            }),
          ],
        }) as never,
    });
    const [v] = (await createRealChangelog(api).listChangesPage()).entries;
    expect(v).toMatchObject({
      kind: "project.deleted",
      object: { type: "project", id: "", label: "" },
      objectLabelKey: "changelog.values.hiddenProject",
      objectLink: { to: "admin", section: "repositories" },
    });
  });

  it("F6: project.deleted per chi lo conosceva: «CODICE · Nome», e Repositories se ne restano senza progetto", async () => {
    const known = (detached: string) =>
      entry({
        type: "project.deleted",
        group: "project",
        data: {
          object: { type: "project", id: PRJ, label: "RNC · Vetrina" },
          before: null,
          after: null,
          params: { detachedRepositories: detached },
        },
      });
    const withRepos = fakeApi({
      list: async () => ({ entries: [known("2"), known("0")], nextCursor: null }) as never,
      viewer: async () => ({
        personId: ME,
        instancePermissions: ["changelog.view"],
        // repos.manage è di progetto: la sezione si vede con almeno uno.
        projectPermissions: { [PRJ]: ["repos.manage"] },
        departmentPermissions: {},
      }),
    });
    const [two, zero] = (await createRealChangelog(withRepos.api).listChangesPage()).entries;
    expect(two).toMatchObject({
      object: { id: PRJ, label: "RNC · Vetrina" },
      objectLabelKey: null,
      objectLink: { to: "admin", section: "repositories" },
    });
    expect(zero!.objectLink).toBeNull();
    // Nella build app il link c'è perché Amministrazione → Repositories è accesa
    // (F6): l'adattatore lo dà solo a sezione accesa (I1).
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    try {
      const [inApp] = (await createRealChangelog(withRepos.api).listChangesPage()).entries;
      expect(inApp!.objectLink).toEqual({ to: "admin", section: "repositories" });
    } finally {
      vi.unstubAllEnvs();
    }
    // Senza repos.manage la sezione non si apre: niente link.
    const [noManage] = (await createRealChangelog(withEntries(known("2")).api).listChangesPage())
      .entries;
    expect(noManage!.objectLink).toBeNull();
  });

  it("F6: la voce di un archiviato (projectArchived, derivato dal server) porta a /archived/<CODICE>", async () => {
    const onProject = entry({
      type: "project.pulse_interval_changed",
      scope: "project",
      group: "automations",
      projectId: PRJ,
      projectCode: "ACQ",
      projectArchived: true,
      data: {
        object: { type: "project", id: PRJ, label: "Acquedotto" },
        before: "7",
        after: "14",
        params: {},
      },
    });
    // Una voce di Settings su un altro oggetto (un repository): un archiviato non ha Settings da aprire.
    const onRepo = entry({
      type: "repository.linked",
      scope: "project",
      group: "repositories",
      projectId: PRJ,
      projectCode: "ACQ",
      projectArchived: true,
      data: {
        object: { type: "repository", id: "r1", label: "api" },
        before: null,
        after: null,
        params: {},
      },
    });
    // Un membro di un archiviato si apre come persona, non nel pannello del membro.
    const onMember = entry({
      type: "member.permission_granted",
      scope: "project",
      group: "members",
      projectId: PRJ,
      projectCode: "ACQ",
      projectArchived: true,
      data: {
        object: { type: "person", id: MARCO, label: "Marco Bellini" },
        before: null,
        after: null,
        params: {},
      },
    });
    const { api } = fakeApi({
      list: async () => ({ entries: [onProject, onRepo, onMember], nextCursor: null }) as never,
      // Gli archiviati non sono in /api/auth/me: nessun permesso sul progetto.
      viewer: async () => ({
        personId: ME,
        instancePermissions: ["changelog.view"],
        projectPermissions: {},
        departmentPermissions: {},
      }),
    });
    const [p, r, m] = (await createRealChangelog(api).listChangesPage()).entries;
    expect(p!.objectLink).toEqual({ to: "archived", code: "ACQ" });
    expect(r!.objectLink).toBeNull();
    expect(m!.objectLink).toEqual({ to: "person", personId: MARCO });
  });
});
