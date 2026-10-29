import type { PermissionSource } from "../../data/access/effective";

// La regola anti-escalation (area 9a): chi agisce DÀ soltanto permessi che
// ha. Vale per ciò che si dà — un ruolo assegnato (coi permessi di quel ruolo
// nel progetto), una concessione, un permesso messo in un reparto o in un
// ruolo — mai per ciò che si toglie: togliere un permesso, cambiare ruolo
// verso uno contenuto o allontanare una persona non passa da qui.
//
// Non c'è una regola sulla gerarchia (maintainer, 30 ott 2026): chi ha il
// permesso di gestione (`project.members.manage`, `users.manage`,
// `roles.manage`, `departments.manage`) modifica chiunque, anche chi ha più
// permessi di lui, a ogni livello.
//
// Riceve i permessi EFFETTIVI già calcolati da `effectivePermissions` (ruolo,
// concessioni, reparto, permessi locali del prototipo): il livello del
// confronto — un progetto o l'istanza — lo sceglie chi chiama.

export type PermissionMap = ReadonlyMap<string, readonly PermissionSource[]>;

/** Il full admin contiene tutto: lo si riconosce dalla fonte, non da un elenco di permessi. */
export const holdsFullAdmin = (perms: PermissionMap): boolean =>
  [...perms.values()].some((sources) => sources.some((s) => s.kind === "full_admin"));

/**
 * `escalation`: chi agisce dà soltanto permessi che ha. `wanted` è ciò che
 * la modifica DÀ; `missing` elenca, in ordine e senza ripetizioni, quelli
 * che gli mancano.
 */
export function checkEscalation(
  actor: PermissionMap,
  wanted: readonly string[],
): { ok: true } | { ok: false; error: "escalation"; missing: string[] } {
  if (holdsFullAdmin(actor)) return { ok: true };
  const missing = [...new Set(wanted)].filter((p) => !actor.has(p));
  return missing.length === 0 ? { ok: true } : { ok: false, error: "escalation", missing };
}
