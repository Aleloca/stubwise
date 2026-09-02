# shop

Mini negozio online, senza dipendenze. Serve solo da banco di prova.

## Moduli

- `src/cart.js` — `computeSubtotal` e `computeTotal`. Il totale è il valore
  autorevole: finisce **sia** nell'export contabile (colonna `orders.total`)
  **sia**, moltiplicato per 100, nell'importo passato al gateway.
- `src/format.js` — `formatEuro` e `formatOrderTotal`: quello che il cliente
  legge nel riepilogo dell'ordine.
- `src/payment.js` — `chargeAmountInCents`: il gateway accetta solo interi, e
  la parte frazionaria viene tagliata.

## Test

```
npm test
```
