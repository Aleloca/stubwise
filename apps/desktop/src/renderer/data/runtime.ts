// Il tempo e i reset del livello dati che le superfici leggono, per la build
// prototipo: l'orologio unico e `onStoreReset` dello store finto. Nella build
// app `@backend/runtime` è `backend/real/runtime.ts` (integrazione area 2,
// fetta 1): l'orologio vero, nessun reset.
export { now, onStoreReset } from "./store";
/** La risposta che si scrive a pezzi (la simulazione dello streaming, Support). */
export { streamText } from "./stream";
