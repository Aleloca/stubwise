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

  // ATTENZIONE a cosa protegge cosa. L'esaustività della mappa la impone il
  // `Record<AiJobStatus, WorkState>` di work-state.ts, cioè il COMPILATORE:
  // vitest non fa typecheck, quindi chi lancia solo `pnpm test` non la vede —
  // la vede `pnpm typecheck`. Qui l'unica difesa a runtime è l'ultimo caso, che
  // pretende che anche la tabella di questo file resti completa; il caso di
  // mezzo è implicato dagli altri due e resta come rete di sicurezza a costo
  // zero se un giorno la tabella smettesse di essere l'oracolo.
  it("produce uno stato valido per OGNI valore dell'enum ai_job_status", () => {
    for (const status of aiJobStatusSchema.options) {
      expect(WORK_STATES).toContain(workStateFor(status));
    }
  });

  it("la tabella di questo test copre tutti i valori dell'enum", () => {
    expect(TABLE.map(([status]) => status).sort()).toEqual([...aiJobStatusSchema.options].sort());
  });
});
