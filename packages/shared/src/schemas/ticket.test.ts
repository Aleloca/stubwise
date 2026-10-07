import { describe, expect, it } from "vitest";
import { readerSchema, UNKNOWN } from "../reader.js";
import { runAiBodySchema, ticketDetailSchema, ticketPageSchema } from "./ticket.js";

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

/**
 * IL CICLO DI CORREZIONE VERSO UN SERVER PIÙ VECCHIO (30 set 2026).
 *
 * `cycle` è nuovo su ogni voce PR del dettaglio: un server senza il ciclo
 * (rollback, istanza self-hosted indietro) non lo manda. Nasce
 * `.nullable().default(null)` e questo test parsa una voce che non lo porta.
 * Il parse passa da `readerSchema` perché è così che l'app legge davvero.
 */
describe("ticketRepositorySchema.cycle verso un server più vecchio", () => {
  const voceSenzaCiclo = {
    repositoryId: "44444444-4444-4444-8444-444444444444",
    repositorySlug: "shop-api",
    branch: "stubwise/ticket-42",
    prUrl: "https://github.com/acme/shop-api/pull/12",
    prState: "open",
  };
  const ciclo = {
    state: "correcting",
    round: 2,
    maxRounds: 3,
    pendingRequest: false,
    lastRequest: null,
    canRequestCorrection: false,
    heldReason: "budget",
    canResume: false,
    heldJobId: "55555555-5555-4555-8555-555555555555",
  };

  it("una voce senza `cycle` si legge con cycle null", () => {
    const parsed = readerSchema(ticketDetailSchema).parse(
      ticketSenzaFase7({ repositories: [voceSenzaCiclo] }),
    );
    expect(parsed.repositories[0]!.cycle).toBeNull();
  });

  it("un ciclo presente si legge verbatim", () => {
    const parsed = readerSchema(ticketDetailSchema).parse(
      ticketSenzaFase7({ repositories: [{ ...voceSenzaCiclo, cycle: ciclo }] }),
    );
    expect(parsed.repositories[0]!.cycle).toEqual(ciclo);
  });

  it("uno stato del ciclo che l'app non conosce non fa saltare il dettaglio", () => {
    const parsed = readerSchema(ticketDetailSchema).parse(
      ticketSenzaFase7({ repositories: [{ ...voceSenzaCiclo, cycle: { ...ciclo, state: "stato_futuro" } }] }),
    );
    expect(parsed.repositories[0]!.cycle?.state).toBe(UNKNOWN);
  });
});

describe("runAiBodySchema (G5)", () => {
  it("tutti i campi opzionali: un client vecchio manda {} o i soli campi di prima", () => {
    expect(runAiBodySchema.parse({})).toEqual({});
    expect(runAiBodySchema.parse({ withInstructions: true, mode: "ai_plan" })).toEqual({
      withInstructions: true,
      mode: "ai_plan",
    });
  });

  it("resumeCorrectionJobId è un uuid", () => {
    const id = "55555555-5555-4555-8555-555555555555";
    expect(runAiBodySchema.parse({ resumeCorrectionJobId: id })).toEqual({ resumeCorrectionJobId: id });
    expect(runAiBodySchema.safeParse({ resumeCorrectionJobId: "non-un-uuid" }).success).toBe(false);
  });
});

describe("ticketDetailSchema: prAdoption (6 ott 2026) verso un server più vecchio", () => {
  it("un dettaglio SENZA il campo si legge null, anche attraverso readerSchema", () => {
    expect(ticketDetailSchema.parse(ticketSenzaFase7()).prAdoption).toBeNull();
    expect(readerSchema(ticketDetailSchema).parse(ticketSenzaFase7()).prAdoption).toBeNull();
  });

  it("un'adozione minima (solo i campi obbligatori) prende i default prudenti", () => {
    const parsed = ticketDetailSchema.parse(
      ticketSenzaFase7({
        type: "review",
        prAdoption: {
          repositoryId: "44444444-4444-4444-8444-444444444444",
          prNumber: 7,
          prUrl: "https://github.com/acme/repo/pull/7",
          state: "available",
        },
      }),
    );
    expect(parsed.prAdoption).toEqual({
      repositoryId: "44444444-4444-4444-8444-444444444444",
      prNumber: 7,
      prUrl: "https://github.com/acme/repo/pull/7",
      branch: null,
      state: "available",
      unavailableReason: null,
      adoptedAt: null,
      adoptedBy: null,
      // Nessuna promessa da un server che non lo dice.
      canManage: false,
    });
  });

  it("uno stato o un motivo sconosciuti arrivano UNKNOWN all'app, senza far saltare il dettaglio", () => {
    const parsed = readerSchema(ticketDetailSchema).parse(
      ticketSenzaFase7({
        prAdoption: {
          repositoryId: "44444444-4444-4444-8444-444444444444",
          prNumber: 7,
          prUrl: "https://github.com/acme/repo/pull/7",
          state: "paused",
          unavailableReason: "archived",
        },
      }),
    );
    expect(parsed.prAdoption?.state).toBe(UNKNOWN);
    expect(parsed.prAdoption?.unavailableReason).toBe(UNKNOWN);
  });
});
