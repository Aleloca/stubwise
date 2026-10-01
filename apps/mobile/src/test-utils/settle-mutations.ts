import type { QueryClient } from "@tanstack/react-query";
import { act, waitFor } from "@testing-library/react-native";

/**
 * Aspetta che le mutazioni abbiano finito E che React Query abbia CONSEGNATO
 * il loro ultimo stato ai componenti, dentro `act`.
 *
 * Perché serve: il `notifyManager` di React Query consegna gli aggiornamenti
 * con un `setTimeout(0)`, e i callback della singola `mutate` (un `onDone`)
 * partono PRIMA di quella consegna. Un test che finisce su `waitFor(onDone)`
 * — o sulla sola chiamata del client, a mutazione ancora in volo — lascia
 * quel timer in coda: scatta fuori da `act` e React stampa «An update to …
 * inside a test was not wrapped in act(...)», solo a volte (dipende da
 * quando gira il timer rispetto alla pulizia del test, quindi più spesso
 * lanciando più file insieme).
 *
 * Il `waitFor` aspetta la fine delle mutazioni; il timer di `act` gira DOPO
 * quello della consegna, già in coda, che quindi scatta dentro `act`. Le
 * asserzioni sullo stato FINALE dell'hook (l'errore azzerato, `isPending`
 * spento) vanno scritte DOPO questa chiamata, non prima: prima leggerebbero
 * lo stato non ancora consegnato.
 */
export async function settleMutations(queryClient: QueryClient): Promise<void> {
  await waitFor(() => expect(queryClient.isMutating()).toBe(0));
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
