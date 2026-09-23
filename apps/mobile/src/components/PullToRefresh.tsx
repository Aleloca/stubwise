import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { RefreshControl } from "react-native";
import { colors } from "../theme/tokens";

/**
 * «TRASCINA PER AGGIORNARE», uguale su ogni schermata con dati del server
 * (23 set 2026 — design «l'app non resta indietro», §5).
 *
 * Restituisce il `RefreshControl` da passare allo `ScrollView` della
 * schermata. Il gesto ricarica le query delle chiavi date — quelle di QUELLA
 * schermata — e la rotella resta finché non hanno finito TUTTE: una rotella
 * che sparisce quando la prima risposta arriva direbbe «aggiornato» su una
 * schermata ancora a metà.
 *
 * Le chiavi sono PREFISSI (`backlogKeys.all` ricarica ogni query del backlog
 * montata), e si ricaricano solo le query MONTATE (`type: "active"`): una
 * query che nessuna schermata sta leggendo non ha niente da mostrare.
 *
 * ⚠️ Le chiavi le passa chi monta: la schermata sa cosa mostra, questo
 * componente no. Una sezione aggiunta a una schermata con una chiave nuova va
 * aggiunta anche qui, o il gesto non la ricarica — l'unica cosa da ricordarsi,
 * ma locale alla schermata e visibile a chi la tocca. Il ricaricamento al
 * ritorno e gli intervalli, che invece valgono per tutte, stanno in un punto
 * solo (`app/navigation.tsx`, `app/providers.tsx`).
 *
 * Le due inbox hanno il loro `RefreshControl` da prima (`query.refetch()` su
 * una query sola): la forma di riferimento di questo, lasciate com'erano.
 */
export function usePullToRefresh(queryKeys: readonly QueryKey[], testID?: string) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  // Smontata a metà ricaricamento (si torna indietro mentre gira): niente
  // `setState` su un componente che non c'è più.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function onRefresh(): Promise<void> {
    setRefreshing(true);
    try {
      await Promise.all(queryKeys.map((queryKey) => queryClient.refetchQueries({ queryKey, type: "active" })));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }

  return (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => void onRefresh()}
      tintColor={colors.signal}
      testID={testID}
    />
  );
}
