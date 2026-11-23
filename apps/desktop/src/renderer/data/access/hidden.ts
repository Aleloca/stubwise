import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { knownPeopleFor } from "./whoCan";

// Il segnaposto delle persone che chi guarda non conosce (registro, A11
// r.1414, decisione del maintainer del 23 nov 2026; la forma è in
// docs/invariants/permissions.md). Come `./whoCan`, non va ri-esportato da
// `./index`: lo store importa quel barile, e `./whoCan` importa lo store.

/**
 * Un masker per UNA risposta: l'id di una persona che `viewerId` non conosce
 * diventa `hidden-<n>`, con `<n>` da 1 nell'ordine in cui compare; la stessa
 * persona ha lo stesso segnaposto in tutta la risposta, mai fra due risposte
 * (un masker nuovo ricomincia da 1). Chi guarda, Claude, chi si conosce e un
 * id che non è una persona restano com'erano; `null` resta `null`.
 */
export function personMasker(viewerId: string): <T extends string | null | undefined>(id: T) => T {
  const known = knownPeopleFor(viewerId);
  const people = new Set(PEOPLE.map((p) => p.id));
  const hidden = new Map<string, string>();
  return <T extends string | null | undefined>(id: T): T => {
    if (id === null || id === undefined) return id;
    if (id === viewerId || id === CLAUDE_ID || !people.has(id) || known.has(id)) return id;
    let placeholder = hidden.get(id);
    if (!placeholder) {
      placeholder = `hidden-${hidden.size + 1}`;
      hidden.set(id, placeholder);
    }
    return placeholder as T;
  };
}

/** Il campo è un segnaposto: non si risolve, non si clicca, non torna al server. */
export const isHiddenId = (id: string | null | undefined): boolean =>
  typeof id === "string" && id.startsWith("hidden-");
