import type { Viewer } from "../types";
import { can, type Permission } from "../viewer";
import { changeTypes } from "./record";

// Chi legge il registro senza guardare le voci: lo usa la colonna
// dell'Amministrazione (`adminSections`) per la voce «Change log». Sta fuori
// da `reads.ts` perché quello è `api.changelog`, che espone solo le due
// letture (test sui nomi esportati).

/** Chi gestisce un progetto (impostazioni o membri) ne legge le voci. */
export const MANAGE_PROJECT = ["project.settings.manage", "project.members.manage"] as const;

/**
 * Se chi guarda legge almeno un tipo di voce, da qualche parte. È la regola
 * di `readable` (`reads.ts`) senza le voci: `changelog.view`, la gestione di
 * un progetto (in almeno uno), o il `readPermission` di un tipo registrato
 * (d'istanza, o di progetto in almeno un progetto).
 */
export function readsSomeChanges(viewer: Viewer): boolean {
  if (can(viewer, "changelog.view")) return true;
  if (MANAGE_PROJECT.some((p) => can(viewer, p))) return true;
  return changeTypes().some((type) => can(viewer, type.readPermission as Permission));
}
