import type { PermissionSource } from "../../data/access/effective";

// Le due regole anti-escalation (area 9a, design «Members del progetto»):
// chi agisce non dà ciò che non ha (`escalation`) e non tocca chi ha più di
// lui (`target_above`). Ricevono i permessi EFFETTIVI già calcolati da
// `effectivePermissions` (ruolo, concessioni, reparto, permessi locali del
// prototipo): il livello del confronto — un progetto o l'istanza — lo
// sceglie chi chiama, calcolando le due mappe sullo stesso livello.

export type PermissionMap = ReadonlyMap<string, readonly PermissionSource[]>;

/** Il full admin contiene tutto: lo si riconosce dalla fonte, non da un elenco di permessi. */
export const holdsFullAdmin = (perms: PermissionMap): boolean =>
  [...perms.values()].some((sources) => sources.some((s) => s.kind === "full_admin"));

/**
 * `escalation`: chi agisce dà soltanto permessi che ha. `missing` elenca, in
 * ordine e senza ripetizioni, quelli che gli mancano.
 */
export function checkEscalation(
  actor: PermissionMap,
  wanted: readonly string[],
): { ok: true } | { ok: false; error: "escalation"; missing: string[] } {
  if (holdsFullAdmin(actor)) return { ok: true };
  const missing = [...new Set(wanted)].filter((p) => !actor.has(p));
  return missing.length === 0 ? { ok: true } : { ok: false, error: "escalation", missing };
}

/**
 * `target_above`: non si modifica chi ha un permesso che chi agisce non ha.
 * Un full admin li contiene tutti, quindi non è mai sotto un altro full admin;
 * chi non lo è non tocca mai un full admin.
 */
export function checkTarget(
  actor: PermissionMap,
  target: PermissionMap,
): { ok: true } | { ok: false; error: "target_above" } {
  if (holdsFullAdmin(actor)) return { ok: true };
  if (holdsFullAdmin(target)) return { ok: false, error: "target_above" };
  for (const p of target.keys()) {
    if (!actor.has(p)) return { ok: false, error: "target_above" };
  }
  return { ok: true };
}
