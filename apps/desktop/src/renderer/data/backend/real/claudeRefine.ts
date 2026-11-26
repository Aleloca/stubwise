import type * as Fake from "../../api";
import type { Conversation } from "../../types";
import { projectCodes, toRow } from "./claude";
import { appClient } from "./client";

// Il refinement delle richieste nella build app (integrazione area 3, fetta
// 3c): la sessione è quella del server (`backlog_refine`, una per richiesta),
// avviata e chiusa da `/api/backlog/:id/refine-session` (l'id della voce è
// quello della richiesta). Messaggi, «Ferma» e stream sono quelli di ogni
// sessione; chi scrive lo dice il server (`backlog.edit`,
// `docs/invariants/backlog-refine.md`). Il piano scritto qui NON è approvato.

/** La richiesta di ogni sessione di refinement letta: chiudere passa dalla voce. */
const requestOfSession = new Map<string, string>();

/**
 * Il refinement di una richiesta come lo vede chi guarda: quello vivo (al
 * più uno), se no il più recente chiuso; `null` se non ce n'è o non lo vede.
 */
export const getRefineOf: typeof Fake.getRefineOf = async (requestId) => {
  const [list, codes] = await Promise.all([
    appClient().agentSessions.list({ kind: "backlog_refine" }),
    projectCodes(),
  ]);
  const mine = (sessions: typeof list.live) => sessions.filter((s) => s.backlogItemId === requestId);
  const pick =
    mine(list.live)[0] ??
    mine(list.recent).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))[0];
  if (!pick) return null;
  requestOfSession.set(pick.id, requestId);
  return toRow(pick, codes);
};

/** «Refine with Claude»: apre (o ritrova) la sessione della richiesta. */
export const startRefineConversation: typeof Fake.startRefineConversation = async (requestId) => {
  const { agentSessionId } = await appClient().backlogRefine.start(requestId);
  requestOfSession.set(agentSessionId, requestId);
  const row = (await getRefineOf(requestId)) ?? null;
  if (row && row.id === agentSessionId) return row;
  // Appena nata, l'elenco può non averla ancora: la forma minima, le letture la completano.
  const now = new Date().toISOString();
  const born: Conversation = {
    id: agentSessionId,
    kind: "refine",
    title: "",
    ownerId: "",
    projectId: null,
    contextProjectId: null,
    taskId: null,
    requestId,
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
  return born;
};

/** «Close session»: la sessione della richiesta si chiude (la richiesta è pronta). */
export const closeRefine: typeof Fake.closeRefine = async (id) => {
  let requestId = requestOfSession.get(id);
  if (!requestId) {
    const detail = await appClient().agentSessions.get(id);
    requestId = detail.backlogItemId ?? undefined;
  }
  if (!requestId) throw Object.assign(new Error("not_found"), { code: "not_found" });
  await appClient().backlogRefine.close(requestId);
};
