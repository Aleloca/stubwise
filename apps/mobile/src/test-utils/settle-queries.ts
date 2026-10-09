import type { QueryClient } from "@tanstack/react-query";
import { act, waitFor } from "@testing-library/react-native";

/**
 * Aspetta che le query abbiano finito di caricare E che React Query abbia
 * CONSEGNATO il risultato ai componenti, dentro `act`. Gemello di
 * `settleMutations` (stesso file accanto), per le query.
 *
 * Serve ai test NEGATIVI su un effetto che parte dal risultato di una query
 * («la ricerca risponde, e NON si naviga»): senza, l'asserzione negativa può
 * girare prima che il risultato sia arrivato al componente, e passare per il
 * motivo sbagliato. Il `notifyManager` consegna con un `setTimeout(0)`: il
 * `waitFor` aspetta la fine delle richieste, il timer di `act` gira DOPO
 * quello della consegna, già in coda — quindi il render col risultato e i
 * suoi effetti sono avvenuti quando questa funzione torna. Nessuna attesa a
 * tempo: l'ordine dei timer a 0 ms è quello di inserimento.
 *
 * Un negativo scritto così va sempre accompagnato da un controllo POSITIVO
 * con la stessa sequenza, che provi che l'effetto, quando deve, è già
 * avvenuto al ritorno di questa funzione.
 */
export async function settleQueries(queryClient: QueryClient): Promise<void> {
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
