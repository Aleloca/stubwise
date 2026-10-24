// Le funzioni di `api-mutations` si usano solo dentro le funzioni: l'import
// circolare (api-mutations → chat/events → stream → chat/reads) è innocuo.
import { respond, type T } from "../../domain/claude/intents";
import i18n from "../../i18n";
import {
  checkOpenProposal,
  proposalActionArgs,
  readsAs,
  settleCancelledProposal,
  settleEditedProposal,
  settleProposal,
  type ProposalEvent,
  type ProposalOutcome,
  type ProposalPlace,
} from "../api-mutations";
import { PEOPLE, CLAUDE_ID } from "../seed/people";
import {
  chatNow,
  gate,
  newId,
  onStoreReset,
  state,
  storeGeneration,
  visibleProjectIds,
} from "../store";
import {
  claudeReplyStream,
  interruptScripts,
  patchChatMessage,
  runScript,
  threadStream,
} from "../stream";
import type {
  Channel,
  ChatMessage,
  ChatClaudeFailure,
  ChatMessageView,
  ChatScriptStep,
  CitationRef,
  ConversationEvent,
  EventDraft,
  ProposedAction,
  ScriptStep,
} from "../types";
import { callsClaude } from "./mentions";
import {
  channelById,
  channelData,
  chatProposalExpired,
  liveReplies,
  messageById,
  presentMessage,
  readableMessage,
} from "./reads";
import { canReadChannel, channelPermissions } from "./visibility";

// @Claude nella Chat. Chi scrive «@Claude» in un canale o in un thread fa
// una chiamata NUOVA, sua: Claude legge come lui (le sue letture, i suoi
// permessi, senza altri controlli — ne risponde chi chiama), legge il thread
// (solo quello) come contesto e risponde nel thread con un messaggio
// `claude` marcato «chiamato da» lui. Le modifiche restano proposte, che
// conferma solo chi le ha chieste, con la stessa logica dell'area 3
// (`settleProposal`: tutto o niente) attraverso un adattatore sul messaggio
// (R-G1). La risposta arriva sulla SUA coda (`chat:claude:<risposta>`): le
// risposte delle persone nello stesso thread entrano subito, in ordine.

const forbidden = () => new Error("forbidden");
const notFound = () => new Error("not_found");
const invalid = (what: string) => new Error(`invalid: ${what}`);

const current = (gen: number): boolean => gen === storeGeneration();

/** Le risposte che stanno lavorando (id → il lavoro), per `whenClaudeIdle`. */
const jobs = new Map<string, Promise<void>>();
onStoreReset(() => jobs.clear());

/** Si risolve quando la risposta di @Claude ha finito di arrivare (o si è fermata). */
export function whenClaudeIdle(replyId: string): Promise<void> {
  return jobs.get(replyId) ?? Promise.resolve();
}

/** Il testo della chiamata senza «@Claude»: quello che Claude deve capire. */
export function callText(text: string): string {
  return text
    .replace(/@Claude(?![\p{L}\p{N}_])[,:]?\s*/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const nameOf = (personId: string | null): string =>
  personId === CLAUDE_ID ? "Claude" : (PEOPLE.find((p) => p.id === personId)?.name ?? "");

/**
 * I codici di ciò che un messaggio cita, solo se chi chiama lo vede: il
 * contesto non porta a Claude nulla che chi chiama non potrebbe leggere.
 */
function citedCodes(caller: string, refs: readonly CitationRef[]): string[] {
  const visible = visibleProjectIds(caller);
  return refs.flatMap((ref) => {
    if (ref.kind === "task") {
      const task = state.tasksById.get(ref.id);
      return task && visible.has(task.projectId) ? [task.code] : [];
    }
    if (ref.kind === "request") {
      const request = state.requests.find((r) => r.id === ref.id);
      return request && visible.has(request.projectId) ? [request.code] : [];
    }
    return [];
  });
}

/**
 * Il contesto della chiamata: il thread (radice e risposte) prima del
 * messaggio che chiama, come lo legge chi chiama — niente eliminati, niente
 * del resto del canale.
 */
function threadContext(caller: string, ch: Channel, call: ChatMessage): string[] {
  if (!canReadChannel(caller, ch)) return [];
  const rootId = call.threadOf ?? call.id;
  const root = messageById(rootId);
  if (!root) return [];
  const before = [root, ...liveReplies(channelData(ch), rootId)].filter(
    (m) =>
      m.id !== call.id &&
      m.createdAt <= call.createdAt &&
      m.deletedAt === null &&
      (m.text !== "" || m.citations.length > 0),
  );
  return before.map((m) => {
    const codes = citedCodes(caller, m.citations);
    const line = `${nameOf(m.authorId)}: ${m.text}`;
    return codes.length > 0 ? `${line} (${codes.join(", ")})` : line;
  });
}

/**
 * Dopo un messaggio con «@Claude»: la risposta nasce subito, vuota, nel
 * thread di quel messaggio (anche chiamato da una radice del canale), e poi
 * si riempie da sola. Senza «@Claude» non succede nulla.
 */
export async function callClaudeIfAsked(
  caller: string,
  ch: Channel,
  call: ChatMessage,
  gen: number,
): Promise<ChatMessage | null> {
  if (call.kind !== "person" || !callsClaude(call.text)) return null;
  return startReply(caller, ch, call, gen);
}

async function startReply(
  caller: string,
  ch: Channel,
  call: ChatMessage,
  gen: number,
): Promise<ChatMessage | null> {
  const rootId = call.threadOf ?? call.id;
  const reply: ChatMessage = {
    id: newId(rootId),
    channelId: ch.id,
    threadOf: rootId,
    authorId: CLAUDE_ID,
    kind: "claude",
    calledById: caller,
    text: "",
    attachments: [],
    citations: [],
    reactions: [],
    asksReplyOf: [],
    linkedCodes: [],
    createdAt: chatNow(),
    editedAt: null,
    deletedAt: null,
    deletedById: null,
    claudeEvents: [],
    claudeRun: { callMessageId: call.id, state: "working" },
  };
  await runScript(threadStream(rootId), [{ step: "post", message: reply }], gen);
  if (!current(gen) || !state.chatMessages.includes(reply)) return null;
  const job = work(caller, reply, call, gen).finally(() => {
    if (jobs.get(reply.id) === job) jobs.delete(reply.id);
  });
  jobs.set(reply.id, job);
  return reply;
}

/** La risposta lavora ancora (non fermata, fallita o eliminata). */
const working = (reply: ChatMessage): boolean =>
  reply.deletedAt === null && reply.claudeRun?.state === "working";

/**
 * Il lavoro della risposta: il motore di intenti a nome di chi chiama, con
 * il thread come contesto, poi i passi sulla coda della risposta. Un errore
 * la lascia «fallita» con il motivo; un ripristino dello stato a metà non
 * scrive nulla.
 */
async function work(caller: string, reply: ChatMessage, call: ChatMessage, gen: number) {
  const ch = channelById(reply.channelId);
  const thread = ch ? threadContext(caller, ch, call) : [];
  try {
    await gate("chat.claudeReply");
    if (!current(gen) || !working(reply)) return;
    if (!ch || !canReadChannel(caller, ch)) throw forbidden();
    const steps = await respond(callText(call.text), {
      personId: caller,
      contextProjectId: ch.projectId,
      read: readsAs(caller),
      t: i18n.t.bind(i18n) as T,
      seed: reply.id,
      thread,
      asks: true,
    });
    if (!current(gen) || !working(reply)) return;
    await runScript(claudeReplyStream(reply.id), () => chatSteps(reply, thread.length, steps), gen);
  } catch (error) {
    fail(reply, error, gen);
  }
}

/** Il codice del motivo di un errore: la UI lo dice nella sua lingua (mai il testo grezzo). */
function failureOf(error: unknown): ChatClaudeFailure {
  const message = error instanceof Error ? error.message : "";
  return message === "forbidden" || message === "not_found" ? message : "other";
}

/** La risposta che lavorava resta «fallita» con il motivo (nulla dopo un ripristino o uno stop). */
function fail(reply: ChatMessage, error: unknown, gen: number): void {
  // Anche dopo l'eliminazione del canale: la risposta non c'è più, nulla da dire.
  if (!current(gen) || !working(reply) || !messageById(reply.id)) return;
  patchChatMessage(reply.id, {
    claudeRun: { ...reply.claudeRun!, state: "failed", errorCode: failureOf(error) },
  });
}

/**
 * I passi della risposta nella Chat, dai passi della conversazione: le
 * righe d'azione e le schede in `claudeEvents`, il testo a pezzi in `text`,
 * le citazioni in `citations`; in fondo «finita». Consegna e stato della
 * conversazione non hanno senso qui.
 */
function chatSteps(
  reply: ChatMessage,
  threadLength: number,
  steps: ScriptStep[],
): ChatScriptStep[] {
  const out: ChatScriptStep[] = [];
  // Una ripresa (dopo una risposta alla domanda) continua da ciò che c'è.
  let events: ConversationEvent[] = [...(reply.claudeEvents ?? [])];
  let citations: CitationRef[] = [...reply.citations];
  let said = reply.text !== "";
  const resumed = events.length > 0;
  const at = resumed ? chatNow() : reply.createdAt;
  const event = (draft: EventDraft): ConversationEvent =>
    ({
      ...draft,
      id: `${reply.id}-e${events.length + 1}`,
      at,
    }) as ConversationEvent;
  const push = (e: ConversationEvent) => {
    events = [...events, e];
    out.push({ step: "patch", messageId: reply.id, patch: { claudeEvents: events } });
  };
  const replace = (e: ConversationEvent) => {
    events = events.map((x) => (x.id === e.id ? e : x));
    out.push({ step: "patch", messageId: reply.id, patch: { claudeEvents: events } });
  };
  if (threadLength > 0 && !resumed) {
    push(
      event({
        type: "action",
        tool: "read_thread",
        label: i18n.t("claude.answers.actions.readThread"),
        state: "done",
        result: i18n.t("claude.answers.actions.messages", { count: threadLength }),
      }),
    );
  }
  for (const step of steps) {
    switch (step.step) {
      case "action": {
        // Ripresa: una lettura già fatta prima della domanda non si ripete.
        if (
          resumed &&
          events.some((e) => e.type === "action" && e.tool === step.tool && e.label === step.label)
        ) {
          break;
        }
        const draft: EventDraft = {
          type: "action",
          tool: step.tool,
          label: step.label,
          state: "running",
        };
        if (step.input !== undefined) draft.input = step.input;
        if (step.truncated !== undefined) draft.truncated = step.truncated;
        const running = event(draft);
        push(running);
        const done = { ...running, state: step.outcome ?? "done" } as ConversationEvent;
        if (step.result !== undefined && done.type === "action") done.result = step.result;
        replace(done);
        break;
      }
      case "say":
        out.push({ step: "say", messageId: reply.id, text: said ? `\n\n${step.text}` : step.text });
        said = true;
        break;
      case "event":
        if (step.event.type === "citation") {
          const fresh = step.event.refs.filter(
            (r) => !citations.some((c) => c.kind === r.kind && c.id === r.id),
          );
          citations = [...citations, ...fresh];
          out.push({ step: "patch", messageId: reply.id, patch: { citations } });
        } else push(event(step.event));
        break;
      default:
        break;
    }
  }
  // Una domanda aperta: la risposta aspetta chi l'ha chiamata, non è finita.
  const asking = events.some((e) => e.type === "question" && e.answer === null);
  out.push({
    step: "patch",
    messageId: reply.id,
    patch: { claudeRun: { ...reply.claudeRun!, state: asking ? "waiting" : "done" } },
  });
  return out;
}

// --- la risposta: fermare, rifare, eliminare -------------------------------------

/** Una risposta di @Claude che chi agisce legge, e che ha chiamato lui. */
function ownReply(me: string, id: string): { reply: ChatMessage; ch: Channel } {
  const found = readableMessage(me, id);
  if (!found || found.message.kind !== "claude") throw notFound();
  if (found.message.calledById !== me) throw forbidden();
  return { reply: found.message, ch: found.data.ch };
}

/** Le righe d'azione ancora in corso si chiudono «fermate». */
function stoppedEvents(events: readonly ConversationEvent[]): ConversationEvent[] {
  return events.map((e) =>
    e.type === "action" && e.state === "running"
      ? { ...e, state: "failed" as const, result: "Stopped" }
      : e,
  );
}

/**
 * Ferma la risposta in corso: solo chi l'ha chiamata. Il testo arrivato
 * resta; nulla arriva più. Interrompe la coda della risposta, mai quella
 * del thread.
 */
export async function stopClaudeReply(id: string): Promise<ChatMessageView> {
  const gen = storeGeneration();
  const me = await gate("chat.stopClaudeReply");
  if (!current(gen)) throw new Error("reset");
  const { reply } = ownReply(me, id);
  if (reply.deletedAt !== null) throw invalid("deleted");
  if (!live(reply)) throw invalid("status");
  return presentMessage(me, haltReply(reply, "stopped"));
}

/** La risposta lavora o aspetta la risposta a una domanda: si può ancora fermare. */
export const live = (reply: ChatMessage): boolean =>
  reply.claudeRun?.state === "working" || reply.claudeRun?.state === "waiting";

/**
 * Risponde alla domanda che Claude ha fatto a chi l'ha chiamato (R-G4): solo
 * lui (nessun altro, nemmeno un full admin: è la sua chiamata), una volta —
 * una seconda risposta, anche concorrente, è `already_answered`. La risposta
 * continua la stessa risposta di Claude, con i permessi di chi chiama. Vale
 * dal thread come da «Da decidere»: è la stessa domanda.
 */
export async function answerChatClaudeQuestion(
  messageId: string,
  questionId: string,
  answer: { optionIndex: number | null; text: string | null },
): Promise<void> {
  const gen = storeGeneration();
  const me = await gate("chat.answerClaudeQuestion");
  if (!current(gen)) throw new Error("reset");
  const found = readableMessage(me, messageId);
  if (!found || found.message.kind !== "claude" || found.message.deletedAt !== null) {
    throw notFound();
  }
  const { message: reply, data } = found;
  const question = reply.claudeEvents?.find(
    (e) => e.type === "question" && e.questionId === questionId,
  );
  if (!question || question.type !== "question") throw notFound();
  const key = `question:chat:${reply.id}:${questionId}`;
  if (question.answer !== null || claims.has(key)) {
    throw Object.assign(new Error("already_answered"), {
      byId: question.answer?.byId ?? claims.get(key) ?? null,
    });
  }
  if (reply.calledById !== me) throw forbidden();
  if (reply.claudeRun?.state !== "waiting") throw invalid("status");
  if (data.ch.archived) throw invalid("archived");
  if (!channelPermissions(me, data.ch).isMember) throw forbidden();
  const text = answer.text?.trim() || null;
  const option = answer.optionIndex === null ? undefined : question.options[answer.optionIndex];
  if (answer.optionIndex !== null && !option) throw invalid("option");
  if (!option && !text) throw invalid("answer");
  const call = messageById(reply.claudeRun.callMessageId);
  if (!call) throw notFound();

  claims.set(key, me);
  const events = (reply.claudeEvents ?? []).map((e) =>
    e.id === question.id
      ? ({
          ...e,
          answer: { optionIndex: answer.optionIndex, text, byId: me, at: chatNow() },
        } as ConversationEvent)
      : e,
  );
  patchChatMessage(reply.id, {
    claudeEvents: events,
    claudeRun: { ...reply.claudeRun, state: "working" },
  });
  const label = option?.label ?? text!;
  const job = resume(me, reply, call, label, gen).finally(() => {
    if (jobs.get(reply.id) === job) jobs.delete(reply.id);
  });
  jobs.set(reply.id, job);
}

/** Le risposte già date (chiave → chi), contro due risposte concorrenti. */
const claims = new Map<string, string>();
onStoreReset(() => claims.clear());

/**
 * La ripresa dopo la risposta: la stessa chiamata con la risposta in coda
 * («assign AUD-4» + «Marco Bellini»), senza poter chiedere di nuovo — se
 * ancora non basta, Claude lo dice a parole.
 */
async function resume(
  caller: string,
  reply: ChatMessage,
  call: ChatMessage,
  label: string,
  gen: number,
) {
  const ch = channelById(reply.channelId);
  try {
    await gate("chat.claudeReply");
    if (!current(gen) || !working(reply)) return;
    if (!ch || !canReadChannel(caller, ch)) throw forbidden();
    const steps = await respond(`${callText(call.text)} ${label}`, {
      personId: caller,
      contextProjectId: ch.projectId,
      read: readsAs(caller),
      t: i18n.t.bind(i18n) as T,
      seed: `${reply.id}:answer`,
      thread: threadContext(caller, ch, call),
    });
    if (!current(gen) || !working(reply)) return;
    await runScript(claudeReplyStream(reply.id), () => chatSteps(reply, 0, steps), gen);
  } catch (error) {
    fail(reply, error, gen);
  }
}

/**
 * Taglia la coda di una risposta che lavora e la chiude con `state` (anche
 * quando la si elimina). Restituisce il messaggio aggiornato.
 */
export function haltReply(reply: ChatMessage, outcome: "stopped"): ChatMessage {
  interruptScripts(claudeReplyStream(reply.id));
  return patchChatMessage(reply.id, {
    claudeEvents: stoppedEvents(reply.claudeEvents ?? []),
    claudeRun: { ...reply.claudeRun!, state: outcome },
  });
}

/**
 * «Try again» su una risposta fallita: solo chi l'ha chiamata, una volta.
 * Rifà la stessa chiamata come una risposta nuova in fondo al thread (la
 * fallita resta, senza più «Try again»), con lo stesso contesto: il thread
 * fino alla chiamata. Il messaggio che chiamava deve esserci ancora.
 */
export async function retryClaudeReply(id: string): Promise<ChatMessageView> {
  const gen = storeGeneration();
  const me = await gate("chat.retryClaudeReply");
  if (!current(gen)) throw new Error("reset");
  const { reply, ch } = ownReply(me, id);
  if (reply.deletedAt !== null) throw invalid("deleted");
  const run = reply.claudeRun;
  if (run?.state !== "failed" || run.retried) throw invalid("status");
  const call = messageById(run.callMessageId);
  if (!call || call.deletedAt !== null) throw invalid("deleted");
  const perms = channelPermissions(me, ch);
  if (!perms.isMember) throw forbidden();
  if (ch.archived) throw invalid("archived");
  patchChatMessage(reply.id, { claudeRun: { ...run, retried: true } });
  const fresh = await startReply(me, ch, call, gen);
  if (!fresh) throw new Error("reset");
  return presentMessage(me, fresh);
}

// --- le proposte di una risposta (R-G1) ------------------------------------------

/**
 * L'adattatore della Chat per la logica delle proposte dell'area 3: la
 * proposta sta nelle righe di una risposta di @Claude, la chiave è
 * (canale, messaggio, proposta), la scadenza conta i messaggi del thread.
 * Una risposta eliminata non ha più proposte: la sua è `not_found`.
 */
function chatProposalPlace(me: string, messageId: string, proposalId: string): ProposalPlace {
  const found = readableMessage(me, messageId);
  if (!found) throw notFound();
  const { message: m, data } = found;
  if (m.kind !== "claude" || m.deletedAt !== null) throw notFound();
  // Come rispondere alla domanda o «Try again»: chi è uscito dal canale non decide più.
  if (!channelPermissions(me, data.ch).isMember) throw forbidden();
  const event = m.claudeEvents?.find((e) => e.type === "proposal" && e.proposalId === proposalId);
  const key = `proposal:chat:${data.ch.id}:${m.id}:${proposalId}`;
  const proposal = checkOpenProposal(
    me,
    event?.type === "proposal" ? event : undefined,
    key,
    event ? chatProposalExpired(data, m, event) : false,
  );
  if (data.ch.archived) throw invalid("archived");
  return {
    proposal,
    key,
    patch: (patch, gen) => {
      // Dallo stesso unico punto di emissione della Chat; dopo un ripristino
      // o un'eliminazione della risposta non scrive nulla.
      const live = messageById(m.id);
      if (!current(gen) || !live || live.deletedAt !== null) return Promise.resolve();
      const events = (live.claudeEvents ?? []).map((e) =>
        e.id === proposal.id ? ({ ...e, ...patch } as ConversationEvent) : e,
      );
      patchChatMessage(m.id, { claudeEvents: events });
      return Promise.resolve();
    },
    touched: () => undefined,
  };
}

/**
 * Conferma una proposta di una risposta di @Claude: solo chi l'ha chiesta
 * (chi ha chiamato), con la stessa logica della conversazione — le azioni a
 * suo nome, tutte o nessuna.
 */
export async function confirmChatProposal(
  messageId: string,
  proposalId: string,
  options: { actionIndexes?: number[] } = {},
): Promise<ProposalOutcome> {
  const gen = storeGeneration();
  const me = await gate("chat.confirmProposal");
  if (!current(gen)) throw new Error("reset");
  return settleProposal(me, chatProposalPlace(me, messageId, proposalId), options, gen);
}

/** Annulla una proposta di una risposta di @Claude (solo chi l'ha chiesta). */
export async function cancelChatProposal(messageId: string, proposalId: string): Promise<void> {
  const gen = storeGeneration();
  const me = await gate("chat.cancelProposal");
  if (!current(gen)) throw new Error("reset");
  await settleCancelledProposal(me, chatProposalPlace(me, messageId, proposalId), gen);
}

/** «Edit»: gli argomenti dell'azione, per il dialogo precompilato (solo chi l'ha chiesta). */
export async function editChatProposal(
  messageId: string,
  proposalId: string,
  actionIndex = 0,
): Promise<{ fn: ProposedAction["fn"]; args: Record<string, unknown> }> {
  const me = await gate("chat.editProposal");
  const place = chatProposalPlace(me, messageId, proposalId);
  return proposalActionArgs(place.proposal as ProposalEvent, actionIndex);
}

/** «Modifica» salvata dal dialogo: la proposta si chiude «Done (edited)». */
export async function completeEditedChatProposal(
  messageId: string,
  proposalId: string,
  resultCodes: string[],
): Promise<void> {
  const gen = storeGeneration();
  const me = await gate("chat.completeEditedProposal");
  if (!current(gen)) throw new Error("reset");
  await settleEditedProposal(me, chatProposalPlace(me, messageId, proposalId), resultCodes, gen);
}
