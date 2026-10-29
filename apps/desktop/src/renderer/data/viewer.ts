import {
  INSTANCE_PERMISSIONS,
  PRESET_ROLES,
  PROJECT_PERMISSIONS,
  effectiveInstancePermissions,
  type InstancePermission,
  type ProjectPermission,
} from "@stubwise/shared";
import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from "react";
import { DEPARTMENT_ROLES } from "./seed/departmentRoles";
import { SEED_INSTANCE_GRANTS, SEED_PROJECT_GRANTS } from "./seed/grants";
import { CLAUDE_ID, PEOPLE } from "./seed/people";
import { GIULIA_LEAD_CODES, PROJECTS } from "./seed/projects";
import { clearToasts } from "../tasks-ui/Toast";
import { DEFAULT_SESSION_PERSON_ID, runBeforePersonaChange, setSessionPersonId } from "./session";
import type {
  DepartmentPermission,
  LocalInstancePermission,
  LocalProjectPermission,
  Viewer,
} from "./types";

export type { LocalInstancePermission, LocalProjectPermission } from "./types";

export type Permission =
  | InstancePermission
  | LocalInstancePermission
  | ProjectPermission
  | LocalProjectPermission
  | DepartmentPermission;

type AnyProjectPermission = ProjectPermission | LocalProjectPermission;

/** I permessi d'istanza del prototipo, nell'ordine in cui si mostrano. */
export const LOCAL_INSTANCE_PERMISSIONS: readonly LocalInstancePermission[] = [
  "claude.public.view",
  "people.activity.view",
  "chat.general.create",
  "chat.general.manage",
  "automations.manage",
  "servers.ssh.manage",
];

const INSTANCE_SET: ReadonlySet<string> = new Set<string>([
  ...INSTANCE_PERMISSIONS,
  ...LOCAL_INSTANCE_PERMISSIONS,
]);
const PROJECT_SET: ReadonlySet<string> = new Set(PROJECT_PERMISSIONS);

/**
 * Permessi che esistono con lo stesso nome a due livelli (area 7: le
 * automazioni di progetto e quelle generali). `can` con un progetto legge
 * quello di progetto, senza progetto quello d'istanza.
 */
const BOTH_LEVELS: ReadonlySet<string> = new Set<string>(["automations.manage"]);

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
 * non è di nessun preset: lo danno le concessioni del seme (`grants.ts`).
 */
export const LOCAL_PROJECT_PERMISSIONS: Readonly<Record<string, readonly LocalProjectPermission[]>> = {
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

function roleKeys(key: string): readonly string[] {
  const role = PRESET_ROLES.find((r) => r.key === key);
  if (!role) throw new Error(`Unknown preset role: ${key}`);
  return role.permissions;
}

function instancePermsOf(key: string): (InstancePermission | LocalInstancePermission)[] {
  // «Vedere le conversazioni pubbliche con Claude» e «creare canali generali»:
  // di base ai preset User e Admin; «gestire i canali generali», le
  // automazioni generali (area 7) e gli accessi SSH dei server (area 8b) all'Admin.
  return [
    ...effectiveInstancePermissions(roleKeys(key)),
    "claude.public.view",
    "chat.general.create",
    ...(key === "admin"
      ? (["chat.general.manage", "automations.manage", "servers.ssh.manage"] as const)
      : []),
  ];
}

/**
 * «Vedere l'attività delle persone» (R-E2): di base al full admin e a chi è
 * Project Lead in almeno un progetto; si aggiunge alle concessioni locali.
 */
const ACTIVITY_ROLE = "project_lead";

function projectPermsOf(key: string): AnyProjectPermission[] {
  return [
    ...roleKeys(key).filter((p): p is ProjectPermission => PROJECT_SET.has(p)),
    ...(LOCAL_PROJECT_PERMISSIONS[key] ?? []),
  ];
}

/**
 * Quello che Claude non ha MAI (R-L9, R-L11): le decisioni — approvare un
 * piano, fare merge, operare sui server, registrare una decisione (il
 * registro non lo scrive mai l'AI), adottare una PR — e la gestione, di
 * progetto (impostazioni, membri, repository, ambienti, widget, moderazione)
 * e d'istanza (full admin, inviti, ogni `*.manage`: accessi SSH, monitor,
 * automazioni, canali generali…). Vince su ogni concessione, riga del seme,
 * ruolo di progetto e full admin: `claudeCan` non legge il `Viewer`.
 */
const CLAUDE_NEVER: ReadonlySet<string> = new Set([
  "plans.approve",
  "release.merge",
  "servers.operate",
  "decisions.record",
  "prs.adopt",
  "tickets.moderate",
  "instance.full_admin",
  "users.invite",
]);

const claudeForbidden = (perm: string): boolean =>
  CLAUDE_NEVER.has(perm) || perm.endsWith(".manage");

/**
 * I permessi di Claude in ogni progetto, membro o no (R-L9, maintainer:
 * «Claude ha sempre accesso a TUTTI i progetti»): quelli di lavoro del
 * Developer — vedere, aprire task, avviare i run, leggere i repository —
 * senza nessuno dei vietati. Gli avvisi non gli arrivano comunque (R-K5).
 */
const CLAUDE_PROJECT_PERMISSIONS: ReadonlySet<string> = new Set(
  projectPermsOf("developer").filter((p) => !claudeForbidden(p)),
);

/** D'istanza: il preset User, senza i vietati (nessuna concessione si aggiunge). */
const CLAUDE_INSTANCE_PERMISSIONS: ReadonlySet<string> = new Set(
  instancePermsOf("user").filter((p) => !claudeForbidden(p)),
);

/**
 * Se Claude ha `perm`, in qualunque progetto: dai due insiemi qui sopra e
 * basta. Un permesso a due livelli (`automations.manage`) è vietato a
 * entrambi; i permessi di reparto non li ha.
 */
function claudeCan(perm: Permission): boolean {
  if (claudeForbidden(perm)) return false;
  if (INSTANCE_SET.has(perm)) return CLAUDE_INSTANCE_PERMISSIONS.has(perm);
  return CLAUDE_PROJECT_PERMISSIONS.has(perm);
}

/** I permessi del ruolo più le concessioni del seme della persona su quel progetto (area 8b). */
function projectPermsWithGrants(
  personId: string,
  projectId: string,
  role: string,
): AnyProjectPermission[] {
  const code = PROJECTS.find((p) => p.id === projectId)?.code;
  const granted = (code && SEED_PROJECT_GRANTS[personId]?.[code]) || [];
  const perms = projectPermsOf(role);
  return [...perms, ...granted.filter((p) => !perms.includes(p))];
}

interface PersonaSpec {
  personId: string;
  /** Il nome è un dato; la descrizione (reparto e ruolo) sta nei locali: `rail.personas.<personId>`. */
  name: string;
  /** Ruolo d'istanza (preset `admin` o `user`). */
  instanceRole: "admin" | "user";
  /** Ruolo di progetto, dato il codice progetto, per i progetti dove la persona è membro. */
  projectRole: (code: string) => string;
}

const LEAD = new Set<string>(GIULIA_LEAD_CODES);

const SPECS: PersonaSpec[] = [
  {
    personId: "p-giulia",
    name: "Giulia Ferri",
    instanceRole: "user",
    projectRole: (code) => (LEAD.has(code) ? "project_lead" : "contributor"),
  },
  {
    personId: "p-marco",
    name: "Marco Bellini",
    instanceRole: "user",
    projectRole: () => "developer",
  },
  {
    personId: "p-laura",
    name: "Laura Costa",
    instanceRole: "user",
    projectRole: () => "project_lead",
  },
  {
    personId: "p-sara",
    name: "Sara Montanari",
    instanceRole: "user",
    projectRole: () => "contributor",
  },
  // Il proprietario di «Nuovo contratto» (AUT-1, R-J10): `automations.manage`
  // d'istanza gli viene dalle concessioni del seme, non dal preset. Serve a
  // vedere l'app come chi possiede un'automazione (email dell'inizio,
  // risposte del cliente).
  {
    personId: "p-matteo",
    name: "Matteo Conti",
    instanceRole: "user",
    projectRole: () => "project_lead",
  },
  {
    personId: "p-roberta",
    name: "Roberta Fontana",
    instanceRole: "admin",
    projectRole: () => "project_lead",
  },
];

/** Chi non è fra le persone «vedi come» ha il suo ruolo tipico ovunque sia membro. */
function specOf(personId: string): PersonaSpec | null {
  const spec = SPECS.find((s) => s.personId === personId);
  if (spec) return spec;
  const person = PEOPLE.find((p) => p.id === personId);
  if (!person) return null;
  const admin = person.presetRole === "admin";
  return {
    personId,
    name: person.name,
    instanceRole: admin ? "admin" : "user",
    projectRole: () => (admin ? "project_lead" : person.presetRole),
  };
}

function buildViewer(spec: PersonaSpec): Viewer {
  const projectPermissions: Record<string, AnyProjectPermission[]> = {};
  let leadSomewhere = false;
  // Un full admin non ha righe per progetto: `can` lo risolve dal permesso
  // d'istanza, come sul server.
  if (spec.instanceRole !== "admin") {
    for (const project of PROJECTS) {
      if (project.memberIds.includes(spec.personId)) {
        const role = spec.projectRole(project.code);
        if (role === ACTIVITY_ROLE) leadSomewhere = true;
        projectPermissions[project.id] = projectPermsWithGrants(spec.personId, project.id, role);
      }
    }
  }
  const instancePermissions = [
    ...instancePermsOf(spec.instanceRole),
    // Le concessioni personali del seme (R-J10), in più del preset.
    ...(SEED_INSTANCE_GRANTS[spec.personId] ?? []).filter(
      (p) => !instancePermsOf(spec.instanceRole).includes(p),
    ),
  ];
  if (spec.instanceRole === "admin" || leadSomewhere) {
    instancePermissions.push("people.activity.view");
  }
  const departmentPermissions: Record<string, DepartmentPermission[]> = {};
  for (const role of DEPARTMENT_ROLES) {
    if (role.personId === spec.personId) {
      departmentPermissions[role.departmentId] = [...role.permissions];
    }
  }
  return {
    personId: spec.personId,
    instancePermissions,
    projectPermissions,
    departmentPermissions,
  };
}

export interface ViewAsPersona {
  personId: string;
  name: string;
  /** Chiave i18n della descrizione (reparto · ruolo). */
  descriptionKey: string;
  viewer: Viewer;
}

export const VIEW_AS_PERSONAS: ViewAsPersona[] = SPECS.map((spec) => ({
  personId: spec.personId,
  name: spec.name,
  descriptionKey: `rail.personas.${spec.personId}`,
  viewer: buildViewer(spec),
}));

export const DEFAULT_PERSONA_ID = DEFAULT_SESSION_PERSON_ID;

const viewers = new Map<string, Viewer>(VIEW_AS_PERSONAS.map((p) => [p.personId, p.viewer]));

/**
 * Il `Viewer` di una persona: quello «vedi come» se c'è, altrimenti dal suo
 * ruolo tipico; per un id sconosciuto, quello di default.
 */
export function viewerFor(personId: string): Viewer {
  const cached = viewers.get(personId);
  if (cached) return cached;
  const spec = specOf(personId);
  if (!spec) return viewers.get(DEFAULT_PERSONA_ID)!;
  const viewer = buildViewer(spec);
  viewers.set(personId, viewer);
  return viewer;
}

/** Come annullare ogni concessione fatta dopo il seed, dalla più recente. */
const undo: (() => void)[] = [];

/** I ruoli di progetto dati dopo il seed (`grantProjectRole`), per `persona\u0000progetto`. */
const grantedRoles = new Map<string, string>();
const roleKeyOf = (personId: string, projectId: string) => `${personId}\u0000${projectId}`;

/**
 * Il ruolo (preset) di una persona in un progetto: quello dato dopo il seed,
 * altrimenti quello del seed se ne è membro; `null` se non ci ha un ruolo.
 * Lo usano le automazioni (area 7) per «chi ha il ruolo X nel progetto»:
 * l'appartenenza di adesso la controlla chi chiama.
 */
export function projectRoleOf(personId: string, projectId: string): string | null {
  const granted = grantedRoles.get(roleKeyOf(personId, projectId));
  if (granted !== undefined) return granted;
  const project = PROJECTS.find((p) => p.id === projectId);
  const spec = specOf(personId);
  if (!project || !spec || !project.memberIds.includes(personId)) return null;
  return spec.projectRole(project.code);
}

/**
 * Dà a una persona il ruolo (preset) su un progetto — chi crea un progetto ne
 * è il project lead; i test lo usano anche per cambiare (o togliere) il ruolo
 * di una persona del seed. Diventare Project Lead dà anche
 * `people.activity.view` (R-E2). Le concessioni si annullano con
 * `resetViewerGrants` (parte di `resetApi`).
 */
export function grantProjectRole(personId: string, projectId: string, roleKey: string): void {
  const viewer = viewerFor(personId);
  // Si annulla rimettendo il ruolo di prima (anche quello del seed), non togliendolo.
  const previous = viewer.projectPermissions[projectId];
  const key = roleKeyOf(personId, projectId);
  const previousRole = grantedRoles.get(key);
  // Cambiare ruolo non toglie le concessioni personali del seme.
  viewer.projectPermissions[projectId] = projectPermsWithGrants(personId, projectId, roleKey);
  grantedRoles.set(key, roleKey);
  undo.push(() => {
    if (previous) viewer.projectPermissions[projectId] = previous;
    else delete viewer.projectPermissions[projectId];
    if (previousRole === undefined) grantedRoles.delete(key);
    else grantedRoles.set(key, previousRole);
  });
  if (roleKey === ACTIVITY_ROLE) grantInstancePermission(personId, "people.activity.view");
}

/**
 * Concede un permesso di progetto del prototipo (assegnabile a qualunque
 * ruolo) su un progetto di cui la persona ha già un ruolo.
 */
export function grantProjectPermission(
  personId: string,
  projectId: string,
  perm: LocalProjectPermission,
): void {
  const perms = viewerFor(personId).projectPermissions[projectId];
  if (!perms || perms.includes(perm)) return;
  perms.push(perm);
  undo.push(() => {
    const i = perms.indexOf(perm);
    if (i >= 0) perms.splice(i, 1);
  });
}

/** Toglie un permesso di progetto del prototipo su un progetto, anche uno di base. */
export function revokeProjectPermission(
  personId: string,
  projectId: string,
  perm: LocalProjectPermission,
): void {
  const perms = viewerFor(personId).projectPermissions[projectId];
  const i = perms?.indexOf(perm) ?? -1;
  if (!perms || i < 0) return;
  perms.splice(i, 1);
  undo.push(() => {
    if (!perms.includes(perm)) perms.push(perm);
  });
}

/** Concede un permesso d'istanza del prototipo (assegnabile a qualunque ruolo). */
export function grantInstancePermission(personId: string, perm: LocalInstancePermission): void {
  const perms = viewerFor(personId).instancePermissions;
  if (perms.includes(perm)) return;
  perms.push(perm);
  undo.push(() => {
    const i = perms.indexOf(perm);
    if (i >= 0) perms.splice(i, 1);
  });
}

/** Toglie un permesso d'istanza del prototipo, anche uno di base. */
export function revokeInstancePermission(personId: string, perm: LocalInstancePermission): void {
  const perms = viewerFor(personId).instancePermissions;
  const i = perms.indexOf(perm);
  if (i < 0) return;
  perms.splice(i, 1);
  undo.push(() => {
    if (!perms.includes(perm)) perms.push(perm);
  });
}

export function resetViewerGrants(): void {
  for (const fn of undo.splice(0).reverse()) fn();
}

const isFullAdmin = (viewer: Viewer) => viewer.instancePermissions.includes("instance.full_admin");

/**
 * Stessa semantica di `hasPermission` in `apps/web/src/lib/permissions.ts`.
 * Per un permesso a due livelli (`BOTH_LEVELS`) il progetto sceglie quale:
 * con `projectId` quello di progetto, senza quello d'istanza.
 */
export function can(viewer: Viewer, perm: Permission, projectId?: string): boolean {
  // R-L9: Claude PRIMA di tutto, e senza leggere il suo `Viewer`: nessuna
  // concessione, riga del seme, ruolo di progetto o full admin gli dà ciò
  // che è vietato.
  if (viewer.personId === CLAUDE_ID) return claudeCan(perm);
  if (isFullAdmin(viewer)) return true;
  if (INSTANCE_SET.has(perm) && !(BOTH_LEVELS.has(perm) && projectId !== undefined))
    return viewer.instancePermissions.includes(
      perm as InstancePermission | LocalInstancePermission,
    );
  if (perm === "department.home.manage") {
    return Object.values(viewer.departmentPermissions).some((perms) => perms.includes(perm));
  }
  const byProject = viewer.projectPermissions;
  const wanted = perm as AnyProjectPermission;
  if (projectId !== undefined) return (byProject[projectId] ?? []).includes(wanted);
  return Object.values(byProject).some((perms) => perms.includes(wanted));
}

/** Un permesso di reparto, su quel reparto (il full admin li ha tutti). */
export function canInDepartment(
  viewer: Viewer,
  perm: DepartmentPermission,
  departmentId: string,
): boolean {
  if (isFullAdmin(viewer)) return true;
  return (viewer.departmentPermissions[departmentId] ?? []).includes(perm);
}

const ADMIN_PERMISSIONS: InstancePermission[] = [
  "instance.full_admin",
  "users.manage",
  "users.invite",
  "roles.manage",
  "settings.manage",
  "ai_providers.manage",
  "git_accounts.manage",
  "plugins.manage",
  "integrations.manage",
  "monitor.manage",
  "usage.view",
];

/** Vero se il viewer ha almeno un permesso d'amministrazione d'istanza. */
export function canSeeAdmin(viewer: Viewer): boolean {
  return ADMIN_PERMISSIONS.some((p) => viewer.instancePermissions.includes(p));
}

// --- stato condiviso dell'app -----------------------------------------------

interface ViewerContextValue {
  viewer: Viewer;
  setPersona(personId: string): void;
}

const ViewerContext = createContext<ViewerContextValue>({
  viewer: viewerFor(DEFAULT_PERSONA_ID),
  setPersona: () => {},
});

/**
 * Da montare una volta nell'`App`: tiene la persona «vedi come» attiva e la
 * sessione del livello dati. La sessione si allinea DURANTE il render del
 * provider — prima che i figli rendano con la persona nuova — così nessuna
 * query parte (né si mostra) a nome della persona precedente.
 */
export function ViewerProvider({
  children,
  initialPersonId = DEFAULT_PERSONA_ID,
}: {
  children: ReactNode;
  initialPersonId?: string;
}) {
  const [personId, setPersonId] = useState(initialPersonId);
  // Idempotente: rimette la sessione sulla persona di questo render.
  setSessionPersonId(personId);
  const value = useMemo<ViewerContextValue>(
    () => ({
      viewer: viewerFor(personId),
      setPersona: (next: string) => {
        // I messaggi parlano dei dati di chi guardava (un ritorno indietro su
        // una sua task): con la persona nuova non devono restare a schermo.
        if (next !== personId) {
          // Prima del cambio, con la sessione ancora della persona di prima:
          // ciò che aveva in sospeso parte a suo nome, non dell'altra.
          runBeforePersonaChange();
          clearToasts();
        }
        setPersonId(next);
      },
    }),
    [personId],
  );
  return createElement(ViewerContext.Provider, { value }, children);
}

export function useViewer(): ViewerContextValue {
  return useContext(ViewerContext);
}
