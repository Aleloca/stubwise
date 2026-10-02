import assert from "node:assert/strict";
import { test } from "node:test";

import { buildOrder, STANDARD_SHIPPING } from "../src/checkout.js";

const items = (price) => [{ sku: "CESTO", price, quantity: 1 }];

test("buildOrder: spedizione gratuita sopra soglia, senza coupon", () => {
  assert.equal(buildOrder(items(65)).shipping, 0);
});

test("buildOrder: sotto soglia si paga la spedizione", () => {
  assert.equal(buildOrder(items(40)).shipping, STANDARD_SHIPPING);
});

test("buildOrder: con il coupon conta l'importo scontato", () => {
  assert.equal(buildOrder(items(65), 0.15).shipping, STANDARD_SHIPPING);
  assert.equal(buildOrder(items(80), 0.15).shipping, 0);
});

test("buildOrder riporta righe e sconto", () => {
  const order = buildOrder(items(65), 0.15);
  assert.deepEqual(order.items, items(65));
  assert.equal(order.discountRate, 0.15);
});
