import type { StubwiseClient } from "@stubwise/api-client";
import type { Reader, SessionUser } from "@stubwise/shared";
import { createContext, useContext } from "react";
import type { StoredSession } from "../lib/storage";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface AuthState {
  status: AuthStatus;
  client: StubwiseClient | null;
  // Reader<SessionUser>: stessa ragione di StoredSession.user (lib/storage.ts).
  user: Reader<SessionUser> | null;
  /**
   * `true` SOLO fra un login riuscito in QUESTA sessione dell'app e la fine
   * dell'onboarding (`completeOnboarding`) — mai quando la sessione arriva
   * dal Keychain all'avvio. È la differenza fra "ho appena fatto login,
   * mostrami l'onboarding" e "ho già un token, portami dritto a Main": la
   * stessa `status === "authenticated"` copre entrambi i casi, ma solo il
   * primo deve passare da Onboarding. Vive qui (non persistito) perché
   * l'onboarding va mostrato una volta per login, non a ogni riavvio
   * dell'app con una sessione già valida.
   */
  justLoggedIn: boolean;
}

export interface AuthContextValue extends AuthState {
  /** Login riuscito: salva la sessione nel Keychain, NON monta ancora `Main` (vedi `justLoggedIn`). */
  login: (session: StoredSession) => Promise<void>;
  /** Onboarding finito (attivato o saltato con "Più tardi"): monta `Main`. */
  completeOnboarding: () => void;
  /**
   * Porta alla PAGINA Impostazioni (16 set 2026). Fino a quel giorno apriva
   * uno SHEET montato in `AppProviders`; ora naviga sul root stack, e il
   * nome è rimasto perché la domanda a cui risponde è la stessa: «portami
   * alle Impostazioni». Chi la chiama non deve sapere se sono una pagina o
   * un pannello.
   */
  openSettings: () => void;
  /**
   * Il logout è finito (best-effort remoto + pulizia locale): l'app torna a
   * `unauthenticated`.
   *
   * ⚠️ Qui c'era `openSettings`, che apriva uno SHEET montato in
   * `AppProviders`. Dal 16 set 2026 le Impostazioni sono una PAGINA sul root
   * stack e l'avatar ci NAVIGA (`SettingsAvatarButton`): non serve più un
   * canale sul contesto per aprirle. Serve invece il verso opposto — la
   * pagina deve poter dire ad `AppProviders` che la sessione è finita.
   */
  loggedOut: () => void;
}

/**
 * Estratto in un file a sé (invece di vivere dentro `providers.tsx`) per una
 * ragione sola: i test degli screen sotto `Main`/`Onboarding` (che hanno
 * bisogno solo di UN client finto, non di un intero bootstrap Keychain +
 * QueryClient + persister) possono avvolgerli in
 * `<AuthContext.Provider value={...}>` senza montare `<AppProviders>` per
 * intero — vedi `OnboardingScreen.test.tsx`.
 */
export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth va chiamato dentro <AppProviders> (o <AuthContext.Provider> nei test)");
  return value;
}
