// I limiti dei server (area 8b, scelte del piano): righe d'uscita di un
// comando mostrate di base, per quanto un server rientrato resta
// «rientrato», punti massimi di un grafico. I tetti dell'analisi (minuti,
// costo, letture) non sono più costanti: si scelgono in Amministrazione → AI
// (R0-C, `state.instance.serverAnalysis`, la forma di `@stubwise/shared`).
/** Di un comando si mostrano le ultime 40 righe d'uscita; il resto con «vedi tutto». */
export const COMMAND_OUTPUT_MAX_LINES = 40;
/** Un server rientrato si dice «rientrato» per 24 ore, poi torna «in salute» (la regola di shared). */
export { RECOVERED_SHOWN_HOURS } from "@stubwise/shared";
/** Un grafico non disegna più di 300 punti: 7 giorni a 30 s si riducono a media. */
export const METRIC_POINTS_MAX = 300;
