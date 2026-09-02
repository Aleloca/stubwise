/**
 * Carrello: calcolo del totale di un ordine.
 *
 * Un ordine ha la forma:
 *   { items: [{ sku, price, quantity }], shipping: number, discountRate: number }
 * dove `price` e `shipping` sono euro e `discountRate` una frazione (0.1 = 10%).
 */

/** Somma delle righe dell'ordine, spedizione esclusa. */
export function computeSubtotal(order) {
  return order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

/**
 * Totale dell'ordine, spedizione inclusa e sconto applicato.
 *
 * È il valore che finisce sia nell'export contabile (`orders.total`) sia,
 * moltiplicato per 100, nell'importo addebitato dal gateway di pagamento.
 */
export function computeTotal(order) {
  const subtotal = computeSubtotal(order);
  return (subtotal + order.shipping) * (1 - order.discountRate);
}
