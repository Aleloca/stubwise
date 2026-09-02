import { describe, expect, it } from "vitest";
import { aiJobStatusSchema, type AiJobStatus } from "./schemas/ai-job.js";
import { WORK_STATES, workStateFor, type WorkState } from "./work-state.js";

/**
 * La mappatura è a 11 stati, non a 9: `skipped` e `pr_closed` hanno un
 * vocabolario proprio (`skipped`, `rejected`) perché comprimerli su `failed`
 * mostrerebbe «Fallito» per una PR che un umano ha chiuso deliberatamente e per
 * un ticket che il triage ha giudicato non fixabile.
 */
const TABLE: Array<[AiJobStatus, WorkState]> = [
  ["queued", "proposed"],
  ["triaging", "planning"],
  ["fixing", "working"],
  ["held", "held"],
  ["awaiting_input", "waiting_answer"],
  ["awaiting_plan_approval", "waiting_approval"],
  ["pr_opened", "pr_ready"],
  ["pr_merged", "done"],
  ["failed", "failed"],
  ["skipped", "skipped"],
  ["pr_closed", "rejected"],
];

describe("workStateFor", () => {
  it.each(TABLE)("mappa %s su %s", (status, expected) => {
    expect(workStateFor(status)).toBe(expected);
  });

  // Le due prove qui sotto sono la difesa contro chi aggiunge un valore a
  // `ai_job_status` senza tradurlo: la prima iterando l'enum (non una lista
  // scritta a mano), la seconda pretendendo che anche la tabella qui sopra sia
  // completa. A monte c'è il `Record<AiJobStatus, WorkState>` di work-state.ts,
  // che su un valore nuovo non compila nemmeno.
  it("produce uno stato valido per OGNI valore dell'enum ai_job_status", () => {
    for (const status of aiJobStatusSchema.options) {
      expect(WORK_STATES).toContain(workStateFor(status));
    }
  });

  it("la tabella di questo test copre tutti i valori dell'enum", () => {
    expect(TABLE.map(([status]) => status).sort()).toEqual([...aiJobStatusSchema.options].sort());
  });
});
