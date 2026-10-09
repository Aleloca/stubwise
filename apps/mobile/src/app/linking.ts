import type { LinkingOptions } from "@react-navigation/native";
import { Linking } from "react-native";
// Solo il TIPO: nessuna dipendenza a runtime da navigation.tsx (che invece
// importa le funzioni di QUESTO file) — un import `type` viene cancellato
// dal compilatore, quindi non introduce un ciclo require reale fra i due
// moduli, a differenza di un import normale.
import type { RootStackParamList } from "./navigation";
import { parseTicketTab } from "../lib/ticket-tabs";
import type { TicketTab } from "../lib/ticket-tabs";

/** Le aree che l'app sa aprire da un deep link (`stubwise://<area>/<id>`). */
export type DeepLinkArea = "inbox" | "tickets" | "projects" | "mail" | "calendar" | "agents";

/**
 * `mail` è a due segmenti (`mail/email/:id`), non uno: porta DIRETTAMENTE al
 * dettaglio di una proposta di posta (App M3, Fase C, Task 7 — architettura
 * §5 regola 2), mai alla lista. Solo `"email"`: è l'unica sorgente con un
 * `proposalId` che significhi qualcosa fuori dal worker (per `"calendar"` è
 * un `randomUUID()`, vedi `packages/notifications/src/push/payload.ts`), ed
 * è la stessa restrizione che il web applica allo stesso link
 * (`apps/web/src/components/inbox-item.tsx`).
 */
/**
 * `calendar` è l'unica area a portare una DATA e non (solo) un id, ed è una
 * conseguenza di come la griglia legge i dati: carica per INTERVALLO, quindi
 * senza sapere il giorno non saprebbe nemmeno quale mese chiedere. Il giorno
 * arriva da `receivedAt` della notifica, che per una proposta di calendario è
 * `calendar_events.starts_at` — quindi c'è anche sulle card pubblicate prima
 * di questa fase, e il link funziona su quelle senza nessun backfill.
 *
 * `eventId` (`calendar_events.id`) è opzionale per la stessa ragione: assente
 * si apre la giornata e basta. **Non è `proposalId`**, che per il calendario
 * resta un `randomUUID()` e deve restarlo — vedi il docblock di
 * `inboxGoogleSchema.calendarEventId` in `@stubwise/shared`.
 */
export type DeepLinkTarget =
  | { area: "projects"; id: string }
  /**
   * `session` solo se il link la chiede (`?session=1`, la push di una domanda
   * dell'agente, piano C): la card cerca la sessione e la apre al suo posto.
   */
  | { area: "inbox"; id: string; session?: true }
  /** `tab` solo se il link la chiede (`?tab=`), sempre passata da `parseTicketTab`. */
  | { area: "tickets"; id: string; tab?: TicketTab }
  | { area: "mail"; source: "email"; id: string }
  | { area: "calendar"; day: string; eventId?: string }
  /**
   * La tab AGT (sessioni degli agenti, piano C): `stubwise://agents` è
   * l'elenco, `stubwise://agents/:id` una sessione. `id` assente — mai
   * `undefined` esplicito — vuol dire l'elenco.
   */
  | { area: "agents"; id?: string };

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
/** `YYYY-MM-DD`, e una data che esiste davvero (non `2026-02-31`). */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false;
  // `2026-02-31` passa il pattern ma non è un giorno: `Date` lo normalizza al
  // 3 marzo, quindi il confronto con la stringa di partenza lo scarta.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function resolveDeepLinkTarget(url: string): DeepLinkTarget | null {
  if (!url.startsWith(SCHEME_PREFIX)) return null;
  // La query non fa parte del percorso: senza toglierla `tickets/abc?tab=x`
  // darebbe l'id «abc?tab=x».
  const [rawPath = "", query = ""] = url.slice(SCHEME_PREFIX.length).split("?", 2);
  const path = rawPath.replace(/^\/+|\/+$/, "");
  const parts = path.split("/");
  const [area] = parts;
  // A mano e non con `URLSearchParams`: Hermes non lo garantisce completo.
  const queryParam = (name: string) =>
    query
      .split("&")
      .map((pair) => pair.split("="))
      .find(([key]) => key === name);
  if (area === "inbox") {
    const id = parts[1];
    if (!id) return null;
    return queryParam("session")?.[1] === "1" ? { area, id, session: true } : { area, id };
  }
  if (area === "projects") {
    const id = parts[1];
    if (!id) return null;
    return { area, id };
  }
  if (area === "tickets") {
    const id = parts[1];
    if (!id) return null;
    const tabParam = queryParam("tab");
    if (tabParam === undefined) return { area, id };
    // Un link scritto da fuori può avere un encoding malformato (`%E0%A4`):
    // `decodeURIComponent` lancerebbe e il link andrebbe perso. Apre Stato.
    let rawTab: string;
    try {
      rawTab = decodeURIComponent(tabParam[1] ?? "");
    } catch {
      rawTab = "";
    }
    return { area, id, tab: parseTicketTab(rawTab) };
  }
  if (area === "mail") {
    const [, source, id] = parts;
    if (source !== "email" || !id) return null;
    return { area: "mail", source: "email", id };
  }
  if (area === "agents") {
    const id = parts[1];
    return id ? { area, id } : { area };
  }
  if (area === "calendar") {
    const [, day, eventId] = parts;
    // Un giorno illeggibile NON degrada a "apri il calendario e basta": la
    // griglia non saprebbe dove posizionarsi, e aprirla su oggi fingerebbe di
    // aver capito il link. Meglio nessun target, così il chiamante resta dov'è.
    if (!day || !isCalendarDay(day)) return null;
    return eventId ? { area: "calendar", day, eventId } : { area: "calendar", day };
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
      // Preflight H1: lo stack della posta sta sulla RADICE (`Mail`, sotto),
      // quindi un link a freddo a `mail/…` o `calendar/…` produrrebbe lo stato
      // `[Mail]` da solo — niente schede sotto, niente «indietro» (su Android
      // l'indietro uscirebbe dall'app). Con `Main` come rotta iniziale lo
      // stato diventa `[Main, Mail]`: le schede ci sono, e l'indietro ci torna.
      initialRouteName: "Main",
      screens: {
        Auth: {
          screens: {
            Login: "login",
            Onboarding: "onboarding",
          },
        },
        Main: {
          screens: {
            // `List` SOTTO la card (piano C, Task 8): dalla push di una domanda
            // la card si sostituisce con la sessione dell'agente, e senza la
            // lista sotto l'indietro della sessione non porterebbe da nessuna
            // parte. Il cast: vedi `Agents` più sotto.
            Inbox: {
              initialRouteName: "List" as never,
              screens: {
                List: "inbox",
                // `?session=1` arriva come STRINGA (preflight H2): il `parse` ne
                // fa il booleano dei params della card.
                Card: { path: "inbox/:id", parse: { session: (value: string) => value === "1" } },
              },
            },
            Projects: {
              screens: {
                // `docs` era il path del tab DOC, tolto il 25 set 2026: nessuna
                // notifica lo emette, ma un link già in giro atterra qui, da
                // dove si raggiunge la documentazione di ogni progetto.
                List: { path: "projects", alias: ["docs"] },
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
            // La tab AGT (sessioni degli agenti, piano C), al posto di MBX:
            // l'elenco e una sessione. L'elenco sta SOTTO la sessione: il suo
            // «indietro» è un `goBack`, che senza niente sotto non farebbe nulla.
            // Il cast: i tipi di react-navigation non sanno ricavare la lista
            // dei parametri di un navigatore ANNIDATO da `NavigatorScreenParams`
            // (ne esce `{}`, quindi `initialRouteName: never`); a runtime il
            // valore è letto così com'è, e il test di linking lo verifica.
            Agents: {
              initialRouteName: "List" as never,
              screens: {
                List: "agents",
                AgentSession: "agents/:id",
              },
            },
          },
        },
        // Posta e calendario (App M3, Fasi C e D), FUORI dalle schede dal
        // piano C delle sessioni degli agenti: AGT ha preso il posto di MBX, e
        // lo stesso stack si apre dal profilo, sopra le schede. I path non
        // cambiano — li emette il server nelle push —, cambia dove atterrano.
        // `MailDetail` porta all'oggetto (regola 2), non alla lista; il
        // calendario ci arriva da `List` con un GIORNO — la griglia carica
        // per intervallo, quindi il giorno è ciò che le serve per sapere quale
        // mese chiedere. Solo la forma con un giorno (`calendar/2026-09-17`,
        // con l'id dell'appuntamento facoltativo): `calendar` senza un giorno
        // leggibile non risolve (vedi `resolveDeepLinkTarget`).
        Mail: {
          screens: {
            MailDetail: "mail/:source/:id",
            List: "calendar/:day/:eventId?",
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
