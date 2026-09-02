import assert from "node:assert/strict";
import { test } from "node:test";

import { computeSubtotal, computeTotal } from "../src/cart.js";
import { formatEuro } from "../src/format.js";

const order = (overrides = {}) => ({
  items: [{ sku: "TAZZA", price: 12.5, quantity: 2 }],
  shipping: 0,
  discountRate: 0,
  ...overrides,
});

test("computeSubtotal somma le righe", () => {
  assert.equal(computeSubtotal(order()), 25);
});

test("computeTotal senza spedizione né sconto è il subtotale", () => {
  assert.equal(computeTotal(order()), 25);
});

test("computeTotal applica lo sconto sulle righe", () => {
  assert.equal(computeTotal(order({ discountRate: 0.2 })), 20);
});

test("computeTotal somma la spedizione", () => {
  assert.equal(computeTotal(order({ shipping: 4.9 })), 29.9);
});

test("formatEuro usa due decimali", () => {
  assert.equal(formatEuro(29.9), "29.90 €");
});
