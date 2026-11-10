import { ApiError } from "@stubwise/api-client";
import type { AgentSessionEvent, ClaudeActionGroupView, ClaudeProposalView, Reader } from "@stubwise/shared";
import i18n from "../../../i18n";
import type { ClassReason, ExecutedFailure } from "../../claude/types";
import type { ConversationEvent, ProposedAction, UndoView } from "../../types";
import { appClient, session } from "./client";
import { taskCodeOf } from "./claudeChat";
import { knownTaskCode } from "./tasks";

// Le proposte e le azioni di Claude nella chat della build app (chat, fetta 3,
// F3.4; design `2026-11-10-integrazione-claude-chat-design.md`, «Proposte e
// azioni»). Claude propone, il SERVER esegue: gli eventi `proposal` e
// `actions_executed` della sessione portano solo gli id, e la scheda e la riga
// del prototipo si DERIVANO dalle viste del server — classe e motivi calcolati
// adesso, stato derivato (scadenza compresa), «Annulla» per chi guarda. Un
// server senza le rotte (404) dà una conversazione senza schede.

type ProposalView = Reader<ClaudeProposalView>;
type GroupView = Reader<ClaudeActionGroupView>;

/** Quanto il renderer sa delle azioni di una conversazione, letto in un colpo. */
export interface ChatActions {
  proposals: ProposalView[];
  groups: GroupView[];
  /** Il codice di ogni task citata negli argomenti (id → «AUD-12»), per i riassunti. */
  codes: Map<string, string>;
}

export const NO_CHAT_ACTIONS: ChatActions = { proposals: [], groups: [], codes: new Map() };

async function orEmpty<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
}

/** Gli id delle task citate dagli argomenti (task, commento, avvio, pianificazione, eliminazione). */
function taskIdsOf(fn: string, args: Record<string, unknown>): string[] {
  const id = typeof args["id"] === "string" ? (args["id"] as string) : null;
  const taskId = typeof args["taskId"] === "string" ? (args["taskId"] as string) : null;
  if (fn === "updateTask" || fn === "planTask" || fn === "deleteTask") return id ? [id] : [];
  if (fn === "addComment" || fn === "deleteComment" || fn === "startRun") return taskId ? [taskId] : [];
  return [];
}

/** Proposte, gruppi e codici delle task citate di una conversazione libera. */
export async function readChatActions(conversationId: string): Promise<ChatActions> {
  const client = appClient().claude.conversations;
  const [proposals, groups] = await Promise.all([
    orEmpty(() => client.proposals(conversationId)),
    orEmpty(() => client.groups(conversationId)),
  ]);
  const codes = new Map<string, string>();
  // Dai gruppi eseguiti, prima: i codici li dice il server, uno per oggetto.
  for (const g of groups) {
    for (const a of g.actions) {
      const ids = taskIdsOf(a.fn, a.args);
      if (ids[0] && a.codes[0]) codes.set(ids[0], a.codes[0]);
    }
  }
  const missing = [
    ...new Set(
      [...proposals.flatMap((p) => p.actions), ...groups.flatMap((g) => g.actions)].flatMap((a) =>
        taskIdsOf(a.fn, a.args),
      ),
    ),
  ].filter((id) => !codes.has(id));
  await Promise.all(
    missing.map(async (id) => {
      const known = knownTaskCode(id) ?? (await taskCodeOf(id).catch(() => null))?.code;
      if (known) codes.set(id, known);
    }),
  );
  return { proposals, groups, codes };
}

// --- i riassunti ----------------------------------------------------------------

/** Il riassunto di un'azione come frase (`summaryText`), dai suoi argomenti: mai scritto dal modello. */
function summaryOf(fn: string, args: Record<string, unknown>, code: string | null): ProposedAction {
  const params: Record<string, string | number> = { code: code ?? "" };
  const text = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  switch (fn) {
    case "createTask":
    case "createRequest":
      params["title"] = text("title");
      break;
    case "updateTask": {
      const patch = (args["patch"] ?? {}) as Record<string, unknown>;
      params["fields"] = Object.keys(patch).join(", ");
      break;
    }
    case "planTask": {
      const plan = (args["plan"] ?? {}) as Record<string, unknown>;
      params["week"] = typeof plan["week"] === "string" ? (plan["week"] as string) : "";
      break;
    }
    case "createMilestone":
    case "saveFilter":
      params["name"] = text("name");
      break;
    case "pageAction":
      params["kind"] = text("kind");
      break;
  }
  const key = `claude.chatActions.summary.${fn}${code === null && params["code"] === "" && needsCode(fn) ? "NoCode" : ""}`;
  // `summary` è la resa al momento, per chi non sa leggere la frase (`spoken` la preferisce).
  return { fn: fn as ProposedAction["fn"], args, summary: i18n.t(key, params), summaryText: { key, params } };
}

const needsCode = (fn: string) =>
  ["updateTask", "planTask", "deleteTask", "addComment", "deleteComment", "startRun"].includes(fn);

// --- le schede e le righe ------------------------------------------------------------

/**
 * La voce di «Who can…?» per un rifiuto `forbidden`, come nel catalogo del
 * prototipo (`whoAction` di `data/claude/catalog.ts`, che qui non si importa:
 * porta con sé lo stato finto). Solo le `fn` del catalogo del server.
 */
const WHO_ACTION: Partial<Record<string, string>> = {
  createTask: "createTasks",
  updateTask: "editTasks",
  planTask: "editTasks",
  addComment: "commentTasks",
  deleteComment: "moderateComments",
  createRequest: "addRequests",
  convertRequest: "editBacklog",
  archiveRequest: "editBacklog",
  reopenRequest: "editBacklog",
  startRun: "startRun",
  createMilestone: "editTasks",
  deleteMilestone: "editTasks",
  deleteTask: "deleteTasks",
};

const reasonsOf = (p: ProposalView): ClassReason[] =>
  p.reasons.flatMap((r): ClassReason[] =>
    r.kind === "notifies"
      ? [{ kind: "notifies", personIds: [...r.personIds], more: r.more }]
      : r.kind === "irreversible"
        ? [{ kind: "irreversible" }]
        : r.kind === "starts_work"
          ? [{ kind: "startsWork" }]
          : [],
  );

/** Il rifiuto del server nella forma del prototipo («Couldn't do it · Who?»). */
function failureOf(p: ProposalView): ExecutedFailure | undefined {
  const f = p.failure;
  if (!f) return undefined;
  const fn = p.actions[f.index]?.fn;
  const code: ExecutedFailure["code"] =
    f.code === "budget_exhausted" ? "other" : (f.code as ExecutedFailure["code"]);
  return {
    code,
    index: f.index,
    whoAction: code === "forbidden" && fn ? (WHO_ACTION[fn] ?? null) : null,
    projectId: f.projectId,
    projectCode: null,
  };
}

const codeOfAction = (a: { fn: string; args: Record<string, unknown> }, codes: Map<string, string>) =>
  codes.get(taskIdsOf(a.fn, a.args)[0] ?? "") ?? null;

function proposalEvent(p: ProposalView, at: string, actions: ChatActions): ConversationEvent {
  const group = p.groupId ? actions.groups.find((g) => g.id === p.groupId) : undefined;
  const failure = failureOf(p);
  return {
    id: `proposal:${p.id}`,
    at,
    type: "proposal",
    proposalId: p.id,
    // Le proposte di una conversazione libera sono di chi l'ha aperta: chi guarda.
    requesterId: session.personId ?? "",
    actions: p.actions.map((a) => summaryOf(a.fn, a.args, codeOfAction(a, actions.codes))),
    status: p.status,
    cls: p.cls,
    reasons: reasonsOf(p),
    ...(p.groupId ? { groupId: p.groupId } : {}),
    ...(group ? { resultCodes: group.actions.flatMap((a) => a.codes), objectCodes: group.actions.map((a) => a.codes[0] ?? null) } : {}),
    ...(failure ? { failure } : {}),
    ...(p.undoOfGroupId ? { undoOf: p.undoOfGroupId } : {}),
  } as ConversationEvent;
}

function executedEvent(g: GroupView, at: string, actions: ChatActions): ConversationEvent {
  return {
    id: `executed:${g.id}`,
    at,
    type: "executed",
    groupId: g.id,
    actions: g.actions.map((a) => summaryOf(a.fn, a.args, a.codes[0] ?? codeOfAction(a, actions.codes))),
    status: "done",
    resultCodes: g.actions.flatMap((a) => a.codes),
    objectCodes: g.actions.map((a) => a.codes[0] ?? null),
  } as ConversationEvent;
}

// --- le azioni della pagina (D3) ------------------------------------------------

type Fake = typeof import("../../api");

/**
 * L'esito delle azioni della pagina, per persona: le esegue il RENDERER (D3,
 * il server le valida e non esegue niente), quindi lo stato — eseguita, non
 * partita, annullata — resta qui, come il loro «Undo» locale. Una
 * conversazione riaperta in un'altra sessione le rilegge in attesa, e il
 * runner le dà non partite se sono vecchie (`isStale`).
 */
const pageStatusByPerson = new Map<string, Map<string, PageEventStatus>>();

type PageEventStatus = Parameters<Fake["settlePageEvent"]>[2];

function pageStatuses(): Map<string, PageEventStatus> {
  const me = session.personId ?? "";
  let map = pageStatusByPerson.get(me);
  if (!map) pageStatusByPerson.set(me, (map = new Map()));
  return map;
}

/** Il runner fissa l'esito di un'azione della pagina (eseguita, non partita, annullata). */
export const settlePageEvent: Fake["settlePageEvent"] = async (_conversationId, eventId, status) => {
  pageStatuses().set(eventId, status);
};

/** Solo nei test: nessun esito ricordato. */
export function forgetPageStatuses(): void {
  pageStatusByPerson.clear();
}

const isPageProposal = (p: ProposalView) => p.actions.length > 0 && p.actions.every((a) => a.fn === "pageAction");

/** Un'azione della pagina per ogni azione della proposta, col suo esito locale. */
function pageEvents(p: ProposalView, at: string): ConversationEvent[] {
  return p.actions.map((a, i) => {
    const id = `page:${p.id}:${i}`;
    const status = pageStatuses().get(id);
    return {
      id,
      at,
      type: "pageAction",
      action: a.args,
      status: status === "done" || status === "undone" || status === "changed_after" || status === "failed" ? status : "pending",
    } as ConversationEvent;
  });
}

/**
 * Le schede (`proposal`) e le righe (`executed`) dagli eventi grezzi, al loro
 * posto nel tempo. Una proposta ha una scheda sola (anche quando la conferma o
 * l'annullamento scrivono un altro evento); una A eseguita subito è una riga;
 * un gruppo eseguito dalla conferma di una scheda NON è una riga in più (la
 * scheda lo dice); un «Annulla» lo dice lo stato del gruppo annullato.
 */
export function chatActionEvents(
  raw: readonly Reader<AgentSessionEvent>[],
  actions: ChatActions,
): ConversationEvent[] {
  const out: ConversationEvent[] = [];
  const carded = new Set(
    raw.filter((e) => e.type === "proposal").map((e) => String((e.data as { proposalId?: unknown }).proposalId)),
  );
  const seen = new Set<string>();
  for (const e of raw) {
    const data = e.data as { proposalId?: unknown; groupId?: unknown; undoOf?: unknown };
    if (e.type === "proposal") {
      const p = actions.proposals.find((x) => x.id === data.proposalId);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      // Le azioni della pagina (D3) non sono una scheda: le esegue il renderer.
      out.push(...(isPageProposal(p) ? pageEvents(p, e.at) : [proposalEvent(p, e.at, actions)]));
    } else if (e.type === "actions_executed") {
      if (typeof data.undoOf === "string") continue;
      if (typeof data.proposalId === "string" && carded.has(data.proposalId)) continue;
      const g = actions.groups.find((x) => x.id === data.groupId);
      if (!g || seen.has(g.id)) continue;
      seen.add(g.id);
      out.push(executedEvent(g, e.at, actions));
    }
  }
  return out;
}

/** Inserisce le schede e le righe fra gli eventi della conversazione, in ordine di tempo. */
export function withChatActionEvents(events: ConversationEvent[], extra: ConversationEvent[]): ConversationEvent[] {
  if (extra.length === 0) return events;
  const out = [...events];
  for (const e of extra) {
    let at = out.length;
    while (at > 0 && out[at - 1]!.at > e.at) at -= 1;
    out.splice(at, 0, e);
  }
  return out;
}

/** Lo stato di «Annulla» di ogni gruppo, per chi guarda (`ConversationDetail.undo`). */
export function undoViewsOf(
  groups: readonly GroupView[],
  nameOf: (personId: string) => string | null,
): Record<string, UndoView> {
  const out: Record<string, UndoView> = {};
  for (const g of groups) {
    switch (g.undo) {
      case "available":
        out[g.id] = { state: "available", needsReauth: false };
        break;
      case "undone":
        out[g.id] = { state: "undone", byName: nameOf(session.personId ?? "") ?? "", at: g.undoneAt ?? g.executedAt };
        break;
      case "changed_after":
        // Chi ha scritto dopo lo nomina solo se chi guarda lo vede (lo dice il server); l'oggetto no.
        out[g.id] = { state: "changed_after", byName: g.changedBy ? nameOf(g.changedBy) : null, code: null };
        break;
      case "not_undoable":
        out[g.id] = { state: "not_undoable" };
        break;
      default:
        out[g.id] = { state: "not_yours" };
    }
  }
  return out;
}

// --- le decisioni della persona ----------------------------------------------------

/**
 * «Confirm» / «Confirm selected» di una scheda: la conferma la fa il SERVER
 * (permessi, classe e scadenza ricontrollati in quel momento). Un rifiuto
 * (409 `expired`, `conflict`, `refused` col motivo) diventa l'esito
 * `failed` del prototipo; la C (riconferma) è la fetta 4.
 */
/**
 * Le viste delle azioni di una conversazione sono VECCHIE: un rifiuto del
 * server (scaduta, rifiutata, in conflitto) non scrive eventi, quindi lo
 * stream non le rileggerebbe da sé. Chi ascolta (lo stream) le rilegge.
 */
const staleListeners = new Set<(conversationId: string) => void>();
export function onChatActionsStale(fn: (conversationId: string) => void): () => void {
  staleListeners.add(fn);
  return () => {
    staleListeners.delete(fn);
  };
}
function markStale(conversationId: string): void {
  for (const fn of [...staleListeners]) fn(conversationId);
}

export const confirmProposal: Fake["confirmProposal"] = async (conversationId, proposalId, options = {}) => {
  const result = await confirmOnServer(proposalId, options);
  if ("status" in result && result.status === "failed") markStale(conversationId);
  return result;
};

async function confirmOnServer(
  proposalId: string,
  options: Parameters<Fake["confirmProposal"]>[2] = {},
): ReturnType<Fake["confirmProposal"]> {
  try {
    const view = await appClient().claude.proposals.confirm(proposalId, {
      ...(options.actionIndexes ? { selected: options.actionIndexes } : {}),
      ...(options.edited ? { edited: options.edited } : {}),
    });
    return view.status === "confirmed"
      ? { status: "confirmed", resultCodes: [], runConversationIds: [] }
      : { status: "failed", error: view.status };
  } catch (error) {
    if (error instanceof ApiError && error.code === "reauth_required") return { ok: false, error: "reauth_required" };
    if (error instanceof ApiError && error.status === 409) return { status: "failed", error: error.code ?? "conflict" };
    throw error;
  }
}

/**
 * «Edit»: gli argomenti dell'azione dalla vista del server, per il dialogo.
 * Salvare il dialogo CONFERMA la proposta con `edited` (la esegue il server,
 * col segno «via Claude»): mai una scrittura a mano.
 */
export const editProposal: Fake["editProposal"] = async (conversationId, proposalId, actionIndex = 0) => {
  const proposals = await appClient().claude.conversations.proposals(conversationId);
  const action = proposals.find((p) => p.id === proposalId)?.actions[actionIndex];
  if (!action) throw Object.assign(new Error("not_found"), { code: "not_found" });
  return { fn: action.fn as Awaited<ReturnType<Fake["editProposal"]>>["fn"], args: action.args };
};

/** «Cancel» della scheda: niente si esegue. */
export const cancelProposal: Fake["cancelProposal"] = async (_conversationId, proposalId) => {
  await appClient().claude.proposals.cancel(proposalId);
};

/**
 * «Undo» di un gruppo: subito, o una scheda da confermare quando gli inversi
 * avviserebbero qualcuno (la scheda arriva come evento della conversazione).
 * I rifiuti nella forma del prototipo.
 */
async function undoClaudeActions(
  _conversationId: string,
  groupId: string,
): ReturnType<Fake["claude"]["undoClaudeActions"]> {
  try {
    const out = await appClient().claude.groups.undo(groupId);
    return out.kind === "needs_confirmation" && out.proposal ? { ok: true, proposalId: out.proposal.id } : { ok: true };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    switch (error.code) {
      case "changed_after":
        return { ok: false, error: "changed_after", byName: null, code: null };
      case "undone":
      case "already_undone":
        return { ok: false, error: "already_undone" };
      case "not_undoable":
        return { ok: false, error: "not_undoable" };
      case "reauth_required":
        return { ok: false, error: "reauth_required" };
      default:
        if (error.status === 404) return { ok: false, error: "not_found" };
        throw error;
    }
  }
}

/** Il namespace `claude` della build app: solo «Undo» (il resto è del prototipo). */
export const claudeChatNamespace = { undoClaudeActions };
