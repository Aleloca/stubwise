/**
 * Pezzi PURI degli scenari golden: l'elenco degli scenari e il check su
 * `ask_user`. Stanno fuori da `run.ts` per una ragione sola: `run.ts` lancia
 * `main()` all'import, quindi un test non potrebbe importarlo. Qui non c'è
 * niente che parli col CLI, col modello o con git — `checks.test.ts` li prova
 * senza spendere una chiamata.
 */

// Solo il TIPO: `import type` è cancellato a compilazione (vedi run.ts, loadRuntime).
import type { AskUserFileResult } from "../../src/pipeline/ask-user.js";

/** Gli scenari, nell'ordine in cui girano quando non se ne sceglie nessuno. */
export const SCENARIO_NAMES = [
  "plan-only",
  "ask-user",
  "no-ask",
  "execute",
  "correction",
  "intervene",
  "intervene-plan",
  "stop-pause",
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export function isScenarioName(value: string): value is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(value);
}

export interface Check {
  name: string;
  passed: boolean;
  /** Cosa si è osservato: è la riga che un umano legge quando un check è rosso. */
  detail: string;
}

/** Cosa ci si aspetta dall'agente davanti a `ask_user` cablato. */
export type AskUserExpectation = "asks" | "does-not-ask";

/** Cosa dice il file-bridge di `ask_user`, in una riga. */
function describeQuestion(question: AskUserFileResult): string {
  switch (question.kind) {
    case "question":
      return `domanda registrata: "${question.payload.question}" (${question.payload.options.length} opzioni)`;
    case "absent":
      return "nessun file-bridge: l'agente non ha chiesto nulla";
    case "malformed":
      return `file-bridge inservibile: ${question.reason}`;
  }
}

/**
 * Il check su `ask_user`, nei due versi.
 *
 * - `asks` (scenario `ask-user`): passa solo con una domanda VALIDA. Un
 *   file-bridge inservibile è rosso: la pipeline non saprebbe parcheggiare il
 *   job, e la domanda andrebbe persa.
 * - `does-not-ask` (scenario `no-ask`): passa solo se il file-bridge è
 *   ASSENTE. Anche un file malformato è rosso: vuol dire che l'agente il tool
 *   l'ha chiamato, ed è proprio la domanda inutile che questo verso misura.
 */
export function askUserCheck(question: AskUserFileResult, expectation: AskUserExpectation): Check {
  if (expectation === "asks") {
    return {
      name: "ask_user chiamato",
      passed: question.kind === "question",
      detail: describeQuestion(question),
    };
  }
  return {
    name: "ask_user NON chiamato",
    passed: question.kind === "absent",
    detail:
      question.kind === "absent"
        ? "nessun file-bridge: l'agente non ha chiesto nulla"
        : `l'agente ha chiesto, ma la risposta si ricava dal repo — ${describeQuestion(question)}`,
  };
}

/* ------------------------------------------------------------------ *
 * Scenario `intervene` (sessioni degli agenti, design 2026-10-08 §7.1)
 * ------------------------------------------------------------------ */

/**
 * Il sorgente DICHIARA `name` (funzione, const/let/var, o in un `export { … }`)?
 * Non una ricerca della parola: «returns the sum» in un commento non è una
 * funzione `sum`, e `checksum` nemmeno.
 */
export function declaresIdentifier(source: string, name: string): boolean {
  const id = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`\\b(?:function\\s*\\*?|const|let|var)\\s+${id}\\b`);
  if (declaration.test(source)) return true;
  const exportList = new RegExp(`export\\s*\\{[^}]*\\b${id}\\b[^}]*\\}`);
  return exportList.test(source);
}

/** Un evento della sessione come lo riceve il sink del runner. */
export interface InterveneEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface InterveneObservation {
  /**
   * `absorb`: messaggio a metà turno SENZA interruzione (deve finire nello
   * stesso turno: un solo `result`). `interrupt`: «Ferma e scrivi» (un
   * `result` error_during_execution, poi un turno che riparte e cambia strada).
   */
  mode: "absorb" | "interrupt";
  inputId: string;
  exitCode: number;
  timedOut: boolean;
  /** Cosa ha risposto `deliver` (null = mai chiamato: nessun `tool_use` osservato). */
  delivered: boolean | null;
  /** Il contenuto di `math.ts` a fine run ("" se il file non c'è). */
  source: string;
  /** Gli eventi del segmento, nell'ordine in cui il sink li ha ricevuti. */
  events: InterveneEvent[];
}

/**
 * I check dello scenario `intervene`, puri: il run vero li alimenta con gli
 * eventi raccolti dal sink in memoria e col file finale.
 */
export function interveneChecks(obs: InterveneObservation): Check[] {
  const turnEnds = obs.events.flatMap((ev, index) =>
    ev.type === "turn_end" ? [{ index, ev }] : [],
  );
  const subtypes = turnEnds.map((t) => String(t.ev.data["subtype"]));
  const inputIndex = obs.events.findIndex(
    (ev) =>
      ev.type === "input" &&
      ev.data["inputId"] === obs.inputId &&
      ev.data["interrupt"] === (obs.mode === "interrupt"),
  );
  const firstTurnEnd = turnEnds[0]?.index ?? Number.POSITIVE_INFINITY;

  const checks: Check[] = [
    {
      name: "il run finisce entro il timeout",
      passed: !obs.timedOut,
      detail: obs.timedOut
        ? "AgentTimeoutError: stdin rimasto aperto o run appeso"
        : "nessun timeout",
    },
    { name: "exit 0", passed: obs.exitCode === 0, detail: `exit code: ${obs.exitCode}` },
    {
      name: "deliver ha accettato l'intervento",
      passed: obs.delivered === true,
      detail: `deliver → ${obs.delivered === null ? "mai chiamato" : String(obs.delivered)}`,
    },
    {
      name: `evento input con l'inputId (interrupt: ${obs.mode === "interrupt"})`,
      passed: inputIndex !== -1,
      detail:
        inputIndex !== -1
          ? `evento input #${inputIndex} su ${obs.events.length}`
          : "nessun evento input con quell'inputId e quel valore di interrupt: l'intervento non è stato consegnato",
    },
  ];

  if (obs.mode === "absorb") {
    checks.push(
      // L'evento `input` nasce all'ECO del CLI (--replay-user-messages): un
      // messaggio assorbito fa eco all'assorbimento, prima del result.
      {
        name: "consegnato a metà turno (prima del primo result)",
        passed: inputIndex !== -1 && inputIndex < firstTurnEnd,
        detail: `input all'indice ${inputIndex}, primo result all'indice ${
          Number.isFinite(firstTurnEnd) ? firstTurnEnd : "(nessuno)"
        }`,
      },
      {
        name: "messaggio assorbito: un solo result, success",
        passed: subtypes.length === 1 && subtypes[0] === "success",
        detail: `result del run: ${subtypes.join(", ") || "(nessuno)"}`,
      },
      {
        name: "il file riflette il messaggio (sum e mul)",
        passed: declaresIdentifier(obs.source, "sum") && declaresIdentifier(obs.source, "mul"),
        detail: `sum: ${declaresIdentifier(obs.source, "sum")}, mul: ${declaresIdentifier(obs.source, "mul")}`,
      },
    );
    return checks;
  }

  const errorAt = subtypes.indexOf("error_during_execution");
  const last = subtypes.at(-1);
  const lastTurnEnd = turnEnds.at(-1)?.index ?? -1;
  checks.push(
    // «Ferma e scrivi»: l'eco del messaggio arriva quando il CLI lo prende —
    // di norma all'inizio del turno rediretto, DOPO il result dell'interruzione
    // (cli-replay C). Conta che sia stato preso prima del result finale.
    {
      name: "preso dal CLI prima del result finale",
      passed: inputIndex !== -1 && inputIndex < lastTurnEnd,
      detail: `input all'indice ${inputIndex}, ultimo result all'indice ${lastTurnEnd}`,
    },
    {
      name: "interruzione: un result error_during_execution",
      passed: errorAt !== -1,
      detail: `result del run: ${subtypes.join(", ") || "(nessuno)"}`,
    },
    {
      name: "il processo resta vivo: un turno successivo finisce in success",
      passed: errorAt !== -1 && subtypes.length > errorAt + 1 && last === "success",
      detail: `ultimo result: ${last ?? "(nessuno)"}`,
    },
    {
      name: "cambio di direzione: add, non sum",
      passed: declaresIdentifier(obs.source, "add") && !declaresIdentifier(obs.source, "sum"),
      detail: `add: ${declaresIdentifier(obs.source, "add")}, sum: ${declaresIdentifier(obs.source, "sum")}`,
    },
  );
  return checks;
}

export interface PlanInterveneObservation {
  /**
   * `plan-absorb`: un messaggio a metà turno di una PIANIFICAZIONE (segmento
   * `plan`), assorbito nello stesso turno: il messaggio finale deve restare il
   * piano. `plan-grace`: un messaggio subito DOPO il primo `result`, dentro la
   * grazia: il runner deve rifiutarlo (deliverable nell'output, vedi
   * `SEGMENT_DELIVERABLE`) e l'output resta il piano.
   */
  mode: "plan-absorb" | "plan-grace";
  inputId: string;
  exitCode: number;
  timedOut: boolean;
  /** Cosa ha risposto `deliver` (null = mai chiamato). */
  delivered: boolean | null;
  /** Il messaggio finale ha la forma del piano (`planHasRequiredShape`). */
  hasPlanShape: boolean;
  events: InterveneEvent[];
}

/** I check dello scenario `intervene-plan`, puri come quelli di `intervene`. */
export function planInterveneChecks(obs: PlanInterveneObservation): Check[] {
  const turnEnds = obs.events.filter((ev) => ev.type === "turn_end");
  const inputIndex = obs.events.findIndex(
    (ev) => ev.type === "input" && ev.data["inputId"] === obs.inputId,
  );
  const firstTurnEnd = obs.events.findIndex((ev) => ev.type === "turn_end");
  const checks: Check[] = [
    {
      name: "il run finisce entro il timeout",
      passed: !obs.timedOut,
      detail: obs.timedOut ? "AgentTimeoutError" : "nessun timeout",
    },
    { name: "exit 0", passed: obs.exitCode === 0, detail: `exit code: ${obs.exitCode}` },
    {
      name: "il piano ha ancora la sezione delle decisioni",
      passed: obs.hasPlanShape,
      detail: obs.hasPlanShape
        ? "messaggio finale con la sezione delle decisioni"
        : "messaggio finale SENZA la sezione delle decisioni: l'intervento ha sostituito il piano",
    },
  ];
  if (obs.mode === "plan-absorb") {
    checks.push(
      {
        name: "deliver ha accettato l'intervento",
        passed: obs.delivered === true,
        detail: `deliver → ${obs.delivered === null ? "mai chiamato" : String(obs.delivered)}`,
      },
      {
        name: "consegnato a metà turno (prima del primo result)",
        passed: inputIndex !== -1 && (firstTurnEnd === -1 || inputIndex < firstTurnEnd),
        detail: `input all'indice ${inputIndex}, primo result all'indice ${firstTurnEnd}`,
      },
    );
    return checks;
  }
  checks.push(
    {
      name: "deliver ha rifiutato l'intervento arrivato dopo il primo result",
      passed: obs.delivered === false,
      detail: `deliver → ${obs.delivered === null ? "mai chiamato (nessun result osservato)" : String(obs.delivered)}`,
    },
    {
      name: "nessun evento input registrato",
      passed: inputIndex === -1,
      detail: inputIndex === -1 ? "nessuno" : `evento input all'indice ${inputIndex}`,
    },
    {
      name: "un solo result: nessun turno nuovo",
      passed: turnEnds.length === 1,
      detail: `result del run: ${turnEnds.map((t) => String(t.data["subtype"])).join(", ") || "(nessuno)"}`,
    },
  );
  return checks;
}

export interface StopPauseObservation {
  /**
   * `pause-resume`: «Ferma» senza testo a metà turno, una pausa più lunga della
   * grazia, poi un messaggio: il run riparte e cambia strada. `pause-expire`:
   * «Ferma» e nessun messaggio entro il tetto (corto, solo nel test): il run
   * è ANNULLATO (`AgentRunCancelledError`).
   */
  mode: "pause-resume" | "pause-expire";
  stopId: string;
  /** L'id del messaggio dopo la pausa (solo `pause-resume`). */
  messageId: string | null;
  /** Cosa ha risposto `deliver` allo «Ferma» (null = mai chiamato). */
  stopDelivered: boolean | null;
  /** Cosa ha risposto `deliver` al messaggio (null = mai chiamato). */
  messageDelivered: boolean | null;
  exitCode: number;
  timedOut: boolean;
  /** Il nome dell'errore lanciato dal run, se ha lanciato. */
  errorName: string | null;
  /** Il contenuto di `math.ts` a fine run ("" se il file non c'è). */
  source: string;
  events: InterveneEvent[];
}

/** I check dello scenario `stop-pause`, puri come quelli di `intervene`. */
export function stopPauseChecks(obs: StopPauseObservation): Check[] {
  const subtypes = obs.events.filter((ev) => ev.type === "turn_end").map((ev) => String(ev.data["subtype"]));
  const stopEvent = obs.events.some((ev) => ev.type === "input" && ev.data["inputId"] === obs.stopId);
  const checks: Check[] = [
    {
      name: "lo «Ferma» senza testo è accettato",
      passed: obs.stopDelivered === true,
      detail: `deliver → ${obs.stopDelivered === null ? "mai chiamato" : String(obs.stopDelivered)}`,
    },
    {
      name: "l'interruzione arriva: un result error_during_execution",
      passed: subtypes.includes("error_during_execution"),
      detail: `result del run: ${subtypes.join(", ") || "(nessuno)"}`,
    },
    {
      name: "lo «Ferma» non produce un evento input (nessun messaggio, nessuna eco)",
      passed: !stopEvent,
      detail: stopEvent ? "evento input dello «Ferma» presente" : "nessuno",
    },
  ];
  if (obs.mode === "pause-expire") {
    checks.push({
      name: "pausa scaduta: il run è ANNULLATO (AgentRunCancelledError), non un timeout",
      passed: obs.errorName === "AgentRunCancelledError" && !obs.timedOut,
      detail: `errore: ${obs.errorName ?? "(nessuno)"}, timeout: ${obs.timedOut}`,
    });
    return checks;
  }
  const messageIndex = obs.events.findIndex(
    (ev) => ev.type === "input" && ev.data["inputId"] === obs.messageId,
  );
  const errorIndex = obs.events.findIndex(
    (ev) => ev.type === "turn_end" && ev.data["subtype"] === "error_during_execution",
  );
  checks.push(
    {
      name: "il messaggio dopo la pausa è accettato",
      passed: obs.messageDelivered === true,
      detail: `deliver → ${obs.messageDelivered === null ? "mai chiamato" : String(obs.messageDelivered)}`,
    },
    {
      name: "il processo è rimasto vivo in pausa: il messaggio è preso DOPO l'interruzione",
      passed: messageIndex !== -1 && errorIndex !== -1 && messageIndex > errorIndex,
      detail: `input all'indice ${messageIndex}, interruzione all'indice ${errorIndex}`,
    },
    {
      name: "il run finisce in success, entro il timeout, exit 0",
      passed: subtypes.at(-1) === "success" && !obs.timedOut && obs.exitCode === 0 && obs.errorName === null,
      detail: `ultimo result: ${subtypes.at(-1) ?? "(nessuno)"}, exit ${obs.exitCode}, errore: ${obs.errorName ?? "(nessuno)"}`,
    },
    {
      name: "cambio di direzione: add, non sum",
      passed: declaresIdentifier(obs.source, "add") && !declaresIdentifier(obs.source, "sum"),
      detail: `add: ${declaresIdentifier(obs.source, "add")}, sum: ${declaresIdentifier(obs.source, "sum")}`,
    },
  );
  return checks;
}

