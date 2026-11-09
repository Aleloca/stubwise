import { accessState } from "./access/index";
import { visibleProjectIds } from "./store";
import type { Viewer } from "./types";

// I due fatti sugli accessi che le regole di visibilità delle superfici
// (`adminSections.ts`) chiedono al livello dati, nel prototipo: dallo stato
// degli accessi e dallo store. Nella build app `@backend/access` è
// `backend/real/accessFacts.ts` (integrazione area 2, fetta 1), che li legge
// dal `Viewer` dato dal server.

/**
 * Una persona umana e attiva: chi ha una sessione nell'app. Claude e
 * «nessuno» non stanno fra le persone degli accessi (R-L9), quindi non passano.
 */
export function isActiveViewer(viewer: Viewer): boolean {
  return accessState().people.some((p) => p.personId === viewer.personId && p.status === "active");
}

/** Un progetto che chi guarda vede (i full admin vedono tutto). */
export function seesProject(viewer: Viewer, projectId: string): boolean {
  return visibleProjectIds(viewer.personId).has(projectId);
}
