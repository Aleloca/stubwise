import type { Person } from "../../data/types";

/**
 * Il nome di una persona nella Chat, o «Someone» (registro, A11 r.1414): un
 * id che l'elenco delle persone non ha è di chi guarda non conosce (un
 * segnaposto `hidden-<n>`). Nessun id, nessun nome.
 */
export function nameOrSomeone(
  people: readonly Person[] | undefined,
  id: string | null | undefined,
  someone: string,
): string {
  if (!id) return "";
  return people?.find((p) => p.id === id)?.name ?? someone;
}
