import {
  canI,
  reauthRefusal as instanceReauthRefusal,
  refuse as instanceRefuse,
} from "../instance/common";
import type { Project } from "../model";
import type { ApiFnName } from "../store";
import { openProject } from "./reads";
import type { BusyReason, ProjectRefusal } from "./types";

// Ciò che le scritture delle impostazioni di progetto (area 9c) condividono:
// i rifiuti e la riconferma. L'ordine dei controlli è quello del 9a e del 9b
// (`admin/common.ts`, `instance/common.ts`): `not_found` (R-G5: un progetto
// invisibile o archiviato è come uno che non c'è) → `forbidden` → l'input
// (`invalid`) → i blocchi (`conflict`, `in_use`, `busy`) →
// `reauth_required` → la scrittura e la sua voce del registro.
//
// Importa la riconferma, e con lei il caveau dei segreti: per questo lo
// store, `adminSections.ts` e il registro non importano mai questo modulo,
// solo `state.ts`, `seed.ts` e `changeTypes.ts` (ruling del controller
// (pre-flight), P6).

export const refuse = {
  ...instanceRefuse,
  /** Il progetto non si archivia adesso: `reasons` dice cosa aspettare. */
  busy: (reasons: BusyReason[]): ProjectRefusal => ({ ok: false, error: "busy", reasons }),
};

/** `reauth_required` se la funzione è dichiarata in `REAUTH_REQUIRED` e manca una riconferma recente. */
export function reauthRefusal(me: string, fn: ApiFnName): ProjectRefusal | null {
  return instanceReauthRefusal(me, fn);
}

export { canI };
export { nameOf } from "../instance/common";

/** Il permesso di scrittura di General, AI, Automations, Plugins e Archive. */
export const MANAGE_SETTINGS = "project.settings.manage";

/** L'oggetto delle voci di progetto: il codice come etichetta. */
export const projectObject = (p: Project) => ({ type: "project", id: p.id, label: p.code });

/**
 * Il progetto su cui scrivere: visibile e aperto (o `not_found`: R-G5, un
 * archiviato è come uno che non c'è), col permesso nel progetto (o
 * `forbidden`).
 */
export function managedProject(
  me: string,
  projectId: string,
  permission: string = MANAGE_SETTINGS,
): { project: Project } | { refusal: ProjectRefusal } {
  const project = openProject(me, projectId);
  if (!project) return { refusal: refuse.notFound() };
  if (!canI(me, permission, project.id)) return { refusal: refuse.forbidden() };
  return { project };
}
