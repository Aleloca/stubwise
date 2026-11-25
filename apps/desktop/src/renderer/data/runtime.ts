// Il tempo e i reset del livello dati che le superfici leggono, per la build
// prototipo: l'orologio unico e `onStoreReset` dello store finto. Nella build
// app `@backend/runtime` è `backend/real/runtime.ts` (integrazione area 2,
// fetta 1): l'orologio vero, nessun reset.
export { now, onStoreReset } from "./store";
/** Le scritture degli accessi del prototipo (un membro entrato, un reparto): l'elenco delle persone si rilegge. */
export { subscribeAccess } from "./access/state";
/** La risposta che si scrive a pezzi (la simulazione dello streaming, Support). */
export { streamText } from "./stream";
