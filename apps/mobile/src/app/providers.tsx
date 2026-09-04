import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { persistQueryClient } from "@tanstack/react-query-persist-client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isUnknown } from "@stubwise/shared";
import type { Reader, SessionUser } from "@stubwise/shared";
import notifee from "@notifee/react-native";
import { AppState, type AppStateStatus } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthContext, type AuthContextValue, type AuthState } from "./auth-context";
import { setLanguage } from "../i18n";
import { createClient, onSessionExpired } from "../lib/client";
import { setupPush } from "../lib/push";
import { inboxKeys } from "../lib/query-keys";
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

/** Intervallo del refresh del badge OS in primo piano (design doc §6: "ogni 60s"). */
const FOREGROUND_BADGE_INTERVAL_MS = 60_000;

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

  /**
   * Metà PUSH dell'app (Task 19, design doc §4/§6): registra il token,
   * ascolta il refresh e le pressioni sui bottoni mentre l'app è in primo
   * piano. Un utente sloggato non ha un device da registrare — da qui il
   * gate su `authenticated`. Il cleanup di `setupPush` disiscrive gli
   * ascoltatori quando il client cambia (nuovo login) o l'app va a
   * `unauthenticated` (401, logout).
   */
  useEffect(() => {
    if (state.status !== "authenticated" || state.client === null) return;
    return setupPush(state.client);
  }, [state.status, state.client]);

  /**
   * Badge OS e freschezza dell'inbox al FOREGROUND (design doc §6: "Badge =
   * unread-count al foreground e a ogni push ricevuta" — la push la copre
   * da sé via `badge` nel payload, questo effetto copre il "al foreground";
   * "contatore ogni 60 s solo in foreground").
   *
   * `isForeground` è una variabile LOCALE alla chiusura dell'effetto, non
   * `AppState.currentState`: il mock ufficiale di `AppState` per Jest
   * (`@react-native/jest-preset/jest/mocks/AppState.js`) tipa `currentState`
   * come un `jest.fn()`, non una stringa — leggerlo qui produrrebbe un
   * confronto sempre falso sotto test. Tenerla in chiusura la rende anche
   * l'unica fonte di verità, aggiornata dallo stesso listener che la legge.
   */
  useEffect(() => {
    if (state.status !== "authenticated" || state.client === null) return;
    const client = state.client;
    let isForeground = true;

    async function refreshBadge(): Promise<void> {
      try {
        const result = await client.inbox.unreadCount();
        await notifee.setBadgeCount(result.count);
      } catch {
        // Best-effort: un fallimento di rete non deve piantare l'app né
        // lasciare il badge scorretto per sempre — il prossimo giro (60s, o
        // il prossimo foreground) riprova da solo.
      }
    }

    function onForeground(): void {
      void queryClient.refetchQueries({ queryKey: inboxKeys.all });
      void refreshBadge();
    }

    const subscription = AppState.addEventListener("change", (next: AppStateStatus) => {
      isForeground = next === "active";
      if (isForeground) onForeground();
    });

    const interval = setInterval(() => {
      if (isForeground) void refreshBadge();
    }, FOREGROUND_BADGE_INTERVAL_MS);

    return () => {
      subscription.remove();
      clearInterval(interval);
    };
  }, [state.status, state.client]);

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
