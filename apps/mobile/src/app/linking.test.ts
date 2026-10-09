import { getStateFromPath } from "@react-navigation/native";
import { buildLinking, resolveDeepLinkTarget } from "./linking";

/**
 * Il parser dei deep link (App M3): puro, quindi si prova qui senza montare
 * l'albero di navigazione — `navigation.test.tsx` verifica invece che da un
 * URL si arrivi davvero alla schermata giusta.
 *
 * Gli URL arrivano da fuori (una push, un link in un messaggio): tutto ciò
 * che non è riconosciuto deve valere `null`, mai un target "quasi giusto".
 */
describe("aree storiche", () => {
  test("inbox, tickets e projects: un'area e un id", () => {
    expect(resolveDeepLinkTarget("stubwise://inbox/abc")).toEqual({ area: "inbox", id: "abc" });
    expect(resolveDeepLinkTarget("stubwise://tickets/42")).toEqual({ area: "tickets", id: "42" });
    expect(resolveDeepLinkTarget("stubwise://projects/p1")).toEqual({ area: "projects", id: "p1" });
  });

  test("mail: solo la sorgente `email` ha un dettaglio da aprire", () => {
    expect(resolveDeepLinkTarget("stubwise://mail/email/e1")).toEqual({
      area: "mail",
      source: "email",
      id: "e1",
    });
    expect(resolveDeepLinkTarget("stubwise://mail/calendar/e1")).toBeNull();
  });
});

/**
 * La tab del ticket nel link (pagina del ticket a tab, Task 8): nessun
 * mittente la produce oggi, ma un link `?tab=` sospeso al login non deve
 * perderla — né finire dentro l'id.
 */
describe("tickets con la tab", () => {
  test("`?tab=activity`: l'id è pulito e la tab arriva", () => {
    expect(resolveDeepLinkTarget("stubwise://tickets/abc?tab=activity")).toEqual({
      area: "tickets",
      id: "abc",
      tab: "activity",
    });
  });

  test("senza query: nessuna tab (la schermata apre Stato)", () => {
    expect(resolveDeepLinkTarget("stubwise://tickets/abc")).toEqual({ area: "tickets", id: "abc" });
  });

  test("`?tab=foo`: Stato, mai un valore che nessuna tab conosce", () => {
    expect(resolveDeepLinkTarget("stubwise://tickets/abc?tab=foo")).toEqual({ area: "tickets", id: "abc", tab: "status" });
  });

  test("encoding malformato (`?tab=%E0%A4`): non lancia, apre Stato", () => {
    expect(() => resolveDeepLinkTarget("stubwise://tickets/abc?tab=%E0%A4")).not.toThrow();
    expect(resolveDeepLinkTarget("stubwise://tickets/abc?tab=%E0%A4")).toEqual({ area: "tickets", id: "abc", tab: "status" });
  });

  test("altri parametri insieme alla tab, e una query sulle altre aree non entra nell'id", () => {
    expect(resolveDeepLinkTarget("stubwise://tickets/abc?x=1&tab=details")).toEqual({
      area: "tickets",
      id: "abc",
      tab: "details",
    });
    expect(resolveDeepLinkTarget("stubwise://inbox/abc?tab=details")).toEqual({ area: "inbox", id: "abc" });
  });
});

describe("calendario (App M3, Fase D)", () => {
  test("con il solo giorno: porta alla griglia su quel giorno", () => {
    expect(resolveDeepLinkTarget("stubwise://calendar/2026-09-17")).toEqual({
      area: "calendar",
      day: "2026-09-17",
    });
  });

  test("con giorno e id: porta all'appuntamento", () => {
    expect(resolveDeepLinkTarget("stubwise://calendar/2026-09-17/7c9e6679-7425")).toEqual({
      area: "calendar",
      day: "2026-09-17",
      eventId: "7c9e6679-7425",
    });
  });

  test("senza giorno non risolve: aprire su OGGI fingerebbe di aver capito il link", () => {
    expect(resolveDeepLinkTarget("stubwise://calendar")).toBeNull();
    expect(resolveDeepLinkTarget("stubwise://calendar/")).toBeNull();
  });

  test("un giorno che NON esiste è scartato, non normalizzato", () => {
    // `new Date("2026-02-31")` non lancia: scivola al 3 marzo. Un link che
    // porta a un giorno diverso da quello che dice è peggio di un link che
    // non funziona.
    expect(resolveDeepLinkTarget("stubwise://calendar/2026-02-31")).toBeNull();
    expect(resolveDeepLinkTarget("stubwise://calendar/2026-13-01")).toBeNull();
    expect(resolveDeepLinkTarget("stubwise://calendar/17-09-2026")).toBeNull();
    expect(resolveDeepLinkTarget("stubwise://calendar/domani")).toBeNull();
  });

  test("un giorno valido con l'id assente NON diventa `eventId: undefined` esplicito", () => {
    // `exactOptionalPropertyTypes` a parte, è ciò che il chiamante controlla
    // con `!== undefined` per decidere se aprire il foglio.
    const target = resolveDeepLinkTarget("stubwise://calendar/2026-09-17");
    expect(target).not.toBeNull();
    expect("eventId" in target!).toBe(false);
  });
});

/**
 * La tab AGT (sessioni degli agenti, piano C): `stubwise://agents` apre
 * l'elenco, `stubwise://agents/:id` una sessione. Anche un link arrivato
 * PRIMA del login deve sapere dove andare, quindi passa da qui.
 */
describe("agenti (sessioni degli agenti)", () => {
  test("senza id: l'elenco delle sessioni", () => {
    expect(resolveDeepLinkTarget("stubwise://agents")).toEqual({ area: "agents" });
  });

  test("con l'id: quella sessione", () => {
    expect(resolveDeepLinkTarget("stubwise://agents/s1")).toEqual({ area: "agents", id: "s1" });
  });
});

/**
 * Piano C, Task 8 (preflight H2): la push di una domanda dell'agente apre la
 * card con `?session=1`, e la card cerca la sessione. Il parametro arriva
 * anche dopo il login (link in sospeso), non solo dal parser di
 * react-navigation.
 */
describe("inbox con la sessione", () => {
  test("`?session=1`: l'id è pulito e `session` arriva", () => {
    expect(resolveDeepLinkTarget("stubwise://inbox/abc?session=1")).toEqual({ area: "inbox", id: "abc", session: true });
  });

  test("senza query, o con un valore diverso da 1: nessun `session`", () => {
    expect(resolveDeepLinkTarget("stubwise://inbox/abc")).toEqual({ area: "inbox", id: "abc" });
    expect(resolveDeepLinkTarget("stubwise://inbox/abc?session=0")).toEqual({ area: "inbox", id: "abc" });
  });
});

describe("tutto il resto è `null`", () => {
  test("schema diverso, area sconosciuta, stringa vuota", () => {
    expect(resolveDeepLinkTarget("https://stubwise.example/calendar/2026-09-17")).toBeNull();
    expect(resolveDeepLinkTarget("stubwise://qualcosa/1")).toBeNull();
    expect(resolveDeepLinkTarget("")).toBeNull();
  });
});

/**
 * Il tab DOC non c'è più (25 set 2026, «Wisey, anteprima nell'app» §3), ma
 * `stubwise://docs` era un path della config: nessuna notifica lo emette
 * oggi, però un link già in giro non deve cercare una tab che non esiste.
 * Porta alla lista dei progetti, da cui si raggiunge la documentazione.
 */
describe("config dei path", () => {
  function leafOf(path: string): string[] {
    const config = buildLinking(() => true).config!;
    let state = getStateFromPath(path, config as never) as
      | { routes: { name: string; state?: unknown }[] }
      | undefined;
    const names: string[] = [];
    while (state) {
      const route = state.routes[state.routes.length - 1]!;
      names.push(route.name);
      state = route.state as typeof state;
    }
    return names;
  }

  test("docs porta alla lista dei progetti", () => {
    expect(leafOf("docs")).toEqual(["Main", "Projects", "List"]);
  });

  test("projects resta dov'era", () => {
    expect(leafOf("projects")).toEqual(["Main", "Projects", "List"]);
  });

  /**
   * Posta e calendario non sono più una tab (sessioni degli agenti, piano C:
   * AGT prende il posto di MBX): il loro stack sta sulla RADICE, e ci si
   * arriva dal profilo. I link che il server emette nelle push non cambiano,
   * cambia solo dove atterrano.
   */
  test("mail/email/:id porta al dettaglio, nello stack della posta sulla radice", () => {
    expect(leafOf("mail/email/x")).toEqual(["Mail", "MailDetail"]);
  });

  test("calendar/:day porta alla lista della posta (sul calendario), sulla radice", () => {
    expect(leafOf("calendar/2026-10-09")).toEqual(["Mail", "List"]);
  });

  /**
   * ⚠️ Preflight H1: con la posta sulla radice, un link a freddo darebbe lo
   * stato `[Mail]` da solo — niente `Main` sotto, quindi niente «indietro»
   * (Android uscirebbe dall'app) e niente barra. `initialRouteName: "Main"`
   * mette le schede sotto.
   */
  test("un link alla posta mette Main SOTTO, così l'indietro torna alle schede", () => {
    const config = buildLinking(() => true).config!;
    for (const path of ["mail/email/x", "calendar/2026-10-09"]) {
      const state = getStateFromPath(path, config as never) as { routes: { name: string }[] };
      expect(state.routes.map((route) => route.name)).toEqual(["Main", "Mail"]);
    }
  });

  /** Preflight H2: le query arrivano come STRINGHE; il `parse` le fa diventare il booleano dei params. */
  test("inbox/:id?session=1 porta alla card con `session: true`", () => {
    const config = buildLinking(() => true).config!;
    const state = getStateFromPath("inbox/abc?session=1", config as never) as {
      routes: { name: string; state?: { routes: { name: string; state?: { routes: { name: string; params?: unknown }[] } }[] } }[];
    };
    const inbox = state.routes[0]!.state!.routes.find((route) => route.name === "Inbox")!;
    const card = inbox.state!.routes[inbox.state!.routes.length - 1]!;
    expect(card.name).toBe("Card");
    expect(card.params).toEqual({ id: "abc", session: true });
  });

  /**
   * La card aperta da un link sostituisce sé stessa con la sessione: senza la
   * lista SOTTO, l'indietro della sessione non porterebbe da nessuna parte.
   */
  test("inbox/:id mette la lista SOTTO la card, così l'indietro ci torna", () => {
    const config = buildLinking(() => true).config!;
    const state = getStateFromPath("inbox/abc", config as never) as {
      routes: { name: string; state?: { routes: { name: string; state?: { routes: { name: string }[] } }[] } }[];
    };
    const inbox = state.routes[0]!.state!.routes.find((route) => route.name === "Inbox")!;
    expect(inbox.state!.routes.map((route) => route.name)).toEqual(["List", "Card"]);
  });

  test("agents porta all'elenco della tab AGT", () => {
    expect(leafOf("agents")).toEqual(["Main", "Agents", "List"]);
  });

  test("agents/:id porta alla sessione, nella tab AGT", () => {
    expect(leafOf("agents/7c9e6679-7425-40de-944b-e07fc1f90ae7")).toEqual(["Main", "Agents", "AgentSession"]);
  });

  /**
   * Task 6: la sessione ha un «indietro» (`goBack`), che senza l'elenco sotto
   * non porterebbe da nessuna parte. `initialRouteName: "List"` lo mette lì.
   */
  test("agents/:id mette l'elenco SOTTO la sessione, così l'indietro ci torna", () => {
    const config = buildLinking(() => true).config!;
    const state = getStateFromPath("agents/7c9e6679-7425-40de-944b-e07fc1f90ae7", config as never) as {
      routes: { name: string; state?: { routes: { name: string; state?: { routes: { name: string }[] } }[] } }[];
    };
    const agents = state.routes[0]!.state!.routes.find((route) => route.name === "Agents")!;
    expect(agents.state!.routes.map((route) => route.name)).toEqual(["List", "AgentSession"]);
  });
});
