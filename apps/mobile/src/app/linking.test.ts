import { resolveDeepLinkTarget } from "./linking";

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

describe("tutto il resto è `null`", () => {
  test("schema diverso, area sconosciuta, stringa vuota", () => {
    expect(resolveDeepLinkTarget("https://stubwise.example/calendar/2026-09-17")).toBeNull();
    expect(resolveDeepLinkTarget("stubwise://qualcosa/1")).toBeNull();
    expect(resolveDeepLinkTarget("")).toBeNull();
  });
});
