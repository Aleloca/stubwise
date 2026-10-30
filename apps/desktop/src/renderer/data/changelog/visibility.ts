import type { Viewer } from "../types";
import { can, type Permission } from "../viewer";
import { changeTypes } from "./record";
import type { ChangeType } from "./types";

// Chi legge il registro senza guardare le voci: lo usano la colonna
// dell'Amministrazione (`adminSections`) per la voce «Change log» e il filtro
// «Type» del registro. Sta fuori da `reads.ts` perché quello è
// `api.changelog`, che espone solo letture (test sui nomi esportati).

/** Chi gestisce un progetto (impostazioni o membri) ne legge le voci. */
export const MANAGE_PROJECT = ["project.settings.manage", "project.members.manage"] as const;

/**
 * L'ordine dei gruppi del filtro «Type» (shape admin-audit.md): quelli del
 * 9a, poi quelli del 9b (`instance/changeTypes.ts`); il 9c aggiunge i suoi
 * dopo. Dichiarato, non affidato all'ordine in cui i moduli registrano.
 */
export const GROUP_ORDER: readonly string[] = [
  "people",
  "invites",
  "roles",
  "members",
  "departments",
  "security",
  "ai",
  "integrations",
  "servers",
  "queue",
];

/**
 * Se chi guarda legge le voci di un tipo da qualche parte (o, con
 * `projectId`, in quel progetto). È la regola di `readable` (`reads.ts`)
 * senza le voci: `changelog.view`, la gestione di un progetto, o il
 * `readPermission` del tipo.
 */
function readsType(viewer: Viewer, type: ChangeType, projectId?: string): boolean {
  if (projectId !== undefined && type.scope !== "project") return false;
  if (can(viewer, "changelog.view")) return true;
  if (type.scope === "project" && MANAGE_PROJECT.some((p) => can(viewer, p, projectId)))
    return true;
  return can(viewer, type.readPermission as Permission, projectId);
}

/** Se chi guarda legge almeno un tipo di voce, da qualche parte. */
export function readsSomeChanges(viewer: Viewer): boolean {
  if (can(viewer, "changelog.view")) return true;
  if (MANAGE_PROJECT.some((p) => can(viewer, p))) return true;
  return changeTypes().some((type) => readsType(viewer, type));
}

/** I gruppi di voci che chi guarda legge (il filtro «Type»), nell'ordine dello shape. */
export function readableChangeGroups(viewer: Viewer, projectId?: string): string[] {
  const groups = new Set(
    changeTypes()
      .filter((type) => readsType(viewer, type, projectId))
      .map((type) => type.group),
  );
  const rank = (g: string) =>
    GROUP_ORDER.includes(g) ? GROUP_ORDER.indexOf(g) : GROUP_ORDER.length;
  return [...groups].sort((a, b) => rank(a) - rank(b));
}
