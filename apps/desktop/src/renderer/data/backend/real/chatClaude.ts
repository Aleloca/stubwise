import { toConversationEvents } from "@stubwise/shared";
import type { AgentSessionEvent, ChatMessageView as ServerMessage, Reader } from "@stubwise/shared";
import i18n from "../../../i18n";
import type { ChatMessage, ConversationEvent, ProposedAction } from "../../types";
import { appClient } from "./client";
import { cachedTaskCode, summaryOf, taskIdsOf } from "./claudeChatActions";

// @Claude nei canali nella build app (integrazione area 4, fetta 3): la vista
// `claude` di una risposta nella forma del prototipo — `claudeRun` (lo stato,
// il motivo, «Try again» già usato) e `claudeEvents` (righe d'azione, schede,
// domanda). Si LEGGE ciò che dice il server:
// - le righe d'azione («cosa ha letto») vengono dalla sessione della chiamata,
//   che il server dà SOLO a chi ha chiamato (`sessionId`, D5): per gli altri
//   non c'è niente da leggere, e niente si chiede;
// - le proposte sono B, decise solo da chi ha chiamato: `canDecide` è il
//   `canConfirm`/`canCancel` del server, mai una deduzione; niente gruppo,
//   quindi niente «Annulla»;
// - gli argomenti delle azioni li ha solo chi ha chiamato: per gli altri il
//   riassunto non nomina ciò che non hanno (nessun titolo, nessun codice).
// Le righe e i codici delle task si leggono a parte (async): `toMessage`
// resta sincrono e usa ciò che è già stato letto; chi legge un thread o lo
// stream aspetta `loadClaudeExtras` e rilegge.

type ServerMsg = Reader<ServerMessage>;
type Block = NonNullable<ServerMsg["claude"]>;
type ServerAction = Block["proposals"][number]["actions"][number];

/** Le righe d'azione di ogni sessione letta (solo quelle di chi guarda: il server non dà le altrui). */
const actionRows = new Map<string, ConversationEvent[]>();
/**
 * L'ultima lettura di ogni sessione: quando e in che stato era la risposta.
 * Mentre Claude scrive lo stream porta un frame circa al secondo, e lo stream
 * della Chat non dice quando arriva un evento di tool: la sessione si rilegge
 * al più ogni `SESSION_REREAD_MS` mentre lavora, SUBITO quando lo stato cambia
 * (il turno finito, la domanda, fermata), mai più a risposta finita.
 */
const sessionReads = new Map<string, { at: number; state: string }>();
export const SESSION_REREAD_MS = 4000;

function sessionDue(id: string, state: string): boolean {
  const last = sessionReads.get(id);
  if (!last || last.state !== state) return true;
  return state === "working" && Date.now() - last.at >= SESSION_REREAD_MS;
}

/** Il codice di ogni task citata negli argomenti di una proposta (id → «AUD-12»). */
const taskCodes = new Map<string, string>();
/** Gli argomenti di ogni proposta letta con gli argomenti (di chi ha chiamato), per «Edit». */
const proposalActions = new Map<string, ServerAction[]>();

export function forgetChatClaudeCaches(): void {
  actionRows.clear();
  sessionReads.clear();
  taskCodes.clear();
  proposalActions.clear();
  loads.clear();
}

/**
 * Le funzioni che senza argomenti direbbero un titolo o un elenco vuoto: chi
 * non ha chiamato legge la frase senza (il server non gli dà gli argomenti).
 */
const HIDDEN_SUMMARY = new Set(["createTask", "createRequest", "createMilestone", "saveFilter", "updateTask"]);

function actionOf(a: ServerAction, redacted: boolean): ProposedAction {
  if (redacted && HIDDEN_SUMMARY.has(a.fn)) {
    const key = `claude.chatActions.summaryHidden.${a.fn}`;
    return { fn: a.fn as ProposedAction["fn"], args: {}, summary: i18n.t(key), summaryText: { key, params: {} } };
  }
  const code = taskIdsOf(a.fn, a.args).map((id) => taskCodes.get(id)).find((c) => c !== undefined) ?? null;
  return summaryOf(a.fn, a.args, code);
}

function proposalEvent(p: Block["proposals"][number], calledById: string, at: string): ConversationEvent {
  // Il server toglie gli argomenti a chi non ha chiamato: una proposta con
  // azioni e argomenti tutti vuoti è letta da un altro.
  const redacted = p.actions.length > 0 && p.actions.every((a) => Object.keys(a.args).length === 0);
  if (!redacted) proposalActions.set(p.id, p.actions);
  return {
    id: `proposal:${p.id}`,
    at,
    type: "proposal",
    proposalId: p.id,
    requesterId: calledById,
    canDecide: p.canConfirm || p.canCancel,
    actions: p.actions.map((a) => actionOf(a, redacted)),
    // Uno stato che questo renderer non conosce: una scheda su cui non si agisce.
    status: p.status === "__unknown__" ? "expired" : p.status,
    cls: "B",
    ...(p.resultCodes.length > 0 ? { resultCodes: [...p.resultCodes] } : {}),
  };
}

function questionEvent(q: NonNullable<Block["question"]>, at: string): ConversationEvent {
  return {
    id: `question:${q.id}`,
    at,
    type: "question",
    questionId: q.id,
    text: q.text,
    options: q.options.map((o) => ({ label: o.label, ...(o.description ? { consequence: o.description } : {}) })),
    answer: q.answer
      ? { optionIndex: q.answer.optionIndex, text: q.answer.text, byId: q.answer.byId ?? "", at: q.answer.at }
      : null,
  };
}

/** I campi del prototipo di una risposta di @Claude; niente su un messaggio senza blocco (o di un server vecchio). */
export function claudeFieldsOf(v: ServerMsg): Pick<ChatMessage, "claudeRun" | "claudeEvents"> {
  const c = v.kind === "claude" ? v.claude : null;
  if (!c) return {};
  const calledById = v.calledById ?? "";
  const events: ConversationEvent[] = [
    ...(c.sessionId ? (actionRows.get(c.sessionId) ?? []) : []),
    ...c.proposals.map((p) => proposalEvent(p, calledById, v.createdAt)),
    ...(c.question ? [questionEvent(c.question, v.createdAt)] : []),
  ];
  return {
    claudeRun: {
      callMessageId: c.callMessageId ?? "",
      // Uno stato che questo renderer non conosce si legge finito (nulla da fermare).
      state: c.state === "__unknown__" ? "done" : c.state,
      ...(c.state === "failed" ? { errorCode: !c.error || c.error === "__unknown__" ? "other" : c.error } : {}),
      retried: c.retried,
      // Chi ferma, rifà e risponde lo dice il server (solo chi ha chiamato, membro, canale aperto).
      canStop: c.canStop,
      canRetry: c.canRetry,
      canAnswer: c.question?.canAnswer ?? false,
    },
    claudeEvents: events,
  };
}

// --- le letture a parte -------------------------------------------------------------

const EVENTS_PAGE = 500;

async function sessionEvents(id: string): Promise<Reader<AgentSessionEvent>[]> {
  const out: Reader<AgentSessionEvent>[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await appClient().agentSessions.events(id, { ...(after ? { after } : {}), limit: EVENTS_PAGE });
    out.push(...page.events);
    if (page.events.length < EVENTS_PAGE) return out;
    after = page.events.at(-1)!.id;
  }
}

/** C'è qualcosa da leggere a parte: la sessione di chi guarda (quando tocca), o codici di task non ancora noti. */
export function needsClaudeLoad(v: ServerMsg): boolean {
  const c = v.kind === "claude" ? v.claude : null;
  if (!c) return false;
  return (c.sessionId !== null && sessionDue(c.sessionId, c.state)) || missingTaskIds(c).length > 0;
}

function missingTaskIds(c: Block): string[] {
  return c.proposals.flatMap((p) => p.actions.flatMap((a) => taskIdsOf(a.fn, a.args))).filter((id) => !taskCodes.has(id));
}

async function load(v: ServerMsg): Promise<boolean> {
  const c = v.claude!;
  let changed = false;
  if (c.sessionId && sessionDue(c.sessionId, c.state)) {
    sessionReads.set(c.sessionId, { at: Date.now(), state: c.state });
    try {
      const rows = toConversationEvents({
        events: await sessionEvents(c.sessionId),
        partials: {},
        inputs: [],
        questions: [],
        live: c.state === "working",
      }).filter((e) => e.type === "action") as ConversationEvent[];
      const before = actionRows.get(c.sessionId);
      if (JSON.stringify(before) !== JSON.stringify(rows)) {
        actionRows.set(c.sessionId, rows);
        changed = true;
      }
    } catch {
      // Fail-open: la risposta si legge senza righe (o con quelle di prima);
      // al prossimo frame si riprova.
      sessionReads.delete(c.sessionId);
    }
  }
  for (const id of missingTaskIds(c)) {
    const code = await cachedTaskCode(id);
    if (code) {
      taskCodes.set(id, code);
      changed = true;
    }
  }
  return changed;
}

/**
 * Una lettura per risposta alla volta; una richiesta che arriva mentre ne
 * gira una la rifà dopo, una volta sola (il testo dal vivo arriva ogni
 * secondo: le righe seguono senza accodare una lettura per frame).
 */
const loads = new Map<string, { running: Promise<boolean>; again: ServerMsg | null }>();

export function loadClaudeExtras(v: ServerMsg): Promise<boolean> {
  if (!needsClaudeLoad(v)) return Promise.resolve(false);
  const current = loads.get(v.id);
  if (current) {
    current.again = v;
    return current.running;
  }
  const entry: { running: Promise<boolean>; again: ServerMsg | null } = { running: Promise.resolve(false), again: null };
  entry.running = (async () => {
    let changed = await load(v);
    while (entry.again) {
      const next = entry.again;
      entry.again = null;
      changed = (await load(next)) || changed;
    }
    loads.delete(v.id);
    return changed;
  })();
  loads.set(v.id, entry);
  return entry.running;
}

/** Gli argomenti di una proposta letta da chi ha chiamato («Edit»); `undefined` se non si sono letti. */
export const proposalActionsOf = (proposalId: string): ServerAction[] | undefined => proposalActions.get(proposalId);
