/**
 * ENTRY PER I CLIENT: la parte di `@stubwise/notifications` che non tocca il DB.
 *
 * Il pacchetto contiene due cose diverse. Da un lato la pubblicazione, il
 * routing e il dispatch, che parlano con Postgres (`@stubwise/db`, `drizzle-orm`
 * e, sotto, il driver `postgres`); dall'altro il COME una notifica si legge e
 * COSA si può farci sopra — testo e catalogo delle azioni — che è logica pura.
 * L'entry `.` espone tutto ed è per server e worker; questa espone solo la
 * seconda metà, ed è quella che un client può importare: l'app mobile React
 * Native (Metro non ha modo di bundlare `postgres`, che vuole i socket di Node)
 * e, se un giorno servisse, la SPA.
 *
 * La purezza di questo grafo non è una convenzione ma un INVARIANTE VERIFICATO:
 * `pure.test.ts` ricostruisce con esbuild le dipendenze reali dell'entry — quelle
 * transitive comprese — e fallisce se ne compare una che un client non può
 * bundlare. Chi aggiunge un import a `format.ts` o `actions.ts` lo scopre lì.
 *
 * I TIPI passano in blocco (`export type *`): sono cancellati alla compilazione,
 * quindi non hanno né costo né rischio nel bundle, e riesportarli uno a uno
 * vorrebbe solo dire dimenticarsene uno al prossimo `kind` di notifica. I VALORI
 * invece sono elencati a mano: la superficie pubblica verso i client è una
 * scelta, non ciò che capita di avere esportato.
 */

export type * from "./format.js";
export type * from "./actions.js";

export { formatNotification, formatNotificationText, sampleEvents } from "./format.js";

export {
  actionsFor,
  actorAllows,
  kindOffers,
  stateAllows,
  KINDS_WITH_OPTIONS,
  SNOOZE_OPTIONS,
} from "./actions.js";
