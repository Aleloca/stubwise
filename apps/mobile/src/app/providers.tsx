import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { persistQueryClient } from "@tanstack/react-query-persist-client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isUnknown } from "@stubwise/shared";
import type { Reader, SessionUser } from "@stubwise/shared";
import notifee from "@notifee/react-native";
import { useNetInfo } from "@react-native-community/netinfo";
import { useTranslation } from "react-i18next";
import { AppState, Pressable, StyleSheet, Text, View, type AppStateStatus } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthContext, type AuthContextValue, type AuthState } from "./auth-context";
import { OfflineBanner } from "../components/OfflineBanner";
import { setLanguage } from "../i18n";
import { createClient, onSessionExpired } from "../lib/client";
import { setupPush } from "../lib/push";
import { inboxKeys } from "../lib/query-keys";
import { getLastSyncAt, loadSession, saveSession, setLastSyncAt, type StoredSession } from "../lib/storage";
import { SettingsSheet } from "../screens/settings/SettingsSheet";
import { colors } from "../theme/tokens";
import { fontFamily } from "../theme/typography";

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
  // Task 20: "ultima sincronizzazione" (banner offline) si aggiorna a OGNI
  // fetch riuscita gestita da TanStack Query — non solo dall'Inbox (che aveva
  // la propria chiamata ad-hoc a `setLastSyncAt`: rimossa dal fix del Task 20
  // — commit 393d8b0 — insieme al banner locale duplicato). Un `QueryCache`
  // con `onSuccess` GLOBALE copre ogni schermo, presente e futuro, senza che
  // ciascuno debba ricordarsi di chiamare `setLastSyncAt` da sé — persiste
  // su AsyncStorage (non nello state di questo componente: il valore
  // reattivo per il banner lo rilegge `AppProviders` sotto, alle transizioni
  // online/offline, dove serve davvero).
  queryCache: new QueryCache({
    onSuccess: () => {
      void setLastSyncAt(new Date().toISOString());
    },
  }),
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
  const { t } = useTranslation();
  const [state, setState] = useState<AuthState>({
    status: "loading",
    client: null,
    user: null,
    justLoggedIn: false,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lastSyncAt, setLastSyncAtState] = useState<string | null>(null);

  // `isConnected !== false`, non `=== true`: stessa regola di `useIsOnline`
  // (`lib/inbox-mutations.ts`) — `null` (stato non ancora noto, es. al
  // primissimo render) resta online per default. NON importato da lì:
  // quel file importa `useAuth` da QUESTO modulo, e il giro opposto
  // creerebbe un ciclo (vedi il docblock su `inboxKeys` più sotto).
  const netInfo = useNetInfo();
  const online = netInfo.isConnected !== false;

  /**
   * Valore REATTIVO di `lastSyncAt` per il banner globale — la scrittura
   * (persistita) è il `QueryCache.onSuccess` sopra. Rilette da AsyncStorage
   * a ogni transizione online/offline (compreso il mount, che è la PRIMA
   * transizione che questo effetto vede): mentre `online` resta true non
   * serve una copia più fresca (il banner non è a schermo), e mentre resta
   * false nessuna nuova sincronizzazione può comunque essere avvenuta — il
   * momento che conta è esattamente quando si passa a offline.
   */
  useEffect(() => {
    void getLastSyncAt().then(setLastSyncAtState);
  }, [online]);

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

  /**
   * Chrome globale (banner offline + avatar → Impostazioni, Task 20): visibile
   * su OGNI tab, non solo l'Inbox — da qui vive in `AppProviders`, l'unico
   * antenato comune a tutta la navigazione autenticata, invece che duplicato
   * schermo per schermo. Gate su `authenticated && !justLoggedIn`: lo stesso
   * di `showMain` in `navigation.tsx` — durante l'Onboarding (`justLoggedIn`)
   * non c'è ancora nulla da gestire nelle Impostazioni.
   *
   * ⚠️ DEBITO NOTO, SEGNALATO IN REVISIONE (Task 20): questo file ha superato
   * la soglia della leggibilità-in-un-colpo-d'occhio (bootstrap sessione,
   * `onSessionExpired`, wiring `setupPush`+cleanup del Task 19, refresh badge
   * foreground, e ora questa chrome + `lastSyncAt`). Estrarre un
   * `AppChrome.tsx` (riceve `state`/`online`/`lastSyncAt`, si occupa solo di
   * top-bar+sheet) è il refactor giusto — RIMANDATO di proposito qui: è
   * l'ultimo task funzionale della fase C, il refactor è puramente
   * organizzativo (nessun comportamento cambierebbe) e il rischio di una
   * regressione dell'ultimo minuto su un task già approvato-con-riserve pesa
   * più del beneficio immediato. Chi tocca ancora questo file in fase D
   * (dove diventerebbe più economico farlo PRIMA di aggiungere altro sopra)
   * lo consideri il momento giusto.
   */
  const showChrome = state.status === "authenticated" && !state.justLoggedIn && state.client !== null && state.user !== null;

  /** Logout riuscito (best-effort remoto + pulizia locale, vedi `SettingsSheet`): torna a `unauthenticated`. */
  function handleLoggedOut(): void {
    setSettingsOpen(false);
    setState({ status: "unauthenticated", client: null, user: null, justLoggedIn: false });
  }

  const avatarInitial = state.user ? state.user.email.charAt(0).toUpperCase() : "";

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <AuthContext.Provider value={value}>
          <View style={styles.root}>
            {showChrome && (
              <View style={styles.topBar}>
                <View style={styles.topBarBanner}>{!online && <OfflineBanner lastSyncAt={lastSyncAt} />}</View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("mobile.settings.openLabel")}
                  onPress={() => setSettingsOpen(true)}
                  style={styles.avatarButton}
                  testID="settings-avatar-button"
                >
                  <Text style={styles.avatarLabel}>{avatarInitial}</Text>
                </Pressable>
              </View>
            )}
            {children}
            {showChrome && state.client && state.user && (
              <SettingsSheet
                visible={settingsOpen}
                onRequestClose={() => setSettingsOpen(false)}
                client={state.client}
                user={state.user}
                onLoggedOut={handleLoggedOut}
              />
            )}
          </View>
        </AuthContext.Provider>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  topBar: {
    alignItems: "center",
    backgroundColor: colors.ink900,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  topBarBanner: {
    flex: 1,
  },
  avatarButton: {
    alignItems: "center",
    backgroundColor: colors.ink800,
    borderRadius: 16,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  avatarLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 13,
  },
});
