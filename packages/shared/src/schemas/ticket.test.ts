import { describe, expect, it } from "vitest";
import { readerSchema } from "../reader.js";
import { ticketDetailSchema, ticketPageSchema } from "./ticket.js";

/**
 * COMPATIBILITÀ VERSO L'APP GIÀ INSTALLATA (fase 7).
 *
 * `planApprovedAt`/`planApprovedBy`/`planApprovalStale` sono nuovi nel
 * dettaglio ticket: un server SENZA la fase 7 (rollback, o un'istanza
 * self-hosted non ancora aggiornata) non li produce affatto. Come
 * `planSummary` prima di loro, nascono `.optional()` (oltre a `.nullable()`
 * per i due che possono essere null) — mai obbligatori — e questo test parsa
 * una risposta che non li porta.
 */

/** Dettaglio ticket come lo emette un server SENZA la fase 7. */
function ticketSenzaFase7(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    number: 42,
    title: "Un ticket",
    body: "Corpo del ticket",
    type: "bug",
    priority: "medium",
    status: "open",
    source: "manual",
    assigneeId: null,
    milestoneId: null,
    effort: null,
    labels: [],
    technicalPayload: null,
    occurrences: 1,
    lastSeenAt: "2026-09-01T10:00:00.000Z",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    implementationPlan: null,
    originContent: null,
    repositories: [],
    ...overrides,
  };
}

describe("ticketDetailSchema: campi della fase 7 verso un server più vecchio", () => {
  it("parsa un dettaglio senza i tre campi della pre-approvazione", () => {
    const parsed = ticketDetailSchema.parse(ticketSenzaFase7());
    expect(parsed.planApprovedAt).toBeUndefined();
    expect(parsed.planApprovedBy).toBeUndefined();
    expect(parsed.planApprovalStale).toBeUndefined();
  });

  it("un server CON la fase 7 continua a essere letto verbatim", () => {
    const parsed = ticketDetailSchema.parse(
      ticketSenzaFase7({
        implementationPlan: "## Piano",
        planApprovedAt: "2026-09-09T10:00:00.000Z",
        planApprovedBy: { id: "33333333-3333-4333-8333-333333333333", email: "maintainer@example.com" },
        planApprovalStale: false,
      }),
    );
    expect(parsed.planApprovedAt).toBe("2026-09-09T10:00:00.000Z");
    expect(parsed.planApprovedBy).toEqual({
      id: "33333333-3333-4333-8333-333333333333",
      email: "maintainer@example.com",
    });
    expect(parsed.planApprovalStale).toBe(false);
  });

  it("planApprovedAt/planApprovedBy possono essere null (mai approvato)", () => {
    const parsed = ticketDetailSchema.parse(
      ticketSenzaFase7({ planApprovedAt: null, planApprovedBy: null, planApprovalStale: false }),
    );
    expect(parsed.planApprovedAt).toBeNull();
    expect(parsed.planApprovedBy).toBeNull();
  });
});

/**
 * IL TOTALE DI UNA PAGINA VERSO UN SERVER PIÙ VECCHIO (22 set 2026, hub di
 * progetto).
 *
 * `total` è `.optional()` per la regola di sempre (CLAUDE.md, «solo cambi
 * additivi»): un'app aggiornata dagli store può parlare con un server che non
 * lo manda — un rollback, o un'istanza self-hosted indietro — e la pagina
 * deve restare leggibile, con la sezione che degrada alle sole righe senza
 * il numero.
 *
 * ⚠️ La fixture è lasciata SENZA `total` apposta: è la prova che la difesa
 * c'è, non una svista da completare (CLAUDE.md, «una fixture incompleta»).
 * Il parse passa da `readerSchema` perché è così che l'app legge davvero —
 * `.default()` e `.optional()` vanno attraversati, non aggirati.
 */
describe("ticketPageSchema: il totale verso un server più vecchio", () => {
  /** Una pagina come la emette un server SENZA il campo `total`. */
  const paginaSenzaTotale = {
    items: [],
    nextCursor: null,
  };

  it("parsa una pagina senza `total`", () => {
    const parsed = readerSchema(ticketPageSchema).parse(paginaSenzaTotale);
    expect(parsed.total).toBeUndefined();
    expect(parsed.items).toEqual([]);
  });

  it("un server che lo manda viene letto verbatim", () => {
    const parsed = readerSchema(ticketPageSchema).parse({ ...paginaSenzaTotale, total: 14 });
    expect(parsed.total).toBe(14);
  });
});
