import type { QueryClient } from "@tanstack/react-query";

/**
 * Le due regole del ricaricamento GLOBALE (23 set 2026 — design «l'app non
 * resta indietro», §3 e §6), fuori dai componenti perché si possano provare
 * da sole.
 */

/**
 * La chiave di OGNI mutazione OTTIMISTICA dell'app — quelle che scrivono la
 * cache PRIMA che il server risponda. Oggi una sola: `useOptimisticRemoval`
 * (`lib/inbox-mutations.ts`), da cui passano «Fatto» e «Rimanda».
 *
 * ⚠️ **Chi aggiunge una mutazione ottimistica nuova le mette questa chiave**
 * (`mutationKey: OPTIMISTIC_MUTATION_KEY`), o riapre il difetto che
 * `canRefreshNow` chiude: senza, un ricaricamento globale partito mentre
 * aspetta il server riporterebbe per un attimo lo stato di prima.
 */
export const OPTIMISTIC_MUTATION_KEY = ["optimistic"] as const;

/**
 * Si può ricaricare adesso? No, se una mutazione OTTIMISTICA è in corso.
 *
 * ⚠️ Il caso che lo rende necessario: «Fatto» su una notifica toglie SUBITO
 * la riga dalla cache e poi aspetta il server. `onMutate` chiama
 * `cancelQueries` — ma quella annulla solo le richieste GIÀ in volo in quel
 * momento. Un ricaricamento partito DOPO (torni indietro mentre il server
 * risponde, o l'app torna in primo piano) chiederebbe la lista a un server
 * che il «Fatto» non l'ha ancora visto, e la riga ricomparirebbe per un
 * attimo — il ripensamento che l'ottimismo esiste per evitare. Aspettare non
 * costa niente: la mutazione invalida ciò che ha cambiato quando finisce.
 *
 * ⚠️ **Solo le ottimistiche, e non tutte le mutazioni, apposta.** Per una
 * mutazione NON ottimistica il rischio non c'è: il ricaricamento legge lo
 * stato di prima, la mutazione finisce, invalida, e si ricarica lo stato
 * giusto — al massimo un fetch in più, mai un dato sbagliato. Bloccare
 * durante QUALSIASI mutazione invece costa: un turno di chat col backlog o
 * col progetto resta in corso per tutto il lavoro dell'agente, anche decine
 * di secondi, e un ricaricamento saltato in quel tempo non si ripete quando
 * finisce — cioè proprio la schermata che resta indietro, il caso che questo
 * lavoro esiste per chiudere. (Era la prima versione di questa regola.)
 */
export function canRefreshNow(queryClient: QueryClient): boolean {
  return queryClient.isMutating({ mutationKey: OPTIMISTIC_MUTATION_KEY }) === 0;
}

/**
 * Ricarica le query MONTATE e SCADUTE — la regola del ritorno su una
 * schermata (`RootNavigator`, `app/navigation.tsx`).
 *
 * `cancelRefetch: false`: aprendo una schermata la sua query è già partita
 * dal montaggio, e il default (`true`) la annullerebbe per rifarla — due
 * richieste per ogni schermata aperta. Così si riusa quella in volo.
 */
export async function refreshStaleQueries(queryClient: QueryClient): Promise<void> {
  if (!canRefreshNow(queryClient)) return;
  await queryClient.refetchQueries({ type: "active", stale: true }, { cancelRefetch: false });
}
