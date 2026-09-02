/** Incasso: conversione del totale nell'importo passato al gateway. */

import { computeTotal } from "./cart.js";

/**
 * Importo da addebitare, in centesimi. Il gateway accetta solo interi, quindi
 * la parte frazionaria viene tagliata.
 */
export function chargeAmountInCents(order) {
  return Math.trunc(computeTotal(order) * 100);
}
