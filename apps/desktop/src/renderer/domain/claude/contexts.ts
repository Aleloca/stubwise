import type { ContextRef } from "../../data/types";

// Lotto 8, §1 (decisione del maintainer, «Tutti quelli aperti»; scelte di 46,
// 24 nov 2026): i contesti di una conversazione si ACCUMULANO. Il gruppo è
// della conversazione; l'ultimo è il primario (la pagina da cui si scrive);
// al più `MAX_CONVERSATION_CONTEXTS`, e il più vecchio esce senza chiedere.
// La stessa regola del server (`PATCH { context }` aggiunge in fondo).

export const MAX_CONVERSATION_CONTEXTS = 5;

/** Lo stesso riferimento (stesso tipo, stesso oggetto o pagina). */
export const sameContext = (a: ContextRef, b: ContextRef): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** Il gruppo con `ref` in fondo: tolto se c'era già, e il più vecchio oltre il tetto. */
export function withContext(group: readonly ContextRef[], ref: ContextRef): ContextRef[] {
  const next = [...group.filter((c) => !sameContext(c, ref)), ref];
  return next.slice(-MAX_CONVERSATION_CONTEXTS);
}

/** Il gruppo senza `ref` (la × di un chip). */
export const withoutContext = (group: readonly ContextRef[], ref: ContextRef): ContextRef[] =>
  group.filter((c) => !sameContext(c, ref));
