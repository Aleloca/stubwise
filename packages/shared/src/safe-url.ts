/**
 * **QUALI SCHEMI DI URL SI POSSONO APRIRE.** Regola di SICUREZZA, e per
 * questo sta in un posto solo (15 set 2026, fix di review).
 *
 * Il motivo per cui questo file esiste invece di tre controlli scritti
 * accanto a chi li usa: due copie di una regola di sicurezza divergono, e
 * **la copia che diverge è quella che lascia passare**. È lo stesso
 * ragionamento di `calendarAttendeeSchema` — una dichiarazione sola, non due
 * identiche per caso — applicato alla cosa che conta di più.
 *
 * ## Sono DUE regole, ed è deliberato
 *
 * Non una sola con un parametro: rispondono a due domande diverse, e
 * confonderle allargherebbe in silenzio quella più stretta.
 *
 *  - {@link isSafeWebUrl} — «posso aprire un link che ho TROVATO dentro un
 *    testo non fidato?». Solo `http`/`https`. Il testo di un'email o la
 *    descrizione di un invito li scrive chi vuole, compreso chi vuole male:
 *    un `tel:` comparso da solo in mezzo a un corpo di messaggio non è
 *    qualcosa che vogliamo rendere toccabile, e uno schema custom di
 *    un'altra app installata ancora meno.
 *  - {@link isSafeJoinUrl} — «posso offrire questo come MODO DI PARTECIPARE
 *    a un appuntamento?». `http`/`https` **più `tel:`**, perché i numeri di
 *    conferenza di Google arrivano esattamente così
 *    (`conferenceData.entryPoints`, `entryPointType: "phone"`), e lì il
 *    `tel:` non è comparso in mezzo a del testo: è un campo strutturato che
 *    dichiara di essere un numero da chiamare.
 *
 * ⚠️ Chi aggiunge uno schema lo aggiunga alla regola GIUSTA. Allargare
 * {@link isSafeWebUrl} «perché tanto lo fa già l'altra» riapre la porta
 * proprio dove il contenuto è meno fidato.
 *
 * In entrambe: **allowlist, mai denylist** — stessa dottrina di
 * `sanitizeEmailHtml` (`@stubwise/google`). Un elenco di schemi vietati è
 * una lista che qualcuno dovrà ricordarsi di aggiornare; un elenco di schemi
 * ammessi non ha bisogno di conoscere il prossimo vettore per fermarlo.
 */

/** Schemi apribili per un link trovato dentro testo non fidato. */
const WEB_SCHEMES = ["http:", "https:"];

/** Schemi apribili per un «modo di partecipare» dichiarato da Google. */
const JOIN_SCHEMES = [...WEB_SCHEMES, "tel:"];

/**
 * Lo schema dell'URL, o `null` se la stringa non è un URL.
 *
 * `new URL` e non una regex sul prefisso: `java\nscript:alert(1)` e
 * ` javascript:alert(1)` (con spazi o caratteri di controllo in mezzo) sono
 * i modi classici di far fallire un confronto testuale mentre il browser
 * normalizza e apre lo stesso. Il parser dell'URL fa quella normalizzazione
 * per noi, ed è la ragione per cui questo controllo non è un
 * `startsWith`.
 */
function schemeOf(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/**
 * Un link TROVATO dentro testo non fidato (il corpo di un'email, la
 * descrizione di un invito) è apribile? Solo `http`/`https` — vedi il
 * docblock del modulo per il perché non include `tel:`.
 */
export function isSafeWebUrl(url: string): boolean {
  const scheme = schemeOf(url);
  return scheme !== null && WEB_SCHEMES.includes(scheme);
}

/**
 * Un «modo di partecipare» a un appuntamento (`hangoutLink`,
 * `conferenceData.entryPoints`) è apribile? `http`/`https` più `tel:` — vedi
 * il docblock del modulo per il perché `tel:` qui sì e in
 * {@link isSafeWebUrl} no.
 */
export function isSafeJoinUrl(url: string): boolean {
  const scheme = schemeOf(url);
  return scheme !== null && JOIN_SCHEMES.includes(scheme);
}
