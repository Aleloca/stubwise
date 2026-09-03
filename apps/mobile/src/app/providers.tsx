import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { persistQueryClient } from "@tanstack/react-query-persist-client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isUnknown } from "@stubwise/shared";
import type { Reader, SessionUser } from "@stubwise/shared";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthContext, type AuthContextValue, type AuthState } from "./auth-context";
import { setLanguage } from "../i18n";
import { createClient, onSessionExpired } from "../lib/client";
import { loadSession, saveSession, type StoredSession } from "../lib/storage";

/**
 * Allinea la lingua dell'app a `user.language` — MA quel campo è
 * `Reader<Language>` (vedi `StoredSession.user` in `lib/storage.ts`): un
 * server più nuovo di questa build dell'app potrebbe avere aggiunto una
 * lingua che non conosciamo, e in quel caso il valore è il segnaposto
 * `UNKNOWN`, non una vera lingua. `setLanguage` non lo accetta (giustamente:
 * non esiste un catalogo `mobile.*` per una lingua ignota) — si resta sulla
 * lingua corrente invece di piantare un errore all'avvio.
 */
function applyUserLanguage(user: Reader<SessionUser>): void {
  if (isUnknown(user.language)) return;
  setLanguage(user.language);
}

export { useAuth } from "./auth-context";
export type { AuthContextValue } from "./auth-context";

/**
 * Cache di TanStack Query persistita su disco — pattern UFFICIALE
 * (`createAsyncStoragePersister` + `persistQueryClient`), non una
 * persistenza scritta a mano: è quanto chiede il Task 13 ("AsyncStorage col
 * pattern ufficiale"). Un solo `QueryClient` per l'intera app, creato fuori
 * dal componente perché deve sopravvivere ai re-render.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // I dati di Stubwise cambiano per iniziativa di altri (un altro
      // maintainer risponde, il worker finisce un job): un retry solo, i
      // task successivi (inbox, pulse) decideranno l'intervallo di refetch
      // per singola query.
      retry: 1,
    },
  },
});

const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: "stubwise-query-cache",
});

void persistQueryClient({ queryClient, persister });

/**
 * Bootstrap della sessione (letta dal Keychain all'avvio) + reazione alla
 * scadenza (401 da `lib/client.ts`, vedi `onSessionExpired`). `status`
 * parte `"loading"`: finché non sappiamo se c'è una sessione, il root
 * navigator (`navigation.tsx`) non deve ancora decidere fra `Auth` e
 * `Main`, o lampeggerebbe la schermata sbagliata per un istante a ogni
 * avvio a freddo.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    status: "loading",
    client: null,
    user: null,
    justLoggedIn: false,
  });

  useEffect(() => {
    let cancelled = false;
    void loadSession().then((session) => {
      if (cancelled) return;
      if (!session) {
        setState({ status: "unauthenticated", client: null, user: null, justLoggedIn: false });
        return;
      }
      applyUserLanguage(session.user);
      setState({
        status: "authenticated",
        client: createClient(session.baseUrl),
        user: session.user,
        justLoggedIn: false,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return onSessionExpired(() => {
      setState({ status: "unauthenticated", client: null, user: null, justLoggedIn: false });
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login: async (session: StoredSession) => {
        await saveSession(session);
        applyUserLanguage(session.user);
        setState({
          status: "authenticated",
          client: createClient(session.baseUrl),
          user: session.user,
          justLoggedIn: true,
        });
      },
      completeOnboarding: () => {
        setState((current) => ({ ...current, justLoggedIn: false }));
      },
    }),
    [state],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
