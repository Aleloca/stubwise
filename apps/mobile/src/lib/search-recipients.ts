/**
 * CHI ALTRO vede un'email, nella riga di ricerca (16 set 2026, design §3.1,
 * regole 1 e 2).
 *
 * Funzione pura e in un file suo, non dentro il componente: è la parte della
 * riga che si può sbagliare in silenzio — un filtro che non filtra si vede
 * solo guardando i dati veri di qualcuno.
 */

/**
 * Gli indirizzi da MOSTRARE, tolto quello della casella che ha ricevuto.
 *
 * ⚠️ **Togliere `accountEmail` è il punto, non un dettaglio estetico** (regola
 * 1): «a: a.locatelli» quando a.locatelli è chi sta cercando non è
 * informazione. La domanda a cui la riga risponde è *chi ALTRO vede questa
 * mail*. Confronto case-insensitive e tollerante agli spazi, come
 * `attendeeResponseOf` per il calendario: gli indirizzi sono già normalizzati
 * in ingestione, ma non fidarsene qui è gratis.
 *
 * Restituisce un array VUOTO quando non resta nessuno — e il chiamante in quel
 * caso **non disegna la riga affatto**: meglio assente che vuota, mai un
 * «a: —».
 */
export function othersThan(addresses: readonly string[], mailboxEmail: string): string[] {
  const mine = mailboxEmail.trim().toLowerCase();
  return addresses.filter((address) => address.trim().toLowerCase() !== mine && address.trim() !== "");
}

/**
 * Quanto ci sta su una riga stretta: la PARTE LOCALE del primo indirizzo, più
 * `+N` per gli altri (regola 2).
 *
 * `m.misseri +2` dice quanto basta per riconoscere di chi si tratta;
 * l'indirizzo intero è nella conversazione aperta, a un tap. Tre indirizzi
 * completi su una riga da telefono si troncherebbero a metà del primo, che è
 * l'unico esito peggiore di non mostrarli.
 *
 * `null` quando non c'è nessuno: è il segnale con cui il chiamante decide di
 * non disegnare la riga.
 */
export function summarizeAddresses(addresses: readonly string[]): string | null {
  const [first, ...rest] = addresses;
  if (first === undefined) return null;
  const at = first.indexOf("@");
  // Un valore senza `@` non è un indirizzo che sappiamo accorciare: si mostra
  // com'è, invece di tagliarlo a caso.
  const local = at > 0 ? first.slice(0, at) : first;
  return rest.length === 0 ? local : `${local} +${rest.length}`;
}
