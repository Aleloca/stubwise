/**
 * Querystring da una mappa di parametri, saltando quelli assenti.
 *
 * Un `undefined` non diventa `param=undefined` e una stringa vuota non diventa
 * `param=`: più di una rotta (la lista ticket con `statuses`) risponde 400 a un
 * parametro presente ma vuoto, quindi "assente" e "vuoto" non sono la stessa
 * cosa e la distinzione va fatta qui, una volta, invece che in ogni endpoint.
 */
export function toQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

/** Segmento di path da un id: gli id dell'API sono uuid, ma non si dà per scontato. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}
