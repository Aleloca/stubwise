// Le proposte del polso (`project.pulse`, shape `pulse-proposals.md`): un
// progetto fermo, e le voci di backlog da cui ripartire. Si decide solo in
// Home, blocco Decide (PQ-1b).

/** Una proposta come la scrive il seme (e lo stato): valori stabili. */
export interface PulseProposalDef {
  id: string;
  projectId: string;
  /** A chi arriva; la vede solo chi, adesso, può avviare lavoro nel progetto. */
  recipientIds: string[];
  /** Le richieste proposte, nell'ordine delle opzioni. */
  requestIds: string[];
  /** L'opzione suggerita. */
  suggestedIndex: number;
  idleDays: number;
  createdAt: string;
  /** Avviata: la task nata (la proposta si chiude per tutti). */
  startedTaskId: string | null;
  /** «Not now»: chi l'ha archiviata (è personale). */
  dismissedBy: string[];
}

export type PulseUrgency = "low" | "medium" | "high" | "urgent";

export interface PulseOption {
  title: string;
  urgency: PulseUrgency | null;
  /** La stima dell'effort, da 1 a 5; `null` se non c'è. */
  effort: number | null;
  suggested: boolean;
}

/** Una proposta come la legge chi guarda. */
export interface PulseProposalView {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  idleDays: number;
  createdAt: string;
  options: PulseOption[];
}

export type PulseStartResult =
  /** `awaitingApproval`: il piano c'è già e aspetta l'approvazione; se no Claude lo sta scrivendo. */
  | { ok: true; taskCode: string; awaitingApproval: boolean }
  | {
      ok: false;
      /**
       * - `stale`: la voce non è più aperta, o la proposta è già stata presa;
       * - `run_not_started`: la task è nata ma Claude no (`taskCode` la dice);
       * - `forbidden`: chi guarda non può avviare lavoro nel progetto;
       * - `budget_exhausted`: il budget AI del mese è finito (niente task).
       */
      reason: "stale" | "run_not_started" | "forbidden" | "budget_exhausted" | "failed";
      taskCode?: string;
    };
