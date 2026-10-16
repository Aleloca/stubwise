/**
 * «Nessun account disponibile» non è un fallimento: ogni coda rimette
 * l'elemento in attesa e il tick successivo lo riprende (rifà la scelta,
 * nessun run). Quel ciclo a vuoto è accettato, ma NON deve scrivere una riga
 * di log a ogni giro: si logga solo all'INGRESSO nell'attesa.
 *
 * Lo stato è in memoria, per processo (il worker è UN processo, come per il
 * serializer per-progetto): dopo un riavvio la prima attesa si rilogga una
 * volta, ed è giusto così. Una chiave esce dall'insieme quando l'elemento
 * torna a girare davvero (o si chiude): la prossima attesa è una transizione
 * nuova.
 */
export class QuotaWaitLog {
  private readonly waiting = new Set<string>();

  /** True solo la PRIMA volta che `key` entra in attesa: è lì che si logga. */
  enter(key: string): boolean {
    if (this.waiting.has(key)) return false;
    this.waiting.add(key);
    return true;
  }

  /** L'elemento ha lasciato l'attesa (ha girato, o si è chiuso). */
  leave(key: string): void {
    this.waiting.delete(key);
  }
}
