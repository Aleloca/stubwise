import type { SuggestionPlace } from "./suggestions";

// La chiave di «Not now», pura: `suggestions.ts` la ri-esporta.

/**
 * La chiave di «Not now»: l'oggetto, non il tipo di pagina ([SG 7], maintainer
 * 2 nov 2026). Nascosta su una PR, la riga resta sulle altre.
 */
export function suggestionKeyOf(place: SuggestionPlace): string {
  switch (place.kind) {
    case "pr":
      return `pr:${place.prId}`;
    case "automations":
    case "overview":
      return `${place.kind}:${place.projectId}`;
    case "usage":
      return "usage";
  }
}
