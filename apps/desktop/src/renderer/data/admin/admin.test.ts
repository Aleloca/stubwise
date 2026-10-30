import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  changelog,
  createTask,
  failNext,
  getTaskByCode,
  listDepartments as listDepartmentNames,
  listNotifications,
  listPeople as listAssignable,
  resetApi,
  setLatency,
  updateTask,
} from "../api";
import {
  accessState,
  effectivePermissions,
  roleIdOf,
  seedAccessState,
  writeAccess,
} from "../access/index";
import { REAUTH_REQUIRED, markReauthenticated } from "../auth/reauth";
import { changeTypes } from "../changelog/index";
import { CLAUDE_ID, PEOPLE, SEED_DEPARTMENT_IDS } from "../seed/people";
import { setSessionPersonId } from "../session";
import { seedChangelog } from "../seed/changelog";
import { state, visibleProjectIds, type ApiFnName } from "../store";
import {
  VIEW_AS_PERSONAS,
  can,
  grantInstancePermission,
  revokeInstancePermission,
  viewerFor,
  type LocalInstancePermission,
  type Permission,
} from "../viewer";
import { ADMIN_CHANGE_TYPES } from "./changeTypes";
import { __secretValuesForTest, secretIdsOf } from "./secrets";
import type { AdminResult } from "./types";

// L'Amministrazione nel livello dati (area 9a, Task 4): People, inviti,
// Roles, Departments. Members ha il suo file (`members.test.ts`). Ogni
// rifiuto si controlla insieme allo stato invariato e alla voce assente.

const ACQ = "prj-acq";
const AUD = "prj-aud";

const as = (personId: string) => setSessionPersonId(personId);
const reauth = (personId: string) => markReauthenticated(personId);
/** Dà un permesso d'istanza a una persona (scorciatoia dei test, come nelle aree 2–8). */
const giveInstance = (personId: string, perm: string) =>
  grantInstancePermission(personId, perm as LocalInstancePermission);

const dept = (id: string) => accessState().departments.find((d) => d.departmentId === id)!;

const developmentMembers = () =>
  accessState().departments.find((d) => d.departmentId === "dep-development")!.memberIds;

/**
 * `personId` fuori da Development e membro solo dei progetti di `ofId`: chi
 * lo aggiunge a un reparto gli dà i permessi del reparto solo lì.
 */
function onlyInProjectsOf(personId: string, ofId: string): void {
  writeAccess((s) => {
    const theirs = new Set(
      s.memberships.filter((m) => m.personId === ofId).map((m) => m.projectId),
    );
    s.memberships = s.memberships.filter((m) => m.personId !== personId || theirs.has(m.projectId));
    const d = s.departments.find((x) => x.departmentId === "dep-development")!;
    d.memberIds = d.memberIds.filter((id) => id !== personId);
  });
}

/** Tutto ciò che una scrittura d'amministrazione può toccare, serializzato. */
function snapshot(): string {
  return JSON.stringify({
    access: accessState(),
    invites: state.invites,
    departments: state.departments,
    departmentHomes: state.departmentHomes,
    securityEvents: state.securityEvents,
    bitbucket: [...state.bitbucketUsernames],
    authors: [...state.commitAuthorLinks],
    notifications: state.notifications,
    tasks: state.tasks,
    activity: state.activity.length,
    changelog: state.changelog,
    personDepartments: PEOPLE.map((p) => p.departmentIds),
    secrets: __secretValuesForTest().map((s) => s.id),
  });
}

/** Il rifiuto atteso, con lo stato e il registro invariati. */
async function refused(
  call: () => Promise<AdminResult<object>>,
  expected: Partial<{ error: string; reason: string; missing: string[] }>,
) {
  const before = snapshot();
  const entries = state.changelog.length;
  const result = await call();
  expect(result).toMatchObject({ ok: false, ...expected });
  expect(snapshot()).toBe(before);
  expect(state.changelog.length).toBe(entries);
}

beforeEach(() => {
  resetApi();
  setLatency(0);
  // Questi test provano il meccanismo del registro: partono senza le voci
  // del seme (che prova `pages/admin/Audit.test.tsx`).
  state.changelog.splice(0);
});
afterEach(() => resetApi());

// --- la riconferma ------------------------------------------------------------

/**
 * Per ogni funzione +R, una chiamata valida fatta da Roberta (full admin):
 * senza riconferma è `reauth_required` e non cambia niente; con la
 * riconferma va a buon fine (prova che la chiamata era valida).
 */
const SENSITIVE: Record<string, { setup?: () => void; call: () => Promise<AdminResult<object>> }> =
  {
    "admin.setInstanceRole": { call: () => admin.setInstanceRole("p-marco", roleIdOf("au-1")) },
    "admin.createPasswordResetLink": { call: () => admin.createPasswordResetLink("p-marco") },
    "admin.resetSecondFactor": { call: () => admin.resetSecondFactor("p-marco") },
    "admin.unlinkGitIdentity": {
      setup: () => state.commitAuthorLinks.set("kevin.ortega", "p-marco"),
      call: () => admin.unlinkGitIdentity("p-marco", "kevin.ortega"),
    },
    "admin.deactivatePerson": { call: () => admin.deactivatePerson("p-marco", {}) },
    "admin.createInvite": {
      call: () =>
        admin.createInvite({
          email: "nuova.persona@example.com",
          instanceRoleId: roleIdOf("user"),
          projects: [{ projectId: ACQ, roleId: roleIdOf("developer") }],
        }),
    },
    "admin.createRole": { call: () => admin.createRole({ name: "Ops", scope: "project" }) },
    "admin.updateRole": {
      call: () => admin.updateRole(roleIdOf("rm-1"), { name: "Release lead" }),
    },
    "admin.duplicateRole": { call: () => admin.duplicateRole(roleIdOf("developer")) },
    "admin.deleteRole": { call: () => admin.deleteRole(roleIdOf("au-1")) },
    "admin.setDepartmentMembers": {
      call: () =>
        admin.setDepartmentMembers("dep-sales", [
          ...accessState().departments.find((d) => d.departmentId === "dep-sales")!.memberIds,
          "p-marco",
        ]),
    },
    "admin.setHomeManagers": {
      call: () => admin.setHomeManagers("dep-sales", ["p-matteo", "p-elena"]),
    },
    "admin.setDepartmentPermissions": {
      call: () => admin.setDepartmentPermissions("dep-sales", ["support.reply"]),
    },
    "admin.saveDepartment": {
      call: () =>
        admin.saveDepartment("dep-sales", {
          memberIds: [...dept("dep-sales").memberIds, "p-marco"],
          homeManagerIds: dept("dep-sales").homeManagerIds,
          projectPermissions: dept("dep-sales").projectPermissions,
        }),
    },
    "admin.addMember": { call: () => admin.addMember(ACQ, "p-giulia", roleIdOf("developer")) },
    "admin.removeMember": { call: () => admin.removeMember(ACQ, "p-marco") },
    "admin.setMemberRole": { call: () => admin.setMemberRole(ACQ, "p-marco", roleIdOf("rm-1")) },
    "admin.grantMemberPermission": {
      call: () => admin.grantMemberPermission(ACQ, "p-federico", "servers.operate"),
    },
    "admin.revokeMemberPermission": {
      call: () => admin.revokeMemberPermission(ACQ, "p-marco", "servers.operate"),
    },
    "admin.saveMember": {
      call: () => admin.saveMember(ACQ, "p-marco", { roleId: roleIdOf("developer"), granted: [] }),
    },
  };

describe("riconferma", () => {
  it("ogni funzione dell'Amministrazione in REAUTH_REQUIRED ha il suo caso qui", () => {
    const declared = [...REAUTH_REQUIRED].filter((n) => n.startsWith("admin."));
    expect(declared.sort()).toEqual(Object.keys(SENSITIVE).sort());
  });

  for (const [name, { setup, call }] of Object.entries(SENSITIVE)) {
    it(`${name}: senza riconferma → reauth_required, stato e registro invariati; con → ok`, async () => {
      setup?.();
      as("p-roberta");
      await refused(call, { error: "reauth_required" });
      reauth("p-roberta");
      expect(await call()).toMatchObject({ ok: true });
      expect(state.changelog.length).toBe(1);
      expect(REAUTH_REQUIRED.has(name as ApiFnName)).toBe(true);
    });
  }

  it("la riconferma è della persona: quella di Roberta non vale per Laura", async () => {
    reauth("p-roberta");
    as("p-laura");
    await refused(() => admin.grantMemberPermission(ACQ, "p-marco", "plans.approve"), {
      error: "reauth_required",
    });
  });
});

// --- senza permesso -------------------------------------------------------------

describe("senza permesso: forbidden, stato invariato, nessuna voce", () => {
  // Sara: Contributor, User d'istanza, membro di ACQ senza gestirne i membri.
  const writes: [string, () => Promise<AdminResult<object>>][] = [
    ["setInstanceRole", () => admin.setInstanceRole("p-marco", roleIdOf("au-1"))],
    ["createPasswordResetLink", () => admin.createPasswordResetLink("p-marco")],
    ["resetSecondFactor", () => admin.resetSecondFactor("p-marco")],
    ["linkGitIdentity", () => admin.linkGitIdentity("p-marco", "kevin.ortega")],
    ["unlinkGitIdentity", () => admin.unlinkGitIdentity("p-marco", "kevin.ortega")],
    ["setBitbucketUsername", () => admin.setBitbucketUsername("p-marco", "marcob")],
    ["deactivatePerson", () => admin.deactivatePerson("p-marco", {})],
    ["reactivatePerson", () => admin.reactivatePerson("p-simone")],
    [
      "createInvite",
      () =>
        admin.createInvite({
          email: "x@example.com",
          instanceRoleId: roleIdOf("user"),
          projects: [],
        }),
    ],
    ["revokeInvite", () => admin.revokeInvite("inv-1")],
    ["createRole", () => admin.createRole({ name: "Ops", scope: "project" })],
    ["updateRole", () => admin.updateRole(roleIdOf("rm-1"), { name: "X" })],
    ["duplicateRole", () => admin.duplicateRole(roleIdOf("developer"))],
    ["deleteRole", () => admin.deleteRole(roleIdOf("au-1"))],
    ["createDepartment", () => admin.createDepartment({ name: "Legal", colorToken: "--dept-6" })],
    ["updateDepartment", () => admin.updateDepartment("dep-sales", { name: "Vendite" })],
    ["setDepartmentMembers", () => admin.setDepartmentMembers("dep-sales", [])],
    ["setHomeManagers", () => admin.setHomeManagers("dep-sales", [])],
    ["setDepartmentPermissions", () => admin.setDepartmentPermissions("dep-sales", [])],
    ["deleteDepartment", () => admin.deleteDepartment("dep-sales", "dep-marketing")],
    ["addMember", () => admin.addMember(ACQ, "p-giulia", roleIdOf("developer"))],
    ["removeMember", () => admin.removeMember(ACQ, "p-marco")],
    ["setMemberRole", () => admin.setMemberRole(ACQ, "p-marco", roleIdOf("rm-1"))],
    ["grantMemberPermission", () => admin.grantMemberPermission(ACQ, "p-marco", "docs.view")],
    [
      "saveMember",
      () => admin.saveMember(ACQ, "p-marco", { roleId: roleIdOf("developer"), granted: [] }),
    ],
    [
      "revokeMemberPermission",
      () => admin.revokeMemberPermission(ACQ, "p-marco", "servers.operate"),
    ],
  ];

  for (const [name, call] of writes) {
    it(name, async () => {
      state.commitAuthorLinks.set("kevin.ortega", "p-marco");
      as("p-sara");
      // Anche con una riconferma fresca: il permesso viene prima.
      reauth("p-sara");
      await refused(call, { error: "forbidden" });
    });
  }

  it("le letture di gestione rifiutano chi non le ha", async () => {
    as("p-sara");
    await expect(admin.listSecurityEvents("p-marco")).rejects.toThrow("forbidden");
    await expect(admin.listObservedAuthors()).rejects.toThrow("forbidden");
    await expect(admin.listInvites()).rejects.toThrow("forbidden");
    await expect(admin.listDepartments()).rejects.toThrow("forbidden");
  });
});

// --- RF 1: escalation per una strada laterale ----------------------------------

describe("RF 1: si dà solo ciò che si ha", () => {
  it("Laura duplica Developer e ci aggiunge servers.operate, che non ha → escalation", async () => {
    giveInstance("p-laura", "roles.manage");
    as("p-laura");
    reauth("p-laura");
    const copy = await admin.duplicateRole(roleIdOf("developer"));
    expect(copy).toMatchObject({ ok: true });
    const id = (copy as { roleId: string }).roleId;
    const perms = accessState().roles.find((r) => r.id === id)!.permissions;
    await refused(() => admin.updateRole(id, { permissions: [...perms, "servers.operate"] }), {
      error: "escalation",
      missing: ["servers.operate"],
    });
    // Togliere non passa dall'anti-escalation.
    expect(await admin.updateRole(id, { permissions: perms.slice(1) })).toMatchObject({ ok: true });
  });

  it("Laura non duplica un ruolo che contiene un permesso che non ha", async () => {
    giveInstance("p-laura", "roles.manage");
    as("p-laura");
    reauth("p-laura");
    await refused(() => admin.duplicateRole(roleIdOf("admin")), {
      error: "escalation",
      missing: expect.arrayContaining(["instance.full_admin", "departments.manage"]),
    });
  });

  describe("un admin non full", () => {
    beforeEach(() => {
      // Matteo con un ruolo d'istanza che gestisce reparti e inviti, senza full admin.
      writeAccess((s) => {
        s.roles.push({
          id: "role-ops",
          key: "ops",
          scope: "instance",
          name: "Ops",
          preset: false,
          permissions: ["users.invite", "departments.manage", "users.view_all"],
        });
        s.people.find((p) => p.personId === "p-matteo")!.instanceRoleId = "role-ops";
      });
      as("p-matteo");
      reauth("p-matteo");
    });

    it("mette instance.full_admin in un reparto → escalation", async () => {
      await refused(() => admin.setDepartmentPermissions("dep-sales", ["instance.full_admin"]), {
        error: "escalation",
        missing: ["instance.full_admin"],
      });
    });

    it("invita col ruolo Admin → escalation", async () => {
      await refused(
        () =>
          admin.createInvite({
            email: "nuovo.admin@example.com",
            instanceRoleId: roleIdOf("admin"),
            projects: [],
          }),
        { error: "escalation", missing: expect.arrayContaining(["instance.full_admin"]) },
      );
    });

    it("invita in un progetto dove non gestisce i membri → forbidden", async () => {
      // Matteo è Project Lead di ACQ: da Developer non ne gestisce i membri.
      writeAccess((s) => {
        s.memberships.find((m) => m.personId === "p-matteo" && m.projectId === ACQ)!.roleId =
          roleIdOf("developer");
      });
      await refused(
        () =>
          admin.createInvite({
            email: "nuovo@example.com",
            instanceRoleId: roleIdOf("user"),
            projects: [{ projectId: ACQ, roleId: roleIdOf("viewer") }],
          }),
        { error: "forbidden" },
      );
    });
  });

  describe("Laura aggiunge Giulia a Development, che porta support.reply", () => {
    it("senza departments.manage → forbidden", async () => {
      as("p-laura");
      reauth("p-laura");
      const members = accessState().departments.find((d) => d.departmentId === "dep-development")!;
      await refused(
        () => admin.setDepartmentMembers("dep-development", [...members.memberIds, "p-giulia"]),
        { error: "forbidden" },
      );
    });

    it("con departments.manage e support.reply nei progetti di chi entra → ammesso", async () => {
      giveInstance("p-laura", "departments.manage");
      onlyInProjectsOf("p-marco", "p-laura");
      as("p-laura");
      reauth("p-laura");
      expect(
        await admin.setDepartmentMembers("dep-development", [...developmentMembers(), "p-marco"]),
      ).toMatchObject({ ok: true });
      expect(PEOPLE.find((p) => p.id === "p-marco")!.departmentIds).toEqual(["dep-development"]);
    });

    it("chi entra è in un progetto dove Laura non ha il permesso del reparto → escalation", async () => {
      giveInstance("p-laura", "departments.manage");
      as("p-laura");
      reauth("p-laura");
      // Giulia è anche in CBV e OLV, dove Laura non è: lì support.reply non ce l'ha.
      await refused(
        () => admin.setDepartmentMembers("dep-development", [...developmentMembers(), "p-giulia"]),
        { error: "escalation", missing: ["support.reply"] },
      );
    });

    it("se il reparto porta un permesso che Laura non ha → escalation", async () => {
      // Sales (di cui Laura non fa parte) dà servers.operate, che Laura non ha da nessuna parte.
      giveInstance("p-laura", "departments.manage");
      writeAccess((s) => {
        s.departments
          .find((d) => d.departmentId === "dep-sales")!
          .projectPermissions.push("servers.operate");
      });
      as("p-laura");
      reauth("p-laura");
      const members = accessState().departments.find((d) => d.departmentId === "dep-sales")!;
      await refused(
        () => admin.setDepartmentMembers("dep-sales", [...members.memberIds, "p-giulia"]),
        { error: "escalation", missing: ["servers.operate"] },
      );
      // Togliere qualcuno dal reparto non passa dall'anti-escalation.
      expect(
        await admin.setDepartmentMembers(
          "dep-sales",
          members.memberIds.filter((id) => id !== "p-luca"),
        ),
      ).toMatchObject({ ok: true });
    });

    it("un permesso che Laura ha solo dal suo reparto conta, nei progetti dove arriva", async () => {
      // servers.operate non sta in nessun ruolo: a Laura arriva SOLO da Development.
      giveInstance("p-laura", "departments.manage");
      writeAccess((s) => {
        s.departments
          .find((d) => d.departmentId === "dep-development")!
          .projectPermissions.push("servers.operate");
      });
      expect(effectivePermissions("p-laura", ACQ).get("servers.operate")).toEqual([
        { kind: "department", departmentId: "dep-development" },
      ]);
      onlyInProjectsOf("p-marco", "p-laura");
      as("p-laura");
      reauth("p-laura");
      // Marco è solo in progetti di Laura: lì servers.operate Laura ce l'ha (dal reparto).
      expect(
        await admin.setDepartmentMembers("dep-development", [...developmentMembers(), "p-marco"]),
      ).toEqual({ ok: true });
      expect(
        await admin.setDepartmentMembers(
          "dep-development",
          developmentMembers().filter((id) => id !== "p-marco"),
        ),
      ).toEqual({ ok: true });
      // Con Marco anche in OLV, dove Laura non è, darglieli è escalation (tutti e due).
      writeAccess((s) => {
        s.memberships.push({
          personId: "p-marco",
          projectId: "prj-olv",
          roleId: roleIdOf("developer"),
        });
      });
      await refused(
        () => admin.setDepartmentMembers("dep-development", [...developmentMembers(), "p-marco"]),
        { error: "escalation", missing: ["support.reply", "servers.operate"] },
      );
    });
  });

  describe("si confronta nel progetto dove il permesso arriva, e al suo livello (R-M2)", () => {
    const CBV = "prj-cbv";
    const STW = "prj-stw";
    const developer = () => accessState().roles.find((r) => r.id === roleIdOf("developer"))!;
    const user = () => accessState().roles.find((r) => r.id === roleIdOf("user"))!;
    const marketing = () =>
      accessState().departments.find((d) => d.departmentId === "dep-marketing")!;
    /** Development porta servers.operate, e Laura non ne fa parte. */
    const developmentOperatesWithoutLaura = () =>
      writeAccess((s) => {
        const d = s.departments.find((x) => x.departmentId === "dep-development")!;
        d.projectPermissions.push("servers.operate");
        d.memberIds = d.memberIds.filter((id) => id !== "p-laura");
      });

    /** Le quattro strade laterali della revisione, fatte da `actor`. */
    const scenarios = {
      "release.merge nel preset Developer (Federico ce l'avrebbe su CBV)": () =>
        admin.updateRole(roleIdOf("developer"), {
          permissions: [...developer().permissions, "release.merge"],
        }),
      "plans.approve nel reparto Marketing (Giulia ce l'avrebbe su CBV)": () =>
        admin.setDepartmentPermissions("dep-marketing", [
          ...marketing().projectPermissions,
          "plans.approve",
        ]),
      "automations.manage nel ruolo d'istanza User (Laura ce l'ha solo di progetto)": () =>
        admin.updateRole(roleIdOf("user"), {
          permissions: [...user().permissions, "automations.manage"],
        }),
      "Alessia in STW, con servers.operate dal reparto": () =>
        admin.addMember(STW, "p-alessia", roleIdOf("viewer")),
    };
    const missingOf: Record<keyof typeof scenarios, string> = {
      "release.merge nel preset Developer (Federico ce l'avrebbe su CBV)": "release.merge",
      "plans.approve nel reparto Marketing (Giulia ce l'avrebbe su CBV)": "plans.approve",
      "automations.manage nel ruolo d'istanza User (Laura ce l'ha solo di progetto)":
        "automations.manage",
      "Alessia in STW, con servers.operate dal reparto": "servers.operate",
    };

    beforeEach(() => {
      developmentOperatesWithoutLaura();
      for (const p of ["roles.manage", "departments.manage"]) giveInstance("p-laura", p);
      reauth("p-laura");
      reauth("p-roberta");
    });

    it("le premesse: Laura ha quei permessi altrove, non dove arriverebbero", () => {
      expect(state.projectsById.get(CBV)!.memberIds).toEqual(
        expect.arrayContaining(["p-federico", "p-giulia"]),
      );
      expect(state.projectsById.get(CBV)!.memberIds).not.toContain("p-laura");
      expect(can(viewerFor("p-laura"), "release.merge", ACQ)).toBe(true);
      expect(can(viewerFor("p-laura"), "automations.manage", ACQ)).toBe(true);
      expect(can(viewerFor("p-laura"), "automations.manage")).toBe(false);
      expect(can(viewerFor("p-laura"), "servers.operate", STW)).toBe(false);
      expect(can(viewerFor("p-laura"), "project.members.manage", STW)).toBe(true);
    });

    for (const [name, call] of Object.entries(scenarios)) {
      it(`Laura: ${name} → escalation, stato e registro invariati`, async () => {
        as("p-laura");
        await refused(call, {
          error: "escalation",
          missing: [missingOf[name as keyof typeof scenarios]],
        });
      });

      it(`Roberta, full admin: ${name} → riesce`, async () => {
        as("p-roberta");
        expect(await call()).toMatchObject({ ok: true });
      });
    }

    it("un ruolo di progetto non assegnato: basta averne i permessi in almeno un progetto", async () => {
      as("p-laura");
      const created = (await admin.createRole({
        name: "Mergers",
        scope: "project",
        from: roleIdOf("developer"),
      })) as { ok: true; roleId: string };
      expect(created.ok).toBe(true);
      const perms = [...developer().permissions, "release.merge"];
      expect(await admin.updateRole(created.roleId, { permissions: perms })).toEqual({ ok: true });
      // Assegnarlo rifà il controllo nel progetto: su ACQ Laura ha release.merge.
      expect(await admin.setMemberRole(ACQ, "p-marco", created.roleId)).toEqual({ ok: true });
      // Ora è assegnato su ACQ: aggiungere ciò che Laura non ha su ACQ è escalation.
      await refused(
        () => admin.updateRole(created.roleId, { permissions: [...perms, "servers.operate"] }),
        { error: "escalation", missing: ["servers.operate"] },
      );
    });

    it("un ruolo promesso da un invito in sospeso conta come assegnato", async () => {
      as("p-laura");
      const created = (await admin.createRole({ name: "Docs only", scope: "project" })) as {
        roleId: string;
      };
      state.invites[0]!.projects = [{ projectId: CBV, roleId: created.roleId }];
      await refused(() => admin.updateRole(created.roleId, { permissions: ["docs.view"] }), {
        error: "escalation",
        missing: ["docs.view"],
      });
    });
  });

  describe("il livello giusto per inviti e ruolo d'istanza (m-b)", () => {
    beforeEach(() => {
      writeAccess((s) => {
        s.roles.push(
          // Un ruolo di progetto e uno d'istanza con un solo permesso ciascuno.
          {
            id: "role-ops",
            key: "ops",
            scope: "project",
            name: "Ops",
            preset: false,
            permissions: ["servers.operate"],
          },
          {
            id: "role-automator",
            key: "automator",
            scope: "instance",
            name: "Automator",
            preset: false,
            permissions: ["automations.manage"],
          },
        );
        // Laura ha servers.operate solo su ACQ.
        s.grants.push({
          personId: "p-laura",
          projectId: ACQ,
          permission: "servers.operate",
          grantedById: "p-roberta",
          at: "2026-10-01T10:00:00Z",
        });
      });
      for (const p of ["users.invite", "users.manage"]) giveInstance("p-laura", p);
      as("p-laura");
      reauth("p-laura");
    });

    const invite = (projectId: string, instanceRoleId = roleIdOf("user")) =>
      admin.createInvite({
        email: "nuova@example.com",
        instanceRoleId,
        projects: [{ projectId, roleId: "role-ops" }],
      });

    it("un invito promette un ruolo di progetto: si confronta in QUEL progetto", async () => {
      await refused(() => invite("prj-stw"), { error: "escalation", missing: ["servers.operate"] });
      expect(await invite(ACQ)).toMatchObject({ ok: true });
    });

    it("il ruolo d'istanza di un invito: automations.manage di progetto non basta", async () => {
      expect(can(viewerFor("p-laura"), "automations.manage", ACQ)).toBe(true);
      await refused(() => invite(ACQ, "role-automator"), {
        error: "escalation",
        missing: ["automations.manage"],
      });
    });

    it("setInstanceRole: automations.manage di progetto non basta per darlo d'istanza", async () => {
      await refused(() => admin.setInstanceRole("p-marco", "role-automator"), {
        error: "escalation",
        missing: ["automations.manage"],
      });
      // Con automations.manage d'istanza, sì.
      giveInstance("p-laura", "automations.manage");
      expect(await admin.setInstanceRole("p-marco", "role-automator")).toEqual({ ok: true });
    });
  });

  it("una scrittura dopo il cambio di persona del «vedi come» è della persona nuova", async () => {
    reauth("p-laura");
    reauth("p-sara");
    as("p-laura");
    as("p-sara");
    await refused(() => admin.grantMemberPermission(ACQ, "p-marco", "plans.approve"), {
      error: "forbidden",
    });
    as("p-laura");
    expect(await admin.grantMemberPermission(ACQ, "p-marco", "plans.approve")).toMatchObject({
      ok: true,
    });
    expect(state.changelog.at(-1)!.actorId).toBe("p-laura");
  });
});

// --- RF 3: l'ultimo full admin ---------------------------------------------------

describe("RF 3: resta sempre un full admin", () => {
  beforeEach(() => {
    // Laura gestisce le persone, senza essere full admin.
    giveInstance("p-laura", "users.manage");
    reauth("p-laura");
    reauth("p-roberta");
  });

  it("disattivare Roberta, l'unica full admin → last_full_admin", async () => {
    as("p-laura");
    await refused(() => admin.deactivatePerson("p-roberta", {}), {
      error: "invalid",
      reason: "last_full_admin",
    });
  });

  it("toglierle il ruolo d'istanza → last_full_admin", async () => {
    as("p-laura");
    await refused(() => admin.setInstanceRole("p-roberta", roleIdOf("user")), {
      error: "invalid",
      reason: "last_full_admin",
    });
  });

  it("togliere full admin al ruolo Admin → last_full_admin", async () => {
    as("p-roberta");
    await refused(() => admin.updateRole(roleIdOf("admin"), { permissions: ["users.manage"] }), {
      error: "invalid",
      reason: "last_full_admin",
    });
  });

  it("togliere full admin al ruolo Admin con DUE full admin dal ruolo → last_full_admin", async () => {
    // Ognuno da solo non sarebbe l'ultimo: lo diventano insieme.
    writeAccess((s) => {
      s.people.find((p) => p.personId === "p-giorgio")!.instanceRoleId = roleIdOf("admin");
    });
    as("p-roberta");
    await refused(() => admin.updateRole(roleIdOf("admin"), { permissions: ["users.manage"] }), {
      error: "invalid",
      reason: "last_full_admin",
    });
  });

  it("con un secondo full admin si può: niente gerarchia, Laura disattiva Roberta", async () => {
    writeAccess((s) => {
      s.people.find((p) => p.personId === "p-giorgio")!.instanceRoleId = roleIdOf("admin");
    });
    as("p-laura");
    expect(await admin.deactivatePerson("p-roberta", {})).toMatchObject({ ok: true });
  });

  it("su sé stessi no: ruolo, reset, disattivazione", async () => {
    as("p-roberta");
    await refused(() => admin.setInstanceRole("p-roberta", roleIdOf("user")), {
      error: "invalid",
      reason: "self",
    });
    await refused(() => admin.createPasswordResetLink("p-roberta"), { reason: "self" });
    await refused(() => admin.resetSecondFactor("p-roberta"), { reason: "self" });
    await refused(() => admin.deactivatePerson("p-roberta", {}), { reason: "self" });
  });

  it("la pagina della persona dice in anticipo perché non si disattiva", async () => {
    as("p-laura");
    expect((await admin.getPerson("p-roberta")).actions.deactivate).toBe("last_full_admin");
    as("p-roberta");
    expect((await admin.getPerson("p-roberta")).actions.deactivate).toBe("self");
    expect((await admin.getPerson("p-marco")).actions.deactivate).toBeNull();
  });
});

// --- disattivazione -------------------------------------------------------------

describe("disattivare e riattivare", () => {
  beforeEach(() => {
    as("p-roberta");
    reauth("p-roberta");
  });

  const openTasksOf = (personId: string) =>
    state.tasks.filter(
      (t) => t.assigneeId === personId && state.statusById.get(t.statusId)!.family !== "closed",
    );

  it("le task riassegnate cambiano incaricato, le altre dicono «(deactivated)»", async () => {
    const [moved, kept] = openTasksOf("p-marco");
    expect(moved && kept).toBeTruthy();
    const detail = await admin.getPerson("p-marco");
    expect(detail.openTasks.map((t) => t.taskId)).toContain(moved!.id);
    const to = detail.openTasks
      .find((t) => t.taskId === moved!.id)!
      .reassignTo.find((id) => id !== CLAUDE_ID)!;
    const result = await admin.deactivatePerson("p-marco", { [moved!.id]: to, [kept!.id]: null });
    expect(result).toEqual({ ok: true, reassigned: 1 });
    expect(state.tasksById.get(moved!.id)!.assigneeId).toBe(to);
    expect(state.activity.at(-1)).toMatchObject({ taskId: moved!.id, field: "assignee" });
    const view = await getTaskByCode(kept!.code);
    expect(view!.assigneeId).toBe("p-marco");
    expect(view!.assigneeStatus).toBe("deactivated");
    expect((await getTaskByCode(moved!.code))!.assigneeStatus).toBe("active");
  });

  it("sparisce dal «vedi come» e da chi si assegna; riattivata torna com'era", async () => {
    const before = VIEW_AS_PERSONAS.map((p) => p.personId);
    const access = JSON.stringify(
      accessState().memberships.filter((m) => m.personId === "p-marco"),
    );
    await admin.deactivatePerson("p-marco", {});
    expect(VIEW_AS_PERSONAS.map((p) => p.personId)).not.toContain("p-marco");
    expect((await listAssignable()).find((p) => p.id === "p-marco")!.deactivated).toBe(true);
    const task = state.tasks.find((t) => t.projectId === ACQ && t.assigneeId !== "p-marco")!;
    await expect(updateTask(task.id, { assigneeId: "p-marco" })).rejects.toThrow(
      "invalid: assignee",
    );
    await expect(
      createTask({ projectId: ACQ, title: "Per Marco", assigneeId: "p-marco" }),
    ).rejects.toThrow("invalid: assignee");
    expect(await admin.reactivatePerson("p-marco")).toMatchObject({ ok: true });
    expect(VIEW_AS_PERSONAS.map((p) => p.personId)).toEqual(before);
    expect((await listAssignable()).find((p) => p.id === "p-marco")!.deactivated).toBe(false);
    expect(JSON.stringify(accessState().memberships.filter((m) => m.personId === "p-marco"))).toBe(
      access,
    );
    expect((await updateTask(task.id, { assigneeId: "p-marco" })).assigneeId).toBe("p-marco");
  });

  it("Simone, disattivato nel seme: le sue task dicono «(deactivated)»", async () => {
    const task = openTasksOf("p-simone")[0]!;
    expect((await getTaskByCode(task.code))!.assigneeStatus).toBe("deactivated");
    expect((await admin.getPerson("p-simone")).actions.reactivate).toBeNull();
  });

  it("non si riassegna a chi non è del progetto, né a un disattivato", async () => {
    const [task] = openTasksOf("p-marco");
    const outsider = accessState().people.find(
      (p) =>
        p.status === "active" &&
        !state.projectsById.get(task!.projectId)!.memberIds.includes(p.personId),
    )!.personId;
    await refused(() => admin.deactivatePerson("p-marco", { [task!.id]: outsider }), {
      reason: "assignee",
    });
    const stw = openTasksOf("p-marco").find((t) => t.projectId === "prj-stw");
    if (stw)
      await refused(() => admin.deactivatePerson("p-marco", { [stw.id]: "p-simone" }), {
        reason: "assignee",
      });
  });
});

// --- RF 2 e security.alert -------------------------------------------------------

describe("RF 2: i link si vedono una volta", () => {
  async function everyRead(): Promise<string> {
    return JSON.stringify([
      await admin.listPeople(),
      await admin.getPerson("p-marco"),
      await admin.listInvites(),
      await admin.listSecurityEvents("p-marco"),
      await admin.listRoles(),
      await admin.listDepartments(),
      await admin.listProjectMembers(ACQ),
      await changelog.listChanges(),
      await listNotifications(),
      state.changelog,
      state.notifications,
      state.invites,
      state.securityEvents,
      accessState(),
    ]);
  }

  it("il link di reset e quello d'invito non ricompaiono in nessuna lettura", async () => {
    as("p-roberta");
    reauth("p-roberta");
    const reset = await admin.createPasswordResetLink("p-marco");
    const invite = await admin.createInvite({
      email: "ines.nuova@example.com",
      instanceRoleId: roleIdOf("user"),
      projects: [],
    });
    expect(reset.ok && invite.ok).toBe(true);
    const values = [
      (reset as { link: string }).link,
      (invite as { link: string }).link,
      ...__secretValuesForTest().flatMap((s) => s.values),
    ];
    const reads = await everyRead();
    for (const value of values) expect(reads).not.toContain(value);
    // Un link di reset nuovo fa dimenticare il precedente.
    await admin.createPasswordResetLink("p-marco");
    expect(secretIdsOf("reset_link", "p-marco")).toHaveLength(1);
  });

  it("un link di reset generato da un altro avvisa l'interessato (solo lui), senza il link", async () => {
    as("p-roberta");
    reauth("p-roberta");
    const alertsBefore = state.notifications.filter((n) => n.kind === "security.alert").length;
    const reset = await admin.createPasswordResetLink("p-marco");
    expect(reset.ok).toBe(true);
    const link = (reset as { link: string }).link;
    const alert = state.notifications.at(-1)!;
    expect(alert).toMatchObject({ kind: "security.alert", recipientIds: ["p-marco"] });
    expect(state.notifications.filter((n) => n.kind === "security.alert")).toHaveLength(
      alertsBefore + 1,
    );
    expect(alert.body).toContain("Roberta Fontana");
    as("p-marco");
    expect((await listNotifications()).map((n) => n.id)).toContain(alert.id);
    const token = link.split("token=")[1]!;
    for (const text of [
      JSON.stringify(state.notifications),
      JSON.stringify(state.securityEvents),
      JSON.stringify(state.changelog),
    ]) {
      expect(text).not.toContain(link);
      expect(text).not.toContain(token);
    }
  });

  it("revocare un invito lo toglie dall'elenco; il link resta solo per dire «revocato»", async () => {
    as("p-roberta");
    reauth("p-roberta");
    const invite = (await admin.createInvite({
      email: "da.revocare@example.com",
      instanceRoleId: roleIdOf("user"),
      projects: [],
    })) as { inviteId: string };
    expect(secretIdsOf("invite_link", invite.inviteId)).toHaveLength(1);
    expect(await admin.revokeInvite(invite.inviteId)).toEqual({ ok: true });
    // Custodito (Task 5: `getInvite` risponde `revoked`), mai più in una lettura.
    expect(secretIdsOf("invite_link", invite.inviteId)).toHaveLength(1);
    expect((await admin.listInvites()).map((i) => i.id)).not.toContain(invite.inviteId);
  });
});

describe("reset del secondo fattore", () => {
  it("security.alert arriva solo all'interessato", async () => {
    as("p-roberta");
    reauth("p-roberta");
    expect(await admin.resetSecondFactor("p-marco")).toEqual({ ok: true });
    const alert = state.notifications.at(-1)!;
    expect(alert).toMatchObject({ kind: "security.alert", recipientIds: ["p-marco"] });
    for (const personId of ["p-marco", "p-roberta", "p-laura", "p-sara"]) {
      as(personId);
      const ids = (await listNotifications()).map((n) => n.id);
      expect(ids.includes(alert.id)).toBe(personId === "p-marco");
    }
    expect(accessState().people.find((p) => p.personId === "p-marco")!.secondFactor).toBeNull();
    expect(secretIdsOf("backup_codes", "p-marco")).toEqual([]);
  });

  it("fra pari grado è accettato e registrato come tale", async () => {
    writeAccess((s) => {
      s.people.find((p) => p.personId === "p-giorgio")!.instanceRoleId = roleIdOf("admin");
    });
    as("p-roberta");
    reauth("p-roberta");
    expect(await admin.resetSecondFactor("p-giorgio")).toEqual({ ok: true });
    expect(state.changelog.at(-1)!.params).toEqual({ peer: "true" });
  });

  it("l'interessato esce ovunque: nessuna sessione di Marco resta aperta", async () => {
    as("p-roberta");
    reauth("p-roberta");
    expect(state.sessions.some((s) => s.personId === "p-marco")).toBe(true);
    const others = state.sessions.filter((s) => s.personId !== "p-marco").length;
    expect(await admin.resetSecondFactor("p-marco")).toEqual({ ok: true });
    expect(state.sessions.filter((s) => s.personId === "p-marco")).toEqual([]);
    expect(state.sessions).toHaveLength(others);
  });

  it("`peer` della pagina: vero solo fra due full admin", async () => {
    as("p-roberta");
    expect((await admin.getPerson("p-marco")).peer).toBe(false);
    writeAccess((s) => {
      s.people.find((p) => p.personId === "p-laura")!.instanceRoleId = roleIdOf("admin");
    });
    expect((await admin.getPerson("p-laura")).peer).toBe(true);
    as("p-laura");
    expect((await admin.getPerson("p-roberta")).peer).toBe(true);
    expect((await admin.getPerson("p-marco")).peer).toBe(false);
  });

  it("chi non ha il secondo fattore non si azzera", async () => {
    as("p-roberta");
    reauth("p-roberta");
    await refused(() => admin.resetSecondFactor("p-sara"), { reason: "no_second_factor" });
  });
});

// --- People -----------------------------------------------------------------------

describe("People", () => {
  it("la legge chiunque; niente Claude; i progetti solo quelli che chi guarda vede", async () => {
    as("p-sara");
    const rows = await admin.listPeople();
    expect(rows.map((r) => r.personId)).not.toContain(CLAUDE_ID);
    expect(rows.some((r) => r.status === "invited")).toBe(false);
    const sara = new Set(
      state.projects.filter((p) => p.memberIds.includes("p-sara")).map((p) => p.code),
    );
    const marco = rows.find((r) => r.personId === "p-marco")!;
    expect(marco.projects.length).toBeGreaterThan(0);
    for (const p of marco.projects) expect(sara.has(p.code)).toBe(true);
    expect((await admin.getPerson("p-marco")).alsoInHiddenProjects).toBe(true);
    await expect(admin.getPerson(CLAUDE_ID)).rejects.toThrow("not_found");
    await expect(admin.getPerson("inv-1")).rejects.toThrow("not_found");
  });

  it("per chi invita, gli inviti sono righe «invited» (anche lo scaduto); i disattivati in fondo", async () => {
    as("p-roberta");
    const rows = await admin.listPeople();
    const invited = rows.filter((r) => r.status === "invited");
    expect(invited.map((r) => [r.invite!.id, r.invite!.expired])).toEqual([
      ["inv-1", false],
      ["inv-2", true],
    ]);
    expect(rows.at(-1)!.personId).toBe("p-simone");
    expect(
      (await admin.listPeople({ statuses: ["active"], departmentIds: ["dep-development"] })).map(
        (r) => r.personId,
      ),
    ).toEqual(["p-alessia", "p-federico", "p-laura", "p-marco", "p-stefano"]);
  });

  it("collegare e scollegare un'identità git: i commit passano sotto la persona", async () => {
    as("p-roberta");
    reauth("p-roberta");
    expect((await admin.listObservedAuthors()).map((a) => a.name)).toContain("kevin.ortega");
    expect(await admin.linkGitIdentity("p-marco", "kevin.ortega")).toEqual({ ok: true });
    expect((await admin.getPerson("p-marco")).identities.gitEmails).toEqual(["kevin.ortega"]);
    expect((await admin.listObservedAuthors()).map((a) => a.name)).not.toContain("kevin.ortega");
    await refused(() => admin.linkGitIdentity("p-laura", "kevin.ortega"), {
      reason: "identity_taken",
    });
    expect(await admin.unlinkGitIdentity("p-marco", "kevin.ortega")).toEqual({ ok: true });
    expect(await admin.setBitbucketUsername("p-marco", "marcob")).toEqual({ ok: true });
    expect((await admin.getPerson("p-marco")).identities.bitbucketUsername).toBe("marcob");
  });

  it("«Link a person» dell'Activity è la stessa scrittura: finisce nel registro", async () => {
    as("p-roberta");
    const { linkCommitAuthor } = await import("../api-mutations");
    await linkCommitAuthor("kevin.ortega", "p-stefano");
    expect((await admin.getPerson("p-stefano")).identities.gitEmails).toEqual(["kevin.ortega"]);
    expect(state.changelog.map((e) => [e.kind, e.after])).toEqual([
      ["person.git_identity_linked", "kevin.ortega"],
    ]);
  });

  it("le scelte dell'invito: ruoli con ciò che manca, solo i progetti dove si gestiscono i membri", async () => {
    // Laura invita (concessione), gestisce i membri dove è Project Lead.
    giveInstance("p-laura", "users.invite");
    as("p-laura");
    const choices = await admin.getInviteChoices();
    expect(choices.instanceRoles.find((r) => r.roleId === roleIdOf("admin"))!.missing).toContain(
      "instance.full_admin",
    );
    expect(choices.instanceRoles.find((r) => r.roleId === roleIdOf("user"))!.missing).toEqual([]);
    expect(choices.defaultInstanceRoleId).toBe(roleIdOf("user"));
    const managed = state.projects
      .filter((p) => can(viewerFor("p-laura"), "project.members.manage", p.id))
      .map((p) => p.id)
      .sort();
    expect(choices.projects.map((p) => p.projectId).sort()).toEqual(managed);
    expect(managed.length).toBeGreaterThan(0);
    const first = choices.projects[0]!;
    expect(first.roles.map((r) => r.name)).toContain("Developer");
    expect(first.roles.find((r) => r.name === "Developer")!.missing).toEqual([]);
    // Senza `users.invite`: forbidden.
    as("p-marco");
    await expect(admin.getInviteChoices()).rejects.toThrow("forbidden");
  });

  it("i ruoli d'istanza offerti dicono cosa manca a chi guarda", async () => {
    giveInstance("p-laura", "users.manage");
    as("p-laura");
    const choices = (await admin.getPerson("p-marco")).instanceRoleChoices;
    expect(choices.find((c) => c.roleId === roleIdOf("admin"))!.missing).toContain(
      "instance.full_admin",
    );
    expect(choices.find((c) => c.roleId === roleIdOf("user"))!.missing).toEqual([]);
    expect(choices.find((c) => c.roleId === roleIdOf("au-1"))!.missing).toEqual([
      "usage.view",
      "changelog.view",
    ]);
    reauth("p-laura");
    await refused(() => admin.setInstanceRole("p-marco", roleIdOf("au-1")), {
      error: "escalation",
      missing: ["usage.view", "changelog.view"],
    });
  });
});

// --- Roles ------------------------------------------------------------------------

describe("Roles", () => {
  beforeEach(() => {
    as("p-roberta");
    reauth("p-roberta");
  });

  it("un preset non si elimina; un ruolo in uso dice chi lo ha", async () => {
    await refused(() => admin.deleteRole(roleIdOf("developer")), { reason: "preset" });
    writeAccess((s) => {
      s.memberships.find((m) => m.personId === "p-marco" && m.projectId === ACQ)!.roleId =
        roleIdOf("rm-1");
    });
    const before = snapshot();
    expect(await admin.deleteRole(roleIdOf("rm-1"))).toEqual({
      ok: false,
      error: "invalid",
      reason: "in_use",
      usedBy: [{ personId: "p-marco", projectId: ACQ }],
    });
    expect(snapshot()).toBe(before);
  });

  it("Task 9: ciò che chi guarda non può aggiungere a un ruolo, dove il ruolo vale", async () => {
    giveInstance("p-marco", "roles.manage");
    as("p-marco");
    const roles = await admin.listRoles();
    const byKey = (key: string) => roles.find((r) => r.key === key)!;
    // Un ruolo d'istanza: i permessi d'istanza di Marco.
    expect(byKey("au-1").reach).toBe("instance");
    expect(byKey("au-1").notGivable).toContain("usage.view");
    expect(byKey("au-1").notGivable).not.toContain("users.view_all");
    // Developer è assegnato: i progetti dove vale.
    expect(byKey("developer").reach).toBe("projects");
    // Developer è assegnato anche in progetti dove Marco non è membro: lì non ha niente.
    expect(byKey("developer").notGivable).toContain("runs.start");
    // `notGivable` guarda anche i permessi FUORI dal ruolo (non è `missing`).
    expect(byKey("developer").notGivable).toContain("release.merge");
    expect(byKey("developer").missing).not.toContain("release.merge");
    // Release manager non è di nessuno: basta averlo in un progetto.
    expect(byKey("rm-1").reach).toBe("anywhere");
    // Copiare un ruolo è crearne uno nuovo: la regola di `createRole`.
    expect(byKey("developer").copyMissing).toEqual([]);
    expect(byKey("project_lead").copyMissing).toContain("plans.approve");
    expect(byKey("au-1").copyMissing).toEqual(["usage.view", "changelog.view"]);
    // Chi può eliminare cosa: preset, in uso, libero.
    expect(byKey("developer").deleteBlock).toBe("preset");
    expect(byKey("rm-1").deleteBlock).toBeNull();
    expect(byKey("au-1").deleteBlock).toBeNull();
    writeAccess((s) => {
      s.memberships.find((m) => m.personId === "p-laura" && m.projectId === ACQ)!.roleId =
        roleIdOf("rm-1");
    });
    expect((await admin.listRoles()).find((r) => r.key === "rm-1")!.deleteBlock).toBe("in_use");
    // R-E2: solo Project Lead dà «vedere l'attività delle persone».
    expect(byKey("project_lead").givesActivityView).toBe(true);
    expect(byKey("rm-1").givesActivityView).toBe(false);
  });

  it("Task 9: un ruolo in uso solo in progetti che chi guarda non vede resta «in uso»", async () => {
    // Release manager dato a qualcuno in un progetto che Sara non vede: non
    // entra nei suoi conteggi, ma il ruolo non si elimina lo stesso.
    const hidden = state.projects.find((p) => !visibleProjectIds("p-sara").has(p.id))!;
    writeAccess((s) => {
      s.memberships.find((m) => m.projectId === hidden.id)!.roleId = roleIdOf("rm-1");
    });
    giveInstance("p-sara", "roles.manage");
    as("p-sara");
    const rm = (await admin.listRoles()).find((r) => r.key === "rm-1")!;
    expect(rm.peopleCount).toBe(0);
    expect(rm.deleteBlock).toBe("in_use");
  });

  it("i conteggi rispettano R-G5: Sara conta solo le appartenenze dei suoi progetti", async () => {
    const all = (await admin.listRoles()).find((r) => r.id === roleIdOf("developer"))!;
    as("p-sara");
    const hers = (await admin.listRoles()).find((r) => r.id === roleIdOf("developer"))!;
    const visible = new Set(
      state.projects.filter((p) => p.memberIds.includes("p-sara")).map((p) => p.id),
    );
    expect(hers.peopleCount).toBeLessThan(all.peopleCount);
    for (const h of hers.holders) expect(visible.has(h.projectId!)).toBe(true);
  });

  it("cambiare il ruolo d'istanza azzera le revoche d'istanza della persona", async () => {
    revokeInstancePermission("p-marco", "claude.public.view");
    expect(can(viewerFor("p-marco"), "claude.public.view")).toBe(false);
    expect(await admin.setInstanceRole("p-marco", roleIdOf("au-1"))).toEqual({ ok: true });
    expect(await admin.setInstanceRole("p-marco", roleIdOf("user"))).toEqual({ ok: true });
    expect(accessState().revocations).toEqual([]);
    expect(can(viewerFor("p-marco"), "claude.public.view")).toBe(true);
  });

  it("il ruolo cambiato vale subito per chi lo ha", async () => {
    const developer = accessState().roles.find((r) => r.id === roleIdOf("developer"))!;
    expect(can(viewerFor("p-marco"), "docs.edit", ACQ)).toBe(true);
    await admin.updateRole(developer.id, {
      permissions: developer.permissions.filter((p) => p !== "docs.edit"),
    });
    expect(can(viewerFor("p-marco"), "docs.edit", ACQ)).toBe(false);
    // Claude ha un insieme fisso: un ruolo non lo tocca.
    expect(can(viewerFor(CLAUDE_ID), "docs.edit", ACQ)).toBe(true);
  });
});

// --- Departments --------------------------------------------------------------------

describe("Departments", () => {
  beforeEach(() => {
    as("p-roberta");
    reauth("p-roberta");
  });

  it("le persone del reparto e Person.departmentIds hanno un solo scrittore, e resetApi torna al seme", async () => {
    const sales = accessState().departments.find((d) => d.departmentId === "dep-sales")!;
    await admin.setDepartmentMembers("dep-sales", [...sales.memberIds, "p-marco"]);
    expect(PEOPLE.find((p) => p.id === "p-marco")!.departmentIds).toEqual([
      "dep-development",
      "dep-sales",
    ]);
    expect((await listAssignable()).find((p) => p.id === "p-marco")!.departmentIds).toContain(
      "dep-sales",
    );
    await admin.setDepartmentMembers(
      "dep-sales",
      sales.memberIds.filter((id) => id !== "p-elena"),
    );
    expect(PEOPLE.find((p) => p.id === "p-elena")!.departmentIds).toEqual(["dep-marketing"]);
    resetApi();
    for (const p of PEOPLE.filter((x) => !x.isClaude))
      expect(p.departmentIds).toEqual(SEED_DEPARTMENT_IDS[p.id]);
    expect(accessState()).toEqual(seedAccessState());
  });

  it("crea, rinomina, elimina spostando le task", async () => {
    const created = (await admin.createDepartment({ name: "Legal", colorToken: "--dept-6" })) as {
      departmentId: string;
    };
    expect((await listDepartmentNames()).map((d) => d.name)).toContain("Legal");
    await refused(() => admin.createDepartment({ name: "legal", colorToken: "--dept-7" }), {
      reason: "name_taken",
    });
    await refused(() => admin.createDepartment({ name: "Ops", colorToken: "--dept-9" }), {
      reason: "color",
    });
    expect(await admin.updateDepartment(created.departmentId, { name: "Legale" })).toEqual({
      ok: true,
    });
    const tasks = state.tasks.filter((t) => t.departmentId === "dep-sales").map((t) => t.id);
    expect(tasks.length).toBeGreaterThan(0);
    await refused(() => admin.deleteDepartment("dep-sales", null), { reason: "move_required" });
    expect(await admin.deleteDepartment("dep-sales", created.departmentId)).toEqual({
      ok: true,
      moved: tasks.length,
    });
    for (const id of tasks)
      expect(state.tasksById.get(id)!.departmentId).toBe(created.departmentId);
    expect(PEOPLE.find((p) => p.id === "p-matteo")!.departmentIds).toEqual([]);
    expect((await listDepartmentNames()).map((d) => d.id)).not.toContain("dep-sales");
  });

  it("Task 9: i permessi che chi guarda non può mettere nel reparto, e dove arrivano", async () => {
    // Marco (Developer) gestisce i reparti.
    giveInstance("p-marco", "departments.manage");
    as("p-marco");
    // Un reparto nuovo, senza persone: basta avere il permesso in un progetto.
    const legal = (await admin.createDepartment({ name: "Legal", colorToken: "--dept-6" })) as {
      departmentId: string;
    };
    const empty = (await admin.listDepartments()).find((d) => d.id === legal.departmentId)!;
    expect(empty.reach).toBe("anywhere");
    expect(empty.notGivable).toContain("plans.approve");
    expect(empty.notGivable).not.toContain("tickets.create");
    // Con Marco dentro, un permesso nuovo arriva nei suoi progetti: lì ha tickets.create.
    writeAccess((s) => {
      s.departments.find((d) => d.departmentId === legal.departmentId)!.memberIds = ["p-marco"];
    });
    const withMarco = (await admin.listDepartments()).find((d) => d.id === legal.departmentId)!;
    expect(withMarco.reach).toBe("projects");
    expect(withMarco.notGivable).toContain("release.merge");
    expect(withMarco.notGivable).not.toContain("tickets.create");
    // Development ha membri in progetti dove Marco non è: lì non ha niente.
    const dev = (await admin.listDepartments()).find((d) => d.id === "dep-development")!;
    expect(dev.notGivable).toContain("tickets.create");
    as("p-roberta");
    expect((await admin.listDepartments()).every((d) => d.notGivable.length === 0)).toBe(true);
  });

  it("un permesso che non è di progetto non va in un reparto", async () => {
    await refused(() => admin.setDepartmentPermissions("dep-sales", ["users.manage"]), {
      reason: "permission",
    });
  });
});

// --- Task 9, giro 1: il reparto si salva in un colpo, e «you'll lose» dal livello dati ----

describe("saveDepartment: la bozza intera, tutto o niente", () => {
  /** Marco gestisce i reparti e crea «Legal», vuoto (Roberta non c'entra). */
  async function marcoWithLegal(): Promise<string> {
    giveInstance("p-marco", "departments.manage");
    as("p-marco");
    reauth("p-marco");
    const r = (await admin.createDepartment({ name: "Legal", colorToken: "--dept-6" })) as {
      departmentId: string;
    };
    return r.departmentId;
  }

  it("lo scenario della revisione: Sara più «create tasks» è rifiutato, zero scritture e nessuna voce", async () => {
    const legal = await marcoWithLegal();
    // Sara sta in progetti dove Marco non è: lì non ha «create tasks».
    await refused(
      () =>
        admin.saveDepartment(legal, {
          memberIds: ["p-sara"],
          homeManagerIds: [],
          projectPermissions: ["tickets.create"],
        }),
      { error: "escalation", missing: ["tickets.create"] },
    );
    expect(dept(legal).memberIds).toEqual([]);
  });

  it("chi esce con la stessa bozza non conta: togliere Sara e dare «create tasks» passa", async () => {
    const legal = await marcoWithLegal();
    writeAccess((s) => {
      s.departments.find((d) => d.departmentId === legal)!.memberIds = ["p-sara"];
    });
    expect(
      await admin.saveDepartment(legal, {
        memberIds: [],
        homeManagerIds: [],
        projectPermissions: ["tickets.create"],
      }),
    ).toEqual({ ok: true });
    expect(dept(legal).projectPermissions).toEqual(["tickets.create"]);
  });

  it("giro 2 (N-1): un membro salvato tolto dalla bozza e rimesso non è un'aggiunta", async () => {
    // Marco gestisce i reparti; Development dà «reply to customers», che Marco
    // non ha nei progetti di Laura dove lui non è.
    giveInstance("p-marco", "departments.manage");
    as("p-marco");
    reauth("p-marco");
    const dev = dept("dep-development");
    const without = dev.memberIds.filter((id) => id !== "p-laura");
    const preview = await admin.previewDepartment("dep-development", {
      memberIds: without,
      projectPermissions: dev.projectPermissions,
    });
    // Rimetterla non dà niente di nuovo: è selezionabile.
    expect(preview.missingToAdd["p-laura"]).toEqual([]);
    // E il salvataggio con Laura rimessa, più un'altra modifica, passa.
    const other = dev.memberIds.find((id) => id !== "p-laura" && !dev.homeManagerIds.includes(id))!;
    expect(
      await admin.saveDepartment("dep-development", {
        memberIds: dev.memberIds,
        homeManagerIds: [...dev.homeManagerIds, other],
        projectPermissions: dev.projectPermissions,
      }),
    ).toEqual({ ok: true });
  });

  it("giro 2: parità — su ogni bozza, previewDepartment prevede l'escalation che saveDepartment dà", async () => {
    giveInstance("p-marco", "departments.manage");
    const dev = () => dept("dep-development");
    const without = (id: string) => dev().memberIds.filter((x) => x !== id);
    // Le bozze: [membri, permessi], sul reparto Development salvato.
    const drafts: [string, () => { memberIds: string[]; projectPermissions: string[] }][] = [
      ["immutata più Home", () => ({ memberIds: dev().memberIds, projectPermissions: dev().projectPermissions })],
      ["entra Sara", () => ({ memberIds: [...dev().memberIds, "p-sara"], projectPermissions: dev().projectPermissions })],
      ["entra Marco stesso", () => ({ memberIds: [...without("p-marco"), "p-marco"], projectPermissions: dev().projectPermissions })],
      ["tolta Laura", () => ({ memberIds: without("p-laura"), projectPermissions: dev().projectPermissions })],
      ["permesso nuovo", () => ({ memberIds: dev().memberIds, projectPermissions: [...dev().projectPermissions, "tickets.create"] })],
      ["permesso tolto", () => ({ memberIds: dev().memberIds, projectPermissions: [] })],
      ["tolto il permesso, entra Sara", () => ({ memberIds: [...dev().memberIds, "p-sara"], projectPermissions: [] })],
      ["entra Sara con permesso nuovo", () => ({ memberIds: [...dev().memberIds, "p-sara"], projectPermissions: ["tickets.create"] })],
    ];
    const outcomes = new Set<boolean>();
    for (const [name, make] of drafts) {
      resetApi();
      setLatency(0);
      giveInstance("p-marco", "departments.manage");
      as("p-marco");
      reauth("p-marco");
      const saved = dev();
      const draft = make();
      const preview = await admin.previewDepartment("dep-development", draft);
      const predicted = preview.missing.length > 0;
      // La Home cambia sempre un poco, così una bozza senza escalation non è `unchanged`.
      const homeExtra = draft.memberIds.find(
        (id) => !saved.homeManagerIds.includes(id) && accessState().people.some((x) => x.personId === id && x.status === "active"),
      )!;
      const result = await admin.saveDepartment("dep-development", {
        ...draft,
        homeManagerIds: [...saved.homeManagerIds.filter((h) => draft.memberIds.includes(h)), homeExtra],
      });
      expect((result as { error?: string }).error === "escalation", name).toBe(predicted);
      if (predicted) expect(result, name).toMatchObject({ missing: preview.missing });
      else expect(result, name).toEqual({ ok: true });
      outcomes.add(predicted);
    }
    // Le bozze coprono tutti e due gli esiti.
    expect([...outcomes].sort()).toEqual([false, true]);
  });

  it("le caselle si calcolano sulla bozza: con Sara dentro «create tasks» è spento, e viceversa", async () => {
    const legal = await marcoWithLegal();
    const empty = await admin.previewDepartment(legal, { memberIds: [], projectPermissions: [] });
    expect(empty.reach).toBe("anywhere");
    expect(empty.notGivable).not.toContain("tickets.create");
    expect(empty.missingToAdd["p-sara"]).toEqual([]);
    const withSara = await admin.previewDepartment(legal, {
      memberIds: ["p-sara"],
      projectPermissions: [],
    });
    expect(withSara.reach).toBe("projects");
    expect(withSara.notGivable).toContain("tickets.create");
    // Al contrario: con «create tasks» nella bozza, Sara non si aggiunge.
    const withPerm = await admin.previewDepartment(legal, {
      memberIds: [],
      projectPermissions: ["tickets.create"],
    });
    expect(withPerm.missingToAdd["p-sara"]).toEqual(["tickets.create"]);
  });

  it("una bozza valida scrive persone, Home e permessi insieme, con le loro voci", async () => {
    as("p-roberta");
    reauth("p-roberta");
    const entries = state.changelog.length;
    const sales = dept("dep-sales");
    expect(
      await admin.saveDepartment("dep-sales", {
        memberIds: [...sales.memberIds, "p-sara"],
        homeManagerIds: [...sales.homeManagerIds, "p-sara"],
        projectPermissions: ["support.reply"],
      }),
    ).toEqual({ ok: true });
    expect(dept("dep-sales").memberIds).toContain("p-sara");
    expect(dept("dep-sales").homeManagerIds).toContain("p-sara");
    expect(dept("dep-sales").projectPermissions).toEqual(["support.reply"]);
    expect(state.changelog.slice(entries).map((e) => e.kind).sort()).toEqual([
      "department.home_managers_changed",
      "department.members_changed",
      "department.permissions_changed",
    ]);
    // Le voci dicono COSA è cambiato: gli insiemi di prima si leggono prima
    // della scrittura (che riassegna i campi dello stesso oggetto).
    const byKind = (kind: string) => state.changelog.slice(entries).find((e) => e.kind === kind)!;
    expect(byKind("department.members_changed").params).toMatchObject({
      added: "p-sara",
      removed: "",
    });
    expect(byKind("department.home_managers_changed").params.added).toBe("p-sara");
    expect(byKind("department.permissions_changed").params).toMatchObject({
      added: "support.reply",
      before: "",
      after: "support.reply",
    });
  });

  it("last_members_manager: la bozza che toglie l'ultimo gestore non scrive neanche il resto", async () => {
    // ACQ senza full admin attivi e senza gestori dal ruolo: i membri di
    // Development li gestiscono solo grazie al reparto.
    writeAccess((s) => {
      for (const p of s.people)
        if (p.instanceRoleId === roleIdOf("admin")) p.instanceRoleId = roleIdOf("user");
      for (const m of s.memberships) if (m.projectId === ACQ) m.roleId = roleIdOf("developer");
      s.departments.find((d) => d.departmentId === "dep-development")!.projectPermissions = [
        "support.reply",
        "project.members.manage",
      ];
    });
    giveInstance("p-laura", "departments.manage");
    as("p-laura");
    reauth("p-laura");
    const dev = dept("dep-development");
    const other = dev.memberIds.find((id) => !dev.homeManagerIds.includes(id))!;
    await refused(
      () =>
        admin.saveDepartment("dep-development", {
          memberIds: dev.memberIds,
          homeManagerIds: [...dev.homeManagerIds, other],
          projectPermissions: ["support.reply"],
        }),
      { error: "invalid", reason: "last_members_manager" },
    );
    expect(dept("dep-development").homeManagerIds).not.toContain(other);
  });

  it("un disattivato non entra nella Home, e senza riconferma niente si scrive", async () => {
    as("p-roberta");
    reauth("p-roberta");
    const dev = dept("dep-development");
    await refused(
      () =>
        admin.saveDepartment("dep-development", {
          memberIds: dev.memberIds,
          homeManagerIds: [...dev.homeManagerIds, "p-simone"],
          projectPermissions: dev.projectPermissions,
        }),
      { error: "invalid", reason: "person" },
    );
  });
});

describe("viewerLosesIf: cosa perde davvero chi salva un ruolo", () => {
  it("Laura, Project Lead di ACQ, perde «approve plans» togliendolo a Project Lead; Roberta (full admin) niente", async () => {
    const lead = accessState().roles.find((r) => r.key === "project_lead")!;
    const next = lead.permissions.filter((p) => p !== "plans.approve");
    giveInstance("p-laura", "roles.manage");
    as("p-laura");
    expect(await admin.viewerLosesIf(lead.id, next)).toEqual(["plans.approve"]);
    as("p-roberta");
    expect(await admin.viewerLosesIf(lead.id, next)).toEqual([]);
  });

  it("chi ha il permesso anche da un'altra fonte non lo perde; la simulazione non scrive niente", async () => {
    const lead = accessState().roles.find((r) => r.key === "project_lead")!;
    const next = lead.permissions.filter((p) => p !== "support.reply");
    giveInstance("p-laura", "roles.manage");
    as("p-laura");
    const before = snapshot();
    // Laura è in Development, che dà «reply to customers»: la tiene.
    expect(dept("dep-development").memberIds).toContain("p-laura");
    expect(await admin.viewerLosesIf(lead.id, next)).toEqual([]);
    expect(snapshot()).toBe(before);
  });
});

describe("Roles: i conteggi e l'incluso", () => {
  it("affectedCount conta le persone toccate anche in progetti che chi guarda non vede", async () => {
    const hidden = state.projects.find((p) => !visibleProjectIds("p-sara").has(p.id))!;
    writeAccess((s) => {
      s.memberships.find((m) => m.projectId === hidden.id)!.roleId = roleIdOf("rm-1");
    });
    giveInstance("p-sara", "roles.manage");
    as("p-sara");
    const rm = (await admin.listRoles()).find((r) => r.key === "rm-1")!;
    expect(rm.peopleCount).toBe(0);
    expect(rm.affectedCount).toBe(1);
  });

  it("fullAdminImplies: ciò che «full administration» include, solo per i ruoli d'istanza", async () => {
    as("p-roberta");
    const roles = await admin.listRoles();
    const adminRole = roles.find((r) => r.key === "admin")!;
    expect(adminRole.fullAdminImplies).toContain("users.manage");
    expect(adminRole.fullAdminImplies).not.toContain("instance.full_admin");
    expect(roles.find((r) => r.key === "developer")!.fullAdminImplies).toEqual([]);
  });
});

// --- registro, R-G5, failNext, resetApi ---------------------------------------------

describe("registro delle modifiche", () => {
  it("le voci di progetto di 9a si leggono solo con un permesso di gestione, mai da Claude", () => {
    const projectTypes = ADMIN_CHANGE_TYPES.filter((t) => t.scope === "project");
    expect(projectTypes.length).toBeGreaterThan(0);
    for (const t of projectTypes) {
      expect(t.readPermission).toMatch(/\.manage$/);
      for (const p of [ACQ, AUD])
        expect(can(viewerFor(CLAUDE_ID), t.readPermission as Permission, p)).toBe(false);
    }
    for (const t of ADMIN_CHANGE_TYPES) expect(changeTypes()).toContainEqual(t);
  });

  it("dopo scritture d'istanza e di progetto, Claude non legge niente", async () => {
    as("p-roberta");
    reauth("p-roberta");
    await admin.grantMemberPermission(ACQ, "p-federico", "servers.operate");
    await admin.createRole({ name: "Ops", scope: "project" });
    await admin.createDepartment({ name: "Legal", colorToken: "--dept-6" });
    expect((await changelog.listChanges()).length).toBe(3);
    as(CLAUDE_ID);
    expect(await changelog.listChanges()).toEqual([]);
    await expect(changelog.listProjectChanges(ACQ)).rejects.toThrow("forbidden");
  });

  it("una voce non contiene il segreto: il reset dice solo che è avvenuto", async () => {
    as("p-roberta");
    reauth("p-roberta");
    await admin.createPasswordResetLink("p-marco");
    expect(state.changelog.at(-1)).toMatchObject({
      kind: "person.password_reset_link_created",
      before: null,
      after: null,
      params: {},
    });
  });
});

describe("failNext e resetApi", () => {
  it("un guasto simulato lancia e non scrive", async () => {
    as("p-roberta");
    reauth("p-roberta");
    const before = snapshot();
    failNext("admin.setInstanceRole");
    await expect(admin.setInstanceRole("p-marco", roleIdOf("au-1"))).rejects.toThrow(
      "Simulated failure",
    );
    expect(snapshot()).toBe(before);
    expect(state.changelog).toEqual([]);
  });

  it("resetApi riporta persone, inviti, ruoli e reparti al seme", async () => {
    // Il seme intero, voci del registro comprese (il `beforeEach` le toglie).
    resetApi();
    const seed = snapshot();
    as("p-roberta");
    reauth("p-roberta");
    await admin.deactivatePerson("p-marco", {});
    await admin.createInvite({
      email: "a.b@example.com",
      instanceRoleId: roleIdOf("user"),
      projects: [],
    });
    await admin.createRole({ name: "Ops", scope: "project" });
    await admin.createDepartment({ name: "Legal", colorToken: "--dept-6" });
    expect(snapshot()).not.toBe(seed);
    resetApi();
    expect(JSON.parse(snapshot())).toMatchObject({
      ...JSON.parse(seed),
      secrets: expect.anything(),
    });
    expect(state.changelog.map((e) => e.id)).toEqual(seedChangelog().map((e) => e.id));
    expect(VIEW_AS_PERSONAS.map((p) => p.personId)).toContain("p-marco");
  });
});

// Le voci con gli insiemi interi di prima e dopo («Show details» del
// registro). `writeAccess` cambia lo stesso oggetto in posto: l'insieme di
// prima va fotografato PRIMA della scrittura, o la voce dice before = after.
describe("prima e dopo nelle voci dei permessi", () => {
  beforeEach(() => {
    as("p-roberta");
    reauth("p-roberta");
  });

  it("updateRole: before è l'insieme di prima, after quello salvato", async () => {
    const before = [...accessState().roles.find((r) => r.id === roleIdOf("au-1"))!.permissions];
    expect(before).toEqual(["usage.view", "changelog.view"]);
    expect(
      await admin.updateRole(roleIdOf("au-1"), { permissions: ["changelog.view", "monitor.view"] }),
    ).toEqual({ ok: true });
    const entry = state.changelog.at(-1)!;
    expect(entry.kind).toBe("role.updated");
    expect(entry.params).toMatchObject({
      added: "monitor.view",
      removed: "usage.view",
      before: "usage.view,changelog.view",
      after: "changelog.view,monitor.view",
    });
    expect(entry.params.before).not.toBe(entry.params.after);
  });

  it("setDepartmentPermissions: before è l'insieme di prima, after quello salvato", async () => {
    expect(dept("dep-development").projectPermissions).toEqual(["support.reply"]);
    expect(
      await admin.setDepartmentPermissions("dep-development", ["support.reply", "docs.edit"]),
    ).toEqual({ ok: true });
    const entry = state.changelog.at(-1)!;
    expect(entry.kind).toBe("department.permissions_changed");
    expect(entry.params).toMatchObject({
      added: "docs.edit",
      removed: "",
      before: "support.reply",
      after: "support.reply,docs.edit",
    });
    expect(entry.params.before).not.toBe(entry.params.after);
  });
});
