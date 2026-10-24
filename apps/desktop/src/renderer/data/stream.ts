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
  Conversation,
  ConversationEvent,
  EventDraft,
  RefinePatch,
  ScriptStep,
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
  conversationId: string,
  steps: ScriptStep[] | (() => ScriptStep[]),
  at = storeGeneration(),
): Promise<void> {
  if (at !== storeGeneration()) return Promise.resolve();
  if (!findConversation(conversationId)) return Promise.reject(new Error("not_found"));
  const cut = cuts.get(conversationId) ?? 0;
  const alive = () => at === storeGeneration() && (cuts.get(conversationId) ?? 0) === cut;
  const previous = queues.get(conversationId) ?? Promise.resolve();
  // Passi dati come funzione: si costruiscono quando arriva il loro turno,
  // dopo quelli accodati prima (es. la risposta del refine parte dal design
  // che il turno precedente ha già scritto).
  const next = previous
    .catch(() => undefined)
    .then(() =>
      alive() ? play(conversationId, typeof steps === "function" ? steps() : steps, alive) : undefined,
    );
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
        if (step.input !== undefined) draft.input = step.input;
        if (step.truncated !== undefined) draft.truncated = step.truncated;
        const event = append(conversationId, draft);
        await pause();
        if (!alive()) return;
        finishAction(event, step.outcome, step.result);
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
): void {
  if (event.type !== "action") return;
  event.state = outcome ?? "done";
  if (result !== undefined) event.result = result;
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
