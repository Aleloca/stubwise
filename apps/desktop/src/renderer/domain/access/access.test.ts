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
import { checkEscalation, checkTarget } from "./escalation";
import { lastFullAdminBlock, lastMembersManagerBlock, membersManagersOf } from "./guards";

beforeEach(() => resetApi());

const pid = (code: string) => PROJECTS.find((p) => p.code === code)!.id;
const ACQ = pid("ACQ");
const AUD = pid("AUD");

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

describe("checkTarget", () => {
  it("Laura su Roberta: target_above, in ogni progetto e nell'istanza", () => {
    expect(
      checkTarget(effectivePermissions("p-laura", ACQ), effectivePermissions("p-roberta", ACQ)),
    ).toEqual({ ok: false, error: "target_above" });
    expect(checkTarget(effectivePermissions("p-laura"), effectivePermissions("p-roberta"))).toEqual(
      { ok: false, error: "target_above" },
    );
  });

  it("Laura su Marco in AUD: ok (Developer è contenuto nel Project Lead)", () => {
    expect(
      checkTarget(effectivePermissions("p-laura", AUD), effectivePermissions("p-marco", AUD)),
    ).toEqual({ ok: true });
  });

  it("Laura su Marco in ACQ: target_above, per la concessione servers.operate che Laura non ha", () => {
    expect(effectivePermissions("p-laura", ACQ).has("servers.operate")).toBe(false);
    expect(
      checkTarget(effectivePermissions("p-laura", ACQ), effectivePermissions("p-marco", ACQ)),
    ).toEqual({ ok: false, error: "target_above" });
  });

  it("un full admin non è mai sopra un altro full admin", () => {
    const roberta = effectivePermissions("p-roberta", ACQ);
    expect(checkTarget(roberta, roberta)).toEqual({ ok: true });
    expect(checkTarget(roberta, effectivePermissions("p-laura", ACQ))).toEqual({ ok: true });
  });

  it("chi non è full admin non tocca un full admin, anche avendo gli stessi permessi", () => {
    const roberta = effectivePermissions("p-roberta", ACQ);
    const sameKeysNoAdmin = new Map(
      [...roberta.keys()].map((p) => [p, [{ kind: "role" as const, roleId: "r" }]]),
    );
    expect(checkTarget(sameKeysNoAdmin, roberta)).toEqual({ ok: false, error: "target_above" });
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
  /** Un progetto di Laura senza full admin membri in cui Laura è l'unica a gestire i membri. */
  const lauraAlone = (s: AccessState): string =>
    PROJECTS.find(
      (p) =>
        p.memberIds.includes("p-laura") &&
        !p.memberIds.includes("p-roberta") &&
        membersManagersOf(s, p.id).join() === "p-laura",
    )!.id;

  it("su un progetto di Laura senza full admin membri, toglierle il permesso è bloccato", () => {
    const s = seedCopy();
    const projectId = lauraAlone(s);
    expect(
      lastMembersManagerBlock(s, projectId, { personId: "p-laura", losesMembersManage: true }),
    ).toBe("last_members_manager");
  });

  it("su ACQ c'è anche Matteo (Project Lead): Laura può perderlo", () => {
    const s = seedCopy();
    expect(membersManagersOf(s, ACQ).sort()).toEqual(["p-laura", "p-matteo"]);
    expect(
      lastMembersManagerBlock(s, ACQ, { personId: "p-laura", losesMembersManage: true }),
    ).toBeNull();
  });

  it("un full admin membro conta come gestore", () => {
    const s = seedCopy();
    const projectId = lauraAlone(s);
    s.memberships.push({ personId: "p-roberta", projectId, roleId: roleIdOf("viewer") });
    expect(membersManagersOf(s, projectId).sort()).toEqual(["p-laura", "p-roberta"]);
    expect(
      lastMembersManagerBlock(s, projectId, { personId: "p-laura", losesMembersManage: true }),
    ).toBeNull();
  });

  it("un gestore disattivato non conta", () => {
    const s = seedCopy();
    const projectId = lauraAlone(s);
    const other = s.memberships.find((m) => m.projectId === projectId && m.personId !== "p-laura")!;
    other.roleId = roleIdOf("project_lead");
    expect(
      lastMembersManagerBlock(s, projectId, { personId: "p-laura", losesMembersManage: true }),
    ).toBeNull();
    s.people.find((p) => p.personId === other.personId)!.status = "deactivated";
    expect(
      lastMembersManagerBlock(s, projectId, { personId: "p-laura", losesMembersManage: true }),
    ).toBe("last_members_manager");
  });

  it("un secondo gestore da una concessione personale sblocca", () => {
    const s = seedCopy();
    const projectId = lauraAlone(s);
    const other = s.memberships.find(
      (m) => m.projectId === projectId && m.personId !== "p-laura",
    )!.personId;
    s.grants.push({
      personId: other,
      projectId,
      permission: "project.members.manage",
      grantedById: "p-laura",
      at: "2026-10-01T10:00:00Z",
    });
    expect(
      lastMembersManagerBlock(s, projectId, { personId: "p-laura", losesMembersManage: true }),
    ).toBeNull();
  });

  it("un secondo gestore dal reparto sblocca (permesso di reparto, da membro)", () => {
    const s = seedCopy();
    const projectId = lauraAlone(s);
    const dep = s.departments.find((d) =>
      d.memberIds.some(
        (id) =>
          id !== "p-laura" &&
          s.memberships.some((m) => m.personId === id && m.projectId === projectId),
      ),
    )!;
    dep.projectPermissions.push("project.members.manage");
    expect(
      lastMembersManagerBlock(s, projectId, { personId: "p-laura", losesMembersManage: true }),
    ).toBeNull();
  });

  it("chi non gestisce i membri, o una modifica che non lo toglie, passa", () => {
    const s = seedCopy();
    const projectId = lauraAlone(s);
    expect(
      lastMembersManagerBlock(s, projectId, { personId: "p-laura", losesMembersManage: false }),
    ).toBeNull();
    expect(
      lastMembersManagerBlock(s, projectId, { personId: "p-marco", losesMembersManage: true }),
    ).toBeNull();
  });

  it("un full admin che non è membro non conta", () => {
    const s = seedCopy();
    const projectId = lauraAlone(s);
    expect(effectivePermissions("p-roberta", projectId).has("project.members.manage")).toBe(true);
    expect(membersManagersOf(s, projectId)).not.toContain("p-roberta");
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
