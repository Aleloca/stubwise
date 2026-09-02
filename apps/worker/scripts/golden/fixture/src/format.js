/** Formattazione degli importi mostrati al cliente. */

import { computeTotal } from "./cart.js";

/** Importo in euro come stringa, due decimali. */
export function formatEuro(amount) {
  return `${amount.toFixed(2)} €`;
}

/** Totale dell'ordine come lo vede il cliente nel riepilogo. */
export function formatOrderTotal(order) {
  return formatEuro(computeTotal(order));
}
