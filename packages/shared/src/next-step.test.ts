import { describe, expect, it } from "vitest";
import { deriveNextStep, type NextStepKind } from "./next-step.js";
import type { AiJobStatus } from "./schemas/ai-job.js";

/**
 * `deriveNextStep` è PURA e deterministica (design fase 7 §4): questi test la
 * coprono esaustivamente. App M1 (11 set 2026): SPOSTATI da
 * `apps/web/src/components/work-next-step.test.tsx` insieme alla funzione —
 * comportamento identico, stessi casi.
 */
describe("deriveNextStep", () => {
  it("voce archiviata: nessuna riga (null)", () => {
    expect(deriveNextStep({ itemStatus: "archived", ticketId: null, latestJobStatus: null })).toBeNull();
  });

  it.each(["new", "refining"] as const)("voce '%s': clarify", (itemStatus) => {
    expect(deriveNextStep({ itemStatus, ticketId: null, latestJobStatus: null })).toBe("clarify");
  });

  it("voce 'ready': readyToConvert", () => {
    expect(deriveNextStep({ itemStatus: "ready", ticketId: null, latestJobStatus: null })).toBe(
      "readyToConvert",
    );
  });

  it("convertita ma il link al ticket non è ancora arrivato: null (non convertedNoJob)", () => {
    expect(
      deriveNextStep({ itemStatus: "converted", ticketId: null, latestJobStatus: null }),
    ).toBeNull();
  });

  it("convertita, ticket collegato, nessun job ancora: convertedNoJob", () => {
    expect(
      deriveNextStep({ itemStatus: "converted", ticketId: "t1", latestJobStatus: null }),
    ).toBe("convertedNoJob");
  });

  const CASES: Array<[AiJobStatus, NextStepKind]> = [
    ["queued", "preparingPlan"],
    ["triaging", "preparingPlan"],
    ["fixing", "executing"],
    ["held", "needsAttention"],
    ["awaiting_input", "needsAttention"],
    ["awaiting_plan_approval", "awaitingApproval"],
    ["pr_opened", "prReady"],
    ["pr_merged", "done"],
    ["failed", "needsAttention"],
    ["skipped", "needsAttention"],
    ["pr_closed", "needsAttention"],
  ];
  it.each(CASES)("job '%s' → %s", (status, expected) => {
    expect(deriveNextStep({ itemStatus: "converted", ticketId: "t1", latestJobStatus: status })).toBe(
      expected,
    );
  });
});
