/** Checkout: costruisce l'ordine a partire dal carrello e dal coupon. */
import { computeSubtotal } from "./cart.js";

export const FREE_SHIPPING_THRESHOLD = 60;
export const STANDARD_SHIPPING = 6.9;

/** Spedizione gratuita sopra soglia. */
export function buildOrder(items, discountRate = 0) {
  const discounted = computeSubtotal({ items }) * (1 - discountRate);
  const shipping = discounted >= FREE_SHIPPING_THRESHOLD ? 0 : STANDARD_SHIPPING;
  return { items, shipping, discountRate };
}
