import type { LinkingOptions } from "@react-navigation/native";
import { Linking } from "react-native";
// Solo il TIPO: nessuna dipendenza a runtime da navigation.tsx (che invece
// importa le funzioni di QUESTO file) — un import `type` viene cancellato
// dal compilatore, quindi non introduce un ciclo require reale fra i due
// moduli, a differenza di un import normale.
import type { RootStackParamList } from "./navigation";

/** Le quattro aree che l'app sa aprire da un deep link (`stubwise://<area>/<id>`). */
export type DeepLinkArea = "inbox" | "tickets" | "projects" | "mail";

/**
 * `mail` è a due segmenti (`mail/email/:id`), non uno: porta DIRETTAMENTE al
 * dettaglio di una proposta di posta (App M3, Fase C, Task 7 — architettura
 * §5 regola 2), mai alla lista. Solo `"email"`: è l'unica sorgente con un
 * `proposalId` che significhi qualcosa fuori dal worker (per `"calendar"` è
 * un `randomUUID()`, vedi `packages/notifications/src/push/payload.ts`), ed
 * è la stessa restrizione che il web applica allo stesso link
 * (`apps/web/src/components/inbox-item.tsx`).
 */
export type DeepLinkTarget =
  | { area: "inbox" | "tickets" | "projects"; id: string }
  | { area: "mail"; source: "email"; id: string };

const SCHEME_PREFIX = "stubwise://";

/**
 * Parser puro `stubwise://inbox/abc` → `{ area: "inbox", id: "abc" }` (e
 * `stubwise://mail/email/abc` → `{ area: "mail", source: "email", id: "abc" }`).
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
  const parts = path.split("/");
  const [area] = parts;
  if (area === "inbox" || area === "tickets" || area === "projects") {
    const id = parts[1];
    if (!id) return null;
    return { area, id };
  }
  if (area === "mail") {
    const [, source, id] = parts;
    if (source !== "email" || !id) return null;
    return { area: "mail", source: "email", id };
  }
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
            // Solo la lista è raggiungibile da deep link: nessuna area
            // "backlog" in `DeepLinkArea` sopra, e questo task non ne
            // aggiunge una (nessuna notifica punta oggi a una voce del
            // backlog) — `Item`/`Chat` restano senza un path.
            Backlog: {
              screens: {
                List: "backlog",
              },
            },
            Docs: "docs",
            // Task 7 (App M3, Fase C): `MailDetail` è l'unico screen di MBX
            // raggiungibile da fuori — porta all'oggetto (regola 2), non alla
            // lista. `List` (il segnaposto posta/calendario) non ha un path:
            // niente notifica punta oggi a "apri MBX e basta".
            Mbx: {
              screens: {
                MailDetail: "mail/:source/:id",
              },
            },
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
