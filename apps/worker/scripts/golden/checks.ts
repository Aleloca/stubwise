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
      name: `evento input con l'inputId (interrupt: ${obs.mode === "interrupt"})`,
      passed: inputIndex !== -1,
      detail:
        inputIndex !== -1
          ? `evento input #${inputIndex} su ${obs.events.length}`
          : "nessun evento input con quell'inputId e quel valore di interrupt: l'intervento non è stato consegnato",
    },
    {
      name: "consegnato a metà turno (prima del primo result)",
      passed: inputIndex !== -1 && inputIndex < firstTurnEnd,
      detail: `input all'indice ${inputIndex}, primo result all'indice ${
        Number.isFinite(firstTurnEnd) ? firstTurnEnd : "(nessuno)"
      }`,
    },
  ];

  if (obs.mode === "absorb") {
    checks.push(
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
  checks.push(
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
