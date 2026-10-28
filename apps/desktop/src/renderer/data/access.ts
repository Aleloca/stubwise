import { visibleProjectIds } from "./store";
import { can, viewerFor, type Permission } from "./viewer";

// Le due domande di accesso dei livelli dati dell'8a (Rilasci, Support): chi
// vede un progetto (R-G5: un oggetto invisibile risponde come uno che non
// esiste) e chi vi ha un permesso. Una sola copia, ri-esportata dai file di
// visibilità.

export const sees = (me: string, projectId: string): boolean =>
  visibleProjectIds(me).has(projectId);

export const holds = (me: string, perm: Permission, projectId: string): boolean =>
  can(viewerFor(me), perm, projectId);
