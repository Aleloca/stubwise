/**
 * Troncatura sicura per il testo che finisce in una push.
 *
 * Sta in un modulo a sé perché la usano in due: il PAYLOAD, che deve stare nei
 * 4096 byte di APNs/FCM, e il CLIENT, che deve limitare il `reason` che il
 * relay gli rimanda indietro (contratto senza tetto, di proposito) prima che il
 * poller lo scriva a DB.
 */

/**
 * Segmentatore per GRAPHEME CLUSTER, istanziato una volta sola: costruirlo non
 * è gratis e qui si tronca per ogni notifica di ogni destinatario.
 *
 * `Intl.Segmenter` è un globale della piattaforma (nessun `node:`), quindi non
 * tocca il confine che tiene questo pacchetto bundlabile dai client.
 */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Taglia `value` in modo che `value.length` non superi `max`, chiudendo con
 * un'ellissi. Restituisce la stringa intatta se ci sta già.
 *
 * ⚠️ TRE unità di misura diverse convivono qui, e ognuna ha il suo motivo:
 *
 *  - il TAGLIO avviene sui GRAPHEME CLUSTER, cioè su ciò che l'utente chiama
 *    "un carattere". Tagliare sui code point produce testo tecnicamente valido
 *    e visibilmente rotto: `👨‍👩‍👧` (padre-ZWJ-madre-ZWJ-figlia) diventa un
 *    padre solo seguito da uno ZWJ penzolante, e `🇮🇹` — due regional
 *    indicator — diventa una «I» dentro un riquadro. Nessun test sui byte lo
 *    prende, perché è UTF-8 validissimo: lo vede solo l'utente sulla lock
 *    screen;
 *  - la MISURA è in unità UTF-16 (`.length`), perché il tetto che deve reggere
 *    è il `.max()` di Zod del contratto, e Zod misura `.length`. Un taglio a
 *    "500 caratteri" su un corpo di emoji produce fino a 1000 unità: nessun
 *    grafema spezzato, e la richiesta comunque fuori contratto;
 *  - il tetto stesso è in CARATTERI e non in byte perché il margine verso i
 *    4096 byte di APNs/FCM è largo (vedi `PUSH_TITLE_MAX_CHARS` in
 *    `@stubwise/shared`).
 *
 * Una unità è riservata all'ellissi (`…` è BMP, quindi `.length === 1`). Un
 * `value` il cui PRIMO grafema non ci sta già diventa la sola ellissi: è il
 * caso degenere di un `max` minuscolo, non un input reale.
 */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  let out = "";
  for (const { segment } of graphemes.segment(value)) {
    if (out.length + segment.length > max - 1) break;
    out += segment;
  }
  return `${out}…`;
}
