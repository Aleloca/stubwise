import { INSTANCE_PERMISSIONS, PROJECT_PERMISSIONS } from "@stubwise/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { resetApi } from "../../data/api";
import {
  ALL_PROJECT_PERMISSIONS,
  INSTANCE_SET,
  LOCAL_INSTANCE_PERMISSIONS,
  accessState,
  effectivePermissions,
  roleIdOf,
  seedAccessState,
  writeAccess,
  type AccessState,
} from "../../data/access/index";
import { PROJECTS } from "../../data/seed/projects";
import en from "../../i18n/locales/en.json";
import it_ from "../../i18n/locales/it.json";
import { ACTIONS, INSTANCE_GROUPS, PROJECT_GROUPS, groupOf, groupPermissions } from "./actions";
import { checkEscalation } from "./escalation";
import { lastFullAdminBlock, lastMembersManagerBlock, membersManagersOf } from "./guards";

beforeEach(() => resetApi());

const pid = (code: string) => PROJECTS.find((p) => p.code === code)!.id;
const ACQ = pid("ACQ");

describe("checkEscalation", () => {
  // Nel seme il Project Lead ha ogni permesso di progetto del web, quindi
  // anche `release.merge`: a Laura su ACQ manca solo `servers.operate`, che non
  // è di nessun preset. Il caso del brief («Laura → release.merge») si prova
  // togliendoglielo prima.
  it("Laura non dà servers.operate su ACQ: non ce l'ha", () => {
    expect(checkEscalation(effectivePermissions("p-laura", ACQ), ["servers.operate"])).toEqual({
      ok: false,
      error: "escalation",
      missing: ["servers.operate"],
    });
  });

  it("Laura senza release.merge su ACQ non lo dà a nessuno", () => {
    expect(checkEscalation(effectivePermissions("p-laura", ACQ), ["release.merge"])).toEqual({
      ok: true,
    });
    writeAccess((s) =>
      s.revocations.push({ personId: "p-laura", projectId: ACQ, permission: "release.merge" }),
    );
    expect(checkEscalation(effectivePermissions("p-laura", ACQ), ["release.merge"])).toEqual({
      ok: false,
      error: "escalation",
      missing: ["release.merge"],
    });
  });

  it("missing elenca solo ciò che manca, una volta sola e in ordine", () => {
    // Marco è Developer: niente release.merge, plans.approve né la gestione.
    const marco = effectivePermissions("p-marco", ACQ);
    expect(
      checkEscalation(marco, ["plans.approve", "runs.start", "release.merge", "plans.approve"]),
    ).toEqual({ ok: false, error: "escalation", missing: ["plans.approve", "release.merge"] });
    expect(checkEscalation(marco, ["runs.start", "support.reply"])).toEqual({ ok: true });
  });

  it("Roberta (full admin) dà qualunque permesso, a ogni livello", () => {
    const anything = [...ALL_PROJECT_PERMISSIONS, ...INSTANCE_SET, "inventato.qualsiasi"];
    expect(checkEscalation(effectivePermissions("p-roberta", ACQ), anything)).toEqual({ ok: true });
    expect(checkEscalation(effectivePermissions("p-roberta"), anything)).toEqual({ ok: true });
    // Anche dove non è membro: il full admin ha tutto ovunque.
    const notHers = PROJECTS.find((p) => !p.memberIds.includes("p-roberta"))!.id;
    expect(checkEscalation(effectivePermissions("p-roberta", notHers), anything)).toEqual({
      ok: true,
    });
  });

  it("un permesso locale del prototipo conta come gli altri", () => {
    // drive.manage è del Project Lead, non del Developer.
    expect(checkEscalation(effectivePermissions("p-laura", ACQ), ["drive.manage"])).toEqual({
      ok: true,
    });
    expect(checkEscalation(effectivePermissions("p-marco", ACQ), ["drive.manage"])).toEqual({
      ok: false,
      error: "escalation",
      missing: ["drive.manage"],
    });
    // E una concessione personale (Marco, servers.operate su ACQ) è sua da dare.
    expect(checkEscalation(effectivePermissions("p-marco", ACQ), ["servers.operate"])).toEqual({
      ok: true,
    });
  });

  it("al livello d'istanza: un admin non full non dà instance.full_admin", () => {
    // Matteo ha automations.manage d'istanza da una concessione, non roles.manage.
    const matteo = effectivePermissions("p-matteo");
    expect(checkEscalation(matteo, ["automations.manage"])).toEqual({ ok: true });
    expect(checkEscalation(matteo, ["instance.full_admin"])).toEqual({
      ok: false,
      error: "escalation",
      missing: ["instance.full_admin"],
    });
  });
});

describe("escalation solo su ciò che si dà (maintainer, 30 ott 2026)", () => {
  // Niente gerarchia: chi gestisce i membri modifica chiunque. Conta solo
  // ciò che la modifica DÀ.
  it("Laura dà servers.operate a Federico su ACQ: escalation, non ce l'ha", () => {
    expect(effectivePermissions("p-laura", ACQ).has("servers.operate")).toBe(false);
    expect(checkEscalation(effectivePermissions("p-laura", ACQ), ["servers.operate"])).toEqual({
      ok: false,
      error: "escalation",
      missing: ["servers.operate"],
    });
  });

  it("Laura toglie servers.operate a Marco su ACQ: non dà niente, ok", () => {
    // Marco ha più permessi di Laura su ACQ: non conta.
    expect(effectivePermissions("p-marco", ACQ).has("servers.operate")).toBe(true);
    expect(checkEscalation(effectivePermissions("p-laura", ACQ), [])).toEqual({ ok: true });
  });

  it("Laura cambia il ruolo di Marco in Developer: dà i permessi del ruolo, che ha", () => {
    const developer = accessState().roles.find((r) => r.key === "developer")!;
    expect(checkEscalation(effectivePermissions("p-laura", ACQ), developer.permissions)).toEqual({
      ok: true,
    });
  });

  it("Laura toglie Marco da ACQ: non dà niente, ok", () => {
    expect(checkEscalation(effectivePermissions("p-laura", ACQ), [])).toEqual({ ok: true });
  });

  it("Laura assegna Release manager: dà release.merge, che ha dal Project Lead", () => {
    const rm = accessState().roles.find((r) => r.key === "rm-1")!;
    expect(checkEscalation(effectivePermissions("p-laura", ACQ), rm.permissions)).toEqual({
      ok: true,
    });
    // Marco no: release.merge gli manca.
    expect(checkEscalation(effectivePermissions("p-marco", ACQ), rm.permissions)).toEqual({
      ok: false,
      error: "escalation",
      missing: ["release.merge"],
    });
  });
});

/** Una copia dello stato del seme, da modificare nel test senza toccare quello vivo. */
const seedCopy = (): AccessState => seedAccessState();

const withSecondFullAdmin = (s: AccessState, personId: string): AccessState => {
  s.people.find((p) => p.personId === personId)!.instanceRoleId = roleIdOf("admin");
  return s;
};

describe("lastFullAdminBlock", () => {
  it("nel seme Roberta è l'unica full admin: perderlo è bloccato", () => {
    const s = seedCopy();
    expect(lastFullAdminBlock(s, { personId: "p-roberta", losesFullAdmin: true })).toBe(
      "last_full_admin",
    );
  });

  it("una modifica che non toglie il full admin, o a chi non lo è, passa", () => {
    const s = seedCopy();
    expect(lastFullAdminBlock(s, { personId: "p-roberta", losesFullAdmin: false })).toBeNull();
    expect(lastFullAdminBlock(s, { personId: "p-laura", losesFullAdmin: true })).toBeNull();
  });

  it("con due full admin attivi, togliere il ruolo a uno passa", () => {
    const s = withSecondFullAdmin(seedCopy(), "p-laura");
    expect(lastFullAdminBlock(s, { personId: "p-roberta", losesFullAdmin: true })).toBeNull();
    expect(lastFullAdminBlock(s, { personId: "p-laura", losesFullAdmin: true })).toBeNull();
  });

  it("anche una concessione d'istanza di instance.full_admin conta", () => {
    const s = seedCopy();
    s.grants.push({
      personId: "p-marco",
      projectId: null,
      permission: "instance.full_admin",
      grantedById: "p-roberta",
      at: "2026-10-01T10:00:00Z",
    });
    expect(lastFullAdminBlock(s, { personId: "p-roberta", losesFullAdmin: true })).toBeNull();
  });

  it("un secondo full admin disattivato non conta", () => {
    const s = withSecondFullAdmin(seedCopy(), "p-simone");
    expect(s.people.find((p) => p.personId === "p-simone")!.status).toBe("deactivated");
    expect(lastFullAdminBlock(s, { personId: "p-roberta", losesFullAdmin: true })).toBe(
      "last_full_admin",
    );
  });

  it("non legge lo stato vivo: lavora su quello che riceve", () => {
    const s = withSecondFullAdmin(seedCopy(), "p-laura");
    expect(accessState().people.find((p) => p.personId === "p-laura")!.instanceRoleId).not.toBe(
      roleIdOf("admin"),
    );
    expect(lastFullAdminBlock(s, { personId: "p-roberta", losesFullAdmin: true })).toBeNull();
  });
});

describe("lastMembersManagerBlock", () => {
  /**
   * Uno stato costruito apposta (maintainer, 30 ott 2026): un progetto, due
   * persone, nessun full admin. Nel seme non può succedere — resta sempre
   * un full admin, e i full admin contano ovunque — ma la guardia resta.
   */
  const P = "prj-x";
  const twoPeopleNoAdmin = (): AccessState => {
    const s = seedCopy();
    const person = (personId: string) => ({
      personId,
      instanceRoleId: roleIdOf("user"),
      status: "active" as const,
      deactivatedAt: null,
      secondFactor: null,
    });
    s.people = [person("p-anna"), person("p-bruno")];
    s.memberships = [
      { personId: "p-anna", projectId: P, roleId: roleIdOf("project_lead") },
      { personId: "p-bruno", projectId: P, roleId: roleIdOf("developer") },
    ];
    s.grants = [];
    s.departments = [];
    s.revocations = [];
    return s;
  };
  const annaLoses = { personId: "p-anna", losesMembersManage: true };

  it("l'unico gestore, senza full admin, non lo perde", () => {
    const s = twoPeopleNoAdmin();
    expect(membersManagersOf(s, P)).toEqual(["p-anna"]);
    expect(lastMembersManagerBlock(s, P, annaLoses)).toBe("last_members_manager");
  });

  it("chi non gestisce i membri, o una modifica che non lo toglie, passa", () => {
    const s = twoPeopleNoAdmin();
    expect(lastMembersManagerBlock(s, P, { ...annaLoses, losesMembersManage: false })).toBeNull();
    expect(
      lastMembersManagerBlock(s, P, { personId: "p-bruno", losesMembersManage: true }),
    ).toBeNull();
  });

  it("un secondo gestore da una concessione personale sblocca", () => {
    const s = twoPeopleNoAdmin();
    s.grants.push({
      personId: "p-bruno",
      projectId: P,
      permission: "project.members.manage",
      grantedById: "p-anna",
      at: "2026-10-01T10:00:00Z",
    });
    expect(lastMembersManagerBlock(s, P, annaLoses)).toBeNull();
  });

  it("un secondo gestore dal reparto sblocca (permesso di reparto, da membro)", () => {
    const s = twoPeopleNoAdmin();
    s.departments.push({
      departmentId: "dep-x",
      memberIds: ["p-bruno"],
      homeManagerIds: [],
      projectPermissions: ["project.members.manage"],
    });
    expect(lastMembersManagerBlock(s, P, annaLoses)).toBeNull();
  });

  it("un gestore disattivato non conta", () => {
    const s = twoPeopleNoAdmin();
    s.memberships[1]!.roleId = roleIdOf("project_lead");
    expect(lastMembersManagerBlock(s, P, annaLoses)).toBeNull();
    s.people[1]!.status = "deactivated";
    expect(lastMembersManagerBlock(s, P, annaLoses)).toBe("last_members_manager");
  });

  it("un full admin attivo conta sempre, anche se non è membro", () => {
    const s = twoPeopleNoAdmin();
    s.people.push({
      personId: "p-carla",
      instanceRoleId: roleIdOf("admin"),
      status: "active",
      deactivatedAt: null,
      secondFactor: null,
    });
    expect(s.memberships.some((m) => m.personId === "p-carla")).toBe(false);
    expect(membersManagersOf(s, P).sort()).toEqual(["p-anna", "p-carla"]);
    expect(lastMembersManagerBlock(s, P, annaLoses)).toBeNull();
    // Disattivato non conta più.
    s.people[2]!.status = "deactivated";
    expect(lastMembersManagerBlock(s, P, annaLoses)).toBe("last_members_manager");
  });

  it("nel seme non scatta mai: Roberta conta ovunque", () => {
    const s = seedCopy();
    const lauraOnly = PROJECTS.find(
      (p) => p.memberIds.includes("p-laura") && !p.memberIds.includes("p-roberta"),
    )!.id;
    expect(membersManagersOf(s, lauraOnly)).toContain("p-roberta");
    expect(
      lastMembersManagerBlock(s, lauraOnly, { personId: "p-laura", losesMembersManage: true }),
    ).toBeNull();
    expect(
      lastMembersManagerBlock(s, ACQ, { personId: "p-laura", losesMembersManage: true }),
    ).toBeNull();
  });
});

describe("ACTIONS e gruppi", () => {
  it("il catalogo ha le azioni del brief", () => {
    const perms = (scope: string) =>
      ACTIONS.filter((a) => a.scope === scope).map((a) => a.permission);
    for (const p of [
      "plans.approve",
      "release.merge",
      "servers.operate",
      "project.members.manage",
      "support.reply",
      "planning.others",
      "automations.manage",
      "runs.start",
    ])
      expect(perms("project")).toContain(p);
    for (const p of ["servers.ssh.manage", "automations.manage"])
      expect(perms("instance")).toContain(p);
  });

  it("id unici, permessi del livello giusto, etichette in en e it", () => {
    expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length);
    const labels = (d: unknown, key: string) =>
      key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], d);
    for (const a of ACTIONS) {
      const universe = a.scope === "project" ? ALL_PROJECT_PERMISSIONS : [...INSTANCE_SET];
      expect(universe, a.id).toContain(a.permission);
      expect(typeof labels(en, a.labelKey), a.labelKey).toBe("string");
      expect(typeof labels(it_, a.labelKey), a.labelKey).toBe("string");
    }
  });

  it("ogni permesso sta in un solo gruppo del suo livello, ogni gruppo ha un'etichetta", () => {
    const check = (groups: typeof INSTANCE_GROUPS, universe: readonly string[]) => {
      const all = groups.flatMap((g) => g.permissions);
      expect(new Set(all).size).toBe(all.length);
      expect([...all].sort()).toEqual([...universe].sort());
      for (const g of groups) {
        expect(typeof (en.whoCan.groups as Record<string, string>)[g.key]).toBe("string");
        expect(typeof (it_.whoCan.groups as Record<string, string>)[g.key]).toBe("string");
      }
    };
    check(INSTANCE_GROUPS, [...INSTANCE_SET]);
    check(PROJECT_GROUPS, ALL_PROJECT_PERMISSIONS);
    // Gli 11 gruppi del web, più «prototype» a ogni livello.
    expect(INSTANCE_GROUPS.length + PROJECT_GROUPS.length).toBe(13);
    expect(INSTANCE_GROUPS.at(-1)!.permissions).toEqual(LOCAL_INSTANCE_PERMISSIONS);
    for (const p of INSTANCE_PERMISSIONS) expect(groupOf("instance", p)).not.toBe("prototype");
    for (const p of PROJECT_PERMISSIONS) expect(groupOf("project", p)).not.toBe("prototype");
  });

  it("groupPermissions segue l'ordine dei gruppi e salta quelli vuoti", () => {
    const entries = [{ permission: "release.merge" }, { permission: "project.members.manage" }];
    expect(groupPermissions("project", entries)).toEqual([
      { groupKey: "project", permissions: [{ permission: "project.members.manage" }] },
      { groupKey: "runs", permissions: [{ permission: "release.merge" }] },
    ]);
  });
});
