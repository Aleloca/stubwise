// Gli indirizzi puri dell'app, senza nessun import: li usano il prototipo E
// l'adattatore vero. Stanno qui, e non nei moduli di visibilità che li
// usavano, perché quei moduli importano lo stato del prototipo (`store.ts`) e
// con lui ogni seme: l'adattatore che li prendeva da lì portava tutto il seme
// nel bundle dell'app (24 nov 2026; `architecture.test.ts`, «l'adattatore vero
// non tocca il prototipo»).

/** L'indirizzo di una conversazione di Support dal codice del progetto (⌘K). */
export const supportHrefIn = (projectCode: string, code: string): string =>
  `#/p/${projectCode}/support/${code}`;

/** L'indirizzo di un rilascio (notifiche, ⌘K): il suo dettaglio. */
export const releaseHref = (projectCode: string, code: string): string =>
  `#/p/${projectCode}/releases/${code}`;

/** L'indirizzo di una PR aperta (avvisi `pr.*`): la sezione col suo pannello. */
export const prHref = (projectCode: string, prId: string): string =>
  `#/p/${projectCode}/releases?pr=${prId}`;
