/**
 * Tronca entro `max` caratteri, con l'ellissi finale. La PAROLA in coda può
 * restare a metà, ma un CARATTERE no: si accumula per punto di codice, così un
 * testo con un'emoji non viene spezzato a metà della coppia di surrogati (uno
 * `slice` secco lo farebbe). Il tetto resta contato in code unit UTF-16
 * (`length`).
 *
 * Serve a ogni testo destinato a una notifica: il poller del brief tronca il
 * markdown che finisce nel payload, e quel payload è un `jsonb`. Un `slice`
 * secco che spezzi una coppia di surrogati produce un orfano, Postgres lo
 * RIFIUTA (`json_errsave_error`), `publishNotification` lancia e il brief resta
 * `done` senza notifica — nessuno lo legge, e il sintomo non assomiglia alla
 * causa. Chi ha bisogno di tagliare testo destinato a una notifica usa questa,
 * non `slice`. (Stava coi blocchi Slack, tolti col ritiro del web vecchio, R2.)
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let kept = "";
  for (const point of text) {
    // -1: l'ellissi occupa l'ultimo posto.
    if (kept.length + point.length > max - 1) break;
    kept += point;
  }
  return `${kept.trimEnd()}…`;
}
