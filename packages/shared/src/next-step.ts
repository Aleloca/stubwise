import { workStateFor } from "./work-state.js";
import type { AiJobStatus } from "./schemas/ai-job.js";
import type { BacklogItemStatus } from "./schemas/backlog.js";

/**
 * Il PASSO SUCCESSIVO di una voce di lavoro (fase 7, design §4): dove sta nel
 * percorso idea → modifica pronta, e cosa si può fare adesso.
 * **Deterministica per costruzione**: derivata SOLO da voce + ticket + job,
 * MAI da un modello — "una frase sbagliata su cosa fare adesso è peggio di
 * nessuna frase" (design, "Rischi e decisioni prese nel piano"). Chi è
 * tentato di far scrivere questa riga a un agente si fermi e lo scriva a un
 * maintainer prima di procedere.
 *
 * App M1 (11 set 2026): SPOSTATA qui da `apps/web/src/components/
 * work-next-step.tsx` (dove restano SOLO `WorkNextStep`, il componente React,
 * e la sua UI) — `workStateFor` era già il precedente che dimostrava che
 * condividere questa classe di logica fra sito e app funziona. Comportamento
 * IDENTICO, verificato dagli stessi test, spostati anche loro.
 *
 * ⚠️ Non ancora USATA dall'app mobile: renderla disponibile qui è tutto
 * quello che chiede questo task. Cablarla in una schermata è M3 — un
 * refactor e una funzionalità nuova nello stesso commit non si revisionano.
 */
export type NextStepKind =
  | "clarify"
  | "readyToConvert"
  | "convertedNoJob"
  | "preparingPlan"
  | "awaitingApproval"
  | "executing"
  | "prReady"
  | "done"
  | "needsAttention";

/** `WorkState` (job) → passo successivo, quando la voce è già convertita. */
const NEXT_STEP_BY_WORK_STATE: Record<ReturnType<typeof workStateFor>, NextStepKind> = {
  proposed: "preparingPlan",
  planning: "preparingPlan",
  working: "executing",
  held: "needsAttention",
  waiting_answer: "needsAttention",
  waiting_approval: "awaitingApproval",
  pr_ready: "prReady",
  done: "done",
  failed: "needsAttention",
  skipped: "needsAttention",
  rejected: "needsAttention",
};

export interface NextStepInput {
  itemStatus: BacklogItemStatus;
  /** Il ticket "converted_to", se la voce è già stata convertita. */
  ticketId: string | null;
  /**
   * Stato dell'ULTIMO job del ticket collegato: `null` finché non è stato
   * lanciato nessun run (o finché i job non sono ancora arrivati dal server —
   * il chiamante degrada a "nessuna riga" in quella finestra, non a
   * `convertedNoJob`, per non lampeggiare uno stato sbagliato).
   */
  latestJobStatus: AiJobStatus | null;
}

/**
 * Deriva il passo successivo. `null` = nessuna riga da mostrare (voce
 * archiviata, o convertita senza che il link al ticket sia ancora arrivato).
 */
export function deriveNextStep(input: NextStepInput): NextStepKind | null {
  if (input.itemStatus === "archived") return null;
  if (input.itemStatus === "new" || input.itemStatus === "refining") return "clarify";
  if (input.itemStatus === "ready") return "readyToConvert";
  // "converted": il ticket deve esserci (l'ha creato la conversione stessa).
  if (input.ticketId === null) return null;
  if (input.latestJobStatus === null) return "convertedNoJob";
  return NEXT_STEP_BY_WORK_STATE[workStateFor(input.latestJobStatus)];
}
