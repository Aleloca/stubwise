import { beforeEach, describe, expect, it } from "vitest";
import { resetApi } from "../api";
import { state } from "../store";
import { DEPARTMENTS } from "../seed/departments";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { PROJECTS } from "../seed/projects";
import {
  CLAUDE_INSTANCE_PERMISSIONS,
  CLAUDE_PROJECT_PERMISSIONS,
  VIEW_AS_PERSONAS,
  can,
  canInDepartment,
  grantProjectRole,
  resetViewerGrants,
  viewerFor,
  type Permission,
} from "../viewer";
import {
  ALL_PROJECT_PERMISSIONS,
  INSTANCE_SET,
  accessState,
  effectivePermissions,
  isMember,
  roleIdOf,
  seedAccessState,
  writeAccess,
} from "./index";
import {
  PARITY_CAN,
  PARITY_DEPARTMENT_HOME,
  PARITY_DEPARTMENT_IDS,
  PARITY_PERMISSIONS,
  PARITY_PROJECT_IDS,
} from "./parity.fixture";

beforeEach(() => resetApi());

const hexToBits = (hex: string, n: number): boolean[] =>
  [...hex]
    .flatMap((d) => parseInt(d, 16).toString(2).padStart(4, "0").split(""))
    .slice(0, n)
    .map((b) => b === "1");

/**
 * Le sole differenze ammesse fra la `can()` di prima e quella di adesso, una
 * per una col motivo. Il permesso di reparto di Development (`support.reply`)
 * potrebbe aggiungerne, ma non ne aggiunge: i membri di Development sono
 * Developer o Project Lead in ogni progetto dove sono membri, e quel permesso
 * l'avevano già dal ruolo. Il test sotto «fonti» lo verifica.
 */
const ALLOWED_DIFFERENCES: readonly {
  personId: string;
  permission: string;
  projectId: string | null;
  reason: string;
}[] = [];

describe("parità con la can() delle aree 2–8 (fixture generato prima del cambio)", () => {
  it("il fixture copre ogni persona del seme, Claude compreso, e ogni progetto", () => {
    expect(Object.keys(PARITY_CAN).sort()).toEqual(PEOPLE.map((p) => p.id).sort());
    expect(PARITY_CAN[CLAUDE_ID]).toBeDefined();
    expect(PARITY_PROJECT_IDS).toEqual(PROJECTS.map((p) => p.id));
    expect(PARITY_DEPARTMENT_IDS).toEqual(DEPARTMENTS.map((d) => d.id));
  });

  it("can() = fixture per ogni persona × permesso × progetto, salvo le differenze elencate", () => {
    const projects: (string | undefined)[] = [undefined, ...PARITY_PROJECT_IDS];
    const found: string[] = [];
    for (const [personId, rows] of Object.entries(PARITY_CAN)) {
      const viewer = viewerFor(personId);
      for (const perm of PARITY_PERMISSIONS) {
        const before = hexToBits(rows[perm]!, projects.length);
        projects.forEach((projectId, i) => {
          const now = can(viewer, perm as Permission, projectId);
          if (now === before[i]) return;
          const allowed = ALLOWED_DIFFERENCES.some(
            (d) =>
              d.personId === personId &&
              d.permission === perm &&
              d.projectId === (projectId ?? null),
          );
          if (allowed && projectId) {
            // Dove è ammessa, la differenza viene dal reparto.
            expect(effectivePermissions(personId, projectId).get(perm)).toContainEqual(
              expect.objectContaining({ kind: "department" }),
            );
          }
          if (!allowed)
            found.push(`${personId} ${perm} ${projectId ?? "-"}: ${before[i]} → ${now}`);
        });
      }
    }
    expect(found).toEqual([]);
  });

  it("canInDepartment = fixture, per ogni persona e reparto", () => {
    for (const [personId, bits] of Object.entries(PARITY_DEPARTMENT_HOME)) {
      PARITY_DEPARTMENT_IDS.forEach((departmentId, i) => {
        expect(
          canInDepartment(viewerFor(personId), "department.home.manage", departmentId),
          `${personId} ${departmentId}`,
        ).toBe(bits[i] === "1");
      });
    }
  });
});

describe("le fonti dei permessi", () => {
  it("Marco su ACQ ha `servers.operate` da una concessione personale", () => {
    const sources = effectivePermissions("p-marco", "prj-acq").get("servers.operate");
    expect(sources).toEqual([expect.objectContaining({ kind: "grant", grantedById: "p-roberta" })]);
    // Il resto viene dal ruolo Developer.
    expect(effectivePermissions("p-marco", "prj-acq").get("runs.start")).toEqual([
      { kind: "role", roleId: roleIdOf("developer") },
    ]);
  });

  it("Roberta ha `full_admin` su tutto: ogni permesso d'istanza e di progetto, membro o no", () => {
    const instance = effectivePermissions("p-roberta");
    for (const p of INSTANCE_SET) {
      expect(instance.get(p), p).toContainEqual({ kind: "full_admin" });
    }
    for (const project of PROJECTS) {
      const map = effectivePermissions("p-roberta", project.id);
      for (const p of ALL_PROJECT_PERMISSIONS) {
        expect(map.get(p), `${p} ${project.code}`).toContainEqual({ kind: "full_admin" });
      }
    }
  });

  it("Development porta `support.reply`, con fonte il reparto, dove i suoi membri sono già membri", () => {
    const dev = accessState().departments.find((d) => d.departmentId === "dep-development")!;
    expect(dev.projectPermissions).toEqual(["support.reply"]);
    for (const personId of dev.memberIds) {
      for (const project of PROJECTS) {
        const sources = effectivePermissions(personId, project.id).get("support.reply") ?? [];
        const fromDept = sources.some((s) => s.kind === "department");
        expect(fromDept, `${personId} ${project.code}`).toBe(isMember(personId, project.id));
        // Nessuno lo guadagna: chi lo ha dal reparto lo ha anche dal ruolo.
        if (fromDept) expect(sources.some((s) => s.kind === "role")).toBe(true);
      }
    }
  });

  it("R-E2: `people.activity.view` è derivato (dal ruolo Project Lead), non salvato", () => {
    expect(accessState().grants.some((g) => g.permission === "people.activity.view")).toBe(false);
    expect(effectivePermissions("p-laura").get("people.activity.view")).toEqual([
      { kind: "role", roleId: roleIdOf("project_lead") },
    ]);
    expect(effectivePermissions("p-marco").has("people.activity.view")).toBe(false);
    // Diventare Project Lead lo dà; tornare Developer lo toglie.
    grantProjectRole("p-marco", "prj-stw", "project_lead");
    expect(can(viewerFor("p-marco"), "people.activity.view")).toBe(true);
    grantProjectRole("p-marco", "prj-stw", "developer");
    expect(can(viewerFor("p-marco"), "people.activity.view")).toBe(false);
  });

  it("`automations.manage` a due livelli: la concessione d'istanza di Matteo resta", () => {
    expect(effectivePermissions("p-matteo").get("automations.manage")).toEqual([
      expect.objectContaining({ kind: "grant" }),
    ]);
    expect(effectivePermissions("p-matteo", "prj-aud").get("automations.manage")).toEqual([
      { kind: "role", roleId: roleIdOf("project_lead") },
    ]);
  });

  it("i preset Admin portano i tre permessi nuovi; nessun preset di progetto ha `servers.operate`", () => {
    const roles = accessState().roles;
    const admin = roles.find((r) => r.key === "admin")!;
    for (const p of ["departments.manage", "instance.status.view", "changelog.view"]) {
      expect(admin.permissions).toContain(p);
      expect(roles.find((r) => r.key === "user")!.permissions).not.toContain(p);
    }
    expect(admin.permissions).toContain("servers.ssh.manage");
    for (const r of roles.filter((x) => x.scope === "project" && x.preset)) {
      expect(r.permissions, r.key).not.toContain("servers.operate");
    }
  });

  it("i due ruoli fatti a mano del seme: Release manager e Auditor", () => {
    const roles = accessState().roles;
    const dev = roles.find((r) => r.key === "developer")!;
    const rm = roles.find((r) => r.name === "Release manager")!;
    expect(rm).toMatchObject({ scope: "project", preset: false });
    expect(rm.permissions.sort()).toEqual([...dev.permissions, "release.merge"].sort());
    expect(roles.find((r) => r.name === "Auditor")).toMatchObject({
      scope: "instance",
      preset: false,
      permissions: ["usage.view", "changelog.view"],
    });
  });
});

describe("Claude, insieme fisso (R-L9, R-L11)", () => {
  const claude = () => viewerFor(CLAUDE_ID);

  it("le due costanti sono quelle di prima: uguali a ciò che la can() di prima gli dava", () => {
    const projects: (string | undefined)[] = [undefined, ...PARITY_PROJECT_IDS];
    const rows = PARITY_CAN[CLAUDE_ID]!;
    const projectBefore = PARITY_PERMISSIONS.filter(
      (p) => !INSTANCE_SET.has(p) && hexToBits(rows[p]!, projects.length)[1],
    );
    const instanceBefore = PARITY_PERMISSIONS.filter(
      (p) => INSTANCE_SET.has(p) && hexToBits(rows[p]!, projects.length)[0],
    );
    expect([...CLAUDE_PROJECT_PERMISSIONS].sort()).toEqual(projectBefore.sort());
    expect([...CLAUDE_INSTANCE_PERMISSIONS].sort()).toEqual(instanceBefore.sort());
  });

  it("cambiare il preset Developer nello stato non cambia `can(claude, …)`", () => {
    const before = PARITY_PERMISSIONS.map((p) => can(claude(), p as Permission, "prj-stw"));
    writeAccess((s) => {
      const dev = s.roles.find((r) => r.key === "developer")!;
      dev.permissions = ["docs.view"];
    });
    // Il preset è cambiato davvero: Marco non avvia più i run…
    expect(can(viewerFor("p-marco"), "runs.start", "prj-stw")).toBe(false);
    // …Claude sì, come prima.
    expect(PARITY_PERMISSIONS.map((p) => can(claude(), p as Permission, "prj-stw"))).toEqual(
      before,
    );
    expect(can(claude(), "runs.start", "prj-stw")).toBe(true);
  });

  it("non ha `departments.manage`, `instance.status.view` né `changelog.view`, nemmeno concessi", () => {
    writeAccess((s) => {
      for (const permission of ["departments.manage", "instance.status.view", "changelog.view"]) {
        s.grants.push({
          personId: CLAUDE_ID,
          projectId: null,
          permission,
          grantedById: null,
          at: "",
        });
      }
    });
    for (const p of ["departments.manage", "instance.status.view", "changelog.view"] as const) {
      expect(can(claude(), p), p).toBe(false);
      expect(CLAUDE_INSTANCE_PERMISSIONS.has(p)).toBe(false);
    }
  });

  it("non ha accessi nello stato: ruoli, appartenenze, reparti, persona", () => {
    const s = accessState();
    expect(s.people.some((p) => p.personId === CLAUDE_ID)).toBe(false);
    expect(s.memberships.some((m) => m.personId === CLAUDE_ID)).toBe(false);
    expect(s.departments.some((d) => d.memberIds.includes(CLAUDE_ID))).toBe(false);
    expect(effectivePermissions(CLAUDE_ID, "prj-stw").size).toBe(0);
    // `grantProjectRole` su Claude non gli dà un'appartenenza (e non lo tocca in `memberIds`).
    const acq = state.projectsById.get("prj-acq")!;
    const members = [...acq.memberIds];
    grantProjectRole(CLAUDE_ID, "prj-acq", "project_lead");
    expect(isMember(CLAUDE_ID, "prj-acq")).toBe(false);
    expect(acq.memberIds).toEqual(members);
  });
});

describe("permesso di reparto", () => {
  it("aggiungere Marco a Sales, con un permesso di reparto, non lo rende membro di nessun progetto nuovo", () => {
    const memberBefore = PROJECTS.map((p) => isMember("p-marco", p.id));
    const memberIdsBefore = state.projects.map((p) => [...p.memberIds]);
    const aud = "prj-aud";
    const mkx = "prj-mkx";
    expect(isMember("p-marco", aud)).toBe(true);
    expect(isMember("p-marco", mkx)).toBe(false);
    expect(can(viewerFor("p-marco"), "drive.history", aud)).toBe(false);

    writeAccess((s) => {
      const sales = s.departments.find((d) => d.departmentId === "dep-sales")!;
      sales.memberIds.push("p-marco");
      sales.projectPermissions.push("drive.history");
    });

    expect(PROJECTS.map((p) => isMember("p-marco", p.id))).toEqual(memberBefore);
    expect(state.projects.map((p) => p.memberIds)).toEqual(memberIdsBefore);
    // Lo ha dove è già membro, dal reparto; dove non lo è, no.
    expect(can(viewerFor("p-marco"), "drive.history", aud)).toBe(true);
    expect(effectivePermissions("p-marco", aud).get("drive.history")).toEqual([
      { kind: "department", departmentId: "dep-sales" },
    ]);
    expect(can(viewerFor("p-marco"), "drive.history", mkx)).toBe(false);
    expect(can(viewerFor("p-marco"), "tickets.view_all", mkx)).toBe(false);
    // Anche nel calcolo unico, non solo nel `Viewer`: «Chi può farlo?» legge da qui.
    expect(effectivePermissions("p-marco", mkx).size).toBe(0);
  });

  it("toglierlo dal reparto toglie il permesso, a lettura", () => {
    writeAccess((s) => {
      const sales = s.departments.find((d) => d.departmentId === "dep-sales")!;
      sales.memberIds.push("p-marco");
      sales.projectPermissions.push("drive.history");
    });
    const viewer = viewerFor("p-marco");
    expect(can(viewer, "drive.history", "prj-aud")).toBe(true);
    writeAccess((s) => {
      const sales = s.departments.find((d) => d.departmentId === "dep-sales")!;
      sales.memberIds = sales.memberIds.filter((id) => id !== "p-marco");
    });
    // Lo stesso `Viewer` di prima: si aggiorna da solo.
    expect(can(viewer, "drive.history", "prj-aud")).toBe(false);
    expect(viewer.projectPermissions["prj-aud"]).not.toContain("drive.history");
  });

  it("`department.home.manage` si legge da `homeManagerIds`", () => {
    expect(canInDepartment(viewerFor("p-marco"), "department.home.manage", "dep-sales")).toBe(
      false,
    );
    writeAccess((s) => {
      s.departments.find((d) => d.departmentId === "dep-sales")!.homeManagerIds.push("p-marco");
    });
    expect(canInDepartment(viewerFor("p-marco"), "department.home.manage", "dep-sales")).toBe(true);
    expect(can(viewerFor("p-marco"), "department.home.manage")).toBe(true);
  });
});

describe("appartenenze e `project.memberIds`", () => {
  it("dare un ruolo su un progetto ne rende membri: `memberIds` segue, il reset lo riporta", () => {
    const aud = state.projectsById.get("prj-aud")!;
    expect(aud.memberIds).not.toContain("p-irene");
    grantProjectRole("p-irene", "prj-aud", "viewer");
    expect(isMember("p-irene", "prj-aud")).toBe(true);
    expect(aud.memberIds).toContain("p-irene");
    expect(can(viewerFor("p-irene"), "tickets.view_all", "prj-aud")).toBe(true);
    resetViewerGrants();
    expect(isMember("p-irene", "prj-aud")).toBe(false);
    expect(aud.memberIds).not.toContain("p-irene");
  });

  it("nel seme, `memberIds` e le appartenenze dicono la stessa cosa (Claude a parte)", () => {
    for (const project of state.projects) {
      const humans = project.memberIds.filter((id) => id !== CLAUDE_ID).sort();
      const members = accessState()
        .memberships.filter((m) => m.projectId === project.id)
        .map((m) => m.personId)
        .sort();
      expect(members, project.code).toEqual(humans);
    }
  });
});

describe("persone: stato e secondo fattore", () => {
  it("Simone è disattivato da 10 giorni; tutti gli altri sono attivi", () => {
    const people = accessState().people;
    expect(people.find((p) => p.personId === "p-simone")).toMatchObject({
      status: "deactivated",
      deactivatedAt: "2026-10-13T12:00:00Z",
    });
    expect(people.filter((p) => p.status === "deactivated").map((p) => p.personId)).toEqual([
      "p-simone",
    ]);
    // Le sue task aperte restano dove sono.
    const open = state.tasks.filter(
      (t) => t.assigneeId === "p-simone" && state.statusById.get(t.statusId)!.family !== "closed",
    );
    expect(open.length).toBe(2);
  });

  it("tutti hanno il secondo fattore, tranne Sara", () => {
    for (const p of accessState().people) {
      if (p.personId === "p-sara") expect(p.secondFactor).toBeNull();
      else expect(p.secondFactor, p.personId).not.toBeNull();
    }
  });

  it("le persone del «vedi come» restano sei, coi loro `Viewer`", () => {
    expect(VIEW_AS_PERSONAS.map((p) => p.personId)).toEqual([
      "p-giulia",
      "p-marco",
      "p-laura",
      "p-sara",
      "p-matteo",
      "p-roberta",
    ]);
    for (const p of VIEW_AS_PERSONAS) expect(p.viewer).toBe(viewerFor(p.personId));
  });
});

describe("resetApi", () => {
  it("riporta gli accessi al seme, sullo stesso oggetto dello store", () => {
    writeAccess((s) => {
      s.roles.find((r) => r.key === "developer")!.permissions = [];
      s.memberships = [];
      s.grants = [];
      s.people[0]!.status = "deactivated";
    });
    grantProjectRole("p-irene", "prj-aud", "viewer");
    resetApi();
    expect(accessState()).toEqual(seedAccessState());
    expect(state.access).toBe(accessState());
    expect(can(viewerFor("p-marco"), "runs.start", "prj-stw")).toBe(true);
    expect(state.projectsById.get("prj-aud")!.memberIds).not.toContain("p-irene");
  });
});
