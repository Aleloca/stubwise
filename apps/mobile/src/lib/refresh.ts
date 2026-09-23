import type { QueryClient } from "@tanstack/react-query";

/**
 * Le due regole del ricaricamento GLOBALE (23 set 2026 — design «l'app non
 * resta indietro», §3 e §6), fuori dai componenti perché si possano provare
 * da sole.
 */

/**
 * Si può ricaricare adesso? No, se una MUTAZIONE è in corso.
 *
 * ⚠️ Il caso che lo rende necessario: «Fatto» su una notifica toglie SUBITO
 * la riga dalla cache (ottimistico) e poi aspetta il server. `onMutate`
 * chiama `cancelQueries` — ma quella annulla solo le richieste GIÀ in volo in
 * quel momento. Un ricaricamento partito DOPO (torni indietro mentre il
 * server risponde, o l'app torna in primo piano) chiederebbe la lista a un
 * server che il «Fatto» non l'ha ancora visto, e la riga ricomparirebbe per
 * un attimo — il ripensamento che l'ottimismo esiste per evitare.
 *
 * Aspettare non costa niente: ogni mutazione dell'app invalida ciò che ha
 * cambiato quando finisce, quindi quel ricaricamento avviene comunque, al
 * momento giusto. Il gate vale per TUTTE le mutazioni e non solo per le
 * ottimistiche: distinguerle chiederebbe di marcarle, cioè un'altra cosa da
 * ricordarsi, per risparmiare qualche centinaio di millisecondi.
 */
export function canRefreshNow(queryClient: QueryClient): boolean {
  return queryClient.isMutating() === 0;
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
