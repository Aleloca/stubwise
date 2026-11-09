import type { SuggestionPlace } from "./suggestions";

// La chiave di «Not now», pura: `suggestions.ts` la ri-esporta.

/**
 * La chiave di «Not now»: l'oggetto, non il tipo di pagina ([SG 7], maintainer
 * 2 nov 2026). Nascosta su ACQ-S2, la riga resta sulle altre conversazioni.
 */
export function suggestionKeyOf(place: SuggestionPlace): string {
  switch (place.kind) {
    case "support":
      return `support:${place.conversationId}`;
    case "pr":
      return `pr:${place.prId}`;
    case "automations":
    case "overview":
      return `${place.kind}:${place.projectId}`;
    case "usage":
      return "usage";
  }
}
