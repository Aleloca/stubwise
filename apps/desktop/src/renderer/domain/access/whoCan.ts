import { isFullAdminIn, type PermissionSource } from "../../data/access/effectiveCore";
import type { AccessState } from "../../data/access/state";

// La parte pura di «Chi può farlo?» (area 9a): chi si vede e in che ordine.
// Chi può davvero lo dice `can()`, e lo chiede `data/access/whoCan.ts`, che
// passa qui lo stato e i progetti visibili (R-G5: un progetto o una persona
// invisibile non compare, come se non esistesse).

/**
 * Le persone che chi guarda vede: le attive che condividono con lui almeno un
 * progetto visibile, più i full admin, più sé stesso. Un full admin vede
 * tutti. Claude non c'è: «Chi può farlo?» lo mostra a parte, con la sua frase.
 * Chi è full admin si legge dallo STESSO stato ricevuto (una fonte sola).
 */
export function peopleVisibleTo(input: {
  state: AccessState;
  viewerId: string;
  visibleProjectIds: ReadonlySet<string>;
}): Set<string> {
  const { state, viewerId, visibleProjectIds } = input;
  const isFullAdmin = (personId: string) => isFullAdminIn(state, personId);
  const viewerIsFullAdmin = isFullAdmin(viewerId);
  const active = state.people.filter((p) => p.status === "active").map((p) => p.personId);
  if (viewerIsFullAdmin) return new Set(active);
  const sharing = new Set(
    state.memberships.filter((m) => visibleProjectIds.has(m.projectId)).map((m) => m.personId),
  );
  return new Set(active.filter((id) => id === viewerId || isFullAdmin(id) || sharing.has(id)));
}

/**
 * Le persone che chi guarda CONOSCE (registro, A11 r.1414, decisione del
 * maintainer del 23 nov 2026): è la regola degli id e dei nomi che una vista
 * può portare. Più larga di `peopleVisibleTo` (chi si sceglie, chi può fare):
 * conta anche i disattivati e gli ex membri dei progetti visibili, che
 * restano «Nome (deactivated)». Un full admin conosce tutti.
 */
export function peopleKnownTo(input: {
  state: AccessState;
  viewerId: string;
  visibleProjectIds: ReadonlySet<string>;
}): Set<string> {
  const { state, viewerId, visibleProjectIds } = input;
  const all = state.people.map((p) => p.personId);
  if (isFullAdminIn(state, viewerId)) return new Set(all);
  const sharing = new Set(
    [...state.memberships, ...(state.formerMemberships ?? [])]
      .filter((m) => visibleProjectIds.has(m.projectId))
      .map((m) => m.personId),
  );
  return new Set(
    all.filter((id) => id === viewerId || isFullAdminIn(state, id) || sharing.has(id)),
  );
}

const SOURCE_RANK: Record<PermissionSource["kind"], number> = {
  role: 0,
  grant: 1,
  department: 2,
  full_admin: 3,
};

/** Il rango di una persona: la sua fonte migliore (ruolo, poi concessione, reparto, full admin). */
const rankOf = (sources: readonly PermissionSource[]): number =>
  Math.min(4, ...sources.map((s) => SOURCE_RANK[s.kind]));

/**
 * L'ordine della risposta (shape admin-audit.md): chi ce l'ha da un ruolo,
 * poi dato a mano, poi dal reparto, poi full admin; dentro, per nome. Le
 * fonti di ogni persona seguono lo stesso ordine.
 */
export function orderHolders<T extends { personId: string; sources: PermissionSource[] }>(
  rows: readonly T[],
  nameOf: (personId: string) => string,
): T[] {
  return rows
    .map((r) => ({
      ...r,
      sources: [...r.sources].sort((a, b) => SOURCE_RANK[a.kind] - SOURCE_RANK[b.kind]),
    }))
    .sort(
      (a, b) =>
        rankOf(a.sources) - rankOf(b.sources) ||
        nameOf(a.personId).localeCompare(nameOf(b.personId)),
    );
}
