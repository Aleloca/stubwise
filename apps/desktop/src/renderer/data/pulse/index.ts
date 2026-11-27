import { convertRequestAs, startRunAs } from "../api-mutations";
import { state, gate, storeGeneration, visibleProjectIds } from "../store";
import type { TaskSize } from "../types";
import { can } from "../viewing";
import { viewerFor } from "../viewer";
import type { PulseProposalDef, PulseProposalView, PulseStartResult } from "./types";

// Le proposte del polso nel prototipo (shape `pulse-proposals.md`). Come sul
// server: le vede chi le riceve e può avviare lavoro nel progetto (PQ-4);
// «Start» crea la task dalla richiesta e fa partire Claude, che passa dal
// piano; «Not now» archivia per chi lo preme soltanto (PQ-2).

export type { PulseOption, PulseProposalView, PulseStartResult, PulseUrgency } from "./types";

const EFFORT: Record<TaskSize, number> = { XS: 1, S: 2, M: 3, L: 4, XL: 5 };

const canStart = (me: string, p: PulseProposalDef) =>
  visibleProjectIds(me).has(p.projectId) && can(viewerFor(me), "runs.start", p.projectId);

const openFor = (me: string, p: PulseProposalDef) =>
  p.startedTaskId === null && p.recipientIds.includes(me) && !p.dismissedBy.includes(me) && canStart(me, p);

function present(p: PulseProposalDef): PulseProposalView {
  const project = state.projects.find((x) => x.id === p.projectId)!;
  return {
    id: p.id,
    projectId: p.projectId,
    projectCode: project.code,
    projectName: project.name,
    idleDays: p.idleDays,
    createdAt: p.createdAt,
    options: p.requestIds.map((id, i) => {
      const r = state.requests.find((x) => x.id === id);
      return {
        title: r?.title ?? "",
        urgency: r?.urgency ?? null,
        effort: r?.size ? EFFORT[r.size] : null,
        suggested: i === p.suggestedIndex,
      };
    }),
  };
}

/** «Da decidere»: le proposte aperte che aspettano chi guarda. */
export async function listPulseProposals(): Promise<PulseProposalView[]> {
  const me = await gate("pulse.listPulseProposals");
  return state.pulseProposals.filter((p) => openFor(me, p)).map(present);
}

/** «Start»: la richiesta dell'opzione diventa una task, e Claude parte dal piano. */
export async function startPulseProposal(id: string, optionIndex: number): Promise<PulseStartResult> {
  const gen = storeGeneration();
  const me = await gate("pulse.startPulseProposal");
  const p = state.pulseProposals.find((x) => x.id === id);
  if (!p || !p.recipientIds.includes(me)) return { ok: false, reason: "stale" };
  if (!canStart(me, p)) return { ok: false, reason: "forbidden" };
  const request = state.requests.find((x) => x.id === p.requestIds[optionIndex]);
  if (p.startedTaskId !== null || !request || (request.status !== "new" && request.status !== "ready"))
    return { ok: false, reason: "stale" };
  const task = convertRequestAs(me, request.id, { title: request.title, description: request.description });
  // Chiusa per tutti i destinatari, come la decisione sul server.
  p.startedTaskId = task.id;
  try {
    await startRunAs(me, task, gen);
  } catch {
    return { ok: false, reason: "run_not_started", taskCode: task.code };
  }
  return { ok: true, taskCode: task.code, awaitingApproval: false };
}

/** «Not now»: archivia per chi guarda; il polso ripropone al giro dopo (PQ-2). */
export async function dismissPulseProposal(id: string): Promise<void> {
  const me = await gate("pulse.dismissPulseProposal");
  const p = state.pulseProposals.find((x) => x.id === id);
  if (p && p.recipientIds.includes(me) && !p.dismissedBy.includes(me)) p.dismissedBy.push(me);
}
