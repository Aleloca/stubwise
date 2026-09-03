import type { LinkingOptions } from "@react-navigation/native";
import { Linking } from "react-native";
// Solo il TIPO: nessuna dipendenza a runtime da navigation.tsx (che invece
// importa le funzioni di QUESTO file) — un import `type` viene cancellato
// dal compilatore, quindi non introduce un ciclo require reale fra i due
// moduli, a differenza di un import normale.
import type { RootStackParamList } from "./navigation";

/** Le tre aree che l'app sa aprire da un deep link (`stubwise://<area>/<id>`). */
export type DeepLinkArea = "inbox" | "tickets" | "projects";

export interface DeepLinkTarget {
  area: DeepLinkArea;
  id: string;
}

const SCHEME_PREFIX = "stubwise://";

/**
 * Parser puro `stubwise://inbox/abc` → `{ area: "inbox", id: "abc" }`.
 *
 * Scritto a mano invece di far passare l'URL dal parser di react-navigation
 * (`getStateFromPath`) perché deve poter girare ANCHE quando non c'è ancora
 * una sessione — cioè quando i soli screen montati sono quelli di `Auth` e
 * "Main/Inbox/Card" non esiste nell'albero — un caso che il parser di
 * react-navigation non è pensato per gestire (vedi {@link getPendingDeepLink}).
 */
export function resolveDeepLinkTarget(url: string): DeepLinkTarget | null {
  if (!url.startsWith(SCHEME_PREFIX)) return null;
  const path = url.slice(SCHEME_PREFIX.length).replace(/^\/+|\/+$/, "");
  const [area, id] = path.split("/");
  if (!id) return null;
  if (area === "inbox" || area === "tickets" || area === "projects") return { area, id };
  return null;
}

/**
 * Deep link "in sospeso": arrivato mentre l'utente non era autenticato (link
 * dalla lock screen col telefono mai loggato, o mentre l'app è ferma sulla
 * schermata di login). UN VALORE IN MEMORIA basta — non deve sopravvivere a
 * un riavvio del processo, solo al tempo che l'utente impiega a fare login
 * nella STESSA sessione dell'app (vedi il design doc del Task 13).
 *
 * Nessun pub/sub: chi lo consuma è `MainNavigator`
 * (`src/app/navigation.tsx`), che chiama {@link getPendingDeepLink} UNA
 * VOLTA in un `useEffect` al mount (cioè subito dopo il login, quando `Main`
 * viene montato per la prima volta) e poi lo azzera con
 * {@link setPendingDeepLink}.
 */
let pendingUrl: string | null = null;

export function setPendingDeepLink(url: string | null): void {
  pendingUrl = url;
}

export function getPendingDeepLink(): string | null {
  return pendingUrl;
}

/**
 * Config di `linking` per `NavigationContainer`. Copre il caso NORMALE (app
 * già autenticata, `Main` montato: react-navigation risolve `inbox/:id` ecc.
 * da sé via `config.screens`) e mette da parte il caso "arrivato prima del
 * login": `getInitialURL`/`subscribe` NON passano l'URL al navigator finché
 * `isAuthenticated()` non torna `true` — lo mettono in
 * {@link setPendingDeepLink} invece, e chi monta `Main`
 * (`src/app/navigation.tsx`) lo consuma con {@link resolveDeepLinkTarget} al
 * primo render.
 *
 * `isAuthenticated` è una funzione (letta a ogni evento) e non un booleano
 * catturato alla creazione: la config si costruisce una sola volta
 * (`useMemo` in `navigation.tsx`), ma lo stato di auth cambia nel tempo.
 */
export function buildLinking(isAuthenticated: () => boolean): LinkingOptions<RootStackParamList> {
  return {
    prefixes: ["stubwise://"],
    config: {
      screens: {
        Auth: {
          screens: {
            Login: "login",
            Onboarding: "onboarding",
          },
        },
        Main: {
          screens: {
            Inbox: {
              screens: {
                List: "inbox",
                Card: "inbox/:id",
              },
            },
            Projects: {
              screens: {
                List: "projects",
                Detail: "projects/:id",
                Ticket: "tickets/:id",
              },
            },
            Backlog: "backlog",
            Docs: "docs",
          },
        },
      },
    },
    async getInitialURL() {
      const url = await Linking.getInitialURL();
      if (!url) return undefined;
      if (isAuthenticated()) return url;
      setPendingDeepLink(url);
      return undefined;
    },
    subscribe(listener) {
      const subscription = Linking.addEventListener("url", ({ url }) => {
        if (isAuthenticated()) {
          listener(url);
        } else {
          setPendingDeepLink(url);
        }
      });
      return () => subscription.remove();
    },
  };
}
