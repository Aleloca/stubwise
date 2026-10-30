import { PRESET_ROLES, PROJECT_PERMISSIONS } from "@stubwise/shared";
import type { DepartmentRole, LocalInstancePermission, LocalProjectPermission } from "../types";
import { daysFromToday } from "../seed/dates";
import { DEPARTMENTS } from "../seed/departments";
import { CLAUDE_ID, PEOPLE, SEED_DEPARTMENT_IDS } from "../seed/people";
import { GIULIA_LEAD_CODES, PROJECTS } from "../seed/projects";
import type {
  AccessState,
  DepartmentAccess,
  Membership,
  PersonAccess,
  PersonalGrant,
  RoleDef,
} from "./state";

// Il seme degli accessi: da qui parte lo stato `access` e qui torna `resetApi`.
// Riproduce i permessi delle aree 2–8 (il fixture di parità lo verifica);
// la sola aggiunta è il permesso di reparto di Development, che non cambia
// niente a nessuno (vedi `DEPARTMENT_PROJECT_PERMISSIONS`).

/**
 * Permessi di progetto che vivono solo nel prototipo, per preset: entrano nel
 * registro di `@stubwise/shared` quando si costruisce il backend.
 * `planning.others` è del Project Lead (e implicito per il full admin); i
 * canali della Chat (area 4) li crea il Project Lead o il Developer e li
 * gestisce il Project Lead. Il Drive (area 5): carica chiunque lavori nel
 * progetto (anche il Legacy Member, shape drive.md [A 14]), non il Viewer;
 * gestire e vedere lo storico delle aperture è del Project Lead. Le
 * automazioni del progetto (area 7) le gestisce il Project Lead. Ai clienti di
 * Support (area 8a) risponde chi lavora al progetto: Project Lead, Developer e
 * Legacy Member, non il Contributor né il Viewer. `servers.operate` (area 8b)
 * non è di nessun preset: si dà persona per persona (`SEED_PROJECT_GRANTS`).
 */
export const LOCAL_PROJECT_PERMISSIONS: Readonly<
  Record<string, readonly LocalProjectPermission[]>
> = {
  project_lead: [
    "planning.others",
    "chat.channels.create",
    "chat.channels.manage",
    "drive.upload",
    "drive.manage",
    "drive.history",
    "automations.manage",
    "support.reply",
  ],
  developer: ["chat.channels.create", "drive.upload", "support.reply"],
  contributor: ["drive.upload"],
  legacy_member: ["drive.upload", "support.reply"],
};

/**
 * I permessi d'istanza del prototipo dei due preset. «Vedere le conversazioni
 * pubbliche con Claude» e «creare canali generali» a User e Admin; «gestire i
 * canali generali», le automazioni generali (area 7), gli accessi SSH dei
 * server (area 8b) e i tre dell'area 9a (reparti, stato dell'istanza,
 * registro delle modifiche) all'Admin. Prima erano cablati su
 * `key === "admin"`: ora sono permessi del ruolo, modificabili.
 */
const LOCAL_INSTANCE_BY_PRESET: Readonly<Record<string, readonly LocalInstancePermission[]>> = {
  user: ["claude.public.view", "chat.general.create"],
  admin: [
    "claude.public.view",
    "chat.general.create",
    "chat.general.manage",
    "automations.manage",
    "servers.ssh.manage",
    "departments.manage",
    "instance.status.view",
    "changelog.view",
  ],
};

export const roleIdOf = (key: string): string => `role-${key}`;

function presetRole(key: string): RoleDef {
  const preset = PRESET_ROLES.find((r) => r.key === key);
  if (!preset) throw new Error(`Unknown preset role: ${key}`);
  const local =
    preset.scope === "instance"
      ? (LOCAL_INSTANCE_BY_PRESET[key] ?? [])
      : (LOCAL_PROJECT_PERMISSIONS[key] ?? []);
  return {
    id: roleIdOf(key),
    key,
    scope: preset.scope,
    name: preset.name,
    preset: true,
    permissions: [...preset.permissions, ...local],
  };
}

function seedRoles(): RoleDef[] {
  const presets = PRESET_ROLES.map((r) => presetRole(r.key));
  const developer = presets.find((r) => r.key === "developer")!;
  return [
    ...presets,
    // I due ruoli fatti a mano del seme (design, «Dati finti»).
    {
      id: roleIdOf("rm-1"),
      key: "rm-1",
      scope: "project",
      name: "Release manager",
      preset: false,
      permissions: [...developer.permissions, "release.merge"],
    },
    {
      id: roleIdOf("au-1"),
      key: "au-1",
      scope: "instance",
      name: "Auditor",
      preset: false,
      permissions: ["usage.view", "changelog.view"],
    },
  ];
}

/**
 * Il ruolo di progetto tipico di una persona del seme: Giulia è Project Lead
 * nei suoi cinque progetti e Contributor altrove; un admin è Project Lead
 * dove è membro; gli altri hanno il loro ruolo tipico ovunque.
 */
function typicalProjectRole(personId: string, presetRole: string, code: string): string {
  if (personId === "p-giulia") {
    return (GIULIA_LEAD_CODES as readonly string[]).includes(code) ? "project_lead" : "contributor";
  }
  return presetRole === "admin" ? "project_lead" : presetRole;
}

const HUMANS = PEOPLE.filter((p) => !p.isClaude);

function seedMemberships(): Membership[] {
  const out: Membership[] = [];
  for (const project of PROJECTS) {
    for (const personId of project.memberIds) {
      // R-L9: Claude è membro implicito di ogni progetto, senza appartenenze.
      if (personId === CLAUDE_ID) continue;
      const person = HUMANS.find((p) => p.id === personId)!;
      out.push({
        personId,
        projectId: project.id,
        roleId: roleIdOf(typicalProjectRole(personId, person.presetRole, project.code)),
      });
    }
  }
  return out;
}

// Le concessioni personali del seme: permessi dati a una persona, in più del
// suo ruolo (che resta com'è).
//
// R-J10 (area 7): Matteo possiede «Nuovo contratto» (AUT-1), un'automazione
// generale, quindi ha `automations.manage` d'istanza; la sua casella è
// collegata, così le email dell'automazione partono davvero.
export const SEED_INSTANCE_GRANTS: Record<string, readonly LocalInstancePermission[]> = {
  "p-matteo": ["automations.manage"],
};

// Per progetto (codice), sulle righe dei progetti di cui la persona è membro.
//
// Area 8b: `servers.operate` non sta in nessun preset (spec «Permessi»): si dà
// persona per persona. Marco (Developer) avvia la correzione dei server di ACQ
// ma non approva il proprio piano; Laura (Project Lead) lo approva ma non la
// avvia. Dall'area 9a si assegna da Members.
export const SEED_PROJECT_GRANTS: Record<
  string,
  Record<string, readonly LocalProjectPermission[]>
> = {
  "p-marco": { ACQ: ["servers.operate"] },
};

/** Chi ha dato le concessioni del seme, e quando: si vedono in Members («aggiunto da Roberta…»). */
const SEED_GRANTED_BY = "p-roberta";
const SEED_GRANTED_AT = `${daysFromToday(-20)}T10:00:00Z`;

function seedGrants(): PersonalGrant[] {
  const out: PersonalGrant[] = [];
  for (const [personId, perms] of Object.entries(SEED_INSTANCE_GRANTS)) {
    for (const permission of perms) {
      out.push({
        personId,
        projectId: null,
        permission,
        grantedById: SEED_GRANTED_BY,
        at: SEED_GRANTED_AT,
      });
    }
  }
  for (const [personId, byCode] of Object.entries(SEED_PROJECT_GRANTS)) {
    for (const [code, perms] of Object.entries(byCode)) {
      const projectId = PROJECTS.find((p) => p.code === code)!.id;
      for (const permission of perms) {
        out.push({
          personId,
          projectId,
          permission,
          grantedById: SEED_GRANTED_BY,
          at: SEED_GRANTED_AT,
        });
      }
    }
  }
  return out;
}

/** Ruoli di reparto del seme: chi gestisce la Home di quale reparto. */
export const DEPARTMENT_ROLES: DepartmentRole[] = [
  { personId: "p-giulia", departmentId: "dep-marketing", permissions: ["department.home.manage"] },
  { personId: "p-laura", departmentId: "dep-development", permissions: ["department.home.manage"] },
  { personId: "p-matteo", departmentId: "dep-sales", permissions: ["department.home.manage"] },
  { personId: "p-giorgio", departmentId: "dep-administration", permissions: [] },
];

/**
 * I permessi di progetto che un reparto dà ai suoi membri (design, «Permessi
 * del reparto»). L'esempio del design: tutto Development risponde ai
 * clienti. Oggi non cambia niente a nessuno: i membri di Development sono
 * Developer o Project Lead, che `support.reply` l'hanno già dal ruolo.
 */
const DEPARTMENT_PROJECT_PERMISSIONS: Record<string, readonly string[]> = {
  "dep-development": ["support.reply"],
};

function seedDepartments(): DepartmentAccess[] {
  return DEPARTMENTS.map((d) => ({
    departmentId: d.id,
    memberIds: HUMANS.filter((p) => SEED_DEPARTMENT_IDS[p.id]?.includes(d.id)).map((p) => p.id),
    homeManagerIds: DEPARTMENT_ROLES.filter(
      (r) => r.departmentId === d.id && r.permissions.includes("department.home.manage"),
    ).map((r) => r.personId),
    projectPermissions: [...(DEPARTMENT_PROJECT_PERMISSIONS[d.id] ?? [])],
  }));
}

/** Simone ha lasciato il team dieci giorni fa: è disattivato, le sue task restano dove sono. */
export const DEACTIVATED_SEED: Readonly<Record<string, string>> = {
  "p-simone": `${daysFromToday(-10)}T12:00:00Z`,
};

/** Sara non ha attivato il secondo fattore; Roberta ha anche una seconda passkey. */
const NO_SECOND_FACTOR = new Set(["p-sara"]);

function seedPeople(): PersonAccess[] {
  return HUMANS.map((p) => {
    const deactivatedAt = DEACTIVATED_SEED[p.id] ?? null;
    return {
      personId: p.id,
      instanceRoleId: roleIdOf(p.presetRole === "admin" ? "admin" : "user"),
      status: deactivatedAt ? "deactivated" : "active",
      deactivatedAt,
      secondFactor: NO_SECOND_FACTOR.has(p.id)
        ? null
        : { totp: true, passkeys: p.id === "p-roberta" ? 2 : 1, backupCodesLeft: 10 },
    };
  });
}

/** Lo stato degli accessi del seme, nuovo a ogni chiamata. */
export function seedAccessState(): AccessState {
  return {
    roles: seedRoles(),
    memberships: seedMemberships(),
    grants: seedGrants(),
    departments: seedDepartments(),
    people: seedPeople(),
    revocations: [],
  };
}

/** Ogni permesso di progetto, del registro condiviso e del prototipo (quelli che il full admin ha ovunque). */
export const ALL_PROJECT_PERMISSIONS: readonly string[] = [
  ...PROJECT_PERMISSIONS,
  ...new Set([...Object.values(LOCAL_PROJECT_PERMISSIONS).flat(), "servers.operate"]),
];
