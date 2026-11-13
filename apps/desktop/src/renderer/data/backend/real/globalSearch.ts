import { appClient } from "./client";

// La ricerca di ⌘K (`GET /api/search`, `citable`): le task e i progetti
// (`search.ts`) e le automazioni (`automationsLive.ts`) partono dallo stesso
// tasto. Due chiamate uguali in volo diventano una sola risposta.

type Results = Awaited<ReturnType<ReturnType<typeof appClient>["search"]["global"]>>;

const inFlight = new Map<string, { client: unknown; promise: Promise<Results> }>();

export function citableSearch(needle: string): Promise<Results> {
  const client = appClient();
  const open = inFlight.get(needle);
  // Con un altro client (cambio di sessione) non si condivide.
  if (open && open.client === client) return open.promise;
  const promise = client.search.global(needle, undefined, { citable: true }).finally(() => {
    if (inFlight.get(needle)?.promise === promise) inFlight.delete(needle);
  });
  inFlight.set(needle, { client, promise });
  return promise;
}
