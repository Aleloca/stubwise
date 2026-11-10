import { ApiError } from "@stubwise/api-client";
import type { ClaudeDecisionView, Reader } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { ClaudeDecision, Conversation } from "../../types";
import { ticketOfConversation } from "./claude";
import { appClient } from "./client";

// Le azioni di Claude nella build app (integrazione area 3, fetta 3b «Agire»).
// Ogni azione è una rotta del server, che decide chi può (i due divieti
// dell'operatore, `docs/invariants/agent-sessions.md`): qui nessun permesso si
// deduce, e un rifiuto arriva come `ApiError` col suo `code`, che la UI dice
// con la sua frase. Cosa si può fare DOPO lo rilegge la vista (`/work`, il
// dettaglio della sessione): le scritture invalidano le loro aree.

/**
 * Il lavoro appena chiesto, nella forma che il prototipo restituisce. Il
 * server dà solo il job: la sessione nasce dopo, e le letture la trovano.
 */
function queuedRun(taskId: string, jobId: string): Conversation {
  const now = new Date().toISOString();
  return {
    id: jobId,
    kind: "task_run",
    title: "",
    ownerId: "",
    projectId: null,
    contextProjectId: null,
    taskId,
    requestId: null,
    state: "working",
    outcome: null,
    visibility: "project",
    publishedAt: null,
    publishedById: null,
    touchedProjectIds: [],
    privateFromIndex: null,
    publishedProjectIds: [],
    continuesFromId: null,
    createdAt: now,
    updatedAt: now,
    archived: false,
  };
}

export const startRun: typeof Fake.startRun = async (taskId) =>
  queuedRun(taskId, (await appClient().tickets.runAi(taskId)).jobId);

/**
 * «Rilancia con indicazioni», come il web: le indicazioni diventano un
 * commento del team, e il job riparte sul fix rileggendolo (`withInstructions`).
 */
export const relaunchWithInstructions: typeof Fake.relaunchWithInstructions = async (taskId, instructions) => {
  await appClient().tickets.comment(taskId, instructions);
  return queuedRun(taskId, (await appClient().tickets.runAi(taskId, { withInstructions: true })).jobId);
};

/** Il ticket con le sue PR e il loro ciclo: chi riprendere, dove correggere. */
async function repositoriesOf(taskId: string) {
  return (await appClient().tickets.get(taskId)).repositories;
}

/**
 * «Riprendi la correzione»: QUALE correzione ferma lo dice il ticket
 * (`cycle.heldJobId`), così una vista vecchia non diventa un fix nuovo (409
 * `correction_not_held` se nel frattempo non è più ferma).
 */
export const resumeCorrection: typeof Fake.resumeCorrection = async (taskId) => {
  const held = (await repositoriesOf(taskId)).find((r) => r.cycle?.heldJobId)?.cycle?.heldJobId;
  if (!held) throw Object.assign(new Error("correction_not_held"), { code: "correction_not_held" });
  return queuedRun(taskId, (await appClient().tickets.runAi(taskId, { resumeCorrectionJobId: held })).jobId);
};

/** «Chiedi modifiche»: sulla PR aperta che il server dice correggibile (o la prima aperta). */
export const requestChanges: typeof Fake.requestChanges = async (taskId, text) => {
  const repos = (await repositoriesOf(taskId)).filter((r) => r.prState === "open");
  const repo = repos.find((r) => r.cycle?.canRequestCorrection) ?? repos[0];
  if (!repo) throw Object.assign(new Error("pr_not_open"), { code: "pr_not_open" });
  const note = text.trim();
  const out = await appClient().tickets.requestCorrection(taskId, repo.repositoryId, note ? { note } : {});
  return queuedRun(taskId, out.correctionId ?? taskId);
};

/**
 * «Annulla il lavoro» (decisione del maintainer): chiude il lavoro
 * PARCHEGGIATO; su uno in esecuzione 409 `run_in_progress` (prima «Ferma»),
 * senza lavoro 409 `nothing_to_cancel`.
 */
export const cancelRun: typeof Fake.cancelRun = async (taskId) => {
  await appClient().tasks.cancelRun(taskId);
};

// --- su una sessione --------------------------------------------------------------

/** Il ticket della sessione: dalla lettura che l'ha mostrata, o dal suo dettaglio. */
async function ticketOf(conversationId: string): Promise<string> {
  const known = ticketOfConversation.get(conversationId);
  if (known) return known;
  const ticketId = (await appClient().agentSessions.get(conversationId)).ticketId;
  if (!ticketId) throw Object.assign(new Error("not_found"), { code: "not_found" });
  ticketOfConversation.set(conversationId, ticketId);
  return ticketId;
}

/** Approva o rifiuta il piano in attesa (solo `plans.approve`: lo decide il server). */
export const decidePlan: typeof Fake.decidePlan = async (id, decision, instructions) => {
  const ticketId = await ticketOf(id);
  if (decision === "approve") await appClient().tickets.approvePlan(ticketId);
  else await appClient().tickets.rejectPlan(ticketId, instructions?.trim() ? { instructions: instructions.trim() } : undefined);
};

/** Sul piano salvato (409 `no_plan` senza): il server la tiene sul suo digest. */
export const preApprovePlan: typeof Fake.preApprovePlan = async (id) => {
  await appClient().tickets.preApprovePlan(await ticketOf(id));
};

export const revokePlanApproval: typeof Fake.revokePlanApproval = async (id) => {
  await appClient().tickets.revokePlanApproval(await ticketOf(id));
};

/** La risposta alla domanda APERTA (409 `question_not_pending` se nel frattempo non lo è più). */
export const answerQuestion: typeof Fake.answerQuestion = async (id, questionId, answer) => {
  const body = answer.optionIndex !== null ? { optionIndex: answer.optionIndex } : { text: answer.text ?? "" };
  await appClient().tickets.answerQuestion(await ticketOf(id), questionId, body);
};

/** Un messaggio nella sessione (chi può scrivere lo dice `canWrite`). Gli allegati non ci sono. */
export const sendMessage: typeof Fake.sendMessage = async (id, message) => {
  await appClient().agentSessions.send(id, { text: message.text });
};

/** «Ferma»: l'interruzione senza testo mette l'agente in pausa. */
export const stop: typeof Fake.stop = async (id) => {
  await appClient().agentSessions.send(id, { interrupt: true });
};

/** «Ferma e scrivi». */
export const stopAndSend: typeof Fake.stopAndSend = async (id, text) => {
  await appClient().agentSessions.send(id, { text, interrupt: true });
};

// --- «Da decidere» -----------------------------------------------------------------

function toDecision(d: Reader<ClaudeDecisionView>): ClaudeDecision | null {
  if (d.kind === "__unknown__") return null;
  // Senza sessione la voce si riconosce dal suo id: le azioni vanno comunque al ticket.
  const conversationId = d.conversationId ?? d.id;
  ticketOfConversation.set(conversationId, d.taskId);
  const base = {
    id: d.id,
    conversationId,
    conversationKind: "task_run" as const,
    title: d.title,
    ownerId: d.ownerId ?? "",
    projectId: d.projectId,
    taskId: d.taskId,
    requestId: d.requestId,
    objectCode: d.objectCode,
    at: d.at,
  };
  if (d.kind === "question") {
    if (!d.questionId) return null;
    return {
      ...base,
      kind: "question",
      questionId: d.questionId,
      text: d.text ?? "",
      options: (d.options ?? []).map((o) => ({
        label: o.label,
        ...(o.consequence !== undefined ? { consequence: o.consequence } : {}),
        recommended: o.recommended,
      })),
    };
  }
  if (!d.planId) return null;
  return { ...base, kind: "plan", planId: d.planId, summary: d.summary ?? "", blockedReason: null, serverCode: null };
}

/**
 * Piani (solo a chi ha `plans.approve`) e domande (a chi può rispondere), dal
 * server. Un server senza la rotta (prima della 3b) risponde 404: nessuna
 * voce, e «Da decidere» mostra le altre invece di un errore.
 */
export const listClaudeDecisions: typeof Fake.listClaudeDecisions = async () => {
  try {
    return (await appClient().me.claudeDecisions()).flatMap((d) => toDecision(d) ?? []);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
};
