import type { QueryClient } from "@tanstack/react-query";

import { spanOf } from "./calendar/span";
import type { CalendarEventView } from "./types";

const listsOf = (client: QueryClient, me: string) =>
  client.getQueriesData<CalendarEventView[]>({ queryKey: ["as", me, "calendar", "events"] });

/**
 * Mette (o sostituisce) l'evento negli elenchi letti degli intervalli che
 * tocca, con la stessa regola di `listEvents` (`spanOf`: un «tutto il
 * giorno» copre i giorni LOCALI della sua data).
 */
export function placeEvent(client: QueryClient, me: string, e: CalendarEventView): void {
  const { from, to } = spanOf(e);
  for (const [key, list] of listsOf(client, me)) {
    if (!list) continue;
    const range = key[4] as { from: string; to: string } | undefined;
    const touches = !!range && from < Date.parse(range.to) && to > Date.parse(range.from);
    const rest = list.filter((x) => x.id !== e.id);
    const next = touches
      ? [...rest, e].sort(
          (a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id),
        )
      : rest;
    client.setQueryData(key, next);
  }
}

/**
 * L'esito di una scrittura prende il posto di ciò che si è visto salvare
 * (`heard`, gli id annunciati con «Saving…»). Una riunione nuova si annuncia
 * con l'id della bozza e il server le dà il suo (review F4, 4): il blocco
 * della bozza se ne va, invece di restare accanto fino alla rilettura.
 */
export function settleSaved(
  client: QueryClient,
  me: string,
  heard: readonly string[],
  result: CalendarEventView,
): void {
  const gone = new Set(heard.filter((id) => id !== result.id));
  if (gone.size > 0)
    for (const [key, list] of listsOf(client, me))
      if (list)
        client.setQueryData(
          key,
          list.filter((x) => !gone.has(x.id)),
        );
  placeEvent(client, me, result);
}
