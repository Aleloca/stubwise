import type { ScriptStep } from "../../data/types";
import { toSteps, type Answer } from "./answers";
import type { IntentContext } from "./context";
import { canonicalCodes, findCodes, findWeek, normalize, topicWords } from "./parse";
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

// Le modifiche si riconoscono solo da un COMANDO: il verbo all'imperativo in
// testa al messaggio (dopo un'eventuale cortesia, «please», «puoi»). Una
// domanda che contiene lo stesso verbo («Chi ha assegnato AUD-10?», «AUD-10
// è pianificata?», «Come si crea un preventivo?») non propone mai nulla.
const POLITE =
  /^(please|pls|can you|could you|would you|will you|per favore|per piacere|puoi|potresti|mi puoi|riesci a)\s+/;
const RUN = /^(run|start|launch|execute|avvia|avviala|avvialo|esegui|lancia|fai partire)\b/;
const PLAN =
  /^(plan|schedule|pianifica|pianificala|pianificalo|programma|programmala|programmalo)\b/;
const ASSIGN =
  /^(assign|reassign|give|assegna|assegnala|assegnalo|riassegna|riassegnala|riassegnalo)\b/;
const CREATE =
  /^(create|add|make|open|new task|crea|creami|creala|aggiungi|apri|nuova task|nuovo task)\b/;
/** Una domanda: il punto interrogativo, o una parola interrogativa in testa. */
const QUESTION =
  /(\?\s*$)|^(when|why|did|does|do|who|whom|whose|what|what's|how|is|are|was|were|has|have|had|which|where|quando|perche|chi|cosa|che cosa|come|e|era|sono|ha|hanno|quale|quali|dove)\b/;
const HOWTO = /\b(how (do|does|can|to|is|are)|come (funziona|funzionano|si|faccio|posso|fare))\b/;
/** Una task o una richiesta nominata senza codice: «spiegami la richiesta», «avvia la task». */
const OBJECT = /\b(task|request|ticket|richiesta)\b/;
const EXPLAIN = /\b(explain|tell me about|summari[sz]e|spiega\w*|raccontami|riassumi)\b/;
const TODAY =
  /\b(today|my day|what should i do|what do i have|oggi|cosa devo fare|cosa ho da fare|la mia giornata)\b/;
const STATUS =
  /\b(status|where (are|do) .*projects?|how are .*projects?|how's .*going|a che punto|come vanno|come va|stato dei progetti|situazione)\b/;

/**
 * L'intento di un messaggio. Prima si decide se è un comando o una domanda:
 * - un COMANDO (verbo all'imperativo in testa) può proporre una modifica:
 *   avvia, pianifica (solo con una settimana), assegna (con un codice di
 *   task), crea (senza);
 * - tutto il resto si legge e basta: un codice da spiegare («a che punto è
 *   AUD-3?», «Perché è fallita AUD-4?»), a che punto, oggi, «come
 *   funziona/come si fa» con un tema — che vince su un codice ignoto
 *   («How does UTF-8 import work in AUD?») —; «spiegami/avvia la task»
 *   senza codice chiedono il codice. Il resto — anche una domanda su temi
 *   esterni — è generico.
 *
 * `visibleCodes`: i codici dei progetti che la persona vede; dicono quali
 * codici nel testo sono noti (vedi `findCodes`).
 */
export function recognize(text: string, visibleCodes?: ReadonlySet<string>): Intent {
  const plain = normalize(text);
  const codes = findCodes(text, visibleCodes);
  const hasTask = codes.some((c) => c.kind === "task");
  const polite = POLITE.exec(plain);
  const command = polite ? plain.slice(polite[0].length) : plain;
  // «Can you run AUD-4?» è una richiesta cortese, non una domanda.
  if (polite || !QUESTION.test(plain)) {
    if (RUN.test(command) && (codes.length > 0 || OBJECT.test(command))) return "run";
    if (hasTask && PLAN.test(command) && findWeek(text)) return "plan";
    if (hasTask && ASSIGN.test(command)) return "assign";
    if (CREATE.test(command) && !hasTask) return "create";
  }
  if (codes.some((c) => c.known)) return "explain";
  if (STATUS.test(plain)) return "status";
  if (TODAY.test(plain)) return "today";
  if (HOWTO.test(plain) && topicWords(howtoTopic(text)).length > 0) return "howto";
  if (codes.length > 0) return "explain";
  if (EXPLAIN.test(plain) && OBJECT.test(plain)) return "explain";
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
  const visibleCodes = new Set((await ctx.read.listProjects()).map((p) => p.code));
  // «aud-3» di un progetto visibile vale «AUD-3» per tutti gli intenti.
  const canonical = canonicalCodes(text, visibleCodes);
  const answer = await HANDLERS[recognize(canonical, visibleCodes)](canonical, ctx);
  return toSteps(answer, ctx, text);
}
