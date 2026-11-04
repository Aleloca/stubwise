import type { ScriptStep } from "../../data/types";
import { toSteps, type Answer } from "./answers";
import type { IntentContext } from "./context";
import {
  QUESTION,
  STATUS,
  TODAY,
  canonicalCodes,
  findCodes,
  findWeek,
  normalize,
  stripCourtesy,
  topicWords,
} from "./parse";
import { archive, isArchiveRequest } from "./intents/archive";
import { automation, isAutomationRequest } from "./intents/automation";
import { draft, isDraftRequest } from "./intents/draft";
import { isMemberRequest, member } from "./intents/member";
import { isPageRequest, page } from "./intents/page";
import { assign, create, plan } from "./intents/change";
import { explain } from "./intents/explain";
import { fileQuestion, files } from "./intents/files";
import { general } from "./intents/general";
import { isRefused, refused } from "./intents/refused";
import { remove } from "./intents/remove";
import { howto, howtoTopic } from "./intents/howto";
import { run } from "./intents/run";
import { isSpendQuestion, spend } from "./intents/spend";
import { isStalledQuestion, stalled } from "./intents/stalled";
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
  | "files"
  | "run"
  | "create"
  | "assign"
  | "plan"
  | "remove"
  | "refused"
  | "automation"
  | "stalled"
  | "spend"
  | "archive"
  | "member"
  | "draft"
  | "page"
  | "general";

// Le modifiche si riconoscono solo da un COMANDO: il verbo all'imperativo in
// testa al messaggio (dopo un'eventuale cortesia, «please», «puoi»). Una
// domanda che contiene lo stesso verbo («Chi ha assegnato AUD-10?», «AUD-10
// è pianificata?», «Come si crea un preventivo?») non propone mai nulla.
// Imperativo (sempre) e infinito con i clitici (solo dopo una cortesia).
const RUN = /^(run|start|launch|execute|avvia|avviala|avvialo|esegui|lancia|fai partire)\b/;
const RUN_INF =
  /^(avviare|avviarla|avviarlo|eseguire|eseguirla|eseguirlo|lanciare|lanciarla|lanciarlo|far partire)\b/;
const PLAN =
  /^(plan|schedule|pianifica|pianificala|pianificalo|programma|programmala|programmalo)\b/;
const PLAN_INF =
  /^(pianificare|pianificarla|pianificarlo|pianificarmi|programmare|programmarla|programmarlo)\b/;
const ASSIGN =
  /^(assign|reassign|give|assegna|assegnala|assegnalo|riassegna|riassegnala|riassegnalo)\b/;
const ASSIGN_INF =
  /^(assegnare|assegnarla|assegnarlo|assegnarmi|riassegnare|riassegnarla|riassegnarlo)\b/;
const REMOVE = /^(delete|remove|elimina|eliminala|eliminalo|cancella|cancellala|cancellalo|rimuovi)\b/;
const REMOVE_INF =
  /^(eliminare|eliminarla|eliminarlo|cancellare|cancellarla|cancellarlo|rimuovere|rimuoverla)\b/;
const CREATE =
  /^(create|add|make|open|new task|crea|creami|creala|aggiungi|apri|nuova task|nuovo task)\b/;
const CREATE_INF =
  /^(creare|crearmi|crearla|crearne|aggiungere|aggiungermi|aggiungerla|aprire|aprirmi|aprirne)\b/;

const HOWTO = /\b(how (do|does|can|to|is|are)|come (funziona|funzionano|si|faccio|posso|fare))\b/;
/** Una task o una richiesta nominata senza codice: «spiegami la richiesta», «avvia la task». */
const OBJECT = /\b(task|request|ticket|richiesta)\b/;
const EXPLAIN = /\b(explain|tell me about|summari[sz]e|spiega\w*|raccontami|riassumi)\b/;

/**
 * L'intento di un messaggio. Prima si decide se è un comando o una domanda:
 * - un gesto delle persone (classe D, area 10a: approvare un piano, il
 *   merge, il deploy…) è una riga D prima di ogni altro comando;
 * - un COMANDO (verbo all'imperativo in testa) può proporre una modifica:
 *   elimina (con un codice di task), avvia, pianifica (solo con una
 *   settimana), assegna (con un codice di task), crea (senza);
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
  const { polite, command } = stripCourtesy(plain);
  // «Can you run AUD-4?», «Puoi avviare STW-R3?» sono richieste cortesi, non domande.
  // Area 10b (Task 8): una bozza si prova PRIMA dei gesti delle persone, ma
  // solo con un verbo di scrittura in testa: «scrivi e manda l'email» è la
  // bozza (più la riga D `send`), «manda l'email» da solo resta la riga D.
  if (isDraftRequest(text)) return "draft";
  // Un gesto delle persone (classe D, area 10a) prima di ogni comando: «approva
  // il piano di AUD-4» non diventa mai un'altra cosa.
  if (isRefused(text)) return "refused";
  // Area 10b (Task 9): lingua, tema, il filtro della pagina e il filtro
  // salvato, dopo i gesti delle persone e prima dei comandi e di `explain`
  // (P10): «show ACQ tasks assigned to Marco» ha un codice noto, ma non
  // chiede di spiegarlo.
  if (isPageRequest(text)) return "page";
  // Area 10b (S4, S5): archiviare in blocco e aggiungere un membro, dopo i
  // gesti delle persone e prima di ogni comando (P10): «add Luca to ACQ as
  // Developer» non crea una task, «archivia i progetti fermi» non chiede
  // quali sono fermi.
  if (isArchiveRequest(text)) return "archive";
  if (isMemberRequest(text)) return "member";
  // Area 10b (S1): «quando arriva una richiesta…, crea una task…» descrive
  // un'automazione, e «crea un'automazione…» non è la creazione di una task:
  // dopo i gesti delle persone, prima dei comandi (P10).
  if (isAutomationRequest(text)) return "automation";
  // Area 10b (S2, S3): le domande sui progetti fermi e sulla spesa, prima dei
  // comandi e di `explain` (P10): «quali task sono ferme in ACQ?» non è un
  // codice da spiegare.
  if (isStalledQuestion(text)) return "stalled";
  if (isSpendQuestion(text)) return "spend";
  if (polite || !QUESTION.test(command)) {
    const verb = (imperative: RegExp, infinitive: RegExp) =>
      imperative.test(command) || (polite && infinitive.test(command));
    if (hasTask && verb(REMOVE, REMOVE_INF)) return "remove";
    if (verb(RUN, RUN_INF) && (codes.length > 0 || OBJECT.test(command))) return "run";
    if (hasTask && verb(PLAN, PLAN_INF) && findWeek(text)) return "plan";
    if (hasTask && verb(ASSIGN, ASSIGN_INF)) return "assign";
    if (verb(CREATE, CREATE_INF) && !hasTask) return "create";
  }
  if (codes.some((c) => c.known)) return "explain";
  // «Cosa dice il contratto col cliente sui tempi di consegna?»: i file del Drive.
  if (fileQuestion(text)) return "files";
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
  files,
  run,
  create,
  assign,
  plan,
  remove,
  refused,
  automation,
  stalled,
  spend,
  archive,
  member,
  draft,
  page,
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
  let canonical = canonicalCodes(text, visibleCodes);
  let intent = recognize(canonical, visibleCodes);
  const fromThread = threadCode(canonical, intent, ctx.thread, visibleCodes);
  if (fromThread) {
    canonical = `${canonical} ${fromThread.code}`;
    intent = fromThread.intent;
  }
  const answer = await HANDLERS[intent](canonical, ctx);
  return toSteps(answer, ctx, text);
}

/** Un rimando a qualcosa già nominato: «it», «this», «questa», «la task»… */
const REFERENCE =
  /\b(it|this|that|this one|that one|questa|questo|quella|quello|task|request|ticket|richiesta)\b/;

/**
 * Il codice di cui parla il thread, quando la chiamata non ne nomina uno e
 * ci rimanda («explain this», «plan it for W45», «pianificala»): l'ultimo
 * codice noto del thread, se con lui la richiesta diventa un intento che lo
 * usa. Un «crea», un «a che punto siamo» o un grazie restano com'erano.
 */
function threadCode(
  text: string,
  intent: Intent,
  thread: readonly string[] | undefined,
  visibleCodes: ReadonlySet<string>,
): { code: string; intent: Intent } | null {
  if (!thread || thread.length === 0) return null;
  if (!["general", "explain", "run"].includes(intent)) return null;
  if (findCodes(text, visibleCodes).some((c) => c.known)) return null;
  let code: string | undefined;
  for (const message of [...thread].reverse()) {
    code = findCodes(message, visibleCodes)
      .filter((c) => c.known)
      .at(-1)?.code;
    if (code) break;
  }
  if (!code) return null;
  const withCode = recognize(`${text} ${code}`, visibleCodes);
  const refers = REFERENCE.test(normalize(text));
  if (["run", "plan", "assign"].includes(withCode) || (refers && withCode === "explain")) {
    return { code, intent: withCode };
  }
  return null;
}
