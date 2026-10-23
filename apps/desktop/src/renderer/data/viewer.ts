import {
  INSTANCE_PERMISSIONS,
  PRESET_ROLES,
  PROJECT_PERMISSIONS,
  effectiveInstancePermissions,
  type InstancePermission,
  type ProjectPermission,
} from "@stubwise/shared";
import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from "react";
import { GIULIA_LEAD_CODES, PROJECTS } from "./seed/projects";
import type { Viewer } from "./types";

export type Permission = InstancePermission | ProjectPermission;

const INSTANCE_SET: ReadonlySet<string> = new Set(INSTANCE_PERMISSIONS);
const PROJECT_SET: ReadonlySet<string> = new Set(PROJECT_PERMISSIONS);

function roleKeys(key: string): readonly string[] {
  const role = PRESET_ROLES.find((r) => r.key === key);
  if (!role) throw new Error(`Unknown preset role: ${key}`);
  return role.permissions;
}

function instancePermsOf(key: string): InstancePermission[] {
  return [...effectiveInstancePermissions(roleKeys(key))];
}

function projectPermsOf(key: string): ProjectPermission[] {
  return roleKeys(key).filter((p): p is ProjectPermission => PROJECT_SET.has(p));
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
    personId: "p-sara",
    name: "Sara Montanari",
    instanceRole: "user",
    projectRole: () => "contributor",
  },
  {
    personId: "p-roberta",
    name: "Roberta Fontana",
    instanceRole: "admin",
    projectRole: () => "project_lead",
  },
];

function buildViewer(spec: PersonaSpec): Viewer {
  const projectPermissions: Record<string, ProjectPermission[]> = {};
  // Un full admin non ha righe per progetto: `can` lo risolve dal permesso
  // d'istanza, come sul server.
  if (spec.instanceRole !== "admin") {
    for (const project of PROJECTS) {
      if (project.memberIds.includes(spec.personId)) {
        projectPermissions[project.id] = projectPermsOf(spec.projectRole(project.code));
      }
    }
  }
  return {
    personId: spec.personId,
    instancePermissions: instancePermsOf(spec.instanceRole),
    projectPermissions,
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

export const DEFAULT_PERSONA_ID = "p-giulia";

/** Il `Viewer` di una persona «vedi come»; per un id sconosciuto, quello di default. */
export function viewerFor(personId: string): Viewer {
  const found = VIEW_AS_PERSONAS.find((p) => p.personId === personId);
  return (found ?? VIEW_AS_PERSONAS.find((p) => p.personId === DEFAULT_PERSONA_ID)!).viewer;
}

/** Stessa semantica di `hasPermission` in `apps/web/src/lib/permissions.ts`. */
export function can(viewer: Viewer, perm: Permission, projectId?: string): boolean {
  if (viewer.instancePermissions.includes("instance.full_admin")) return true;
  if (INSTANCE_SET.has(perm))
    return viewer.instancePermissions.includes(perm as InstancePermission);
  const byProject = viewer.projectPermissions;
  if (projectId !== undefined)
    return (byProject[projectId] ?? []).includes(perm as ProjectPermission);
  return Object.values(byProject).some((perms) => perms.includes(perm as ProjectPermission));
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

/** Da montare una volta nell'`App`: tiene la persona «vedi come» attiva. */
export function ViewerProvider({
  children,
  initialPersonId = DEFAULT_PERSONA_ID,
}: {
  children: ReactNode;
  initialPersonId?: string;
}) {
  const [personId, setPersonId] = useState(initialPersonId);
  const value = useMemo<ViewerContextValue>(
    () => ({ viewer: viewerFor(personId), setPersona: setPersonId }),
    [personId],
  );
  return createElement(ViewerContext.Provider, { value }, children);
}

export function useViewer(): ViewerContextValue {
  return useContext(ViewerContext);
}
