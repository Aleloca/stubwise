import type { AgentSessionParams } from "../app/navigation";

/** Quanto serve di una `navigation` di schermata: aprire una rotta e uscire dal proprio stack. */
export interface ReplaceableNavigation {
  navigate(name: "AgentSession", params: AgentSessionParams): void;
  pop(): void;
}

/**
 * Apre la sessione di un agente AL POSTO della schermata corrente (9 ott 2026,
 * Task A1): la card di una domanda aperta dalla push, la ricerca per job.
 *
 * La sessione sta sul ROOT stack, la schermata che la apre in uno stack delle
 * schede. `replace` non va: lo stack della schermata non ha la rotta, l'azione
 * sale al root, e lì sostituirebbe la rotta a fuoco — `Main`, cioè tutte le
 * schede. Quindi due passi:
 *
 * 1. `navigate` sale al root e ci spinge la sessione, sopra le schede;
 * 2. `pop` toglie la schermata dal SUO stack, che resta lì sotto: chiudendo
 *    la sessione si torna a ciò che c'era prima della card (la lista, l'hub),
 *    non alla card, che ripartirebbe da capo.
 *
 * Prima la sessione e poi il `pop`: lo stack della schermata cambia DIETRO la
 * sessione, senza far vedere per un istante la schermata di sotto. Il `pop` di
 * una schermata non più a fuoco funziona lo stesso: lo stack su cui agisce è
 * il suo, e lì è ancora in cima.
 */
export function replaceWithAgentSession(navigation: ReplaceableNavigation, params: AgentSessionParams): void {
  navigation.navigate("AgentSession", params);
  navigation.pop();
}
