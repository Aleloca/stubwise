import { describe, expect, it } from "vitest";
import { readerSchema } from "../reader.js";
import { backlogPageSchema } from "./backlog.js";

/**
 * IL TOTALE DI UNA PAGINA VERSO UN SERVER PIÙ VECCHIO (22 set 2026, hub di
 * progetto). Gemello esatto del test su `ticketPageSchema` in
 * `ticket.test.ts`, e per le stesse ragioni: `total` è `.optional()` perché
 * l'app si aggiorna dagli store e può trovarsi davanti un server che non lo
 * manda — la pagina deve restare leggibile, senza il numero.
 *
 * ⚠️ La fixture è lasciata SENZA `total` apposta: è la prova che la difesa
 * c'è, non una svista da completare (CLAUDE.md, «una fixture incompleta»).
 */
describe("backlogPageSchema: il totale verso un server più vecchio", () => {
  /** Una pagina come la emette un server SENZA il campo `total`. */
  const paginaSenzaTotale = {
    items: [],
    nextCursor: null,
  };

  it("parsa una pagina senza `total`", () => {
    const parsed = readerSchema(backlogPageSchema).parse(paginaSenzaTotale);
    expect(parsed.total).toBeUndefined();
    expect(parsed.items).toEqual([]);
  });

  it("un server che lo manda viene letto verbatim", () => {
    const parsed = readerSchema(backlogPageSchema).parse({ ...paginaSenzaTotale, total: 6 });
    expect(parsed.total).toBe(6);
  });
});
