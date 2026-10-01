/**
 * Avvisi NON bloccanti della creazione di una repository (D7), portati dal
 * wizard al dettaglio con lo stato di navigazione di TanStack Router. Sono
 * l'esito di UN salvataggio, non una proprietà della repository: un link
 * condiviso non li porta, e — poiché `history.state` SOPRAVVIVE a un reload e
 * a back/forward — il dettaglio li CONSUMA alla prima lettura, riscrivendo la
 * voce corrente con {@link withoutRepositoryWarnings}.
 *
 * Niente augmentation di `HistoryState`: la dichiara `@tanstack/history`, che
 * non è una dipendenza diretta del web (pnpm non la risolve da qui). Si scrive
 * con {@link withRepositoryWarnings} e si rilegge con
 * {@link readRepositoryWarnings}, che valida invece di fidarsi: lo stato di
 * history è un dato che sopravvive ai deploy, e può avere qualunque forma.
 */
const KEY = "repositoryWarnings";

export function withRepositoryWarnings<T extends object>(
  prev: T,
  warnings: readonly string[],
): T {
  return { ...prev, [KEY]: [...warnings] };
}

export function readRepositoryWarnings(state: unknown): string[] | undefined {
  if (typeof state !== "object" || state === null || !(KEY in state)) return undefined;
  const value: unknown = (state as Record<string, unknown>)[KEY];
  // Si restituisce lo STESSO array, mai una copia: è il valore di un selettore
  // di `useRouterState`, e un riferimento nuovo a ogni lettura farebbe
  // ri-renderizzare a ogni cambio dello store del router.
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value as string[];
}

/** Lo stato senza gli avvisi: per consumarli dopo averli letti. */
export function withoutRepositoryWarnings<T extends object>(prev: T): T {
  const next = { ...prev };
  Reflect.deleteProperty(next, KEY);
  return next;
}
