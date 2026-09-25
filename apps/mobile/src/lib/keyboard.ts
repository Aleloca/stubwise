/**
 * Le prop che rendono una PAGINA CHE SCORRE consapevole della tastiera (25 set
 * 2026, segnalato dal maintainer: nel ticket «la tastiera va sopra l'input
 * del commento»).
 *
 * `automaticallyAdjustKeyboardInsets` è la gestione NATIVA di iOS per una
 * `ScrollView`: quando la tastiera sale, la pagina guadagna in fondo lo spazio
 * che la tastiera copre e scorre fino al campo in uso. `keyboardShouldPersist
 * Taps: "handled"`: con la tastiera aperta, il primo tocco su un bottone
 * («invia») fa il suo lavoro invece di chiudere soltanto la tastiera.
 *
 * ⚠️ Per chi sceglie dove metterle, tre casi diversi e tre strumenti diversi:
 *   - pagina che SCORRE con un campo dentro (il ticket, le impostazioni di
 *     progetto) → queste prop;
 *   - schermata col campo FISSO in fondo (le due chat) →
 *     `TabScreenKeyboardAvoider`;
 *   - un PANNELLO (`SheetModal`) → niente: la tastiera la gestisce il foglio,
 *     e aggiungere uno dei due raddoppierebbe lo spostamento.
 */
export const KEYBOARD_AWARE_SCROLL_PROPS = {
  automaticallyAdjustKeyboardInsets: true,
  keyboardShouldPersistTaps: "handled",
} as const;
