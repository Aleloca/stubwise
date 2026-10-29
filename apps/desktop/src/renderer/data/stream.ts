// La Chat: `publishChatEvent` usa `runScript` di qui, ma solo dentro le
// funzioni, quindi l'import circolare è innocuo (come `api-mutations` ↔ `api`).
import { publishChatEvent } from "./chat/events";
import { channelById, messageById, presentMessage } from "./chat/reads";
import { canReadChannel, membersOf } from "./chat/visibility";
import { SCRIPTS } from "./seed/conversations";
import { getSessionPersonId } from "./session";
import {
  canSeeConversation,
  now,
  onStoreReset,
  presentEvent,
  PROPOSAL_EXPIRY,
  isMessage,
  messagesAfter,
  readableLength,
  state,
  storeGeneration,
  streamDelay,
  syncTaskClaude,
} from "./store";
import type {
  Channel,
  ChatMessage,
  ChatMessageView,
  ChatScriptStep,
  Conversation,
  ConversationEvent,
  EventDraft,
  RefinePatch,
  ScriptStep,
  Utterance,
} from "./types";

export type { ScriptStep } from "./types";
export { reconnectDelay } from "./store";

// Lo stream finto delle conversazioni con Claude, come il relay del server:
// chi si iscrive riceve prima il flusso già salvato, poi quello che accade.
// Ogni evento nuovo o cambiato passa da `runScript` — anche quelli che il
// Task 4 aggiunge — che scrive nel flusso dello store e avvisa gli iscritti.
// «Adesso» è l'orologio fisso del prototipo (`now()`), mai quello vero.

export type StreamMode = "append" | "update";
export type StreamConnection = "live" | "reconnecting" | "closed";

export interface SubscribeOptions {
  /**
   * Riprende dopo una disconnessione: l'ultimo evento ricevuto. Gli eventi
   * fino a lui arrivano come `update` (il loro stato di adesso, che completa
   * un messaggio interrotto a metà), i successivi come `append`.
   */
  afterEventId?: string;
  /** La connessione cade (`reconnecting`) o la chiude il «server» (`closed`). */
  onConnection?: (connection: Exclude<StreamConnection, "live">) => void;
  /**
   * Solo ascolto: legge il flusso dal vivo senza far partire ciò che la
   * sessione del seed fa da qui in avanti. Lo usa chi riassume una sessione
   * (la sezione «Claude» della task); lo script parte quando qualcuno apre
   * la conversazione o con un'azione.
   */
  passive?: boolean;
}

interface Subscriber {
  conversationId: string;
  /** La persona che si è iscritta: lo stream è suo e di nessun altro. */
  personId: string;
  onEvent: (e: ConversationEvent, mode: StreamMode) => void;
  onConnection?: SubscribeOptions["onConnection"];
}

const subscribers = new Set<Subscriber>();
/** La coda degli script di ogni conversazione: uno alla volta, in ordine. */
const queues = new Map<string, Promise<void>>();
/** Le sessioni del seed il cui script è già partito. */
const started = new Set<string>();
/** Per conversazione: cambia a ogni «Ferma», e gli script già accodati smettono. */
const cuts = new Map<string, number>();
/** Chi vuole sapere che una conversazione è cambiata (stato, flusso, dati). */
const changeListeners = new Set<(conversationId: string) => void>();

// Gli script partiti prima di un `resetApi` smettono di scrivere: ognuno
// fissa la generazione dello stato (`storeGeneration`) quando parte.
onStoreReset(() => {
  subscribers.clear();
  chatSubscribers.clear();
  queues.clear();
  started.clear();
  cuts.clear();
});

/**
 * Avvisa che una conversazione è cambiata: il suo stato, un evento cambiato
 * (risposta, decisione, stato di una proposta) o i suoi dati (titolo,
 * visibilità…). Non a ogni evento nuovo né a ogni pezzo di testo: quelli li
 * porta lo stream, e rileggere a ogni passo affamerebbe le letture. Porta
 * solo l'id — chi ascolta rilegge con le letture, che filtrano per persona.
 * Restituisce la disiscrizione.
 */
export function onConversationChange(fn: (conversationId: string) => void): () => void {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
}

export function notifyConversationChange(conversationId: string): void {
  for (const fn of [...changeListeners]) fn(conversationId);
}

/**
 * Interrompe gli script in corso o in coda della conversazione («Ferma»):
 * smettono al passo successivo; quelli accodati DOPO partono normalmente.
 * Un messaggio di chi scrive ancora «in attesa» non lo consegnerà più
 * nessuno: con `reason` resta nel flusso «non consegnato», con il motivo e
 * «Resend» — mai perso.
 */
export function interruptScripts(conversationId: string, reason?: string): void {
  cuts.set(conversationId, (cuts.get(conversationId) ?? 0) + 1);
  // Lo script del seed non ancora partito non deve partire dopo il «Ferma».
  started.add(conversationId);
  if (reason === undefined) return;
  for (const e of state.conversationEvents.get(conversationId) ?? []) {
    if (e.type === "user" && e.delivery === "pending") {
      e.delivery = "undelivered";
      e.undeliveredReason = reason;
      update(conversationId, e);
    }
  }
}

/**
 * Il messaggio di chi scrive in una sessione di lavoro entra SUBITO nel
 * flusso, «in attesa», anche mentre Claude sta lavorando: non aspetta in coda
 * dietro allo script in corso (spec §1, il messaggio è assorbito nel turno).
 * Passa dallo stesso `append`, quindi dallo stesso unico punto di emissione;
 * lo consegna il passo `deliver` accodato dopo, e se la coda viene interrotta
 * prima resta «non consegnato» (`interruptScripts`). `at`: la generazione
 * dello stato all'inizio della scrittura — dopo un ripristino non scrive.
 */
export function appendUserMessage(
  conversationId: string,
  draft: Extract<EventDraft, { type: "user" }>,
  at = storeGeneration(),
): ConversationEvent {
  if (at !== storeGeneration()) throw new Error("reset");
  if (!findConversation(conversationId)) throw new Error("not_found");
  return append(conversationId, draft);
}

const findConversation = (id: string): Conversation | undefined =>
  state.conversations.find((c) => c.id === id);

/**
 * Si iscrive al flusso di una conversazione, a nome della persona della
 * sessione. Una conversazione che non vede risponde come una che non esiste
 * (`Error("not_found")`). Restituisce la disiscrizione.
 */
export function subscribe(
  conversationId: string,
  onEvent: (e: ConversationEvent, mode: StreamMode) => void,
  options: SubscribeOptions = {},
): () => void {
  const personId = getSessionPersonId();
  const conversation = findConversation(conversationId);
  if (!conversation || !canSeeConversation(personId, conversation)) {
    throw new Error("not_found");
  }
  const log = state.conversationEvents.get(conversationId) ?? [];
  const resumeAt =
    options.afterEventId === undefined ? -1 : log.findIndex((e) => e.id === options.afterEventId);
  // Il seguito privato di una pubblica non arriva a chi non è l'autore (R-E6).
  const readable = readableLength(personId, conversation);
  log.forEach((_, i) => {
    if (i < readable) onEvent(presentEvent(log, i), i <= resumeAt ? "update" : "append");
  });

  const subscriber: Subscriber = { conversationId, personId, onEvent };
  if (options.onConnection) subscriber.onConnection = options.onConnection;
  subscribers.add(subscriber);

  const script = SCRIPTS[conversationId];
  if (script && !options.passive && !started.has(conversationId)) {
    started.add(conversationId);
    void runScript(conversationId, script);
  }
  return () => {
    subscribers.delete(subscriber);
  };
}

/**
 * Fa cadere la connessione di chi guarda una conversazione (per i test e per
 * provarla a mano): gli iscritti ricevono `reconnecting` e devono iscriversi
 * di nuovo con `afterEventId`. Lo script intanto va avanti.
 */
export function simulateDisconnect(conversationId: string): void {
  for (const subscriber of [...subscribers]) {
    if (subscriber.conversationId !== conversationId) continue;
    subscribers.delete(subscriber);
    subscriber.onConnection?.("reconnecting");
  }
}

/**
 * Unisce un evento dello stream all'elenco di chi guarda: un id già presente
 * si sostituisce (aggiornamento o ripresa), uno nuovo va in fondo. Mai doppi.
 */
export function mergeStreamEvent(
  events: ConversationEvent[],
  event: ConversationEvent,
): ConversationEvent[] {
  const index = events.findIndex((e) => e.id === event.id);
  if (index === -1) return [...events, event];
  const next = events.slice();
  next[index] = event;
  return next;
}

/**
 * Esegue i passi di Claude in una conversazione, in coda a quelli già
 * avviati: l'unico punto da cui un evento entra nel flusso o cambia. `at`:
 * la generazione dello stato in cui la scrittura è partita (di default
 * adesso); se nel frattempo lo stato è stato ripristinato, non fa nulla.
 */
export function runScript(
  streamId: ChatStreamId,
  steps: ChatScriptStep[] | (() => ChatScriptStep[]),
  at?: number,
): Promise<void>;
export function runScript(
  conversationId: string,
  steps: ScriptStep[] | (() => ScriptStep[]),
  at?: number,
): Promise<void>;
export function runScript(
  conversationId: string,
  steps: ScriptStep[] | ChatScriptStep[] | (() => ScriptStep[] | ChatScriptStep[]),
  at = storeGeneration(),
): Promise<void> {
  if (at !== storeGeneration()) return Promise.resolve();
  // Un flusso della Chat (`chat:<canale>`, `chat:thread:<radice>`) usa la
  // stessa coda, gli stessi «Ferma» e la stessa generazione dello stato.
  const chat = isChatStream(conversationId);
  const exists = chat ? channelOfStream(conversationId) : findConversation(conversationId);
  if (!exists) return Promise.reject(new Error("not_found"));
  const cut = cuts.get(conversationId) ?? 0;
  const alive = () => at === storeGeneration() && (cuts.get(conversationId) ?? 0) === cut;
  const previous = queues.get(conversationId) ?? Promise.resolve();
  // Passi dati come funzione: si costruiscono quando arriva il loro turno,
  // dopo quelli accodati prima (es. la risposta del refine parte dal design
  // che il turno precedente ha già scritto).
  const next = previous
    .catch(() => undefined)
    .then(() => {
      if (!alive()) return undefined;
      const built = typeof steps === "function" ? steps() : steps;
      return chat
        ? playChat(built as ChatScriptStep[], alive)
        : play(conversationId, built as ScriptStep[], alive);
    });
  queues.set(conversationId, next);
  return next;
}

/** Si risolve quando gli script accodati della conversazione sono finiti. */
export function whenIdle(conversationId: string): Promise<void> {
  return (queues.get(conversationId) ?? Promise.resolve()).catch(() => undefined);
}

// --- esecuzione -------------------------------------------------------------

/** L'attesa fra due pezzi; con latenza 0 basta un microtask. */
function pause(): Promise<void> {
  const ms = streamDelay();
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function play(conversationId: string, steps: ScriptStep[], alive: () => boolean) {
  for (const step of steps) {
    await pause();
    if (!alive()) return;
    switch (step.step) {
      case "say":
        await say(conversationId, step.text, alive);
        break;
      case "action": {
        const draft: EventDraft = {
          type: "action",
          tool: step.tool,
          label: step.label,
          state: "running",
        };
        if (step.labelText) draft.labelText = step.labelText;
        if (step.input !== undefined) draft.input = step.input;
        if (step.truncated !== undefined) draft.truncated = step.truncated;
        if (step.access !== undefined) draft.access = step.access;
        const event = append(conversationId, draft);
        await pause();
        if (!alive()) return;
        finishAction(event, step.outcome, step.result, step.resultText);
        update(conversationId, event);
        break;
      }
      case "finish_action": {
        const log = state.conversationEvents.get(conversationId) ?? [];
        const running = [...log]
          .reverse()
          .find((e) => e.type === "action" && e.state === "running");
        if (running) {
          finishAction(running, step.outcome, step.result);
          update(conversationId, running);
        }
        break;
      }
      case "deliver":
        for (const e of state.conversationEvents.get(conversationId) ?? []) {
          if (e.type === "user" && e.delivery === "pending") {
            e.delivery = "delivered";
            update(conversationId, e);
          }
        }
        break;
      case "event":
        // Prima la richiesta, poi la riga: chi riceve la riga la trova già scritta.
        if (step.event.type === "work_result" && step.event.requestPatch) {
          applyRefinePatch(conversationId, step.event.requestPatch);
        }
        append(conversationId, step.event);
        // La PR aperta da una sessione di lavoro arriva anche nei canali del
        // progetto che pubblicano «PR opened».
        if (step.event.type === "work_result" && step.event.kind === "pr_opened") {
          const c = findConversation(conversationId);
          if (c?.kind === "task_run" && c.projectId !== null && c.taskId !== null) {
            void publishChatEvent(
              c.projectId,
              "pr_opened",
              { kind: "task", id: c.taskId },
              step.event.text,
            );
          }
        }
        break;
      case "patch": {
        const event = state.conversationEvents
          .get(conversationId)
          ?.find((e) => e.id === step.eventId);
        if (!event) throw new Error("not_found");
        // Un patch cambia solo i campi del suo tipo: mai id, data, né il tipo.
        const { type, ...fields } = step.patch;
        if (type !== event.type) throw new Error("invalid: patch type");
        Object.assign(event, fields);
        update(conversationId, event);
        notifyConversationChange(conversationId);
        break;
      }
      case "state": {
        const conversation = findConversation(conversationId)!;
        conversation.state = step.state;
        conversation.outcome = step.state === "finished" ? (step.outcome ?? "ok") : null;
        conversation.updatedAt = now();
        syncTaskClaude(conversation);
        notifyConversationChange(conversationId);
        break;
      }
    }
  }
}

/**
 * Quello che Claude scrive nel refine (design, piano, metadati) entra nella
 * richiesta nello stesso passo in cui la riga entra nel flusso: un solo
 * percorso, quindi la richiesta e la riga non divergono mai. Solo su una
 * richiesta ancora aperta: trasformata o archiviata non si cambia più.
 */
function applyRefinePatch(conversationId: string, patch: RefinePatch): void {
  const conversation = findConversation(conversationId);
  if (conversation?.kind !== "refine" || !conversation.requestId) return;
  const request = state.requests.find((r) => r.id === conversation.requestId);
  if (!request || !["new", "refining", "ready"].includes(request.status)) return;
  Object.assign(request, structuredClone(patch));
  notifyConversationChange(conversationId);
}

function finishAction(
  event: ConversationEvent,
  outcome: "done" | "failed" | undefined,
  result: string | undefined,
  resultText?: Utterance,
): void {
  if (event.type !== "action") return;
  event.state = outcome ?? "done";
  if (result !== undefined) event.result = result;
  if (resultText) event.resultText = resultText;
}

/** Un messaggio di Claude, a pezzi di 3–12 parole sullo stesso evento. */
async function say(conversationId: string, text: string, alive: () => boolean) {
  const event = append(conversationId, { type: "assistant", text: "", done: false });
  const chunks = chunksOf(text, event.id);
  for (const [i, chunk] of chunks.entries()) {
    if (i > 0) {
      await pause();
      if (!alive()) return;
    }
    if (event.type !== "assistant") return;
    event.text += chunk;
    event.done = i === chunks.length - 1;
    // Il primo pezzo è la nascita dell'evento: chi guarda lo riceve come `append`.
    if (i === 0) emit(conversationId, event, "append");
    else update(conversationId, event);
  }
}

/**
 * Un testo di Claude che si scrive in un CAMPO invece che nel flusso di una
 * conversazione (la bozza di Claude nella Posta): gli stessi pezzi
 * (`chunksOf`) e le stesse pause (`streamDelay`) delle risposte, senza
 * evento né iscritti — `onText` riceve il testo fin lì. Smette appena
 * `alive()` è falso o lo stato si ripristina; restituisce se è arrivato in
 * fondo.
 */
export async function streamText(
  text: string,
  seed: string,
  onText: (soFar: string) => void,
  alive: () => boolean,
): Promise<boolean> {
  const generation = storeGeneration();
  const going = () => alive() && storeGeneration() === generation;
  let soFar = "";
  for (const chunk of chunksOf(text, seed)) {
    await pause();
    if (!going()) return false;
    soFar += chunk;
    onText(soFar);
  }
  return true;
}

/**
 * Taglia un testo in pezzi di 3–12 parole (lo spazio dopo una parola resta
 * con lei), deterministici per evento: uniti danno il testo esatto.
 */
export function chunksOf(text: string, seed: string): string[] {
  const words = text.match(/^\s+|\S+\s*/g) ?? [];
  if (words.length === 0) return [text];
  let hash = 2166136261;
  for (const ch of seed) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  const chunks: string[] = [];
  let at = 0;
  while (at < words.length) {
    const left = words.length - at;
    hash = (Math.imul(hash, 1103515245) + 12345) >>> 0;
    let size = 3 + (hash % 10);
    // L'ultimo pezzo non resta sotto le 3 parole: o si prende tutto, o se ne lasciano 3.
    if (left - size < 3) size = left <= 12 ? left : left - 3;
    chunks.push(words.slice(at, at + size).join(""));
    at += size;
  }
  return chunks;
}

// --- scrittura nel flusso ---------------------------------------------------

/**
 * Aggiunge un evento al flusso; l'id continua la numerazione del seed. Un
 * messaggio di Claude nasce vuoto e non si annuncia: lo annuncia il suo
 * primo pezzo.
 */
function append(conversationId: string, draft: EventDraft): ConversationEvent {
  let log = state.conversationEvents.get(conversationId);
  if (!log) {
    log = [];
    state.conversationEvents.set(conversationId, log);
  }
  const event = {
    ...draft,
    id: `${conversationId}-e${log.length + 1}`,
    at: now(),
  } as ConversationEvent;
  log.push(event);
  findConversation(conversationId)!.updatedAt = event.at;
  if (event.type !== "assistant") emit(conversationId, event, "append");
  // La proposta aperta che con questo messaggio ne ha 20 dopo di sé scade
  // adesso: chi guarda la riceve aggiornata (una volta, quando passa la soglia).
  if (isMessage(event)) {
    log.forEach((e, i) => {
      if (
        e.type === "proposal" &&
        e.status === "open" &&
        messagesAfter(log, i) === PROPOSAL_EXPIRY.messages
      ) {
        emit(conversationId, e, "update");
      }
    });
  }
  return event;
}

function update(conversationId: string, event: ConversationEvent): void {
  findConversation(conversationId)!.updatedAt = now();
  emit(conversationId, event, "update");
}

/**
 * Avvisa gli iscritti. Chi non è più la persona della sessione (si è
 * cambiato «vedi come») o non vede più la conversazione viene chiuso prima
 * di ricevere qualunque cosa.
 */
function emit(conversationId: string, event: ConversationEvent, mode: StreamMode): void {
  const conversation = findConversation(conversationId);
  const log = state.conversationEvents.get(conversationId) ?? [];
  const index = log.indexOf(event);
  // Ogni evento che si annuncia è già nel flusso (`append` lo mette prima,
  // gli altri lo prendono da lì): uno che non c'è non si manda a nessuno.
  if (index < 0) return;
  for (const subscriber of [...subscribers]) {
    if (subscriber.conversationId !== conversationId || !subscribers.has(subscriber)) continue;
    const entitled =
      subscriber.personId === getSessionPersonId() &&
      conversation !== undefined &&
      canSeeConversation(subscriber.personId, conversation);
    if (!entitled) {
      subscribers.delete(subscriber);
      subscriber.onConnection?.("closed");
      continue;
    }
    if (index >= readableLength(subscriber.personId, conversation)) continue;
    subscriber.onEvent(presentEvent(log, index), mode);
  }
}

/**
 * Consegna agli iscritti che non sono l'autore gli eventi trattenuti da
 * `fromIndex` in poi, quando il seguito tenuto privato in via provvisoria
 * risulta pubblico (R-E6): arrivano come `append`, nell'ordine, una volta.
 */
export function releaseHeld(conversationId: string, fromIndex: number): void {
  const conversation = findConversation(conversationId);
  if (!conversation) return;
  const log = state.conversationEvents.get(conversationId) ?? [];
  for (const subscriber of [...subscribers]) {
    if (subscriber.conversationId !== conversationId) continue;
    if (subscriber.personId === conversation.ownerId) continue;
    if (
      subscriber.personId !== getSessionPersonId() ||
      !canSeeConversation(subscriber.personId, conversation)
    ) {
      subscribers.delete(subscriber);
      subscriber.onConnection?.("closed");
      continue;
    }
    const readable = readableLength(subscriber.personId, conversation);
    for (let i = fromIndex; i < readable; i++) {
      subscriber.onEvent(presentEvent(log, i), "append");
    }
  }
}

// --- Chat (area 4) ------------------------------------------------------------
//
// I flussi della Chat passano dallo stesso motore: un messaggio nuovo entra
// solo da `runScript` su `chat:<canale>` (radici) o `chat:thread:<radice>`
// (risposte), con il passo `post`; ogni messaggio nuovo o cambiato arriva
// agli iscritti da `emitChat`, l'unico punto che li avvisa. Chi si iscrive
// non riceve lo storico (lo leggono `listMessages` e `listThread`, a
// pagine), solo ciò che accade dopo: `append` per un messaggio nuovo,
// `update` per uno cambiato (testo, reazioni, eliminazione, riassunto del
// thread). Ogni iscritto riceve il messaggio come lo legge lui
// (`presentMessage`), e chi non è più la persona della sessione o non legge
// più il canale viene chiuso prima di ricevere qualunque cosa.

/** L'id di un flusso della Chat: `chat:<canale>` o `chat:thread:<radice>`. */
export type ChatStreamId = `chat:${string}`;

export const isChatStream = (id: string): id is ChatStreamId => id.startsWith("chat:");

/** Il flusso di un canale: le radici e le risposte «anche nel canale». */
export const channelStream = (channelId: string): ChatStreamId => `chat:${channelId}`;

/** Il flusso di un thread: la radice e le sue risposte. */
export const threadStream = (rootId: string): ChatStreamId => `chat:thread:${rootId}`;

/**
 * La coda di una risposta di @Claude: i suoi pezzi e le sue righe arrivano
 * da qui, così le risposte delle persone nello stesso thread (sulla coda del
 * thread) entrano subito, in ordine, anche mentre Claude scrive. Non è un
 * flusso a cui iscriversi: gli iscritti del thread ricevono la risposta.
 */
export const claudeReplyStream = (replyId: string): ChatStreamId => `chat:claude:${replyId}`;

const THREAD_PREFIX = "chat:thread:";
const CLAUDE_PREFIX = "chat:claude:";

/** Il canale di un flusso della Chat, se esiste ancora. */
function channelOfStream(streamId: string): Channel | undefined {
  if (streamId.startsWith(THREAD_PREFIX)) {
    const root = messageById(streamId.slice(THREAD_PREFIX.length));
    return root && root.threadOf === null ? channelById(root.channelId) : undefined;
  }
  if (streamId.startsWith(CLAUDE_PREFIX)) {
    const reply = messageById(streamId.slice(CLAUDE_PREFIX.length));
    return reply?.kind === "claude" ? channelById(reply.channelId) : undefined;
  }
  return channelById(streamId.slice("chat:".length));
}

interface ChatSubscriber {
  streamId: ChatStreamId;
  personId: string;
  onMessage: (m: ChatMessageView, mode: StreamMode) => void;
  onConnection?: (connection: "closed") => void;
}

const chatSubscribers = new Set<ChatSubscriber>();
const chatChangeListeners = new Set<(channelId: string) => void>();

/**
 * Avvisa che nella Chat qualcosa è cambiato in un canale (un messaggio
 * nuovo o cambiato, un canale, i suoi membri, una lettura): chi ascolta
 * rilegge con le letture, che filtrano per persona. Restituisce la
 * disiscrizione.
 */
export function onChatChange(fn: (channelId: string) => void): () => void {
  chatChangeListeners.add(fn);
  return () => {
    chatChangeListeners.delete(fn);
  };
}

export function notifyChatChange(channelId: string): void {
  for (const fn of [...chatChangeListeners]) fn(channelId);
}

/**
 * Si iscrive a un flusso della Chat, a nome della persona della sessione.
 * Un canale (o un thread) che non legge risponde come uno che non esiste
 * (`Error("not_found")`). Restituisce la disiscrizione.
 */
export function subscribeChat(
  streamId: ChatStreamId,
  onMessage: (m: ChatMessageView, mode: StreamMode) => void,
  options: { onConnection?: (connection: "closed") => void } = {},
): () => void {
  const personId = getSessionPersonId();
  const ch = streamId.startsWith(CLAUDE_PREFIX) ? undefined : channelOfStream(streamId);
  if (!ch || !canReadChannel(personId, ch)) throw new Error("not_found");
  const subscriber: ChatSubscriber = { streamId, personId, onMessage };
  if (options.onConnection) subscriber.onConnection = options.onConnection;
  chatSubscribers.add(subscriber);
  return () => {
    chatSubscribers.delete(subscriber);
  };
}

/** L'iscritto ha ancora diritto al suo flusso: è la persona della sessione e legge il canale. */
function chatEntitled(subscriber: ChatSubscriber): boolean {
  const ch = channelOfStream(subscriber.streamId);
  return (
    subscriber.personId === getSessionPersonId() &&
    ch !== undefined &&
    canReadChannel(subscriber.personId, ch)
  );
}

/**
 * Chiude subito gli iscritti che non leggono più il loro flusso (uscito dal
 * canale, tolto, canale eliminato), senza aspettare il prossimo messaggio.
 */
export function recheckChatSubscribers(): void {
  for (const subscriber of [...chatSubscribers]) {
    if (chatEntitled(subscriber)) continue;
    chatSubscribers.delete(subscriber);
    subscriber.onConnection?.("closed");
  }
}

/**
 * Avvisa gli iscritti di un messaggio nuovo o cambiato: il flusso del
 * thread e, per una radice o una risposta «anche nel canale», quello del
 * canale. Una risposta aggiorna anche la sua radice (il riassunto del
 * thread) in entrambi i flussi.
 */
function emitChat(m: ChatMessage, mode: StreamMode): void {
  const targets: [ChatStreamId, ChatMessage, StreamMode][] = [];
  if (m.threadOf === null) {
    targets.push([channelStream(m.channelId), m, mode], [threadStream(m.id), m, mode]);
  } else {
    targets.push([threadStream(m.threadOf), m, mode]);
    if (m.alsoInChannel) targets.push([channelStream(m.channelId), m, mode]);
    const root = messageById(m.threadOf);
    if (root) {
      targets.push([channelStream(m.channelId), root, "update"]);
      targets.push([threadStream(root.id), root, "update"]);
    }
  }
  for (const [streamId, message, how] of targets) {
    for (const subscriber of [...chatSubscribers]) {
      if (subscriber.streamId !== streamId || !chatSubscribers.has(subscriber)) continue;
      if (!chatEntitled(subscriber)) {
        chatSubscribers.delete(subscriber);
        subscriber.onConnection?.("closed");
        continue;
      }
      subscriber.onMessage(presentMessage(subscriber.personId, message), how);
    }
  }
  notifyChatChange(m.channelId);
}

/**
 * Cambia un messaggio già scritto e lo annuncia, subito: modifica,
 * eliminazione, reazioni, codici collegati. Non aspetta in coda dietro a
 * una risposta di Claude che sta arrivando nello stesso thread (come il
 * messaggio di chi scrive in una conversazione, `appendUserMessage`).
 */
export function patchChatMessage(
  messageId: string,
  patch: Extract<ChatScriptStep, { step: "patch" }>["patch"],
): ChatMessage {
  const message = messageById(messageId);
  if (!message) throw new Error("not_found");
  Object.assign(message, structuredClone(patch));
  emitChat(message, "update");
  return message;
}

async function playChat(steps: ChatScriptStep[], alive: () => boolean): Promise<void> {
  for (const step of steps) {
    await pause();
    if (!alive()) return;
    switch (step.step) {
      case "post": {
        // Fra l'accodamento e il turno il canale può essere stato archiviato,
        // eliminato, o chi scrive esserne uscito: il messaggio non entra.
        const ch = channelById(step.message.channelId);
        const author = step.message.kind === "person" ? step.message.authorId : null;
        if (!ch || ch.archived) return;
        if (author !== null && !(membersOf(ch).includes(author) && canReadChannel(author, ch))) {
          return;
        }
        state.chatMessages.push(step.message);
        emitChat(step.message, "append");
        break;
      }
      case "patch": {
        // Un messaggio eliminato (anche a metà di una risposta di Claude) non
        // riprende testo da un passo accodato prima: lo script si ferma.
        const message = messageById(step.messageId);
        if (!message || message.deletedAt !== null) return;
        patchChatMessage(step.messageId, step.patch);
        break;
      }
      case "say": {
        // Come per «patch»: un messaggio sparito (canale eliminato) ferma lo script.
        const message = messageById(step.messageId);
        if (!message) return;
        for (const [i, chunk] of chunksOf(step.text, message.id).entries()) {
          if (i > 0) {
            await pause();
            if (!alive()) return;
          }
          if (message.deletedAt !== null) return;
          message.text += chunk;
          emitChat(message, "update");
        }
        break;
      }
    }
  }
}
