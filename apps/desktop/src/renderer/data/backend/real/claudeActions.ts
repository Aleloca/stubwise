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

/** Il numero di una PR dal suo indirizzo (`…/pull/7`, `…/pull-requests/7`, `…/merge_requests/7`). */
const prNumberOf = (url: string | null) => Number(/\/(?:pull|pull-requests|merge_requests)\/(\d+)/.exec(url ?? "")?.[1] ?? NaN);

/**
 * `owner/repo` dall'indirizzo della PR, come lo calcola il server per
 * `requestChangesPerPr` (`repoOf` in `task-work.ts`): il numero da solo non
 * basta, due repository della stessa task possono avere ciascuno la sua #7
 * (review dell'area 3, punto 12).
 */
const prRepoOf = (url: string | null) => /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\//.exec(url ?? "")?.[1] ?? null;

/** «Chiedi modifiche»: sulla PR aperta che il server dice correggibile (o la prima aperta). */
export const requestChanges: typeof Fake.requestChanges = async (taskId, text) => {
  const [repositories, work] = await Promise.all([repositoriesOf(taskId), appClient().tasks.work(taskId)]);
  const repos = repositories.filter((r) => r.prState === "open");
  // Su quale PR lo dice il server (`requestChangesPerPr`): la prima permessa.
  const allowed = work.requestChangesPerPr.filter((p) => p.availability === "allowed");
  const repo =
    repos.find((r) => allowed.some((p) => p.repo === prRepoOf(r.prUrl) && p.number === prNumberOf(r.prUrl))) ??
    repos.find((r) => r.cycle?.canRequestCorrection) ??
    repos[0];
  if (!repo) throw Object.assign(new Error("pr_not_open"), { code: "pr_not_open" });
  const note = text.trim();
  const out = await appClient().tickets.requestCorrection(taskId, repo.repositoryId, note ? { note } : {});
  return queuedRun(taskId, out.correctionId ?? taskId);
};

/**
 * «Annulla il lavoro» (decisione del maintainer): il lavoro PARCHEGGIATO lo
 * chiude il server subito (200, `cancelled`); su uno IN ESECUZIONE il server
 * registra la richiesta e sveglia il worker, che ferma Claude e chiude a breve
 * (202, `requested`: lo dice `cancelRequested` dell'ultimo run). Senza lavoro
 * 409 `nothing_to_cancel`; un server di prima del 3b.1-bis risponde ancora
 * 409 `run_in_progress` su un lavoro in esecuzione.
 */
export const cancelRun: typeof Fake.cancelRun = async (taskId) => {
  const work = await appClient().tasks.cancelRun(taskId);
  return work.runs?.at(-1)?.cancelRequested === true ? "requested" : "cancelled";
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
export const decidePlan: typeof Fake.decidePlan = async (id, decision, instructions, _planId, planDigest) => {
  const ticketId = await ticketOf(id);
  // Il piano MOSTRATO (review dell'area 3, punto 13): il suo digest lo passa
  // chi decide, dall'evento o dalla voce che ha davanti — mai da una lettura
  // successiva dello stesso lavoro. Col digest il server rifiuta (409
  // `plan_changed`) un piano riscritto nel frattempo.
  const digest = planDigest ? { planDigest } : {};
  if (decision === "approve") {
    await appClient().tickets.approvePlan(ticketId, digest);
  } else {
    const text = instructions?.trim();
    const body = { ...(text ? { instructions: text } : {}), ...digest };
    await appClient().tickets.rejectPlan(ticketId, Object.keys(body).length > 0 ? body : undefined);
  }
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
  return {
    ...base,
    kind: "plan",
    planId: d.planId,
    ...(d.planDigest ? { planDigest: d.planDigest } : {}),
    summary: d.summary ?? "",
    blockedReason: null,
    serverCode: null,
  };
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
