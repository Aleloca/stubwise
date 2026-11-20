import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "@backend/api";
import { featureIntegrated } from "../integration";
import { useConversationChanges, useSessionPersonId } from "../queries";
import { useAiBlock } from "./instance";

// La riga «Claude can help you…» (area 10b, Task 12); `data/queries` la
// ri-esporta. Sta qui, e non in `queries.ts`, perché legge `useAiBlock` di
// `./instance`: da `queries.ts` sarebbe l'unico import con nome nel verso
// opposto a `export *` (review finale 10b, 3).

export type { ClaudeSuggestion, SuggestionPlace } from "../api";
export { suggestionKeyOf } from "../claude/suggestionKey";

/**
 * L'area di lettura di ogni luogo: le scritture che cambiano la pagina (una
 * le note, un'automazione nuova, un piano deciso, i
 * consumi) ricaricano già quell'area, e con lei la riga.
 */
const SUGGESTION_AREA: Record<api.SuggestionPlace["kind"], string> = {
  pr: "releases",
  automations: "automations",
  overview: "pulse",
  usage: "instance",
};

/**
 * La riga «Claude can help you…» di una pagina di partenza (area 10b, Task
 * 12): la decide il livello dati per chi guarda (`null` = nessuna riga). Il
 * blocco del budget sta nella chiave: alzato o esaurito, la riga si rilegge
 * su ogni pagina, non solo dove i blocchi hanno la loro area.
 */
export function useClaudeSuggestion(place: api.SuggestionPlace | null) {
  const me = useSessionPersonId();
  useConversationChanges();
  const budget = useAiBlock(null).data?.reason ?? null;
  // La riga «Claude can help you…» propone azioni di Claude: nella build app
  // «in arrivo» (non c'è con la sola chat in lettura): niente chiave, niente lettura.
  const on = featureIntegrated("claude-suggestions");
  const placeKey = place && on ? api.suggestionKeyOf(place) : null;
  return useQuery({
    queryKey: [
      "as",
      me,
      place ? SUGGESTION_AREA[place.kind] : "claudeSuggestion",
      "claudeSuggestion",
      placeKey,
      budget,
    ] as const,
    queryFn: () => (place ? api.getClaudeSuggestion(place) : Promise.resolve(null)),
    enabled: place !== null && on,
    // Cambiato solo il budget, la riga di prima resta finché non arriva la
    // risposta nuova (niente lampo); un altro oggetto, o un'altra persona
    // («vedi come»), non eredita mai la riga.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me && previousQuery.queryKey[4] === placeKey
        ? previous
        : undefined,
  });
}

/**
 * «Not now» (area 10, F7): nella build app lo salva il server, per persona e
 * per oggetto; poi la riga si rilegge (il server la dà `null`). Nel prototipo
 * non scrive niente: lo ricorda la riga in `localStorage` ([SG 7]).
 */
export function useDismissClaudeSuggestion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { place: api.SuggestionPlace; kind: api.ClaudeSuggestion["id"] }) =>
      api.dismissClaudeSuggestion(vars.place, vars.kind),
    onSettled: () =>
      client.invalidateQueries({
        predicate: (q) => q.queryKey[3] === "claudeSuggestion",
      }),
  });
}
