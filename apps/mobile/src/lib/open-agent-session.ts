import { StackActions } from "@react-navigation/native";
import type { AgentSessionParams } from "../app/navigation";

/** Quanto serve di una `navigation` per aprire la sessione (sale al ROOT stack). */
export interface SessionOpener {
  navigate(name: "AgentSession", params: AgentSessionParams, options: { pop: true }): void;
}

/** In più, per uscire dal proprio stack: la sua chiave e il `dispatch`. */
export interface ReplaceableNavigation extends SessionOpener {
  getState(): { key: string };
  dispatch(action: ReturnType<typeof StackActions.pop> & { target: string }): void;
}

/**
 * Apre la sessione di un agente, che sta sul ROOT stack (9 ott 2026, Task A1).
 *
 * `pop: true` insieme al `getId` della rotta (l'id della sessione, in
 * `navigation.tsx`): se QUELLA sessione è già nel root stack — si è aperto il
 * suo ticket, e dal ticket di nuovo la sessione — si torna a lei togliendo ciò
 * che le sta sopra, invece di impilarne un doppione. Una sessione diversa si
 * spinge sopra, come sempre.
 */
export function openAgentSession(navigation: SessionOpener, params: AgentSessionParams): void {
  navigation.navigate("AgentSession", params, { pop: true });
}

/**
 * Apre la sessione AL POSTO della schermata corrente: la card di una domanda
 * aperta dalla push, la ricerca per job.
 *
 * La sessione sta sul ROOT stack, la schermata che la apre in uno stack delle
 * schede. `replace` non va: lo stack della schermata non ha la rotta, l'azione
 * sale al root, e lì sostituirebbe la rotta a fuoco — `Main`, cioè tutte le
 * schede. Quindi due passi:
 *
 * 1. {@link openAgentSession} sale al root e ci mette la sessione, sopra le
 *    schede;
 * 2. un POP col BERSAGLIO sullo stack della schermata (la chiave letta PRIMA
 *    del passo 1) la toglie da lì: chiudendo la sessione si torna a ciò che
 *    c'era prima (la lista, l'hub, il ticket), non alla card, che ripartirebbe.
 *    Il `dispatch` della schermata aggiunge da sé la sua chiave come `source`,
 *    quindi si toglie proprio lei, anche non più a fuoco. Il bersaglio non è
 *    un dettaglio: senza, un POP che nello stack non trova niente da togliere
 *    (la schermata prima del suo stack) SALIREBBE al root e chiuderebbe la
 *    sessione appena aperta. Con il bersaglio, react-navigation lo lascia
 *    cadere lì.
 *
 * Prima la sessione e poi il POP: lo stack della schermata cambia DIETRO la
 * sessione. ⚠️ Mentre la sessione entra, iOS mostra di lato la scena di sotto:
 * il cambio sotto potrebbe vedersi — da controllare sul telefono.
 */
export function replaceWithAgentSession(navigation: ReplaceableNavigation, params: AgentSessionParams): void {
  const target = navigation.getState().key;
  openAgentSession(navigation, params);
  navigation.dispatch({ ...StackActions.pop(), target });
}
