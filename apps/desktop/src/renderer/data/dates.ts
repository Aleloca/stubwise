// L'«oggi» fisso del prototipo per le superfici, che non leggono il seed.
export { TODAY, daysFromToday, isoWeek, subscribeClock, today } from "@backend/clock";

/** L'orologio fisso del prototipo (`now()` del livello dati): «Aggiornato N min fa». */
export { now } from "@backend/runtime";
