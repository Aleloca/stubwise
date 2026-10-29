// I limiti dei server (area 8b, scelte del piano): durata e costo massimi
// dell'analisi automatica, righe d'uscita di un comando mostrate di base,
// per quanto un server rientrato resta «rientrato», punti massimi di un
// grafico.

/** L'analisi automatica di un episodio si ferma dopo 20 minuti (`timed_out`). */
export const ANALYSIS_MAX_MINUTES = 20;
/** …o dopo 2 dollari di consumi. */
export const ANALYSIS_MAX_COST_USD = 2;
/** Di un comando si mostrano le ultime 40 righe d'uscita; il resto con «vedi tutto». */
export const COMMAND_OUTPUT_MAX_LINES = 40;
/** Un server rientrato si dice «rientrato» per 24 ore, poi torna «in salute». */
export const RECOVERED_SHOWN_HOURS = 24;
/** Un grafico non disegna più di 300 punti: 7 giorni a 30 s si riducono a media. */
export const METRIC_POINTS_MAX = 300;
