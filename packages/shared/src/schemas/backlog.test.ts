import { describe, expect, it } from "vitest";
import { readerSchema } from "../reader.js";
import { backlogItemDetailSchema, backlogPageSchema, refineSessionViewSchema } from "./backlog.js";

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

describe("sessione di refinement verso un server più vecchio", () => {
  // Dettaglio SENZA `refineSession`, apposta: prova che il default c'è.
  const dettaglioSenzaRefine = {
    id: "7f1c2a1e-0000-4000-8000-000000000002",
    projectId: "7f1c2a1e-0000-4000-8000-000000000003",
    title: "Voce",
    document: "",
    implementationPlan: null,
    originContent: null,
    status: "new",
    effort: null,
    risk: null,
    riskNote: null,
    urgency: null,
    requestCount: 1,
    source: "manual",
    suggested: null,
    similarTo: null,
    createdAt: "2026-10-14T10:00:00.000Z",
    updatedAt: "2026-10-14T10:00:00.000Z",
    tickets: [],
  };

  it("dettaglio della voce senza refineSession (server più vecchio): null", () => {
    const parsed = backlogItemDetailSchema.parse(dettaglioSenzaRefine);
    expect(parsed.refineSession).toBeNull();
  });

  it("refineSession senza closedReason: null", () => {
    expect(
      refineSessionViewSchema.parse({
        agentSessionId: "7f1c2a1e-0000-4000-8000-000000000001",
        status: "active",
        lastActivityAt: "2026-10-14T10:00:00.000Z",
      }).closedReason,
    ).toBeNull();
  });
});
