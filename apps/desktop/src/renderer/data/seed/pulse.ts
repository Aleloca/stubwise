import type { PulseProposalDef } from "../pulse/types";
import { CLOCK_START } from "./dates";

// Il polso (27 nov 2026, shape `pulse-proposals.md`): TRM è fermo da 9 giorni
// (nessuna task, nessun lavoro), e propone le sue due richieste aperte a chi
// può avviare lavoro nel progetto (Laura e Marco; Sara è membro senza
// `runs.start` e non la riceve). È l'unico posto dove il prototipo la pubblica.
export const PULSE_PROPOSALS: PulseProposalDef[] = [
  {
    id: "pulse-trm-1",
    projectId: "prj-trm",
    recipientIds: ["p-laura", "p-marco"],
    requestIds: ["req-trm-1", "req-trm-2"],
    suggestedIndex: 0,
    idleDays: 9,
    createdAt: new Date(Date.parse(CLOCK_START) - 3 * 3_600_000).toISOString().replace(".000Z", "Z"),
    startedTaskId: null,
    dismissedBy: [],
  },
];
