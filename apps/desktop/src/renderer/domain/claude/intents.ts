import type { ScriptStep } from "../../data/types";
import { toSteps, type Answer } from "./answers";
import type { IntentContext } from "./context";
import { findCodes, findWeek, normalize, topicWords } from "./parse";
import { assign, create, plan } from "./intents/change";
import { explain } from "./intents/explain";
import { general } from "./intents/general";
import { howto, howtoTopic } from "./intents/howto";
import { run } from "./intents/run";
import { status } from "./intents/status";
import { today } from "./intents/today";

export type { IntentContext, ReadApi, T } from "./context";
export type { StartRunArgs } from "./intents/run";

// Il motore di intenti della conversazione libera: il prototipo non chiama
// un modello, quindi riconosce le richieste tipiche (parole chiave en/it e
// codici di catalogo) e risponde sui dati finti con i passi dello stream.
// Puro: legge solo da `ctx.read` (le letture della persona), non scrive
// nulla — le modifiche escono come proposte da confermare — e non guarda
// l'orologio vero. L'app vera lo sostituisce con il modello e gli strumenti
// MCP di Stubwise, senza toccare le pagine.

export type Intent =
  | "status"
  | "today"
  | "explain"
  | "howto"
  | "run"
  | "create"
  | "assign"
  | "plan"
  | "general";

const RUN = /\b(run|start|launch|execute|avvia|esegui|lancia|fai partire|metti al lavoro)\b/;
const PLAN = /\b(plan|schedule|pianifica\w*|programma\w*)\b/;
const ASSIGN = /\b(assign|reassign|assegna\w*|riassegna\w*)\b/;
const CREATE =
  /\b(create|add|new task|make a task|open a task|crea\w*|aggiungi\w*|nuova task|nuovo task|apri una task)\b/;
const HOWTO = /\b(how (do|does|can|to|is|are)|come (funziona|funzionano|si|faccio|posso|fare))\b/;
/** Una task o una richiesta nominata senza codice: «spiegami la richiesta», «avvia la task». */
const OBJECT = /\b(task|request|ticket|richiesta)\b/;
const EXPLAIN = /\b(explain|tell me about|summari[sz]e|spiega\w*|raccontami|riassumi)\b/;
const TODAY =
  /\b(today|my day|what should i do|what do i have|oggi|cosa devo fare|cosa ho da fare|la mia giornata)\b/;
const STATUS =
  /\b(status|where (are|do) .*projects?|how are .*projects?|how's .*going|a che punto|come vanno|come va|stato dei progetti|situazione)\b/;

/**
 * L'intento di un messaggio. L'ordine conta: prima le richieste di
 * modifica con un codice (avvia, pianifica — solo con una settimana —,
 * assegna), poi crea, un codice da spiegare («a che punto è AUD-3» è una
 * spiegazione, non il polso del progetto), a che punto, oggi, «come
 * funziona» con un tema; «spiegami/avvia la task» senza codice chiedono il
 * codice. Il resto — anche una domanda su temi esterni — è generico.
 */
export function recognize(text: string): Intent {
  const plain = normalize(text);
  const codes = findCodes(text);
  const hasTask = codes.some((c) => c.kind === "task");
  if (codes.length > 0 && RUN.test(plain)) return "run";
  if (hasTask && PLAN.test(plain) && findWeek(text)) return "plan";
  if (hasTask && ASSIGN.test(plain)) return "assign";
  if (CREATE.test(plain) && !hasTask) return "create";
  if (codes.length > 0) return "explain";
  if (STATUS.test(plain)) return "status";
  if (TODAY.test(plain)) return "today";
  if (HOWTO.test(plain) && topicWords(howtoTopic(text)).length > 0) return "howto";
  if (EXPLAIN.test(plain) && OBJECT.test(plain)) return "explain";
  if (RUN.test(plain) && OBJECT.test(plain)) return "run";
  return "general";
}

const HANDLERS: Record<Intent, (text: string, ctx: IntentContext) => Promise<Answer>> = {
  status,
  today,
  explain,
  howto,
  run,
  create,
  assign,
  plan,
  general,
};

/**
 * La risposta di Claude a un messaggio della conversazione libera, come
 * passi per `runScript`. Le letture avvengono qui (a nome della persona,
 * tramite `ctx.read`); le scritture mai: solo eventi `proposal` aperti.
 */
export async function respond(text: string, ctx: IntentContext): Promise<ScriptStep[]> {
  const answer = await HANDLERS[recognize(text)](text, ctx);
  return toSteps(answer, ctx, text);
}
